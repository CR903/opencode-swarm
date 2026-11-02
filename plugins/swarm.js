/* global process */
/**
 * Swarm — OpenCode 多会话编排器（V2 插件，纯 ESM 零依赖）。
 *
 * 分层（薄插件 + 厚 lib）：
 *   .opencode/lib/swarm-store.js   原子队列（tmp+fsync+rename / 目录锁 / CAS / mtime 缓存）
 *   .opencode/lib/swarm-fsm.js     状态机唯一真相（TRANSITIONS 表 + can/checkTransition）
 *   .opencode/lib/swarm-run.js     Run 隔离 + timeline 路径/重放（timelinePath/rebuild）
 *   .opencode/lib/swarm-exec.js    沙箱执行 verify_cmd（无 shell / 白名单 / 异步 / 硬超时）
 *   .opencode/lib/swarm-events.js  异步通道（幂等 eid / outbox 重放 / tail 补捞）
 *   .opencode/lib/swarm-gate.js    客观门禁（命令真跑 + verdict + commit 绑定）
 *   .opencode/lib/swarm-roles.js   角色表 + tag 展开
 *
 * 用户入口（tag 唤起，无需写长提示词）：
 *   #plan 拆解 <需求>     → planner 语义
 *   #dev W3-T1            → dev 语义 + 任务详情自动注入
 *   #test W3-T1           → test 语义 + 任务详情自动注入
 *
 * 命令：/swarm-up /swarm-start /swarm-status /swarm-runs /swarm-switch /swarm-migrate /swarm-halt /swarm-retry /swarm-drained /swarm-eval /swarm-clean
 * 工具：swarm_read_queue / swarm_plan / swarm_claim / swarm_next / swarm_done / swarm_test / swarm_review
 *   swarm_review：reviewer 语义评审（review 开的任务 test pass 后 reviewing→passed/dev_doing，medium/high 默认进评审，N1 单 reviewer）
 *   swarm_approve：高风险放行（high-risk 任务人工批准，写 kind=approve 审计行，幂等；只解锁派发，不改状态）
 *
 * Run 隔离（多需求并行）：队列/台账/事件按 `.swarm/runs/<runId>/` 切分，
 * 唯一解析入口见 `lib/swarm-run.js`（resolveRun）。工具 input 与命令 flag 全接受
 * 可选 `run`；不传 run 的老调用走 current 指针 → default，行为不变。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadQueue, invalidate, transitionTask, enqueueTask, saveQueueAtomic, appendTimeline } from '../lib/swarm-store.js';
import { createFileBus, eventId } from '../lib/swarm-filebus.js';
import { checkGate, headCommit, matchPatterns, baseHead } from '../lib/swarm-gate.js';
import { parseTag, expandTag, ROLES, hasRole } from '../lib/swarm-roles.js';
import { DEFAULT_ALLOWLIST, runVerify } from '../lib/swarm-exec.js';
import {
  modelIndex, resolveModelRef, readRound, writeRound, deriveName, roleTitle,
} from '../lib/swarm-sessions.js';
import {
  sanitizeRunId, resolveRun, writeCurrentRunId, readCurrentRunId, clearCurrentRunId,
  archiveRun, deriveRunIdFromName, resolveUniqueRunId, runQueueHasTasks,
  ensureRunMeta, listRuns, migrateLegacy, displayPath,
  rebuildQueueFromTimeline, readTimeline, stateBeforeLastGateEnter,
  readMeta, writeMeta, normalizeExecutor, executorForRole,
  DISPOSITIONS, roundsToPass, dispositionDist, lastFailDetails,
  validateFindings, validateReviewVerdict, mergeFindings,
  excludedFindingIds, resolveReviewDoc,
  REVIEW_MAX_ROUNDS,
} from '../lib/swarm-run.js';

const DEFAULTS = {
  queue: '.swarm/queue.jsonl',
  channel: 'swarm',
  runId: 'default',
  executor: 'hybrid',
  maxRetries: 3,
  verifyTimeoutMs: 300_000,
  sweepMs: 60_000,
  allowlist: [],
  autoWake: true,
  policyDeny: [],
  sensitivePaths: [],
  gates: {},
  gitBin: 'git',
};

function asStringArray(v) {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string');
  if (typeof v === 'string' && v.trim()) return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

function settings(ctx) {
  const o = ctx.options ?? {};
  return {
    queue: o.queue ?? DEFAULTS.queue,
    channel: o.channel ?? DEFAULTS.channel,
    runId: o.runId ?? DEFAULTS.runId,
    executor: o.executor ?? DEFAULTS.executor,
    maxRetries: o.maxRetries ?? DEFAULTS.maxRetries,
    verifyTimeoutMs: o.verifyTimeoutMs ?? DEFAULTS.verifyTimeoutMs,
    sweepMs: o.sweepMs ?? DEFAULTS.sweepMs,
    allowlist: [...DEFAULT_ALLOWLIST, ...(asStringArray(o.allowlist))],
    autoWake: o.autoWake ?? DEFAULTS.autoWake,
    policyDeny: asStringArray(o.policyDeny ?? DEFAULTS.policyDeny),
    sensitivePaths: asStringArray(o.sensitivePaths ?? DEFAULTS.sensitivePaths),
    gates: (o.gates && typeof o.gates === 'object') ? o.gates : {},
    gitBin: typeof o.gitBin === 'string' && o.gitBin.trim() ? o.gitBin : DEFAULTS.gitBin,
  };
}

const cwdOf = (ctx) => ctx.location?.directory ?? process.cwd();
const abs = (cwd, p) => (p.startsWith('/') ? p : resolve(cwd, p));

/**
 * 判活口径唯一真相（drained 判定三态）：
 * dispatchNext 与 /swarm-drained 同调；/swarm-mode recipe 与手册§9.2 逐字引用
 * DRAINED_RECIPE（e2e 锁死，见 swarm.e2e.test.mjs「/swarm-drained 只读判活」）。
 * 三态 = dev_doing/test_doing/reviewing；gate_check 是 swarm_done 内的同步瞬态
 * （串行调用边界上恒为空，不计入——recipe/手册历史上一直是三态口径，零变）。
 * review=false 的任务永不进 reviewing，老行为不变。
 */
export const LIVE_STATUSES = ['dev_doing', 'test_doing', 'reviewing'];
/** 返回进行中任务列表（供 /swarm-drained 打印 id+status；drained = 无 queued 且本表为空）。 */
export function liveTasks(tasks) {
  try {
    return (Array.isArray(tasks) ? tasks : []).filter((t) => t && LIVE_STATUSES.includes(t.status));
  } catch {
    return [];
  }
}
/** 判活结束语（/swarm-mode recipe 与手册§9.2 共用，e2e 断言两边逐字含它）。 */
export const DRAINED_END_LINE = '队列空 + 无 dev/test_doing/reviewing → 结束（判活口径见 /swarm-drained，与 dispatchNext 同调）';
/** subagents 轮 prompt hook 警告首行（PRD b：#dev/#test 展开体首行，e2e 锁死逐字）。 */
export const SUBAGENT_TAG_WARN = '⚠️ 本轮子代理派发，勿直接 claim，走 /swarm-mode recipe';
/** 子代理编排循环 recipe fence 全文（/swarm-mode 输出与手册§9.2 逐字一致，e2e 断言两边逐字含它）。 */
export const DRAINED_RECIPE = [
  '/swarm-status 确认 run → #plan 入队 → /swarm-start（默认 hybrid：dev常驻会话，test/reviewer走子代理）',
  'loop:',
  '  /swarm-drained --run <id>（只读：drained/有活+任务列表，不改状态）',
  '  有活 → dev会话直接开工（wake已投递）+ subagent(agent=swarm-test|swarm-reviewer, model=roleModels.*, prompt=expandTag体+任务JSON+补充要求)',
  '  子代理自己调 swarm_claim/swarm_done/swarm_test/swarm_review（tools 对任何会话开放）',
  `  ${DRAINED_END_LINE}`,
].join('\n');

/**
 * eval 导出谓词（/swarm-eval 用，纯函数）：
 * 只收失败/评审信号，不收正常流转（初次派发 queued→dev_doing、进门禁、
 * reviewing 待审、retry halted→dev_doing 都不算 eval 信号）。
 * - HALT：任意 to==='halted' 行（test 超限 / review 打回超限 / 人工熔断）
 * - fail 打回边：kind='move' 且 to==='dev_doing' 且 from 为工作态
 *   （test_doing/gate_check/reviewing → test-fail / gate-reject / review-changes）
 * - revert：kind==='revert' 行（回退快照）
 * - review：kind==='review' 行（approve / request-changes 评审结论）
 * - approve：kind='move' 且 to==='passed' 行（test 直过 + review 批准）
 * - approve 审计行：kind==='approve' 行（swarm_approve 高风险放行，只解锁派发）
 */
export function isEvalRow(r) {
  try {
    if (!r || typeof r !== 'object') return false;
    if (r.to === 'halted') return true;
    if (r.kind === 'revert') return true;
    if (r.kind === 'review') return true;
    if (r.kind === 'approve') return true;
    if (r.kind === 'move' && r.to === 'passed') return true;
    if (r.kind === 'move' && r.to === 'dev_doing'
      && ['test_doing', 'gate_check', 'reviewing'].includes(r.from)) return true;
    return false;
  } catch {
    return false;
  }
}

/** eval 行 eid（FileBus eid 语义：同 timeline 行同 run 恒同 eid，跨行恒不同）。 */
export function evalEid(runId, row) {
  try {
    const task = row?.taskId ?? '-';
    const st = row?.to ?? row?.kind ?? '-';
    const cm = row?.commit ?? '-';
    const extra = `${row?.kind ?? '-'}\0${row?.from ?? '-'}->${row?.to ?? '-'}\0${row?.reason ?? '-'}\0${row?.seq ?? '-'}`;
    return eventId(task, st, cm, runId ?? '-', extra);
  } catch {
    return eventId(String(row?.taskId ?? '-'), '-', '-', String(runId ?? '-'));
  }
}

/**
 * 解析 `--flag value` / `--flag "a b"` / `--flag`（布尔）。
 * 注意：布尔 flag 后面紧跟另一个 flag 时不能把后者当值吃掉 ——
 * 老的单个正则会把 `--dry-run --dev-model x/y` 解析成 `dry_run="--dev-model"`。
 */
function parseFlags(text) {
  const out = {};
  const tokens = [];
  const src = String(text ?? '');
  let buf = '';
  let quote = '';
  for (const ch of src) {
    if (quote) {
      if (ch === quote) quote = '';
      else buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) {
      if (buf) { tokens.push(buf); buf = ''; }
      continue;
    }
    buf += ch;
  }
  if (buf) tokens.push(buf);
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (!t.startsWith('--')) continue;
    const key = t.slice(2).replace(/-/g, '_');
    const next = tokens[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[key] = next; i += 1; }
    else out[key] = 'true';
  }
  return out;
}

function splitModel(ref) {
  const raw = String(ref ?? '').trim().replace(/^["']|["']$/g, '');
  if (!raw || !raw.includes('/')) return null;
  const i = raw.indexOf('/');
  return { providerID: raw.slice(0, i).trim(), id: raw.slice(i + 1).trim() };
}

/** 会话名/模型落盘前统一脱敏，避免把一整段需求塞进标题。 */
function oneLine(s, max = 160) {
  const v = String(s ?? '').replace(/\s+/g, ' ').trim();
  return v.length > max ? `${v.slice(0, max)}…` : v;
}

function table(tasks) {
  if (!tasks.length) return '(empty)';
  const head = '| task | wave | status | risk | retries | assignee | commit |\n|---|---|---|---|---|---|---|';
  const rows = tasks.map(
    (t) => `| ${t.id} | ${t.wave} | ${t.status} | ${t.risk ?? 'medium'} | ${t.retries ?? 0} | ${t.assignee ?? '-'} | ${t.commit ?? '-'} |`,
  );
  return [head, ...rows].join('\n');
}

/** swarm-status --task：timeline 行的 payload 打印（老任务无字段显示 `(未填写)`，永不抛错）。 */
function timelinePatchNote(row) {
  try {
    const p = (row && row.patch && typeof row.patch === 'object') ? row.patch : {};
    const snap = (row && row.snapshot && typeof row.snapshot === 'object') ? row.snapshot : {};
    const bits = [];
    // R1：行带 testing/summary（顶层 → patch → snapshot；都没有则整行记“(未填写)”）
    const testing = row.testing ?? p.testing ?? snap.testing;
    const summary = row.summary ?? p.summary ?? snap.summary;
    if (testing !== undefined) bits.push(`testing=${oneLine(testing, 200)}`);
    if (summary !== undefined) bits.push(`summary=${oneLine(summary, 200)}`);
    // R5：disposition 与 failed_ids/detail 同存 B2 字段，status --task 一并打印
    const disposition = p.disposition ?? snap.disposition;
    if (disposition !== undefined) bits.push(`disposition=${oneLine(disposition, 40)}`);
    if (p.failed_ids !== undefined) bits.push(`failed_ids=${oneLine(p.failed_ids, 200)}`);
    if (p.detail !== undefined) {
      const d = String(p.detail ?? '');
      bits.push(`detail=${d.length > 500 ? `${d.slice(0, 500)}…` : d}`);
    }
    // Reviewer-N1：review 行带 findings 快照 + verdict/round（--task 可见，rebuild 经 move 还原）
    if (p.findings !== undefined) {
      const n = Array.isArray(p.findings) ? p.findings.length : 0;
      const open = Array.isArray(p.findings) ? p.findings.filter((f) => f && f.status === 'open').length : 0;
      bits.push(`findings=${n}条(open${open})`);
      if (p.reviewVerdict !== undefined) bits.push(`verdict=${oneLine(p.reviewVerdict, 20)}`);
      if (p.reviewRound !== undefined) bits.push(`round=${oneLine(p.reviewRound, 10)}`);
    }
    if (p.reviewRounds !== undefined) bits.push(`reviewRounds=${oneLine(p.reviewRounds, 10)}`);
    return bits.length ? bits.join(' ') : '(未填写)';
  } catch {
    return '(未填写)';
  }
}

/** 高风险任务（risk=high 或 paths 命中 sensitivePaths）→ status 追加提示行。 */
function highRiskTasks(tasks, sensitivePaths) {
  return (tasks ?? []).filter((t) => {
    if (t.risk === 'high') return true;
    if (Array.isArray(t.paths) && Array.isArray(sensitivePaths) && sensitivePaths.length) {
      return t.paths.some((p) => matchPatterns(p, sensitivePaths));
    }
    return false;
  });
}

/** 疑似无人接单（15 分钟无进展）：dev_doing/test_doing/gate_check 自进入该状态超 15 分钟且 timeline 无后续行。阈值写死 15min（与 gate_long 对齐），不加配置。 */
const IDLE_MS = 15 * 60 * 1000;
function idleSuspects(tasks, tlRows, now = Date.now()) {
  try {
    const lastByTask = new Map();
    for (const row of Array.isArray(tlRows) ? tlRows : []) {
      if (!row || !row.taskId) continue;
      const prev = lastByTask.get(row.taskId);
      if (!prev || (row.seq ?? 0) >= (prev.seq ?? 0)) lastByTask.set(row.taskId, row);
    }
    const out = [];
    for (const t of Array.isArray(tasks) ? tasks : []) {
      if (!t || !['dev_doing', 'test_doing', 'gate_check'].includes(t.status)) continue;
      const last = lastByTask.get(t.id);
      let entryTs = 0;
      if (last && last.to === t.status && last.ts) {
        entryTs = new Date(last.ts).getTime();
      } else if (last && last.to !== t.status) {
        continue;
      } else if (!last && t.updated_at) {
        entryTs = new Date(t.updated_at).getTime();
      } else {
        continue;
      }
      if (!Number.isFinite(entryTs) || entryTs <= 0) continue;
      const age = now - entryTs;
      if (age > IDLE_MS) {
        const mins = Math.max(16, Math.floor(age / 60000));
        const dur = mins >= 60 ? `${Math.floor(mins / 60)}小时${mins % 60}分钟` : `${mins}分钟`;
        out.push({ id: t.id, status: t.status, mins, dur });
      }
    }
    return out;
  } catch { return []; }
}

/** rebuild 比对差异（现状 vs timeline 重放，最多 20 行，永不抛错）。 */
function diffQueueLines(current, rebuilt) {
  try {
    const a = new Map((current ?? []).map((t) => [t.id, t]));
    const b = new Map((rebuilt ?? []).map((t) => [t.id, t]));
    const lines = [];
    for (const [id, t] of a) {
      if (!b.has(id)) lines.push(`- 现有但重放无：${id}（现=${t.status}）`);
      else if (JSON.stringify(t) !== JSON.stringify(b.get(id))) lines.push(`~ 行差异：${id}（现=${t.status} 重放=${b.get(id).status}）`);
    }
    for (const [id, t] of b) {
      if (!a.has(id)) lines.push(`+ 重放多出：${id}（重放=${t.status}）`);
    }
    return (lines.slice(0, 20).join('\n') || '（无逐行差异，可能是顺序/字段差异）');
  } catch {
    return '（差异比对失败）';
  }
}

/**
 * 包根目录（npm 安装位置无关）：本文件固定在 `<pkg>/plugins/` 下，
 * 根 = 上一级含 package.json 的目录；找不到则回退本文件所在目录。
 */
function pkgRoot() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const cand of [resolve(here, '..'), here]) {
      try {
        if (existsSync(join(cand, 'package.json'))) return cand;
      } catch { /* try next */ }
    }
    return resolve(here, '..');
  } catch {
    return process.cwd();
  }
}

/**
 * 注册包自带的 skills（swarm-orchestrate / swarm-quality）。
 * frontmatter 的 name/description 即注册元数据，body 即 content，单源。
 * @returns {Promise<{registered:string[], skipped:string}>} 永不抛错。
 */
