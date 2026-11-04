/**
 * swarm-store — 原子 durable 队列存储。
 *
 * 设计要点（高稳定）：
 * - 所有写走 `tmp + fsync + rename`，崩溃不丢不坏（POSIX rename 原子）。
 * - 所有状态迁移走 `transitionTask`（FSM 表校验 + 写 timeline + 原子写）：
 *   lockd 目录锁（mkdir 原子）+  stale 熔断
 *   + 锁内 fresh 读 + 原子写。双 dev 并发 claim 同一任务只赢一个。
 *   `casTransition` 保留为无 timeline 无表校验的旧入口（仅旧单测兼容，插件不再用）。
 * - 读走 mtime 缓存（读多写少：status/claim 前读一次，写才失效）。
 */
import {
  readFileSync, writeFileSync, existsSync, mkdirSync,
  statSync, rmSync, openSync, closeSync, writeSync, fsyncSync, renameSync,
  appendFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

import { allowedFrom } from './swarm-fsm.js';

const cache = new Map(); // absPath -> { key, tasks }

function statKey(path) {
  try {
    // bigint 纳秒精度：同毫秒内同尺寸的两次写入（如 queued→passed 长度相同）
    // 在 mtimeMs+size 下会撞 key 导致读到陈旧缓存，这里必须用 ns + ino。
    const s = statSync(path, { bigint: true });
    return `${s.mtimeNs}:${s.size}:${s.ino}`;
  } catch {
    return null;
  }
}

function readFresh(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/** 读：mtime 缓存，只读路径用（status/read_queue）。 */
export function loadQueue(queuePath) {
  const path = resolve(queuePath);
  const key = statKey(path);
  const hit = cache.get(path);
  if (hit && hit.key === key && key !== null) return structuredClone(hit.tasks);
  if (key === null) return [];
  const tasks = readFresh(path);
  cache.set(path, { key, tasks });
  return structuredClone(tasks);
}

export function invalidate(queuePath) {
  cache.delete(resolve(queuePath));
}

/** 写：tmp + fsync + rename，写完失效本进程缓存。 */
export function saveQueueAtomic(queuePath, tasks) {
  const path = resolve(queuePath);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, tasks.map((t) => JSON.stringify(t)).join('\n') + (tasks.length ? '\n' : ''));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  invalidate(queuePath);
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 目录锁：mkdir 原子，owner 文件记 pid@ts，stale（默认 15s）熔断清锁。
 * 同进程并发 + 多进程并发都安全。临界区只做内存计算 + 一次原子写，保持短。
 */
export function withLock(queuePath, fn, opts = {}) {
  const { timeoutMs = 8000, staleMs = 15000 } = opts;
  const target = resolve(queuePath);
  mkdirSync(dirname(target), { recursive: true }); // 父目录必须先存在，否则 ENOENT 会被误判为空转
  const lockDir = `${target}.lockd`;
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(lockDir);
      try { writeFileSync(`${lockDir}/owner`, `${process.pid}@${Date.now()}`, 'utf8'); } catch { /* best-effort */ }
      break;
    } catch (err) {
      if (err && err.code !== 'EEXIST') throw err; // 真错误（权限等）直接抛出，绝不空转
      let stale = false;
      try {
        stale = (Date.now() - statSync(lockDir).mtimeMs) > staleMs;
      } catch {
        continue; // 锁在检查瞬间被释放，立即重试
      }
      if (stale) {
        try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* ignored */ }
        continue;
      }
      if (Date.now() - start > timeoutMs) throw new Error(`swarm lock timeout: ${queuePath}`);
      sleepMs(25);
    }
  }
  try {
    return fn();
  } finally {
    try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* ignored */ }
  }
}

/**
 * Compare-And-Set 状态迁移（唯一写入口，建议所有 tool 都走它）：
 * 锁内 fresh 读 → 校验期望状态 → patch → 原子写。
 * 返回 { ok:true, task } 或 { ok:false, reason }，调用方永不抛错。
 */
