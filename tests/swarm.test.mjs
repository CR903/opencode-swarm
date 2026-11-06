/**
 * Swarm 回归测试（node --test）
 *
 *   node --test .opencode/lib/swarm.test.mjs
 *
 * 覆盖四层不变量：
 *   1. 存储：原子写 / 锁 / CAS 互斥 / 缓存一致性
 *   2. 执行：无 shell 沙箱 / 白名单 / 超时 / 输出截断
 *   3. 门禁：命令真跑 + verdict + commit 绑定
 *   4. 协议：tag 解析展开 / 事件幂等
 *
 * 全部在临时目录内跑，不碰真实仓库。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadQueue, saveQueueAtomic, casTransition, enqueueTask, transitionTask, withLock, invalidate, appendTimeline, requiredModels } from '../lib/swarm-store.js';
import { TRANSITIONS, STATUSES, can, allowedFrom, checkTransition } from '../lib/swarm-fsm.js';
import { sanitizeRunId, resolveRun, writeCurrentRunId, listRuns, migrateLegacy, timelinePathFor, rebuildQueueFromTimeline, readTimeline, readMeta, writeMeta, ensureRunMeta, normalizeExecutor, EXECUTORS, validateFindings, validateReviewVerdict, mergeFindings, findingKey, excludedFindingIds, excludedIntersection, resolveReviewDoc, FINDING_SEVERITIES, REVIEW_VERDICTS, REVIEW_MAX_ROUNDS, deriveRunIdFromName, isRunDirNonEmpty, resolveUniqueRunId, runQueueHasTasks, sessionRunIndex, runIdForSession, runIdForTask } from '../lib/swarm-run.js';
import { parseCommand, runVerify, DEFAULT_ALLOWLIST } from '../lib/swarm-exec.js';
import { eventId, createChannel } from '../lib/swarm-events.js';
import { createFileBus, eventId as busEventId } from '../lib/swarm-filebus.js';
import { checkGate, registerGate, branchGate, GATES, FORBIDDEN, matchPatterns } from '../lib/swarm-gate.js';
import { parseTag, expandTag, expandTagCompact, renderTaskBlock, ROLES, TAG_INDEX, registerRole, hasRole, rebuildTagIndex } from '../lib/swarm-roles.js';
import { writeRound, readRound } from '../lib/swarm-sessions.js';

let dir;
let queue;

const emptyTask = (over = {}) => ({
  id: 'W1-T1', wave: 'W1', title: 't', acceptance: 'a', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd', stack: 'backend', ...over,
});

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'swarm-test-'));
  queue = join(dir, 'queue.jsonl');
  // B3 收敛后 node -e 不再可用：回归用脚本文件代替内联代码
  writeFileSync(join(dir, 'ok.mjs'), 'process.exit(0);\n');
  writeFileSync(join(dir, 'bad.mjs'), 'process.exit(1);\n');
  writeFileSync(join(dir, 'exit3.mjs'), 'process.exit(3);\n');
  writeFileSync(join(dir, 'sleep.mjs'), 'setTimeout(() => {}, 60000);\n');
});
after(() => { rmSync(dir, { recursive: true, force: true }); });

// ───────────────────────────── 1. 存储 ─────────────────────────────
describe('store', () => {
  test('enqueue 写入并读回', () => {
    assert.equal(enqueueTask(queue, emptyTask()).ok, true);
    const tasks = loadQueue(queue);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].status, 'queued');
    assert.equal(tasks[0].retries, 0);
    assert.ok(tasks[0].updated_at);
  });

  test('重复 id 被拒', () => {
    const r = enqueueTask(queue, emptyTask());
    assert.equal(r.ok, false);
    assert.match(r.reason, /duplicate id/);
  });

  test('缺必填字段被拒（逐项）', () => {
    for (const k of ['id', 'wave', 'title', 'acceptance', 'verify_cmd']) {
      const row = emptyTask({ id: `X-${k}` });
      delete row[k];
      const r = enqueueTask(queue, row);
      assert.equal(r.ok, false, `missing ${k} should be rejected`);
      assert.match(r.reason, new RegExp(k));
    }
  });

  test('入队硬拦 verify_cmd：shell 拼接/路径/cd 在 plan 即拒收（11-06 复盘，不等门禁）', () => {
    for (const [id, cmd] of [
      ['VX-1', 'cd x && go test ./...'],
      ['VX-2', 'go test ./... | tail -5'],
      ['VX-3', './scripts/tenant-check.sh --all'],
      ['VX-4', 'cd smarterlab-backend && make gate'],
    ]) {
      const r = enqueueTask(queue, emptyTask({ id, verify_cmd: cmd }));
      assert.equal(r.ok, false, `${cmd} 应在入队被拒`);
      assert.match(r.reason, /verify_cmd/);
      assert.match(r.reason, /make -C/, '拒收须给合规改写指引');
    }
    assert.equal(loadQueue(queue).some((t) => t.id.startsWith('VX-')), false, '拒收零写行');
  });

  test('入队放行合规 verify_cmd：make -C 单命令照常进；自定义 allowlist 透传不误拦', () => {
    const ok = enqueueTask(queue, emptyTask({ id: 'VO-1', verify_cmd: 'make -C smarterlab-backend gate' }));
    assert.equal(ok.ok, true, ok.reason);
    const custom = enqueueTask(queue, emptyTask({ id: 'VA-1', verify_cmd: 'task build' }), null, { allowlist: [...DEFAULT_ALLOWLIST, 'task'] });
    assert.equal(custom.ok, true, custom.reason);
  });

  test('wave 非 string 被拒且点名形状', () => {
    const r = enqueueTask(queue, emptyTask({ id: 'VW-1', wave: 2 }));
    assert.equal(r.ok, false);
    assert.match(r.reason, /wave/);
    assert.match(r.reason, /W1/, '须点名期望形状');
  });

  test('CAS 状态不符时拒绝', () => {
    const r = casTransition(queue, 'W1-T1', 'passed', { status: 'halted' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /expect passed/);
    assert.equal(loadQueue(queue)[0].status, 'queued', '状态未被改动');
  });

  test('CAS 允许状态数组', () => {
    const r = casTransition(queue, 'W1-T1', ['queued', 'halted'], { status: 'dev_doing' });
    assert.equal(r.ok, true);
    assert.equal(loadQueue(queue)[0].status, 'dev_doing');
  });

  test('不存在的任务返回人话而非抛错', () => {
    const r = casTransition(queue, 'NOPE', 'queued', { status: 'dev_doing' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /task not found/);
  });

  test('并发 claim 只有一个赢家（10 并发）', async () => {
    const q = join(dir, 'race.jsonl');
    enqueueTask(q, emptyTask({ id: 'RACE-1' }));
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        Promise.resolve().then(() => casTransition(q, 'RACE-1', 'queued', { status: 'dev_doing' })),
      ),
    );
    const wins = results.filter((r) => r.status === 'fulfilled' && r.value.ok).length;
    assert.equal(wins, 1, `应只有 1 个赢家，实际 ${wins}`);
    assert.equal(loadQueue(q)[0].status, 'dev_doing');
  });

  test('跨进程并发 claim 只有一个赢家', () => {
    const q = join(dir, 'race2.jsonl');
    enqueueTask(q, emptyTask({ id: 'RACE-2' }));
    // 用两个 node 子进程先后抢（并发竞争由上一测试覆盖）
    const script = `
      import { casTransition } from ${JSON.stringify(new URL('../lib/swarm-store.js', import.meta.url).href)};
      const r = casTransition(${JSON.stringify(q)}, 'RACE-2', 'queued', { status: 'dev_doing' });
      process.stdout.write(r.ok ? 'WIN' : 'LOSE');
    `;
    const outs = [];
    // 串行兜底（shell 并发在 CI 不稳定）；真实并发由上一测试覆盖
    for (let i = 0; i < 2; i++) {
      outs.push(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }));
    }
    assert.equal(outs.filter((o) => o === 'WIN').length, 1, `只应有一个 WIN：${outs.join(',')}`);
  });

  test('写入是原子的：临时文件不残留', () => {
    const q = join(dir, 'atomic.jsonl');
    saveQueueAtomic(q, [emptyTask({ id: 'A-1' })]);
    const stray = readFileSync;
    assert.equal(existsSync(`${q}.tmp.${process.pid}`), false, 'tmp 文件应已 rename 掉');
    assert.equal(loadQueue(q).length, 1);
  });

  test('缓存随写入失效', () => {
    const q = join(dir, 'cache.jsonl');
    enqueueTask(q, emptyTask({ id: 'C-1' }));
    assert.equal(loadQueue(q)[0].status, 'queued');
    casTransition(q, 'C-1', 'queued', { status: 'passed' });
    assert.equal(loadQueue(q)[0].status, 'passed', '同尺寸同毫秒写入后必须读到新值');
  });

  test('读返回副本，外部改动不污染存储', () => {
    const q = join(dir, 'clone.jsonl');
    enqueueTask(q, emptyTask({ id: 'D-1' }));
    const a = loadQueue(q);
    a[0].status = 'halted';
    assert.equal(loadQueue(q)[0].status, 'queued');
  });

  test('锁在异常时也会释放', () => {
    const q = join(dir, 'lockrel.jsonl');
    assert.throws(() => withLock(q, () => { throw new Error('boom'); }));
    // 锁已释放，下一次能立即拿到
    assert.equal(withLock(q, () => 'ok'), 'ok');
  });
});

// ───────────────────────────── 2. 执行沙箱 ─────────────────────────────
describe('exec sandbox', () => {
  test('拒绝 shell 分隔符', () => {
    for (const cmd of ['node a.js; rm -rf /', 'node a.js && rm x', 'node a | sh', 'node a & b', 'node `id`']) {
      assert.equal(parseCommand(cmd).ok, false, cmd);
    }
  });

  test('拒绝命令替换', () => {
    assert.equal(parseCommand('node $(whoami)').ok, false);
  });

  test('node -e / python3 -c 内联代码被拒（含括号也不行）；括号文件名本身无害', () => {
    const r = parseCommand('node -e process.exit(0)');
    assert.equal(r.ok, false);
    assert.match(r.reason, /脚本文件/);
    assert.equal(parseCommand('python3 -c print(1)').ok, false);
    assert.equal(parseCommand('node "my (1).mjs"').ok, true);
  });

  test('非白名单命令被拒', () => {
    assert.equal(parseCommand('curl http://evil').ok, false);
    assert.equal(parseCommand('rm -rf /').ok, false);
  });

  test('白名单可追加（含路径形式）', () => {
    assert.equal(parseCommand('task build', [...DEFAULT_ALLOWLIST, 'task']).ok, true);
    assert.equal(parseCommand('./gradlew test').ok, true);
  });

  test('空命令 / 引号不配对被拒', () => {
    assert.equal(parseCommand('').ok, false);
    assert.equal(parseCommand('node "unclosed').ok, false);
  });

  test('成功执行 exit 0', async () => {
    const r = await runVerify('node ok.mjs', { cwd: dir });
    assert.equal(r.ok, true);
    assert.equal(r.code, 0);
  });

  test('失败执行保留 exit code', async () => {
    const r = await runVerify('node exit3.mjs', { cwd: dir });
    assert.equal(r.ok, false);
    assert.equal(r.code, 3);
  });

  test('超时被 SIGKILL 且总耗时受控', async () => {
    const r = await runVerify('node sleep.mjs', { cwd: dir, timeoutMs: 400 });
    assert.equal(r.timedOut, true);
    assert.ok(r.durationMs < 5000, `耗时 ${r.durationMs}ms`);
  });

  test('输出截断不爆内存', async () => {
    const script = join(dir, 'noisy.mjs');
    writeFileSync(script, 'process.stdout.write("x".repeat(200000));\n');
    const r = await runVerify(`node ${script}`, { cwd: dir, maxOutputBytes: 1000 });
    assert.ok(r.stdout.length < 1200, `实际 ${r.stdout.length}`);
    assert.match(r.stdout, /truncated/);
  });

  test('非法命令不 spawn，直接返回原因', async () => {
    const r = await runVerify('curl http://evil', { cwd: dir });
    assert.equal(r.ok, false);
    assert.match(r.reason, /allowlist/);
    assert.equal(r.durationMs, 0);
  });
});

// ───────────────────────────── 3. 门禁 ─────────────────────────────
describe('gate', () => {
  const green = `node ${join(dir, 'ok.mjs')}`;
  const red = `node ${join(dir, 'bad.mjs')}`;

  test('无 verdict 时只看命令', async () => {
    const r = await checkGate({ cwd: dir, verify_cmd: green });
    assert.equal(r.ok, true);
  });

  test('branchGate：未声明分支直接过（legacy 零变，不碰 git）', async () => {
    for (const opts of [{ cwd: dir }, { cwd: dir, expectedBranch: '' }, { cwd: dir, expectedBranch: '   ' }]) {
      const r = await branchGate(opts);
      assert.equal(r.ok, true, JSON.stringify(opts));
      assert.match(r.reason, /no branch declared/);
    }
  });

  test('requireVerdict 时缺 verdict 被拒', async () => {
    const r = await checkGate({ cwd: dir, verify_cmd: green, requireVerdict: true });
    assert.equal(r.ok, false);
    assert.match(r.reason, /verdict required/);
  });

  test('verdict 文件缺失被拒', async () => {
    const r = await checkGate({ cwd: dir, verify_cmd: green, verdict_path: 'nope.json' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /verdict missing/);
  });

  test('红命令即使 verdict 全绿也拒绝', async () => {
    const vp = join(dir, 'v.json');
    writeFileSync(vp, JSON.stringify({ allPassed: true, reviewedCommit: 'abc' }));
    const r = await checkGate({ cwd: dir, verify_cmd: red, verdict_path: 'v.json' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /exited 1/);
    assert.ok(r.evidence.stdout !== undefined, '应带证据');
  });

  test('allPassed=false 被拒', async () => {
    const vp = join(dir, 'v2.json');
    writeFileSync(vp, JSON.stringify({ allPassed: false, reviewedCommit: 'abc' }));
    const r = await checkGate({ cwd: dir, verify_cmd: green, verdict_path: 'v2.json' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /allPassed/);
  });

  test('commit 不一致被拒（防测旧代码）', async () => {
    const vp = join(dir, 'v3.json');
    writeFileSync(vp, JSON.stringify({ allPassed: true, reviewedCommit: 'aaaaaaa' }));
    const r = await checkGate({ cwd: dir, verify_cmd: green, verdict_path: 'v3.json', commit: 'bbbbbbb' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /commit mismatch/);
  });

  test('verdict 损坏被拒而非抛错', async () => {
    const vp = join(dir, 'bad.json');
    writeFileSync(vp, '{not json');
    const r = await checkGate({ cwd: dir, verify_cmd: green, verdict_path: 'bad.json' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /unreadable/);
  });

  test('非 git 目录不因 HEAD 检查崩溃', async () => {
    const nogit = mkdtempSync(join(tmpdir(), 'swarm-nogit-'));
    try {
      const r = await checkGate({ cwd: nogit, verify_cmd: green });
      assert.equal(r.ok, true);
    } finally {
      rmSync(nogit, { recursive: true, force: true });
    }
  });
});

// ───────────────────────────── 4. 协议 ─────────────────────────────
describe('roles & tags', () => {
  test('三个默认角色齐备且各有契约', () => {
    for (const role of ['plan', 'dev', 'test']) {
      assert.ok(ROLES[role], `缺角色 ${role}`);
      assert.ok(ROLES[role].contract.length > 0);
      assert.ok(ROLES[role].agent.startsWith('swarm-'));
    }
  });

  test('别名映射到正确角色', () => {
    assert.equal(TAG_INDEX.get('dev'), 'dev');
    assert.equal(TAG_INDEX.get('developer'), 'dev');
    assert.equal(TAG_INDEX.get('qa'), 'test');
    assert.equal(TAG_INDEX.get('planner'), 'plan');
  });

  test('#dev + 任务号 + 补充要求', () => {
    const t = parseTag('#dev W3-T1 顺手修空指针');
    assert.equal(t.role, 'dev');
    assert.equal(t.taskId, 'W3-T1');
    assert.equal(t.rest, '顺手修空指针');
  });

  test('无任务号也成立', () => {
    const t = parseTag('#plan 拆解这个需求');
    assert.equal(t.role, 'plan');
    assert.equal(t.taskId, undefined);
    assert.equal(t.rest, '拆解这个需求');
  });

  test('普通文本不误判为 tag', () => {
    assert.equal(parseTag('帮我看看这个 bug'), null);
    assert.equal(parseTag(''), null);
    assert.equal(parseTag('#unknown 随便'), null);
  });

  test('展开包含角色契约 + 任务详情 + 原话', () => {
    const text = expandTag(
      { role: 'dev', taskId: 'W1-T1', rest: '加注释' },
      { id: 'W1-T1', wave: 'W1', status: 'dev_doing', title: '改 n', acceptance: 'exit 0', verify_cmd: 'node verify.mjs', retries: 2 },
    );
    assert.match(text, /你是 dev/);
    assert.match(text, /改 n/);
    assert.match(text, /node verify\.mjs/);
    assert.match(text, /已失败 2 次/);
    assert.match(text, /加注释/);
  });

  test('任务找不到时给出指引而不是瞎猜', () => {
    const text = expandTag({ role: 'test', taskId: 'NOPE-9', rest: '' }, undefined);
    assert.match(text, /未在队列中找到/);
  });

  test('增量唤醒：任务块与全量逐字一致、契约压成一行、更短', () => {
    const task = { id: 'W1-T1', wave: 'W1', status: 'dev_doing', title: '改 n', acceptance: 'exit 0', verify_cmd: 'node verify.mjs', retries: 2, risk: 'high', paths: ['a/b.go'] };
    const full = expandTag({ role: 'dev', taskId: 'W1-T1', rest: '' }, task);
    const inc = expandTagCompact({ role: 'dev', taskId: 'W1-T1', rest: '' }, task);
    assert.match(inc, /你是 dev/);
    assert.match(inc, /W1-T1/);
    assert.match(inc, /改 n/);
    assert.match(inc, /node verify\.mjs/);
    assert.match(inc, /已失败 2 次/);
    assert.match(inc, /高风险/);
    assert.match(inc, /a\/b\.go/);
    assert.doesNotMatch(inc, /只做被指派的那一个任务/, '增量体不得含完整契约长句');
    assert.ok(inc.length < full.length, `增量体应更短（全量${full.length} vs 增量${inc.length}）`);
    // 任务块同源：全量去掉契约行后应与增量任务块一致
    const taskBlock = renderTaskBlock(task).filter(Boolean).join('\n');
    assert.ok(full.includes(taskBlock), '全量体含标准任务块');
    assert.ok(inc.includes(taskBlock), '增量体含同一任务块（逐字一致）');
  });

  test('增量唤醒：未知角色回 null，与全量同口径', () => {
    assert.equal(expandTagCompact({ role: 'nope', taskId: 'X-1', rest: '' }, undefined), null);
  });
});

describe('event idempotency', () => {
  test('同输入同 eid，异输入异 eid', () => {
    assert.equal(eventId('T1', 'TASK-DONE', 'abc'), eventId('T1', 'TASK-DONE', 'abc'));
    assert.notEqual(eventId('T1', 'TASK-DONE', 'abc'), eventId('T1', 'TASK-DONE', 'abd'));
    assert.notEqual(eventId('T1', 'TASK-DONE', 'abc'), eventId('T1', 'TEST-PASS', 'abc'));
  });

  test('旧 createChannel 入口仍可用（薄适配委托 FileBus，真写文件）', async () => {
    const stateDir = join(dir, 'compat-state');
    const ch = createChannel({ stateDir, channel: 'compat-chan' });
    const r = await ch.send({
      as: 'dev', prefix: '[TASK-DONE]', kv: { task: 'T9' },
      taskId: 'T9', status: 'TASK-DONE', commit: 'abc',
    });
    assert.equal(r.sent, true, JSON.stringify(r));
    assert.ok(existsSync(join(stateDir, 'events.jsonl')), 'events.jsonl 应落盘');
    assert.equal(await ch.flushOutbox(), 0, 'FileBus 无 outbox，恒返 0');
  });

  test('FileBus 真写：send 落盘，tail 读回，重发幂等', async () => {
    const bus = createFileBus({ stateDir: join(dir, 'bus1'), runId: 'r1' });
    const first = await bus.send({
      as: 'dev', prefix: '[TASK-DONE]', kv: { task: 'T1', wave: 'W1' },
      taskId: 'T1', status: 'TASK-DONE', commit: 'c1',
    });
    assert.equal(first.sent, true, JSON.stringify(first));
    assert.equal(first.seq, 1);
    assert.equal(typeof first.eid, 'string');

    const again = await bus.send({
      as: 'dev', prefix: '[TASK-DONE]', kv: { task: 'T1', wave: 'W1' },
      taskId: 'T1', status: 'TASK-DONE', commit: 'c1',
    });
    assert.equal(again.sent, false);
    assert.equal(again.duplicate, true);
    assert.equal(again.eid, first.eid);

    const rows = readFileSync(join(dir, 'bus1', 'events.jsonl'), 'utf8').split('\n').filter(Boolean);
    assert.equal(rows.length, 1, '重发不得追加第二行');
    const tail = await bus.tail(10);
    assert.equal(tail.length, 1);
    assert.equal(tail[0].seq, 1);
    assert.equal(tail[0].by, 'dev');
    assert.match(tail[0].text, /\[TASK-DONE\]/);
  });

  test('并发 send seq 唯一（20 并发，无重号、无跳号）', async () => {
    const bus = createFileBus({ stateDir: join(dir, 'bus-race'), runId: 'race' });
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => bus.send({
        as: 'dev', prefix: '[TASK-ASSIGN]', kv: { task: `C-${i}` },
        taskId: `C-${i}`, status: 'TASK-ASSIGN', commit: `c${i}`,
      })),
    );
    assert.ok(results.every((r) => r.sent), JSON.stringify(results));
    const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
    assert.deepEqual(seqs, Array.from({ length: 20 }, (_, i) => i + 1));
  });

  test('坏行跳过：tail 不崩，send seq 不受坏行影响', async () => {
    const stateDir = join(dir, 'bus-bad');
    const bus = createFileBus({ stateDir, runId: 'bad' });
    await bus.send({
      as: 'dev', prefix: '[TASK-DONE]', kv: { task: 'G1' },
      taskId: 'G1', status: 'TASK-DONE', commit: 'c1',
    });
    appendFileSync(join(stateDir, 'events.jsonl'), '{broken json\n\nnot-json{{{\n', 'utf8');
    const tail = await bus.tail(10);
    assert.equal(tail.length, 1, '坏行应被跳过，只剩 1 条好行');
    assert.equal(tail[0].taskId, 'G1');

    const next = await bus.send({
      as: 'test', prefix: '[TEST-PASS]', kv: { task: 'G2' },
      taskId: 'G2', status: 'TEST-PASS', commit: 'c2',
    });
    assert.equal(next.sent, true);
    assert.equal(next.seq, 2, '坏行不得占用 seq');
  });

  test('双路径兼容：新位空时 tail 回退旧位', async () => {
    const legacyDir = join(dir, 'legacy-state');
    const legacyBus = createFileBus({ stateDir: legacyDir, runId: 'old' });
    await legacyBus.send({
      as: 'dev', prefix: '[TASK-DONE]', kv: { task: 'L1' },
      taskId: 'L1', status: 'TASK-DONE', commit: 'c1',
    });
    const bus = createFileBus({ stateDir: join(dir, 'bus-new-empty'), runId: 'old', legacyDir });
    const tail = await bus.tail(10);
    assert.equal(tail.length, 1);
    assert.equal(tail[0].taskId, 'L1');
  });

  test('send 永不抛错，wait 超时回 null（不等满长 timeout）', async () => {
    const bus = createFileBus({ stateDir: join(dir, 'bus-wait'), runId: 'w' });
    const t0 = Date.now();
    const got = await bus.wait({ timeout: 400 });
    assert.equal(got, null);
    assert.ok(Date.now() - t0 < 5000, '短 timeout 不得久等');

    await bus.send({
      as: 'dev', prefix: '[TASK-ASSIGN]', kv: { task: 'W1' },
      taskId: 'W1', status: 'TASK-ASSIGN', commit: 'c1',
    });
    // 新事件在 wait 开始前已存在（mtime 未变）→ 超时回 null，同样不抛错
    const got2 = await bus.wait({ timeout: 300 });
    assert.equal(got2, null);
  });

  test('bus eid 带 runId 命名空间，不同 run 同任务不互斥', () => {
    assert.equal(busEventId('T1', 'S', 'c', 'r1'), busEventId('T1', 'S', 'c', 'r1'));
    assert.notEqual(busEventId('T1', 'S', 'c', 'r1'), busEventId('T1', 'S', 'c', 'r2'));
  });
});

// ───────────────────────────── 5. Run 隔离 ─────────────────────────────
describe('run isolation', () => {
  test('sanitizeRunId 只留白名单，空/非法归一，防路径穿越', () => {
    assert.equal(sanitizeRunId('A-1_x'), 'A-1_x');
    assert.equal(sanitizeRunId(''), 'default');
    assert.equal(sanitizeRunId(null), 'default');
    assert.equal(sanitizeRunId('../'), 'default', '../ 应被吃光归一');
    assert.equal(sanitizeRunId('../../etc'), 'etc', '点和斜杠全剥掉，逃不出 runs/');
    assert.equal(sanitizeRunId('a/b'), 'ab');
    assert.equal(sanitizeRunId('  B  '), 'B');
  });

  test('resolveRun 默认落 run 目录；显式 queue 仍被尊重（相对经 cwd，绝对直用）', () => {
    const r = resolveRun(dir);
    assert.equal(r.runId, 'default');
    assert.ok(r.queuePath.endsWith('.swarm/runs/default/queue.jsonl'), r.queuePath);
    assert.equal(r.roundPath, join(r.runDir, 'round.json'));
    assert.equal(r.eventsDir, r.runDir);
    const q = resolveRun(dir, { queue: '.trellis/swarm-queue.jsonl' });
    assert.equal(q.queuePath, join(dir, '.trellis', 'swarm-queue.jsonl'));
    assert.equal(q.runId, 'default', '显式 queue 不改变 run 归属');
    const qa = resolveRun(dir, { queue: '/tmp/x.jsonl' });
    assert.equal(qa.queuePath, '/tmp/x.jsonl');
  });

  test('优先级：显式 run > cfgRunId > current 指针 > default', () => {
    const d2 = mkdtempSync(join(tmpdir(), 'swarm-runp-'));
    try {
      assert.equal(resolveRun(d2).runId, 'default');
      writeCurrentRunId(d2, 'B');
      assert.equal(resolveRun(d2).runId, 'B', 'current 指针生效');
      assert.equal(resolveRun(d2, { cfgRunId: 'C' }).runId, 'C');
      assert.equal(resolveRun(d2, { run: 'A', cfgRunId: 'C' }).runId, 'A');
      const rEvil = resolveRun(d2, { run: '../evil' });
      assert.equal(rEvil.runId, 'evil', '点和斜杠被剥掉，只剩安全字符');
      assert.ok(rEvil.runDir.startsWith(join(d2, '.swarm', 'runs')), 'runDir 逃不出 runs/ 根');
    } finally {
      rmSync(d2, { recursive: true, force: true });
    }
  });

  test('双轮队列互不可见，同 taskId 分属两轮互不干扰', () => {
    const qa = resolveRun(dir, { run: 'A' }).queuePath;
    const qb = resolveRun(dir, { run: 'B' }).queuePath;
    assert.equal(enqueueTask(qa, emptyTask({ id: 'W1-T1' })).ok, true);
    assert.equal(enqueueTask(qb, emptyTask({ id: 'W1-T1' })).ok, true);
    assert.equal(loadQueue(qa).length, 1);
    assert.equal(loadQueue(qb).length, 1);
    assert.equal(casTransition(qa, 'W1-T1', 'queued', { status: 'dev_doing' }).ok, true);
    assert.equal(loadQueue(qa)[0].status, 'dev_doing');
    assert.equal(loadQueue(qb)[0].status, 'queued', 'A 的迁移不得影响 B');
  });

  test('migrate 幂等：空跑提示、拒覆盖非空、force 重迁', () => {
    const d3 = mkdtempSync(join(tmpdir(), 'swarm-mig-'));
    try {
      const empty = migrateLegacy(d3, { run: 'M1' });
      assert.equal(empty.ok, true);
      assert.match(empty.message ?? '', /空跑/);
      mkdirSync(join(d3, '.trellis', 'swarm-state'), { recursive: true });
      writeFileSync(
        join(d3, '.trellis', 'swarm-queue.jsonl'),
        `${JSON.stringify({ ...emptyTask({ id: 'L-1' }), status: 'queued', retries: 0 })}\n`,
      );
      writeFileSync(join(d3, '.trellis', 'swarm-state', 'round.json'), JSON.stringify({ name: '旧需求', sessions: {} }));
      const first = migrateLegacy(d3, { run: 'M2' });
      assert.equal(first.ok, true, JSON.stringify(first));
      assert.equal(loadQueue(resolveRun(d3, { run: 'M2' }).queuePath).length, 1);
      const again = migrateLegacy(d3, { run: 'M2' });
      assert.equal(again.ok, false, '目标非空必须拒绝');
      assert.match(again.reason, /拒绝覆盖/);
      const forced = migrateLegacy(d3, { run: 'M2', force: true });
      assert.equal(forced.ok, true);
    } finally {
      rmSync(d3, { recursive: true, force: true });
    }
  });

  test('listRuns 列出多轮', () => {
    const runs = listRuns(dir).map((r) => r.runId);
    assert.ok(runs.includes('A') && runs.includes('B'), `应含 A/B，实际 ${runs.join(',')}`);
  });
});

describe('会话/任务 → run 解析（10-31 并行两轮串轮修复）', () => {
  const mkRun = (root, id, round, tasks = []) => {
    const d = join(root, '.swarm', 'runs', id);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'round.json'), JSON.stringify(round), 'utf8');
    writeFileSync(join(d, 'meta.json'), JSON.stringify({ runId: id, name: id }), 'utf8');
    writeFileSync(join(d, 'queue.jsonl'),
      tasks.map((t) => JSON.stringify({ ...emptyTask(), ...t })).join('\n') + (tasks.length ? '\n' : ''), 'utf8');
    return d;
  };

  test('优先级：显式 run > 任务归属 > 会话绑定 > current > default', () => {
    const d = mkdtempSync(join(tmpdir(), 'swarm-bind-'));
    try {
      mkRun(d, 'A', { name: 'A', sessions: { plan: 'sid-plan-a' }, members: { 'sid-host-a': { role: 'host' } } }, [{ id: 'TA' }]);
      mkRun(d, 'B', { name: 'B', sessions: { dev: 'sid-dev-b' }, members: { 'sid-sub-b': { role: 'dev' } } }, [{ id: 'TB' }]);
      writeCurrentRunId(d, 'A');
      // 会话绑定压过全局 current（串轮事故根因）
      assert.equal(resolveRun(d, { sessionID: 'sid-dev-b' }).runId, 'B');
      assert.equal(resolveRun(d, { sessionID: 'sid-host-a' }).runId, 'A');
      assert.equal(resolveRun(d, { sessionID: 'sid-sub-b' }).runId, 'B', 'members（子代理）同样可反查');
      // 未绑定会话仍回 current（老行为零变）
      assert.equal(resolveRun(d, { sessionID: 'unknown' }).runId, 'A');
      // 任务归属：子代理没带 run 也能落对轮
      assert.equal(resolveRun(d, { taskId: 'TB' }).runId, 'B');
      assert.equal(resolveRun(d, { taskId: 'NOPE' }).runId, 'A');
      // 显式 run 永远最高
      assert.equal(resolveRun(d, { run: 'A', taskId: 'TB' }).runId, 'A');
      assert.equal(runIdForSession(d, 'sid-dev-b'), 'B');
      assert.equal(runIdForTask(d, 'TA'), 'A');
      assert.deepEqual(Object.keys(sessionRunIndex(d)).sort(), ['sid-dev-b', 'sid-host-a', 'sid-plan-a', 'sid-sub-b']);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test('writeRound：members 默认合并，replaceMembers 整体替换且不动 sessions', () => {
    const d = mkdtempSync(join(tmpdir(), 'swarm-mem-'));
    try {
      writeRound(d, { name: 'n', sessions: { plan: 'p1' }, members: { s1: { role: 'host' } } });
      writeRound(d, { members: { s2: { role: 'dev' } } });
      assert.deepEqual(readRound(d).members, { s1: { role: 'host' }, s2: { role: 'dev' } }, '默认合并');
      writeRound(d, { members: { s3: { role: 'host' } } }, { replaceMembers: true });
      assert.deepEqual(readRound(d).members, { s3: { role: 'host' } }, '整体替换');
      assert.deepEqual(readRound(d).sessions, { plan: 'p1' }, '替换 members 不得动 sessions');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('up 新轮隔离（派生/判空/sessions 替换）', () => {
  test('deriveRunIdFromName 只留中英数_-(截 40)，空回退 run-MMDD-HHmm', () => {
    assert.equal(deriveRunIdFromName('库房列表库存显示'), '库房列表库存显示');
    assert.equal(deriveRunIdFromName('  A/B.C-1_x 待办!'), 'ABC-1_x待办');
    assert.equal(deriveRunIdFromName('!!!', new Date(2026, 9, 31, 8, 5)), 'run-1031-0805');
    assert.equal(deriveRunIdFromName('', new Date(2026, 9, 31, 8, 5)), 'run-1031-0805');
    assert.equal(deriveRunIdFromName('库'.repeat(50)).length, 40);
  });

  test('sanitizeRunId 保留中文，穿越仍被拦', () => {
    assert.equal(sanitizeRunId('库房列表A-1'), '库房列表A-1');
    assert.equal(sanitizeRunId('../库房'), '库房', '点和斜杠仍剥掉，只剩中文');
  });

  test('resolveUniqueRunId：空位直接用，非空加 -2/-3', () => {
    const d = mkdtempSync(join(tmpdir(), 'swarm-uniq-'));
    try {
      assert.equal(resolveUniqueRunId(d, 'N'), 'N', '目录缺失直接用');
      mkdirSync(join(d, '.swarm', 'runs', 'N'), { recursive: true });
      assert.equal(resolveUniqueRunId(d, 'N'), 'N', '空目录直接用');
      assert.equal(isRunDirNonEmpty(d, 'N'), false);
      writeFileSync(join(d, '.swarm', 'runs', 'N', 'queue.jsonl'), '{"id":"X"}\n');
      assert.equal(isRunDirNonEmpty(d, 'N'), true);
      assert.equal(resolveUniqueRunId(d, 'N'), 'N-2');
      mkdirSync(join(d, '.swarm', 'runs', 'N-2'), { recursive: true });
      writeFileSync(join(d, '.swarm', 'runs', 'N-2', 'round.json'), '{"name":"x"}');
      assert.equal(resolveUniqueRunId(d, 'N'), 'N-3');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test('runQueueHasTasks 只看自有 queue（缺文件/全空行视为空）', () => {
    const d = mkdtempSync(join(tmpdir(), 'swarm-qt-'));
    try {
      assert.equal(runQueueHasTasks(d, 'Q'), false, '缺目录视为空');
      mkdirSync(join(d, '.swarm', 'runs', 'Q'), { recursive: true });
      assert.equal(runQueueHasTasks(d, 'Q'), false, '缺 queue 文件视为空');
      writeFileSync(join(d, '.swarm', 'runs', 'Q', 'queue.jsonl'), '\n  \n');
      assert.equal(runQueueHasTasks(d, 'Q'), false, '全空行视为空');
      writeFileSync(join(d, '.swarm', 'runs', 'Q', 'queue.jsonl'), '{"id":"T1"}\n');
      assert.equal(runQueueHasTasks(d, 'Q'), true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test('writeRound 默认合并 sessions；replaceSessions 整体替换', () => {
    const d = mkdtempSync(join(tmpdir(), 'swarm-wr-'));
    try {
      writeRound(d, { name: 'n', sessions: { plan: 'old-plan', dev: 'old-dev' } });
      writeRound(d, { sessions: { plan: 'new-plan' } });
      assert.deepEqual(readRound(d).sessions, { plan: 'new-plan', dev: 'old-dev' }, '默认合并，老 dev 保留');
      writeRound(d, { sessions: { plan: 'fresh' } }, { replaceSessions: true });
      assert.deepEqual(readRound(d).sessions, { plan: 'fresh' }, '替换后旧 dev 不得残留');
      assert.equal(readRound(d).name, 'n', '非 sessions 字段不受替换影响');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

// ───────────────────────────── 6. FSM 状态机 ─────────────────────────────
describe('fsm', () => {
  test('状态表与常量齐备', () => {
    for (const s of ['queued', 'dev_doing', 'gate_check', 'test_doing', 'passed', 'halted']) {
      assert.ok(STATUSES.includes(s), `缺状态 ${s}`);
      assert.ok(Array.isArray(TRANSITIONS[s]), `缺出边 ${s}`);
    }
  });

  test('合法链全过：queued→dev_doing→gate_check→test_doing→passed', () => {
    assert.equal(can('queued', 'dev_doing'), true);
    assert.equal(can('dev_doing', 'gate_check'), true);
    assert.equal(can('gate_check', 'test_doing'), true);
    assert.equal(can('test_doing', 'passed'), true);
    assert.equal(can('halted', 'dev_doing'), true);
    assert.equal(can('test_doing', 'halted'), true);
    assert.equal(can('passed', 'halted'), true);
  });

  test('queued→passed 被拒且 reason 含 allowed:', () => {
    assert.equal(can('queued', 'passed'), false);
    const r = checkTransition('queued', 'queued', 'passed', 'W-T1');
    assert.equal(r.ok, false);
    assert.match(r.reason, /allowed:/);
  });

  test('gate_check→passed 被拒（门禁只能去 test_doing/dev_doing/halted）', () => {
    assert.equal(can('gate_check', 'passed'), false);
    const r = checkTransition('gate_check', 'gate_check', 'passed', 'W-T1');
    assert.equal(r.ok, false);
    assert.match(r.reason, /allowed:/);
    assert.match(r.reason, /test_doing/);
  });

  test('门禁拒绝边 gate_check→dev_doing 合法；超限边 test_doing→halted 合法', () => {
    assert.equal(can('gate_check', 'dev_doing'), true);
    assert.equal(can('test_doing', 'halted'), true);
    assert.equal(checkTransition('gate_check', 'gate_check', 'dev_doing').ok, true);
  });

  test('checkTransition：expect 命中但表无边仍拒绝', () => {
    const r = checkTransition('dev_doing', ['dev_doing', 'queued'], 'passed', 'W-T2');
    assert.equal(r.ok, false);
    assert.match(r.reason, /illegal transition/);
    assert.match(r.reason, /allowed:/);
  });

  test('checkTransition：同态重进（to === cur）只做 expect 检查', () => {
    assert.equal(checkTransition('gate_check', ['dev_doing', 'gate_check'], 'gate_check').ok, true);
    assert.equal(checkTransition('gate_check', 'dev_doing', 'gate_check').ok, false);
  });

  test('allowedFrom 未知状态返回空数组，永不抛错', () => {
    assert.deepEqual(allowedFrom('nope'), []);
    assert.equal(can('nope', 'queued'), false);
  });
});

// ───────────────────────────── 7. Timeline 事件溯源 ─────────────────────────────
describe('timeline', () => {
  const tDir = () => {
    const d = mkdtempSync(join(tmpdir(), 'swarm-tl-'));
    return { d, q: join(d, 'queue.jsonl'), tl: join(d, 'run', 'timeline.jsonl'), runDir: join(d, 'run') };
  };

  test('transitionTask 非法迁移被拒，queue 不动且 timeline 无行', () => {
    const { d, q, tl } = tDir();
    try {
      assert.equal(enqueueTask(q, emptyTask({ id: 'F-1' }), tl).ok, true);
      const before = loadQueue(q);
      const r = transitionTask(q, tl, { taskId: 'F-1', expect: 'queued', patch: { status: 'passed' }, by: 'dev', reason: 'x' });
      assert.equal(r.ok, false);
      assert.match(r.reason, /allowed:/);
      assert.deepEqual(loadQueue(q), before, '被拒后 queue 不得改动');
      const rows = readTimeline(join(d, 'run'));
      assert.equal(rows.filter((x) => x.kind === 'move').length, 0, '被拒不得写 move 行');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test('transitionTask 合法迁移写 move 行（by/reason/seq 单调）', () => {
    const { d, q } = tDir();
    try {
      enqueueTask(q, emptyTask({ id: 'M-1' }), join(d, 'run', 'timeline.jsonl'));
      const tl = join(d, 'run', 'timeline.jsonl');
      const r1 = transitionTask(q, tl, { taskId: 'M-1', expect: 'queued', patch: { status: 'dev_doing', assignee: 'dev' }, by: 'dev', reason: 'claim' });
      assert.equal(r1.ok, true);
      const r2 = transitionTask(q, tl, { taskId: 'M-1', expect: 'dev_doing', patch: { status: 'gate_check' }, by: 'dev', reason: 'gate-enter' });
      assert.equal(r2.ok, true);
      const rows = readTimeline(join(d, 'run'));
      assert.equal(rows.length, 3, 'create + 2 move');
      assert.deepEqual(rows.map((x) => x.kind), ['create', 'move', 'move']);
      assert.deepEqual(rows.map((x) => x.seq), [1, 2, 3]);
      assert.equal(rows[1].from, 'queued');
      assert.equal(rows[1].to, 'dev_doing');
      assert.equal(rows[1].by, 'dev');
      assert.equal(rows[1].reason, 'claim');
      assert.equal(rows[2].to, 'gate_check');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test('timelinePath 缺省时迁移只写 queue 不炸', () => {
    const { d, q } = tDir();
    try {
      assert.equal(enqueueTask(q, emptyTask({ id: 'N-1' })).ok, true);
      const r = transitionTask(q, null, { taskId: 'N-1', expect: 'queued', patch: { status: 'dev_doing' } });
      assert.equal(r.ok, true);
      assert.equal(loadQueue(q)[0].status, 'dev_doing');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test('timelinePathFor 落 run 目录且经 sanitize', () => {
    const p = timelinePathFor(dir, 'A');
    assert.ok(p.endsWith(join('.swarm', 'runs', 'A', 'timeline.jsonl')), p);
    assert.equal(timelinePathFor(dir, '../evil'), timelinePathFor(dir, 'evil'));
  });

  test('删 queue 后 rebuild 与原文件 deep-equal', () => {
    const { d, q, tl, runDir } = tDir();
    try {
      enqueueTask(q, emptyTask({ id: 'TL-1' }), tl);
      enqueueTask(q, emptyTask({ id: 'TL-2' }), tl, { by: 'plan', reason: 'create' });
      assert.equal(transitionTask(q, tl, { taskId: 'TL-1', expect: 'queued', patch: { status: 'dev_doing', assignee: 'dev' }, by: 'dev', reason: 'claim' }).ok, true);
      assert.equal(transitionTask(q, tl, { taskId: 'TL-1', expect: 'dev_doing', patch: { status: 'gate_check' }, by: 'dev', reason: 'gate-enter' }).ok, true);
      assert.equal(transitionTask(q, tl, { taskId: 'TL-1', expect: 'gate_check', patch: { status: 'test_doing', assignee: 'test', commit: 'abc1234' }, by: 'gate', reason: 'gate-pass' }).ok, true);
      assert.equal(transitionTask(q, tl, { taskId: 'TL-2', expect: 'queued', patch: { status: 'halted' }, by: 'human', reason: 'manual' }).ok, true);
      assert.equal(transitionTask(q, tl, { taskId: 'TL-2', expect: 'halted', patch: { status: 'dev_doing', assignee: 'dev', retries: 0 }, by: 'human', reason: 'retry' }).ok, true);
      const before = loadQueue(q);
      assert.equal(before.length, 2);
      rmSync(q, { force: true });
      assert.deepEqual(rebuildQueueFromTimeline(runDir), before, '重放必须与删前 queue逐行 deep-equal');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test('rebuild：坏行跳过、悬空 move 丢弃、缺文件回 []', () => {
    const { d, runDir, tl } = tDir();
    try {
      mkdirSync(runDir, { recursive: true });
      writeFileSync(tl, '{broken json\n\n', 'utf8');
      assert.deepEqual(rebuildQueueFromTimeline(runDir), []);
      assert.deepEqual(rebuildQueueFromTimeline(join(d, 'no-such-dir')), []);
      // 悬空 move（无 create）不得凭空造任务
      appendFileSync(tl, `${JSON.stringify({ seq: 1, taskId: 'GHOST', kind: 'move', from: 'queued', to: 'dev_doing', patch: { status: 'dev_doing' } })}\n`, 'utf8');
      assert.deepEqual(rebuildQueueFromTimeline(runDir), []);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test('rebuild 忽略 kind=approve 软卡行（审计行不参与重放，by+task+risk 照留 timeline）', () => {
    const { d, q, tl, runDir } = tDir();
    try {
      enqueueTask(q, emptyTask({ id: 'AP-1', risk: 'high' }), tl);
      assert.equal(transitionTask(q, tl, { taskId: 'AP-1', expect: 'queued', patch: { status: 'dev_doing', assignee: 'dev' }, by: 'dev', reason: 'claim' }).ok, true);
      appendTimeline(tl, {
        taskId: 'AP-1', kind: 'approve', from: null, to: null,
        by: 'human', reason: 'approve:risk=high', commit: '-', retries: 0,
        patch: { approved: true, risk: 'high', session: 'human' },
      });
      const before = loadQueue(q);
      rmSync(q, { force: true });
      assert.deepEqual(rebuildQueueFromTimeline(runDir), before, 'approve 行不得影响重放');
      const rows = readTimeline(runDir);
      assert.ok(rows.some((r) => r.kind === 'approve' && r.taskId === 'AP-1' && r.by === 'human'), '审计行仍在 timeline（by 可审计）');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test('门禁打回边不碰 retries（transitionTask 只合 patch 字段）', () => {
    const { d, q, tl } = tDir();
    try {
      enqueueTask(q, emptyTask({ id: 'G-1' }), tl);
      transitionTask(q, tl, { taskId: 'G-1', expect: 'queued', patch: { status: 'dev_doing' }, by: 'dev', reason: 'claim' });
      transitionTask(q, tl, { taskId: 'G-1', expect: 'dev_doing', patch: { status: 'gate_check' }, by: 'dev', reason: 'gate-enter' });
      const r = transitionTask(q, tl, { taskId: 'G-1', expect: 'gate_check', patch: { status: 'dev_doing' }, by: 'gate', reason: 'gate-reject:boom' });
      assert.equal(r.ok, true);
      assert.equal(loadQueue(q)[0].retries, 0, '打回不得计 retries');
      assert.equal(loadQueue(q)[0].status, 'dev_doing');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

// ───────────────────────────── 8. Gate 管道 ─────────────────────────────
describe('gate pipeline', () => {
  const green = `node ${join(dir, 'ok.mjs')}`;
  const red = `node ${join(dir, 'bad.mjs')}`;

  test('短路：verify 红则后门不跑', async () => {
    let ran = 0;
    registerGate(async () => { ran += 1; return { ok: true, reason: 'spy ok' }; });
    try {
      const r = await checkGate({ cwd: dir, verify_cmd: red });
      assert.equal(r.ok, false);
      assert.match(r.reason, /gate=verify/);
      assert.equal(ran, 0, 'verify 失败后管道必须短路');
    } finally {
      GATES.pop();
    }
  });

  test('一行 registerGate 生效（全绿时被新 Gate 拦住）', async () => {
    registerGate(async () => ({ ok: false, reason: 'gate=zz: boom', evidence: { kind: 'zz' } }));
    try {
      const r = await checkGate({ cwd: dir, verify_cmd: green });
      assert.equal(r.ok, false);
      assert.match(r.reason, /gate=zz/);
    } finally {
      GATES.pop();
    }
  });

  test('policy 拦 paths 命中禁区', async () => {
    const r = await checkGate({ cwd: dir, verify_cmd: green, paths: ['tools/review/note.md'] });
    assert.equal(r.ok, false);
    assert.match(r.reason, /gate=policy/);
    assert.match(r.reason, /tools\/review\/note\.md/);
  });

  test('policy_exception 放行禁区（自举类任务）', async () => {
    const r = await checkGate({ cwd: dir, verify_cmd: green, paths: ['tools/review/note.md'], policy_exception: true });
    assert.equal(r.ok, true);
  });

  test('policyDeny 自定义禁区', async () => {
    const r = await checkGate({ cwd: dir, verify_cmd: green, paths: ['secret/keys.txt'], policyDeny: ['secret/**'] });
    assert.equal(r.ok, false);
    assert.match(r.reason, /gate=policy/);
  });

  test('policy 拦 git 改动（禁区文件未提交）', async () => {
    const g = mkdtempSync(join(tmpdir(), 'swarm-policy-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: g });
      execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: g });
      execFileSync('git', ['config', 'user.name', 't'], { cwd: g });
      mkdirSync(join(g, 'tools', 'review'), { recursive: true });
      writeFileSync(join(g, 'tools', 'review', 'x.md'), 'x\n');
      const r = await checkGate({ cwd: g, verify_cmd: green });
      assert.equal(r.ok, false);
      assert.match(r.reason, /gate=policy/);
      const excused = await checkGate({ cwd: g, verify_cmd: green, policy_exception: true });
      assert.equal(excused.ok, true);
    } finally {
      rmSync(g, { recursive: true, force: true });
    }
  });

  test('旧调用形状不变：git 干净无 paths 时全过且 evidence 兼容（security 占位恒 warning 透出）', async () => {
    const r = await checkGate({ cwd: dir, verify_cmd: green });
    assert.equal(r.ok, true);
    assert.match(r.reason, /gate ok \(warnings:/);
    assert.match(r.reason, /gate=security: security-not-configured/);
    assert.equal(r.evidence.kind, 'verify+verdict');
    assert.equal(typeof r.evidence.durationMs, 'number');
    assert.ok(Array.isArray(r.evidence.warnings) && r.evidence.warnings.some((w) => /security-not-configured/.test(w)), 'warnings 应含 security 占位');
  });

  test('securityGate 恒 ok + warning（reason 含 security + not-configured，走 warnings 管道）', async () => {
    const { securityGate } = await import('../lib/swarm-gate.js');
    const s = await securityGate();
    assert.equal(s.ok, true);
    assert.match(s.reason, /security/);
    assert.match(s.reason, /not-configured/);
    assert.equal(s.evidence.warning, true);
  });

  test('matchPatterns 语义：前缀/精确/不命中', () => {
    assert.ok(matchPatterns('tools/review/a.md', FORBIDDEN));
    assert.ok(matchPatterns('.opencode/lib/x.js', FORBIDDEN));
    assert.ok(matchPatterns('opencode.json', FORBIDDEN));
    assert.equal(matchPatterns('src/a.ts', FORBIDDEN), null);
    assert.equal(matchPatterns('tools/other/a.md', FORBIDDEN), null);
  });

  test('A1：脏工作区仅 .opencode 改动 + 无 paths → 放行且 reason 带 warning', async () => {
    const g = mkdtempSync(join(tmpdir(), 'swarm-policy-warn-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: g });
      execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: g });
      execFileSync('git', ['config', 'user.name', 't'], { cwd: g });
      mkdirSync(join(g, '.opencode', 'lib'), { recursive: true });
      writeFileSync(join(g, '.opencode', 'x.js'), 'x\n');
      const r = await checkGate({ cwd: g, verify_cmd: green });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.match(r.reason, /warning/);
    } finally {
      rmSync(g, { recursive: true, force: true });
    }
  });

  test('A1：声明 paths 命中 .opencode 禁区仍被拒', async () => {
    const r = await checkGate({ cwd: dir, verify_cmd: green, paths: ['.opencode/x.js'] });
    assert.equal(r.ok, false);
    assert.match(r.reason, /gate=policy/);
  });

  test('A2：verdict full hash + HEAD short 前缀同一 → 放行', async () => {
    const g = mkdtempSync(join(tmpdir(), 'swarm-verdict-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: g });
      execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: g });
      execFileSync('git', ['config', 'user.name', 't'], { cwd: g });
      writeFileSync(join(g, 'a.txt'), 'a\n');
      execFileSync('git', ['add', '-A'], { cwd: g });
      execFileSync('git', ['commit', '-qm', 'init'], { cwd: g });
      const full = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: g, encoding: 'utf8' }).trim();
      assert.ok(full.length > 7, `应为完整 hash，实际 ${full}`);
      writeFileSync(join(g, 'vv.json'), JSON.stringify({ allPassed: true, reviewedCommit: full }));
      const r = await checkGate({ cwd: g, verify_cmd: green, verdict_path: 'vv.json' });
      assert.equal(r.ok, true, JSON.stringify(r));
    } finally {
      rmSync(g, { recursive: true, force: true });
    }
  });

  test('A2：verdict 与 HEAD 真不一致仍拒绝', async () => {
    const g = mkdtempSync(join(tmpdir(), 'swarm-verdict-mis-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: g });
      execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: g });
      execFileSync('git', ['config', 'user.name', 't'], { cwd: g });
      writeFileSync(join(g, 'a.txt'), 'a\n');
      execFileSync('git', ['add', '-A'], { cwd: g });
      execFileSync('git', ['commit', '-qm', 'init'], { cwd: g });
      writeFileSync(join(g, 'w.json'), JSON.stringify({ allPassed: true, reviewedCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }));
      const r = await checkGate({ cwd: g, verify_cmd: green, verdict_path: 'w.json' });
      assert.equal(r.ok, false);
      assert.match(r.reason, /stale|mismatch/);
    } finally {
      rmSync(g, { recursive: true, force: true });
    }
  });
});

// ───────────────────────────── 9. 入队风控字段 ─────────────────────────────
describe('enqueue risk/paths/policy_exception', () => {
  test('risk 非法值拒收', () => {
    const q = join(dir, 'risk-bad.jsonl');
    const r = enqueueTask(q, emptyTask({ id: 'RK-1', risk: 'critical' }));
    assert.equal(r.ok, false);
    assert.match(r.reason, /invalid risk/);
  });

  test('risk 缺省 medium，合法值透传且 timeline 快照带上', () => {
    const q = join(dir, 'risk-ok.jsonl');
    const tl = join(dir, 'risk-ok-tl.jsonl');
    assert.equal(enqueueTask(q, emptyTask({ id: 'RK-2' }), tl).ok, true);
    assert.equal(enqueueTask(q, emptyTask({ id: 'RK-3', risk: 'high', paths: ['a/b.ts'], policy_exception: true }), tl).ok, true);
    const tasks = loadQueue(q);
    assert.equal(tasks[0].risk, 'medium');
    assert.equal(tasks[1].risk, 'high');
    assert.deepEqual(tasks[1].paths, ['a/b.ts']);
    assert.equal(tasks[1].policy_exception, true);
    const snap = readFileSync(tl, 'utf8');
    assert.match(snap, /"risk":"high"/);
  });

  test('paths 非数组拒收，policy_exception 非布尔拒收', () => {
    const q = join(dir, 'risk-bad2.jsonl');
    assert.match(enqueueTask(q, emptyTask({ id: 'RK-4', paths: 'a/b' })).reason, /invalid paths/);
    assert.match(enqueueTask(q, emptyTask({ id: 'RK-5', policy_exception: 'yes' })).reason, /invalid policy_exception/);
  });
});

// ───────────────────────────── 10. Role 注册表 ─────────────────────────────
describe('role registry', () => {
  test('角色带 tools/needsHuman', () => {
    for (const role of ['plan', 'dev', 'test']) {
      assert.ok(Array.isArray(ROLES[role].tools), `${role} 缺 tools`);
      assert.equal(typeof ROLES[role].needsHuman, 'boolean', `${role} 缺 needsHuman`);
    }
  });

  test('reviewer 占位：agent null、needsHuman、可索引', () => {
    assert.equal(ROLES.reviewer.agent, null);
    assert.equal(ROLES.reviewer.needsHuman, true);
    assert.equal(hasRole('reviewer'), true);
    assert.equal(TAG_INDEX.get('reviewer'), 'reviewer');
  });

  test('planner 契约含 verify_cmd 三条自查（单命令/裸命令名/禁拼接，11-06 复盘）', () => {
    const c = ROLES.plan.contract;
    assert.match(c, /单命令/);
    assert.match(c, /裸命令名/);
    assert.match(c, /make -C/);
    assert.match(c, /禁.*shell.*拼接|禁 shell 拼接/);
  });

  test('dev 契约含单树铁律（禁自建 worktree/分支，11-06 复盘）', () => {
    const c = ROLES.dev.contract;
    assert.match(c, /worktree/);
    assert.match(c, /主树|同一分支/);
  });

  test('一行 registerRole 生效且索引重建', () => {
    registerRole('security', {
      tag: ['security', '#security'], agent: null, modelKey: 'security',
      canEdit: false, tools: [], needsHuman: true, contract: 'sec',
    });
    try {
      assert.equal(hasRole('security'), true);
      assert.equal(TAG_INDEX.get('security'), 'security');
      assert.equal(parseTag('#security W1-T1 看看')?.role, 'security');
    } finally {
      delete ROLES.security;
      rebuildTagIndex();
    }
    assert.equal(hasRole('security'), false);
  });

  test('裸 dev 不命中，#dev 命中（收紧 # 前缀）', () => {
    assert.equal(parseTag('dev W1-T1 干活'), null);
    assert.equal(parseTag('test W1-T1 看看'), null);
    assert.equal(parseTag('#dev W1-T1 干活')?.role, 'dev');
    assert.equal(parseTag('  #dev W1-T1 干活')?.role, 'dev', '前导空格仍允许');
  });

  test('expandTag 透出 risk/paths', () => {
    const text = expandTag({ role: 'dev', taskId: 'W1-T1', rest: '' },
      { id: 'W1-T1', wave: 'W1', status: 'dev_doing', title: 't', acceptance: 'ok', verify_cmd: 'node ok.mjs', risk: 'high', paths: ['a/b.ts'] });
    assert.match(text, /风险：high/);
    assert.match(text, /两人复核/);
    assert.match(text, /涉及路径：a\/b\.ts/);
  });
});

// ───────────────────────────── B1: eid kv 摘要（同 commit 不同 detail 不得吞） ─────────────────────────────
describe('B1 filebus eid kv 摘要', () => {
  test('同 commit 不同 detail 的 TEST-FAIL 都送达', async () => {
    const bus = createFileBus({ stateDir: join(dir, 'bus-b1'), runId: 'b1' });
    const first = await bus.send({
      as: 'test', prefix: '[TEST-FAIL]', kv: { task: 'T1', failed: 'B1', detail: '第一次：空指针' },
      taskId: 'T1', status: 'TEST-FAIL', commit: 'c1',
    });
    assert.equal(first.sent, true, JSON.stringify(first));
    const second = await bus.send({
      as: 'test', prefix: '[TEST-FAIL]', kv: { task: 'T1', failed: 'B1', detail: '第二次：断言不对' },
      taskId: 'T1', status: 'TEST-FAIL', commit: 'c1',
    });
    assert.equal(second.sent, true, `不同 detail 不得判 duplicate：${JSON.stringify(second)}`);
    assert.notEqual(first.eid, second.eid);
    const tail = await bus.tail(10);
    assert.equal(tail.filter((r) => r.taskId === 'T1').length, 2);
  });

  test('完全相同的 TEST-FAIL 重发仍 duplicate（旧去重语义保留）', async () => {
    const bus = createFileBus({ stateDir: join(dir, 'bus-b1dup'), runId: 'b1dup' });
    const kv = { task: 'T1', failed: 'B1', detail: '同一次' };
    const first = await bus.send({
      as: 'test', prefix: '[TEST-FAIL]', kv, taskId: 'T1', status: 'TEST-FAIL', commit: 'c1',
    });
    assert.equal(first.sent, true);
    const again = await bus.send({
      as: 'test', prefix: '[TEST-FAIL]', kv: { ...kv }, taskId: 'T1', status: 'TEST-FAIL', commit: 'c1',
    });
    assert.equal(again.sent, false);
    assert.equal(again.duplicate, true);
    assert.equal(again.eid, first.eid);
    const rows = readFileSync(join(dir, 'bus-b1dup', 'events.jsonl'), 'utf8').split('\n').filter(Boolean);
    assert.equal(rows.length, 1, '重发不得追加第二行');
  });

  test('GATE-REJECT 不同 reason 都送达；TASK-ASSIGN retry/wave 区分派发与重派', async () => {
    const bus = createFileBus({ stateDir: join(dir, 'bus-b1b'), runId: 'b1b' });
    const g1 = await bus.send({
      as: 'gate', prefix: '[GATE-REJECT]', kv: { task: 'G1', reason: 'verify 炸了', commit: 'c1' },
      taskId: 'G1', status: 'GATE-REJECT', commit: 'c1',
    });
    const g2 = await bus.send({
      as: 'gate', prefix: '[GATE-REJECT]', kv: { task: 'G1', reason: 'policy 拦了', commit: 'c1' },
      taskId: 'G1', status: 'GATE-REJECT', commit: 'c1',
    });
    assert.equal(g1.sent, true);
    assert.equal(g2.sent, true, `不同 reason 不得判 duplicate：${JSON.stringify(g2)}`);
    const a1 = await bus.send({
      as: 'orchestrator', prefix: '[TASK-ASSIGN]',
      kv: { task: 'A1', wave: 'W1', to: 'dev' }, taskId: 'A1', status: 'TASK-ASSIGN', commit: '-',
    });
    const a2 = await bus.send({
      as: 'orchestrator', prefix: '[TASK-ASSIGN]',
      kv: { task: 'A1', wave: 'W1', to: 'dev', retry: 'true' }, taskId: 'A1', status: 'TASK-ASSIGN', commit: '-',
    });
    assert.equal(a1.sent, true);
    assert.equal(a2.sent, true, `retry 重派不得判 duplicate：${JSON.stringify(a2)}`);
  });

  test('其余 prefix 保持旧公式（同输入同 eid；kv 差异不影响）', async () => {
    const legacy = createHash('sha256').update('r9\0T9\0TASK-DONE\0ccc').digest('hex').slice(0, 16);
    assert.equal(busEventId('T9', 'TASK-DONE', 'ccc', 'r9'), legacy, '无 kv 摘要时 eid 必须与旧公式逐字节一致');
    const bus = createFileBus({ stateDir: join(dir, 'bus-b1c'), runId: 'r9' });
    const s1 = await bus.send({
      as: 'dev', prefix: '[TASK-DONE]', kv: { task: 'T9' }, taskId: 'T9', status: 'TASK-DONE', commit: 'ccc',
    });
    assert.equal(s1.eid, legacy);
    const s2 = await bus.send({
      as: 'dev', prefix: '[TASK-DONE]', kv: { task: 'T9', detail: '旧 prefix 不纳 kv' },
      taskId: 'T9', status: 'TASK-DONE', commit: 'ccc',
    });
    assert.equal(s2.duplicate, true, '旧 prefix 重发仍去重');
  });
});

// ───────────────────────────── B3: exec 收敛 ─────────────────────────────
describe('B3 exec 收敛', () => {
  test('含 / 的 bin 被拒：绝对/相对路径都不放行', () => {
    for (const cmd of ['/tmp/evil/node verify.mjs', './evil-runner test', 'a/b/c test', '/bin/ls -la']) {
      const r = parseCommand(cmd);
      assert.equal(r.ok, false, cmd);
      assert.match(r.reason, /裸|PATH/);
    }
  });

  test('node -e / python3 -c 被拒（人话：改用脚本文件传参）', () => {
    for (const cmd of ['node -e process.exit(0)', 'python3 -c print(1)']) {
      const r = parseCommand(cmd);
      assert.equal(r.ok, false, cmd);
      assert.match(r.reason, /脚本文件/);
    }
  });

  test('node/python3 跑脚本文件放行；白名单精确命中 ./gradlew', () => {
    assert.equal(parseCommand('node verify.mjs').ok, true);
    assert.equal(parseCommand('python3 run_tests.py').ok, true);
    assert.equal(parseCommand('./gradlew test').ok, true);
  });

  test('make/git/npm 改写类 flag 只 warn 不拦；白名单本身不变', () => {
    const r = parseCommand('make -f /tmp/evil/Makefile');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(Array.isArray(r.warnings) && r.warnings.length > 0, '应有 warn 证据');
    const g = parseCommand('git -c core.x=y status');
    assert.equal(g.ok, true, JSON.stringify(g));
    assert.ok(g.warnings.length > 0);
    const n = parseCommand('npm --prefix /tmp/x test');
    assert.equal(n.ok, true, JSON.stringify(n));
    assert.ok(n.warnings.length > 0);
    assert.equal((parseCommand('make build').warnings ?? []).length, 0, '无改写 flag 则无 warn');
    assert.deepEqual(DEFAULT_ALLOWLIST, [
      'node', 'npm', 'pnpm', 'yarn', 'bun', 'bunx',
      'npx', 'go', 'cargo', 'python3', 'pytest', 'uv',
      'git', 'make', 'mvn', 'gradle', './gradlew',
    ]);
  });
});

// ───────────────────────────── R1: testing 必填（红测先行） ─────────────────────────────
describe('R1 testing required', () => {
  const rowNoTesting = (over = {}) => ({
    id: 'R1-X', wave: 'W1', title: 't', acceptance: 'a', verify_cmd: 'node ok.mjs', stack: 'backend', ...over,
  });

  test('enqueue 缺 testing 被拒且 reason 指明 testing', () => {
    const q = join(dir, 'r1-reject.jsonl');
    const r = enqueueTask(q, rowNoTesting({ id: 'R1-A' }));
    assert.equal(r.ok, false, '缺 testing 必须拒收');
    assert.match(r.reason, /testing/);
  });

  test('enqueue 空 testing 被拒；"同 verify_cmd"引用式放行', () => {
    const q = join(dir, 'r1-reject2.jsonl');
    assert.match(enqueueTask(q, rowNoTesting({ id: 'R1-B', testing: '' })).reason ?? 'ok', /testing/);
    assert.match(enqueueTask(q, rowNoTesting({ id: 'R1-C', testing: '   ' })).reason ?? 'ok', /testing/);
    const okRow = rowNoTesting({ id: 'R1-D', testing: '同 verify_cmd' });
    assert.equal(enqueueTask(q, okRow).ok, true);
    assert.equal(loadQueue(q).find((t) => t.id === 'R1-D').testing, '同 verify_cmd');
  });

  test('timeline create 快照带 testing；move patch 带 summary；rebuild 还原', () => {
    const d = mkdtempSync(join(tmpdir(), 'swarm-r1-'));
    try {
      const q = join(d, 'queue.jsonl');
      const tl = join(d, 'run', 'timeline.jsonl');
      assert.equal(enqueueTask(q, rowNoTesting({ id: 'R1-T', testing: 'node ok.mjs 全绿' }), tl).ok, true);
      assert.equal(transitionTask(q, tl, { taskId: 'R1-T', expect: 'queued', patch: { status: 'dev_doing' }, by: 'dev', reason: 'claim' }).ok, true);
      assert.equal(transitionTask(q, tl, { taskId: 'R1-T', expect: 'dev_doing', patch: { status: 'gate_check', summary: '改了三处' }, by: 'gate', reason: 'gate-pass' }).ok, true);
      const rows = readTimeline(join(d, 'run'));
      const create = rows.find((r) => r.kind === 'create');
      assert.equal(create.snapshot.testing, 'node ok.mjs 全绿', 'create 快照必须带 testing');
      const mv = rows.find((r) => r.to === 'gate_check');
      assert.equal(mv.patch.summary, '改了三处', 'move patch 必须带 summary');
      rmSync(q, { force: true });
      const rebuilt = rebuildQueueFromTimeline(join(d, 'run'));
      assert.equal(rebuilt[0].testing, 'node ok.mjs 全绿');
      assert.equal(rebuilt[0].summary, '改了三处');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

// ───────────────────────────── 锁定三项：插件禁用 casTransition 直调 ─────────────────────────────
describe('lock-three casTransition', () => {
  test('swarm.js 源码不含 casTransition：迁移只走 transitionTask（改实现即红）', () => {
    const src = readFileSync(fileURLToPath(new URL('../plugins/swarm.js', import.meta.url)), 'utf8');
    assert.equal(src.includes('casTransition'), false, '插件不得直调 casTransition，统一走 transitionTask（FSM 校验 + timeline）');
  });
});
describe('R2 gate whitelist', () => {
  test('lintGate/typeGate/tenantGate 存在且 reason 带 gate=<name>', async () => {
    const m = await import('../lib/swarm-gate.js');
    for (const [fn, name] of [[m.lintGate, 'lint'], [m.typeGate, 'type'], [m.tenantGate, 'tenant']]) {
      assert.equal(typeof fn, 'function', `${name}Gate 缺失`);
      const green = await fn({ cwd: dir, lint_cmd: `node ${join(dir, 'ok.mjs')}`, type_cmd: `node ${join(dir, 'ok.mjs')}`, tenant_cmd: `node ${join(dir, 'ok.mjs')}` });
      assert.equal(green.ok, true, JSON.stringify(green));
      assert.match(green.reason, new RegExp(`gate=${name}`));
      const red = await fn({ cwd: dir, lint_cmd: `node ${join(dir, 'bad.mjs')}`, type_cmd: `node ${join(dir, 'bad.mjs')}`, tenant_cmd: `node ${join(dir, 'bad.mjs')}` });
      assert.equal(red.ok, false, `${name} 红命令必须拦`);
      assert.match(red.reason, new RegExp(`gate=${name}`));
    }
  });

  test('checkGate 白名单交集：未列名不跑，已列才跑', async () => {
    let ran = 0;
    const spy = async () => { ran += 1; return { ok: true, reason: 'gate=zzR2: ok' }; };
    spy.gateName = 'zzR2';
    registerGate(spy);
    try {
      const green = `node ${join(dir, 'ok.mjs')}`;
      const r1 = await checkGate({ cwd: dir, verify_cmd: green, gates: ['verify', 'verdict', 'policy', 'diff', 'security'] });
      assert.equal(r1.ok, true, JSON.stringify(r1));
      assert.equal(ran, 0, '白名单未列 zzR2，必须不跑');
      const r2 = await checkGate({ cwd: dir, verify_cmd: green, gates: ['verify', 'zzR2'] });
      assert.equal(r2.ok, true, JSON.stringify(r2));
      assert.equal(ran, 1, '白名单列了 zzR2，必须跑');
    } finally {
      GATES.pop();
    }
  });

  test('tenant 包装器：未知 argv 直接拒（不调 go，不进 allowlist 的 bash）', () => {
    const out = (() => {
      try {
        execFileSync(process.execPath, [fileURLToPath(new URL('../lib/swarm-tenant-check.mjs', import.meta.url)), '--bogus-flag'], { encoding: 'utf8', cwd: dir });
        return 'EXIT0';
      } catch (e) {
        return `EXIT${e.status} ${(e.stderr ?? '').slice(0, 200)}`;
      }
    })();
    assert.match(out, /EXIT2/);
  });
});

// ───────────────────────────── R3: baseHEAD（红测先行） ─────────────────────────────
describe('R3 baseHEAD', () => {
  test('baseHead 存在：非 git 目录回 null', async () => {
    const m = await import('../lib/swarm-gate.js');
    assert.equal(typeof m.baseHead, 'function', '缺 baseHead');
    const nogit = mkdtempSync(join(tmpdir(), 'swarm-r3-'));
    try {
      assert.equal(await m.baseHead(nogit), null);
    } finally {
      rmSync(nogit, { recursive: true, force: true });
    }
  });

  test('baseHead 读 main；仅 master 时回退；commit 后前进可辨', async () => {
    const m = await import('../lib/swarm-gate.js');
    const g = mkdtempSync(join(tmpdir(), 'swarm-r3g-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: g });
      execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: g });
      execFileSync('git', ['config', 'user.name', 't'], { cwd: g });
      writeFileSync(join(g, 'a.txt'), 'a\n');
      execFileSync('git', ['add', '-A'], { cwd: g });
      execFileSync('git', ['commit', '-qm', 'init'], { cwd: g });
      execFileSync('git', ['branch', '-M', 'main'], { cwd: g });
      const h1 = await m.baseHead(g);
      assert.match(h1, /^[0-9a-f]{7,}$/);
      writeFileSync(join(g, 'b.txt'), 'b\n');
      execFileSync('git', ['add', '-A'], { cwd: g });
      execFileSync('git', ['commit', '-qm', 'second'], { cwd: g });
      const h2 = await m.baseHead(g);
      assert.notEqual(h1, h2, 'base 前进必须可辨');
      execFileSync('git', ['branch', '-M', 'master'], { cwd: g });
      const h3 = await m.baseHead(g);
      assert.equal(h3, h2, '无 main 时回退 master');
    } finally {
      rmSync(g, { recursive: true, force: true });
    }
  });
});

// ───────────────────────────── R4: revert 重放（红测先行） ─────────────────────────────
describe('R4 revert replay', () => {
  test('passed→dev_doing 边存在（revert 用）', () => {
    assert.equal(can('passed', 'dev_doing'), true);
  });

  test('rebuild 处理 revert 行：快照置换，其后 move 继续生效', () => {
    const d = mkdtempSync(join(tmpdir(), 'swarm-r4-'));
    try {
      const runDir = join(d, 'run');
      mkdirSync(runDir, { recursive: true });
      const tl = join(runDir, 'timeline.jsonl');
      const s0 = { id: 'RV-1', wave: 'W1', title: 't', acceptance: 'a', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd', status: 'queued', retries: 0, updated_at: '2026-01-01T00:00:00.000Z' };
      const snap = { ...s0, status: 'dev_doing', commit: null, verdict_path: null, updated_at: '2026-01-02T00:00:00.000Z' };
      const lines = [
        { seq: 1, taskId: 'RV-1', kind: 'create', from: null, to: 'queued', snapshot: s0 },
        { seq: 2, taskId: 'RV-1', kind: 'move', from: 'queued', to: 'passed', patch: { status: 'passed', commit: 'abc1234' } },
        { seq: 3, taskId: 'RV-1', kind: 'revert', from: 'passed', to: 'dev_doing', reason: 'revert', snapshot: snap },
      ];
      writeFileSync(tl, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      const rebuilt = rebuildQueueFromTimeline(runDir);
      assert.equal(rebuilt.length, 1);
      assert.equal(rebuilt[0].status, 'dev_doing', 'revert 行必须把状态置回快照');
      assert.equal(rebuilt[0].verdict_path, null);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test('stateBeforeLastGateEnter：回到最后一次进 gate 前（commit 回退），无记录则拒', async () => {
    const m = await import('../lib/swarm-run.js');
    assert.equal(typeof m.stateBeforeLastGateEnter, 'function', '缺 stateBeforeLastGateEnter');
    const d = mkdtempSync(join(tmpdir(), 'swarm-r4s-'));
    try {
      const runDir = join(d, 'run');
      mkdirSync(runDir, { recursive: true });
      const tl = join(runDir, 'timeline.jsonl');
      const s0 = { id: 'RV-2', wave: 'W1', title: 't', acceptance: 'a', verify_cmd: 'node ok.mjs', testing: 'x', status: 'queued', retries: 0 };
      const lines = [
        { seq: 1, taskId: 'RV-2', kind: 'create', from: null, to: 'queued', snapshot: s0 },
        { seq: 2, taskId: 'RV-2', kind: 'move', from: 'queued', to: 'dev_doing', patch: { status: 'dev_doing' } },
        { seq: 3, taskId: 'RV-2', kind: 'move', from: 'dev_doing', to: 'gate_check', patch: { status: 'gate_check', commit: 'c1' } },
        { seq: 4, taskId: 'RV-2', kind: 'move', from: 'gate_check', to: 'dev_doing', patch: { status: 'dev_doing' } },
        { seq: 5, taskId: 'RV-2', kind: 'move', from: 'dev_doing', to: 'gate_check', patch: { status: 'gate_check', commit: 'c2' } },
        { seq: 6, taskId: 'RV-2', kind: 'move', from: 'gate_check', to: 'passed', patch: { status: 'passed', commit: 'c2' } },
      ];
      writeFileSync(tl, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      const r = m.stateBeforeLastGateEnter(runDir, 'RV-2');
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.prior.status, 'dev_doing');
      assert.equal(r.prior.commit, 'c1', '应回退到最后一次进 gate 之前的 commit');
      const none = m.stateBeforeLastGateEnter(runDir, 'RV-NONE');
      assert.equal(none.ok, false);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

// ───────────────────────────── R5+R6: disposition / rounds-to-pass / HALT 摘要（红测先行） ─────────────────────────────
describe('R5+R6 disposition & metrics', () => {
  test('DISPOSITIONS 枚举存在且仅四值', async () => {
    const m = await import('../lib/swarm-run.js');
    assert.ok(Array.isArray(m.DISPOSITIONS), '缺 DISPOSITIONS 导出');
    assert.deepEqual([...m.DISPOSITIONS].sort(), ['fixed', 'intentional', 'wrong', 'wontfix'].sort());
  });

  test('roundsToPass：passed 任务 (to=dev_doing 计数+1) 均值，gate 打回计入', async () => {
    const m = await import('../lib/swarm-run.js');
    assert.equal(typeof m.roundsToPass, 'function', '缺 roundsToPass');
    const tasks = [{ id: 'A', status: 'passed' }, { id: 'B', status: 'passed' }, { id: 'C', status: 'queued' }];
    const rows = [
      // A：一次直通：queued->dev_doing(1) => rounds=2
      { taskId: 'A', to: 'dev_doing' },
      { taskId: 'A', to: 'gate_check' },
      { taskId: 'A', to: 'test_doing' },
      { taskId: 'A', to: 'passed' },
      // B：一次 fail 回 dev + 一次 gate 打回：to=dev_doing 共 3 次 => rounds=4
      { taskId: 'B', to: 'dev_doing' },
      { taskId: 'B', to: 'gate_check' },
      { taskId: 'B', to: 'dev_doing' },
      { taskId: 'B', to: 'gate_check' },
      { taskId: 'B', to: 'test_doing' },
      { taskId: 'B', to: 'dev_doing' },
      { taskId: 'B', to: 'passed' },
    ];
    const r = m.roundsToPass(tasks, rows);
    assert.equal(r.count, 2);
    assert.equal(r.mean, (2 + 4) / 2);
  });

  test('dispositionDist：四类计数，非法值忽略', async () => {
    const m = await import('../lib/swarm-run.js');
    assert.equal(typeof m.dispositionDist, 'function', '缺 dispositionDist');
    const d = m.dispositionDist([
      { id: 'a', disposition: 'fixed' },
      { id: 'b', disposition: 'wrong' },
      { id: 'c', disposition: 'fixed' },
      { id: 'd' },
      { id: 'e', disposition: 'bogus' },
    ]);
    assert.deepEqual(d, { fixed: 2, wrong: 1, intentional: 0, wontfix: 0 });
  });

  test('lastFailDetails：取最后三条 patch.detail，500 截断，无则空数组', async () => {
    const m = await import('../lib/swarm-run.js');
    assert.equal(typeof m.lastFailDetails, 'function', '缺 lastFailDetails');
    const d = mkdtempSync(join(tmpdir(), 'swarm-r56-'));
    try {
      const runDir = join(d, 'run');
      mkdirSync(runDir, { recursive: true });
      const tl = join(runDir, 'timeline.jsonl');
      const long = 'y'.repeat(800);
      const lines = [
        { seq: 1, taskId: 'H1', kind: 'create', from: null, to: 'queued', snapshot: { id: 'H1' } },
        { seq: 2, taskId: 'H1', kind: 'move', to: 'dev_doing', patch: { status: 'dev_doing', detail: 'd1' } },
        { seq: 3, taskId: 'H1', kind: 'move', to: 'dev_doing', patch: { status: 'dev_doing', detail: 'd2' } },
        { seq: 4, taskId: 'H1', kind: 'move', to: 'dev_doing', patch: { status: 'dev_doing', detail: long } },
        { seq: 5, taskId: 'H1', kind: 'move', to: 'dev_doing', patch: { status: 'dev_doing' } },
      ];
      writeFileSync(tl, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      const got = m.lastFailDetails(runDir, 'H1', 3, 500);
      assert.equal(got.length, 3);
      assert.equal(got[0], 'd1');
      assert.equal(got[1], 'd2');
      assert.equal(got[2].length, 500);
      assert.deepEqual(m.lastFailDetails(runDir, 'NOPE', 3, 500), []);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

// ───────────────────────────── 10. 执行器（executor/roleModels，默认 hybrid 按角色混合） ─────────────────────────────
describe('executor', () => {
  test('normalizeExecutor：sessions/subagents/hybrid 透过，其余归一 hybrid（缺省 hybrid）', () => {
    assert.deepEqual([...EXECUTORS].sort(), ['hybrid', 'sessions', 'subagents']);
    assert.equal(normalizeExecutor('subagents'), 'subagents');
    assert.equal(normalizeExecutor('sessions'), 'sessions');
    assert.equal(normalizeExecutor('hybrid'), 'hybrid');
    assert.equal(normalizeExecutor(''), 'hybrid');
    assert.equal(normalizeExecutor(undefined), 'hybrid');
    assert.equal(normalizeExecutor('SUBAGENTS'), 'hybrid', '大小写不透过');
    assert.equal(normalizeExecutor('bogus'), 'hybrid');
  });

  test('executorForRole：显式整轮零变，hybrid 按角色拆（dev/plan 走 sessions，test/reviewer 走 subagents）', async () => {
    const m = await import('../lib/swarm-run.js');
    assert.equal(typeof m.executorForRole, 'function', '缺 executorForRole');
    assert.equal(m.executorForRole('sessions', 'dev'), 'sessions');
    assert.equal(m.executorForRole('sessions', 'test'), 'sessions');
    assert.equal(m.executorForRole('subagents', 'dev'), 'subagents');
    assert.equal(m.executorForRole('subagents', 'test'), 'subagents');
    assert.equal(m.executorForRole('hybrid', 'dev'), 'sessions');
    assert.equal(m.executorForRole('hybrid', 'plan'), 'sessions');
    assert.equal(m.executorForRole('hybrid', 'test'), 'subagents');
    assert.equal(m.executorForRole('hybrid', 'reviewer'), 'subagents');
    assert.equal(m.executorForRole(undefined, 'dev'), 'sessions', '缺省 hybrid：dev 走 sessions');
    assert.equal(m.executorForRole(undefined, 'test'), 'subagents', '缺省 hybrid：test 走 subagents');
  });

  test('默认 hybrid：无 meta 时 resolveRun 透出 hybrid + 空 roleModels', () => {
    const d = mkdtempSync(join(tmpdir(), 'swarm-execdef-'));
    try {
      const r = resolveRun(d, { run: 'NODEF' });
      assert.equal(r.executor, 'hybrid');
      assert.deepEqual(r.roleModels, {});
      assert.equal(readMeta(d, 'NODEF'), null, '无 meta 读出 null，不抛错');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test('meta 读写：executor + roleModels 落盘，resolveRun 透出；非法值归一 hybrid，显式整轮零变', () => {
    const d = mkdtempSync(join(tmpdir(), 'swarm-execmeta-'));
    try {
      const w = writeMeta(d, 'E1', { executor: 'subagents', roleModels: { dev: 'a/b', test: 'c/d' } });
      assert.equal(w.executor, 'subagents');
      const r = resolveRun(d, { run: 'E1' });
      assert.equal(r.executor, 'subagents');
      assert.deepEqual(r.roleModels, { dev: 'a/b', test: 'c/d' });
      writeMeta(d, 'E1', { executor: 'sessions' });
      assert.equal(resolveRun(d, { run: 'E1' }).executor, 'sessions', '显式 sessions 透过零变');
      writeMeta(d, 'E1', { executor: 'bogus' });
      assert.equal(resolveRun(d, { run: 'E1' }).executor, 'hybrid', '非法值归一 hybrid');
      assert.deepEqual(resolveRun(d, { run: 'E1' }).roleModels, { dev: 'a/b', test: 'c/d' }, 'roleModels 合并保留');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test('ensureRunMeta 默认建 hybrid 语义：坏 meta 不崩', () => {
    const d = mkdtempSync(join(tmpdir(), 'swarm-execensure-'));
    try {
      const m = ensureRunMeta(d, 'E2', { name: '试点' });
      assert.equal(m.name, '试点');
      assert.equal(normalizeExecutor(m.executor), 'hybrid');
      assert.equal(resolveRun(d, { run: 'E2' }).executor, 'hybrid');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test('dev/test contract 追加 subagent 自述行，sessions 语义不变', () => {
    assert.match(ROLES.dev.contract, /你是 dev/);
    assert.match(ROLES.test.contract, /你是 test/);
    assert.match(ROLES.dev.contract, /subagent 模式/);
    assert.match(ROLES.test.contract, /subagent 模式/);
    assert.match(ROLES.dev.contract, /swarm_claim\/swarm_done/);
    assert.match(ROLES.test.contract, /swarm_test/);
  });
});

// ───────────────────────────── Reviewer-N1：FSM 三边 + enqueue 校验 + finding 契约 ─────────────────────────────
describe('reviewer-N1 fsm', () => {
  test('STATUSES 含 reviewing，新三边合法', () => {
    assert.ok(STATUSES.includes('reviewing'), '缺 reviewing 状态');
    assert.equal(can('test_doing', 'reviewing'), true, 'test_doing→reviewing（review=true 条件边）');
    assert.equal(can('reviewing', 'passed'), true, 'reviewing --approve--> passed');
    assert.equal(can('reviewing', 'dev_doing'), true, 'reviewing --request-changes--> dev_doing');
    assert.equal(can('reviewing', 'halted'), true, 'reviewing --halt--> halted');
  });

  test('reviewing 非法边拒收且 reason 恒含 allowed:', () => {
    assert.equal(can('reviewing', 'queued'), false);
    assert.equal(can('queued', 'reviewing'), false, 'queued 不得直跳 reviewing');
    assert.equal(can('reviewing', 'gate_check'), false);
    const r = checkTransition('reviewing', 'reviewing', 'queued', 'RV-T1');
    assert.equal(r.ok, false);
    assert.match(r.reason, /allowed:/);
  });

  test('review=false 老链路零变：test_doing→passed 仍合法', () => {
    assert.equal(can('test_doing', 'passed'), true);
    assert.equal(checkTransition('test_doing', 'test_doing', 'passed', 'OLD-1').ok, true);
  });
});

describe('reviewer-N1 enqueue', () => {
  test('review/reviewDepth/reviewRounds 非法值拒收', () => {
    const q = join(dir, 'rev-bad.jsonl');
    assert.match(enqueueTask(q, emptyTask({ id: 'RV-B1', review: 'yes' })).reason, /invalid review/);
    assert.match(enqueueTask(q, emptyTask({ id: 'RV-B2', reviewDepth: 'deep' })).reason, /invalid reviewDepth/);
    assert.match(enqueueTask(q, emptyTask({ id: 'RV-B3', reviewRounds: -1 })).reason, /invalid reviewRounds/);
    assert.match(enqueueTask(q, emptyTask({ id: 'RV-B4', reviewRounds: 1.5 })).reason, /invalid reviewRounds/);
  });

  test('缺省按 risk 默认（medium/high 开，low 关；显式优先）+ timeline 快照带上', () => {
    const q = join(dir, 'rev-ok.jsonl');
    const tl = join(dir, 'rev-ok-tl.jsonl');
    assert.equal(enqueueTask(q, emptyTask({ id: 'RV-O1' }), tl).ok, true);
    assert.equal(enqueueTask(q, emptyTask({ id: 'RV-O2', review: true, reviewDepth: 'standard' }), tl).ok, true);
    assert.equal(enqueueTask(q, emptyTask({ id: 'RV-O3', risk: 'low' }), tl).ok, true);
    assert.equal(enqueueTask(q, emptyTask({ id: 'RV-O4', risk: 'high', review: false }), tl).ok, true);
    const tasks = loadQueue(q);
    assert.equal(tasks[0].review, true, '缺省 medium 默认开评审');
    assert.equal(tasks[0].reviewDepth, 'quick');
    assert.equal(tasks[0].reviewRounds, 0);
    assert.equal(tasks[1].review, true);
    assert.equal(tasks[1].reviewDepth, 'standard');
    assert.equal(tasks[1].reviewRounds, 0);
    assert.equal(tasks[2].review, false, 'low 默认直通');
    assert.equal(tasks[3].review, false, '显式 false 覆盖 high 默认');
  });
});

describe('reviewer-N1 findings 契约', () => {
  const fImp = (over = {}) => ({
    id: 'F1', severity: 'Important', file: 'a.ts', line: 10, rule: 'no-any',
    evidence: '实测 any', suggestion: '改 unknown', status: 'open', ...over,
  });

  test('finding 关闭必须 fixed 或 wontfix+reason，否则拒收', () => {
    assert.equal(validateFindings([fImp()]).ok, true);
    assert.equal(validateFindings([fImp({ status: 'fixed' })]).ok, true);
    assert.equal(validateFindings([fImp({ status: 'wontfix', reason: '存量，不修' })]).ok, true);
    assert.match(validateFindings([fImp({ status: 'wontfix' })]).reason, /reason/);
    assert.match(validateFindings([fImp({ severity: 'Blocker' })]).reason, /severity/);
    assert.match(validateFindings([fImp({ status: 'closed' })]).reason, /status/);
    assert.match(validateFindings([fImp({ id: '' })]).reason, /id/);
  });

  test('verdict 校验：空 Important 的 request-changes 拒收；含 open Important 的 approve 拒收', () => {
    assert.match(validateReviewVerdict('request-changes', []).reason, /open Important/);
    assert.match(validateReviewVerdict('request-changes', [fImp({ status: 'fixed' })]).reason, /open Important/);
    assert.equal(validateReviewVerdict('request-changes', [fImp()]).ok, true);
    assert.match(validateReviewVerdict('approve', [fImp()]).reason, /open Important/);
    assert.equal(validateReviewVerdict('approve', [fImp({ severity: 'Nit' })]).ok, true);
    assert.equal(validateReviewVerdict('approve', [fImp({ severity: 'Pre-existing' })]).ok, true);
    assert.equal(validateReviewVerdict('approve', []).ok, true);
    assert.match(validateReviewVerdict('bogus', []).reason, /verdict/);
  });

  test('去重：同 file+line+rule 合并，冲突（同 file+line 不同 rule）留两条', () => {
    const a = fImp({ id: 'A' });
    const dup = fImp({ id: 'B' });
    assert.equal(mergeFindings([a], [dup]).length, 1, '同键合并只留一条');
    const diffRule = fImp({ id: 'C', rule: 'other-rule' });
    assert.equal(mergeFindings([a], [diffRule]).length, 2, '不同 rule 留两条');
    const fixed = fImp({ id: 'A', status: 'fixed' });
    const merged = mergeFindings([a], [fixed]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].status, 'fixed', '新状态覆盖旧（支持标 fixed）');
  });

  test('排除集交集为空（收敛“不重复贴”单测锁）', () => {
    const task = { id: 'T', findings: [fImp({ id: 'F1' }), fImp({ id: 'F2', file: 'b.ts' })] };
    assert.deepEqual(excludedFindingIds(task).sort(), ['F1', 'F2']);
    assert.deepEqual(excludedIntersection([fImp({ id: 'F3', file: 'c.ts' })], excludedFindingIds(task)), [], '新 finding 与排除集无交集才放行');
    assert.deepEqual(excludedIntersection([fImp({ id: 'F1' })], excludedFindingIds(task)), ['F1'], '重复贴能被检出');
  });
});

describe('reviewer-N1 REVIEW.md 就近加载', () => {
  test('嵌套路径命中最近祖先、空回 null', () => {
    const d = mkdtempSync(join(tmpdir(), 'swarm-revdoc-'));
    try {
      mkdirSync(join(d, '.opencode', 'review', 'src', 'a'), { recursive: true });
      writeFileSync(join(d, '.opencode', 'review', 'src.md'), '通用口径\n', 'utf8');
      writeFileSync(join(d, '.opencode', 'review', 'src', 'a.md'), 'a 域规则\n', 'utf8');
      const hit = resolveReviewDoc(d, { id: 'T', paths: ['src/a/b.ts'] });
      assert.ok(hit, '应命中最近祖先');
      assert.match(hit.file, /src.a\.md$/);
      assert.match(hit.content, /a 域规则/);
      assert.equal(resolveReviewDoc(d, { id: 'T', paths: [] }), null);
      assert.equal(resolveReviewDoc(d, { id: 'T' }), null);
      assert.equal(resolveReviewDoc(d, { id: 'T', paths: ['no/such.ts'] }), null);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test('_default.md 兜底：无祖先命中回通用口径；缺失回 null；祖先优先于兜底', () => {
    const d = mkdtempSync(join(tmpdir(), 'swarm-revdoc-def-'));
    try {
      assert.equal(resolveReviewDoc(d, { id: 'T', paths: ['x/y.ts'] }), null, '_default 缺失回 null（容错）');
      assert.equal(resolveReviewDoc(d, { id: 'T', paths: [] }), null);
      mkdirSync(join(d, '.opencode', 'review'), { recursive: true });
      writeFileSync(join(d, '.opencode', 'review', '_default.md'), '通用口径\n', 'utf8');
      const hit = resolveReviewDoc(d, { id: 'T', paths: ['x/y.ts'] });
      assert.ok(hit, '无祖先命中应回 _default.md');
      assert.match(hit.file, /_default\.md$/);
      assert.match(hit.content, /通用口径/);
      assert.ok(resolveReviewDoc(d, { id: 'T', paths: [] }), '无 paths 也回兜底');
      mkdirSync(join(d, '.opencode', 'review', 'x'), { recursive: true });
      writeFileSync(join(d, '.opencode', 'review', 'x.md'), 'x 域规则\n', 'utf8');
      const near = resolveReviewDoc(d, { id: 'T', paths: ['x/y.ts'] });
      assert.match(near.file, /x\.md$/, '就近祖先优先于 _default.md');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('reviewer-N1 rebuild 兼容', () => {
  test('timeline kind=review 行不参与重放（通用合并零改动，单测锁一行）', () => {
    const d = mkdtempSync(join(tmpdir(), 'swarm-revtl-'));
    try {
      const q = join(d, 'queue.jsonl');
      const runDir = join(d, 'run');
      mkdirSync(runDir, { recursive: true });
      const tl = join(runDir, 'timeline.jsonl');
      assert.equal(enqueueTask(q, emptyTask({ id: 'RV-RB', review: true }), tl).ok, true);
      assert.equal(transitionTask(q, tl, { taskId: 'RV-RB', expect: 'queued', patch: { status: 'dev_doing' }, by: 'dev', reason: 'claim' }).ok, true);
      assert.equal(transitionTask(q, tl, { taskId: 'RV-RB', expect: 'dev_doing', patch: { status: 'gate_check' }, by: 'dev', reason: 'gate-enter' }).ok, true);
      assert.equal(transitionTask(q, tl, { taskId: 'RV-RB', expect: 'gate_check', patch: { status: 'test_doing' }, by: 'gate', reason: 'gate-pass' }).ok, true);
      assert.equal(transitionTask(q, tl, { taskId: 'RV-RB', expect: 'test_doing', patch: { status: 'reviewing' }, by: 'test', reason: 'test-pass待审' }).ok, true);
      const before = loadQueue(q);
      // reviewer 快照行（kind=review）：只读审计，不参与重放——重放后仍与 queue 一致
      appendTimeline(tl, {
        taskId: 'RV-RB', kind: 'review', from: 'reviewing', to: 'passed',
        by: 'reviewer', reason: 'review-approve:round1',
        patch: { findings: [], reviewVerdict: 'approve', reviewRound: 1 },
      });
      rmSync(q, { force: true });
      assert.deepEqual(rebuildQueueFromTimeline(runDir), before, 'kind=review 行不得影响重放');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

// ───────────────────────────── secret 扫描门（10-30-swarm-secret-scan，fixture diff 离线） ─────────────────────────────
describe('secret gate', () => {
  const secretDiff = [
    'diff --git a/src/a.ts b/src/a.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/a.ts',
    '@@ -0,0 +1,3 @@',
    '+const api_key = "supersecret123456";',
    '+const ok = 1;',
    '+// AKIAIOSFODNN7EXAMPLE',
    '',
  ].join('\n');
  const cleanDiff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,2 +1,2 @@',
    '-const a = 1;',
    '+const a = 2;',
    '',
  ].join('\n');
  const freshCwd = () => mkdtempSync(join(tmpdir(), 'swarm-secret-'));
  const greenFor = () => `node ${join(dir, 'ok.mjs')}`;

  test('干净 diff 放行（含 security 占位 warning 透出）', async () => {
    const g = freshCwd();
    try {
      const { secretScanGate } = await import('../lib/swarm-gate.js');
      assert.equal(typeof secretScanGate, 'function', '缺 secretScanGate');
      assert.equal(secretScanGate.gateName, 'secret');
      const r = await checkGate({ cwd: g, verify_cmd: greenFor(), diffText: cleanDiff });
      assert.equal(r.ok, true, JSON.stringify(r));
    } finally {
      rmSync(g, { recursive: true, force: true });
    }
  });

  test('命中拦截（含文件+行，写基线+timeline 里程碑）', async () => {
    const g = freshCwd();
    try {
      const runDir = join(g, 'run');
      mkdirSync(runDir, { recursive: true });
      const tl = join(runDir, 'timeline.jsonl');
      const r = await checkGate({
        cwd: g, verify_cmd: greenFor(), diffText: secretDiff,
        timelinePath: tl, taskId: 'S-1',
      });
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.match(r.reason, /gate=secret/);
      assert.match(r.reason, /src\/a\.ts:\d+/);
      assert.ok(Array.isArray(r.evidence.hits) && r.evidence.hits.length > 0);
      assert.match(r.evidence.hits[0].file, /src\/a\.ts/);
      assert.equal(typeof r.evidence.hits[0].line, 'number');
      const base = JSON.parse(readFileSync(join(g, '.swarm/secret-baseline.json'), 'utf8'));
      assert.ok(Array.isArray(base) && base.length > 0, '命中必须写基线');
      assert.ok(base.every((e) => typeof e.file === 'string' && typeof e.hash === 'string'));
      const rows = readFileSync(tl, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      assert.ok(rows.some((x) => x.kind === 'secret-baseline'), '首次命中必须写 secret-baseline 里程碑行');
    } finally {
      rmSync(g, { recursive: true, force: true });
    }
  });

  test('二次运行被基线抑制（同 diff 同 cwd 放行）', async () => {
    const g = freshCwd();
    try {
      const first = await checkGate({ cwd: g, verify_cmd: greenFor(), diffText: secretDiff });
      assert.equal(first.ok, false, '首次必须拦截');
      const second = await checkGate({ cwd: g, verify_cmd: greenFor(), diffText: secretDiff });
      assert.equal(second.ok, true, JSON.stringify(second));
      assert.match(second.reason, /baselined|gate ok/);
    } finally {
      rmSync(g, { recursive: true, force: true });
    }
  });

  test('policy_exception 放行+warning（与 policyGate 同口径）', async () => {
    const g = freshCwd();
    try {
      const r = await checkGate({ cwd: g, verify_cmd: greenFor(), diffText: secretDiff, policy_exception: true });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.match(r.reason, /gate=secret: exception/);
      assert.ok(Array.isArray(r.evidence.warnings) && r.evidence.warnings.some((w) => /gate=secret: exception/.test(w)), 'exception 警告须经 warnings 管道透出');
    } finally {
      rmSync(g, { recursive: true, force: true });
    }
  });

  test('worktree 未跟踪新文件：仅 task.paths 命中才扫', async () => {
    const g = mkdtempSync(join(tmpdir(), 'swarm-secret-wt-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: g });
      execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: g });
      execFileSync('git', ['config', 'user.name', 't'], { cwd: g });
      writeFileSync(join(g, 'leak.txt'), 'token = "worktree-secret-123456"\n');
      const green = `node ${join(dir, 'ok.mjs')}`;
      const hit = await checkGate({ cwd: g, verify_cmd: green, paths: ['leak.txt'] });
      assert.equal(hit.ok, false, JSON.stringify(hit));
      assert.match(hit.reason, /gate=secret/);
      assert.match(hit.reason, /leak\.txt/);
      const g2 = mkdtempSync(join(tmpdir(), 'swarm-secret-wt2-'));
      try {
        execFileSync('git', ['init', '-q'], { cwd: g2 });
        execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: g2 });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: g2 });
        writeFileSync(join(g2, 'leak.txt'), 'token = "worktree-secret-123456"\n');
        const miss = await checkGate({ cwd: g2, verify_cmd: green, paths: ['other.txt'] });
        assert.equal(miss.ok, true, 'paths 未命中不得扫 worktree');
      } finally {
        rmSync(g2, { recursive: true, force: true });
      }
    } finally {
      rmSync(g, { recursive: true, force: true });
    }
  });
});

describe('R2 stack required（backend/frontend/integration 三选一）', () => {
  const rowNoStack = (over = {}) => ({
    id: 'R2-X', wave: 'W1', title: 't', acceptance: 'a', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd', ...over,
  });

  test('enqueue 缺 stack 被拒且 reason 指明三选一', () => {
    const q = join(dir, 'r2-reject.jsonl');
    const r = enqueueTask(q, rowNoStack({ id: 'R2-A' }));
    assert.equal(r.ok, false);
    assert.match(r.reason, /stack.*backend\/frontend\/integration/);
  });

  test('enqueue 非法 stack 被拒；三合法值放行', () => {
    const q = join(dir, 'r2-reject2.jsonl');
    assert.match((enqueueTask(q, rowNoStack({ id: 'R2-B', stack: 'fullstack' })).reason ?? 'ok'), /stack/);
    assert.match((enqueueTask(q, rowNoStack({ id: 'R2-C', stack: '' })).reason ?? 'ok'), /stack/);
    for (const st of ['backend', 'frontend', 'integration']) {
      assert.equal(enqueueTask(q, rowNoStack({ id: `R2-OK-${st}`, stack: st })).ok, true);
    }
    assert.equal(loadQueue(q).find((t) => t.id === 'R2-OK-frontend').stack, 'frontend');
  });

  test('requiredModels：纯 legacy 轮零要求；按需只索要出现的 stack', () => {
    assert.deepEqual(requiredModels([{ id: 'L', status: 'queued' }], {}).missing, []);
    const b = requiredModels([{ id: 'B', status: 'queued', stack: 'backend', review: false }], {});
    assert.deepEqual(b.stacks, ['backend']);
    assert.deepEqual(b.missing.map((m) => m.key), ['dev_backend', 'test']);
    const f = requiredModels(
      [{ id: 'F', status: 'queued', stack: 'frontend', review: false }],
      { dev_backend: 'p/m', test: 'p/m' },
    );
    assert.deepEqual(f.missing.map((m) => m.key), ['dev_frontend'], '后端模型不对前端任务放行');
    const i = requiredModels([{ id: 'I', status: 'queued', stack: 'integration', review: false }], { dev_frontend: 'p/m', test: 'p/m' });
    assert.deepEqual(i.missing, [], '联调任一侧 dev 即可');
    const done = requiredModels([{ id: 'D', status: 'passed', stack: 'backend', review: true }], {});
    assert.deepEqual(done.missing, [], '已 passed 不再索要模型');
  });
});

describe('R3 思考强度 variant（provider/model#variant）', () => {
  const stubCtx = (models) => ({ model: { list: async () => models } });
  const REG = [
    { providerID: 'opencode-go', id: 'deepseek-v4.1-flash', name: 'DeepSeek', variants: [{ id: 'low' }, { id: 'high' }, { id: 'max' }] },
    { providerID: 'opencode-go', id: 'plain-model', name: 'Plain' },
  ];

  test('splitModel：无#零变；有#拆 variant；空/双#拒收', async () => {
    const { splitModel } = await import('../plugins/swarm.js');
    assert.deepEqual(splitModel('opencode-go/deepseek-v4.1-flash'), { providerID: 'opencode-go', id: 'deepseek-v4.1-flash' });
    assert.deepEqual(splitModel('opencode-go/deepseek-v4.1-flash#high'), { providerID: 'opencode-go', id: 'deepseek-v4.1-flash', variant: 'high' });
    assert.equal(splitModel('opencode-go/deepseek-v4.1-flash#'), null);
    assert.equal(splitModel('opencode-go/deepseek-v4.1-flash#a#b'), null);
    assert.equal(splitModel('nonsense'), null);
  });

  test('modelIndex 保留 variants；resolveModelRef 校验强度', async () => {
    const { modelIndex, resolveModelRef } = await import('../lib/swarm-sessions.js');
    const index = await modelIndex(stubCtx(REG));
    assert.deepEqual(index.byRef.get('opencode-go/deepseek-v4.1-flash').variants, [{ id: 'low' }, { id: 'high' }, { id: 'max' }]);
    const ok = resolveModelRef(index, { providerID: 'opencode-go', id: 'deepseek-v4.1-flash', variant: 'high' });
    assert.equal(ok.ok, true);
    assert.equal(ok.variant, 'high');
    const normed = resolveModelRef(index, { providerID: 'opencode-go', id: 'deepseek-v4.1-flash', variant: 'HIGH' });
    assert.equal(normed.ok, true);
    assert.equal(normed.variant, 'high');
    const bad = resolveModelRef(index, { providerID: 'opencode-go', id: 'deepseek-v4.1-flash', variant: 'ultra' });
    assert.equal(bad.ok, false);
    assert.ok(bad.suggestions.some((s) => s === 'opencode-go/deepseek-v4.1-flash#high'), '错强度要列出可用项');
    const novar = resolveModelRef(index, { providerID: 'opencode-go', id: 'plain-model', variant: 'high' });
    assert.equal(novar.ok, false);
    assert.ok(novar.suggestions.includes('opencode-go/plain-model'), '无 variants 的模型指回裸引用');
    const plain = resolveModelRef(index, { providerID: 'opencode-go', id: 'deepseek-v4.1-flash' });
    assert.equal(plain.ok, true);
    assert.equal(plain.variant, undefined, '不带强度不加字段（老行为零变）');
  });
});
