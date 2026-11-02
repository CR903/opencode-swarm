/**
 * swarm-run — Run 隔离：多需求并行的命名空间解析（纯 ESM；唯一内部依赖是
 * 同目录 swarm-sessions 的 `writeRound` 原子台账写入，见 migrateLegacy）。
 *
 * 背景：单全局 `.trellis/swarm-queue.jsonl + round.json` 双需求并行会串队列、
 * 串唤醒、串命名。本层是唯一的 run 解析入口：
 *
 *   resolveRun(cwd, { run?, queue?, channel?, cfgRunId? })
 *     -> { runId, runDir, queuePath, roundPath, eventsDir, metaPath, channel }
 *
 * 优先级：显式 run（工具 input.run / 命令 --run）> cfgRunId（插件 options.runId，
 * 仅当用户显式配置才传）> `.swarm/current` 指针 > `default`。
 *
 * 约定：
 * - run 落盘目录固定为 `<cwd>/.swarm/runs/<runId>/`，内含
 *   `{ meta.json, queue.jsonl, events.jsonl, round.json }`。
 * - 只有显式传的 `queue`（单测/e2e/旧调用）才尊重，全是相对路径一律经
 *   `abs(cwd)` 转绝对；默认 queuePath = `<runDir>/queue.jsonl`，不再默认全局队列。
 * - `sanitizeRunId` 只留中/英/数字/`_`/`-`（空/非法 → `default`），charset 本身不含
 *   `.` 与 `/`，runDir 不可能逃出 `.swarm/runs/`（防路径穿越）。
 * - 本文件永不抛错给调用方制造惊喜之外：LLM 工具链要求 filebus 那种永不抛错，
 *   但解析层保持同步精简，IO 失败一律收敛为空值；且全文件无 console 输出
 *   （插件进程 console 不可见，见 opencode2-plugin-guide 陷阱 1）。
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
  readdirSync, statSync, renameSync, unlinkSync,
} from 'node:fs';
import { resolve, join, relative, dirname } from 'node:path';
import { writeRound } from './swarm-sessions.js';

export const DEFAULT_RUN_ID = 'default';
export const MAX_RUN_ID_LEN = 64;

/**
 * 执行器：`hybrid` = 默认混合（dev/plan 走 sessions 常驻会话唤醒，test/reviewer 走 subagents 一次性派发）；
 * `sessions` = 显式整轮会话唤醒（老行为，dev/test 均唤醒）；
 * `subagents` = 显式整轮子代理派发（老行为，均不唤醒）。
 * 存 run meta.json（`{executor, roleModels}`），缺字段/非法值一律归一 `hybrid`。
 */
export const EXECUTORS = ['sessions', 'subagents', 'hybrid'];
export function normalizeExecutor(v) {
  const s = String(v ?? '').trim();
  if (s === 'sessions') return 'sessions';
  if (s === 'subagents') return 'subagents';
  if (s === 'hybrid') return 'hybrid';
  return 'hybrid';
}

/**
 * 按角色执行器（混合口径唯一真相）：
 * 显式整轮 sessions/subagents 零变（全角色同值）；
 * hybrid 缺省：dev/plan 走 sessions（常驻唤醒），test/reviewer 走 subagents（一次性）。
 * 永不抛错。
 */
export function executorForRole(executor, role) {
  try {
    const ex = normalizeExecutor(executor);
    if (ex === 'sessions' || ex === 'subagents') return ex;
    return (role === 'dev' || role === 'plan') ? 'sessions' : 'subagents';
  } catch {
    return (role === 'dev' || role === 'plan') ? 'sessions' : 'subagents';
  }
}

/** R5：fail disposition 枚举（fixed/wrong/intentional/wontfix，缺失拒收）。 */
export const DISPOSITIONS = ['fixed', 'wrong', 'intentional', 'wontfix'];

/**
 * Reviewer-N1：finding 契约（PRD §1，存 queue patch + timeline review 行）。
 * findings: [{id, severity: Important|Nit|Pre-existing, file, line, rule, evidence, suggestion, status: open|fixed|wontfix, reason?}]
 * 关闭语义平移 swarm_test disposition：只有 fixed 或 wontfix+reason 能关闭，否则拒收。
 */
export const FINDING_SEVERITIES = ['Important', 'Nit', 'Pre-existing'];
export const FINDING_STATUSES = ['open', 'fixed', 'wontfix'];
export const REVIEW_VERDICTS = ['approve', 'request-changes'];
export const REVIEW_DEPTHS = ['quick', 'standard'];
export const REVIEW_MAX_ROUNDS = 2;