export function casTransition(queuePath, taskId, expectStatus, patch) {
  return withLock(queuePath, () => {
    const path = resolve(queuePath);
    const tasks = readFresh(path);
    const i = tasks.findIndex((t) => t.id === taskId);
    if (i < 0) return { ok: false, reason: `task not found: ${taskId}` };
    const cur = tasks[i];
    const expects = Array.isArray(expectStatus) ? expectStatus : [expectStatus];
    if (!expects.includes(cur.status)) {
      return { ok: false, reason: `cannot transition: ${cur.id} is ${cur.status}, expect ${expects.join('/')}` };
    }
    const next = { ...cur, ...patch, updated_at: new Date().toISOString() };
    tasks[i] = next;
    saveQueueAtomic(queuePath, tasks);
    return { ok: true, task: structuredClone(next) };
  });
}

/** 加任务（planner 用）：id 唯一，字段校验，锁内追加。timelinePath 可选：给了就写 create 行。 */
export const TASK_RISKS = ['low', 'medium', 'high'];

/**
 * 任务技术栈（planner 拆任务时三选一必填）：
 * backend = 后端（Go/Gin/GORM）、frontend = 前端（Angular/UniApp）、integration = 前后端联调。
 * 用途：`/swarm-start` 按队列里实际出现的 stack 按需索要模型（只含 backend 的轮不要 dev_frontend），
 * 缺啥门禁硬拦。无 stack 的存量老任务行视为 legacy，不触发任何模型要求（老轮老口径）。
 */
export const TASK_STACKS = ['backend', 'frontend', 'integration'];

/**
 * 按需模型需求（纯函数）：扫队列未 passed 任务的 stack 并集，算出缺的模型键。
 * 返回 { stacks: string[], missing: Array<{ key, flag, reason }> }，永不抛错。
 * - backend → dev_backend（legacy dev 亦可）；frontend → dev_frontend（legacy dev 亦可）；
 *   integration → dev 任一侧即可（dev_backend / dev_frontend / dev 有其一即过）。
 * - 有未完任务 → test；有未完且 review=true 的任务 → reviewer。
 * - 全 legacy（无 stack）→ missing 为空（老行为零变）。
 */
export function requiredModels(tasks, roleModels = {}) {
  try {
    const list = Array.isArray(tasks) ? tasks : [];
    const open = list.filter((t) => t && typeof t === 'object' && t.status !== 'passed');
    const stacks = [...new Set(open.map((t) => t.stack).filter((s) => TASK_STACKS.includes(s)))];
    // 纯 legacy 轮（未完任务全无 stack）：零要求，老行为零变（裸 start 照常派发）。
    if (!stacks.length) return { stacks, missing: [] };
    const rm = roleModels && typeof roleModels === 'object' ? roleModels : {};
    const has = (v) => typeof v === 'string' && v.trim() !== '';
    const missing = [];
    const devOkB = has(rm.dev_backend) || has(rm.dev);
    const devOkF = has(rm.dev_frontend) || has(rm.dev);
    const hasB = stacks.includes('backend');
    const hasF = stacks.includes('frontend');
    const hasI = stacks.includes('integration');
    if (hasB && !devOkB) {
      missing.push({ key: 'dev_backend', flag: '--dev-backend-model', reason: '本轮含 backend 任务，需后端 dev 模型（或 legacy --dev-model 通配）' });
    }
    if (hasF && !devOkF) {
      missing.push({ key: 'dev_frontend', flag: '--dev-frontend-model', reason: '本轮含 frontend 任务，需前端 dev 模型（或 legacy --dev-model 通配）' });
    }
    if (hasI && !(devOkB || devOkF)) {
      missing.push({ key: 'dev_backend', flag: '--dev-backend-model（或 --dev-frontend-model）', reason: '本轮含 integration 联调任务，需任一侧 dev 模型' });
    }
    if (open.length && !has(rm.test)) {
      missing.push({ key: 'test', flag: '--tester-model', reason: '本轮有未完任务，需 tester 模型' });
    }
    if (open.some((t) => t.review === true) && !has(rm.reviewer)) {
      missing.push({ key: 'reviewer', flag: '--reviewer-model', reason: '本轮有未完的评审任务，需 reviewer 模型' });
    }
    return { stacks, missing };
  } catch {
    return { stacks: [], missing: [] };
  }
}

