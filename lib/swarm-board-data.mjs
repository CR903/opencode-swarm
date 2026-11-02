/**
 * swarm-board-data — Swarm TUI 大屏纯数据层（无 JSX，tsx 与单测共用）。
 *
 * 约束：纯读 + 永不抛错。坏行跳过，缺文件回空；无 console.*（TUI 进程不可见）。
 *
 *   readRunSnapshot(cwd, runId)
 *     -> { runId, runDir, tasks, timeline, events, round, meta, mtimeMs, ok }
 *   funnelCounts(tasks)         -> { queued, dev_doing, gate_check, test_doing, halted, passed, total }
 *   listRunSummaries(cwd)       -> [{ runId, name, counts, mtimeMs, level }]
 *     level: halted>0 -> 'halt'；有 live（dev_doing/test_doing/gate_check/reviewing 任一>0）-> 'active'；
 *     无 live 且 queued>0 -> 'queued'；否则 -> 'done'。坏 run 跳过不崩。
 *   sessionRunIndex(cwd)        -> { [sid]: { runId, role } }（纯读无缓存，多 run 合并）
 *   resolveFooterRun(sessionID, index, currentRunId)
 *     -> 命中索引回该 run；未命中/空回 currentRunId（全局行为保留）。
 *   sessionRows(snapshot, roleSessions?, nowMs?)
 *     -> [{ role, sid, taskId, enteredAt, elapsedMs, lastBeat }]
 *   healthJudgement(snapshot, nowMs?, idleMap?, opts?)
 *     -> [{ level:'done' }] | [{ level:'ok' }] | 若干 { level:'suspect'|'gate-long'|'halted', ... }
 *   formatElapsed(ms)           -> '45s' / '12m' / '3h' / '2d'
 *   approvalsByTask(timeline)
 *     -> { [taskId]: approveRow }（kind='approve' 行 presence，幂等下恒一条；后者覆盖前者）
 *   pendingApprovals(tasks, timeline)
 *     -> [taskId]（risk=high + 未 passed + 无 approve 行；纯算不存状态。
 *     注：snapshot 无 sensitivePaths 配置，paths 命中型高风险只在插件 status 行提示，板上只看 risk=high）
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sanitizeRunId, normalizeExecutor } from './swarm-run.js';

/** 队列六态（唯一真相见 lib/swarm-fsm.js STATUSES；reviewing 走 findings 面板，funnel 仍按六态计入 total）。 */
export const FUNNEL_STATUSES = ['queued', 'dev_doing', 'gate_check', 'test_doing', 'passed', 'halted'];

/** 默认阈值：suspect 10min（PRD ②，可传参覆盖）；gate-long 15min（PRD ③）。 */
export const DEFAULT_IDLE_MS = 600_000;
export const DEFAULT_GATE_MS = 900_000;

/** status -> 负责角色（round.sessions 的键；gate 无会话，归到 'gate' 名下展示；reviewing 归 reviewer）。 */
export const STATUS_ROLES = {
  queued: 'plan',
  dev_doing: 'dev',
  gate_check: 'gate',
  test_doing: 'test',
  reviewing: 'reviewer',
};

function readJsonLines(file) {
  try {
    const text = readFileSync(file, 'utf8');
    const rows = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const v = JSON.parse(line);
        if (v && typeof v === 'object') rows.push(v);
      } catch {
        // 坏行跳过，不抛错
      }
    }
    return rows;
  } catch {
    return [];
  }
}

