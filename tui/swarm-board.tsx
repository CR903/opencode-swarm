/** @jsxImportSource @opentui/solid */
/**
 * swarm-board — Swarm TUI 大屏（显示层，纯读）。
 *
 * - `sidebar.content` 窄卡（append）：run 名 + 新鲜度 + funnel 一行 + rounds-to-pass + 异常行。
 * - 整页 `swarm-board`（router.register + `/swarm-board` 进入）：会话表 + funnel + 任务明细 + 健康判据 + 事件尾 8。
 * - `prompt.footer.status` 一行：`swarm <run>: D<n> G<n> ✓<n>`。
 * - 数据轮询 2s + mtime 指纹（无变化不 setSignal）；digest 截断（事件尾 8、明细 50）。
 * - T3 键盘：board 页内 j/k 移动，Enter 跳会话，Backspace 返回，1/2/3 切区，w 波次过滤，? 帮助行。
 *
 * 约束：纯读（不调任何 swarm_* tool，不写队列/timeline）；无 console.*；
 * 路径以项目根为基准（data.location.default().directory，cwd 不可靠）。
 */
import { Plugin } from "@opencode/plugin/tui";
import { createSignal, For } from "solid-js";
import {
  readRunSnapshot,
  funnelCounts,
  listRunSummaries,
  sessionRunIndex,
  resolveFooterRun,
  sessionRows,
  healthJudgement,
  formatElapsed,
  executorOf,
  pendingApprovals,
  STATUS_ROLES,
} from "../lib/swarm-board-data.mjs";
import { readCurrentRunId, roundsToPass } from "../lib/swarm-run.js";

const POLL_MS = 2000;
const DETAIL_LIMIT = 50;
const EVENTS_TAIL = 8;

type Zone = "sessions" | "tasks" | "detail";

type Row =
  | { kind: "session"; zone: Zone; role: string; sid: string; taskId: string | null; elapsed: string }
  | { kind: "task"; zone: Zone; id: string; status: string; wave: string; title: string; sid: string | null }
  | { kind: "health"; zone: Zone; label: string; sid: string | null };

const STATUS_LABEL: Record<string, string> = {
  queued: "排队",
  dev_doing: "开发",
  gate_check: "门禁",
  test_doing: "测试",
  reviewing: "评审",
  passed: "通过",
  halted: "熔断",
};

const STATUS_ICON: Record<string, string> = {
  queued: "○",
  dev_doing: "●",
  gate_check: "◷",
  test_doing: "●",
  reviewing: "◎",
  passed: "✓",
  halted: "✗",
};

function statusText(status: string): string {
  const icon = STATUS_ICON[status] ?? "?";
  const label = STATUS_LABEL[status] ?? status;
  return `${icon} ${label}`;
}

type HealthEntry = {
  level: string;
  taskId?: string;
  idleMs?: number;
  stuckMs?: number;
  verify_cmd?: string;
  taskIds?: string[];
  passed?: number;
  total?: number;
};

type FindingItem = {
  id?: string;
  severity?: string;
  status?: string;
  file?: string;
  line?: string | number;
  rule?: string;
};

type TaskRef = { assignee?: unknown; status?: unknown; id?: unknown };

type RowLineProps = { row: Row; focused: boolean };

type WithId = { id?: string };

type RoundsToPass = { mean: number | null; count: number; values: number[] };

function toHealthEntries(v: unknown): HealthEntry[] {
  if (!Array.isArray(v)) return [];
  const out: HealthEntry[] = [];
  for (const e of v) {
    if (typeof e !== "object" || e === null || !("level" in e)) continue;
    const lv: unknown = e.level;
    if (typeof lv !== "string") continue;
    const item: HealthEntry = { level: lv };
    if ("taskId" in e && typeof e.taskId === "string") item.taskId = e.taskId;
    if ("idleMs" in e && typeof e.idleMs === "number") item.idleMs = e.idleMs;
    if ("stuckMs" in e && typeof e.stuckMs === "number") item.stuckMs = e.stuckMs;
    if ("verify_cmd" in e && typeof e.verify_cmd === "string") item.verify_cmd = e.verify_cmd;
    if ("taskIds" in e && Array.isArray(e.taskIds) && e.taskIds.every((x) => typeof x === "string")) item.taskIds = e.taskIds;
    if ("passed" in e && typeof e.passed === "number") item.passed = e.passed;
    if ("total" in e && typeof e.total === "number") item.total = e.total;
    out.push(item);
  }
  return out;
}