export function enqueueTask(queuePath, row, timelinePath = null, opts = {}) {
  return withLock(queuePath, () => {
    const required = ['id', 'wave', 'title', 'acceptance', 'verify_cmd'];
    for (const k of required) {
      if (!row[k] || typeof row[k] !== 'string') return { ok: false, reason: `missing/invalid field: ${k}` };
    }
    // R1：testing 必填（非空 string；允许"同 verify_cmd"这类引用式写法）
    if (!row.testing || typeof row.testing !== 'string' || !row.testing.trim()) {
      return { ok: false, reason: 'missing/invalid field: testing（入队必须写清测什么；可写"同 verify_cmd"引用验收命令）' };
    }
    // R2：stack 必填（三选一；存量老行无 stack 走 legacy 免检，由 requiredModels 识别，
    // 这里只管新入队：缺 stack/非法值一律拒收，理由指明三选一）。
    if (typeof row.stack !== 'string' || !TASK_STACKS.includes(row.stack)) {
      return { ok: false, reason: `missing/invalid field: stack (expect ${TASK_STACKS.join('/')})` };
    }
    // 可选风控字段：非法直接拒收（reason 指明期望形状）
    let risk = 'medium';
    if (row.risk !== undefined) {
      if (typeof row.risk !== 'string' || !TASK_RISKS.includes(row.risk)) {
        return { ok: false, reason: `invalid risk: ${JSON.stringify(row.risk)} (expect low/medium/high)` };
      }
      risk = row.risk;
    }
    let paths;
    if (row.paths !== undefined) {
      if (!Array.isArray(row.paths) || !row.paths.every((p) => typeof p === 'string')) {
        return { ok: false, reason: 'invalid paths: expect string[]' };
      }
      paths = [...row.paths];
    }
    let policy_exception = false;
    if (row.policy_exception !== undefined) {
      if (typeof row.policy_exception !== 'boolean') {
        return { ok: false, reason: 'invalid policy_exception: expect boolean' };
      }
      policy_exception = row.policy_exception;
    }
    // Reviewer-N1：review/reviewDepth/reviewRounds 可选字段。
    // review 未显式传入时默认 risk !== 'low'（medium/high 默认进评审，low 默认直通）；
    // 显式传入优先；存量 queue 行自带旧值不动，无迁移。
    let review = risk !== 'low';
    if (row.review !== undefined) {
      if (typeof row.review !== 'boolean') {
        return { ok: false, reason: 'invalid review: expect boolean' };
      }
      review = row.review;
    }
    let reviewDepth = 'quick';
    if (row.reviewDepth !== undefined) {
      if (row.reviewDepth !== 'quick' && row.reviewDepth !== 'standard') {
        return { ok: false, reason: 'invalid reviewDepth: expect quick|standard' };
      }
      reviewDepth = row.reviewDepth;
    }
    let reviewRounds = 0;
    if (row.reviewRounds !== undefined) {
      if (!Number.isInteger(row.reviewRounds) || row.reviewRounds < 0) {
        return { ok: false, reason: 'invalid reviewRounds: expect non-negative integer' };
      }
      reviewRounds = row.reviewRounds;
    }
    const tasks = readFresh(resolve(queuePath));
    if (tasks.some((t) => t.id === row.id)) return { ok: false, reason: `duplicate id: ${row.id}` };
    const task = {
      ...row, risk, ...(paths !== undefined ? { paths } : {}), policy_exception,
      review, reviewDepth, reviewRounds,
      status: 'queued', retries: 0, updated_at: new Date().toISOString(),
    };
    tasks.push(task);
    saveQueueAtomic(queuePath, tasks);
    appendTimeline(timelinePath, {
      taskId: task.id, kind: 'create', from: null, to: 'queued',
      by: opts?.by ?? 'plan', reason: opts?.reason ?? 'create',
      commit: task.commit, retries: 0, snapshot: structuredClone(task), ts: task.updated_at,
    });
    return { ok: true };
  });
}

/**
 * 只存变化字段 + 结果 status/retries/assignee/commit（重放能精确还原 next）。
 */
function diffPatch(cur, next, patch) {
  const out = {};
  for (const k of Object.keys(patch ?? {})) {
    try {
      if (JSON.stringify(patch[k]) !== JSON.stringify(cur[k])) out[k] = patch[k];
    } catch {
      out[k] = patch[k];
    }
  }
  out.status = next.status;
  if (next.retries !== undefined) out.retries = next.retries;
  if (next.assignee !== undefined) out.assignee = next.assignee;
  if (next.commit !== undefined) out.commit = next.commit;
  return out;
}

