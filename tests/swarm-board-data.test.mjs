/**
 * swarm-board-data 回归测试（node --test）
 *
 *   node --test .opencode/lib/swarm-board-data.test.mjs
 *
 * 覆盖 PRD T1 验收：
 *   1. readRunSnapshot：坏行/缺文件/空 run 不崩
 *   2. funnelCounts：六态计数对
 *   3. healthJudgement：四规则各 1 例（含阈值边界）
 *   4. formatElapsed：短格式
 *   5. sessionRows：角色行映射
 *
 * 全部在临时目录内跑，不碰真实仓库。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readRunSnapshot, funnelCounts, sessionRows, healthJudgement, formatElapsed,
  findingsByTask, executorOf, approvalsByTask, pendingApprovals,
  listRunSummaries, sessionRunIndex, resolveFooterRun,
} from '../lib/swarm-board-data.mjs';

let dir;

const runDir = (id) => join(dir, '.swarm', 'runs', id);
const putRun = (id, files) => {
  mkdirSync(runDir(id), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(runDir(id), name), content, 'utf8');
  }
};

const T0 = Date.parse('2026-10-29T10:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

const task = (over = {}) => ({
  id: 'W1-T1', wave: 'W1', title: 't', acceptance: 'a',
  verify_cmd: 'make test', testing: '同 verify_cmd',
  status: 'queued', assignee: 'dev', updated_at: iso(T0), ...over,
});

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'swarm-board-test-'));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readRunSnapshot', () => {
  test('缺文件 run：回空且不抛错', () => {
    const s = readRunSnapshot(dir, 'no-such-run');
    assert.equal(s.ok, false);
    assert.deepEqual(s.tasks, []);
    assert.deepEqual(s.timeline, []);
    assert.deepEqual(s.events, []);
    assert.equal(s.round, null);
    assert.equal(s.mtimeMs, 0);
  });

  test('坏行跳过、坏 JSON 回空', () => {
    putRun('badrun', {
      'queue.jsonl': `${JSON.stringify(task())}\n{not json\n\n${JSON.stringify(task({ id: 'W1-T2' }))}\n`,
      'round.json': '{broken',
      'timeline.jsonl': 'xxx\n',
      'events.jsonl': '',
    });
    const s = readRunSnapshot(dir, 'badrun');
    assert.equal(s.tasks.length, 2);
    assert.deepEqual(s.tasks.map((t) => t.id), ['W1-T1', 'W1-T2']);
    assert.equal(s.round, null);
    assert.deepEqual(s.timeline, []);
    assert.equal(s.ok, true);
  });

  test('空 run（目录存在但无文件）：不崩', () => {
    mkdirSync(runDir('emptyrun'), { recursive: true });
    const s = readRunSnapshot(dir, 'emptyrun');
    assert.equal(s.ok, false);
    assert.deepEqual(s.tasks, []);
  });

  test('runId 非法字符被归一（防路径穿越）', () => {
    const s = readRunSnapshot(dir, '../escape');
    assert.equal(s.runId, 'escape');
    assert.equal(s.ok, false);
  });
});

describe('funnelCounts', () => {
  test('六态计数对，未知状态只计 total', () => {
    const tasks = [
      task({ id: 'a', status: 'queued' }),
      task({ id: 'b', status: 'dev_doing' }),
      task({ id: 'c', status: 'gate_check' }),
      task({ id: 'd', status: 'test_doing' }),
      task({ id: 'e', status: 'halted' }),
      task({ id: 'f', status: 'passed' }),
      task({ id: 'g', status: 'weird' }),
    ];
    assert.deepEqual(funnelCounts(tasks), {
      queued: 1, dev_doing: 1, gate_check: 1, test_doing: 1,
      halted: 1, passed: 1, total: 7,
    });
  });

  test('空/非法输入回零', () => {
    assert.equal(funnelCounts([]).total, 0);
    assert.equal(funnelCounts(null).total, 0);
    assert.equal(funnelCounts('x').total, 0);
  });
});

describe('healthJudgement', () => {
  // suspect 规则是 sessions 语义（role 会话心跳）：显式 sessions meta 锁定回退通道；
  // 缺失/非法 meta 归一 subagents（无 suspect），由 executor 专测覆盖。
  const snapOf = (tasks, extra = {}) => ({
    runId: 'r', runDir: '', tasks, timeline: [], events: [],
    round: { sessions: { dev: 'ses_dev', test: 'ses_test' } },
    meta: { executor: 'sessions' }, mtimeMs: 1, ok: true, ...extra,
  });

  test('规则①：全 passed -> done（独占）', () => {
    const out = healthJudgement(snapOf([task({ status: 'passed' }), task({ id: 'W1-T2', status: 'passed' })]), T0);
    assert.deepEqual(out, [{ level: 'done', passed: 2, total: 2, reason: 'all-passed' }]);
  });

  test('规则①：空队列 -> done', () => {
    assert.deepEqual(healthJudgement(snapOf([]), T0)[0].level, 'done');
  });

  test('规则②：dev 会话 idle 超 10min -> suspect；阈值边界（==10min）不报', () => {
    const tasks = [task({ status: 'dev_doing', updated_at: iso(T0 - 11 * 60_000) })];
    const over = healthJudgement(snapOf(tasks), T0, { ses_dev: T0 - 11 * 60_000 });
    assert.equal(over.length, 1);
    assert.equal(over[0].level, 'suspect');
    assert.equal(over[0].taskId, 'W1-T1');
    assert.equal(over[0].idleMs, 11 * 60_000);

    const edge = healthJudgement(snapOf(tasks), T0, { ses_dev: T0 - 600_000 });
    assert.deepEqual(edge, [{ level: 'ok' }]);
  });

  test('规则②：可传参阈值', () => {
    const tasks = [task({ status: 'test_doing' })];
    const out = healthJudgement(snapOf(tasks), T0, { ses_test: T0 - 61_000 }, { idleMs: 60_000 });
    assert.equal(out[0].level, 'suspect');
  });

  test('规则③：gate 停留超 15min -> gate-long（含 verify_cmd）；边界不报', () => {
    const mk = (ago) => snapOf(
      [task({ id: 'G1', status: 'gate_check', verify_cmd: 'make gate', updated_at: iso(T0 - ago) })],
      {
        timeline: [
          { seq: 1, taskId: 'G1', kind: 'move', to: 'gate_check', ts: iso(T0 - ago) },
        ],
      },
    );
    const over = healthJudgement(mk(16 * 60_000), T0);
    assert.equal(over[0].level, 'gate-long');
    assert.equal(over[0].taskId, 'G1');
    assert.equal(over[0].verify_cmd, 'make gate');
    assert.equal(over[0].stuckMs, 16 * 60_000);

    const edge = healthJudgement(mk(15 * 60_000), T0);
    assert.deepEqual(edge, [{ level: 'ok' }]);
  });

  test('规则④：halted 非空 -> halted 列表', () => {
    const out = healthJudgement(snapOf([
      task({ id: 'H1', status: 'halted' }),
      task({ id: 'H2', status: 'halted' }),
      task({ id: 'W1-T3', status: 'dev_doing' }),
    ]), T0, { ses_dev: T0 });
    assert.equal(out.length, 1);
    assert.equal(out[0].level, 'halted');
    assert.deepEqual(out[0].taskIds, ['H1', 'H2']);
  });

  test('无问题 -> ok', () => {
    const out = healthJudgement(snapOf([task({ status: 'dev_doing' })]), T0, { ses_dev: T0 });
    assert.deepEqual(out, [{ level: 'ok' }]);
  });
});

describe('sessionRows', () => {
  test('角色行：taskId/enteredAt/elapsedMs/lastBeat', () => {
    const snap = {
      runId: 'r', runDir: '', mtimeMs: 1, ok: true, meta: null,
      tasks: [
        task({ id: 'D1', status: 'dev_doing', updated_at: iso(T0 - 5 * 60_000) }),
        task({ id: 'T1', status: 'test_doing', updated_at: iso(T0 - 60_000) }),
      ],
      timeline: [
        { seq: 1, taskId: 'D1', kind: 'move', to: 'dev_doing', ts: iso(T0 - 5 * 60_000), by: 'dev' },
      ],
      events: [{ seq: 1, by: 'dev', ts: iso(T0 - 60_000), text: 'x' }],
      round: { sessions: { plan: 'ses_plan', dev: 'ses_dev', test: 'ses_test' } },
    };
    const rows = sessionRows(snap, undefined, T0);
    assert.equal(rows.length, 3);
    const dev = rows.find((r) => r.role === 'dev');
    assert.equal(dev.sid, 'ses_dev');
    assert.equal(dev.taskId, 'D1');
    assert.equal(dev.enteredAt, T0 - 5 * 60_000);
    assert.equal(dev.elapsedMs, 5 * 60_000);
    assert.equal(dev.lastBeat, T0 - 60_000);
    const testRow = rows.find((r) => r.role === 'test');
    assert.equal(testRow.taskId, 'T1');
  });
});

describe('formatElapsed', () => {
  test('短格式', () => {
    assert.equal(formatElapsed(45_000), '45s');
    assert.equal(formatElapsed(12 * 60_000), '12m');
    assert.equal(formatElapsed(3 * 3600_000), '3h');
    assert.equal(formatElapsed(2 * 86400_000), '2d');
  });

  test('非法输入回 –', () => {
    assert.equal(formatElapsed(null), '–');
    assert.equal(formatElapsed(NaN), '–');
    assert.equal(formatElapsed(-1), '–');
  });
});

describe('reviewer-N1 findings 面板（纯读）', () => {
  const f = (over = {}) => ({
    id: 'F1', severity: 'Important', file: 'a.ts', line: 1, rule: 'r',
    evidence: 'e', suggestion: 's', status: 'open', ...over,
  });

  test('findingsByTask：queue 为底，timeline review 行覆盖（timeline 为准）', () => {
    const tasks = [{ ...task(), id: 'W1-T1', findings: [f({ id: 'F1', status: 'open' })] }];
    const timeline = [
      { seq: 1, taskId: 'W1-T1', kind: 'review', patch: { findings: [f({ id: 'F1', status: 'fixed' })] } },
      { seq: 2, taskId: 'W1-T1', kind: 'review', patch: { findings: [f({ id: 'F2', file: 'b.ts' })] } },
    ];
    const out = findingsByTask(tasks, timeline);
    assert.equal(out['W1-T1'].find((x) => x.id === 'F1').status, 'fixed', 'timeline 后者覆盖 queue');
    assert.ok(out['W1-T1'].some((x) => x.id === 'F2'), 'timeline 新增合并');
  });

  test('readRunSnapshot 带 findingsByTask（含关闭态），坏行不崩', () => {
    putRun('findrun', {
      'queue.jsonl': `${JSON.stringify({ ...task({ id: 'FR-1' }), findings: [f({ id: 'F1', status: 'wontfix', reason: '存量' })] })}\n`,
      'timeline.jsonl': `${JSON.stringify({ seq: 1, taskId: 'FR-1', kind: 'review', patch: { findings: [f({ id: 'F1', status: 'wontfix', reason: '存量' })] } })}\n`,
    });
    const s = readRunSnapshot(dir, 'findrun');
    assert.ok(s.findingsByTask['FR-1'], '应有 findings');
    assert.equal(s.findingsByTask['FR-1'][0].status, 'wontfix');
    assert.equal(s.ok, true);
  });

  test('must-answer 计数 = open Important 数（含关闭态区分）', () => {
    const list = [f({ id: 'A' }), f({ id: 'B', status: 'fixed' }), f({ id: 'C', severity: 'Nit' })];
    assert.equal(list.filter((x) => x.severity === 'Important' && x.status === 'open').length, 1);
  });
});

describe('高风险软卡 approve presence（10-30-swarm-approve-softcard）', () => {
  const apRow = (seq, id) => ({
    seq, taskId: id, kind: 'approve', from: null, to: null,
    by: 'human', reason: 'approve:risk=high',
  });

  test('approvalsByTask：presence 收敛（后者覆盖前者），非 approve 行忽略', () => {
    const tl = [
      apRow(1, 'H1'),
      { seq: 2, taskId: 'H1', kind: 'move', to: 'dev_doing' },
      apRow(3, 'H2'),
    ];
    const out = approvalsByTask(tl);
    assert.deepEqual(Object.keys(out).sort(), ['H1', 'H2']);
    assert.equal(out.H1.seq, 1);
    assert.equal(out.H2.by, 'human');
  });

  test('pendingApprovals：high + 未 passed + 无批 → 待批；passed/已批/非 high 排除', () => {
    const tasks = [
      task({ id: 'P1', status: 'queued', risk: 'high' }),
      task({ id: 'P2', status: 'dev_doing', risk: 'high' }),
      task({ id: 'P3', status: 'queued', risk: 'high' }),
      task({ id: 'P4', status: 'passed', risk: 'high' }),
      task({ id: 'P5', status: 'queued', risk: 'medium' }),
    ];
    const tl = [apRow(1, 'P3')];
    assert.deepEqual(pendingApprovals(tasks, tl), ['P1', 'P2']);
  });

  test('readRunSnapshot 带 approvalsByTask + pendingApprovals，坏输入不崩', () => {
    putRun('apprun', {
      'queue.jsonl': `${JSON.stringify(task({ id: 'Q1', status: 'queued', risk: 'high' }))}\n`,
      'timeline.jsonl': `${JSON.stringify({ seq: 1, taskId: 'Q1', kind: 'approve', by: 'human', reason: 'approve:risk=high' })}\n`,
    });
    const s = readRunSnapshot(dir, 'apprun');
    assert.deepEqual(s.pendingApprovals, []);
    assert.ok(s.approvalsByTask.Q1, '已批 presence 应在快照');
    assert.deepEqual(pendingApprovals(null, null), []);
    assert.deepEqual(approvalsByTask(null), {});
  });
});

describe('executor 透出 + subagents suspect 复核（PRD a，hybrid 缺省）', () => {
  const snapOfExec = (executor, tasks, idle) => ({
    runId: 'r', runDir: '', tasks, timeline: [], events: [],
    round: { sessions: { dev: 'ses_dev', test: 'ses_test' } },
    meta: executor === undefined ? null : { executor }, mtimeMs: 1, ok: true,
    _idle: idle,
  });

  test('executorOf：缺失/非法归一 hybrid，显式整轮透过零变', () => {
    assert.equal(executorOf(null), 'hybrid');
    assert.equal(executorOf({}), 'hybrid');
    assert.equal(executorOf({ meta: null }), 'hybrid');
    assert.equal(executorOf({ meta: {} }), 'hybrid');
    assert.equal(executorOf({ meta: { executor: 'bogus' } }), 'hybrid');
    assert.equal(executorOf({ meta: { executor: 'sessions' } }), 'sessions');
    assert.equal(executorOf({ meta: { executor: 'subagents' } }), 'subagents');
    assert.equal(executorOf({ meta: { executor: 'hybrid' } }), 'hybrid');
  });

  test('readRunSnapshot 透出 meta.executor（落盘即读回）', () => {
    putRun('execrun', {
      'queue.jsonl': `${JSON.stringify(task({ id: 'E-1' }))}\n`,
      'meta.json': JSON.stringify({ runId: 'execrun', executor: 'hybrid' }),
    });
    const s = readRunSnapshot(dir, 'execrun');
    assert.equal(s.meta.executor, 'hybrid');
    assert.equal(executorOf(s), 'hybrid');
  });

  test('subagents 下无心跳不判 suspect（选方案A，无误报；显式整轮零变）', () => {
    const tasks = [task({ status: 'dev_doing', updated_at: iso(T0 - 11 * 60_000) })];
    const snap = snapOfExec('subagents', tasks);
    // 即使 idle 超阈值（11min），subagents 也不报 suspect
    const out = healthJudgement(snap, T0, { ses_dev: T0 - 11 * 60_000 });
    assert.deepEqual(out, [{ level: 'ok' }]);
    assert.ok(!out.some((h) => h.level === 'suspect'), 'subagents 不得有 suspect');
  });

  test('sessions 下同条件仍判 suspect（零变对照）', () => {
    const tasks = [task({ status: 'dev_doing', updated_at: iso(T0 - 11 * 60_000) })];
    const snap = snapOfExec('sessions', tasks);
    const out = healthJudgement(snap, T0, { ses_dev: T0 - 11 * 60_000 });
    assert.equal(out[0].level, 'suspect');
  });

  test('hybrid 下 dev 常驻仍判 suspect（与 sessions 同口径，test 无心跳不误报）', () => {
    const tasks = [task({ status: 'dev_doing', updated_at: iso(T0 - 11 * 60_000) })];
    const snap = snapOfExec('hybrid', tasks);
    const out = healthJudgement(snap, T0, { ses_dev: T0 - 11 * 60_000 });
    assert.equal(out[0].level, 'suspect', 'hybrid dev 常驻应判 suspect');
    const snapMissing = snapOfExec(undefined, tasks);
    assert.equal(executorOf(snapMissing), 'hybrid', '缺 meta 归一 hybrid');
    const outMissing = healthJudgement(snapMissing, T0, { ses_dev: T0 - 11 * 60_000 });
    assert.equal(outMissing[0].level, 'suspect', '缺省 hybrid 同 sessions 口径');
  });
});

describe('listRunSummaries：level 四态', () => {
  const ql = (tasks) => tasks.map((t) => JSON.stringify(t)).join('\n') + '\n';

  test('halt / active / queued / done 四态 + reviewing 视作 live', () => {
    putRun('follow-halt', {
      'queue.jsonl': ql([task({ id: 'H1', status: 'halted' }), task({ id: 'Q1', status: 'queued' })]),
      'round.json': JSON.stringify({ name: 'halt 轮', sessions: {} }),
    });
    putRun('follow-active', {
      'queue.jsonl': ql([task({ id: 'D1', status: 'dev_doing' }), task({ id: 'Q2', status: 'queued' })]),
      'round.json': JSON.stringify({ name: 'active 轮', sessions: {} }),
    });
    putRun('follow-reviewing', {
      'queue.jsonl': ql([task({ id: 'R1', status: 'reviewing' })]),
      'round.json': JSON.stringify({ name: '评审轮', sessions: {} }),
    });
    putRun('follow-queued', {
      'queue.jsonl': ql([task({ id: 'Q3', status: 'queued' })]),
      'round.json': JSON.stringify({ name: '排队轮', sessions: {} }),
    });
    putRun('follow-done', {
      'queue.jsonl': ql([task({ id: 'P1', status: 'passed' })]),
      'round.json': JSON.stringify({ name: '完工轮', sessions: {} }),
    });
    const sums = listRunSummaries(dir);
    const byId = Object.fromEntries(sums.map((s) => [s.runId, s]));
    assert.equal(byId['follow-halt'].level, 'halt');
    assert.equal(byId['follow-active'].level, 'active');
    assert.equal(byId['follow-reviewing'].level, 'active', 'reviewing 计 live');
    assert.equal(byId['follow-queued'].level, 'queued');
    assert.equal(byId['follow-done'].level, 'done');
    assert.equal(byId['follow-halt'].name, 'halt 轮');
    assert.equal(byId['follow-reviewing'].counts.reviewing, 1);
    assert.ok(byId['follow-active'].mtimeMs > 0, 'mtimeMs 应有值');
  });

  test('坏 run 不崩：非目录条目跳过', () => {
    writeFileSync(join(dir, '.swarm', 'runs', 'not-a-dir'), 'x', 'utf8');
    let sums;
    assert.doesNotThrow(() => { sums = listRunSummaries(dir); });
    assert.ok(Array.isArray(sums));
    assert.ok(!sums.some((s) => s.runId === 'not-a-dir'), '文件条目不得入摘要');
  });
});

describe('sessionRunIndex：多 run 合并', () => {
  test('两轮 sid 合并为索引，role/runId 对', () => {
    putRun('follow-idx-a', {
      'round.json': JSON.stringify({ name: 'A', sessions: { dev: 'ses_follow_dev', plan: 'ses_follow_plan' } }),
    });
    putRun('follow-idx-b', {
      'round.json': JSON.stringify({ name: 'B', sessions: { test: 'ses_follow_test' } }),
    });
    const idx = sessionRunIndex(dir);
    assert.deepEqual(idx['ses_follow_dev'], { runId: 'follow-idx-a', role: 'dev' });
    assert.deepEqual(idx['ses_follow_plan'], { runId: 'follow-idx-a', role: 'plan' });
    assert.deepEqual(idx['ses_follow_test'], { runId: 'follow-idx-b', role: 'test' });
  });

  test('members（主会话/子代理）也进索引 —— footer 才能跟随', () => {
    putRun('follow-idx-m', {
      'round.json': JSON.stringify({ name: 'M', sessions: { plan: 'ses_m_plan' }, members: { ses_m_host: { role: 'host' }, ses_m_sub: { role: 'dev' } } }),
    });
    const idx = sessionRunIndex(dir);
    assert.deepEqual(idx['ses_m_host'], { runId: 'follow-idx-m', role: 'host' });
    assert.deepEqual(idx['ses_m_sub'], { runId: 'follow-idx-m', role: 'dev' }, '子代理也能反查到所属轮');
    assert.equal(resolveFooterRun('ses_m_sub', idx, 'other-run'), 'follow-idx-m', 'footer 命中子代理即跟随，不落 current');
  });

  test('缺 round 的轮跳过不崩', () => {
    mkdirSync(runDir('follow-idx-empty'), { recursive: true });
    let idx;
    assert.doesNotThrow(() => { idx = sessionRunIndex(dir); });
    assert.ok(idx['ses_follow_dev'], '已有索引不受空轮影响');
  });
});

describe('listRunSummaries：名字口径（meta 优先，防两轮同名）', () => {
  test('meta.name 与 round.name 漂移时以 meta 为准；缺 meta 才回 round', () => {
    putRun('name-meta', {
      'queue.jsonl': JSON.stringify(task()) + '\n',
      'meta.json': JSON.stringify({ runId: 'name-meta', name: '按瓶借用毛重' }),
      'round.json': JSON.stringify({ name: '移动端待入库（被污染）', sessions: {} }),
    });
    putRun('name-round', {
      'queue.jsonl': JSON.stringify(task()) + '\n',
      'round.json': JSON.stringify({ name: '只有 round 名', sessions: {} }),
    });
    const byId = Object.fromEntries(listRunSummaries(dir).map((s) => [s.runId, s]));
    assert.equal(byId['name-meta'].name, '按瓶借用毛重', 'meta 是规范名，round 漂移不覆盖');
    assert.equal(byId['name-round'].name, '只有 round 名', '缺 meta 兜底 round');
  });
});

describe('resolveFooterRun：三路', () => {
  const index = {
    ses_dev_a: { runId: 'run-a', role: 'dev' },
    ses_test_b: { runId: 'run-b', role: 'test' },
  };

  test('命中索引回该 run（dev 会话只看其 run）', () => {
    assert.equal(resolveFooterRun('ses_dev_a', index, 'run-b'), 'run-a');
    assert.equal(resolveFooterRun('ses_test_b', index, 'run-a'), 'run-b');
  });

  test('未注册会话 fallback current（现状保留）', () => {
    assert.equal(resolveFooterRun('ses_unknown', index, 'run-a'), 'run-a');
  });

  test('空 sessionID 回 current；current 空原样回', () => {
    assert.equal(resolveFooterRun(null, index, 'run-a'), 'run-a');
    assert.equal(resolveFooterRun('', index, 'run-a'), 'run-a');
    assert.equal(resolveFooterRun('ses_dev_a', index, null), 'run-a', '命中时 current 空亦回命中');
    assert.equal(resolveFooterRun('ses_unknown', index, null), null);
  });
});