function readJsonFile(file) {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

function mtimeOf(file) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function toMs(v) {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

/**
 * findings 合并（Board 纯读层，timeline 为准）：
 * queue 快照 findings 为底，timeline kind='review' 行 patch.findings 按序合上
 * （同 file+line+rule 后者覆盖前者，冲突留两条即不同 rule 各留）。永不抛错。
 */
export function findingsByTask(tasks, timeline) {
  try {
    const map = new Map();
    const keyOf = (f) => {
      try {
        return `${String(f?.file ?? '')}\0${String(f?.line ?? '')}\0${String(f?.rule ?? '')}`;
      } catch {
        return '';
      }
    };
    const putList = (taskId, list, override) => {
      if (!taskId || !Array.isArray(list)) return;
      let cur = map.get(taskId);
      if (!cur) {
        cur = [];
        map.set(taskId, cur);
      }
      if (!override) {
        for (const f of list) if (f && typeof f === 'object') cur.push(f);
        return;
      }
      const idx = new Map();
      cur.forEach((f, i) => {
        const k = keyOf(f);
        if (k && k !== '\0\0' && !idx.has(k)) idx.set(k, i);
      });
      for (const f of list) {
        if (!f || typeof f !== 'object') continue;
        const k = keyOf(f);
        if (!k || k === '\0\0') {
          cur.push(f);
          continue;
        }
        if (idx.has(k)) cur[idx.get(k)] = f;
        else {
          idx.set(k, cur.length);
          cur.push(f);
        }
      }
    };
    for (const t of Array.isArray(tasks) ? tasks : []) {
      if (t && typeof t === 'object' && t.id && Array.isArray(t.findings)) putList(t.id, t.findings, false);
    }
    const rows = Array.isArray(timeline) ? [...timeline].sort((a, b) => (a?.seq ?? 0) - (b?.seq ?? 0)) : [];
    for (const r of rows) {
      if (r && r.kind === 'review' && r.taskId && r.patch && Array.isArray(r.patch.findings)) {
        putList(r.taskId, r.patch.findings, true);
      }
    }
    return Object.fromEntries(map);
  } catch {
    return {};
  }
}

/**
 * 批准 presence（Board 待批色块依据，timeline 为准）：
 * kind='approve' 行按 taskId 收 presence（幂等下恒一条，后者覆盖前者记最新）。
 * rebuild 天然忽略（只处理 create/revert/move），与 kind='review' 同类。永不抛错。
 */
export function approvalsByTask(timeline) {
  try {
    const map = {};
    const rows = Array.isArray(timeline) ? [...timeline].sort((a, b) => (a?.seq ?? 0) - (b?.seq ?? 0)) : [];
    for (const r of rows) {
      if (r && r.kind === 'approve' && r.taskId) map[r.taskId] = r;
    }
    return map;
  } catch {
    return {};
  }
}

/**
 * 待批任务（status 一行 / board 一色块共用，纯算）：
 * task.risk==='high' + status!=='passed' + 无 approve 行 → 待批 id 列表。
 * 永不抛错。
 */
export function pendingApprovals(tasks, timeline) {
  try {
    const approved = approvalsByTask(timeline);
    const out = [];
    for (const t of Array.isArray(tasks) ? tasks : []) {
      if (!t || typeof t !== 'object' || !t.id) continue;
      if (t.status === 'passed') continue;
      if (t.risk !== 'high') continue;
      if (approved[t.id]) continue;
      out.push(t.id);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 执行器透出（board 会话区折叠依据）：
 * snapshot.meta?.executor 经 normalizeExecutor 归一（缺失/非法 -> 'hybrid'，永不抛错）。
 * tsx 侧以此判断 subagents（折叠会话区）vs hybrid（仅展示 dev/plan）vs 显式 sessions（老行为零变全展示）。
 */
export function executorOf(snapshot) {
  try {
    const meta = snapshot && typeof snapshot === 'object' ? snapshot.meta : null;
    const raw = meta && typeof meta === 'object' ? meta.executor : undefined;
    return normalizeExecutor(raw);
  } catch {
    return 'hybrid';
  }
}

/**
 * 读某 run 的全部快照。缺文件/坏行/坏 JSON 一律回空，永不抛错。
 * ok: 至少有一个源文件存在（调用方据此渲染 STALE/断源）。
 * mtimeMs: 各源文件最大 mtime（轮询指纹：不变则不 setSignal）。
 * findingsByTask: queue findings + timeline review 行合并（timeline 为准），Board findings 面板用。
 * meta: 原样透出 meta.json（含 executor；缺失为 null，归一走 executorOf）。
 */
export function readRunSnapshot(cwd, runId) {
  try {
    const id = sanitizeRunId(runId);
    const runDir = join(resolve(cwd), '.swarm', 'runs', id);
    const queueFile = join(runDir, 'queue.jsonl');
    const timelineFile = join(runDir, 'timeline.jsonl');
    const eventsFile = join(runDir, 'events.jsonl');
    const roundFile = join(runDir, 'round.json');
    const metaFile = join(runDir, 'meta.json');
    const tasks = readJsonLines(queueFile);
    const timeline = readJsonLines(timelineFile);
    const events = readJsonLines(eventsFile);
    const round = readJsonFile(roundFile);
    const meta = readJsonFile(metaFile);
    const mtimeMs = Math.max(
      mtimeOf(queueFile), mtimeOf(timelineFile), mtimeOf(eventsFile),
      mtimeOf(roundFile), mtimeOf(metaFile),
    );
    const ok = existsSync(queueFile) || existsSync(timelineFile)
      || existsSync(eventsFile) || existsSync(roundFile);
    let findings = {};
    try {
      findings = findingsByTask(tasks, timeline);
    } catch {
      findings = {};
    }
    let approvals = {};
    let pending = [];
    try {
      approvals = approvalsByTask(timeline);
      pending = pendingApprovals(tasks, timeline);
    } catch {
      approvals = {};
      pending = [];
    }
    return { runId: id, runDir, tasks, timeline, events, round, meta, mtimeMs, ok, findingsByTask: findings, approvalsByTask: approvals, pendingApprovals: pending };
  } catch {
    const id = (() => { try { return sanitizeRunId(runId); } catch { return 'default'; } })();
    return {
      runId: id, runDir: '', tasks: [], timeline: [], events: [],
      round: null, meta: null, mtimeMs: 0, ok: false, findingsByTask: {},
      approvalsByTask: {}, pendingApprovals: [],
    };
  }
}

/** 五态计数 + halted + passed（未知 status 不计入分桶，但计入 total）。 */
export function funnelCounts(tasks) {
  const out = {
    queued: 0, dev_doing: 0, gate_check: 0, test_doing: 0, halted: 0, passed: 0, total: 0,
  };
  try {
    for (const t of Array.isArray(tasks) ? tasks : []) {
      if (!t || typeof t !== 'object') continue;
      out.total += 1;
      const s = t.status;
      if (s === 'queued') out.queued += 1;
      else if (s === 'dev_doing') out.dev_doing += 1;
      else if (s === 'gate_check') out.gate_check += 1;
      else if (s === 'test_doing') out.test_doing += 1;
      else if (s === 'halted') out.halted += 1;
      else if (s === 'passed') out.passed += 1;
    }
  } catch { /* 永不抛错 */ }
  return out;
}

/**
 * 多轮摘要（sidebar 多轮列表 + footer 跨轮取数共用，纯读永不抛错）：
 * 扫 `<cwd>/.swarm/runs/` 下各轮目录（仅目录），每轮经 readRunSnapshot 取数
 * （坏行/坏 JSON 由其内部消化），`{ runId, name, counts, mtimeMs, level }`。
 * - name：round.name 优先，兜底 meta.name，再兜底 runId（空串亦兜底）。
 * - counts：funnelCounts 原样 + `reviewing` 计数（funnel 本无 reviewing 桶，
 *   sidebar 迷你 funnel 的 ◎ 与 level 活态判定用它；老键零变）。
 * - level：halted>0 -> 'halt'；dev_doing/test_doing/gate_check/reviewing 任一>0
 *   -> 'active'；无 live 且 queued>0 -> 'queued'；否则 -> 'done'。
 * - 坏 run（非目录/不可读/内部异常）跳过不崩；runs 根缺失回 []。
 * - 不排序（halt 优先 + mtime 新优先由 tsx 侧排，高亮只加标记不重排）。
 */
export function listRunSummaries(cwd) {
  try {
    const base = resolve(cwd);
    const root = join(base, '.swarm', 'runs');
    let entries = [];
    try {
      entries = readdirSync(root);
    } catch {
      return [];
    }
    const out = [];
    for (const name of entries) {
      try {
        if (typeof name !== 'string' || !name) continue;
        const dir = join(root, name);
        try {
          if (!statSync(dir).isDirectory()) continue;
        } catch {
          continue;
        }
        const snap = readRunSnapshot(base, name);
        const countsBase = funnelCounts(snap.tasks);
        let reviewing = 0;
        try {
          for (const t of Array.isArray(snap.tasks) ? snap.tasks : []) {
            if (t && typeof t === 'object' && t.status === 'reviewing') reviewing += 1;
          }
        } catch {
          reviewing = 0;
        }
        const counts = { ...countsBase, reviewing };
        let nm = snap.runId;
        try {
          // meta.name 是规范名（round 改名时同步写 meta）；round.name 仅兜底旧数据。
          // 旧实现 round 优先，一旦 round 被别轮改名污染，sidebar 就会两轮同名。
          const mn = snap.meta && typeof snap.meta === 'object' ? snap.meta.name : null;
          const rn = snap.round && typeof snap.round === 'object' ? snap.round.name : null;
          if (typeof mn === 'string' && mn.trim()) nm = mn;
          else if (typeof rn === 'string' && rn.trim()) nm = rn;
        } catch {
          nm = snap.runId;
        }
        let level = 'done';
        try {
          if (counts.halted > 0) level = 'halt';
          else if (counts.dev_doing > 0 || counts.test_doing > 0 || counts.gate_check > 0 || reviewing > 0) level = 'active';
          else if (counts.queued > 0) level = 'queued';
          else level = 'done';
        } catch {
          level = 'done';
        }
        out.push({
          runId: snap.runId, name: String(nm ?? snap.runId),
          counts, mtimeMs: snap.mtimeMs || 0, level,
        });
      } catch {
        continue;
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 会话 -> 轮索引（footer 跟随 + sidebar 高亮共用，纯读无缓存）：
 * 扫各 run `round.json` 的 sessions（`{ role: sid }`），倒排为 `{ [sid]: { runId, role } }`。
 * 多 run 含同 sid 时后者覆盖前者（sid 全局唯一为常态，覆盖仅保底确定性）；
 * round 缺失/坏 JSON/无 sessions 即跳过该轮。永不抛错。
 * （TUI 2s 轮询直调即够，5s 内存缓存可选未做：round.json 体积极小。）
 */
export function sessionRunIndex(cwd) {
  try {
    const base = resolve(cwd);
    const root = join(base, '.swarm', 'runs');
    let entries = [];
    try {
      entries = readdirSync(root);
    } catch {
      return {};
    }
    const out = {};
    for (const name of entries) {
      try {
        if (typeof name !== 'string' || !name) continue;
        const round = readJsonFile(join(root, name, 'round.json'));
        if (!round || typeof round !== 'object') continue;
        const sessions = round.sessions;
        if (!sessions || typeof sessions !== 'object') continue;
        for (const [role, sid] of Object.entries(sessions)) {
          if (typeof sid !== 'string' || !sid) continue;
          out[sid] = { runId: sanitizeRunId(name), role: String(role) };
        }
        // members：主会话 host / 子代理 / 任意调过 swarm 工具的会话（不参与改名/唤醒，只用于跟随）。
        const members = round.members;
        if (members && typeof members === 'object') {
          for (const [sid, info] of Object.entries(members)) {
            if (typeof sid !== 'string' || !sid) continue;
            const role = info && typeof info === 'object' && typeof info.role === 'string' ? info.role : 'member';
            out[sid] = { runId: sanitizeRunId(name), role };
          }
        }
      } catch {
        continue;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * footer 跟随解析（纯函数）：命中索引回该 run；未命中/空 sessionID 回 currentRunId
 * （全局行为保留，单轮文案零变）；currentRunId 空亦原样回（调用方走灰态/隐藏）。
 * 永不抛错。
 */
export function resolveFooterRun(sessionID, index, currentRunId) {
  try {
    if (typeof sessionID === 'string' && sessionID
      && index && typeof index === 'object') {
      const hit = index[sessionID];
      if (hit && typeof hit === 'object'
        && typeof hit.runId === 'string' && hit.runId) {
        return hit.runId;
      }
    }
    return currentRunId ?? null;
  } catch {
    try {
      return currentRunId ?? null;
    } catch {
      return null;
    }
  }
}

/** 任务进入当前 status 的时刻：timeline 最后一条 to===status 行的 ts，兜底 updated_at。 */
function taskEnteredAt(timeline, task) {
  try {
    const rows = Array.isArray(timeline) ? timeline : [];
    let ts = null;
    for (const r of rows) {
      if (r && r.taskId === task.id && r.to === task.status && r.ts != null) {
        const ms = toMs(r.ts);
        if (ms != null) ts = ms;
      }
    }
    if (ts != null) return ts;
    return toMs(task.updated_at);
  } catch {
    return null;
  }
}

function pickLatest(tasks) {
  let best = null;
  let bestMs = -1;
  for (const t of tasks) {
    const ms = toMs(t.updated_at) ?? -1;
    if (best == null || ms >= bestMs) { best = t; bestMs = ms; }
  }
  return best;
}

/**
 * 每角色一行。roleSessions 默认为 snapshot.round.sessions（{ role: sid }）。
 * taskId: 该角色当前手头任务（状态映射 dev_doing->dev 等；同角色多任务取 updated_at 最新）。
 * enteredAt: 任务进入当前状态时刻；elapsedMs: nowMs-enteredAt；lastBeat: events/timeline 中该角色最后动态。
 */
export function sessionRows(snapshot, roleSessions, nowMs = Date.now()) {
  try {
    const snap = snapshot && typeof snapshot === 'object' ? snapshot : {};
    const tasks = Array.isArray(snap.tasks) ? snap.tasks : [];
    const timeline = Array.isArray(snap.timeline) ? snap.timeline : [];
    const events = Array.isArray(snap.events) ? snap.events : [];
    const roles = (roleSessions && typeof roleSessions === 'object')
      ? roleSessions
      : (snap.round && typeof snap.round.sessions === 'object' ? snap.round.sessions : {});
    const out = [];
    for (const [role, sid] of Object.entries(roles)) {
      if (typeof sid !== 'string' || !sid) continue;
      let taskId = null;
      let enteredAt = null;
      const want = Object.entries(STATUS_ROLES).find(([, r]) => r === role)?.[0];
      if (want) {
        const cur = pickLatest(tasks.filter((t) => t && t.status === want));
        if (cur) {
          taskId = cur.id ?? null;
          enteredAt = taskEnteredAt(timeline, cur);
        }
      }
      let lastBeat = null;
      for (const e of events) {
        if (e && e.by === role) {
          const ms = toMs(e.ts);
          if (ms != null && (lastBeat == null || ms > lastBeat)) lastBeat = ms;
        }
      }
      for (const r of timeline) {
        if (r && r.by === role) {
          const ms = toMs(r.ts);
          if (ms != null && (lastBeat == null || ms > lastBeat)) lastBeat = ms;
        }
      }
      out.push({
        role, sid, taskId, enteredAt,
        elapsedMs: enteredAt != null ? Math.max(0, nowMs - enteredAt) : null,
        lastBeat,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function idleLookup(idleMap, keys) {
  try {
    if (!idleMap || typeof idleMap !== 'object') return null;
    for (const k of keys) {
      if (k == null) continue;
      const v = idleMap[k];
      const ms = toMs(v);
      if (ms != null) return ms;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 健康判据（按 PRD 四规则，顺序即优先级展示序）：
 *  ① 队列空（无任务）或全 passed -> [{ level:'done', ... }]（独占返回）
 *  ② 任务在 dev/test/gate 且对应会话 idle 超阈值（默认 10min，可传 opts.idleMs）-> suspect
 *     subagents 例外（PRD a STALE/suspect 复核，选方案A）：executor=subagents 时无 role 会话心跳，
 *     idleMap 查无可查，跳过 suspect（备选B“标注子代理心跳不可见”未采用，避免健康面板噪音）。
 *  ③ gate_check 停留超 15min（可传 opts.gateMs）-> gate-long（含 verify_cmd + 时长）
 *  ④ halted 非空 -> { level:'halted', taskIds } 单条聚合
 *  无问题 -> [{ level:'ok' }]
 * idleMap: { <sid|role|taskId>: lastActiveMs }，三键按序查找。
 */
export function healthJudgement(snapshot, nowMs = Date.now(), idleMap = {}, opts = {}) {
  try {
    const snap = snapshot && typeof snapshot === 'object' ? snapshot : {};
    const tasks = Array.isArray(snap.tasks) ? snap.tasks.filter((t) => t && typeof t === 'object') : [];
    const timeline = Array.isArray(snap.timeline) ? snap.timeline : [];
    const idleMs = opts && Number.isFinite(opts.idleMs) && opts.idleMs > 0 ? opts.idleMs : DEFAULT_IDLE_MS;
    const gateMs = opts && Number.isFinite(opts.gateMs) && opts.gateMs > 0 ? opts.gateMs : DEFAULT_GATE_MS;
    const isSub = executorOf(snap) === 'subagents';

    if (tasks.length === 0) return [{ level: 'done', passed: 0, total: 0, reason: 'empty' }];
    const passed = tasks.filter((t) => t.status === 'passed').length;
    if (passed === tasks.length) return [{ level: 'done', passed, total: tasks.length, reason: 'all-passed' }];

    const roleSessions = (snap.round && typeof snap.round.sessions === 'object' && snap.round.sessions) || {};
    const out = [];

    if (!isSub) {
      for (const t of tasks) {
        if (t.status !== 'dev_doing' && t.status !== 'test_doing' && t.status !== 'gate_check') continue;
        const role = STATUS_ROLES[t.status];
        const sid = roleSessions[role];
        const last = idleLookup(idleMap, [sid, role, t.id]);
        if (last != null && nowMs - last > idleMs) {
          out.push({
            level: 'suspect', taskId: t.id, role, sid: sid ?? null, idleMs: nowMs - last,
          });
        }
      }
    }

    for (const t of tasks) {
      if (t.status !== 'gate_check') continue;
      const entered = taskEnteredAt(timeline, t);
      if (entered != null && nowMs - entered > gateMs) {
        out.push({
          level: 'gate-long', taskId: t.id,
          verify_cmd: typeof t.verify_cmd === 'string' ? t.verify_cmd : '',
          stuckMs: nowMs - entered,
        });
      }
    }

    const haltedIds = tasks.filter((t) => t.status === 'halted').map((t) => t.id).filter(Boolean);
    if (haltedIds.length) out.push({ level: 'halted', taskIds: haltedIds });

    return out.length ? out : [{ level: 'ok' }];
  } catch {
    return [{ level: 'ok' }];
  }
}

/** 短格式时长：45s / 12m / 3h / 2d；非法输入回 '–'。 */
export function formatElapsed(ms) {
  try {
    if (!Number.isFinite(ms) || ms < 0) return '–';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
  } catch {
    return '–';
  }
}