/**
 * timeline 追加（best-effort，永不抛错）：
 * timelinePath 缺省/缺文件时只跳过写行，主流程（queue 写）不受影响。
 * seq 取文件内最大 seq + 1，坏行跳过不占号。
 * R1：行顶层透出 testing/summary（取自 snapshot/patch，缺失不写；读出缺失显示“(未填写)”）。
 * R4：revert 行由此写（kind='revert' + snapshot）。
 */
export function appendTimeline(timelinePath, fields) {
  try {
    if (!timelinePath) return { appended: false };
    const path = resolve(String(timelinePath));
    mkdirSync(dirname(path), { recursive: true });
    let seq = 0;
    if (existsSync(path)) {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line);
          if (r && typeof r.seq === 'number' && r.seq > seq) seq = r.seq;
        } catch {
          // 坏行跳过，不占 seq
        }
      }
    }
    const row = {
      seq: seq + 1,
      ts: fields.ts ?? new Date().toISOString(),
      taskId: fields.taskId,
      kind: fields.kind,
      from: fields.from ?? null,
      to: fields.to ?? null,
      by: fields.by ?? '-',
      reason: fields.reason ?? '-',
      commit: fields.commit ?? '-',
      retries: fields.retries ?? 0,
    };
    if (fields.snapshot !== undefined) row.snapshot = fields.snapshot;
    if (fields.patch !== undefined) row.patch = fields.patch;
    // R1 行带 testing/summary：snapshot（create/revert 行）优先，其次 patch（move 行）
    const snap = (fields.snapshot && typeof fields.snapshot === 'object') ? fields.snapshot : {};
    const pt = (fields.patch && typeof fields.patch === 'object') ? fields.patch : {};
    if (snap.testing !== undefined) row.testing = snap.testing;
    else if (pt.testing !== undefined) row.testing = pt.testing;
    if (pt.summary !== undefined) row.summary = pt.summary;
    else if (snap.summary !== undefined) row.summary = snap.summary;
    appendFileSync(path, `${JSON.stringify(row)}\n`, 'utf8');
    try {
      const fd = openSync(path, 'a');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      // fsync 失败不影响已落盘内容（best-effort）
    }
    return { appended: true, seq: seq + 1 };
  } catch {
    return { appended: false };
  }
}

/**
 * FSM 迁移（推荐唯一写入口）：同一把锁内 fresh 读 → expect 校验 →
 * 状态表校验（swarm-fsm.js）→ patch → 写 timeline → 原子写 queue。
 * 非法迁移返回 { ok:false, reason }（reason 恒含 `allowed:`），调用方永不抛错。
 * timelinePath 缺省（null/''）即不写 timeline，只写 queue。
 */
export function transitionTask(queuePath, timelinePath, { taskId, expect, patch = {}, by, reason } = {}) {
  return withLock(queuePath, () => {
    const path = resolve(queuePath);
    const tasks = readFresh(path);
    const i = tasks.findIndex((t) => t.id === taskId);
    if (i < 0) return { ok: false, reason: `task not found: ${taskId}` };
    const cur = tasks[i];
    const expects = Array.isArray(expect) ? expect : [expect];
    if (!expects.includes(cur.status)) {
      return { ok: false, reason: `cannot transition: ${cur.id} is ${cur.status}, expect ${expects.join('/')} ; allowed: ${allowedFrom(cur.status).join('/') || '(none)'}` };
    }
    const to = patch?.status;
    if (to !== undefined && to !== null && String(to) !== String(cur.status) && !allowedFrom(cur.status).includes(String(to))) {
      return { ok: false, reason: `illegal transition: ${cur.id} ${cur.status}→${to} not allowed; allowed: ${allowedFrom(cur.status).join('/') || '(none)'}` };
    }
    const now = new Date().toISOString();
    const next = { ...cur, ...patch, updated_at: now };
    tasks[i] = next;
    saveQueueAtomic(queuePath, tasks);
    appendTimeline(timelinePath, {
      taskId, kind: 'move', from: cur.status, to: next.status,
      by, reason, commit: next.commit, retries: next.retries,
      patch: diffPatch(cur, next, patch), ts: now,
    });
    return { ok: true, task: structuredClone(next) };
  });
}