/** 单条 finding 校验（永不抛错；缺字段/非法枚举/关闭无 reason 一律拒）。 */
export function validateFinding(f) {
  try {
    if (!f || typeof f !== 'object') return { ok: false, reason: 'finding 须为对象' };
    if (typeof f.id !== 'string' || !f.id.trim()) return { ok: false, reason: 'finding 缺 id' };
    if (!FINDING_SEVERITIES.includes(f.severity)) {
      return { ok: false, reason: `finding ${f.id} severity 非法：${String(f.severity).slice(0, 40)}（expect ${FINDING_SEVERITIES.join('/')})` };
    }
    if (!FINDING_STATUSES.includes(f.status)) {
      return { ok: false, reason: `finding ${f.id} status 非法：${String(f.status).slice(0, 40)}（expect ${FINDING_STATUSES.join('/')})` };
    }
    if (f.status === 'wontfix' && (typeof f.reason !== 'string' || !f.reason.trim())) {
      return { ok: false, reason: `finding ${f.id} wontfix 必须写 reason` };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'finding 校验异常' };
  }
}

/** finding 数组校验（非数组/逐条非法一律拒；空数组放行，由 verdict 层再判）。 */
export function validateFindings(list) {
  try {
    if (list === undefined || list === null) return { ok: true, value: [] };
    if (!Array.isArray(list)) return { ok: false, reason: 'findings 须为数组' };
    for (const f of list) {
      const r = validateFinding(f);
      if (!r.ok) return r;
    }
    return { ok: true, value: list };
  } catch {
    return { ok: false, reason: 'findings 校验异常' };
  }
}

/**
 * verdict 校验（与 findings 联动）：
 * - verdict 非法直接拒；
 * - request-changes 必须含 ≥1 条 open Important，否则拒（空 Important 不得打回）；
 * - approve 不得含 open Important（只允许 Nit/Pre-existing open），否则拒。
 * 永不抛错。
 */
export function validateReviewVerdict(verdict, findings) {
  try {
    const v = typeof verdict === 'string' ? verdict.trim() : '';
    if (!REVIEW_VERDICTS.includes(v)) {
      return { ok: false, reason: `verdict 非法：${String(verdict).slice(0, 40)}（expect ${REVIEW_VERDICTS.join('/')})` };
    }
    const list = Array.isArray(findings) ? findings : [];
    const openImportant = list.filter((f) => f && f.severity === 'Important' && f.status === 'open');
    if (v === 'request-changes' && openImportant.length < 1) {
      return { ok: false, reason: 'request-changes 必须含 ≥1 条 open Important（空 Important 不得打回）' };
    }
    if (v === 'approve' && openImportant.length > 0) {
      return { ok: false, reason: `approve 不得含 open Important（${openImportant.length} 条未关闭：${openImportant.slice(0, 3).map((f) => f.id).join(',')}）` };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'verdict 校验异常' };
  }
}

/** finding 去重键：同 file+line+rule 合并（确定性代码），冲突（同 file+line 不同 rule）留两条。 */
export function findingKey(f) {
  try {
    return `${String(f?.file ?? '')}\0${String(f?.line ?? '')}\0${String(f?.rule ?? '')}`;
  } catch {
    return '';
  }
}

/**
 * 合并两批 findings（N1 去重投票替代）：
 * 同 file+line+rule 只留一条（新优先：后报的状态覆盖先报，支持 reviewer 标 fixed）；
 * 不同 rule 即使同 file+line 也留两条。永不抛错。
 */
export function mergeFindings(base, incoming) {
  try {
    const out = [];
    const indexByKey = new Map();
    const pushOrReplace = (f) => {
      if (!f || typeof f !== 'object') return;
      const k = findingKey(f);
      if (!k || k === '\0\0') {
        out.push(f);
        return;
      }
      if (indexByKey.has(k)) {
        out[indexByKey.get(k)] = f;
        return;
      }
      indexByKey.set(k, out.length);
      out.push(f);
    };
    if (Array.isArray(base)) for (const f of base) pushOrReplace(f);
    if (Array.isArray(incoming)) for (const f of incoming) pushOrReplace(f);
    return out;
  } catch {
    return [...(Array.isArray(base) ? base : [])];
  }
}

/** 排除集：任务已有 findings 的全部 id（已 open + 已关闭全列，供下一轮 reviewer 防重贴）。永不抛错。 */
export function excludedFindingIds(task) {
  try {
    const list = task && Array.isArray(task.findings) ? task.findings : [];
    return list.filter((f) => f && typeof f.id === 'string' && f.id).map((f) => f.id);
  } catch {
    return [];
  }
}

/**
 * 检查新 findings 与排除集交集（收敛“不重复贴”）：
 * 返回重叠 id 数组（空 = 无重复，可放行）。永不抛错。
 */
export function excludedIntersection(findings, excluded) {
  try {
    const set = new Set(Array.isArray(excluded) ? excluded : []);
    if (!set.size || !Array.isArray(findings)) return [];
    return findings.filter((f) => f && typeof f.id === 'string' && set.has(f.id)).map((f) => f.id);
  } catch {
    return [];
  }
}