export default Plugin.define({
  id: "swarm-board",
  setup(ctx: Plugin.Context) {
    const rootOf = (): string => {
      try {
        const loc = ctx.data.location.default();
        if (loc && typeof loc.directory === "string" && loc.directory) return loc.directory;
      } catch { /* 兜底 cwd */ }
      try {
        const g: unknown = globalThis;
        if (typeof g === "object" && g !== null && "process" in g) {
          const p: unknown = g.process;
          if (typeof p === "object" && p !== null && "cwd" in p && typeof p.cwd === "function") {
            const r: unknown = p.cwd();
            if (typeof r === "string" && r) return r;
          }
        }
        return "/";
      } catch {
        return "/";
      }
    };

    // 空态：current 指针为空（被 /swarm-clean 清空）→ snap.runId 置 ''（灰字“暂无轮次”）；
    // run 目录缺文件 → readRunSnapshot ok=false（红 STALE 不变，真断源）。readRunSnapshot 本身不动。
    const emptySnap = () => ({
      runId: "", runDir: "", tasks: [], timeline: [], events: [],
      round: null, meta: null, mtimeMs: 0, ok: false, findingsByTask: {},
      approvalsByTask: {}, pendingApprovals: [],
    });
    const initialRun = (() => {
      try {
        return readCurrentRunId(rootOf());
      } catch {
        return "default";
      }
    })();
    const [snap, setSnap] = createSignal(initialRun == null ? emptySnap() : readRunSnapshot(rootOf(), initialRun));
    const [tick, setTick] = createSignal(Date.now());
    const [wave, setWave] = createSignal<string>("all");
    const [cursor, setCursor] = createSignal(0);
    const [lastSession, setLastSession] = createSignal<string | null>(null);
    const [isBoard, setIsBoard] = createSignal(false);
    // 多轮跟随（follow 任务）：sidebar 列表 + footer 跨轮取数 + ▶ 高亮。
    // 纯读派生：poll 内 2s 刷新；失败回空不崩（板上只读，永不抛错）。
    const [summaries, setSummaries] = createSignal<
      { runId: string; name: string; counts: Record<string, number>; mtimeMs: number; level: string }[]
    >([]);
    const [runIdx, setRunIdx] = createSignal<Record<string, { runId: string; role: string }>>({});
    const [currentSid, setCurrentSid] = createSignal<string | null>(null);

    const poll = () => {
      const root = rootOf();
      let cur: string | null = null;
      try {
        cur = readCurrentRunId(root);
      } catch {
        cur = null;
      }
      if (cur == null) {
        const prev = snap();
        if (prev.runId !== "") {
          setSnap(emptySnap());
          setCursor(0);
        }
      } else {
        const next = readRunSnapshot(root, cur);
        const prev = snap();
        if (next.runId !== prev.runId) {
          setSnap(next);
          setCursor(0);
        } else if (next.mtimeMs !== prev.mtimeMs || next.ok !== prev.ok) {
          setSnap(next);
          // clamp 规则（headless 可测纯逻辑）：cursor' = min(cursor, max(0, rows().length - 1))；
          // runId 不变 + mtime 变时不归零，仅 cursor 越界才拉回末尾。
          setCursor((c) => Math.min(c, Math.max(0, rows().length - 1)));
        }
      }
      setTick(Date.now());
      // 多轮摘要 + 会话索引：纯读，单轮时 SideCard/Footer 走老路（零变）。
      try {
        setSummaries(listRunSummaries(root));
      } catch {
        setSummaries([]);
      }
      try {
        setRunIdx(sessionRunIndex(root));
      } catch {
        setRunIdx({});
      }
      try {
        const cur = ctx.ui.router.current();
        setIsBoard(cur.type === "plugin" && cur.name === "swarm-board");
        // 高亮跟随当前路由会话；板页内（plugin 路由）保留上次会话，不清空。
        if (cur.type === "session" && cur.sessionID) setCurrentSid(cur.sessionID);
      } catch {
        setIsBoard(false);
      }
    };

    poll();
    const timer = setInterval(poll, POLL_MS);

    const funnel = () => funnelCounts(snap().tasks);
    const waves = () => {
      const seen: string[] = [];
      for (const t of snap().tasks) {
        if (t && typeof t.wave === "string" && t.wave && !seen.includes(t.wave)) seen.push(t.wave);
      }
      return seen.sort();
    };
    const filteredTasks = () => {
      const w = wave();
      const all = snap().tasks.filter((t) => t && typeof t === "object");
      const list = w === "all" ? all : all.filter((t) => t.wave === w);
      return list.slice(0, DETAIL_LIMIT);
    };
    const health = (): HealthEntry[] => {
      // 空轮（current 被清空）→ 无健康判据（避免空任务被判 done 误导）。
      if (snap().runId === "") return [];
      // idleMap 由会话行 lastBeat（events/timeline 中该角色最后动态）构造，
      // 使健康规则②（会话 idle 超阈值 -> suspect）在板上真实生效；
      // 无动态的会话不入 map（查不到即不报，避免开局误报）。
      // subagents 例外（PRD a，选隐藏方案）：无 role 会话心跳，idleMap 置空，
      // 双保险（数据层 healthJudgement 同样跳过 suspect，见 board-data 注释）。
      if (executor() === "subagents") {
        return toHealthEntries(healthJudgement(snap(), tick(), {}));
      }
      const idle: Record<string, number> = {};
      for (const r of sessionRows(snap(), roleSessions(), tick())) {
        if (r.lastBeat != null) idle[r.sid] = r.lastBeat;
      }
      return toHealthEntries(healthJudgement(snap(), tick(), idle));
    };
    const rtp = (): RoundsToPass => {
      try {
        return roundsToPass(snap().tasks, snap().timeline);
      } catch {
        const fallback: RoundsToPass = { mean: null, count: 0, values: [] };
        return fallback;
      }
    };
    const roleSessions = (): Record<string, string> => {
      const r = snap().round;
      if (r && typeof r.sessions === "object" && r.sessions) {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(r.sessions)) {
          if (typeof v === "string" && v) out[k] = v;
        }
        return out;
      }
      return {};
    };
    const executor = (): string => {
      try {
        return executorOf(snap());
      } catch {
        return "hybrid";
      }
    };
    const isSub = () => executor() === "subagents";
    const isHybrid = () => executor() === "hybrid";
    const taskSid = (t: TaskRef): string | null => {
      const rs = roleSessions();
      const byAssignee = typeof t.assignee === "string" ? rs[t.assignee] : undefined;
      if (byAssignee) return byAssignee;
      const hit = typeof t.status === "string"
        ? Object.entries(STATUS_ROLES).find(([k]) => k === t.status)
        : undefined;
      const role = hit && typeof hit[1] === "string" ? hit[1] : undefined;
      return (role && rs[role]) || null;
    };

    const rows = (): Row[] => {
      const out: Row[] = [];
      tick(); // 订阅轮询节拍：elapsed/freshness 随轮询刷新
      // subagents 折叠（PRD a，选隐藏方案）：会话区不渲染 role 会话行，
      // 避免把共享队列任务挂到毫不相干的会话名下（假信号）；STALE 断源行不受影响。
      // hybrid 只展示 dev 与 plan（test/reviewer 本无会话，不占区；显式 sessions 老行为零变全展示）。
      if (!isSub()) {
        const all = sessionRows(snap(), roleSessions(), Date.now());
        const list = isHybrid() ? all.filter((r) => r.role === "dev" || r.role === "plan") : all;
        for (const r of list) {
          out.push({
            kind: "session", zone: "sessions", role: r.role, sid: r.sid,
            taskId: r.taskId, elapsed: r.elapsedMs == null ? "–" : formatElapsed(r.elapsedMs),
          });
        }
      }
      for (const t of filteredTasks()) {
        out.push({
          kind: "task", zone: "tasks",
          id: String(t.id ?? "?"), status: String(t.status ?? "?"),
          wave: String(t.wave ?? "–"), title: String(t.title ?? "").slice(0, 60),
          sid: taskSid(t),
        });
      }
      for (const h of health()) {
        if (h.level === "suspect" || h.level === "gate-long") {
          const task = h.taskId == null
            ? undefined
            : snap().tasks.find((t) => t && t.id === h.taskId);
          out.push({
            kind: "health", zone: "detail",
            label: h.level === "suspect"
              ? `⚠ ${h.taskId} 静置 ${formatElapsed(h.idleMs ?? 0)}`
              : `◷ ${h.taskId} 门禁卡 ${formatElapsed(h.stuckMs ?? 0)}`,
            sid: task ? taskSid(task) : null,
          });
        }
      }
      return out;
    };

    const focusSession = (sid: string | null) => {
      if (!sid) return;
      try {
        if (!ctx.ui.tabs.focus(sid)) {
          ctx.ui.router.navigate({ type: "session", sessionID: sid });
        }
      } catch { /* 纯读大屏：跳转失败静默 */ }
    };

    const activateRow = (row: Row | undefined) => {
      if (!row) return;
      if (row.kind === "session") focusSession(row.sid);
      else if (row.kind === "task" || row.kind === "health") focusSession(row.sid);
    };

    const jumpZone = (zone: Zone) => {
      const list = rows();
      const i = list.findIndex((r) => r.zone === zone);
      if (i >= 0) setCursor(i);
    };

    const guard = () => {
      if (!isBoard()) return false;
      return true;
    };

    /**
     * 内键名桥接：SDK 命令用 `id`，宿主 keymap 派发/绑定按内部 `name` 索引
     *（缺 name 会注册成功但派发 "not-found"）。此处显式补 `name=id`。
     */
    const named = <C extends WithId>(list: C[]): (C & { name: string })[] =>
      list.map((c) => ({ ...c, name: String(c.id ?? "") }));

    /** 全局键（随 app 常驻挂载，唯一注册处；打开命令随处可用）。 */
    function GlobalKeys() {
      try {
        ctx.keymap.layer(() => ({
        mode: "global",
        commands: named([
          {
            id: "swarm-board.open",
            title: "Swarm board",
            description: "打开 Swarm TUI 大屏",
            group: "Swarm",
            palette: true,
            slash: { name: "swarm-board" },
            run: () => {
              try {
                const cur = ctx.ui.router.current();
                if (cur.type === "session") setLastSession(cur.sessionID);
              } catch { /* 忽略 */ }
              setCursor(0);
              ctx.ui.router.navigate({ type: "plugin", name: "swarm-board" });
            },
          },
        ]),
        }));
      } catch { /* 纯读大屏：layer 工厂校验失败静默，不打掉 slot 渲染 */ }
      return null;
    }

    /** 板内键（随 board 页挂载/卸载，只在板内生效；guard 保证板外放行）。 */
    function BoardKeys() {
      try {
        ctx.keymap.layer(() => ({
        mode: "global",
        commands: named([
          {
            id: "swarm-board.down",
            title: "下移",
            group: "Swarm",
            bind: "j",
            run: () => {
              if (!guard()) return false;
              setCursor((c) => Math.min(c + 1, Math.max(0, rows().length - 1)));
            },
          },
          {
            id: "swarm-board.up",
            title: "上移",
            group: "Swarm",
            bind: "k",
            run: () => {
              if (!guard()) return false;
              setCursor((c) => Math.max(c - 1, 0));
            },
          },
          {
            id: "swarm-board.enter",
            title: "跳入会话",
            group: "Swarm",
            bind: "enter",
            run: () => {
              if (!guard()) return false;
              activateRow(rows()[cursor()]);
            },
          },
          {
            id: "swarm-board.back",
            title: "返回",
            group: "Swarm",
            bind: "backspace",
            run: () => {
              if (!guard()) return false;
              const s = lastSession();
              if (s) ctx.ui.router.navigate({ type: "session", sessionID: s });
              else ctx.ui.router.navigate({ type: "home" });
            },
          },
          {
            id: "swarm-board.zone-sessions",
            title: "切会话区",
            group: "Swarm",
            bind: "1",
            run: () => {
              if (!guard()) return false;
              jumpZone("sessions");
            },
          },
          {
            id: "swarm-board.zone-tasks",
            title: "切任务区",
            group: "Swarm",
            bind: "2",
            run: () => {
              if (!guard()) return false;
              jumpZone("tasks");
            },
          },
          {
            id: "swarm-board.zone-detail",
            title: "切明细区",
            group: "Swarm",
            bind: "3",
            run: () => {
              if (!guard()) return false;
              jumpZone("detail");
            },
          },
          {
            id: "swarm-board.wave",
            title: "波次过滤",
            group: "Swarm",
            bind: "w",
            run: () => {
              if (!guard()) return false;
              const ws = waves();
              if (!ws.length) {
                setWave("all");
                return;
              }
              const cur = wave();
              if (cur === "all") {
                setWave(ws[0]);
              } else {
                const i = ws.indexOf(cur);
                setWave(i < 0 || i + 1 >= ws.length ? "all" : ws[i + 1]);
              }
              setCursor(0);
            },
          },
          {
            id: "swarm-board.help",
            title: "按键帮助",
            group: "Swarm",
            bind: "?",
            run: () => {
              if (!guard()) return false;
              ctx.ui.toast.show({
                message: "j/k移动 ⏎跳会话 Backspace返回 1/2/3切区 w波次过滤",
                variant: "info",
              });
            },
          },
        ]),
      }));
      } catch { /* 纯读大屏：layer 工厂校验失败静默，不打掉 slot 渲染 */ }
      return null;
    }

    const theme = () => ctx.theme;
    const isEmpty = () => snap().runId === "";
    const runName = () => {
      if (isEmpty()) return "暂无轮次";
      const r = snap().round;
      const name = r && typeof r.name === "string" && r.name ? r.name : snap().runId;
      return name;
    };
    const freshText = () => {
      const s = snap();
      if (isEmpty()) return "暂无轮次";
      if (!s.ok) return "STALE";
      return `${formatElapsed(Math.max(0, tick() - Math.max(s.mtimeMs, 1)))}前`;
    };
    const funnelText = () => {
      const f = funnel();
      const reviewing = (() => {
        try {
          return snap().tasks.filter((t) => t && typeof t === "object" && "status" in t && t.status === 'reviewing').length;
        } catch {
          return 0;
        }
      })();
      const halted = f.halted > 0 ? ` ✗${f.halted}` : "";
      const rev = reviewing > 0 ? ` ◎${reviewing}` : "";
      return `Q${f.queued} D${f.dev_doing} G${f.gate_check} T${f.test_doing}${rev} ✓${f.passed}${halted}`;
    };
    const firstIssue = () => health().find((h) => h.level !== "ok" && h.level !== "done" && h.level !== "halted") ?? null;
    // 待批（pending-approval，一色块）：snapshot 预聚合优先，缺失回退现算（纯读）。
    const pendingOf = (): string[] => {
      try {
        const s = snap() as unknown as { pendingApprovals?: unknown; tasks?: unknown; timeline?: unknown };
        if (Array.isArray(s.pendingApprovals)) return s.pendingApprovals.filter((x) => typeof x === "string");
        return pendingApprovals(
          (Array.isArray(s.tasks) ? s.tasks : []) as Parameters<typeof pendingApprovals>[0],
          (Array.isArray(s.timeline) ? s.timeline : []) as Parameters<typeof pendingApprovals>[1],
        );
      } catch {
        return [];
      }
    };
    const issueText = (h: HealthEntry): string => {
      if (h.level === "suspect") {
        return `⚠ ${h.taskId ?? "?"} 静置${formatElapsed(h.idleMs ?? 0)}`;
      }
      if (h.level === "gate-long") {
        return `◷ ${h.taskId ?? "?"} 门禁卡${formatElapsed(h.stuckMs ?? 0)}`;
      }
      if (h.level === "halted") {
        const ids = h.taskIds ?? [];
        return `✗ 熔断 ${ids.slice(0, 3).join(",")}${ids.length > 3 ? `+${ids.length - 3}` : ""}`;
      }
      return "";
    };

    const unregisterPage = ctx.ui.router.register({
      name: "swarm-board",
      render: () => <BoardView />,
    });

    const unregisterCard = ctx.ui.slot({
      append: "sidebar.content",
      render: () => <SideCard />,
    });

    const unregisterFooter = ctx.ui.slot({
      append: "prompt.footer.status",
      render: (input: any) => <FooterLine sessionID={input?.sessionID} />,
    });

    /** 多轮行排序：halt 优先，其次 mtime 新优先；高亮只加标记不重排（防跳动）。 */
    const rankOf = (level: string): number => (level === "halt" ? 0 : 1);
    const lampFor = (level: string): string =>
      level === "halt" ? "✗" : level === "active" ? "●" : level === "queued" ? "○" : "✓";
    const miniFunnel = (c: Record<string, number>): string => {
      const q = c.queued ?? 0;
      const d = c.dev_doing ?? 0;
      const g = c.gate_check ?? 0;
      const tt = c.test_doing ?? 0;
      const rev = c.reviewing ?? 0;
      const p = c.passed ?? 0;
      const h = c.halted ?? 0;
      return `Q${q} D${d} G${g} T${tt}${rev > 0 ? ` ◎${rev}` : ""} ✓${p}${h > 0 ? ` ✗${h}` : ""}`;
    };

    function SideCard() {
      const t = theme();
      if (isEmpty()) {
        return (
          <box flexDirection="column">
            <text fg={t.text.muted}>{"swarm 暂无轮次（/swarm-up 开新轮）"}</text>
          </box>
        );
      }
      const f = funnel();
      const r = rtp();
      const stale = () => !snap().ok;
      // 单轮零变：摘要 ≤1 轮时只渲染老卡片，不添多余行。
      const sums = () => {
        try {
          return summaries();
        } catch {
          return [];
        }
      };
      const highlightRunId = (): string | null => {
        try {
          const sid = currentSid();
          if (!sid) return null;
          const hit = runIdx()[sid];
          return hit && typeof hit.runId === "string" ? hit.runId : null;
        } catch {
          return null;
        }
      };
      const ongoing = () => {
        try {
          return [...sums()]
            .filter((s) => s && s.level !== "done")
            .sort((a, b) => {
              const ra = rankOf(a.level);
              const rb = rankOf(b.level);
              if (ra !== rb) return ra - rb;
              if ((b.mtimeMs ?? 0) !== (a.mtimeMs ?? 0)) return (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0);
              return a.runId < b.runId ? -1 : 1;
            });
        } catch {
          return [];
        }
      };
      const doneCount = () => {
        try {
          return sums().filter((s) => s && s.level === "done").length;
        } catch {
          return 0;
        }
      };
      const multi = () => sums().length > 1;
      return (
        <box flexDirection="column">
          <text fg={stale() ? t.text.feedback.error.base : t.text.base}>
            {`swarm ${runName()} · ${freshText()}`}
          </text>
          <text fg={t.text.muted}>{funnelText()}</text>
          {r.mean != null ? (
            <text fg={t.text.muted}>{`≈${r.mean.toFixed(1)}轮/过`}</text>
          ) : null}
          {(() => {
            const it = firstIssue();
            return it ? <text fg={t.text.feedback.warning.base}>{issueText(it)}</text> : null;
          })()}
          {f.halted > 0 ? (
            <text fg={t.text.feedback.error.base}>{`✗ 熔断 ${f.halted}（/swarm-board 看 halted）`}</text>
          ) : null}
          {multi() ? (
            <For each={ongoing()}>
              {(s) => {
                const cur = highlightRunId() === s.runId;
                return (
                  <text
                    fg={
                      cur
                        ? t.text.base
                        : s.level === "halt"
                          ? t.text.feedback.error.base
                          : t.text.muted
                    }
                  >
                    {`${cur ? "▶ " : ""}${lampFor(s.level)} ${s.name} ${miniFunnel(s.counts)}`}
                  </text>
                );
              }}
            </For>
          ) : null}
          {multi() && doneCount() > 0 ? (
            <text fg={t.text.muted}>{`${doneCount()} 轮已完成`}</text>
          ) : null}
        </box>
      );
    }

    function FooterLine(props: { sessionID?: string }) {
      if (isEmpty()) return null;
      // 跟随所在会话：命中索引只渲染该 run；未注册回退 current（现状）；current 空沿用隐藏。
      let target: string | null = null;
      try {
        target = resolveFooterRun(props.sessionID, runIdx(), snap().runId || null);
      } catch {
        target = snap().runId || null;
      }
      if (!target) return null;
      const t = theme();
      // 单轮零变：单摘要或命中当前轮时走老文案（`swarm <run>: D<n> G<n> ✓<n>` 不变）。
      let sums: { runId: string; counts: Record<string, number> }[] = [];
      try {
        sums = summaries();
      } catch {
        sums = [];
      }
      if (sums.length <= 1 || target === snap().runId) {
        if (!snap().ok && funnel().total === 0) return null;
        const f = funnel();
        return (
          <text fg={t.text.muted}>
            {`swarm ${snap().runId}: D${f.dev_doing} G${f.gate_check} ✓${f.passed}`}
          </text>
        );
      }
      const hit = sums.find((s) => s && s.runId === target);
      if (!hit) {
        if (!snap().ok && funnel().total === 0) return null;
        const f = funnel();
        return (
          <text fg={t.text.muted}>
            {`swarm ${snap().runId}: D${f.dev_doing} G${f.gate_check} ✓${f.passed}`}
          </text>
        );
      }
      const c = hit.counts ?? {};
      if ((c.total ?? 0) === 0) return null;
      return (
        <text fg={t.text.muted}>
          {`swarm ${hit.runId}: D${c.dev_doing ?? 0} G${c.gate_check ?? 0} ✓${c.passed ?? 0}`}
        </text>
      );
    }

    function RowLine(props: RowLineProps) {
      const t = theme();
      const bg = () => (props.focused ? t.background.action.primary.focused : undefined);
      const fg = () => {
        if (props.row.kind === "task") {
          const st = props.row.status;
          if (st === "halted") return t.text.feedback.error.base;
          if (st === "passed") return t.text.feedback.success.base;
          if (st === "gate_check" || st === "reviewing") return t.text.feedback.warning.base;
        }
        return props.focused ? t.text.action.primary.focused : t.text.base;
      };
      const body = () => {
        const r = props.row;
        if (r.kind === "session") {
          return `${r.role} ${r.taskId ?? "–"} ${r.elapsed} ⏎跳会话`;
        }
        if (r.kind === "task") {
          return `${statusText(r.status)} ${r.id} ${r.wave} ${r.title} ⏎找会话`;
        }
        return `${r.label} ⏎找会话`;
      };
      return (
        <box backgroundColor={bg()}>
          <text fg={fg()}>{`${props.focused ? "▸" : " "} ${body()}`}</text>
        </box>
      );
    }

    function BoardView() {
      const t = theme();
      const s = snap();
      const list = () => rows();
      const f = funnel();
      const h = health();
      const evts = () => snap().events.slice(-EVENTS_TAIL).reverse();
      // Reviewer-N1 findings 面板（纯读）：按任务渲染 chip + open/关闭态 + must-answer 计数
      const findingsEntries = () => {
        try {
          const fb: unknown = (s && typeof s === "object" && s !== null && "findingsByTask" in s) ? s.findingsByTask : {};
          if (typeof fb !== "object" || fb === null) return [];
          return Object.entries(fb).filter(([, v]) => Array.isArray(v) && v.length > 0);
        } catch {
          return [];
        }
      };
      const findingChip = (x: FindingItem) => {
        if (x.severity === 'Important') return '●Important';
        if (x.severity === 'Pre-existing') return '◇Pre-existing';
        return '○Nit';
      };
      return (
        <>
          <BoardKeys />
          <box flexDirection="column">
          {isEmpty() ? (
            <text fg={t.text.muted}>
              {"swarm-board · 暂无轮次（/swarm-up 开新轮）· Backspace 返回"}
            </text>
          ) : (
            <>
              <text fg={s.ok ? t.text.base : t.text.feedback.error.base}>
                {`swarm-board · ${runName()} (${s.runId}) · ${freshText()}`}
              </text>
              {!s.ok ? (
                <text fg={t.text.feedback.error.base}>
                  {"STALE · 断源：检查 .swarm/runs/<run>（改名/删除会触发）· Backspace 返回"}
                </text>
              ) : null}
            </>
          )}
          <text fg={t.text.muted}>
            {`funnel Q${f.queued}→D${f.dev_doing}→G${f.gate_check}→T${f.test_doing}→◎${(() => { try { return snap().tasks.filter((x) => x && typeof x === "object" && "status" in x && x.status === 'reviewing').length; } catch { return 0; } })()}→✓${f.passed} ✗${f.halted} · 波次 ${wave()}（w切）`}
          </text>
          {(() => {
            const p = pendingOf();
            return p.length ? (
              <text fg={t.text.feedback.warning.base}>
                {`⏳ 待批 ${p.join(",")}（主会话 swarm_approve 放行）`}
              </text>
            ) : null;
          })()}
          <text fg={t.text.muted}>{"[L1 会话] 1切 · j/k移 · ⏎跳会话（tabs.open/focus）"}</text>
          {isSub() ? (
            <text fg={t.text.muted}>{"子代理派发中（无 role 会话，心跳不可见）· 会话区已折叠"}</text>
          ) : (
            <>
              {isHybrid() ? (
                <text fg={t.text.muted}>{"hybrid：dev常驻+test子代理 · 会话区仅展示 dev/plan"}</text>
              ) : null}
              <For each={list().filter((r) => r.zone === "sessions")}>
                {(r) => <RowLine row={r} focused={list().indexOf(r) === cursor()} />}
              </For>
            </>
          )}
          <text fg={t.text.muted}>{"[L2 任务] 2切 · w波次过滤 · ⏎找 assignee 会话"}</text>
          <For each={list().filter((r) => r.zone === "tasks")}>
            {(r) => <RowLine row={r} focused={list().indexOf(r) === cursor()} />}
          </For>
          <text fg={t.text.muted}>{"[Findings 评审] 只读 · Important红/Nit灰/Pre-existing斜体 + open/关闭态"}</text>
          <For each={findingsEntries()}>
            {([taskId, vs]) => {
              const rawList: unknown = vs;
              const arr: FindingItem[] = Array.isArray(rawList)
                ? rawList.filter((x) => typeof x === "object" && x !== null)
                : [];
              const must = arr.filter((x) => x.severity === 'Important' && x.status === 'open').length;
              return (
                <text fg={must > 0 ? t.text.feedback.error.base : t.text.muted}>
                  {`${taskId} must=${must} ` + arr.slice(0, 6).map((x) => `${findingChip(x)}${x.status === 'open' ? '' : `/${x.status}`} ${String(x.id ?? '?')}`).join(' ')}
                </text>
              );
            }}
          </For>
          <text fg={t.text.muted}>{"[明细 健康/事件] 3切 · 只读：动作指回命令（/swarm-*）"}</text>
          <For each={h}>
            {(e) => (
              <text
                fg={
                  e.level === "ok" || e.level === "done"
                    ? t.text.feedback.success.base
                    : e.level === "halted"
                      ? t.text.feedback.error.base
                      : t.text.feedback.warning.base
                }
              >
                {healthLine(e)}
              </text>
            )}
          </For>
          <For each={evts()}>
            {(e) => (
              <text fg={t.text.faint}>{`${String(e.ts ?? "").slice(11, 19)} ${String(e.by ?? "?")} ${String(e.text ?? "").slice(0, 80)}`}</text>
            )}
          </For>
          <text fg={t.text.faint}>{"j/k移动 ⏎跳会话 Backspace返回 1/2/3切区 w波次 ?帮助（本行即帮助）"}</text>
          </box>
        </>
      );
    }

    function healthLine(e: HealthEntry): string {
      if (e.level === "done") {
        return `✓ done（${e.passed ?? 0}/${e.total ?? 0} passed）`;
      }
      if (e.level === "ok") return "○ 正常";
      return issueText(e);
    }

    const unregisterApp = ctx.ui.slot({
      append: "app",
      render: () => <GlobalKeys />,
    });

    return () => {
      clearInterval(timer);
      unregisterPage();
      unregisterCard();
      unregisterFooter();
      unregisterApp();
    };
  },
});