async function registerBundledSkills(ctx) {
  const out = { registered: [], skipped: '' };
  try {
    if (!ctx || typeof ctx.skill?.transform !== 'function') { out.skipped = 'no skill api'; return out; }
    let Skill = null;
    try { ({ Skill } = await import('@opencode/plugin')); } catch { /* 无 SDK 照跳 */ }
    const root = pkgRoot();
    const files = [
      join(root, 'skills', 'swarm-orchestrate', 'SKILL.md'),
      join(root, 'skills', 'swarm-quality', 'SKILL.md'),
    ];
    const defs = [];
    for (const file of files) {
      let text = '';
      try { text = readFileSync(file, 'utf8'); } catch { continue; }
      const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
      if (!m) continue;
      const name = (m[1].match(/^name:\s*(.+)$/m) || [])[1]?.trim();
      const desc = (m[1].match(/^description:\s*(.+)$/m) || [])[1]?.trim().replace(/^["']|["']$/g, '');
      if (!name || !desc) continue;
      const body = (m[2] || '').trim() || desc;
      let id = name;
      let nm = name;
      try {
        if (Skill && Skill.ID && Skill.Name) { id = Skill.ID.make(name); nm = Skill.Name.make(name); }
      } catch { /* 素字符串回退 */ }
      defs.push({ id, name: nm, description: desc, path: file, content: body });
    }
    if (!defs.length) { out.skipped = 'no skill files'; return out; }
    await ctx.skill.transform((editor) => {
      for (const d of defs) {
        try { editor.add(d); } catch { /* 单个失败不连累 */ }
        try { out.registered.push(String(d.id)); } catch { /* ignore */ }
      }
    });
  } catch { out.skipped = 'error'; }
  return out;
}

export default {
  id: 'swarm',
  async setup(ctx) {
    const cfg = settings(ctx);
    const cwd = cwdOf(ctx);
    // 显式 queue（插件 options / 命令 --queue / 工具 input.queue）是旧调用的兼容通道：
    // 尊重绝对/相对路径且与 run 无关。不传时才按 run 默认到 `.swarm/runs/<runId>/queue.jsonl`。
    const rawQueue = ctx.options?.queue ?? null;
    const rawRunId = ctx.options?.runId ?? null;
    let runtimeQueue = null; // 命令 --queue 的运行时覆盖（只影响本次进程）
    const effQueue = () => runtimeQueue ?? rawQueue ?? undefined;
    const legacyStateDir = abs(cwd, '.trellis/swarm-state');

    // npm 包自带 skills（swarm-orchestrate / swarm-quality）：随插件注册，
    // 项目无需复制 SKILL.md。路径以本文件为基准，与包安装位置无关；
    // 缺 API/缺文件一律静默跳过（旧 harness 无 ctx.skill 照常工作）。
    try { await registerBundledSkills(ctx); } catch { /* best-effort，不卡启动 */ }

    // 唯一解析入口：显式 run > cfg.runId（显式配置才传）> .swarm/current > default。
    // parseFlags 把裸 `--run`（无值）解析成字符串 'true'，必须视同未传，
    // 否则会误建出名为 `true` 的轮并污染 current 指针。
    const cmdRun = (f) => (f?.run && f.run !== 'true' ? f.run : undefined);
    const currentRunId = () => resolveRun(cwd, { cfgRunId: rawRunId }).runId;
    const queueFor = (run) => resolveRun(cwd, { run, queue: effQueue(), cfgRunId: rawRunId }).queuePath;
    // timeline 按 run 落（run 目录的 timeline.jsonl）；显式 input.queue 是兼容通道，
    // timeline 仍归所属 run，保证 rebuild 对得上插件实际写的位置。
    const timelineFor = (run) => resolveRun(cwd, { run, queue: effQueue(), cfgRunId: rawRunId }).timelinePath;

    // FileBus 按 run 建实例，小缓存（上限 20，LRU 丢）；tail 自带旧位回退。
    const busCache = new Map();
    function busFor(run) {
      const rid = sanitizeRunId(run ?? currentRunId());
      const hit = busCache.get(rid);
      if (hit) { busCache.delete(rid); busCache.set(rid, hit); return hit; }
      const rr = resolveRun(cwd, { run: rid, cfgRunId: rawRunId });
      const b = createFileBus({
        stateDir: rr.eventsDir,
        runId: rid,
        legacyDir: legacyStateDir,
        logger: () => {},
      });
      busCache.set(rid, b);
      if (busCache.size > 20) busCache.delete(busCache.keys().next().value);
      return b;
    }

    const emitFor = async (run, as, prefix, kv, extra = {}) => {
      try {
        return await busFor(run).send({ as, prefix, kv, taskId: kv.task, status: prefix.replace(/[[\]]/g, ''), commit: kv.commit, ...extra });
      } catch {
        return { sent: false, reason: 'bus unavailable' };
      }
    };

    /** status 用的 tail：bus 建实例失败也只返回空，不让整条命令抛错。 */
    async function tailFor(run, limit = 6) {
      try {
        return await busFor(run).tail(limit);
      } catch {
        return [];
      }
    }

    // ---------- 状态迁移助手（统一走 transitionTask：FSM 表校验 + 写 timeline；失败返回人话；永不跨 run 取数） ----------
    async function transition(run, taskId, expect, patch, opts = {}) {
      const { by, reason, queue, ...payload } = opts ?? {};
      const qp = queue ? abs(cwd, queue) : queueFor(run);
      const r = transitionTask(qp, timelineFor(run), { taskId, expect, patch, by, reason });
      if (!r.ok) return { ok: false, message: r.reason };
      invalidate(qp);
      return { ok: true, task: r.task, ...payload };
    }

    // ---------- 轮次台账：这一轮的会话是谁、叫什么（按 run 存） ----------
    // 只读该 run 自有的 round.json：旧全局位（.trellis/swarm-state/round.json）**仅镜像写、
    // 不再被读**（writeRoundFor 里对 current 轮 best-effort 同步一份，供老工具看），
    // 历史队列/事件可用 /swarm-migrate 迁进 run 目录，但 migrate 只搬 name/createdAt，
    // **不再把旧 sessions 搬进新轮**（否则等于复活上一轮的 stale 会话）。
    // 事故背景（10-31）：新轮读旧全局台账会把上一轮的 stale sessionID 当成本轮登记 ——
    // 空轮 plan+name 继承 3 个外来会话并给它们改名，wakeRole 随后把本轮任务投给昨天的会话。
    // 底线：本轮没登记过就是「未登记」，空轮零继承。
    function readRoundFor(run) {
      const rr = resolveRun(cwd, { run, cfgRunId: rawRunId });
      return readRound(rr.runDir);
    }
    function writeRoundFor(run, patch, opts = {}) {
      const rr = resolveRun(cwd, { run, cfgRunId: rawRunId });
      const next = writeRound(rr.runDir, patch, opts);
      try { ensureRunMeta(cwd, rr.runId, next.name ? { name: next.name } : undefined); } catch { /* best-effort */ }
      if (rr.runId === currentRunId()) {
        // 镜像位与自有位同语义（含 replaceSessions）：只写不读，但别让它留一份删不掉的脏 sessions。
        try { writeRound(legacyStateDir, patch, opts); } catch { /* best-effort */ }
      }
      return next;
    }
    const roundNameFor = (run) => readRoundFor(run).name ?? '';
    const roleSessionsFor = (run) => readRoundFor(run).sessions ?? {};

    /**
     * sid → 所属 run 索引（跨轮归属校验与 title hook 共用同一份构建逻辑，口径不分叉）。
     * 一个 sid 可能同时出现在多个轮台账里（历史污染），所以按 listRuns 顺序存全量，
     * 取用侧自己决定用哪条：title hook 取首条，归属闸按 createdAt 定属主（见 foreignOwnerOf）。
     * `createdAt` 台账优先、meta 兜底：N6 tie-break 靠它判「谁先登记的才是真属主」。
     * ⚠️ 只扫 `.swarm/runs/*`：已归档轮（`.swarm/archive/**`）扫不到 —— 那条路靠
     * migrateLegacy 不搬 sessions 兜底，不能指望这里拦住归档轮里的 stale sid。
     */
    function buildSidIndex() {
      const map = new Map();
      try {
        for (const r of listRuns(cwd)) {
          const data = readRound(r.runDir);
          const createdAt = data.createdAt ?? r.createdAt ?? '';
          for (const [role, id] of Object.entries(data.sessions ?? {})) {
            if (!id) continue;
            const hits = map.get(id) ?? [];
            hits.push({ runId: r.runId, name: data.name ?? '', role, createdAt });
            map.set(id, hits);
          }
        }
      } catch { /* 索引失败 fail-open：不因为读不到别人的轮就阻断本轮唤醒 */ }
      return map;
    }

    /**
     * 跨轮归属校验：这个 sessionID 是否登记在**别的**轮里。
     * 返回那个 runId（外来会话）或 null（本轮自有/未知）。
     * 用途：本轮台账被历史脏数据/手工塞入外来 sid 时，既不改它的标题、也不向它投指令
     * ——「禁跨轮唤醒」的最后一道闸（正常路径下 readRoundFor 只读本轮自有位，命中不到）。
     *
     * 多轮命中（N6）：同一 sid 可能被历史污染写进好几个轮台账，不能「只要有一条非本轮就算外来」
     * ——那会把真正的属主轮也判成外来（轮A 的合法 dev 会话被拦，轮A 自己反而不能改名/唤醒）。
     * 规则（确定且单调）：**属主 = 最早登记该 sid 的轮**，即 createdAt 更早者胜；同 createdAt
     * 再按 runId 字典序。后写进来的都是污染副本，只跳过它自己，不动原属主。
     * 这里**不吃 sidToRun 的 5s 缓存**：归属闸宁可多扫一遍，也不能因为缓存过期放行刚登记的外来 sid。
     */
    function foreignOwnerOf(runId, sid) {
      if (!sid) return null;
      const hits = buildSidIndex().get(sid) ?? [];
      if (!hits.length) return null;
      const owner = hits.reduce((best, h) => {
        const a = h.createdAt ?? '';
        const b = best.createdAt ?? '';
        if (a !== b) return a < b ? h : best;
        return h.runId < best.runId ? h : best;
      });
      return owner.runId === runId ? null : owner.runId;
    }

    /** 各 run 汇总（status --all / runs 用）：只读各 run 自有文件，不碰旧全局位。 */
    function summarizeRuns() {
      return listRuns(cwd).map((r) => {
        let tasks = [];
        try { tasks = loadQueue(join(r.runDir, 'queue.jsonl')); } catch { tasks = []; }
        const count = (s) => tasks.filter((t) => t.status === s).length;
        let sessions = 0;
        try { sessions = Object.keys(readRound(r.runDir).sessions ?? {}).length; } catch { sessions = 0; }
        return {
          runId: r.runId, name: r.name, createdAt: r.createdAt, total: tasks.length,
          queued: count('queued'), dev_doing: count('dev_doing'), gate_check: count('gate_check'),
          test_doing: count('test_doing'), reviewing: count('reviewing'), passed: count('passed'), halted: count('halted'),
          sessions,
        };
      });
    }

    /**
     * 给这一轮命名 = 改所有人可见的会话标题。
     * 主会话（发起需求的那个）用纯需求名，其余角色加 `· dev` / `· test` 后缀，
     * 这样并排开三个 swarm 也能一眼分清。
     * 返回 { renamed: [[sid,title]], errors: [string] }，永不抛错。
     */
    async function nameRound(name, { currentSessionID, extra, run } = {}) {
      const clean = oneLine(name, 60);
      if (!clean) return { renamed: [], errors: [] };
      const runId = sanitizeRunId(run ?? currentRunId());
      const sessions = { ...roleSessionsFor(runId), ...(extra ?? {}) };
      const base = readRoundFor(runId);
      const targets = [];
      // 主调会话同样过归属闸（N3）：A 轮会话对 B 轮发 plan/start 时，不得把 A 的会话
      // 改成 B 的需求名 ——「外来会话只属于自己的轮」对主调分支同样成立。
      if (currentSessionID && !foreignOwnerOf(runId, currentSessionID)) targets.push([currentSessionID, clean]);
      for (const [role, sid] of Object.entries(sessions)) {
        if (!sid || sid === currentSessionID) continue;
        // 跨轮归属：外来会话（别的轮登记的）只属于自己的轮，本轮不碰它的标题。
        if (foreignOwnerOf(runId, sid)) continue;
        // plan 平时用纯需求名；但如果「主会话」不是 plan 会话（人在自己的会话里发起），
        // plan 也要加后缀，否则两个会话同名分不清。
        const title = role === 'plan' && !currentSessionID ? clean : (roleTitle(clean, role) ?? `${clean} · ${role}`);
        targets.push([sid, title]);
      }
      // 台账自愈（N1）：被归属闸拦下的外来 sid 不写回本轮台账。writeRound 默认合并语义，
      // 若不剔除，脏 sid 会一直留在 round.json 里，每次唤醒都要被拦一次（只有重跑 /swarm-up 能清）。
      // own 已是「本轮自有会话全集」，所以必须配 replaceSessions:true 才是真删键
      // （默认合并会把 prev 里的脏 sid 又合回来，自愈等于没做）。
      const own = Object.fromEntries(Object.entries(sessions).filter(([, sid]) => sid && !foreignOwnerOf(runId, sid)));
      writeRoundFor(
        runId,
        { name: clean, sessions: own, ...(base.createdAt ? {} : { createdAt: new Date().toISOString() }) },
        { replaceSessions: true },
      );
      const renamed = [];
      const errors = [];
      for (const [sid, title] of targets) {
        try {
          await ctx.session.update({ sessionID: sid, title });
          renamed.push([sid, title]);
        } catch (e) {
          errors.push(`改标题失败 ${sid}: ${oneLine(e?.message ?? e, 120)}`);
        }
      }
      return { renamed, errors };
    }

    /**
     * 唤醒某个角色会话干活（issue：派发后没人知道到底有没有开始跑）。
     * 只发一次 tag 展开的指令；会话忙时 OpenCode 自己排队。
     * 按角色执行器拆分（hybrid 缺省）：dev/plan 走 sessions 常驻唤醒，
     * test/reviewer 走 subagents 一次性派发（编排会话自己用 subagent 工具派发，
     * 见 /swarm-mode recipe，不经过 role 会话）。
     * 显式整轮 sessions/subagents 零变（全角色同值）。
     */
    const executorOfRun = (run) => {
      try {
        return resolveRun(cwd, { run, cfgRunId: rawRunId }).executor;
      } catch {
        return 'hybrid';
      }
    };
    // 整轮 subagents（status 折叠/兼容判断用；hybrid 不折叠，走会话表）
    const isSub = (run) => executorOfRun(run) === 'subagents';
    // 按角色 subagent 判断（wake/tag 警告用；hybrid 下 dev=false test=true）
    const isSubRole = (role, run) => executorForRole(executorOfRun(run), role) === 'subagents';
    async function wakeRole(role, task, run) {
      const runId = sanitizeRunId(run ?? currentRunId());
      if (isSubRole(role, runId)) return { skipped: 'subagent 模式：编排会话用 subagent 工具直接派发（判活见 /swarm-drained，派发见 /swarm-mode recipe）' };
      if (!cfg.autoWake) return { skipped: 'autoWake=off（加 --wake 或配置 autoWake:true 打开）' };
      const sid = roleSessionsFor(runId)[role];
      if (!sid) return { skipped: `未登记 ${role} 会话（先跑 /swarm-up）` };
      // 禁跨轮唤醒：本轮台账若被历史脏数据/手工塞了别的轮的 sid，一律按「未登记」跳过，
      // 不向任何会话 prompt（否则本轮任务会投给上一轮的常驻会话）。
      const foreign = foreignOwnerOf(runId, sid);
      if (foreign) return { skipped: `未登记 ${role} 会话（${sid} 属 run=${foreign}，禁跨轮唤醒；先跑 /swarm-up --run ${runId} --force 重建会话，或 /swarm-clean --run ${runId} 归档后重开）` };
      // 唤醒前预检目标会话模型（与 /swarm-up 同口径：provider 错/大小写/跨 provider 全给候选）。
      // 读不到会话/无模型信息 → 无法预检，按 fail-open 直接投递（老行为零变）；
      // 注册表不可用（modelIndex null）→ fail-open 投递并注“未预检”；模型非法 → 不 prompt，直接 blocked。
      let targetModel = null;
      try {
        const info = await ctx.session.get({ sessionID: sid });
        const m = info?.model;
        if (m && m.providerID && m.id) targetModel = { providerID: String(m.providerID), id: String(m.id) };
      } catch { targetModel = null; }
      if (targetModel) {
        let index = null;
        try { index = await modelIndex(ctx); } catch { index = null; }
        if (!index) {
          const text = expandTag({ role, taskId: task.id, rest: '', raw: '' }, task);
          try {
            await ctx.session.prompt({ sessionID: sid, text });
            return { sessionID: sid, unverified: true };
          } catch (e) {
            return { error: `${sid}: ${oneLine(e?.message ?? e, 120)}` };
          }
        }
        const r = resolveModelRef(index, targetModel);
        if (!r.ok) {
          const hint = r.suggestions?.length ? `（你是不是想用：${r.suggestions.map((s) => `\`${s}\``).join(' / ')}）` : '';
          return { blocked: `${role} 会话 ${sid} 模型不可用：${r.reason}${hint}；查可用模型：\`/swarm-models --search <关键词>\`（或 \`opencode api get /api/model\`），修模型后重建会话` };
        }
      }
      const text = expandTag({ role, taskId: task.id, rest: '', raw: '' }, task);
      try {
        await ctx.session.prompt({ sessionID: sid, text });
        return { sessionID: sid };
      } catch (e) {
        return { error: `${sid}: ${oneLine(e?.message ?? e, 120)}` };
      }
    }

    function wakeLine(res, role = 'dev', taskId = '<task>') {
      if (!res) return '';
      if (res.sessionID) {
        const unverified = res.unverified ? '（未预检：注册表不可用，未验证模型是否可用）' : '';
        return `\n唤醒投递结果：指令已投递到 ${role} 会话 ${res.sessionID}${unverified}（未验证跑起来，去 ${role} 会话确认是否开工：\`#${role} ${taskId}\`）`;
      }
      if (res.blocked) return `\n⚠️ 唤醒未投递：${res.blocked}（未发指令，手动在该会话修好后发 \`#${role} ${taskId}\`）`;
      if (res.error) return `\n⚠️ 唤醒失败：${res.error}（请手动在该会话里发 \`#${role} ${taskId}\`）`;
      if (res.skipped) return `\n未自动唤醒：${res.skipped}`;
      return '';
    }

    /**
     * HALT-only 主会话推送（10-30-swarm-halt-push）：
     * 三路 HALT 迁移成功后 prompt requester（meta.notify.requester，/swarm-start 记录）。
     * 投递语义：无 requester 零动作；prompt 失败静默（清掉字段，不抛错，不影响主迁移）。
     */
    async function notifyHalt(runId, text) {
      let requester = null;
      try {
        const meta = readMeta(cwd, runId) ?? {};
        requester = meta?.notify?.requester ?? null;
      } catch {
        return;
      }
      if (typeof requester !== 'string' || !requester.trim()) return;
      try {
        await ctx.session.prompt({ sessionID: requester, text });
      } catch {
        try { writeMeta(cwd, runId, { notify: {} }); } catch { /* 静默清字段 */ }
      }
    }

    /**
     * 完工汇报：drained 且全 passed 时推 requester 一次（10-31-swarm-drained-push）。
     * 语义沿用 notifyHalt 通道（meta.notify.requester，/swarm-start 记录）：
     * 无 requester 零动作；prompt 失败静默（不记已推，不影响主迁移）。
     * 幂等：meta.doneNotified 置顶层（notify 会被 start 覆盖/HALT 失败清空，不放里面）；
     * 成功才记，失败不记（后续收敛可重试）；revert 不重置（每轮只推一次，不刷屏）。
     */
    function isAllPassed(tasks) {
      try {
        if (!Array.isArray(tasks) || !tasks.length) return false;
        // 口径同源：liveTasks 为空是全过必要条件（与 dispatchNext/swarm-drained 同调）
        if (liveTasks(tasks).length) return false;
        if (tasks.some((t) => !t || t.status !== 'passed')) return false;
        return true;
      } catch {
        return false;
      }
    }

    /** 完工汇报正文：做了什么（id/标题/summary/commit）+ 证据 + 待验收点，永不抛错。 */
    function buildDoneReport(runId, tasks) {
      try {
        const list = (Array.isArray(tasks) ? tasks : []).filter((t) => t && t.status === 'passed');
        if (!list.length) return null;
        let name = '';
        try { name = readRoundFor(runId).name ?? ''; } catch { name = ''; }
        const head = name
          ? `✅ 完工汇报「${oneLine(name, 40)}」（run=${runId}，共 ${list.length} 个任务，全部 passed，可验收）`
          : `✅ 完工汇报（run=${runId}，共 ${list.length} 个任务，全部 passed，可验收）`;
        const lines = list.map((t) => {
          const summary = t.summary ? oneLine(String(t.summary), 120) : '（未填写）';
          const commit = t.commit ? String(t.commit).slice(0, 12) : '-';
          const acc = t.acceptance ? oneLine(String(t.acceptance), 120) : '（未填写）';
          return `- ${t.id}「${oneLine(String(t.title ?? '-'), 40)}」：${summary}（commit=${commit}）\n  验收：${acc}`;
        });
        return [
          head, ...lines,
          `证据：门禁已过（verify 全绿），commit 见上；明细查 \`/swarm-status --run ${runId}\`。`,
          `待验收：按各任务「验收」口径复核；有问题用 \`/swarm-revert --run ${runId} --task <id>\` 回退重做。`,
        ].join('\n');
      } catch {
        return null;
      }
    }

    /**
     * 收敛即推一次（只读判定不改队列；成功回注脚文案，失败/跳过回空串）。
     * 调用点：swarm_test pass 直通 / swarm_review approve 后的 dispatchNext drained 分支。
     * /swarm-drained 本体保持纯只读（零 prompt），轮询收敛不刷屏靠本函数幂等。
     */
    async function maybeNotifyDone(runId) {
      try {
        let tasks = [];
        try { tasks = loadQueue(queueFor(runId)); } catch { return ''; }
        if (!isAllPassed(tasks)) return '';
        let meta = null;
        try { meta = readMeta(cwd, runId); } catch { meta = null; }
        if (meta && meta.doneNotified) return '';
        const requester = meta?.notify?.requester;
        if (typeof requester !== 'string' || !requester.trim()) return '';
        const text = buildDoneReport(runId, tasks);
        if (!text) return '';
        try {
          await ctx.session.prompt({ sessionID: requester, text });
        } catch {
          return '';
        }
        try { writeMeta(cwd, runId, { doneNotified: true }); } catch { /* best-effort */ }
        return '\n（完工汇报已推送给主会话）';
      } catch {
        return '';
      }
    }

    /**
     * 共用：HALT 迁移（命令与 swarm_halt tool 同调，语义逐行一致）。
     * 只做队列+t-db 操作（transition），不发事件/推送（调用方薄 wrapper 负责）。
     * @returns {ok:true, task, id} | {ok:false, message}
     */
    async function haltTask(runId, taskId, reason, by) {
      const id = String(taskId ?? '').trim();
      const r = await transition(runId, id,
        ['queued', 'dev_doing', 'gate_check', 'test_doing', 'reviewing', 'passed'],
        { status: 'halted' },
        { by: by ?? 'human', reason: String(reason ?? 'manual') });
      if (!r.ok) return { ok: false, message: r.message };
      return { ok: true, task: r.task, id };
    }

    /**
     * 共用：REVERT 回退（命令与 swarm_revert tool 同调，语义逐行一致）。
     * 含队列查找 + 状态守卫 + timeline 重放 + transition + kind='revert' 行；
     * 不发事件/唤醒（调用方薄 wrapper 负责）。
     * @returns {ok:true, task, from} | {ok:false, message}
     */
    async function revertTask(runId, taskId, by, reasonSuffix) {
      const id = String(taskId ?? '').trim();
      if (!id || id === 'true') return { ok: false, message: '用法：`/swarm-revert --task <id>`（只接受 halted/passed 任务）' };
      const qp = queueFor(runId);
      const runDir = resolveRun(cwd, { run: runId, cfgRunId: rawRunId }).runDir;
      const cur = loadQueue(qp).find((t) => t.id === id);
      if (!cur) return { ok: false, message: `任务不存在：${id}` };
      if (cur.status !== 'halted' && cur.status !== 'passed') {
        return { ok: false, message: `只有 halted/passed 可 revert，${id} 是 ${cur.status}（如需重做先 /swarm-halt 熔断）` };
      }
      const back = stateBeforeLastGateEnter(runDir, id);
      if (!back.ok) return { ok: false, message: `revert 失败：${back.reason}` };
      const patch = {
        ...back.prior,
        id,
        status: 'dev_doing',
        commit: back.prior?.commit ?? null,
        verdict_path: null,
        baseHEAD: null,
      };
      delete patch.updated_at;
      const suffix = reasonSuffix && String(reasonSuffix).trim() ? oneLine(String(reasonSuffix), 80) : '';
      const r = await transition(runId, id, [cur.status], patch, {
        by: by ?? 'human', reason: `revert${suffix ? `:${suffix}` : ''}`,
      });
      if (!r.ok) return { ok: false, message: `revert 失败：${r.message}` };
      appendTimeline(timelineFor(runId), {
        taskId: id, kind: 'revert', from: cur.status, to: 'dev_doing',
        by: by ?? 'human', reason: `revert:to-dev_doing${suffix ? `:${suffix}` : ''}`,
        commit: r.task.commit, retries: r.task.retries,
        snapshot: structuredClone(r.task), ts: r.task.updated_at,
      });
      return { ok: true, task: r.task, from: cur.status };
    }

    /**
     * 共用：只读编排配置（供 swarm_config tool 与编排循环读模型映射）。
     * 纯读：读 meta + current 指针，永不写盘，失败回默认。
     */
    function readConfig(runId) {
      try {
        const rid = sanitizeRunId(runId ?? currentRunId());
        const meta = readMeta(cwd, rid) ?? {};
        const ex = normalizeExecutor(meta.executor);
        const rms = (meta.roleModels && typeof meta.roleModels === 'object') ? meta.roleModels : {};
        return { executor: ex, roleModels: { ...rms }, currentRun: currentRunId(), runId: rid };
      } catch {
        return { executor: 'hybrid', roleModels: {}, currentRun: 'default', runId: 'default' };
      }
    }

    async function dispatchNext(run) {
      const runId = sanitizeRunId(run ?? currentRunId());
      const tasks = loadQueue(queueFor(runId));
      const next = tasks.find((t) => t.status === 'queued');
      if (!next) {
        // 判活三态唯一真相 liveTasks（/swarm-drained 同调；review=false 时永无 reviewing，老行为零变）
        const live = liveTasks(tasks);
        if (live.length) {
          return { dispatched: null, drained: false, reason: `仍有${live.length}个进行中：${live.map((t) => `${t.id} ${t.status}`).join('、')}` };
        }
        return { dispatched: null, drained: true };
      }
      // 高风险软卡（10-30-swarm-approve-softcard）：high-risk 且无 approve 行 → 阻断派发。
      // approve 只解锁、不改状态；本层纯读 timeline（kind='approve' presence），不写任何东西。
      if (highRiskTasks([next], cfg.sensitivePaths).length) {
        let approved = false;
        try {
          const rr = resolveRun(cwd, { run: runId, queue: effQueue(), cfgRunId: rawRunId });
          approved = readTimeline(rr.runDir).some((r) => r && r.taskId === next.id && r.kind === 'approve');
        } catch {
          approved = false;
        }
        if (!approved) {
          return {
            dispatched: null,
            drained: false,
            reason: `⛔ 高风险未批：${next.id}（risk=${next.risk ?? 'high'}）暂不派发。主会话先看 diff（git diff / git show <commit>）确认变更，再补批：/swarm_approve —— 调工具 swarm_approve {task_id: "${next.id}"}。批后自动解锁派发（approve 不改状态，只解锁）`,
          };
        }
      }
      const r = await transition(runId, next.id, 'queued', { status: 'dev_doing', assignee: 'dev' }, { by: 'orchestrator', reason: 'dispatch' });
      if (!r.ok) return { dispatched: null, reason: r.message };
      await emitFor(runId, 'orchestrator', '[TASK-ASSIGN]', { task: next.id, wave: next.wave, to: 'dev', verify: next.verify_cmd });
      const wake = await wakeRole('dev', r.task, runId);
      return { dispatched: r.task, wake };
    }

    // ---------- 执行器标记：--executor/--dev-model/--tester-model/--reviewer-model 写 run meta ----------
    // 只做落盘（供编排会话派发 subagent 时读模型）；显式 sessions/subagents 整轮行为零变，默认 hybrid。
    // roleModels 落盘前先走模型校验（与 /swarm-up 同一口径：格式/provider 错/大小写/跨 provider 全给候选）：
    // 任一非法即拒收、不写 meta；注册表不可用（modelIndex null）时降级放行（fail-open，不卡编排）。
    async function applyExecutorFlags(runId, f) {
      const patch = {};
      if (f.executor !== undefined && f.executor !== 'true') {
        const e = String(f.executor).trim();
        if (e !== 'sessions' && e !== 'subagents' && e !== 'hybrid') return { error: `未知执行器：${e}（只接受 sessions|subagents|hybrid）` };
        patch.executor = e;
      }
      // 待校验的模型 flags：沿 ROLES 表收集（写法与 /swarm-up 对齐：`--<modelKey>-model` 优先，裸 `--<modelKey>` 兜底）。
      // dev/test/reviewer 校验通过后照常落 roleModels；planner 只验不落，非法同样拒收。
      const pending = [];
      for (const [role, def] of Object.entries(ROLES)) {
        const raw = f[`${def.modelKey}_model`] ?? f[def.modelKey];
        if (raw === undefined || raw === 'true') continue;
        const ref = String(raw).trim();
        if (!ref) continue;
        pending.push({ role, ref });
      }
      if (pending.length) {
        let index = null;
        try { index = await modelIndex(ctx); } catch { index = null; }
        if (index) {
          const problems = [];
          for (const { role, ref } of pending) {
            const parsed = splitModel(ref);
            if (!parsed) {
              problems.push(`- **${role}**：\`${ref}\` 格式不对，应写成 \`provider/model\`（例如 \`opencode-go/deepseek-v4.1-flash\`）`);
              continue;
            }
            const r = resolveModelRef(index, parsed);
            if (!r.ok) {
              const hint = r.suggestions?.length ? `\n  你是不是想用：${r.suggestions.map((s) => `\`${s}\``).join(' / ')}` : '';
              problems.push(`- **${role}**：${r.reason}${hint}`);
            }
          }
          if (problems.length) {
            return { error: `模型不可用（未写 meta，请修正后重跑）：\n${problems.join('\n')}\n\n查可用模型：\`/swarm-models --search deepseek\`（或 \`opencode api get /api/model\`）。修正后重跑：\`/swarm-start --dev-model <provider/model>\`` };
          }
        }
        // index 为 null（注册表不可用）→ 降级放行，不卡编排
      }
      const rm = {};
      if (f.dev_model !== undefined && f.dev_model !== 'true') rm.dev = String(f.dev_model).trim();
      if (f.tester_model !== undefined && f.tester_model !== 'true') rm.test = String(f.tester_model).trim();
      if (f.reviewer_model !== undefined && f.reviewer_model !== 'true') rm.reviewer = String(f.reviewer_model).trim();
      if (Object.keys(rm).length) {
        let prev = {};
        try { prev = readMeta(cwd, runId)?.roleModels ?? {}; } catch { prev = {}; }
        patch.roleModels = { ...(prev && typeof prev === 'object' ? prev : {}), ...rm };
      }
      if (Object.keys(patch).length) {
        try { writeMeta(cwd, runId, patch); } catch { /* best-effort */ }
      }
      return { ok: true };
    }

    // ---------- prompt hook：tag 唤起（核心易用性） ----------
    await ctx.session.hook?.('prompt', async (event) => {
      const text = event.prompt?.text ?? '';
      const tag = parseTag(text);
      if (!tag) return;
      const runId = currentRunId();
      const task = tag.taskId ? loadQueue(queueFor(runId)).find((t) => t.id === tag.taskId) : undefined;
      const expanded = expandTag(tag, task);
      if (!expanded) return;
      // PRD b：子代理角色遇 #dev/#test，展开体首行加警告（按角色执行器：hybrid 下 dev 不警告/test 警告；显式 sessions 零变）。
      const subWarn = (isSubRole(tag.role, runId) && (tag.role === 'dev' || tag.role === 'test'))
        ? `${SUBAGENT_TAG_WARN}\n`
        : '';
      // 展开为完整指令：用户只敲 `#dev W3-T1`，拿到的是任务详情 + 角色契约
      // 补充要求已内嵌为展开体 `## 补充要求` 节，不再复读原话全文（含裸 tag）；
      // 审计走 timeline/通道事件，不走 prompt token。
      event.prompt.text = `${subWarn}${expanded}`;
      // 需求一落地就给这一轮改名（planner 是需求的入口，其余角色跟着改）。
      // 事件本身无 run 信息，只动当前轮。
      if (tag.role === 'plan') {
        const name = deriveName(tag.rest);
        if (name && name !== roundNameFor(runId)) {
          void nameRound(name, { currentSessionID: event.sessionID, run: runId }).catch(() => {});
        }
      }
    });

    // ---------- title hook：别让自动标题盖掉需求名 ----------
    // OpenCode 会在首轮对话后自动生成标题；那一版只会写「解决 xxx 问题」这种
    // 猜出来的短句，和三个并排会话的名字对不上。这里对登记过的轮次会话直接给定标题。
    // sid → 所属 run 反查（扫 runs/*/round.json，5s 缓存），跨轮同名不串。
    // 与 foreignOwnerOf 同源：都走 buildSidIndex（见上方注释），区别只是这里吃 5s 缓存。
    let sidIndex = { at: 0, map: new Map() };
    function sidToRun(sid) {
      const now = Date.now();
      if (now - sidIndex.at > 5000) sidIndex = { at: now, map: buildSidIndex() };
      return sid ? sidIndex.map.get(sid)?.[0] : undefined;
    }
    await ctx.session.hook?.('title', (event) => {
      const sid = event.sessionID;
      if (!sid) return;
      const hit = sidToRun(sid);
      const runId = hit?.runId ?? currentRunId();
      const sessions = hit ? { [hit.role]: sid } : roleSessionsFor(runId);
      const role = Object.keys(sessions).find((r) => sessions[r] === sid);
      if (!role) return;
      const name = hit?.name || roundNameFor(runId);
      if (!name) return;
      event.result = { title: roleTitle(name, role) ?? `${name} · ${role}` };
    });

    // ---------- 执行器展示行（status/mode 共用；读 meta 失败就回默认 hybrid，永不抛错） ----------
    function execLineFor(runId) {
      try {
        const meta = readMeta(cwd, runId) ?? {};
        const ex = normalizeExecutor(meta.executor);
        const rms = (meta.roleModels && typeof meta.roleModels === 'object') ? meta.roleModels : {};
        let suffix = '';
        if (ex === 'sessions') suffix = '（显式整轮，会话唤醒）';
        else if (ex === 'subagents') suffix = '（显式整轮，子代理派发，不唤醒 role 会话，判活见 /swarm-drained，recipe 见本命令）';
        else suffix = '（默认 hybrid：dev常驻会话唤醒，test/reviewer走子代理，判活见 /swarm-drained，recipe 见本命令）';
        let line = `执行器：${ex}${suffix}`;
        if (rms.dev || rms.test || rms.reviewer) line += `　模型：dev=${rms.dev ?? '-'} test=${rms.test ?? '-'} reviewer=${rms.reviewer ?? '-'}`;
        return line;
      } catch {
        return '执行器：hybrid（默认 hybrid：dev常驻会话唤醒，test/reviewer走子代理，判活见 /swarm-drained，recipe 见本命令）';
      }
    }

    // ---------- 命令 ----------
    await ctx.command.transform((editor) => {
      editor.add({
        name: 'swarm-init',
        description: '安装 swarm 配套文件到本项目：agents + review 模板（已存在的不覆盖，除非 --force；skills 随插件自动注册，无需复制）',
        execute: async ({ sessionID, prompt }) => {
          const reply = (text) => ctx.session.prompt({ sessionID, text });
          try {
            const f = parseFlags(prompt?.text ?? '');
            const force = f.force === 'true';
            const root = pkgRoot();
            const jobs = [
              ['agents/swarm-plan.md', '.opencode/agents/swarm-plan.md'],
              ['agents/swarm-dev.md', '.opencode/agents/swarm-dev.md'],
              ['agents/swarm-test.md', '.opencode/agents/swarm-test.md'],
              ['agents/swarm-reviewer.md', '.opencode/agents/swarm-reviewer.md'],
              ['review/_default.md', '.opencode/review/_default.md'],
            ];
            const copied = [];
            const skipped = [];
            const missing = [];
            for (const [src, rel] of jobs) {
              const from = join(root, src);
              const to = abs(cwd, rel);
              let body = null;
              try { body = readFileSync(from, 'utf8'); } catch { missing.push(rel); continue; }
              if (!force) {
                try {
                  if (readFileSync(to, 'utf8') === body) { skipped.push(`${rel}（一致）`); continue; }
                } catch { /* 目标不存在即写 */ }
                if (existsSync(to)) { skipped.push(`${rel}（已存在，加 --force 覆盖）`); continue; }
              }
              try { mkdirSync(dirname(to), { recursive: true }); } catch { /* 父目录已存在 */ }
              try { writeFileSync(to, body, 'utf8'); } catch (e) {
                return reply(`❌ /swarm-init 写文件失败：${rel} ${oneLine(e?.message ?? e, 120)}`);
              }
              copied.push(rel);
            }
            const lines = ['## swarm-init'];
            if (copied.length) lines.push(`已安装：\n${copied.map((x) => `- ${x}`).join('\n')}`);
            if (skipped.length) lines.push(`跳过：\n${skipped.map((x) => `- ${x}`).join('\n')}`);
            if (missing.length) lines.push(`⚠️ 包内缺失（未安装）：\n${missing.map((x) => `- ${x}`).join('\n')}`);
            lines.push('skills（swarm-orchestrate / swarm-quality）已随插件自动注册，无需复制。');
            lines.push('下一步：`/swarm-up --planner-model <p> --dev-model <d> --tester-model <t> --name <需求名>`，然后 `#plan 拆解 <需求>`。');
            return reply(lines.join('\n\n'));
          } catch (e) {
            return reply(`❌ /swarm-init 异常：${oneLine(e?.message ?? e, 200)}`);
          }
        },
      });
      editor.add({
        name: 'swarm-up',
        description: '一键拉起 planner/dev/tester 三个会话并指定模型（先校验模型再建会话）',
        execute: async ({ sessionID, prompt }) => {
          const reply = (text) => ctx.session.prompt({ sessionID, text });
          try {
            const f = parseFlags(prompt.text ?? '');
            // 新轮隔离（无 --run + 有 --name → 由需求名派生新轮，防复用脏 default 目录）；
            // 显式 --run / 显式 cfgRunId（插件 options.runId）/ 无 --name 全走老解析（current → default），零变。
            const explicitUpRun = cmdRun(f);
            const hasCfgRunId = rawRunId !== undefined && rawRunId !== null && String(rawRunId).trim() !== '';
            let upRun;
            let derivedUpRun = false;
            if (explicitUpRun || hasCfgRunId) {
              upRun = resolveRun(cwd, { run: explicitUpRun ?? undefined, cfgRunId: rawRunId }).runId;
            } else {
              const wantName = oneLine(f.name ?? f.title ?? '', 60);
              if (wantName) {
                upRun = resolveUniqueRunId(cwd, deriveRunIdFromName(wantName));
                derivedUpRun = true;
              } else {
                upRun = resolveRun(cwd, { cfgRunId: rawRunId }).runId;
              }
            }
            const rrUp = resolveRun(cwd, { run: upRun, cfgRunId: rawRunId });
            const roles = (f.roles && f.roles !== 'true' ? f.roles : 'plan,dev,test').split(',').map((s) => s.trim()).filter(Boolean);
            const unknown = roles.filter((r) => !hasRole(r));
            if (!roles.length || unknown.length) {
              return reply(`❌ /swarm-up 失败：未知角色 ${unknown.join(', ') || '(空)'}\n` +
                `可选角色：${Object.keys(ROLES).join(' / ')}\n用法：\`/swarm-up --planner-model a/b --dev-model c/d --tester-model e/f [--name 需求名]\``);
            }
            if (f.dry_run === 'true') {
              // dry-run 只校验模型 + 打印计划，不建会话、不改队列
              const dry = [];
              for (const role of roles) {
                const ref = f[`${ROLES[role].modelKey}_model`] ?? f[ROLES[role].modelKey] ?? '';
                const marks = [
                  ROLES[role].needsHuman ? '需人力复核' : '',
                  !ROLES[role].agent ? '占位，不可 up' : '',
                ].filter(Boolean).join('，');
                dry.push(`${role}: ${ref || '(默认模型)'}${marks ? `（${marks}）` : ''}`);
              }
              return reply(`## swarm-up --dry-run\n${dry.map((l) => `- ${l}`).join('\n')}\n\n（未创建任何会话）`);
            }

            // 无参/单名开场卡（10-31-swarm-up-name-card + 10-31-swarm-empty-run）：
            // 仅模型/执行器 flag 算实质 ——单 --name（无任何模型/执行器 flag）仍回开场卡，
            // 卡内回显已预填的需求名；不建会话、不读任务内容，只回一张提问卡。
            // 10-31-swarm-empty-run：单 --name（派生轮）或显式 --run（无实质 flag）即建空轮
            // （queue空+round/meta/current落盘，sidebar/footer立刻可见，零任务态非报错），
            // 裸 up（无 name、无显式 --run）仍零落盘。位置在 dry-run 与未知角色检查之后、
            // 模型校验之前；裸 `--roles`/`--dry-run` 视同未传（前者穿透未知角色检查到达这里，
            // 后者已在上面按 dry-run 返回）；显式 `--roles`（带值）走老行为
            // （占位拒绝等在建会话分支处理）。有实质 flag 即穿透走老行为（零变）。
            const upHasFlag = (() => {
              const hasVal = (v) => v !== undefined && v !== 'true' && String(v).trim() !== '';
              if (hasVal(f.executor)) return true;
              for (const def of Object.values(ROLES)) {
                const mk = def.modelKey;
                if (hasVal(f[`${mk}_model`]) || hasVal(f[mk])) return true;
              }
              if (hasVal(f.roles)) return true;
              return false;
            })();
            if (!upHasFlag) {
              const upName = oneLine(f.name ?? f.title ?? '', 60);
              // 空轮落盘（仅派生轮/显式轮；裸 up 零落盘，老行为零变）：
              // 冲突沿用现有拒收与 force 口径（显式 --run 指非空旧轮 + 无 --force → 同文案拒收）。
              if (derivedUpRun || explicitUpRun) {
                if (explicitUpRun && !derivedUpRun && f.force !== 'true' && runQueueHasTasks(cwd, upRun)) {
                  return reply(
                    `❌ /swarm-up 拒绝复用非空旧轮 **${upRun}**（该轮队列还有任务，直接复用会把新需求会话挂到旧队列上串味）。\n` +
                    `三选一：\n` +
                    `1. 归档旧轮再开：\`/swarm-clean --run ${upRun}\`（整轮搬到 .swarm/archive，全保留供审计），然后重跑本命令；\n` +
                    `2. 换个轮名：\`/swarm-up --run <新名字> ...\`（或不带 --run，用 --name 自动派生新轮）；\n` +
                    `3. 确认要混用旧轮：加 \`--force\` 重跑（旧任务保留，新会话登记到该轮）。`,
                  );
                }
                // 落空轮：queue 空文件（缺才建，永不截断已有任务）+ round/meta/current。
                // 零会话（sessions 保持空或沿用已有，不新建）、不读任务内容。
                // hadTasks 先记（--force 复用非空轮时文案不谎报 queue 空）；
                // 本轮自有位只读 round（不回退旧全局位，防脏 default 台账污染新轮初始化）。
                const hadTasks = runQueueHasTasks(cwd, upRun);
                try {
                  const qpEmpty = queueFor(upRun);
                  if (!existsSync(qpEmpty)) {
                    try { saveQueueAtomic(qpEmpty, []); } catch { /* best-effort */ }
                    try { invalidate(qpEmpty); } catch { /* best-effort */ }
                  }
                } catch { /* best-effort */ }
                try {
                  if (upName) {
                    try { ensureRunMeta(cwd, upRun, { name: upName }); } catch { /* best-effort */ }
                  } else {
                    try { ensureRunMeta(cwd, upRun); } catch { /* best-effort */ }
                  }
                } catch { /* best-effort */ }
                let keptSessions = false;
                try {
                  const prevRound = readRound(rrUp.runDir);
                  const hasSessions = prevRound
                    && prevRound.sessions
                    && typeof prevRound.sessions === 'object'
                    && Object.keys(prevRound.sessions).length > 0;
                  keptSessions = !!hasSessions;
                  const patchEmpty = {
                    ...(upName ? { name: upName } : {}),
                    ...(!prevRound || !prevRound.createdAt ? { createdAt: new Date().toISOString() } : {}),
                  };
                  if (!hasSessions) {
                    patchEmpty.sessions = {};
                    writeRoundFor(upRun, patchEmpty, { replaceSessions: true });
                  } else if (Object.keys(patchEmpty).length) {
                    writeRoundFor(upRun, patchEmpty);
                  }
                } catch { /* best-effort */ }
                try { writeCurrentRunId(cwd, upRun); } catch { /* best-effort */ }
                // 复用分支文案不谎报：非空轮 --force / 有会话轮复用各走各的 state 行；
                // 纯空轮分支文案逐字锁定（e2e 断言），不动。
                const stateLine = hadTasks
                  ? `轮已复用（--force）：run=${upRun}（旧队列原样保留未截断；round/meta/current已对齐，sidebar/footer可见）\n`
                  : keptSessions
                    ? `轮已复用：run=${upRun}（已有会话登记原样保留，未新建会话；round/meta/current已对齐，sidebar/footer可见）\n`
                    : `空轮已建：run=${upRun}（queue空+round/meta/current已落盘，sidebar/footer立刻可见，零任务态非报错）\n`;
                return reply(
                  '## swarm-up：开轮前先问三件事（未创建任何会话）\n' +
                  stateLine +
                  (upName ? `\n需求名已预填：**${upName}**（第 2 问直接用它，不用重问）\n` : '') + '\n' +
                  '用 question 工具问清下面三项（括号里是默认值，不答就按默认走）：\n\n' +
                  '1. 模型：planner / dev / tester 各用什么？（默认：planner 强推理、dev 便宜量大、tester 严格；查：`/swarm-models --search <关键词>`）\n' +
                  '2. 需求：本轮需求名（一句话）＋ 需求正文去处（prd 路径，或直接口述）。\n' +
                  '3. 执行器：sessions | subagents | hybrid（默认 hybrid：dev常驻会话，test/reviewer走子代理；recipe 见 `/swarm-mode`）。\n' +
                  '评审默认值：medium/high 默认进评审（test pass 后进 reviewing），low 默认直通（显式 review:true 可开，显式 review:false 可关）。\n\n' +
                  '本轮无需历史数据，不要调 swarm_read_queue /swarm-status /swarm-drained，直接用 question 工具问完上面三项。\n\n' +
                  `下一步：拿到答案后重跑带参 \`/swarm-up --run ${upRun} --planner-model <p> --dev-model <d> --tester-model <t>${upName ? ` --name ${upName}` : ''}\`（复用本空轮，不会再派生新轮），然后在 planner 会话里 \`#plan 拆解 <需求>\`。`,
                );
              }
              const upNameBare = upName;
              return reply(
                '## swarm-up：开轮前先问三件事（未创建任何会话）\n' +
                (upNameBare ? `\n需求名已预填：**${upNameBare}**（第 2 问直接用它，不用重问）\n` : '') + '\n' +
                '用 question 工具问清下面三项（括号里是默认值，不答就按默认走）：\n\n' +
                '1. 模型：planner / dev / tester 各用什么？（默认：planner 强推理、dev 便宜量大、tester 严格；查：`/swarm-models --search <关键词>`）\n' +
                '2. 需求：本轮需求名（一句话）＋ 需求正文去处（prd 路径，或直接口述）。\n' +
                '3. 执行器：sessions | subagents | hybrid（默认 hybrid：dev常驻会话，test/reviewer走子代理；recipe 见 `/swarm-mode`）。\n' +
                '评审默认值：medium/high 默认进评审（test pass 后进 reviewing），low 默认直通（显式 review:true 可开，显式 review:false 可关）。\n\n' +
                '本轮无需历史数据，不要调 swarm_read_queue /swarm-status /swarm-drained，直接用 question 工具问完上面三项。\n\n' +
                '下一步：拿到答案后重跑带参 `/swarm-up --planner-model <p> --dev-model <d> --tester-model <t> --name <需求名>`，然后在 planner 会话里 `#plan 拆解 <需求>`。',
              );
            }

            // 新轮隔离 R2：显式 --run 指向还有任务行的旧轮 → 拒收（防新需求会话挂到旧队列上串味）。
            // 空轮/同轮复用走老行为（零变）；dry-run/开场卡在上面已提前返回，不受影响；
            // 加 --force 显式覆盖才允许复用。
            if (explicitUpRun && !derivedUpRun && f.force !== 'true' && runQueueHasTasks(cwd, upRun)) {
              return reply(
                `❌ /swarm-up 拒绝复用非空旧轮 **${upRun}**（该轮队列还有任务，直接复用会把新需求会话挂到旧队列上串味）。\n` +
                `三选一：\n` +
                `1. 归档旧轮再开：\`/swarm-clean --run ${upRun}\`（整轮搬到 .swarm/archive，全保留供审计），然后重跑本命令；\n` +
                `2. 换个轮名：\`/swarm-up --run <新名字> ...\`（或不带 --run，用 --name 自动派生新轮）；\n` +
                `3. 确认要混用旧轮：加 \`--force\` 重跑（旧任务保留，新会话登记到该轮）。`,
              );
            }

            // ① 先校验模型：OpenCode 的 switchModel 对不存在的模型会静默成功，
            //    错误要等该会话跑一步才以 ModelUnavailableError 冒出来 —— 必须先拦住。
            const index = await modelIndex(ctx);
            const problems = [];
            const chosen = new Map(); // role -> { providerID, id } | null
            for (const role of roles) {
              const def = ROLES[role];
              const ref = f[`${def.modelKey}_model`] ?? f[def.modelKey] ?? '';
              if (!ref) { chosen.set(role, null); continue; }
              const parsed = splitModel(ref);
              if (!parsed) {
                problems.push(`- **${role}**：\`${ref}\` 格式不对，应写成 \`provider/model\`（例如 \`opencode-go/deepseek-v4.1-flash\`）`);
                continue;
              }
              const r = resolveModelRef(index, parsed);
              if (!r.ok) {
                const hint = r.suggestions?.length ? `\n  你是不是想用：${r.suggestions.map((s) => `\`${s}\``).join(' / ')}` : '';
                problems.push(`- **${role}**：${r.reason}${hint}`);
              } else {
                chosen.set(role, { providerID: r.providerID, id: r.id });
              }
            }
            if (problems.length) {
              return reply(`❌ /swarm-up 未创建任何会话 —— 模型不可用（这类错误如果放进会话里跑，只会得到一句 ModelUnavailable，很难看出是谁配错了）\n\n` +
                `${problems.join('\n')}\n\n` +
                `查可用模型：\`/swarm-models --search deepseek\`（或 \`opencode api get /api/model\`）。修正后重跑：\`/swarm-up --dev-model <provider/model>\``);
            }

            // ② 建会话：title/agent/model 一次性写进 create，减少「建完再改」的中间态
            // 显式 --run 到这一步才认领该轮：dry-run/未知角色/模型非法/执行器非法都不改 current、不建会话。
            // 执行器先验后认领：非法值直接拒收（applyExecutorFlags 只在合法时落盘）。
            const execUp = await applyExecutorFlags(upRun, f);
            if (execUp.error) return reply(`❌ /swarm-up 参数错误：${execUp.error}`);
            if (explicitUpRun) writeCurrentRunId(cwd, upRun);
            // 执行器标记落盘已在上一步完成（dry-run 已提前返回，这里只影响真建会话的路径）
            // hybrid 缺省只建 plan+dev 会话：dev 常驻唤醒，test/reviewer 由编排会话按 /swarm-mode recipe 派 subagent，不建会话
            // （roleModels.dev/test/reviewer 照常由 flags 落 meta，不依赖会话创建；显式 sessions/subagents 整轮零变）。
            let upExecutor = 'hybrid';
            try { upExecutor = normalizeExecutor((readMeta(cwd, upRun) ?? {}).executor); } catch { upExecutor = 'hybrid'; }
            const isSubUp = upExecutor === 'subagents';
            const isHybridUp = upExecutor === 'hybrid';
            const explicitRoles = f.roles !== undefined && f.roles !== 'true';
            const name = oneLine(f.name ?? f.title ?? '', 60);
            const report = [];
            const sessions = {};
            const errors = [];
            for (const role of roles) {
              const def = ROLES[role];
              if (!def.agent) {
                errors.push(`- **${role}**：该角色为占位（subagent 专属，不经 /swarm-up 建会话）——先用 plan/dev/test 干活，reviewer 由编排会话在 test pass 后按需派发`);
                continue;
              }
              if (isSubUp && (role === 'dev' || role === 'test')) {
                report.push(explicitRoles
                  ? `- ${role} 跳过（subagent 模式：会话建了也没人唤醒，建议去掉 --roles ${role}；dev/test 由编排会话按 /swarm-mode recipe 派 subagent，不建会话）`
                  : `- ${role} 跳过（subagent 模式：dev/test 由编排会话按 /swarm-mode recipe 派 subagent，不建会话）`);
                continue;
              }
              if (isHybridUp && role === 'test') {
                report.push(explicitRoles
                  ? `- ${role} 跳过（hybrid 模式：会话建了也没人唤醒，建议去掉 --roles ${role}；test/reviewer 由编排会话按 /swarm-mode recipe 派 subagent，不建会话）`
                  : `- ${role} 跳过（hybrid 模式：test/reviewer 由编排会话按 /swarm-mode recipe 派 subagent，不建会话）`);
                continue;
              }
              const model = chosen.get(role) ?? null;
              let session;
              try {
                session = await ctx.session.create({
                  title: name ? (roleTitle(name, role) ?? `swarm-${role}`) : `swarm-${role}`,
                  ...(def.agent ? { agent: def.agent } : {}),
                  ...(model ? { model } : {}),
                });
              } catch (e) {
                errors.push(`- **${role}**：创建会话失败 —— ${oneLine(e?.message ?? e, 160)}`);
                continue;
              }
              const sid = session?.id ?? session?.sessionID;
              if (!sid) { errors.push(`- **${role}**：创建会话失败 —— 返回值里没有 sessionID`); continue; }
              sessions[role] = sid;

              // ③ 回读核对：create 成功 ≠ 模型/agent 生效，必须读回来比对
              let actual = null;
              try { actual = await ctx.session.get({ sessionID: sid }); } catch { /* 读不到就按未核对处理 */ }
              const gotModel = actual?.model;
              const modelOk = !model || (gotModel?.providerID === model.providerID && gotModel?.id === model.id);
              const gotAgent = actual?.agent;
              const agentOk = !def.agent || !gotAgent || gotAgent === def.agent;
              const shown = model ? `${model.providerID}/${model.id}` : (gotModel ? `${gotModel.providerID}/${gotModel.id}` : '默认模型');
              const flags = [modelOk ? '✓' : '⚠️', agentOk ? '' : '⚠️ agent'].filter(Boolean).join(' ');
              const warn = modelOk ? '' : `\n  ⚠️ 实际模型是 ${gotModel ? `${gotModel.providerID}/${gotModel.id}` : '(空)'}，与要求不一致`;
              // 给会话挂一条 context 说明（不触发模型调用）：打开这个会话就知道自己是谁、在等什么
              try {
                await ctx.session.instructions?.entry?.put?.({
                  sessionID: sid,
                  key: 'swarm-role',
                  value: `你是本轮 swarm 的 ${role} 会话${name ? `（需求：${name}）` : ''}。` +
                    `只在收到 #${role} 指令或被唤醒后干活，不要自己找活；判定权不在你（test 说了算）。`,
                });
              } catch { /* instructions 不可用就算了，不影响主流程 */ }
              report.push(`- ${role} ${flags} \`${sid}\` · ${shown}${def.agent ? ` · agent ${def.agent}` : ''}${warn}`);
            }

            // ④ 落台账（供改名/唤醒/status 使用）：登记到该 run。新轮 sessions 从空起
            // （replaceSessions，只登记本次新建的，不合并旧轮残留 ID，防唤醒打到昨天的死会话；
            // 空轮/同轮复用时旧 sessions 本就为空，老行为零变）。
            // 有 --name 时 meta/round 双写一致（writeMeta 覆盖旧名；无 --name 不动，老行为）。
            try {
              if (name) writeMeta(cwd, upRun, { name });
              else ensureRunMeta(cwd, upRun);
            } catch { /* best-effort */ }
            const hasRound = writeRoundFor(upRun, {
              ...(name ? { name } : {}),
              sessions,
              ...(Object.keys(sessions).length && !readRoundFor(upRun).createdAt ? { createdAt: new Date().toISOString() } : {}),
            }, { replaceSessions: true });
            // 新轮落盘成功后必写 current（认领的是“新轮创建”这件事本身，不再以显式 --run 为条件）；
            // 显式 --run 的认领在上面已发生（老行为零变），这里只补派生轮。
            if (derivedUpRun) writeCurrentRunId(cwd, upRun);

            const head = `## swarm-up${isSubUp ? '（subagents：仅 plan 建会话）' : (isHybridUp ? '（hybrid：plan+dev 建会话，test走子代理）' : '')}\n${report.join('\n')}`;
            const subTail = `\n\n下一步：在 planner 会话里用 \`#plan 拆解 <需求>\`（会自动把这一轮会话改成需求名），` +
              `或直接 \`/swarm-start\` 派发已有队列（默认 hybrid）。` +
              `dev/test 由编排会话按 /swarm-mode recipe 派 subagent，不建会话（模型已记入 meta，编排循环见 /swarm-mode）。`;
            const hybridTail = `\n\n下一步：在 planner 会话里用 \`#plan 拆解 <需求>\`（会自动把这一轮会话改成需求名），` +
              `或直接 \`/swarm-start\` 派发已有队列（默认 hybrid：dev常驻唤醒）。` +
              `test/reviewer 由编排会话按 /swarm-mode recipe 派 subagent，不建会话（模型已记入 meta，编排循环见 /swarm-mode）。`;
            const tail = errors.length
              ? `\n\n### 失败\n${errors.join('\n')}${isSubUp ? subTail : (isHybridUp ? hybridTail : '')}`
              : (isSubUp ? subTail
                : (isHybridUp ? hybridTail
                : `\n\n下一步：在 planner 会话里用 \`#plan 拆解 <需求>\`（会自动把这一轮会话改成需求名），` +
                  `或直接 \`/swarm-start\` 派发已有队列（会自动唤醒 dev）。`));
            const roundLine = hasRound?.name ? `\n本轮：**${hasRound.name}**` : '';
            return reply(`${head}${roundLine}${tail}${errors.length ? '\n\n（失败的会话没有创建，修正后重跑 /swarm-up 即可）' : ''}`);
          } catch (e) {
            return reply(`❌ /swarm-up 异常：${oneLine(e?.message ?? e, 200)}\n\n${String(e?.stack ?? '').split('\n').slice(0, 5).join('\n')}`);
          }
        },
      });

      editor.add({
        name: 'swarm-start',
        description: '派发第一个 queued 任务给 dev（会唤醒 dev 会话；可用 --name 给本轮命名）',
        execute: async ({ sessionID, prompt }) => {
          const reply = (text) => ctx.session.prompt({ sessionID, text });
          try {
            const f = parseFlags(prompt.text ?? '');
            if (f.queue) runtimeQueue = f.queue;
            if (f.channel) cfg.channel = f.channel;
            if (f.no_wake === 'true') cfg.autoWake = false;
            if (f.wake === 'true') cfg.autoWake = true;
            const startRun = sanitizeRunId(cmdRun(f) ?? currentRunId());
            // 失败零落盘：先判队列存在（不存在直接回，不写 meta 不动 current），
            // 再 applyExecutorFlags（含模型校验），合法才 writeCurrentRunId。
            const qp = queueFor(startRun);
            if (!existsSync(qp)) return reply(`swarm: 队列不存在 ${displayPath(cwd, qp)}（run=${startRun}），先让 planner 写入（#plan）。`);
            const execStart = await applyExecutorFlags(startRun, f);
            if (execStart.error) return reply(`❌ /swarm-start 参数错误：${execStart.error}`);
            if (cmdRun(f)) writeCurrentRunId(cwd, startRun); // 显式 --run 即认领该轮（队列存在 + 执行器合法才认领）

            // 命名：--name 优先；否则沿用 #plan 时落盘的需求名。
            // 用户明确要的行为：「给定需求后，通过 start 应该把当前会话改成需求的名字」。
            const pending = oneLine(f.name ?? f.title ?? '', 60);
            const name = pending || roundNameFor(startRun);
            if (name) {
              const r = await nameRound(name, { currentSessionID: sessionID, run: startRun });
              if (r.errors.length) await reply(`⚠️ 部分会话改名失败：\n${r.errors.map((x) => `- ${x}`).join('\n')}`);
            }

            // FileBus 本地通道：run 目录 + meta 确保存在即可，无外部二进制可调。
            try { ensureRunMeta(cwd, startRun, name ? { name } : undefined); } catch { /* best-effort */ }
            // HALT 推送目标：记录当前 sessionID（每次 start 覆盖，最新编排者为准；/swarm-up 不记）
            try {
              if (typeof sessionID === 'string' && sessionID.trim()) writeMeta(cwd, startRun, { notify: { requester: sessionID } });
            } catch { /* best-effort */ }
            const nameLine = name ? `\n本轮：**${name}**（run=${startRun}）` : '\n（本轮没有需求名：用 `/swarm-up --name 需求名` 或 `#plan <需求>` 可以让三个会话按需求命名）';
            const r = await dispatchNext(startRun);
            if (!r.dispatched) {
              return reply(`无可派发任务（${r.drained ? '队列已空' : r.reason}）${nameLine}`);
            }
            return reply(
              `已派发 ${r.dispatched.id}（wave=${r.dispatched.wave}）→ dev［状态已流转：queued→dev_doing］\n` +
              `验证命令：\`${r.dispatched.verify_cmd}\`${nameLine}` +
              wakeLine(r.wake, 'dev', r.dispatched.id),
            );
          } catch (e) {
            return reply(`❌ /swarm-start 异常：${oneLine(e?.message ?? e, 200)}`);
          }
        },
      });

      editor.add({
        name: 'swarm-status',
        description: '实时状态：轮次/会话/模型 + 队列表 + 通道尾 + 卡住的任务（--run 看某轮，--all 看全部，--task 看单任务 timeline）',
        execute: async ({ sessionID, prompt }) => {
          const f = parseFlags(prompt?.text ?? '');
          if (f.task && f.task !== 'true') {
            const runId = sanitizeRunId(cmdRun(f) ?? currentRunId());
            const rr = resolveRun(cwd, { run: runId, cfgRunId: rawRunId });
            const cur = loadQueue(queueFor(runId)).find((t) => t.id === f.task);
            const rows = readTimeline(rr.runDir).filter((r) => r.taskId === f.task);
            const body = rows.length
              ? rows.map((r) => `- seq${r.seq ?? '?'} ${r.from ?? '-'}→${r.to ?? '-'} by=${r.by ?? '-'} reason=${r.reason ?? '-'} ${r.ts ?? ''} ${timelinePatchNote(r)}`).join('\n')
              : '（该任务暂无 timeline 记录）';
            // Reviewer-N1：--task 打印 findings 全量（queue 快照 + review 行快照，纯读）
            let findingsBlock = '';
            try {
              const all = Array.isArray(cur?.findings) ? cur.findings : [];
              if (all.length) {
                const openImp = all.filter((x) => x && x.severity === 'Important' && x.status === 'open').length;
                findingsBlock = `\n\n### findings（${all.length} 条，open Important ${openImp}）\n` +
                  all.map((x) => `- ${x.id} [${x.severity}/${x.status}] ${x.file ?? '-'}:${x.line ?? '-'} ${x.rule ?? ''}${x.status === 'wontfix' && x.reason ? ` reason=${oneLine(x.reason, 80)}` : ''}`).join('\n');
              } else if (cur && cur.review) {
                findingsBlock = '\n\n### findings（暂无，reviewer 尚未出结论）';
              }
            } catch { /* findings 打印失败不影响主 timeline */ }
            await ctx.session.prompt({
              sessionID,
              text: `## swarm timeline：${f.task}（run=${runId}，当前：${cur ? cur.status : '不在队列'}）\n\n${body}${findingsBlock}`,
            });
            return;
          }
          if (f.all === 'true') {
            const rows = summarizeRuns();
            const cur = currentRunId();
            const body = rows.length
              ? `| run | name | queued | dev | gate | test | reviewing | passed | halted | 会话 |\n|---|---|---|---|---|---|---|---|---|---|\n` +
                rows.map((r) => `| ${r.runId}${r.runId === cur ? ' ←当前' : ''} | ${oneLine(r.name || '-', 24)} | ${r.queued} | ${r.dev_doing} | ${r.gate_check} | ${r.test_doing} | ${r.reviewing ?? 0} | ${r.passed} | ${r.halted} | ${r.sessions} |`).join('\n')
              : '(还没有任何轮：先跑 `/swarm-up --run <id> --name <需求>`）';
            await ctx.session.prompt({
              sessionID,
              text: `## swarm runs（${rows.length} 轮，当前：${cur}）\n\n${body}\n\n单轮详情：\`/swarm-status --run <id>\`；切换当前轮：\`/swarm-switch --run <id>\``,
            });
            return;
          }
          const runId = sanitizeRunId(cmdRun(f) ?? currentRunId());
          const qp = queueFor(runId);
          const tasks = loadQueue(qp);
          const tail = (await tailFor(runId, 6)).map((e) => `- seq${e.seq} ${e.by}: ${String(e.text).split('\n')[0]}`).join('\n');
          const stuck = tasks.filter((t) => (t.status === 'dev_doing' || t.status === 'test_doing') && t.retries >= cfg.maxRetries);
          const risky = highRiskTasks(tasks, cfg.sensitivePaths);

          // 待批（10-30-swarm-approve-softcard）：high-risk + 无 approve 行 + 未 passed → pending-approval。
          // 纯算（读 timeline presence），不存新状态、不写盘。
          let pending = [];
          try {
            const rrP = resolveRun(cwd, { run: runId, cfgRunId: rawRunId });
            const approved = new Set(
              readTimeline(rrP.runDir)
                .filter((r) => r && r.kind === 'approve' && r.taskId)
                .map((r) => r.taskId),
            );
            pending = tasks.filter((t) => t && t.status !== 'passed' && !approved.has(t.id)
              && highRiskTasks([t], cfg.sensitivePaths).length);
          } catch {
            pending = [];
          }

          // R5+R6：两行指标（永不抛错：timeline 缺失/坏行只显示空口径）。
          // rounds-to-pass 定义：本 run 已 passed 任务的 (to=dev_doing timeline 计数+1) 均值，
          // gate 打回（gate_check→dev_doing）计入（与 test fail 打回同权）。
          let roundsLine = 'rounds-to-pass 均值：（暂无 passed）';
          let dispLine = 'disposition 分布：fixed=0 wrong=0 intentional=0 wontfix=0';
          try {
            const rr = resolveRun(cwd, { run: runId, cfgRunId: rawRunId });
            const tlRows = readTimeline(rr.runDir);
            const rt = roundsToPass(tasks, tlRows);
            roundsLine = rt.count
              ? `rounds-to-pass 均值：${rt.mean.toFixed(2)}（${rt.count} 个 passed；定义：每个 passed 任务的 to=dev_doing 计数+1 的均值，gate 打回计入）`
              : 'rounds-to-pass 均值：（暂无 passed）';
            const dd = dispositionDist(tasks);
            dispLine = `disposition 分布：fixed=${dd.fixed} wrong=${dd.wrong} intentional=${dd.intentional} wontfix=${dd.wontfix}`;
          } catch { /* 指标失败不影响主状态 */ }

          // 会话台账：这是「任务到底有没有派下去、那边是不是真的在跑」的唯一可见入口。
          // 模型在这里再核一次 —— swarm-up 之后有人手改过模型 / 模型下架，都能当场发现。
          const r = readRoundFor(runId);
          // nosignal（选型 B：折叠为一行）：subagents 下无 role 会话，旧「手上任务」列会把
          // 共享队列里的 dev_doing/test_doing 任务挂到毫不相干的会话名下（假信号）。
          // subagents 分支只显示待派发 ids + recipe 指引，不显示任何会话持有关系；sessions 分支零变。
          let sessionBlock;
          if (isSub(runId)) {
            // 口径同源：进行中即 liveTasks（与 dispatchNext/swarm-drained 同一真相，不手写状态表）
            const pending = liveTasks(tasks).map((t) => `${t.id} ${t.status}`);
            const pendingText = pending.length ? pending.join('、') : '无（队列无进行中任务）';
            sessionBlock = `子代理派发中（无 role 会话）待派发：${pendingText} —— 待编排会话派 subagent（判活 /swarm-drained，派发见 /swarm-mode recipe）`;
          } else {
          const sessions = r.sessions ?? {};
          const index = await modelIndex(ctx).catch(() => null);
          const rows = [];
          for (const [role, sid] of Object.entries(sessions)) {
            let info = null;
            let readErr = '';
            try { info = await ctx.session.get({ sessionID: sid }); } catch (e) { readErr = oneLine(e?.message ?? e, 80); }
            const m = info?.model;
            const ref = m ? `${m.providerID}/${m.id}` : '(默认)';
            const bad = index && m ? !resolveModelRef(index, m).ok : false;
            // 口径同源：手上任务即分给该 role 的 liveTasks（与 dispatchNext/swarm-drained 同一真相，不手写状态表）
            const hold = tasks.find((t) => t.assignee === role && LIVE_STATUSES.includes(t.status));
            rows.push(`| ${role} | \`${sid}\` | ${oneLine(info?.title ?? '-', 28)} | ${ref}${bad ? ' ⚠️不可用' : ''} | ${readErr ? '读取失败' : (hold ? `${hold.id} ${hold.status}` : '空闲')} |`);
          }
          sessionBlock = rows.length
            ? `| role | session | title | model | 手上任务 |\n|---|---|---|---|---|\n${rows.join('\n')}`
            : '（还没有登记会话：先跑 `/swarm-up`）';
          }

          // 疑似无人接单：dev_doing/test_doing/gate_check 超 15 分钟且 timeline 无后续行（永不抛错）。
          let idle = [];
          try {
            const rrIdle = resolveRun(cwd, { run: runId, cfgRunId: rawRunId });
            idle = idleSuspects(tasks, readTimeline(rrIdle.runDir));
          } catch { idle = []; }

          await ctx.session.prompt({
            sessionID,
            text: `## swarm-status\nRun：${runId}　队列：${displayPath(cwd, qp)}　通道：${cfg.channel}　轮次：${r.name ? `**${r.name}**` : '(未命名)'}\n${execLineFor(runId)}\n\n` +
              `### 会话\n${sessionBlock}\n\n` +
              `### 队列\n${table(tasks)}\n\n` +
              `### 质量\n- ${roundsLine}\n- ${dispLine}\n\n` +
              (risky.length ? `### 高风险提示\n⚠️ 高风险：建议两人复核：${risky.map((t) => t.id).join(', ')}\n\n` : '') +
              (pending.length ? `### 待批（pending-approval）\n${pending.map((t) => `- ⏳ ${t.id} 高风险未批（${t.status}）：主会话确认 diff 后调 \`swarm_approve\` {\`task_id\`: "${t.id}"} 放行`).join('\n')}\n\n` : '') +
              (stuck.length ? `### 需人工关注\n${stuck.map((t) => `- ${t.id} 重试 ${t.retries} 次`).join('\n')}\n\n` : '') +
              (idle.length ? `### 疑似无人接单\n${idle.map((x) => `- ${x.id} ${x.status} 已停留 ${x.dur}（超15分钟无进展，疑似无人接单：去对应会话确认是否跑起来，或 /swarm-retry 重派）`).join('\n')}\n\n` : '') +
              `### 通道最近事件\n${tail || '(无)'}`,
          });
        },
      });

      editor.add({
        name: 'swarm-mode',
        description: '只读：当前 run 的执行器 + 角色模型 + 子代理编排 recipe（设置走 /swarm-start --executor）',
        execute: async ({ sessionID, prompt }) => {
          const reply = (text) => ctx.session.prompt({ sessionID, text });
          try {
            const f = parseFlags(prompt?.text ?? '');
            const runId = sanitizeRunId(cmdRun(f) ?? currentRunId());
            const setHint = (f.executor !== undefined && f.executor !== 'true') || f.dev_model !== undefined || f.tester_model !== undefined || f.reviewer_model !== undefined
              ? '\n\n⚠️ /swarm-mode 是只读的：改执行器/模型走 `/swarm-start --executor sessions|subagents|hybrid --dev-model a/b --tester-model c/d --reviewer-model e/f [--run <id>]`（本次 flags 已忽略，只展示现状）。'
              : '';
            return reply(
              `## swarm-mode（只读，run=${runId}）\n${execLineFor(runId)}\n\n` +
              `### 混合编排循环 recipe（默认 hybrid：dev常驻会话，test/reviewer走子代理；显式整轮 sessions/subagents 仍可用）\n` +
              '```\n' +
              DRAINED_RECIPE + '\n' +
              '```\n\n' +
              'dev 常驻会话直接开工（wake已投递；任务已是 dev_doing 且归自己时跳过 claim 直接开工，claim 返回"可继续"时同样直接开工）。test/reviewer 子代理流程不变。\n\n' +
              '### prompt 模板（派发 subagent 时拼；dev 常驻会话走 wake 注入体）\n' +
              '- dev：`expandTag({role:"dev",taskId})` 全文 + `任务JSON` + 补充要求（必须含上次 fail 的 `detail/failed_ids`，时间线已现成，直接复用 wake 注入体）。\n' +
              '- test：`expandTag({role:"test",taskId})` 全文 + `任务JSON`。\n' +
              '- reviewer：任务JSON + `git show <commit>` diff(截断50KB) + REVIEW.md命中 + excluded=[finding ids]（review 开的任务 test pass 后派：medium/high 默认进评审，low 显式开）。\n\n' +
              '### reviewer 两轮与去重（standard）\n' +
              '- review 开的任务 test pass 后派 reviewer subagent（agent=swarm-reviewer；medium/high 默认进评审，low 默认直通，显式 review 优先）。\n' +
              '- standard 分两轮：第二轮 prompt 附第一轮 findings 全列为 excluded。\n' +
              '- N1 去重：同 file+line+rule 合并一句（冲突留两条）。\n\n' +
              '### 模型映射\n' +
              '- test subagent 用 `roleModels.test`，reviewer subagent 用 `roleModels.reviewer`，dev 常驻会话用 `roleModels.dev`（建会话时写入）；subagent 无配置模型则继承父会话模型（官方语义）。\n' +
              '- gate/FSM/门禁/timeline 全部沿用，与执行器无关。' +
              setHint,
            );
          } catch (e) {
            return reply(`❌ /swarm-mode 异常：${oneLine(e?.message ?? e, 200)}`);
          }
        },
      });

      editor.add({
        name: 'swarm-drained',
        description: '只读判活：本轮是否 drained（三态 dev_doing/test_doing/reviewing，与 dispatchNext 同口径；不改任何状态）',
        execute: async ({ sessionID, prompt }) => {
          const reply = (text) => ctx.session.prompt({ sessionID, text });
          try {
            const f = parseFlags(prompt?.text ?? '');
            const runId = sanitizeRunId(cmdRun(f) ?? currentRunId());
            const qp = queueFor(runId);
            // 纯读：只 loadQueue + 回复，不调 transition、不 wake、不 emit、不写 timeline/meta。
            if (!existsSync(qp)) return reply(`## swarm-drained（run=${runId}）\n✅ drained：队列文件不存在（无任务，视为 drained，只读，未改任何状态）`);
            const tasks = loadQueue(qp);
            const queued = tasks.filter((t) => t && t.status === 'queued');
            const live = liveTasks(tasks);
            if (!queued.length && !live.length) {
              return reply(`## swarm-drained（run=${runId}）\n✅ drained：队列空且无 dev_doing/test_doing/reviewing（与 dispatchNext 同口径，只读，未改任何状态）`);
            }
            const lines = [
              ...queued.map((t) => `- ${t.id} queued（待派发）`),
              ...live.map((t) => `- ${t.id} ${t.status}`),
            ];
            return reply(
              `## swarm-drained（run=${runId}）\n❌ 有活（${queued.length + live.length}）：drained=false（只读，未改任何状态）\n` +
              `${lines.join('\n')}`,
            );
          } catch (e) {
            return reply(`❌ /swarm-drained 异常：${oneLine(e?.message ?? e, 200)}`);
          }
        },
      });

      editor.add({
        name: 'swarm-eval',
        description: '只读导出 eval 信号行（HALT/fail 打回/review/revert/approve）到 .swarm/eval/<month>.jsonl（append + eid 幂等；不改队列/timeline）',
        execute: async ({ sessionID, prompt }) => {
          const reply = (text) => ctx.session.prompt({ sessionID, text });
          try {
            const f = parseFlags(prompt?.text ?? '');
            const runId = sanitizeRunId(cmdRun(f) ?? currentRunId());
            const rawMonth = f.month && f.month !== 'true' ? String(f.month).trim() : '';
            const month = rawMonth || new Date().toISOString().slice(0, 7);
            if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
              return reply('用法：`/swarm-eval [--run <id>] [--month YYYY-MM]`（month 形如 2026-10，只读，未改任何状态）');
            }
            // 纯读队列：前后快照留痕（e2e 用 deepEqual 锁死只读语义）。
            const qp = queueFor(runId);
            const before = existsSync(qp) ? JSON.stringify(loadQueue(qp)) : '[]';
            const rr = resolveRun(cwd, { run: runId, cfgRunId: rawRunId });
            const rows = readTimeline(rr.runDir);
            const hits = rows.filter(isEvalRow);
            const evalPath = join(cwd, '.swarm', 'eval', `${month}.jsonl`);
            const seen = new Set();
            try {
              if (existsSync(evalPath)) {
                for (const line of readFileSync(evalPath, 'utf8').split('\n')) {
                  if (!line.trim()) continue;
                  try {
                    const r = JSON.parse(line);
                    if (r && typeof r.eid === 'string') seen.add(r.eid);
                  } catch { /* 坏行跳过，不挡导出 */ }
                }
              }
            } catch { /* 读失败视为空集，本次照写 */ }
            const fresh = [];
            for (const r of hits) {
              const eid = evalEid(runId, r);
              if (seen.has(eid)) continue;
              seen.add(eid);
              fresh.push({
                eid, run: runId, seq: r.seq ?? null, taskId: r.taskId ?? '-',
                kind: r.kind ?? '-', from: r.from ?? null, to: r.to ?? null,
                by: r.by ?? '-', reason: r.reason ?? '-',
                commit: r.commit ?? '-', retries: r.retries ?? 0, ts: r.ts ?? null,
              });
            }
            if (fresh.length) {
              try { mkdirSync(dirname(evalPath), { recursive: true }); } catch { /* 父目录已存在 */ }
              appendFileSync(evalPath, `${fresh.map((x) => JSON.stringify(x)).join('\n')}\n`, 'utf8');
            }
            const after = existsSync(qp) ? JSON.stringify(loadQueue(qp)) : '[]';
            const ro = before === after ? '只读，未改任何状态' : '⚠️ 队列快照变化（预期外）';
            const sample = fresh.slice(0, 10).map((x) => `- ${x.taskId} ${x.kind} ${x.from ?? '-'}→${x.to ?? '-'} ${oneLine(x.reason, 80)}`).join('\n');
            return reply(
              `## swarm-eval（run=${runId} month=${month}，${ro}）\n` +
              `timeline ${rows.length} 行 → eval 信号 ${hits.length} 行（HALT/fail 打回/review/revert/approve），` +
              `本次新增 ${fresh.length} 行（同 eid 跳过 ${hits.length - fresh.length}），落盘 ${displayPath(cwd, evalPath)}\n` +
              (sample ? `${sample}${fresh.length > 10 ? `\n…（另 ${fresh.length - 10} 行见文件）` : ''}` : '（本次无新增： timeline 无新信号或已全部导出过）'),
            );
          } catch (e) {
            return reply(`❌ /swarm-eval 异常：${oneLine(e?.message ?? e, 200)}`);
          }
        },
      });

      editor.add({
        name: 'swarm-runs',
        description: '列出所有轮（run/需求名/各状态计数/会话数），等价 status --all 精简版',
        execute: async ({ sessionID }) => {
          const rows = summarizeRuns();
          const cur = currentRunId();
          const body = rows.length
            ? rows.map((r) => `- \`${r.runId}\`${r.runId === cur ? ' ←当前' : ''}${r.name ? `「${oneLine(r.name, 30)}」` : ''} queued ${r.queued} · dev_doing ${r.dev_doing} · gate_check ${r.gate_check} · test_doing ${r.test_doing} · reviewing ${r.reviewing ?? 0} · passed ${r.passed} · halted ${r.halted} · 会话 ${r.sessions}`).join('\n')
            : '(还没有任何轮：先跑 `/swarm-up --run <id> --name <需求>`）';
          await ctx.session.prompt({
            sessionID,
            text: `## swarm runs（${rows.length} 轮，当前：${cur}）\n\n${body}`,
          });
        },
      });

      editor.add({
        name: 'swarm-switch',
        description: '切换当前轮（改 .swarm/current 指针，后续不带 --run 的命令都看该轮）',
        execute: async ({ sessionID, prompt }) => {
          const reply = (text) => ctx.session.prompt({ sessionID, text });
          try {
            const f = parseFlags(prompt.text ?? '');
            if (!f.run || f.run === 'true') return reply('用法：`/swarm-switch --run <id>`（`--run` 后面要跟轮名字，只留字母数字 `_-`）');
            const id = writeCurrentRunId(cwd, f.run);
            try { ensureRunMeta(cwd, id); } catch { /* best-effort */ }
            return reply(`已切换到轮 **${id}**（/swarm-status 看本轮，/swarm-status --all 看全部）`);
          } catch (e) {
            return reply(`❌ /swarm-switch 异常：${oneLine(e?.message ?? e, 200)}`);
          }
        },
      });

      editor.add({
        name: 'swarm-clean',
        description: '归档某轮目录到 .swarm/archive（保留全部文件；默认当前轮；--all-done 只搬无活轮）',
        execute: async ({ sessionID, prompt }) => {
          const reply = (text) => ctx.session.prompt({ sessionID, text });
          try {
            const f = parseFlags(prompt.text ?? '');
            const allDone = f.all_done === 'true' || f.alldone === 'true';
            // current 善后：被清的是当前轮 → 指到最近还有活的轮；一个没有 → 清空 current（board 灰态）。
            // 有活口径与 drained 同调：queued 非空或 liveTasks 非空即有活。
            const retargetAfter = (archivedIds) => {
              try {
                const cur = readCurrentRunId(cwd);
                if (!cur || !archivedIds.includes(cur)) return '';
                const remaining = listRuns(cwd).slice().reverse();
                for (const rr of remaining) {
                  let ts = [];
                  try { ts = loadQueue(join(rr.runDir, 'queue.jsonl')); } catch { ts = []; }
                  const hasLive = ts.some((t) => t && (t.status === 'queued' || LIVE_STATUSES.includes(t.status)));
                  if (hasLive) {
                    writeCurrentRunId(cwd, rr.runId);
                    return `\n当前轮已归档，已指到最近有活轮 **${rr.runId}**`;
                  }
                }
                clearCurrentRunId(cwd);
                return '\n当前轮已归档且无有活轮，已清空 current（board 灰字“暂无轮次”，/swarm-up 开新轮）';
              } catch {
                return '';
              }
            };
            if (allDone) {
              const runs = listRuns(cwd);
              if (!runs.length) return reply('swarm-clean --all-done：没有可归档的轮（.swarm/runs 为空）');
              const moved = [];
              const movedIds = [];
              const skipped = [];
              const failed = [];
              for (const r of runs) {
                let tasks = [];
                try { tasks = loadQueue(join(r.runDir, 'queue.jsonl')); } catch { tasks = []; }
                const queued = tasks.filter((t) => t && t.status === 'queued').length;
                const live = liveTasks(tasks).length;
                if (queued > 0 || live > 0) {
                  skipped.push(`- \`${r.runId}\` 跳过（有活：queued ${queued} + 进行中 ${live}）`);
                  continue;
                }
                const res = archiveRun(cwd, r.runId);
                if (res.ok) {
                  moved.push(`- \`${r.runId}\` → ${displayPath(cwd, res.to)}`);
                  movedIds.push(r.runId);
                } else failed.push(`- \`${r.runId}\` 失败：${res.reason}`);
              }
              const tail = retargetAfter(movedIds);
              const body = [
                `## swarm-clean --all-done（${moved.length} 搬，${skipped.length} 跳过${failed.length ? `，${failed.length} 失败` : ''}）`,
                moved.length ? `### 已归档\n${moved.join('\n')}` : '### 已归档\n（无可搬轮：全部有活或已清空）',
                skipped.length ? `### 跳过（有活不动）\n${skipped.join('\n')}` : '',
                failed.length ? `### 失败\n${failed.join('\n')}` : '',
              ].filter(Boolean).join('\n\n');
              return reply(`${body}${tail}`);
            }
            if (!cmdRun(f) && readCurrentRunId(cwd) == null) {
              return reply('暂无轮次（current 为空），无需清理（/swarm-up 开新轮）');
            }
            const target = sanitizeRunId(cmdRun(f) ?? currentRunId());
            const rr = resolveRun(cwd, { run: target, cfgRunId: rawRunId });
            if (!existsSync(rr.runDir)) return reply(`轮不存在：${target}（${displayPath(cwd, rr.runDir)} 缺失）`);
            let note = '';
            try {
              const ts = loadQueue(rr.queuePath);
              const qn = ts.filter((t) => t && t.status === 'queued').length;
              const lv = liveTasks(ts).length;
              if (qn > 0 || lv > 0) note = `（含未完任务：queued ${qn} + 进行中 ${lv}，已一并归档）`;
            } catch { /* 队列读失败不挡归档 */ }
            const res = archiveRun(cwd, target);
            if (!res.ok) return reply(`❌ /swarm-clean 失败：${res.reason}`);
            const tail = retargetAfter([target]);
            return reply(`已归档轮 **${target}**${note} → ${displayPath(cwd, res.to)}（queue/timeline/events/round/meta 全保留供审计）${tail}`);
          } catch (e) {
            return reply(`❌ /swarm-clean 异常：${oneLine(e?.message ?? e, 200)}`);
          }
        },
      });

      editor.add({
        name: 'swarm-migrate',
        description: '一次性迁移：旧全局队列/台账/事件拷入某 run（幂等，目标非空拒绝，需 --force）',
        execute: async ({ sessionID, prompt }) => {
          const reply = (text) => ctx.session.prompt({ sessionID, text });
          try {
            const f = parseFlags(prompt.text ?? '');
            const want = f.run && f.run !== 'true' ? f.run : (f.name && f.name !== 'true' ? f.name : undefined);
            const r = migrateLegacy(cwd, { run: want, legacyQueue: effQueue(), force: f.force === 'true' });
            if (!r.ok) return reply(`❌ 迁移拒绝：${r.reason}`);
            const lines = [...r.copied.map((c) => `- ${c}`), ...r.skipped.map((s) => `- （跳过）${s}`), ...(r.notes ?? []).map((n) => `- ${n}`)];
            return reply(`## swarm-migrate → ${r.runId}\n${lines.join('\n') || '（无文件可迁）'}${r.message ? `\n${r.message}` : ''}`);
          } catch (e) {
            return reply(`❌ /swarm-migrate 异常：${oneLine(e?.message ?? e, 200)}`);
          }
        },
      });

      editor.add({
        name: 'swarm-rebuild',
        description: '用 timeline.jsonl 事件重放重建队列（默认 dry-run 只比对不写文件；--write 真写）',
        execute: async ({ sessionID, prompt }) => {
          const reply = (text) => ctx.session.prompt({ sessionID, text });
          try {
            const f = parseFlags(prompt.text ?? '');
            const runId = sanitizeRunId(cmdRun(f) ?? currentRunId());
            // 队列解析与其它命令一致（显式 --queue 是兼容通道）；timeline 恒归所属 run。
            const rr = resolveRun(cwd, { run: runId, queue: f.queue ?? effQueue(), cfgRunId: rawRunId });
            const current = loadQueue(rr.queuePath);
            const rebuilt = rebuildQueueFromTimeline(rr.runDir);
            const same = JSON.stringify(current) === JSON.stringify(rebuilt);
            if (f.write === 'true') {
              if (same) return reply(`swarm-rebuild（run=${runId}）：与现状一致（${rebuilt.length} 行），未改写。`);
              saveQueueAtomic(rr.queuePath, rebuilt);
              invalidate(rr.queuePath);
              return reply(`swarm-rebuild（run=${runId}）：已用 timeline 重建队列（${current.length}→${rebuilt.length} 行）。\n${diffQueueLines(current, rebuilt)}`);
            }
            if (same) return reply(`swarm-rebuild dry-run（run=${runId}）：一致（${rebuilt.length} 行，0 差异），未写文件。加 --write 真写。`);
            return reply(`swarm-rebuild dry-run（run=${runId}）：现状 ${current.length} 行 vs 重放 ${rebuilt.length} 行，差异：\n${diffQueueLines(current, rebuilt)}\n（确认后加 --write 真写）`);
          } catch (e) {
            return reply(`❌ /swarm-rebuild 异常：${oneLine(e?.message ?? e, 200)}`);
          }
        },
      });

      editor.add({
        name: 'swarm-models',
        description: '列出可用模型（--provider/--search 过滤），用于给 /swarm-up 挑模型',
        execute: async ({ sessionID, prompt }) => {
          const reply = (text) => ctx.session.prompt({ sessionID, text });
          try {
            const f = parseFlags(prompt.text ?? '');
            const index = await modelIndex(ctx);
            if (!index) return reply('⚠️ 读不到模型注册表（ctx.model.list 不可用），无法列出。可以试 `opencode api get /api/model`。');
            const provider = f.provider ?? '';
            const q = String(f.search ?? f.q ?? '').toLowerCase();
            const rows = index.entries
              .filter((m) => (!provider || m.providerID === provider))
              .filter((m) => (!q || `${m.providerID}/${m.id}/${m.name}`.toLowerCase().includes(q)))
              .slice(0, 40)
              .map((m) => `- \`${m.providerID}/${m.id}\`${m.name && m.name !== m.id ? ` — ${oneLine(m.name, 40)}` : ''}`);
            const total = index.entries.length;
            return reply(`## swarm-models\n共 ${total} 个可用模型${provider ? `（provider=${provider}）` : ''}${q ? `（含 "${q}"）` : ''}\n\n` +
              `${rows.join('\n') || '（没有匹配）'}\n\n用法：\`/swarm-up --planner-model <provider/model> --dev-model <provider/model> --tester-model <provider/model> --name 需求名\``);
          } catch (e) {
            return reply(`❌ /swarm-models 异常：${oneLine(e?.message ?? e, 160)}`);
          }
        },
      });

      editor.add({
        name: 'swarm-halt',
        description: '人工熔断某任务（--run 指定轮，默认当前轮）',
        execute: async ({ sessionID, prompt }) => {
          const f = parseFlags(prompt.text ?? '');
          const runId = sanitizeRunId(cmdRun(f) ?? currentRunId());
          const id = f.task ?? (prompt.text ?? '').trim();
          const reason = String(f.reason ?? 'manual');
          const r = await haltTask(runId, id, reason, 'human');
          if (r.ok) {
            await emitFor(runId, 'human', '[HALT]', { task: id, reason });
            const wave = r.task?.wave ?? '-';
            const retries = r.task?.retries ?? 0;
            const reasonShort = String(f.reason ?? 'manual').slice(0, 200);
            await notifyHalt(runId, `⛔ HALT 通知 ${id}（wave=${wave}，retries=${retries}）：人工熔断 reason=${reasonShort}\n恢复：/swarm-retry --task ${id}`);
          }
          await ctx.session.prompt({ sessionID, text: r.ok ? `已熔断 ${id}（run=${runId}）` : `熔断失败：${r.message}` });
        },
      });

      editor.add({
        name: 'swarm-retry',
        description: '人工重试已熔断任务（会唤醒 dev；--run 指定轮，默认当前轮）',
        execute: async ({ sessionID, prompt }) => {
          const f = parseFlags(prompt.text ?? '');
          const runId = sanitizeRunId(cmdRun(f) ?? currentRunId());
          const id = f.task ?? (prompt.text ?? '').trim();
          const r = await transition(runId, id, ['halted'], { status: 'dev_doing', assignee: 'dev', retries: 0, reviewRounds: 0 }, { by: 'human', reason: 'retry' });
          if (r.ok) {
            await emitFor(runId, 'human', '[TASK-ASSIGN]', { task: id, wave: r.task.wave, to: 'dev', retry: 'true', verify: r.task.verify_cmd });
          }
          const wake = r.ok ? await wakeRole('dev', r.task, runId) : null;
          await ctx.session.prompt({
            sessionID,
            text: r.ok ? `状态已流转：${id} halted→dev_doing（已重派待 dev 接单）${wakeLine(wake, 'dev', id)}` : `重试失败：${r.message}`,
          });
        },
      });

      editor.add({
        name: 'swarm-revert',
        description: '把 halted/passed 任务回退到最后一次进门禁之前（dev_doing + commit 回退 + verdict 清空）',
        execute: async ({ sessionID, prompt }) => {
          const reply = (text) => ctx.session.prompt({ sessionID, text });
          try {
            const f = parseFlags(prompt.text ?? '');
            const runId = sanitizeRunId(cmdRun(f) ?? currentRunId());
            const id = f.task ?? (prompt.text ?? '').trim();
            const r = await revertTask(runId, id, 'human', f.reason ? String(f.reason) : '');
            if (!r.ok) return reply(r.message);
            await emitFor(runId, 'human', '[REVERT]', { task: id, from: r.from, to: 'dev_doing', commit: r.task.commit ?? '-' });
            const wake = await wakeRole('dev', r.task, runId);
            return reply(`状态已流转：${id} →dev_doing（已回退，commit 已回退到进门禁前${r.task.commit ? `：${r.task.commit}` : '（此前无 commit）'}，verdict 已清空）${wakeLine(wake, 'dev', id)}`);
          } catch (e) {
            return reply(`❌ /swarm-revert 异常：${oneLine(e?.message ?? e, 200)}`);
          }
        },
      });

      editor.add({
        name: 'swarm-nightly',
        description: '只读重跑该 run 全部 passed 任务的 verify_cmd（顺序复用 runVerify，不改状态；--run 指定轮，--limit 限个数默认 20）',
        execute: async ({ sessionID, prompt }) => {
          const reply = (text) => ctx.session.prompt({ sessionID, text });
          try {
            const f = parseFlags(prompt.text ?? '');
            const runId = sanitizeRunId(cmdRun(f) ?? currentRunId());
            const rawLimit = f.limit ?? f.n ?? '20';
            let limit = 20;
            if (rawLimit !== undefined && rawLimit !== null && String(rawLimit) !== 'true') {
              const n = parseInt(String(rawLimit), 10);
              if (Number.isFinite(n) && n > 0) limit = n;
            }
            const qp = queueFor(runId);
            if (!existsSync(qp)) return reply(`swarm-nightly：队列不存在 ${displayPath(cwd, qp)}（run=${runId}），无 passed 可跑`);
            const passed = loadQueue(qp).filter((t) => t && t.status === 'passed');
            if (!passed.length) return reply(`## swarm-nightly（run=${runId}）\n无 passed 任务，无需重跑（只读，未改任何状态）`);
            const toRun = passed.slice(0, limit);
            const skipped = passed.slice(limit);
            // R7：顺序重跑（复用 runVerify，超时走配置），不调任何 transition（跑红也不改 passed）。
            const results = [];
            for (const t of toRun) {
              let r;
              try {
                r = await runVerify(t.verify_cmd, { cwd, timeoutMs: cfg.verifyTimeoutMs, allowlist: cfg.allowlist });
              } catch (e) {
                r = { ok: false, reason: String(e?.message ?? e).slice(0, 200), durationMs: 0 };
              }
              results.push({ id: t.id, ok: !!r.ok, reason: r.reason ?? (r.ok ? 'ok' : 'fail'), ms: r.durationMs ?? 0 });
            }
            const greens = results.filter((x) => x.ok);
            const reds = results.filter((x) => !x.ok);
            const prefix = reds.length ? '[NIGHTLY-RED]' : '[NIGHTLY-GREEN]';
            const summaryKv = {
              task: 'nightly', run: runId, total: String(passed.length),
              ran: String(toRun.length), green: String(greens.length), red: String(reds.length),
              failed: reds.length ? reds.map((x) => x.id).join(',') : '-',
              skipped: skipped.length ? skipped.map((t) => t.id).join(',') : '-',
            };
            // FileBus + timeline 双写（通用约束：新事件同时写两处；timeline kind='nightly' 不参与 rebuild）。
            // commit 用时间戳保证每次 nightly 的 eid 唯一（同结果连跑两次也各发一条，status 尾可见）。
            const stamp = String(Date.now());
            await emitFor(runId, 'orchestrator', prefix, { ...summaryKv, at: new Date().toISOString() }, { commit: stamp });
            try {
              appendTimeline(timelineFor(runId), {
                taskId: 'nightly', kind: 'nightly', from: null, to: null,
                by: 'orchestrator', reason: `nightly:${greens.length}/${toRun.length} run=${runId}`,
                commit: stamp, retries: 0,
                patch: { summary: `${prefix} ran=${toRun.length} green=${greens.length} red=${reds.length}`, results: results.map((x) => ({ id: x.id, ok: x.ok })) },
                ts: new Date().toISOString(),
              });
            } catch { /* timeline 双写 best-effort，不影响只读语义 */ }
            const lines = results.map((x) => `- ${x.id}：${x.ok ? `✅ (${x.ms}ms)` : `❌ ${oneLine(x.reason, 160)}`}`);
            const skipLine = skipped.length
              ? `\n跳过（超出 limit=${limit} 未跑）：${skipped.map((t) => t.id).join(', ')}`
              : '';
            return reply(
              `## swarm-nightly（run=${runId}）\npassed 共 ${passed.length} 个，limit ${limit}，本次跑 ${toRun.length} 个（只读，未改任何状态）\n` +
              `${lines.join('\n')}${skipLine}\n汇总 ${prefix} 已发送（status 尾可见）`,
            );
          } catch (e) {
            return reply(`❌ /swarm-nightly 异常：${oneLine(e?.message ?? e, 200)}`);
          }
        },
      });
    });

    // ---------- 工具 ----------
    await ctx.tool.transform((editor) => {
      const S = { queue: { type: 'string' }, channel: { type: 'string' }, as: { type: 'string' }, run: { type: 'string' } };

      editor.add({
        name: 'swarm_read_queue',
        description: '读队列（按状态筛选）。做任何动作前先调它确认现状。',
        input: { type: 'object', properties: { status: { type: 'string' }, ...S }, additionalProperties: false },
        execute: async (input) => {
          const qp = input?.queue ? abs(cwd, input.queue) : queueFor(input?.run);
          const tasks = loadQueue(qp);
          const filtered = input?.status ? tasks.filter((t) => t.status === input.status) : tasks;
          return { content: JSON.stringify(filtered, null, 2) };
        },
      });

      editor.add({
        name: 'swarm_plan',
        description: 'planner 专用：批量入队任务（每项必须含 id/wave/title/acceptance/verify_cmd/testing，testing 非空，可写"同 verify_cmd"）；name 给本轮需求命名',
        input: {
          type: 'object',
          properties: { tasks: { type: 'array', items: { type: 'object' } }, name: { type: 'string' }, ...S },
          required: ['tasks'],
          additionalProperties: false,
        },
        execute: async (input) => {
          const runId = sanitizeRunId(input?.run ?? currentRunId());
          const qp = input?.queue ? abs(cwd, input.queue) : queueFor(runId);
          // 非空轮提示：只提示不拦截，入队语义零变（空轮无提示）。
          let existingCount = 0;
          try {
            const prev = loadQueue(qp);
            existingCount = Array.isArray(prev) ? prev.length : 0;
          } catch { existingCount = 0; }
          const results = [];
          for (const row of input.tasks ?? []) {
            const r = enqueueTask(qp, row, timelineFor(runId), { by: 'plan', reason: 'create' });
            results.push(`${row.id ?? '?'}: ${r.ok ? 'queued' : r.reason}`);
          }
          invalidate(qp);
          // 命名只认显式 name：从「第一个任务标题」猜需求名会把无关的旧任务名带进来
          // （实测污染：上一轮的「永远失败」被当成这一轮的需求名）。
          const name = oneLine(input.name ?? '', 60);
          try { ensureRunMeta(cwd, runId, name ? { name } : undefined); } catch { /* best-effort */ }
          let nameLine = '';
          if (name && name !== roundNameFor(runId)) {
            const r = await nameRound(name, { run: runId });
            nameLine = `\n本轮命名：**${name}**（已改名 ${r.renamed.length} 个会话${r.errors.length ? `，${r.errors.length} 个失败` : ''}）`;
          }
          let hintLine = '';
          if (existingCount > 0) {
            hintLine = `\n⚠️ 该轮已有${existingCount}个任务，本次入队会混排；要用新轮请换run或先clean归档（仅提示，入队照常）`;
          }
          return { content: (results.join('\n') || '(no tasks)') + nameLine + hintLine };
        },
      });

      editor.add({
        name: 'swarm_claim',
        description: 'dev 认领任务（queued → dev_doing，CAS 保证不双花）',
        input: { type: 'object', properties: { task_id: { type: 'string' }, role: { type: 'string' }, ...S }, required: ['task_id'], additionalProperties: false },
        execute: async (input) => {
          const runId = sanitizeRunId(input?.run ?? currentRunId());
          const who = input.role ?? 'dev';
          const r = await transition(runId, input.task_id, 'queued', {
            status: 'dev_doing', assignee: who,
          }, { by: input.as ?? who, reason: 'claim', queue: input?.queue ?? null });
          if (!r.ok) {
            // 编排预占可继续：/swarm-start 已把任务派给调用者（dev_doing 且归属一致），
            // 此时 claim 按 CAS 必败——给可继续信号直接开工，不算认领失败。
            // 他人持有/状态不对仍拒收（sessions 语义零变）。
            try {
              const qp = input?.queue ? abs(cwd, input.queue) : queueFor(input?.run);
              const cur = loadQueue(qp).find((t) => t && t.id === input.task_id);
              if (cur && cur.status === 'dev_doing' && cur.assignee === who) {
                return { content: `可继续：${cur.id} 已是 dev_doing 且归属 ${who}（属编排预派发，跳过 claim 直接开工）\n验收：${cur.acceptance}\n验证命令：${cur.verify_cmd}` };
              }
            } catch { /* 快照读失败就回退原失败文案 */ }
            return { content: `认领失败：${r.message}` };
          }
          await emitFor(runId, who, '[TASK-ASSIGN]', { task: r.task.id, wave: r.task.wave, to: who, verify: r.task.verify_cmd });
          // 高风险软提示（10-31-swarm-up-name-card）：放行但不静默 —— high-risk 且同 run timeline
          // 无 kind='approve' 行时，回执追加补批指引（含 swarm_approve 用法 + 任务 id）；有 approve/非 high 零变。
          // 只加提示，不断言改拒（claim 照常放行，状态已流转 dev_doing）。
          let claimTip = '';
          try {
            if (highRiskTasks([r.task], cfg.sensitivePaths).length) {
              const rrClaim = resolveRun(cwd, { run: runId, queue: effQueue(), cfgRunId: rawRunId });
              const approved = readTimeline(rrClaim.runDir).some((row) => row && row.taskId === r.task.id && row.kind === 'approve');
              if (!approved) {
                claimTip = `\n⚠️ 高风险未批：${r.task.id} 尚未补批（已放行认领，不阻断）。主会话确认 diff 后补批：调工具 swarm_approve {task_id: "${r.task.id}"}`;
              }
            }
          } catch { claimTip = ''; }
          return { content: `已认领 ${r.task.id}\n验收：${r.task.acceptance}\n验证命令：${r.task.verify_cmd}${claimTip}` };
        },
      });

      editor.add({
        name: 'swarm_next',
        description: '取下一个可做任务（dev 轮询用）',
        input: { type: 'object', properties: { ...S }, additionalProperties: false },
        execute: async (input) => {
          const qp = input?.queue ? abs(cwd, input.queue) : queueFor(input?.run);
          const t = loadQueue(qp).find((x) => x.status === 'dev_doing');
          if (!t) return { content: '当前没有 dev_doing 任务。' };
          return { content: JSON.stringify(t, null, 2) };
        },
      });

      editor.add({
        name: 'swarm_done',
        description: 'dev 完成：先过门禁（真跑 verify_cmd + 校验 verdict/commit），再交给 test（summary 必填一句话总结；force_base 越过 base 竞态检查）',
        input: {
          type: 'object',
          properties: {
            task_id: { type: 'string' }, commit: { type: 'string' }, verdict_path: { type: 'string' },
            summary: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } },
            policy_exception: { type: 'boolean' }, force_base: { type: 'boolean' }, ...S,
          },
          required: ['task_id'],
          additionalProperties: false,
        },
        execute: async (input) => {
          const runId = sanitizeRunId(input?.run ?? currentRunId());
          const qIn = input?.queue ?? null;
          const qp = qIn ? abs(cwd, input.queue) : queueFor(runId);
          const task = loadQueue(qp).find((t) => t.id === input.task_id);
          if (!task) return { content: `任务不存在：${input.task_id}` };
          if (task.status !== 'dev_doing' && task.status !== 'gate_check') {
            return { content: `状态不对：${task.id} 是 ${task.status}，需为 dev_doing` };
          }
          // R1：summary 必填（缺失拒收 + 人话，不跑门禁）
          if (!input.summary || typeof input.summary !== 'string' || !input.summary.trim()) {
            return { content: '缺少 summary：done 需要一句话总结本次改动（例如"改了三处，回归通过"），补上 summary 再跑' };
          }

          // 步骤1：进门禁中间态（已在 gate_check 说明上次崩在门禁里，直接重进，不重复写行）。
          // R3：进门禁时记录 task.baseHEAD（当时 main/master 头；取不到记 null，不卡）。
          if (task.status === 'dev_doing') {
            const base = await baseHead(cwd, { gitBin: cfg.gitBin });
            const enter = await transition(runId, input.task_id, 'dev_doing', { status: 'gate_check', baseHEAD: base }, { by: input.as ?? 'dev', reason: 'gate-enter', queue: qIn });
            if (!enter.ok) return { content: `状态迁移失败：${enter.message}` };
          }

          const commit = input.commit ?? (await headCommit(cwd, cfg.gitBin)) ?? '';
          // R2：开关门禁只跑白名单交集（cfg.gates 为 true 才加对应命令；默认 6 门全跑，行为兼容）
          const gateNames = ['verify', 'verdict', 'policy', 'secret', 'diff', 'security'];
          if (cfg.gates?.lint) gateNames.push('lint');
          if (cfg.gates?.type) gateNames.push('type');
          if (cfg.gates?.tenant) gateNames.push('tenant');
          const gate = await checkGate({
            cwd,
            verify_cmd: task.verify_cmd,
            verdict_path: input.verdict_path ?? task.verdict_path,
            commit,
            timeoutMs: cfg.verifyTimeoutMs,
            allowlist: cfg.allowlist,
            paths: input.paths ?? task.paths ?? [],
            policy_exception: input.policy_exception ?? task.policy_exception ?? false,
            policyDeny: cfg.policyDeny,
            gitBin: cfg.gitBin,
            gates: gateNames,
            taskId: input.task_id,
            timelinePath: timelineFor(runId),
          });
          if (!gate.ok) {
            // 打回：gate_check→dev_doing（表内合法边），不计 retries，不唤醒 test；
            // 此前拒绝是静默的，这里补一条 [GATE-REJECT] 事件，timeline 里首次可见。
            const back = await transition(runId, input.task_id, 'gate_check', { status: 'dev_doing' }, { by: 'gate', reason: `gate-reject:${oneLine(gate.reason, 120)}`, queue: qIn });
            await emitFor(runId, input.as ?? 'dev', '[GATE-REJECT]', {
              task: input.task_id, reason: oneLine(gate.reason, 200), commit: commit || '-',
            });
            const backNote = back.ok ? '已打回 dev_doing' : `打回失败：${back.message}`;
            return {
              content: `❌ 门禁拒绝：${gate.reason}\n(${backNote}，retries 不变，未唤醒 test，先修复再重试)\n${gate.evidence?.stderr ? `\nstderr:\n${gate.evidence.stderr}` : ''}`,
            };
          }
          // R3：门禁通过后比对 base；前进则拒绝放行（回 dev_doing，reason 需 rebase 后重跑）。
          // input 加可选 force_base:true 显式越过（timeline reason 留 force-base 痕）。
          const forced = input.force_base === true;
          let baseWarn = '';
          if (!forced) {
            const fresh = loadQueue(qp).find((t) => t.id === input.task_id);
            const recorded = fresh?.baseHEAD ?? null;
            const nowBase = await baseHead(cwd, { gitBin: cfg.gitBin });
            if (recorded != null && nowBase != null && String(recorded) !== String(nowBase)) {
              const reason = `gate-reject:base-advanced ${recorded}→${nowBase}，rebase 后重跑`;
              const back = await transition(runId, input.task_id, 'gate_check', { status: 'dev_doing' }, { by: 'gate', reason, queue: qIn });
              await emitFor(runId, input.as ?? 'dev', '[GATE-REJECT]', {
                task: input.task_id, reason: oneLine(reason, 200), commit: commit || '-',
              });
              const backNote = back.ok ? '已打回 dev_doing' : `打回失败：${back.message}`;
              return { content: `❌ 门禁拒绝：${reason}\n(${backNote}，retries 不变，rebase 到最新 base 后重跑)` };
            }
            if (recorded == null || nowBase == null) {
              baseWarn = '\n⚠️ baseHEAD 取不到（非 git 仓或无 main/master），已放行';
            }
          }
          const r = await transition(runId, input.task_id, 'gate_check', {
            status: 'test_doing', assignee: 'test', commit,
            verdict_path: input.verdict_path ?? task.verdict_path,
            // R1：summary 必填（恒写入；经 diffPatch 进 timeline，rebuild 自然还原）
            summary: input.summary,
          }, { by: 'gate', reason: forced ? 'gate-pass:force-base' : 'gate-pass', queue: qIn });
          if (!r.ok) return { content: `状态迁移失败：${r.message}` };
          await emitFor(runId, input.as ?? 'dev', '[TASK-DONE]', {
            task: task.id, commit, verdict: input.verdict_path ?? task.verdict_path ?? '-',
            suite: 'pass', ms: String(gate.evidence?.durationMs ?? '-'),
          });
          const wake = await wakeRole('test', r.task, runId);
          const execWarns = Array.isArray(gate.evidence?.warnings) ? gate.evidence.warnings : [];
          const warnNote = execWarns.length ? `\n⚠️ verify warn（本次放行）：${execWarns.join('; ')}` : '';
          return { content: `✅ 门禁通过（${gate.evidence?.durationMs ?? '?'}ms）：状态已流转 gate_check→test_doing（已交 test）\ncommit=${commit}${warnNote}${baseWarn}` + wakeLine(wake, 'test', task.id) };
        },
      });

      editor.add({
        name: 'swarm_test',
        description: 'test 出结论：pass 进下一任务；fail 回 dev（≥maxRetries 自动 HALT，fail 必填 disposition）',
        input: {
          type: 'object',
          properties: {
            task_id: { type: 'string' }, pass: { type: 'boolean' },
            failed_ids: { type: 'string' }, detail: { type: 'string' },
            disposition: { type: 'string' }, ...S,
          },
          required: ['task_id', 'pass'],
          additionalProperties: false,
        },
        execute: async (input) => {
          const runId = sanitizeRunId(input?.run ?? currentRunId());
          const qp = input?.queue ? abs(cwd, input.queue) : queueFor(runId);
          const task = loadQueue(qp).find((t) => t.id === input.task_id);
          if (!task) return { content: `任务不存在：${input.task_id}` };
          if (task.status !== 'test_doing') return { content: `状态不对：${task.id} 是 ${task.status}，需为 test_doing` };

          if (input.pass) {
            // review 开的任务 test pass 后进 reviewing 待审（medium/high 默认进评审；显式 review=false 照直通 passed）
            if (task.review === true) {
              const r = await transition(runId, input.task_id, 'test_doing', { status: 'reviewing' }, { by: input.as ?? 'test', reason: 'test-pass待审', queue: input?.queue ?? null });
              if (!r.ok) return { content: `状态迁移失败：${r.message}` };
              await emitFor(runId, input.as ?? 'test', '[TEST-PASS]', { task: task.id, commit: task.commit ?? '-', review: 'pending' });
              let docHint = '（无 REVIEW.md，用通用口径）';
              try {
                const doc = resolveReviewDoc(cwd, r.task);
                if (doc) docHint = `REVIEW.md命中：${displayPath(cwd, doc.file)}`;
              } catch { /* 提示失败不影响主流程 */ }
              const excluded = excludedFindingIds(r.task);
              const depth = r.task.reviewDepth ?? 'quick';
              return {
                content: `✅ ${task.id} 测试通过 → reviewing待审（review=true，depth=${depth}）。请派 reviewer subagent：agent=swarm-reviewer，prompt=任务JSON + git show ${task.commit ?? 'HEAD'} diff(截断50KB) + ${docHint} + excluded=[${excluded.join(',') || '空'}]。reviewer 调 swarm_review 出结论（approve→passed / request-changes→dev_doing）。`,
              };
            }
            const r = await transition(runId, input.task_id, 'test_doing', { status: 'passed' }, { by: input.as ?? 'test', reason: 'test-pass', queue: input?.queue ?? null });
            if (!r.ok) return { content: `状态迁移失败：${r.message}` };
            await emitFor(runId, input.as ?? 'test', '[TEST-PASS]', { task: task.id, commit: task.commit ?? '-' });
            const next = await dispatchNext(runId);
            let doneNote = '';
            if (next.drained) {
              try { doneNote = await maybeNotifyDone(runId); } catch { doneNote = ''; }
            }
            return {
              content: next.dispatched
                ? `✅ ${task.id} 通过 → 已派发 ${next.dispatched.id}［状态已流转：queued→dev_doing］` + wakeLine(next.wake, 'dev', next.dispatched.id)
                : `✅ ${task.id} 通过 → ${next.drained ? '队列已清空' : `暂无可派发（${next.reason}）`}${doneNote}`,
            };
          }

          // R5：fail 必填 disposition 枚举（缺失/非法拒收；与 failed_ids/detail 同存 B2 字段）
          const dispRaw = typeof input.disposition === 'string' ? input.disposition.trim() : '';
          if (!dispRaw) {
            return { content: `缺少 disposition：fail 必须说明失败定性（fixed=修好了/wrong=用例错了/intentional=预期内/wontfix=不修），补上 disposition 再跑` };
          }
          if (!DISPOSITIONS.includes(dispRaw)) {
            return { content: `disposition 非法：${dispRaw}（expect ${DISPOSITIONS.join('/')})` };
          }
          const retries = (task.retries ?? 0) + 1;
          const overLimit = retries >= cfg.maxRetries;
          // B2：fail patch 追加 failed_ids/detail/disposition（detail 存全量；事件发送时仍截 500；经 diffPatch 进 timeline，rebuild 自然还原）
          const failPatch = {
            disposition: dispRaw,
            ...(input.failed_ids ? { failed_ids: input.failed_ids } : {}),
            ...(input.detail ? { detail: input.detail } : {}),
          };
          const r = await transition(runId, input.task_id, 'test_doing', overLimit
            ? { status: 'halted', retries, ...failPatch }
            : { status: 'dev_doing', assignee: 'dev', retries, ...failPatch },
            overLimit
              ? { by: input.as ?? 'test', reason: `halt:retries=${retries}`, queue: input?.queue ?? null }
              : { by: input.as ?? 'test', reason: 'test-fail', queue: input?.queue ?? null });
          if (!r.ok) return { content: `状态迁移失败：${r.message}` };

          if (overLimit) {
            await emitFor(runId, input.as ?? 'test', '[HALT]', { task: task.id, reason: `retries=${retries}` });
            // R6：HALT 追加重审建议 + 三轮 detail 摘要（timeline patch 取，500 截断；无则 (无记录)，不崩）
            let haltSummary = '(无记录)';
            try {
              const rr = resolveRun(cwd, { run: runId, cfgRunId: rawRunId });
              const details = lastFailDetails(rr.runDir, task.id, 3, 500);
              if (details.length) haltSummary = details.map((d, i) => `${i + 1}. ${oneLine(d, 500)}`).join('\n');
            } catch { /* 摘要失败不影响 HALT 主流程 */ }
            const failedIds = String(input.failed_ids ?? r.task?.failed_ids ?? '-');
            const failDetail = String(input.detail ?? r.task?.detail ?? '').slice(0, 200);
            await notifyHalt(runId, `⛔ HALT 通知 ${task.id}（wave=${r.task?.wave ?? task.wave ?? '-'}，retries=${retries}）：失败摘要 failed_ids=${failedIds} detail=${failDetail || '(无)'}\n恢复：/swarm-retry --task ${task.id}`);
            return { content: `⛔ ${task.id} 连续失败 ${retries} 次 → 已 HALT，等待人工 /swarm-retry\n建议重审方案而非继续修（已失败 ${retries} 轮，可能是方案/验收口径问题）\n最近三轮摘要：\n${haltSummary}` };
          }
          await emitFor(runId, input.as ?? 'test', '[TEST-FAIL]', {
            task: task.id, commit: task.commit ?? '-',
            failed: input.failed_ids ?? '-', detail: (input.detail ?? '-').slice(0, 500),
          });
          const wake = await wakeRole('dev', r.task, runId);
          return { content: `❌ ${task.id} 未过（第 ${retries}/${cfg.maxRetries} 次）：状态已流转 test_doing→dev_doing（回 dev）` + wakeLine(wake, 'dev', task.id) };
        },
      });

      editor.add({
        name: 'swarm_review',
        description: 'reviewer 出结论：approve 进 passed；request-changes 回 dev（≥2 次自动 HALT，finding 关闭须 fixed/wontfix+reason）',
        input: {
          type: 'object',
          properties: {
            task_id: { type: 'string' }, findings: { type: 'array', items: { type: 'object' } },
            verdict: { type: 'string' }, ...S,
          },
          required: ['task_id', 'verdict'],
          additionalProperties: false,
        },
        execute: async (input) => {
          const runId = sanitizeRunId(input?.run ?? currentRunId());
          const qp = input?.queue ? abs(cwd, input.queue) : queueFor(runId);
          const task = loadQueue(qp).find((t) => t.id === input.task_id);
          if (!task) return { content: `任务不存在：${input.task_id}` };
          if (task.status !== 'reviewing') return { content: `状态不对：${task.id} 是 ${task.status}，需为 reviewing` };
          const incoming = Array.isArray(input.findings) ? input.findings : [];
          const fv = validateFindings(incoming);
          if (!fv.ok) return { content: `findings 非法：${fv.reason}` };
          const vv = validateReviewVerdict(input.verdict, incoming);
          if (!vv.ok) return { content: `verdict 非法：${vv.reason}` };
          const merged = mergeFindings(task.findings ?? [], incoming);
          const thisRound = (task.reviewRounds ?? 0) + 1;
          const tlPath = timelineFor(runId);

          if (input.verdict === 'approve') {
            const r = await transition(runId, input.task_id, 'reviewing', { status: 'passed', findings: merged }, { by: input.as ?? 'reviewer', reason: 'review-approve', queue: input?.queue ?? null });
            if (!r.ok) return { content: `状态迁移失败：${r.message}` };
            try {
              appendTimeline(tlPath, {
                taskId: task.id, kind: 'review', from: 'reviewing', to: 'passed',
                by: input.as ?? 'reviewer', reason: `review-approve:round${thisRound}`,
                commit: r.task.commit, retries: r.task.retries,
                patch: { findings: incoming, reviewVerdict: 'approve', reviewRound: thisRound }, ts: r.task.updated_at,
              });
            } catch { /* timeline 双写 best-effort */ }
            await emitFor(runId, input.as ?? 'reviewer', '[REVIEW-APPROVE]', { task: task.id, commit: task.commit ?? '-', findings: String(incoming.length) });
            const next = await dispatchNext(runId);
            let doneNote = '';
            if (next.drained) {
              try { doneNote = await maybeNotifyDone(runId); } catch { doneNote = ''; }
            }
            return {
              content: next.dispatched
                ? `✅ ${task.id} 评审通过 → 已派发 ${next.dispatched.id}［状态已流转：queued→dev_doing］` + wakeLine(next.wake, 'dev', next.dispatched.id)
                : `✅ ${task.id} 评审通过 → ${next.drained ? '队列已清空' : `暂无可派发（${next.reason}）`}${doneNote}`,
            };
          }

          // request-changes：记 reviewRounds+1，≥2 则 HALT（复用 R6 HALT 文案）
          const openImp = incoming.filter((f) => f && f.severity === 'Important' && f.status === 'open');
          const failed_ids = openImp.map((f) => f.id).join(',');
          const first = openImp[0];
          const detail = first ? `${first.id} ${first.file ?? '-'}:${first.line ?? '-'} ${first.rule ?? ''} ${oneLine(first.evidence ?? '', 200)}`.trim() : 'reviewer 要求返工';
          const newRounds = (task.reviewRounds ?? 0) + 1;
          if (newRounds >= REVIEW_MAX_ROUNDS) {
            const r = await transition(runId, input.task_id, 'reviewing', { status: 'halted', findings: merged, reviewRounds: newRounds, failed_ids, detail }, { by: input.as ?? 'reviewer', reason: `halt:reviewRounds=${newRounds}`, queue: input?.queue ?? null });
            if (!r.ok) return { content: `状态迁移失败：${r.message}` };
            try {
              appendTimeline(tlPath, {
                taskId: task.id, kind: 'review', from: 'reviewing', to: 'halted',
                by: input.as ?? 'reviewer', reason: `review-halt:round${thisRound}`,
                commit: r.task.commit, retries: r.task.retries,
                patch: { findings: incoming, reviewVerdict: 'request-changes', reviewRound: thisRound, failed_ids, detail }, ts: r.task.updated_at,
              });
            } catch { /* best-effort */ }
            await emitFor(runId, input.as ?? 'reviewer', '[HALT]', { task: task.id, reason: `reviewRounds=${newRounds}` });
            let haltSummary = '(无记录)';
            try {
              const rr = resolveRun(cwd, { run: runId, cfgRunId: rawRunId });
              const details = lastFailDetails(rr.runDir, task.id, 3, 500);
              if (details.length) haltSummary = details.map((d, i) => `${i + 1}. ${oneLine(d, 500)}`).join('\n');
            } catch { /* 摘要失败不影响 HALT 主流程 */ }
            const retriesNow = r.task?.retries ?? task.retries ?? 0;
            const firstBrief = first ? `${first.id} ${first.file ?? '-'}:${first.line ?? '-'} ${first.rule ?? ''} ${String(first.evidence ?? '').slice(0, 200)}`.trim() : detail.slice(0, 200);
            await notifyHalt(runId, `⛔ HALT 通知 ${task.id}（wave=${r.task?.wave ?? task.wave ?? '-'}，retries=${retriesNow} reviewRounds=${newRounds}）：失败摘要 findings首条 ${firstBrief} failed_ids=${failed_ids || '-'}\n恢复：/swarm-retry --task ${task.id}`);
            return { content: `⛔ ${task.id} 评审打回 ${newRounds} 次 → 已 HALT，等待人工 /swarm-retry\n建议重审方案而非继续修（可能是方案/验收口径问题）\n最近三轮摘要：\n${haltSummary}` };
          }
          const r = await transition(runId, input.task_id, 'reviewing', { status: 'dev_doing', assignee: 'dev', findings: merged, reviewRounds: newRounds, failed_ids, detail }, { by: input.as ?? 'reviewer', reason: 'review-changes', queue: input?.queue ?? null });
          if (!r.ok) return { content: `状态迁移失败：${r.message}` };
          try {
            appendTimeline(tlPath, {
              taskId: task.id, kind: 'review', from: 'reviewing', to: 'dev_doing',
              by: input.as ?? 'reviewer', reason: `review-changes:round${thisRound}`,
              commit: r.task.commit, retries: r.task.retries,
              patch: { findings: incoming, reviewVerdict: 'request-changes', reviewRound: thisRound, failed_ids, detail }, ts: r.task.updated_at,
            });
          } catch { /* best-effort */ }
          await emitFor(runId, input.as ?? 'reviewer', '[REVIEW-CHANGES]', {
            task: task.id, commit: task.commit ?? '-',
            failed: failed_ids || '-', detail: detail.slice(0, 500),
          });
          const wake = await wakeRole('dev', r.task, runId);
          return { content: `❌ ${task.id} 评审打回（第 ${newRounds}/${REVIEW_MAX_ROUNDS} 次）：状态已流转 reviewing→dev_doing（回 dev）：${failed_ids}` + wakeLine(wake, 'dev', task.id) };
        },
      });

      editor.add({
        name: 'swarm_halt',
        description: '人工熔断某任务（与 /swarm-halt 同逻辑，共用 haltTask；HALT 推送照发）',
        input: {
          type: 'object',
          properties: { task_id: { type: 'string' }, reason: { type: 'string' }, run: { type: 'string' } },
          required: ['task_id'],
          additionalProperties: false,
        },
        execute: async (input) => {
          const runId = sanitizeRunId(input?.run ?? currentRunId());
          const id = String(input?.task_id ?? '').trim();
          const reason = input?.reason !== undefined ? String(input.reason) : 'manual';
          const r = await haltTask(runId, id, reason, 'human');
          if (r.ok) {
            await emitFor(runId, 'human', '[HALT]', { task: id, reason });
            const wave = r.task?.wave ?? '-';
            const retries = r.task?.retries ?? 0;
            await notifyHalt(runId, `⛔ HALT 通知 ${id}（wave=${wave}，retries=${retries}）：人工熔断 reason=${reason.slice(0, 200)}\n恢复：/swarm-retry --task ${id}`);
          }
          return { content: r.ok ? `已熔断 ${id}（run=${runId}）` : `熔断失败：${r.message}` };
        },
      });

      editor.add({
        name: 'swarm_revert',
        description: '把 halted/passed 任务回退到最后一次进门禁之前（与 /swarm-revert 同逻辑，共用 revertTask；kind=revert 行照写）',
        input: {
          type: 'object',
          properties: { task_id: { type: 'string' }, reason: { type: 'string' }, run: { type: 'string' } },
          required: ['task_id'],
          additionalProperties: false,
        },
        execute: async (input) => {
          const runId = sanitizeRunId(input?.run ?? currentRunId());
          const id = String(input?.task_id ?? '').trim();
          const r = await revertTask(runId, id, 'human', input?.reason ? String(input.reason) : '');
          if (!r.ok) return { content: r.message };
          await emitFor(runId, 'human', '[REVERT]', { task: id, from: r.from, to: 'dev_doing', commit: r.task.commit ?? '-' });
          const wake = await wakeRole('dev', r.task, runId);
          return { content: `状态已流转：${id} →dev_doing（已回退，commit 已回退到进门禁前${r.task.commit ? `：${r.task.commit}` : '（此前无 commit）'}，verdict 已清空）${wakeLine(wake, 'dev', id)}` };
        },
      });

      editor.add({
        name: 'swarm_approve',
        description: '高风险放行：high-risk 任务人工批准（写 kind=approve 审计行，幂等；非 high-risk 拒收并明说无需审批；approve 只解锁派发，不改状态）',
        input: {
          type: 'object',
          properties: { task_id: { type: 'string' }, ...S },
          required: ['task_id'],
          additionalProperties: false,
        },
        execute: async (input, toolCtx) => {
          const runId = sanitizeRunId(input?.run ?? currentRunId());
          const qp = input?.queue ? abs(cwd, input.queue) : queueFor(runId);
          const id = String(input?.task_id ?? '').trim();
          if (!id || id === 'true') return { content: '用法：swarm_approve {task_id: "<id>"}（仅 high-risk 任务可批）' };
          const task = loadQueue(qp).find((t) => t && t.id === id);
          if (!task) return { content: `任务不存在：${id}（无需审批）` };
          if (!highRiskTasks([task], cfg.sensitivePaths).length) {
            return { content: `❌ ${id} 非高风险任务（risk=${task.risk ?? 'medium'}），无需审批（approve 仅 high-risk 可用），直接按正常流程派发` };
          }
          if (task.status === 'passed') return { content: `${id} 已 passed，无需审批` };
          const tlPath = timelineFor(runId);
          let rows = [];
          try {
            const rr = resolveRun(cwd, { run: runId, queue: effQueue(), cfgRunId: rawRunId });
            rows = readTimeline(rr.runDir).filter((r) => r && r.taskId === id && r.kind === 'approve');
          } catch {
            rows = [];
          }
          if (rows.length) {
            const last = rows[rows.length - 1];
            return { content: `✅ 已批：${id} 已有批准记录（by=${last.by ?? '-'}，seq=${last.seq ?? '?'}），不重复写行` };
          }
          const by = input?.as ?? 'human';
          const sid = (toolCtx && (toolCtx.sessionID ?? toolCtx.sessionId)) ?? input?.sessionID ?? by;
          const risk = task.risk ?? 'high';
          appendTimeline(tlPath, {
            taskId: id, kind: 'approve', from: null, to: null,
            by, reason: `approve:risk=${risk}`,
            commit: task.commit ?? '-', retries: task.retries ?? 0,
            patch: { approved: true, risk, session: String(sid) }, ts: new Date().toISOString(),
          });
          return { content: `✅ 已批准 ${id}（risk=${risk}，by=${by}）：高风险放行，派发已解锁（approve 不改状态，当前 ${task.status}）` };
        },
      });

      editor.add({
        name: 'swarm_config',
        description: '只读：返回编排配置（执行器 + 角色模型 + 当前轮），供编排循环读模型映射；无副作用',
        input: {
          type: 'object',
          properties: { run: { type: 'string' } },
          required: [],
          additionalProperties: false,
        },
        execute: async (input) => {
          const c = readConfig(input?.run);
          return { content: JSON.stringify(c, null, 2) };
        },
      });
    });

    // ---------- 后台 sweep：FileBus 无 outbox，flushOutbox 恒返 0（保留空实现兼容） ----------
    const timer = setInterval(() => {
      for (const b of busCache.values()) void b.flushOutbox().catch(() => {});
    }, cfg.sweepMs);
    timer.unref?.();
    return () => clearInterval(timer);
  },
};