/**
 * REVIEW.md 就近加载（纯函数 + 同步 IO，永不抛错）：
 * task.paths（如有）逐个向上找 `.opencode/review/<前缀>.md`，命中最近祖先优先；
 * 都不命中回 `.opencode/review/_default.md` 通用口径；
 * _default.md 缺失/空才回 null（调用方用通用口径）。
 * 例：paths=['src/a/b.ts'] → 依次试 src/a/b.ts.md、src/a/b.md、src/a.md、src.md，首中即返。
 * @returns {{file:string, content:string} | null}
 */
export function resolveReviewDoc(cwd, task) {
  try {
    const base = resolve(cwd);
    const readIfHit = (file) => {
      try {
        if (!existsSync(file)) return null;
        const content = readFileSync(file, 'utf8');
        if (typeof content === 'string' && content.trim()) {
          return { file, content };
        }
      } catch {
        // 读失败视同未命中，继续走兜底链
      }
      return null;
    };
    const fallback = () => readIfHit(join(base, '.opencode', 'review', '_default.md'));
    const paths = task && Array.isArray(task.paths)
      ? task.paths.filter((p) => typeof p === 'string' && p.trim())
      : [];
    if (!paths.length) return fallback();
    const candidates = [];
    for (const raw of paths) {
      const norm = String(raw).trim().replace(/^\.\//, '').replace(/^\/+/, '');
      if (!norm || norm === '.' || norm.includes('..')) continue;
      const parts = norm.split('/').filter(Boolean);
      if (!parts.length) continue;
      // 全路径（含文件名）优先，其次逐级 dirname；文件另试去扩展名一档
      const tries = [norm];
      const last = parts[parts.length - 1];
      if (last && last.includes('.')) {
        const noExt = [...parts.slice(0, -1), last.replace(/\.[^.]+$/, '')].join('/');
        if (noExt && noExt !== norm) tries.push(noExt);
      }
      for (let i = parts.length - 1; i >= 1; i -= 1) {
        tries.push(parts.slice(0, i).join('/'));
      }
      for (const prefix of tries) {
        candidates.push({ prefix, depth: prefix.split('/').length, file: join(base, '.opencode', 'review', `${prefix}.md`) });
      }
    }
    // 去重（同 file 只留最深一次），按 depth 降序 = 最近祖先优先
    const seen = new Set();
    const ordered = [];
    for (const c of candidates.sort((a, b) => b.depth - a.depth)) {
      if (seen.has(c.file)) continue;
      seen.add(c.file);
      ordered.push(c);
    }
    for (const c of ordered) {
      const hit = readIfHit(c.file);
      if (hit) return hit;
    }
    return fallback();
  } catch {
    return null;
  }
}

/**
 * R5+R6：rounds-to-pass = 本 run 已 passed 任务的 (to=dev_doing timeline 计数+1) 均值。
 * 定义（手册同步）：每个 passed 任务统计其 timeline 行中 to==='dev_doing' 的次数（含初次派发、
 * test fail 打回、gate 打回，均计入），再 +1；对全部 passed 任务取均值。无 passed 时 mean=null。
 * @returns {{mean:number|null, count:number, values:number[]}} 永不抛错。
 */
export function roundsToPass(tasks, rows) {
  try {
    const passed = (Array.isArray(tasks) ? tasks : []).filter((t) => t && t.status === 'passed');
    if (!passed.length) return { mean: null, count: 0, values: [] };
    const list = Array.isArray(rows) ? rows : [];
    const values = passed.map((t) => {
      let c = 0;
      for (const r of list) {
        if (r && r.taskId === t.id && r.to === 'dev_doing') c += 1;
      }
      return c + 1;
    });
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return { mean, count: passed.length, values };
  } catch {
    return { mean: null, count: 0, values: [] };
  }
}

/**
 * R5+R6：fail disposition 分布计数（当前队列任务的 disposition 字段统计，非法值忽略）。
 * @returns {{fixed:number, wrong:number, intentional:number, wontfix:number}} 永不抛错。
 */
export function dispositionDist(tasks) {
  const out = { fixed: 0, wrong: 0, intentional: 0, wontfix: 0 };
  try {
    for (const t of Array.isArray(tasks) ? tasks : []) {
      const d = t && typeof t.disposition === 'string' ? t.disposition : null;
      if (d && Object.prototype.hasOwnProperty.call(out, d)) out[d] += 1;
    }
  } catch { /* 永不抛错 */ }
  return out;
}

/**
 * R5+R6：HALT 三轮 detail 摘要（从 timeline patch 取，沿用 500 字截断）。
 * 取该任务最后 n 条含 patch.detail 的行，截断后返回；无则 []（调用方显示“(无记录)”）。
 * @returns {string[]} 永不抛错。
 */
export function lastFailDetails(runDir, taskId, n = 3, trunc = 500) {
  try {
    const rows = readTimeline(runDir).filter(
      (r) => r && r.taskId === taskId && r.patch && typeof r.patch.detail === 'string' && r.patch.detail,
    );
    return rows.slice(-Math.max(1, n)).map((r) => String(r.patch.detail).slice(0, Math.max(1, trunc)));
  } catch {
    return [];
  }
}

/** 只留白名单字符（中/英/数字/`_`/`-`），空/非法一律归一到 `default`
 * （`../` → 空 → `default`；白名单不含 `.` 与 `/`，runDir 不可能逃出 `.swarm/runs/`，
 * 中文区（\u3400-\u4dbf\u4e00-\u9fff）同样不含任何路径分隔符，防穿越性质不变）。 */
export function sanitizeRunId(v) {
  const s = String(v ?? '').trim();
  if (!s) return DEFAULT_RUN_ID;
  const clean = s.replace(/[^A-Za-z0-9_\-\u3400-\u4dbf\u4e00-\u9fff]/g, '').slice(0, MAX_RUN_ID_LEN);
  return clean || DEFAULT_RUN_ID;
}

/** 相对路径一律经 abs(cwd) 转绝对（约束：插件进程 cwd 不可靠，调用方传项目根）。 */
export function absPath(cwd, p) {
  const s = String(p ?? '');
  if (!s) return s;
  return s.startsWith('/') ? s : resolve(cwd, s);
}

/**
 * 由 `--name` 派生新轮 runId（/swarm-up 无 `--run` 时用，防复用脏 `default` 目录）：
 * 只留中文/英文/数字/`_`/`-`（与 sanitizeRunId 同口径），截 40；
 * 派不出名字（空/全符号）回退 `run-<MMDD-HHmm>`，永不归一到 `default`。
 * @param {string} name 需求名（--name 原文）
 * @param {Date} [now] 时间回退的时钟（单测可注入，默认当前时间）
 */
export function deriveRunIdFromName(name, now = new Date()) {
  const s = String(name ?? '').trim().replace(/[^A-Za-z0-9_\-\u3400-\u4dbf\u4e00-\u9fff]/g, '').slice(0, 40);
  if (s) return s;
  const d = now instanceof Date ? now : new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  return `run-${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/**
 * 轮目录是否非空（up 派生冲突/复用判定口径）：
 * 目录存在且任一核心文件（queue/round/meta/timeline/events）有内容即非空；
 * 目录缺失或全空文件视为空（可直接复用，无串味风险）。永不抛错。
 */
export function isRunDirNonEmpty(cwd, runId) {
  try {
    const d = runDirFor(cwd, runId);
    let isDir = false;
    try {
      isDir = statSync(d).isDirectory();
    } catch {
      return false;
    }
    if (!isDir) return false;
    for (const f of ['queue.jsonl', 'round.json', 'meta.json', 'timeline.jsonl', 'events.jsonl']) {
      try {
        if (String(readFileSync(join(d, f), 'utf8')).trim()) return true;
      } catch {
        // 缺文件视为空，继续看下一个
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 新轮唯一 runId（--name 派生冲突后缀习惯：`-2`/`-3`…）：
 * 目标非空才加后缀；目录缺失或全空直接用（沿用“空位复用无风险”习惯）。
 * 永不抛错（极端全满回 `base-<末5位时间戳>`，恒返回可用值）。
 */
export function resolveUniqueRunId(cwd, base) {
  try {
    const b = String(base ?? '').trim() || DEFAULT_RUN_ID;
    if (!isRunDirNonEmpty(cwd, b)) return b;
    for (let n = 2; n < 1000; n += 1) {
      const cand = `${b}-${n}`;
      if (!isRunDirNonEmpty(cwd, cand)) return cand;
    }
    return `${b}-${Date.now() % 100000}`;
  } catch {
    return String(base ?? '').trim() || DEFAULT_RUN_ID;
  }
}

/**
 * 某轮队列是否有任务行（显式 `--run` 复用拦截口径）：
 * 只看该 run 自有 `queue.jsonl`（≥1 非空行即非空），不看显式 queue 兼容通道
 * （隔离语义：up 落盘只写 run 自有位，判空也只看自有位才对得上）。
 * 缺文件/坏行视为空。永不抛错。
 */
export function runQueueHasTasks(cwd, runId) {
  try {
    const text = String(readFileSync(join(runDirFor(cwd, runId), 'queue.jsonl'), 'utf8'));
    return text.split('\n').some((l) => l.trim());
  } catch {
    return false;
  }
}

export function runsRoot(cwd) {
  return join(resolve(cwd), '.swarm', 'runs');
}

export function runDirFor(cwd, runId) {
  return join(runsRoot(cwd), sanitizeRunId(runId));
}

function currentFile(cwd) {
  return join(resolve(cwd), '.swarm', 'current');
}

/** 读 `.swarm/current` 指针（一行文本 runId）；缺文件/空 → null（再由上层归一）。 */
export function readCurrentRunId(cwd) {
  try {
    const line = String(readFileSync(currentFile(cwd), 'utf8')).split('\n')[0].trim();
    return line ? sanitizeRunId(line) : null;
  } catch {
    return null;
  }
}

/** 写 `.swarm/current` 指针（tmp + rename 原子写）。返回归一后的 runId。 */
export function writeCurrentRunId(cwd, runId) {
  const id = sanitizeRunId(runId);
  const file = currentFile(cwd);
  mkdirSync(join(resolve(cwd), '.swarm'), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, `${id}\n`, 'utf8');
  renameSync(tmp, file);
  return id;
}

/** 清空 `.swarm/current` 指针（删文件；缺文件视为已清空）。永不抛错。 */
export function clearCurrentRunId(cwd) {
  try {
    unlinkSync(currentFile(cwd));
  } catch {
    // 缺文件/删失败都视为已清空（board 读不到指针即走灰态）
  }
  return null;
}

/** 归档根 `.swarm/archive/`（clean 目标父目录）。 */
export function archiveRoot(cwd) {
  return join(resolve(cwd), '.swarm', 'archive');
}

/**
 * 归档某轮：`.swarm/runs/<id>/` → `.swarm/archive/<id>-<YYYYMMDD-HHmm>/`
 * （整目录 rename，queue/timeline/events/round/meta 全保留供审计；目标冲突追加 -01/-02）。
 * 源缺失/非目录 → { ok:false, reason }；永不抛错、无 console。
 */
export function archiveRun(cwd, runId) {
  try {
    const id = sanitizeRunId(runId);
    const src = runDirFor(cwd, id);
    let isDir = false;
    try {
      isDir = statSync(src).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) return { ok: false, runId: id, reason: `轮不存在：${id}（${src} 缺失）` };
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    const root = archiveRoot(cwd);
    mkdirSync(root, { recursive: true });
    let dest = join(root, `${id}-${stamp}`);
    let n = 0;
    while (existsSync(dest)) {
      n += 1;
      dest = join(root, `${id}-${stamp}-${pad(n)}`);
    }
    renameSync(src, dest);
    return { ok: true, runId: id, from: src, to: dest };
  } catch (e) {
    try {
      return { ok: false, runId: sanitizeRunId(runId), reason: `归档失败：${String(e?.message ?? e).slice(0, 120)}` };
    } catch {
      return { ok: false, runId: 'default', reason: '归档失败' };
    }
  }
}

/**
 * 会话 → run 索引（`sessions` 角色会话 + `members` 动态成员，后者供主会话/子代理使用）。
 * 同一 sid 出现在多轮时按 listRuns 顺序后者覆盖（属主判定仍由插件侧 foreignOwnerOf 负责）；
 * 这里只做「这个会话属于哪一轮」的快速反查。永不抛错。
 */
export function sessionRunIndex(cwd) {
  const out = {};
  try {
    const base = resolve(cwd);
    for (const r of listRuns(base)) {
      const round = readJsonFile(join(r.runDir, 'round.json')) ?? {};
      for (const sid of Object.values(round.sessions ?? {})) {
        if (typeof sid === 'string' && sid) out[sid] = r.runId;
      }
      for (const sid of Object.keys(round.members ?? {})) {
        if (typeof sid === 'string' && sid) out[sid] = r.runId;
      }
    }
  } catch { /* 读失败回空索引，调用方回退 current */ }
  return out;
}

/** 会话归属的 runId（无绑定 → null）。永不抛错。 */
export function runIdForSession(cwd, sessionID) {
  try {
    const sid = typeof sessionID === 'string' ? sessionID.trim() : '';
    if (!sid) return null;
    return sessionRunIndex(cwd)[sid] ?? null;
  } catch {
    return null;
  }
}

/**
 * 任务 → run 反查（子代理常不带 run 调用，但一定带 task_id）：
 * 逐轮扫 queue.jsonl，命中即返回该 runId；多轮同 id 取 listRuns 首轮（id 全局唯一为常态）。
 * 永不抛错（缺文件/坏行跳过）。
 */
export function runIdForTask(cwd, taskId) {
  try {
    const id = typeof taskId === 'string' ? taskId.trim() : '';
    if (!id) return null;
    const base = resolve(cwd);
    for (const r of listRuns(base)) {
      let text = '';
      try { text = String(readFileSync(join(r.runDir, 'queue.jsonl'), 'utf8')); } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const t = JSON.parse(line);
          if (t && t.id === id) return r.runId;
        } catch { /* 坏行跳过 */ }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 解析当前应操作的轮（唯一入口）：
 *   显式 run > cfgRunId > 任务归属（taskId）> 会话绑定（sessionID）> `.swarm/current` > default。
 *
 * 为什么加中间两级（10-31 并行两轮串轮事故）：
 * 原优先级只有「显式 run > current」，而 current 是**全局单指针** —— 第二个 /swarm-up
 * 把指针切走后，第一个轮次里所有会话的工具调用都落到新轮，串队列、串改名、串唤醒。
 * 会话绑定与任务归属都是**会话/任务自带**的定位信息，优先于全局指针，
 * 从根上消除「并行两轮互相抢指针」。
 */
export function resolveRun(cwd, opts = {}) {
  const base = resolve(cwd);
  const { run, queue, channel, cfgRunId, sessionID, taskId } = opts;
  let runId;
  if (run !== undefined && run !== null && String(run).trim() !== '') {
    runId = sanitizeRunId(run);
  } else if (cfgRunId !== undefined && cfgRunId !== null && String(cfgRunId).trim() !== '') {
    runId = sanitizeRunId(cfgRunId);
  } else {
    runId = runIdForTask(base, taskId)
      ?? runIdForSession(base, sessionID)
      ?? readCurrentRunId(base)
      ?? DEFAULT_RUN_ID;
  }
  const runDir = join(base, '.swarm', 'runs', runId);
  const hasQueue = queue !== undefined && queue !== null && String(queue) !== '';
  // 执行器只读 meta（缺文件/坏行 → 默认 hybrid；非法值归一），永不抛错。
  let executor = 'hybrid';
  let roleModels = {};
  try {
    const meta = readJsonFile(join(runDir, 'meta.json')) ?? {};
    executor = normalizeExecutor(meta.executor);
    if (meta.roleModels && typeof meta.roleModels === 'object') roleModels = { ...meta.roleModels };
  } catch {
    executor = 'hybrid';
    roleModels = {};
  }
  return {
    runId,
    runDir,
    queuePath: hasQueue ? absPath(base, queue) : join(runDir, 'queue.jsonl'),
    roundPath: join(runDir, 'round.json'),
    eventsDir: runDir,
    metaPath: join(runDir, 'meta.json'),
    timelinePath: join(runDir, 'timeline.jsonl'),
    channel: channel ?? 'swarm',
    executor,
    roleModels,
  };
}

/** run 目录的 timeline.jsonl 路径（队列快照对应的事件源）。 */
export function timelinePathFor(cwd, runId) {
  return join(runDirFor(cwd, runId), 'timeline.jsonl');
}

function readTimelineRows(file) {
  try {
    const text = readFileSync(file, 'utf8');
    const rows = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r && typeof r === 'object') rows.push(r);
      } catch {
        // 坏行跳过，不抛错
      }
    }
    return rows;
  } catch {
    return [];
  }
}

/** 读某 run 的 timeline（文件序；缺文件/坏行 → 空/跳过，永不抛错）。 */
export function readTimeline(runDir) {
  return readTimelineRows(join(resolve(runDir), 'timeline.jsonl'));
}

/**
 * 由 timeline 按 seq 重放建队列（create 建快照、move 合 patch、revert 置快照）：
 * transitionTask 存的 patch 恒含结果 status/retries/assignee/commit，
 * move 行 ts 即写 queue 时的 updated_at，重放结果与 queue.jsonl deep-equal。
 * R4：revert 行重放即把该任务置为行内 snapshot（与 revert 写回的 queue 状态一致，
 * 单测锁住“rebuild 与队列分叉”）。
 * 无 create 的悬空 move/revert 跳过；缺文件 → []。
 */
export function rebuildQueueFromTimeline(runDir) {
  const rows = readTimeline(runDir).slice().sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const tasks = new Map();
  for (const row of rows) {
    if (!row || !row.taskId) continue;
    if (row.kind === 'create') {
      if (row.snapshot && typeof row.snapshot === 'object') tasks.set(row.taskId, structuredClone(row.snapshot));
      continue;
    }
    if (row.kind === 'revert') {
      if (row.snapshot && typeof row.snapshot === 'object') tasks.set(row.taskId, structuredClone(row.snapshot));
      continue;
    }
    if (row.kind === 'move') {
      const cur = tasks.get(row.taskId);
      if (!cur) continue;
      const p = row.patch && typeof row.patch === 'object' ? row.patch : {};
      const next = { ...cur, ...p };
      if (row.to !== undefined && row.to !== null) next.status = row.to;
      if (row.ts) next.updated_at = row.ts;
      tasks.set(row.taskId, next);
    }
  }
  return [...tasks.values()];
}

/**
 * R4：取某任务最后一次进入 gate_check 之前的状态（revert 回放目标）。
 * 从 create 快照起，按 seq 把最后一条 `to==='gate_check'` 之前的行依次合上
 * （move 合 patch，revert 置快照），返回该时刻的任务深拷贝。
 * 调用方再 status=dev_doing + verdict_path=null 写回。
 * 无 create / 无 gate-enter 历史 → { ok:false, reason }（调用方给人话，不抛错）。
 */
export function stateBeforeLastGateEnter(runDir, taskId) {
  try {
    const rows = readTimeline(runDir).slice().sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    const mine = rows.filter((r) => r && r.taskId === taskId);
    if (!mine.some((r) => r.kind === 'create')) return { ok: false, reason: `no create row: ${taskId}` };
    let lastEnter = -1;
    mine.forEach((r, i) => {
      if (r.kind === 'move' && r.to === 'gate_check') lastEnter = i;
    });
    if (lastEnter < 0) return { ok: false, reason: `${taskId} 从未进入 gate_check，无可回退点` };
    let prior = null;
    for (let i = 0; i < lastEnter; i++) {
      const r = mine[i];
      if (r.kind === 'create') {
        if (r.snapshot && typeof r.snapshot === 'object') prior = structuredClone(r.snapshot);
        continue;
      }
      if (r.kind === 'revert') {
        if (r.snapshot && typeof r.snapshot === 'object') prior = structuredClone(r.snapshot);
        continue;
      }
      if (r.kind === 'move') {
        if (!prior) continue;
        const p = r.patch && typeof r.patch === 'object' ? r.patch : {};
        prior = { ...prior, ...p };
        if (r.to !== undefined && r.to !== null) prior.status = r.to;
        if (r.ts) prior.updated_at = r.ts;
      }
    }
    if (!prior) return { ok: false, reason: `no state before gate-enter: ${taskId}` };
    return { ok: true, prior };
  } catch (e) {
    return { ok: false, reason: `replay failed: ${String(e?.message ?? e).slice(0, 120)}` };
  }
}

/** 相对 cwd 的短显示（status 输出用，落盘外可读性）。 */
export function displayPath(cwd, p) {
  try {
    const r = relative(resolve(cwd), resolve(p));
    return r.startsWith('..') || r === '' ? String(p) : r;
  } catch {
    return String(p);
  }
}

function readJsonFile(path) {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

function writeJsonAtomic(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
  return obj;
}

/** 读某 run 的 meta.json；缺失/损坏 → null。 */
export function readMeta(cwd, runId) {
  const id = sanitizeRunId(runId);
  return readJsonFile(join(runDirFor(cwd, id), 'meta.json'));
}

/**
 * 写某 run 的 meta.json（merge 语义，补 updatedAt）。
 * @returns 写完的 meta 对象。
 */
export function writeMeta(cwd, runId, patch = {}) {
  const id = sanitizeRunId(runId);
  const file = join(runDirFor(cwd, id), 'meta.json');
  const prev = readJsonFile(file) ?? {};
  const next = {
    ...prev,
    runId: id,
    name: patch.name ?? prev.name ?? '',
    createdAt: prev.createdAt ?? patch.createdAt ?? new Date().toISOString(),
    ...patch,
    runId: id,
    updatedAt: new Date().toISOString(),
  };
  mkdirSync(dirname(file), { recursive: true });
  writeJsonAtomic(file, next);
  return next;
}

/** 首写保障：meta 缺失才建（补 name），已存在时只在缺名且给了名时补名。 */
export function ensureRunMeta(cwd, runId, extra = {}) {
  const id = sanitizeRunId(runId);
  const cur = readMeta(cwd, id);
  if (!cur) return writeMeta(cwd, id, { name: extra.name ?? '' });
  if (extra.name && !cur.name) return writeMeta(cwd, id, { name: extra.name });
  return cur;
}

/** 列出 `.swarm/runs/*`（仅目录），按 createdAt 升序；坏 meta 跳过不抛错。 */
export function listRuns(cwd) {
  const root = runsRoot(cwd);
  let entries = [];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const out = [];
  for (const name of entries) {
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const meta = readJsonFile(join(dir, 'meta.json')) ?? {};
    out.push({
      runId: name,
      name: typeof meta.name === 'string' ? meta.name : '',
      createdAt: typeof meta.createdAt === 'string' ? meta.createdAt : null,
      runDir: dir,
    });
  }
  out.sort((a, b) => {
    const x = a.createdAt ?? '';
    const y = b.createdAt ?? '';
    if (x === y) return a.runId < b.runId ? -1 : 1;
    return x < y ? -1 : 1;
  });
  return out;
}

function isNonEmptyFile(path) {
  try {
    if (!existsSync(path)) return false;
    return String(readFileSync(path, 'utf8')).trim().length > 0;
  } catch {
    return false;
  }
}

function copyIfExists(src, dst, record, tag) {
  try {
    if (!existsSync(src)) {
      record.skipped.push(`${tag}: 无源文件`);
      return;
    }
    mkdirSync(dirname(resolve(dst)), { recursive: true });
    writeFileSync(dst, readFileSync(src));
    record.copied.push(`${tag}: ${src} → ${dst}`);
  } catch (e) {
    record.skipped.push(`${tag}: 复制失败 ${String(e?.message ?? e).slice(0, 120)}`);
  }
}

/**
 * 一次性迁移：旧全局 `queue.jsonl + round.json + events.jsonl` 拷入目标 run。
 * 幂等：目标 queue 非空且 !force → 直接拒绝（ok:false），绝不覆盖；
 * 无旧文件 → 空跑成功（copied 为空，message 说明）。
 * 成功后若尚无 current 指针，把指针指向该 run（status 默认就能看见）。
 *
 * 禁跨轮继承（R1）：round 只搬 `{name, createdAt}`，旧 `sessions` 一律丢弃并在 notes 里报数。
 * 理由：旧全局台账的会话属于上一轮（常常已归档到 `.swarm/archive/**`，不在 listRuns 扫描范围，
 * 插件层的 foreignOwnerOf 拦不住）。照搬进新轮 = 把 stale 会话登记成本轮会话，
 * 接着 nameRound 会给它们改名、wakeRole 会把新任务投给昨天的会话（10-31 事故）。
 * 新轮会话只能由 `/swarm-up` 重建。
 */
export function migrateLegacy(cwd, opts = {}) {
  const base = resolve(cwd);
  const { run, legacyQueue, legacyDir, force = false } = opts;
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const target = resolveRun(base, { run: run ?? `migrated-${stamp}` });
  const lq = legacyQueue !== undefined && legacyQueue !== null && String(legacyQueue) !== ''
    ? absPath(base, legacyQueue)
    : join(base, '.trellis', 'swarm-queue.jsonl');
  const ld = legacyDir !== undefined && legacyDir !== null && String(legacyDir) !== ''
    ? resolve(base, String(legacyDir))
    : join(base, '.trellis', 'swarm-state');

  if (!force && isNonEmptyFile(target.queuePath)) {
    return {
      ok: false,
      runId: target.runId,
      reason: `目标已有数据，拒绝覆盖：${displayPath(base, target.queuePath)}（确认要重迁加 --force）`,
      copied: [],
      skipped: [],
    };
  }

  mkdirSync(target.runDir, { recursive: true });
  const record = { copied: [], skipped: [], notes: [] };
  copyIfExists(lq, target.queuePath, record, 'queue');
  // round 只在目标为空（或 force）时覆盖：/swarm-up 可能已在该 run 登记了新会话，
  // 直接覆盖会把新台账洗掉（queue 为空但 round 非空的半初始化轮）。
  // 且**不照搬 sessions**（见函数头「禁跨轮继承」）：只保留 name/createdAt。
  const legacyRound = readJsonFile(join(ld, 'round.json')) ?? {};
  const droppedSessions = Object.keys(legacyRound.sessions ?? {}).length;
  if (!force && isNonEmptyFile(target.roundPath)) {
    record.skipped.push('round: 目标已有台账，保留（加 --force 才覆盖）');
  } else if (!existsSync(join(ld, 'round.json'))) {
    record.skipped.push('round: 无源文件');
  } else {
    try {
      // N7：走 writeRound 的原子实现（tmp + rename），与 queue/meta 一致 —— 直接
      // writeFileSync 目标文件在进程被杀时留半截 JSON，readRound 会 catch 成 {}，
      // 该轮 name/createdAt 静默丢失。replaceSessions:true 的语义正好是
      // 「只留 name/createdAt，sessions 置空」。
      const filtered = {
        name: typeof legacyRound.name === 'string' ? legacyRound.name : '',
        ...(legacyRound.createdAt ? { createdAt: legacyRound.createdAt } : {}),
        sessions: {},
      };
      writeRound(target.runDir, filtered, { replaceSessions: true });
      record.copied.push(`round: ${join(ld, 'round.json')} → ${target.roundPath}（仅 name/createdAt）`);
      if (droppedSessions > 0) {
        record.notes.push(`round: 已丢弃 ${droppedSessions} 个历史会话（旧轮/已归档轮，不属于新轮），新轮请 /swarm-up 重建会话`);
      }
    } catch (e) {
      record.skipped.push(`round: 复制失败 ${String(e?.message ?? e).slice(0, 120)}`);
    }
  }

  // events 只在目标为空（或 force）时覆盖，避免把该 run 已有事件洗掉。
  const eventsDst = join(target.eventsDir, 'events.jsonl');
  const eventsSrc = join(ld, 'events.jsonl');
  if (!force && isNonEmptyFile(eventsDst)) {
    record.skipped.push('events: 目标已有事件，保留（加 --force 才覆盖）');
  } else {
    copyIfExists(eventsSrc, eventsDst, record, 'events');
  }

  // meta.name 沿用旧 round 名，便于 --all 列表辨认（legacyRound 已在上方读取）。
  ensureRunMeta(base, target.runId, {
    name: typeof legacyRound.name === 'string' ? legacyRound.name : '',
    ...(legacyRound.createdAt ? { createdAt: legacyRound.createdAt } : {}),
  });

  if (readCurrentRunId(base) == null) writeCurrentRunId(base, target.runId);

  const hasSource = existsSync(lq) || existsSync(join(ld, 'round.json')) || existsSync(eventsSrc);
  return {
    ok: true,
    runId: target.runId,
    runDir: displayPath(base, target.runDir),
    copied: record.copied,
    skipped: record.skipped,
    notes: record.notes,
    message: hasSource ? undefined : '旧全局队列/台账/事件都不存在，空跑（已建空 run 并指向 current）',
  };
}
