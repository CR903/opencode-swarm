/**
 * Swarm 端到端回归（node --test）
 *
 *   node --test .opencode/plugins/swarm.e2e.test.mjs
 *
 * 用假 ctx 加载真实插件，跑完整编排闭环：
 *   入队 → 门禁拒绝 → 修好 → 放行 → test fail → 回 dev → pass → 下一任务 → 3-strike halt
 * 外加：tag 注入、状态命令、越权迁移被拒。
 *
 * 不联网、不碰真实仓库、无外部二进制（FileBus 本地写 events.jsonl，正好验证耐久性）。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import plugin, { liveTasks, LIVE_STATUSES, DRAINED_RECIPE, DRAINED_END_LINE, SUBAGENT_TAG_WARN } from '../plugins/swarm.js';

let dir;
let ctx;
let prompts;
let promptCalls;
let tools;
let cmds;
let sessions;
let hooks = {};
let promptHook;

/**
 * e2e 默认绕过 P1 start 闸门：这些用例测的是门禁/FSM/评审等其它语义，
 * 统一带 force:true 认领；闸门本身由「start 闸门」用例直调 tools.execute 验证。
 */
const withForce = (name, input) => (name === 'swarm_claim' || name === 'swarm_next')
  ? { force: true, ...input }
  : input;
const run = async (name, input) => (await tools.get(name).execute(withForce(name, input))).content;
const cmd = async (name, text = '', sessionID = 's1') => {
  await cmds.get(name).execute({ sessionID, prompt: { text } });
  return prompts.at(-1);
};
const queueState = () => JSON.parse('[' + readFileSync(join(dir, '.trellis/swarm-queue.jsonl'), 'utf8')
  .split('\n').filter(Boolean).join(',') + ']');
const roundState = () => JSON.parse(readFileSync(join(dir, '.trellis/swarm-state/round.json'), 'utf8'));

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'swarm-e2e-'));
  // 造一个真 git 仓 + 一个会失败的验收脚本
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  writeFileSync(join(dir, 'data.json'), '{"n":1}\n');
  writeFileSync(join(dir, 'verify.mjs'),
    'import { readFileSync } from "node:fs";\n' +
    'const d = JSON.parse(readFileSync(new URL("./data.json", import.meta.url)));\n' +
    'process.exit(d.n === 2 ? 0 : 1);\n');
  // B3 收敛后 node -e 不再可用：回归用脚本文件代替内联代码
  writeFileSync(join(dir, 'ok.mjs'), 'process.exit(0);\n');
  writeFileSync(join(dir, 'bad.mjs'), 'process.exit(1);\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });

  prompts = [];
  promptCalls = [];
  tools = new Map();
  cmds = new Map();
  sessions = new Map();
  let seq = 0;
  ctx = {
    location: { directory: dir },
    options: { queue: '.trellis/swarm-queue.jsonl', channel: 'swarm-e2e-none', maxRetries: 3, verifyTimeoutMs: 20_000 },
    // 模型注册表：两个可用模型；'opencode-go/retired-model' 故意不存在
    model: {
      list: async () => [
        { providerID: 'opencode-go', id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
        { providerID: 'opencode-go', id: 'muse-spark-1.3-contributor', name: 'Muse Spark' },
      ],
    },
    session: {
      prompt: async ({ sessionID, text }) => { promptCalls.push({ sessionID, text }); prompts.push(text); },
      create: async ({ title, agent, model }) => {
        const id = `sess-${++seq}`;
        sessions.set(id, { id, title, agent, model });
        return { id, title };
      },
      get: async ({ sessionID }) => sessions.get(sessionID),
      update: async ({ sessionID, title }) => {
        const s = sessions.get(sessionID) ?? { id: sessionID };
        s.title = title;
        sessions.set(sessionID, s);
      },
      switchModel: async () => {},
      hook: async (name, fn) => { hooks[name] = fn; if (name === 'prompt') promptHook = fn; },
    },
    command: { transform: async (fn) => fn({ add: (d) => cmds.set(d.name, d) }) },
    tool: { transform: async (fn) => fn({ add: (d) => tools.set(d.name, d) }) },
  };
  await plugin.setup(ctx);
});

after(() => { rmSync(dir, { recursive: true, force: true }); });

describe('插件注册面', () => {
  test('17 个命令 + 11 个工具全部注册（N1 新增 swarm_review；drained 新增只读 swarm-drained；clean 新增归档 swarm-clean；orchestrate 新增 swarm_halt/swarm_revert/swarm_config；eval 新增只读 swarm-eval；approve 新增 swarm_approve；npm 包新增 swarm-init）', () => {
    assert.deepEqual([...cmds.keys()].sort(),
      ['swarm-clean', 'swarm-drained', 'swarm-eval', 'swarm-halt', 'swarm-init', 'swarm-migrate', 'swarm-mode', 'swarm-models', 'swarm-nightly', 'swarm-rebuild', 'swarm-retry', 'swarm-revert', 'swarm-runs', 'swarm-start', 'swarm-status', 'swarm-switch', 'swarm-up']);
    assert.deepEqual([...tools.keys()].sort(),
      ['swarm_approve', 'swarm_claim', 'swarm_config', 'swarm_done', 'swarm_halt', 'swarm_next', 'swarm_plan', 'swarm_read_queue', 'swarm_revert', 'swarm_review', 'swarm_test']);
  });

  test('prompt hook 已注册（tag 唤起的前提）', () => {
    assert.equal(typeof promptHook, 'function');
  });
});

describe('planning', () => {
  test('planner 批量入队，缺字段被拒', async () => {
    const out = await run('swarm_plan', {
      tasks: [
        { id: 'W1-T1', wave: 'W1', title: '把 n 改成 2', acceptance: 'verify.mjs exit 0', verify_cmd: 'node verify.mjs', testing: 'node verify.mjs 全绿' , review: false},
        { id: 'W1-BAD', wave: 'W1', title: '缺 verify', testing: 'x' , review: false}, // 应被拒（缺 verify_cmd/acceptance）
      ],
    });
    assert.match(out, /W1-T1: queued/);
    assert.match(out, /W1-BAD: missing\/invalid field/);
    const s = queueState();
    assert.equal(s.length, 1);
    assert.equal(s[0].status, 'queued');
  });
});

describe('dev → gate → test 闭环', () => {
  test('claim 成功', async () => {
    const out = await run('swarm_claim', { task_id: 'W1-T1', role: 'dev' });
    assert.match(out, /已认领 W1-T1/);
    assert.equal(queueState()[0].status, 'dev_doing');
  });

  test('编排预占后同归属 claim 给可继续信号（非失败）', async () => {
    const out = await run('swarm_claim', { task_id: 'W1-T1', role: 'dev' });
    assert.match(out, /可继续/);
    assert.match(out, /编排预派发/);
    assert.match(out, /验收/);
    assert.match(out, /验证命令/);
    assert.equal(queueState()[0].status, 'dev_doing', '可继续不改状态');
  });

  test('他人持有时 claim 仍被拒（不双花）', async () => {
    const out = await run('swarm_claim', { task_id: 'W1-T1', role: 'test' });
    assert.match(out, /认领失败/);
    assert.doesNotMatch(out, /可继续/);
  });

  test('代码没改时门禁拒绝，且状态不动', async () => {
    const out = await run('swarm_done', { task_id: 'W1-T1', summary: '还没改，试红' });
    assert.match(out, /门禁拒绝/);
    assert.equal(queueState()[0].status, 'dev_doing', '被拒后不得前进');
  });

  test('修好后门禁放行 → test_doing 且记录 commit', async () => {
    writeFileSync(join(dir, 'data.json'), '{"n":2}\n');
    const out = await run('swarm_done', { task_id: 'W1-T1', summary: 'n 改成 2' });
    assert.match(out, /门禁通过/);
    const t = queueState()[0];
    assert.equal(t.status, 'test_doing');
    assert.match(t.commit, /^[0-9a-f]{7,}$/);
  });

  test('test 判 fail → 回 dev 且 retries+1', async () => {
    const out = await run('swarm_test', { task_id: 'W1-T1', pass: false, failed_ids: 'B1', detail: '实测 n=3', disposition: 'fixed' });
    assert.match(out, /回 dev/);
    assert.equal(queueState()[0].retries, 1);
    assert.equal(queueState()[0].status, 'dev_doing');
  });

  test('非 test_doing 状态下 test 越权被拒', async () => {
    const out = await run('swarm_test', { task_id: 'W1-T1', pass: true });
    assert.match(out, /状态不对/);
  });
});

describe('放行与推进', () => {
  test('fail 后重做 → 再 done → pass → passed 并自动派下一单', async () => {
    await run('swarm_claim', { task_id: 'W1-T1' }); // dev_doing 同归属：可继续信号，不崩
    await run('swarm_done', { task_id: 'W1-T1', summary: '重做通过' });
    assert.equal(queueState()[0].status, 'test_doing');

    await run('swarm_plan', {
      tasks: [{ id: 'W1-T2', wave: 'W1', title: '第二个', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false}],
    });
    const out = await run('swarm_test', { task_id: 'W1-T1', pass: true });
    assert.match(out, /通过/);
    assert.match(out, /已派发 W1-T2/);

    const s = queueState();
    const t1 = s.find((x) => x.id === 'W1-T1');
    const t2 = s.find((x) => x.id === 'W1-T2');
    assert.equal(t1.status, 'passed');
    assert.equal(t2.status, 'dev_doing', '下一单应已自动派给 dev');
  });

  test('队列清空后 pass 报告 drained', async () => {
    await run('swarm_done', { task_id: 'W1-T2', summary: '第二个做完' });
    const out = await run('swarm_test', { task_id: 'W1-T2', pass: true });
    assert.match(out, /队列已清空/);
  });
});

describe('start 预占后 claim（编排派发语义锁死）', () => {
  test('start 预占后同任务 claim 返回可继续信号', async () => {
    await run('swarm_plan', {
      tasks: [{ id: 'W-CONT', wave: 'W9', title: '预占演练', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false}],
    });
    const started = await cmd('swarm-start', '');
    assert.match(started, /已派发 W-CONT/);
    const out = await run('swarm_claim', { task_id: 'W-CONT', role: 'dev' });
    assert.match(out, /可继续/);
    assert.match(out, /编排预派发/);
    const t = queueState().find((x) => x.id === 'W-CONT');
    assert.equal(t.status, 'dev_doing');
    assert.equal(t.assignee, 'dev');
  });

  test('预占任务走完闭环（清场，不影响后续）', async () => {
    await run('swarm_done', { task_id: 'W-CONT', summary: '预占演练做完' });
    const out = await run('swarm_test', { task_id: 'W-CONT', pass: true });
    assert.match(out, /队列已清空/);
    assert.equal(queueState().find((x) => x.id === 'W-CONT').status, 'passed');
  });
});

describe('3-strike halt 与人工介入', () => {
  test('连续 3 次 fail → halted', async () => {
    await run('swarm_plan', {
      tasks: [{ id: 'W1-T3', wave: 'W1', title: '永远失败', acceptance: 'never', verify_cmd: 'node bad.mjs', testing: '恒红' , review: false}],
    });
    await run('swarm_claim', { task_id: 'W1-T3' });
    // 门禁会拒绝红色 verify，故手工走 gate_check 中间态推进到 test_doing 以验证 halt 逻辑；
    // 走 transitionTask（带 timeline，合法边 dev_doing→gate_check→test_doing），rebuild 才能与 queue 对上。
    const { transitionTask } = await import('../lib/swarm-store.js');
    const { resolveRun } = await import('../lib/swarm-run.js');
    const qp = join(dir, '.trellis/swarm-queue.jsonl');
    const tp = resolveRun(dir, { run: 'default', queue: '.trellis/swarm-queue.jsonl' }).timelinePath;
    const push = () => {
      const a = transitionTask(qp, tp, {
        taskId: 'W1-T3', expect: 'dev_doing',
        patch: { status: 'gate_check' }, by: 'dev', reason: 'setup-push-enter',
      });
      if (!a.ok) return a;
      return transitionTask(qp, tp, {
        taskId: 'W1-T3', expect: 'gate_check',
        patch: { status: 'test_doing', assignee: 'test' }, by: 'gate', reason: 'setup-push-pass',
      });
    };
    assert.equal(push().ok, true);

    let last;
    for (let i = 0; i < 3; i++) {
      last = await run('swarm_test', { task_id: 'W1-T3', pass: false, failed_ids: `X${i}`, detail: `挂${i}`, disposition: 'fixed' });
      if (i < 2) assert.equal(push().ok, true);
    }
    assert.match(last, /HALT/);
    assert.equal(queueState().find((t) => t.id === 'W1-T3').status, 'halted');
    assert.equal(queueState().find((t) => t.id === 'W1-T3').retries, 3);
  });

  test('/swarm-retry 把 halted 拉回 dev_doing 且 retries 归零', async () => {
    const out = await cmd('swarm-retry', '--task W1-T3');
    assert.match(out, /已重派/);
    const t = queueState().find((x) => x.id === 'W1-T3');
    assert.equal(t.status, 'dev_doing');
    assert.equal(t.retries, 0);
  });

  test('/swarm-halt 人工熔断', async () => {
    const out = await cmd('swarm-halt', '--task W1-T3 --reason 先停一下');
    assert.match(out, /已熔断/);
    assert.equal(queueState().find((t) => t.id === 'W1-T3').status, 'halted');
  });

  test('/swarm-halt 对不存在任务给提示而非崩溃', async () => {
    const out = await cmd('swarm-halt', '--task NOPE-1');
    assert.match(out, /熔断失败/);
  });
});

describe('/swarm-status', () => {
  test('输出队列表与通道段（含 FileBus 事件尾）', async () => {
    const out = await cmd('swarm-status');
    assert.match(out, /## swarm-status/);
    assert.match(out, /W1-T3/);
    assert.match(out, /### 通道最近事件/);
    assert.match(out, /- seq\d+ \S+: /s, '通道尾应列出 FileBus 事件行，而非 (无)');
  });
});

describe('tag 唤起', () => {
  test('#dev + 任务号 注入角色契约与任务详情（不复读原话）', async () => {
    const ev = { prompt: { text: '#dev W1-T1 顺手加注释' } };
    await promptHook(ev);
    assert.match(ev.prompt.text, /你是 dev/);
    assert.match(ev.prompt.text, /node verify\.mjs/);
    assert.match(ev.prompt.text, /顺手加注释/);
    assert.doesNotMatch(ev.prompt.text, /用户原话：/);
    assert.equal(ev.prompt.text.split('顺手加注释').length - 1, 1, '补充要求在展开结果中恰出现一次（不再复读原话全文）');
  });

  test('#plan 长需求正文在展开结果中恰出现一次', async () => {
    const need = '把登录页背景换成深蓝渐变且按钮圆角加大';
    const ev = { prompt: { text: `#plan 拆解 ${need}` } };
    await promptHook(ev);
    assert.match(ev.prompt.text, /你是 planner/);
    assert.doesNotMatch(ev.prompt.text, /用户原话：/);
    assert.equal(ev.prompt.text.split(need).length - 1, 1, '长需求正文恰出现一次');
    await new Promise((r) => setTimeout(r, 20)); // #plan 改名 fire-and-forget 落定
  });

  test('裸 tag 无"用户原话"尾巴', async () => {
    const ev = { prompt: { text: '#dev W1-T1' } };
    await promptHook(ev);
    assert.match(ev.prompt.text, /你是 dev/);
    assert.doesNotMatch(ev.prompt.text, /用户原话：/);
  });

  test('#test 注入 tester 契约', async () => {
    const ev = { prompt: { text: '#test W1-T2' } };
    await promptHook(ev);
    assert.match(ev.prompt.text, /你是 test/);
  });

  test('普通文本不被改写', async () => {
    const ev = { prompt: { text: '这个 bug 怎么修？' } };
    await promptHook(ev);
    assert.equal(ev.prompt.text, '这个 bug 怎么修？');
  });

  test('未知 tag 不误伤', async () => {
    const ev = { prompt: { text: '#foobar 随便说说' } };
    await promptHook(ev);
    assert.equal(ev.prompt.text, '#foobar 随便说说');
  });
});

describe('事件耐久性（FileBus 本地审计）', () => {
  test('事件落 .swarm/runs/default/events.jsonl（不丢、无 outbox）', () => {
    const eventsFile = join(dir, '.swarm/runs/default/events.jsonl');
    assert.ok(existsSync(eventsFile), 'events.jsonl 应已生成');
    const rows = readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(rows.length > 0, `events 应有记录，实际 ${rows.length}`);
    const seqs = rows.map((r) => r.seq);
    assert.deepEqual([...seqs].sort((a, b) => a - b), seqs, 'seq 应单调递增');
    assert.equal(new Set(seqs).size, seqs.length, 'seq 不得重号');
    assert.ok(rows.every((r) => typeof r.eid === 'string' && typeof r.text === 'string' && typeof r.ts === 'string'),
      '每行应含 eid/text/ts');
    const prefixes = rows.map((r) => r.text.split(' ')[0]).join(',');
    assert.match(prefixes, /\[TASK-ASSIGN\]/, '应有派发事件');
    assert.ok(!existsSync(join(dir, '.trellis/swarm-state/outbox.jsonl')), 'FileBus 不得再建 outbox');
    assert.ok(!existsSync(join(dir, '.swarm/runs/default/outbox.jsonl')), 'FileBus 不得再建 outbox');
  });
});

describe('/swarm-up', () => {
  test('默认主会话即 planner：只建 dev/test，plan 指向本会话', async () => {
    const out = await cmd('swarm-up',
      '--planner-model opencode-go/deepseek-v4.1-flash --dev-model opencode-go/muse-spark-1.3-contributor --tester-model opencode-go/deepseek-v4.1-flash --executor sessions');
    assert.match(out, /## swarm-up/);
    assert.match(out, /plan ✓ `s1` · 本会话（主会话即 planner/);
    assert.match(out, /dev .*opencode-go\/muse-spark-1\.3-contributor/);
    assert.match(out, /test /);
    assert.match(out, /未 start 前 dev\/test 认领会被拒/);
  });

  test('模型不存在 → 一个会话都不建，并给出候选', async () => {
    const before = sessions.size;
    const out = await cmd('swarm-up', '--planner-model opencode-go/retired-model');
    assert.match(out, /未创建任何会话/);
    assert.match(out, /没有模型 "retired-model"/);
    assert.match(out, /你是不是想用/);
    assert.equal(sessions.size, before, '校验失败不得留下半成品会话');
  });

  test('provider 大小写写错 → 报错并给出确切写法', async () => {
    const out = await cmd('swarm-up', '--dev-model OpenCode/deepseek-v4.1-flash');
    assert.match(out, /未创建任何会话/);
    assert.match(out, /opencode-go\/deepseek-v4\.1-flash/);
  });

  test('模型格式写错（缺 provider）→ 明确提示格式', async () => {
    const out = await cmd('swarm-up', '--dev-model deepseek-v4.1-flash');
    assert.match(out, /格式不对/);
    assert.match(out, /provider\/model/);
  });

  test('--dry-run 只校验不建会话', async () => {
    const before = sessions.size;
    const out = await cmd('swarm-up', '--dry-run --dev-model opencode-go/deepseek-v4.1-flash');
    assert.match(out, /--dry-run/);
    assert.equal(sessions.size, before);
  });

  test('台账记录会话，会话带上对应 agent', async () => {
    const r = roundState();
    assert.equal(r.sessions.plan, 's1', '默认主会话即 planner');
    assert.equal(sessions.get(r.sessions.dev).agent, 'swarm-dev');
    assert.equal(sessions.get(r.sessions.test).agent, 'swarm-test');
    assert.ok(r.members && r.members['s1'], 'members 应登记主会话（footor/sidebar 跟随用）');
  });

  test('--name 直接给会话起名（显式 sessions）', async () => {
    const out = await cmd('swarm-up', '--run default --name 待办角标刷新 --dev-model opencode-go/deepseek-v4.1-flash --executor sessions');
    assert.match(out, /待办角标刷新/);
    const r = roundState();
    assert.equal(sessions.get('s1').title, '待办角标刷新', '主会话（planner）用纯需求名');
    assert.equal(sessions.get(r.sessions.dev).title, '待办角标刷新 · dev');
    assert.equal(sessions.get(r.sessions.test).title, '待办角标刷新 · test');
  });

  test('--plan-session new 保留旧行为：另建 plan 会话', async () => {
    const out = await cmd('swarm-up', '--run plannew --plan_session new --planner-model opencode-go/deepseek-v4.1-flash --executor sessions', 'host-pn');
    assert.match(out, /plan .*opencode-go\/deepseek-v4\.1-flash/);
    const r = JSON.parse(readFileSync(join(dir, '.swarm/runs/plannew/round.json'), 'utf8'));
    assert.notEqual(r.sessions.plan, 'host-pn', '显式 new 时 plan 应为独立会话');
    assert.equal(sessions.get(r.sessions.plan).agent, 'swarm-plan');
    await cmd('swarm-switch', '--run default'); // 复原 current
  });
});

describe('需求命名（会话标题跟着需求走）', () => {
  test('#plan <需求> 把主会话和本轮角色会话改成需求名', async () => {
    const ev = { sessionID: 'main-sess', prompt: { text: '#plan 需求：待办页面审批完成后导航栏角标立即刷新，不要出现负数' } };
    await promptHook(ev);
    await new Promise((r) => setTimeout(r, 20)); // nameRound 是 fire-and-forget
    assert.match(sessions.get('main-sess')?.title, /^待办页面审批完成后导航栏角标立即刷新，不要出现/);
    const r = roundState();
    assert.ok(sessions.get(r.sessions.plan).title.startsWith('待办页面审批完成后导航栏角标立即刷新'));
    assert.match(sessions.get(r.sessions.dev).title, /· dev$/);
    assert.match(roundState().name, /待办页面审批完成后导航栏角标/);
  });

  test('/swarm-start 把当前会话改成需求名', async () => {
    const out = await cmd('swarm-start', '--name 借用单用途必填', 'user-main');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(sessions.get('user-main')?.title, '借用单用途必填');
    assert.match(out, /本轮：\*\*借用单用途必填\*\*/);
    const r = roundState();
    assert.match(sessions.get(r.sessions.dev).title, /借用单用途必填 · dev/);
  });

  test('title hook 用需求名覆盖自动标题', async () => {
    assert.equal(typeof hooks.title, 'function');
    const ev = { sessionID: roundState().sessions.dev };
    hooks.title(ev);
    assert.equal(ev.result.title, `${roundState().name} · dev`);
  });
});

describe('派发可见性（不再「不知道有没有跑」；显式 sessions 回退通道）', () => {
  test('显式 sessions：swarm-up 之后 /swarm-start 会真的唤醒 dev 会话', async () => {
    await run('swarm_plan', { tasks: [{ id: 'W9-T1', wave: 'W9', title: '唤醒验证', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false}] });
    const before = promptCalls.length;
    const out = await cmd('swarm-start', '--executor sessions');
    assert.match(out, /已派发 W9-T1/);
    assert.match(out, /状态已流转/);
    assert.match(out, /唤醒投递结果/);
    assert.match(out, /指令已投递/);
    assert.match(out, /未验证跑起来/);
    assert.doesNotMatch(out, /开始执行/);
    const devSid = roundState().sessions.dev;
    const woke = promptCalls.slice(before).find((c) => c.sessionID === devSid);
    assert.ok(woke, '应给 dev 会话发一条 #dev 指令');
    assert.match(woke.text, /你是 dev/);
    assert.match(woke.text, /W9-T1/);
  });

  test('swarm_done 通过后唤醒 test 会话', async () => {
    const before = promptCalls.length;
    await run('swarm_done', { task_id: 'W9-T1', summary: '唤醒演练' });
    const testSid = roundState().sessions.test;
    const woke = promptCalls.slice(before).find((c) => c.sessionID === testSid);
    assert.ok(woke, '应给 test 会话发一条 #test 指令');
    assert.match(woke.text, /你是 test/);
  });

  test('未登记会话时给「未自动唤醒」而不是静默（显式 sessions）', async () => {
    const { rmSync: rm } = await import('node:fs');
    // 台账只按 run 存放：清本轮 round.json 即算「未登记」（旧全局位已不参与读，
    // 那行 rm 只是顺手清掉镜像残留，删了也不影响本用例结论）
    rm(join(dir, '.swarm/runs/default/round.json'), { force: true });
    rm(join(dir, '.trellis/swarm-state/round.json'), { force: true });
    await run('swarm_plan', { tasks: [{ id: 'W9-T2', wave: 'W9', title: '无台账', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false}] });
    const out = await cmd('swarm-start', '--executor sessions');
    assert.match(out, /未自动唤醒/);
  });
});

describe('swarm-status 会话可见（显式 sessions 回退通道）', () => {
  test('列出版次名与会话表（含模型）', async () => {
    await cmd('swarm-up', '--run default --name 会话可见性 --dev-model opencode-go/deepseek-v4.1-flash --executor sessions');
    const out = await cmd('swarm-status');
    assert.match(out, /### 会话/);
    assert.match(out, /opencode-go\/deepseek-v4\.1-flash/);
    assert.match(out, /轮次：\*\*会话可见性\*\*/);
    assert.match(out, /session|sess-/);
  });
});

describe('run 隔离：双轮并行（不传 queue → 按 run 切分）', () => {
  let dir2;
  let ctx2;
  let prompts2;
  let tools2;
  let cmds2;
  let sessions2;
  let hooks2 = {};

  const run2 = async (name, input) => (await tools2.get(name).execute(withForce(name, input))).content;
  const cmd2 = async (name, text = '', sessionID = 's1') => {
    await cmds2.get(name).execute({ sessionID, prompt: { text } });
    return prompts2.at(-1);
  };

  before(async () => {
    dir2 = mkdtempSync(join(tmpdir(), 'swarm-runiso-'));
    writeFileSync(join(dir2, 'ok.mjs'), 'process.exit(0);\n'); // 该轮 cwd=dir2，verify 相对路径需本地有脚本
    prompts2 = [];
    tools2 = new Map();
    cmds2 = new Map();
    sessions2 = new Map();
    let seq = 100;
    ctx2 = {
      location: { directory: dir2 },
      // 注意：故意不传 queue → 队列按 run 落 `.swarm/runs/<id>/queue.jsonl`
      options: { channel: 'swarm-runiso', maxRetries: 3, verifyTimeoutMs: 20_000 },
      model: { list: async () => [] }, // 空注册表 → 校验降级放行
      session: {
        prompt: async ({ sessionID, text }) => { prompts2.push(`[${sessionID}] ${text}`); },
        create: async ({ title, agent, model }) => {
          const id = `r2-${++seq}`;
          sessions2.set(id, { id, title, agent, model });
          return { id, title };
        },
        get: async ({ sessionID }) => sessions2.get(sessionID),
        update: async ({ sessionID, title }) => {
          const s = sessions2.get(sessionID) ?? { id: sessionID };
          s.title = title;
          sessions2.set(sessionID, s);
        },
        switchModel: async () => {},
        hook: async (name, fn) => { hooks2[name] = fn; },
      },
      command: { transform: async (fn) => fn({ add: (d) => cmds2.set(d.name, d) }) },
      tool: { transform: async (fn) => fn({ add: (d) => tools2.set(d.name, d) }) },
    };
    await plugin.setup(ctx2);
  });

  after(() => { rmSync(dir2, { recursive: true, force: true }); });

  test('up --run 落台账到各自 run，命名互不干扰（显式 sessions）', async () => {
    await cmd2('swarm-up', '--run A --name 需求A --executor sessions');
    await cmd2('swarm-up', '--run B --name 需求B --executor sessions');
    const ra = JSON.parse(readFileSync(join(dir2, '.swarm/runs/A/round.json'), 'utf8'));
    const rb = JSON.parse(readFileSync(join(dir2, '.swarm/runs/B/round.json'), 'utf8'));
    assert.equal(ra.name, '需求A');
    assert.equal(rb.name, '需求B');
    assert.notEqual(ra.sessions.dev, rb.sessions.dev, '两轮 dev 会话必须不同');
  });

  test('title hook 按 sid 反查所属 run，不串名', async () => {
    const ra = JSON.parse(readFileSync(join(dir2, '.swarm/runs/A/round.json'), 'utf8'));
    const rb = JSON.parse(readFileSync(join(dir2, '.swarm/runs/B/round.json'), 'utf8'));
    const ea = { sessionID: ra.sessions.dev };
    hooks2.title(ea);
    assert.equal(ea.result.title, '需求A · dev');
    const eb = { sessionID: rb.sessions.dev };
    hooks2.title(eb);
    assert.equal(eb.result.title, '需求B · dev');
  });

  test('plan 交替入队：同 taskId 分属两轮', async () => {
    const oa = await run2('swarm_plan', {
      run: 'A',
      tasks: [
        { id: 'WA-T1', wave: 'W1', title: 'A 任务一', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false},
        { id: 'WA-T2', wave: 'W1', title: 'A 任务二', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false},
      ],
    });
    assert.match(oa, /WA-T1: queued/);
    const ob = await run2('swarm_plan', {
      run: 'B',
      tasks: [{ id: 'WA-T1', wave: 'W1', title: 'B 任务一', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false}],
    });
    assert.match(ob, /WA-T1: queued/);
    const qa = JSON.parse(`[${readFileSync(join(dir2, '.swarm/runs/A/queue.jsonl'), 'utf8').split('\n').filter(Boolean).join(',')}]`);
    const qb = JSON.parse(`[${readFileSync(join(dir2, '.swarm/runs/B/queue.jsonl'), 'utf8').split('\n').filter(Boolean).join(',')}]`);
    assert.equal(qa.length, 2);
    assert.equal(qb.length, 1);
    assert.equal(qb[0].title, 'B 任务一');
  });

  test('start 各派各的：A 的 done 不影响 B', async () => {
    const outA = await cmd2('swarm-start', '--run A');
    assert.match(outA, /已派发 WA-T1/);
    const outB = await cmd2('swarm-start', '--run B');
    assert.match(outB, /已派发 WA-T1/);
    const doneA = await run2('swarm_done', { run: 'A', task_id: 'WA-T1', summary: 'A 轮做完' });
    assert.match(doneA, /门禁通过/);
    const qb = JSON.parse(`[${readFileSync(join(dir2, '.swarm/runs/B/queue.jsonl'), 'utf8').split('\n').filter(Boolean).join(',')}]`);
    assert.equal(qb[0].status, 'dev_doing', 'B 的 WA-T1 不得被 A 的 done 带走');
    const passA = await run2('swarm_test', { run: 'A', task_id: 'WA-T1', pass: true });
    assert.match(passA, /已派发 WA-T2/, 'A 轮内自动派下一单');
  });

  test('事件按 run 落盘，互不可见', async () => {
    const ea = readFileSync(join(dir2, '.swarm/runs/A/events.jsonl'), 'utf8');
    const eb = readFileSync(join(dir2, '.swarm/runs/B/events.jsonl'), 'utf8');
    assert.match(ea, /WA-T2/);
    assert.doesNotMatch(eb, /WA-T2/, 'B 的事件流不得出现 A 独有的任务');
  });

  test('status --all 两轮计数对；switch 切轮后默认看该轮', async () => {
    const all = await cmd2('swarm-status', '--all');
    assert.match(all, /A/);
    assert.match(all, /B/);
    assert.match(all, /WA-T2|需求A/);
    const sw = await cmd2('swarm-switch', '--run B');
    assert.match(sw, /已切换到轮 \*\*B\*\*/);
    assert.equal(readFileSync(join(dir2, '.swarm/current'), 'utf8').trim(), 'B');
    const s = await cmd2('swarm-status', '');
    assert.match(s, /Run：B/);
    assert.match(s, /轮次：\*\*需求B\*\*/);
    assert.match(s, /WA-T1/);
    assert.doesNotMatch(s, /WA-T2/, 'B 轮看不到 A 独有的 WA-T2');
    assert.doesNotMatch(s, /需求A/);
  });

  test('归档一轮（删目录）不影响另一轮', async () => {
    rmSync(join(dir2, '.swarm/runs/A'), { recursive: true, force: true });
    const s = await cmd2('swarm-status', '--run B');
    assert.match(s, /轮次：\*\*需求B\*\*/);
    assert.match(s, /WA-T1/);
    assert.doesNotMatch(s, /WA-T2/);
    const all = await cmd2('swarm-status', '--all');
    assert.match(all, /B/);
    assert.doesNotMatch(all, /需求A/, 'A 归档后 --all 不再列出');
  });
});

describe('up 新轮隔离（无 --run 派生，不串旧轮）', () => {
  let dir3;
  let prompts3;
  let tools3;
  let cmds3;
  let sessions3;

  const run3 = async (name, input) => (await tools3.get(name).execute(withForce(name, input))).content;
  const cmd3 = async (name, text = '', sessionID = 's1') => {
    await cmds3.get(name).execute({ sessionID, prompt: { text } });
    return prompts3.at(-1);
  };
  const bytes3 = (p) => readFileSync(p, 'utf8');

  before(async () => {
    dir3 = mkdtempSync(join(tmpdir(), 'swarm-upiso-'));
    prompts3 = [];
    tools3 = new Map();
    cmds3 = new Map();
    sessions3 = new Map();
    let seq = 300;
    const ctx3 = {
      location: { directory: dir3 },
      // 注意：故意不传 queue → 队列按 run 落 `.swarm/runs/<id>/queue.jsonl`（生产形态）
      options: { channel: 'swarm-upiso', maxRetries: 3, verifyTimeoutMs: 20_000 },
      model: { list: async () => [] }, // 空注册表 → 校验降级放行
      session: {
        prompt: async ({ sessionID, text }) => { prompts3.push(`[${sessionID}] ${text}`); },
        create: async ({ title, agent, model }) => {
          const id = `r3-${++seq}`;
          sessions3.set(id, { id, title, agent, model });
          return { id, title };
        },
        get: async ({ sessionID }) => sessions3.get(sessionID),
        update: async ({ sessionID, title }) => {
          const s = sessions3.get(sessionID) ?? { id: sessionID };
          s.title = title;
          sessions3.set(sessionID, s);
        },
        switchModel: async () => {},
        hook: async () => {},
      },
      command: { transform: async (fn) => fn({ add: (d) => cmds3.set(d.name, d) }) },
      tool: { transform: async (fn) => fn({ add: (d) => tools3.set(d.name, d) }) },
    };
    await plugin.setup(ctx3);
  });

  after(() => { rmSync(dir3, { recursive: true, force: true }); });

  test('无 --run + 有 --name 派生新轮：旧 default 四件套字节一致', async () => {
    // 1. 旧轮播种：显式 --run default 建会话 + 入队 1 任务（含残留 sessions）
    const seed = await cmd3('swarm-up', '--run default --executor sessions --name 旧需求');
    assert.match(seed, /## swarm-up/);
    const planOut = await run3('swarm_plan', {
      tasks: [{ id: 'OLD-T1', wave: 'W1', title: '旧任务', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd', review: false }],
    });
    assert.match(planOut, /OLD-T1: queued/);
    const snap = {};
    for (const f of ['queue.jsonl', 'round.json', 'meta.json', 'timeline.jsonl']) {
      snap[f] = bytes3(join(dir3, '.swarm/runs/default', f));
    }
    const oldIds = Object.values(JSON.parse(snap['round.json']).sessions ?? {});
    assert.ok(oldIds.length >= 2, `旧轮应有 plan(=host)/dev/test 登记，实际 ${oldIds.length}`);

    // 2. 新轮：无 --run + 有 --name（派生 runId，不碰 default；用另一个主会话，
    //    同一会话开新轮会按设计把 host 从旧轮摘走，见「会话换轮」用例）
    const out = await cmd3('swarm-up', '--executor sessions --name 库房列表库存显示', 's1-new');
    assert.match(out, /## swarm-up/);
    assert.doesNotMatch(out, /拒绝复用/);

    // 3. 旧轮四件套字节一致（新轮独立）
    for (const f of ['queue.jsonl', 'round.json', 'meta.json', 'timeline.jsonl']) {
      assert.equal(bytes3(join(dir3, '.swarm/runs/default', f)), snap[f], `旧 default/${f} 必须原封不动`);
    }
    // 4. 新轮独立存在：sessions 只登记本次新建，meta/round 双写一致
    const newRound = JSON.parse(bytes3(join(dir3, '.swarm/runs/库房列表库存显示/round.json')));
    const newMeta = JSON.parse(bytes3(join(dir3, '.swarm/runs/库房列表库存显示/meta.json')));
    assert.equal(newRound.name, '库房列表库存显示');
    assert.equal(newMeta.name, '库房列表库存显示', 'meta/round name 必须双写一致');
    const newIds = Object.values(newRound.sessions ?? {});
    assert.ok(newIds.length >= 1, '新轮应登记本次新建的会话');
    assert.ok(newIds.every((id) => !oldIds.includes(id)), '新轮 sessions 不得含旧轮残留 ID');
    // 5. current 必写（新轮落盘成功后认领）
    assert.equal(bytes3(join(dir3, '.swarm/current')).trim(), '库房列表库存显示');
  });

  test('显式 --run 指非空旧轮被拒收（指引 clean/换名），不建会话不动 current', async () => {
    const beforeSessions = sessions3.size;
    const beforeCurrent = bytes3(join(dir3, '.swarm/current')).trim();
    const beforeRound = bytes3(join(dir3, '.swarm/runs/default/round.json'));
    const out = await cmd3('swarm-up', '--run default --executor sessions --name 新需求硬闯');
    assert.match(out, /拒绝复用非空旧轮/);
    assert.match(out, /swarm-clean --run default/);
    assert.match(out, /--force/);
    assert.equal(sessions3.size, beforeSessions, '拒收不得创建会话');
    assert.equal(bytes3(join(dir3, '.swarm/current')).trim(), beforeCurrent, '拒收不得动 current');
    assert.equal(bytes3(join(dir3, '.swarm/runs/default/round.json')), beforeRound, '拒收不得改旧轮台账');
  });

  test('--force 放行复用旧轮（meta/round 改名 + current 认领）', async () => {
    const out = await cmd3('swarm-up', '--run default --executor sessions --name 强制接管 --force');
    assert.match(out, /## swarm-up/);
    assert.doesNotMatch(out, /拒绝复用/);
    const r = JSON.parse(bytes3(join(dir3, '.swarm/runs/default/round.json')));
    const m = JSON.parse(bytes3(join(dir3, '.swarm/runs/default/meta.json')));
    assert.equal(r.name, '强制接管');
    assert.equal(m.name, '强制接管', '显式复用时 meta/round 双写新名');
    assert.equal(bytes3(join(dir3, '.swarm/current')).trim(), 'default', '显式 --run 认领当前轮（老行为）');
  });

  test('派生冲突自动加 -2 后缀，旧同名轮不动', async () => {
    const snap = bytes3(join(dir3, '.swarm/runs/库房列表库存显示/round.json'));
    const out = await cmd3('swarm-up', '--executor sessions --name 库房列表库存显示');
    assert.match(out, /## swarm-up/);
    assert.equal(bytes3(join(dir3, '.swarm/current')).trim(), '库房列表库存显示-2');
    assert.ok(existsSync(join(dir3, '.swarm/runs/库房列表库存显示-2/round.json')), '冲突轮应落 -2 目录');
    assert.equal(bytes3(join(dir3, '.swarm/runs/库房列表库存显示/round.json')), snap, '旧同名轮原封不动');
  });

  test('显式 --run 指空轮放行（老行为零变）', async () => {
    const out = await cmd3('swarm-up', '--run 空轮EMPTY --executor sessions --name 空轮需求');
    assert.match(out, /## swarm-up/);
    assert.doesNotMatch(out, /拒绝复用/);
    const r = JSON.parse(bytes3(join(dir3, '.swarm/runs/空轮EMPTY/round.json')));
    assert.equal(r.name, '空轮需求');
    assert.equal(bytes3(join(dir3, '.swarm/current')).trim(), '空轮EMPTY');
  });
});

describe('FSM 与 timeline（事件溯源）', () => {
  const tlRows = (id) => readFileSync(join(dir, '.swarm/runs/default/timeline.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.taskId === id);

  test('非法迁移被拒且带 allowed:（已 passed 的任务再 claim）', async () => {
    const out = await run('swarm_claim', { task_id: 'W1-T1' }); // W1-T1 前面已 passed
    assert.match(out, /认领失败/);
    assert.match(out, /allowed:/);
  });

  test('全闭环 timeline 行数/顺序精确（create→dev→gate→test→passed）', async () => {
    await run('swarm_plan', {
      tasks: [{ id: 'W-TL', wave: 'W9', title: 'timeline 闭环', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false}],
    });
    await run('swarm_claim', { task_id: 'W-TL' });
    const done = await run('swarm_done', { task_id: 'W-TL', summary: '闭环走完' });
    assert.match(done, /门禁通过/);
    const pass = await run('swarm_test', { task_id: 'W-TL', pass: true });
    assert.match(pass, /通过/);
    const rows = tlRows('W-TL');
    assert.deepEqual(rows.map((r) => r.kind), ['create', 'move', 'move', 'move', 'move']);
    assert.deepEqual(rows.map((r) => r.to), ['queued', 'dev_doing', 'gate_check', 'test_doing', 'passed']);
    assert.deepEqual(rows.map((r) => r.from), [null, 'queued', 'dev_doing', 'gate_check', 'test_doing']);
    assert.deepEqual(rows.map((r) => r.reason), ['create', 'claim', 'gate-enter', 'gate-pass', 'test-pass']);
    const seqs = rows.map((r) => r.seq);
    assert.ok(seqs.every((s, i) => i === 0 || s > seqs[i - 1]), '同任务 seq 单调递增');
  });

  test('门禁拒绝打回 dev_doing：retries 不变、timeline 可见、[GATE-REJECT] 事件落盘', async () => {
    await run('swarm_plan', {
      tasks: [{ id: 'W-RJ', wave: 'W9', title: '拒绝可见', acceptance: 'never', verify_cmd: 'node bad.mjs', testing: '恒红' , review: false}],
    });
    await run('swarm_claim', { task_id: 'W-RJ' });
    const out = await run('swarm_done', { task_id: 'W-RJ', summary: '试红门禁' });
    assert.match(out, /门禁拒绝/);
    assert.match(out, /已打回 dev_doing/);
    const t = queueState().find((x) => x.id === 'W-RJ');
    assert.equal(t.status, 'dev_doing');
    assert.equal(t.retries, 0, '门禁拒绝不得计 retries');
    const rows = tlRows('W-RJ');
    assert.ok(rows.length >= 3, `至少 create+claim+gate-enter+reject，实际 ${rows.length}`);
    const last = rows[rows.length - 1];
    assert.equal(last.from, 'gate_check');
    assert.equal(last.to, 'dev_doing');
    assert.match(last.reason, /^gate-reject:/);
    const events = readFileSync(join(dir, '.swarm/runs/default/events.jsonl'), 'utf8');
    assert.match(events, /\[GATE-REJECT\].*W-RJ/);
  });

  test('swarm-status --task 打印单任务 timeline', async () => {
    const out = await cmd('swarm-status', '--task W-TL');
    assert.match(out, /## swarm timeline：W-TL/);
    assert.match(out, /gate_check→test_doing/);
    assert.match(out, /by=gate/);
    assert.match(out, /reason=gate-pass/);
  });

  test('swarm-rebuild dry-run 差异0；删 queue 后 --write 重建 deep-equal', async () => {
    const dry = await cmd('swarm-rebuild', '');
    assert.match(dry, /一致|0 差异/);
    const qp = join(dir, '.trellis/swarm-queue.jsonl');
    const snapshot = JSON.parse(`[${readFileSync(qp, 'utf8').split('\n').filter(Boolean).join(',')}]`);
    rmSync(qp, { force: true });
    const wrote = await cmd('swarm-rebuild', '--write');
    assert.match(wrote, /已用 timeline 重建队列/);
    const rebuilt = JSON.parse(`[${readFileSync(qp, 'utf8').split('\n').filter(Boolean).join(',')}]`);
    assert.deepEqual(rebuilt, snapshot, '重建结果必须与删前 queue 逐行 deep-equal');
    const dry2 = await cmd('swarm-rebuild', '');
    assert.match(dry2, /0 差异/);
  });
});

describe('risk 分级与 status 标出', () => {
  test('高 risk 任务全闭环，status 标⚠️且队列表带 risk 列', async () => {
    await run('swarm_plan', {
      tasks: [{ id: 'W-RISK', wave: 'W9', title: '高风险改动', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd', risk: 'high', paths: ['src/core/pay.ts'] , review: false}],
    });
    await run('swarm_claim', { task_id: 'W-RISK' });
    const done = await run('swarm_done', { task_id: 'W-RISK', summary: '高风险改完' });
    assert.match(done, /门禁通过/);
    const out = await cmd('swarm-status', '');
    assert.match(out, /⚠️ 高风险：建议两人复核/);
    assert.match(out, /W-RISK/);
    assert.match(out, /\| high \|/);
    const pass = await run('swarm_test', { task_id: 'W-RISK', pass: true });
    assert.match(pass, /通过/);
    assert.equal(queueState().find((t) => t.id === 'W-RISK').status, 'passed');
  });

  test('risk 非法值入队被拒', async () => {
    const out = await run('swarm_plan', {
      tasks: [{ id: 'W-BADRISK', wave: 'W9', title: 'x', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: 'x', risk: 'critical' , review: false}],
    });
    assert.match(out, /invalid risk/);
    assert.equal(queueState().find((t) => t.id === 'W-BADRISK'), undefined);
  });

  test('#dev 唤起时展开 risk 行', async () => {
    await run('swarm_plan', {
      tasks: [{ id: 'W-RISK2', wave: 'W9', title: '看看', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: 'x', risk: 'high' , review: false}],
    });
    const ev = { prompt: { text: '#dev W-RISK2 修一下' } };
    await promptHook(ev);
    assert.match(ev.prompt.text, /风险：high/);
  });
});

describe('policy 门禁（禁区拦截）', () => {
  test('paths 命中禁区 → done 被门禁拒绝且打回 dev_doing', async () => {
    await run('swarm_plan', {
      tasks: [{ id: 'W-FORB', wave: 'W9', title: '禁区改动', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd', paths: ['tools/review/leak.md'] , review: false}],
    });
    await run('swarm_claim', { task_id: 'W-FORB' });
    const out = await run('swarm_done', { task_id: 'W-FORB', summary: '试禁区' });
    assert.match(out, /门禁拒绝/);
    assert.match(out, /gate=policy/);
    assert.equal(queueState().find((t) => t.id === 'W-FORB').status, 'dev_doing');
  });

  test('policy_exception 反例放行（自举类任务）', async () => {
    await run('swarm_plan', {
      tasks: [{ id: 'W-EXC', wave: 'W9', title: '自举任务', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd', paths: ['tools/review/leak.md'], policy_exception: true , review: false}],
    });
    await run('swarm_claim', { task_id: 'W-EXC' });
    const out = await run('swarm_done', { task_id: 'W-EXC', summary: '自举任务做完' });
    assert.match(out, /门禁通过/);
    const pass = await run('swarm_test', { task_id: 'W-EXC', pass: true });
    assert.match(pass, /通过/);
  });
});

describe('/swarm-up 占位角色', () => {
  test('reviewer 不可 up：人话拒绝且不建会话、不崩', async () => {
    const before = sessions.size;
    const out = await cmd('swarm-up', '--roles reviewer');
    assert.match(out, /占位/);
    assert.equal(sessions.size, before, '占位角色不得创建会话');
  });

  test('dry-run 标注占位与需人力复核', async () => {
    const out = await cmd('swarm-up', '--roles reviewer --dry-run');
    assert.match(out, /占位，不可 up/);
    assert.match(out, /需人力复核/);
  });
});

describe('B2 payload 持久化（summary/failed_ids/detail）', () => {
  test('done 写 summary；fail 写 failed_ids/detail 全量；事件 detail 截 500', async () => {
    await run('swarm_plan', {
      tasks: [{ id: 'W-B2', wave: 'W9', title: 'payload 持久化', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false}],
    });
    await run('swarm_claim', { task_id: 'W-B2' });
    const done = await run('swarm_done', { task_id: 'W-B2', summary: '改了三处，回归通过' });
    assert.match(done, /门禁通过/);
    let t = queueState().find((x) => x.id === 'W-B2');
    assert.equal(t.status, 'test_doing');
    assert.equal(t.summary, '改了三处，回归通过');
    const longDetail = 'x'.repeat(800);
    const fail = await run('swarm_test', { task_id: 'W-B2', pass: false, failed_ids: 'B1,B2', detail: longDetail, disposition: 'fixed' });
    assert.match(fail, /回 dev/);
    t = queueState().find((x) => x.id === 'W-B2');
    assert.equal(t.failed_ids, 'B1,B2');
    assert.equal(t.detail, longDetail, 'queue 存全量 detail');
    const events = readFileSync(join(dir, '.swarm/runs/default/events.jsonl'), 'utf8');
    const line = events.split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .map((r) => r.text).find((x) => x.includes('[TEST-FAIL]') && x.includes('W-B2'));
    assert.ok(line, '应有 W-B2 的 TEST-FAIL 事件');
    const m = /detail=(\S+)/.exec(line.split('\n')[0]);
    assert.ok(m, '事件应带 detail kv');
    assert.equal(m[1].length, 500, `事件 detail 应截断到 500，实际 ${m[1].length}`);
  });

  test('status --task 打印三字段；老任务显示（未填写）', async () => {
    const out = await cmd('swarm-status', '--task W-B2');
    assert.match(out, /summary=改了三处/);
    assert.match(out, /failed_ids=B1,B2/);
    assert.match(out, /detail=x{10}/);
    const old = await cmd('swarm-status', '--task W-TL');
    assert.match(old, /\(未填写\)/);
  });

  test('删 queue 后 rebuild 还原 summary/failed_ids/detail', async () => {
    const qp = join(dir, '.trellis/swarm-queue.jsonl');
    const snapshot = JSON.parse(`[${readFileSync(qp, 'utf8').split('\n').filter(Boolean).join(',')}]`);
    rmSync(qp, { force: true });
    const wrote = await cmd('swarm-rebuild', '--write');
    assert.match(wrote, /已用 timeline 重建队列/);
    const rebuilt = JSON.parse(`[${readFileSync(qp, 'utf8').split('\n').filter(Boolean).join(',')}]`);
    assert.deepEqual(rebuilt, snapshot);
    const t = rebuilt.find((x) => x.id === 'W-B2');
    assert.equal(t.summary, '改了三处，回归通过');
    assert.equal(t.failed_ids, 'B1,B2');
    assert.equal(t.detail.length, 800);
  });
});

describe('R1 必填（红测）', () => {
  test('plan 缺 testing 被拒', async () => {
    const out = await run('swarm_plan', {
      tasks: [{ id: 'R1-RED', wave: 'W9', title: '缺 testing', acceptance: 'ok', verify_cmd: 'node ok.mjs' }],
    });
    assert.match(out, /testing/);
    assert.doesNotMatch(out, /R1-RED: queued/);
  });

  test('done 缺 summary 被拒（人话）', async () => {
    await run('swarm_plan', {
      tasks: [{ id: 'R1-S1', wave: 'W9', title: '缺 summary', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false}],
    });
    await run('swarm_claim', { task_id: 'R1-S1' });
    const out = await run('swarm_done', { task_id: 'R1-S1' });
    assert.match(out, /summary/);
  });
});

describe('R4 命令（红测）', () => {
  test('/swarm-revert 命令存在', async () => {
    assert.ok(cmds.get('swarm-revert'), '缺 /swarm-revert 命令');
  });
});

describe('R2 开关（独立实例，gates:{lint:true}，无 Makefile）', () => {
  let dirR2;
  let runR2;
  before(async () => {
    dirR2 = mkdtempSync(join(tmpdir(), 'swarm-r2e2-'));
    writeFileSync(join(dirR2, 'ok.mjs'), 'process.exit(0);\n');
    const toolsR2 = new Map();
    const cmdsR2 = new Map();
    const sessionsR2 = new Map();
    let seq = 500;
    const promptsR2 = [];
    const ctxR2 = {
      location: { directory: dirR2 },
      options: { channel: 'swarm-r2e2', maxRetries: 3, verifyTimeoutMs: 20_000, gates: { lint: true } },
      model: { list: async () => [] },
      session: {
        prompt: async ({ sessionID, text }) => { promptsR2.push(`[${sessionID}] ${text}`); },
        create: async ({ title, agent, model }) => {
          const id = `r2-${++seq}`;
          sessionsR2.set(id, { id, title, agent, model });
          return { id, title };
        },
        get: async ({ sessionID }) => sessionsR2.get(sessionID),
        update: async ({ sessionID, title }) => {
          const s = sessionsR2.get(sessionID) ?? { id: sessionID };
          s.title = title;
          sessionsR2.set(sessionID, s);
        },
        switchModel: async () => {},
        hook: async () => {},
      },
      command: { transform: async (fn) => fn({ add: (d) => cmdsR2.set(d.name, d) }) },
      tool: { transform: async (fn) => fn({ add: (d) => toolsR2.set(d.name, d) }) },
    };
    await plugin.setup(ctxR2);
    runR2 = async (name, input) => (await toolsR2.get(name).execute(withForce(name, input))).content;
    const qp = join(dirR2, '.swarm', 'runs', 'default', 'queue.jsonl');
    runR2.qp = qp;
  });

  after(() => { rmSync(dirR2, { recursive: true, force: true }); });

  test('开 lint 红被拦（gate=lint），状态不动', async () => {
    await runR2('swarm_plan', {
      tasks: [{ id: 'R2-LINT', wave: 'W1', title: 'lint 红', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: 'node ok.mjs 全绿' , review: false}],
    });
    await runR2('swarm_claim', { task_id: 'R2-LINT' });
    const out = await runR2('swarm_done', { task_id: 'R2-LINT', summary: '试 lint' });
    assert.match(out, /门禁拒绝/);
    assert.match(out, /gate=lint/);
    const t = JSON.parse(`[${readFileSync(runR2.qp, 'utf8').split('\n').filter(Boolean).join(',')}]`).find((x) => x.id === 'R2-LINT');
    assert.equal(t.status, 'dev_doing');
  });

  test('建 Makefile 后 lint 放行', async () => {
    writeFileSync(join(dirR2, 'Makefile'), 'gate:\n\ttrue\n');
    const out = await runR2('swarm_done', { task_id: 'R2-LINT', summary: '补 Makefile' });
    assert.match(out, /门禁通过/);
  });
});

describe('R3 base 竞态（独立实例，mock git）', () => {
  let dirR3;
  let runR3;
  let mockState;
  const shaA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const shaB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const readQ = () => JSON.parse(`[${readFileSync(join(dirR3, '.swarm', 'runs', 'default', 'queue.jsonl'), 'utf8').split('\n').filter(Boolean).join(',')}]`);
  const tlRows = (id) => readFileSync(join(dirR3, '.swarm', 'runs', 'default', 'timeline.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.taskId === id);

  before(async () => {
    dirR3 = mkdtempSync(join(tmpdir(), 'swarm-r3e2-'));
    writeFileSync(join(dirR3, 'ok.mjs'), 'process.exit(0);\n');
    mockState = mkdtempSync(join(tmpdir(), 'swarm-mockgit-'));
    writeFileSync(join(mockState, 'mode'), 'static');
    writeFileSync(join(mockState, 'count'), '0');
    writeFileSync(join(mockState, 'shaA'), `${shaA}\n`);
    writeFileSync(join(mockState, 'shaB'), `${shaB}\n`);
    // mock git：rev-parse main 按 mode/counter 返回 canned sha；其余常用子命令给良性结果
    const mock = join(mockState, 'git');
    writeFileSync(mock, `#!/bin/sh\nD=${mockState}\n`
      + `if [ "$1" = "rev-parse" ] && [ "$2" = "main" ]; then\n`
      + `  mode=$(cat "$D/mode" 2>/dev/null || echo static)\n`
      + `  if [ "$mode" = "null" ]; then exit 128; fi\n`
      + `  if [ "$mode" = "advance" ]; then n=$(cat "$D/count" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$D/count"; if [ "$n" -le 1 ]; then cat "$D/shaA"; else cat "$D/shaB"; fi\n`
      + `  else cat "$D/shaA"; fi\n  exit 0\nfi\n`
      + `if [ "$1" = "rev-parse" ] && [ "$2" = "master" ]; then exit 128; fi\n`
      + `if [ "$1" = "rev-parse" ]; then echo mocksha1; exit 0; fi\n`
      + `if [ "$1" = "status" ]; then exit 0; fi\n`
      + `exit 0\n`);
    chmodSync(mock, 0o755);
    const toolsR3 = new Map();
    const cmdsR3 = new Map();
    const ctxR3 = {
      location: { directory: dirR3 },
      options: { channel: 'swarm-r3e2', maxRetries: 3, verifyTimeoutMs: 20_000, gitBin: mock },
      model: { list: async () => [] },
      session: {
        prompt: async () => {},
        create: async ({ title }) => ({ id: 'x', title }),
        get: async () => undefined,
        update: async () => {},
        switchModel: async () => {},
        hook: async () => {},
      },
      command: { transform: async (fn) => fn({ add: (d) => cmdsR3.set(d.name, d) }) },
      tool: { transform: async (fn) => fn({ add: (d) => toolsR3.set(d.name, d) }) },
    };
    await plugin.setup(ctxR3);
    runR3 = async (name, input) => (await toolsR3.get(name).execute(withForce(name, input))).content;
  });

  after(() => { rmSync(dirR3, { recursive: true, force: true }); rmSync(mockState, { recursive: true, force: true }); });

  test('静态 base：done 记录 baseHEAD 并放行', async () => {
    await runR3('swarm_plan', {
      tasks: [{ id: 'R3-S', wave: 'W1', title: '静态', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false}],
    });
    await runR3('swarm_claim', { task_id: 'R3-S' });
    const out = await runR3('swarm_done', { task_id: 'R3-S', summary: '静态过' });
    assert.match(out, /门禁通过/);
    assert.equal(readQ().find((t) => t.id === 'R3-S').baseHEAD, shaA);
  });

  test('base 前进：打回 dev_doing 且 reason 含 rebase', async () => {
    writeFileSync(join(mockState, 'mode'), 'advance');
    writeFileSync(join(mockState, 'count'), '0');
    await runR3('swarm_plan', {
      tasks: [{ id: 'R3-A', wave: 'W1', title: '前进', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false}],
    });
    await runR3('swarm_claim', { task_id: 'R3-A' });
    const out = await runR3('swarm_done', { task_id: 'R3-A', summary: '会被打回' });
    assert.match(out, /rebase/);
    assert.equal(readQ().find((t) => t.id === 'R3-A').status, 'dev_doing');
    const rows = tlRows('R3-A');
    assert.match(rows[rows.length - 1].reason, /rebase/);
  });

  test('force_base 越过且 timeline 留 force-base 痕', async () => {
    const out = await runR3('swarm_done', { task_id: 'R3-A', summary: '强制过', force_base: true });
    assert.match(out, /门禁通过/);
    assert.equal(readQ().find((t) => t.id === 'R3-A').status, 'test_doing');
    const rows = tlRows('R3-A');
    assert.ok(rows.some((r) => /force-base/.test(r.reason ?? '')), 'timeline 应有 force-base 痕');
  });

  test('取不到 base：记 null 并放行+warning', async () => {
    writeFileSync(join(mockState, 'mode'), 'null');
    await runR3('swarm_plan', {
      tasks: [{ id: 'R3-N', wave: 'W1', title: '无 base', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false}],
    });
    await runR3('swarm_claim', { task_id: 'R3-N' });
    const out = await runR3('swarm_done', { task_id: 'R3-N', summary: '无 base 也过' });
    assert.match(out, /门禁通过/);
    assert.match(out, /取不到/);
    assert.equal(readQ().find((t) => t.id === 'R3-N').baseHEAD, null);
  });
});

describe('R4 revert（主实例）', () => {
  const readQ = () => JSON.parse(`[${readFileSync(join(dir, '.trellis/swarm-queue.jsonl'), 'utf8').split('\n').filter(Boolean).join(',')}]`);
  const tlRows = (id) => readFileSync(join(dir, '.swarm/runs/default/timeline.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.taskId === id);

  test('pass 后 revert 回 dev_doing：commit 回退 + verdict_path=null', async () => {
    await run('swarm_plan', {
      tasks: [{ id: 'W-RV1', wave: 'W9', title: 'revert 演练', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: 'node ok.mjs 全绿' , review: false}],
    });
    await run('swarm_claim', { task_id: 'W-RV1' });
    await run('swarm_done', { task_id: 'W-RV1', summary: '准备 revert' });
    assert.equal(readQ().find((t) => t.id === 'W-RV1').status, 'test_doing');
    await run('swarm_test', { task_id: 'W-RV1', pass: true });
    const passed = readQ().find((t) => t.id === 'W-RV1');
    assert.equal(passed.status, 'passed');
    assert.ok(passed.commit, 'pass 前应已记录 commit');
    const out = await cmd('swarm-revert', '--task W-RV1');
    assert.match(out, /dev_doing/);
    const back = readQ().find((t) => t.id === 'W-RV1');
    assert.equal(back.status, 'dev_doing');
    assert.equal(back.verdict_path, null);
    assert.ok(!back.commit, `commit 应回退（进 gate 前无 commit），实际 ${back.commit}`);
    assert.ok(tlRows('W-RV1').some((r) => r.kind === 'revert'), 'timeline 应有 revert 行');
  });

  test('halted 也可 revert；queued 不可', async () => {
    await run('swarm_plan', {
      tasks: [
        { id: 'W-RV2', wave: 'W9', title: 'halt 后 revert', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false},
        { id: 'W-RV3', wave: 'W9', title: 'queued 不可 revert', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false},
      ],
    });
    await run('swarm_claim', { task_id: 'W-RV2' });
    await run('swarm_done', { task_id: 'W-RV2', summary: 'halt 演练' });
    await run('swarm_test', { task_id: 'W-RV2', pass: false, failed_ids: 'F1', detail: '挂一次', disposition: 'wrong' });
    await cmd('swarm-halt', '--task W-RV2 --reason 演练熔断');
    assert.equal(readQ().find((t) => t.id === 'W-RV2').status, 'halted');
    const out = await cmd('swarm-revert', '--task W-RV2');
    assert.match(out, /dev_doing/);
    assert.equal(readQ().find((t) => t.id === 'W-RV2').status, 'dev_doing');
    const refuse = await cmd('swarm-revert', '--task W-RV3');
    assert.match(refuse, /只有 halted\/passed 可 revert/);
    assert.equal(readQ().find((t) => t.id === 'W-RV3').status, 'queued');
  });

  test('revert 后 rebuild 仍一致', async () => {
    const out = await cmd('swarm-rebuild', '');
    assert.match(out, /一致|0 差异/);
  });
});

describe('R5+R6 disposition 必填 + status 两行 + HALT 摘要（红测）', () => {
  const readQ = () => JSON.parse(`[${readFileSync(join(dir, '.trellis/swarm-queue.jsonl'), 'utf8').split('\n').filter(Boolean).join(',')}]`);

  test('fail 缺 disposition 被拒收', async () => {
    await run('swarm_plan', {
      tasks: [{ id: 'W-D1', wave: 'W9', title: 'disposition 缺失', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false}],
    });
    await run('swarm_claim', { task_id: 'W-D1' });
    await run('swarm_done', { task_id: 'W-D1', summary: '待 fail' });
    const out = await run('swarm_test', { task_id: 'W-D1', pass: false, failed_ids: 'F1', detail: '挂了' });
    assert.match(out, /disposition/);
    assert.equal(readQ().find((t) => t.id === 'W-D1').status, 'test_doing', '拒收后状态不动');
  });

  test('fail 非法 disposition 被拒；合法四值放行且落盘', async () => {
    const bad = await run('swarm_test', { task_id: 'W-D1', pass: false, failed_ids: 'F1', detail: '挂了', disposition: 'bogus' });
    assert.match(bad, /disposition/);
    const ok = await run('swarm_test', { task_id: 'W-D1', pass: false, failed_ids: 'F1', detail: '确有 bug', disposition: 'fixed' });
    assert.match(ok, /回 dev/);
    assert.equal(readQ().find((t) => t.id === 'W-D1').disposition, 'fixed');
  });

  test('status 含 rounds-to-pass 与 disposition 分布两行', async () => {
    const out = await cmd('swarm-status', '');
    assert.match(out, /rounds-to-pass/);
    assert.match(out, /disposition/);
  });

  test('HALT 含重审建议 + 三轮摘要（无记录不崩）', async () => {
    await run('swarm_plan', {
      tasks: [{ id: 'W-DH', wave: 'W9', title: 'halt 摘要', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false}],
    });
    await run('swarm_claim', { task_id: 'W-DH' });
    await run('swarm_done', { task_id: 'W-DH', summary: 'halt 演练' });
    const { transitionTask } = await import('../lib/swarm-store.js');
    const { resolveRun } = await import('../lib/swarm-run.js');
    const qp = join(dir, '.trellis/swarm-queue.jsonl');
    const tp = resolveRun(dir, { run: 'default', queue: '.trellis/swarm-queue.jsonl' }).timelinePath;
    const push = () => {
      const a = transitionTask(qp, tp, { taskId: 'W-DH', expect: 'dev_doing', patch: { status: 'gate_check' }, by: 'dev', reason: 'setup-push-enter' });
      if (!a.ok) return a;
      return transitionTask(qp, tp, { taskId: 'W-DH', expect: 'gate_check', patch: { status: 'test_doing', assignee: 'test' }, by: 'gate', reason: 'setup-push-pass' });
    };
    // done 后已在 test_doing：第一次 fail 直接回 dev，无需先 push
    // maxRetries=3：前两次 fail 回 dev，第三次 HALT
    await run('swarm_test', { task_id: 'W-DH', pass: false, failed_ids: 'F1', detail: '第一轮挂', disposition: 'wrong' });
    assert.equal(push().ok, true);
    await run('swarm_test', { task_id: 'W-DH', pass: false, failed_ids: 'F2', detail: '第二轮挂', disposition: 'fixed' });
    assert.equal(push().ok, true);
    const last = await run('swarm_test', { task_id: 'W-DH', pass: false, failed_ids: 'F3', detail: '第三轮挂', disposition: 'intentional' });
    assert.match(last, /HALT/);
    assert.match(last, /重审/);
    assert.match(last, /第三轮挂|第一轮挂/);
  });
});

describe('R7 nightly 只读重跑（红测）', () => {
  test('/swarm-nightly 命令存在', async () => {
    assert.ok(cmds.get('swarm-nightly'), '缺 /swarm-nightly 命令');
  });

  test('全绿跑出 GREEN 汇总且状态不变', async () => {
    const out = await cmd('swarm-nightly', '--limit 20');
    assert.match(out, /NIGHTLY-GREEN|NIGHTLY-RED/);
    const tail = await cmd('swarm-status', '');
    assert.match(tail, /NIGHTLY-GREEN|NIGHTLY-RED/);
  });

  test('人为改坏一条 verify：跑红出 RED 但 passed 不变（只读）', async () => {
    const before = queueState().filter((t) => t.status === 'passed').map((t) => t.id).sort();
    assert.ok(before.length > 0, '应有 passed 任务可重跑');
    // 改坏 W1-T1 的验收文件（verify.mjs 读 data.json，n=2 才绿）
    const dataFile = join(dir, 'data.json');
    const saved = readFileSync(dataFile, 'utf8');
    writeFileSync(dataFile, '{"n":1}\n');
    try {
      const out = await cmd('swarm-nightly', '--limit 20');
      assert.match(out, /NIGHTLY-RED/);
      assert.match(out, /W1-T1/);
      const after = queueState().filter((t) => t.status === 'passed').map((t) => t.id).sort();
      assert.deepEqual(after, before, '跑红也不得改 passed 状态（只读）');
      const tail = await cmd('swarm-status', '');
      assert.match(tail, /NIGHTLY-RED/);
    } finally {
      writeFileSync(dataFile, saved);
    }
  });

  test('limit 生效：超出列清单不跑', async () => {
    const out = await cmd('swarm-nightly', '--limit 1');
    assert.match(out, /跳过|超出|limit/i);
  });
});

describe('subagent 执行器（executor=subagents，默认；显式 sessions 回退）', () => {
  const subMeta = () => JSON.parse(readFileSync(join(dir, '.swarm/runs/SUBAG/meta.json'), 'utf8'));

  test('start --executor subagents 写 meta + 派发但不唤醒 role 会话', async () => {
    const p = await run('swarm_plan', {
      run: 'SUBAG',
      tasks: [{ id: 'S1', wave: 'W1', title: '子代理任务一', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false}],
    });
    assert.match(p, /S1: queued/);
    // 主 ctx 配了显式 queue（兼容通道），各 run 共用同一队列文件：start 派发的是队首 queued，不一定是 S1
    const firstQueued = queueState().find((t) => t.status === 'queued');
    assert.ok(firstQueued, '应有可派发的 queued 任务');
    // 高风险软卡：队首若是未批 high-risk，先在同 run 补批再起派（approve 行落该 run timeline，dispatchNext 同 run 读到即解锁）
    if (firstQueued.risk === 'high') {
      const ap = await run('swarm_approve', { run: 'SUBAG', task_id: firstQueued.id });
      assert.match(ap, /已批准/, '队首 high-risk 应可补批');
    }
    const before = promptCalls.length;
    const out = await cmd('swarm-start', '--run SUBAG --executor subagents --dev-model opencode-go/muse-spark-1.3-contributor --tester-model opencode-go/deepseek-v4.1-flash');
    assert.match(out, new RegExp(`已派发 ${firstQueued.id}`));
    assert.match(out, /subagent 模式/, 'wake 应短路为 skipped 并指到 recipe');
    assert.equal(promptCalls.length, before + 1, '除 start 回复外不得再调 session.prompt（零唤醒）');
    assert.equal(subMeta().executor, 'subagents');
    assert.deepEqual(subMeta().roleModels, { dev: 'opencode-go/muse-spark-1.3-contributor', test: 'opencode-go/deepseek-v4.1-flash' });
  });

  test('status 显示执行器行 + 角色模型', async () => {
    const out = await cmd('swarm-status', '--run SUBAG');
    assert.match(out, /执行器：subagents/);
    assert.match(out, /dev=opencode-go\/muse-spark/);
    assert.match(out, /test=opencode-go\/deepseek/);
  });

  test('status 会话表 subagents 去假信号：折叠为待派发一行，无持有行', async () => {
    await run('swarm_plan', {
      run: 'SUBAG',
      tasks: [{ id: 'NOSIG-1', wave: 'W1', title: '去假信号演练', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false}],
    });
    await run('swarm_claim', { run: 'SUBAG', task_id: 'NOSIG-1' });
    assert.equal(queueState().find((x) => x.id === 'NOSIG-1').status, 'dev_doing');
    const out = await cmd('swarm-status', '--run SUBAG');
    assert.match(out, /子代理派发中（无 role 会话）/);
    assert.match(out, /待编排会话派 subagent（判活 \/swarm-drained，派发见 \/swarm-mode recipe）/);
    assert.match(out, /待派发：.*NOSIG-1 dev_doing/);
    assert.doesNotMatch(out, /sess-.*NOSIG-1/, '不得出现会话持有 NOSIG-1 的假信号行');
    assert.doesNotMatch(out, /\| 手上任务 \|/, 'subagents 下不得出现手上任务列表头');
  });

  test('/swarm-mode 只读打印 recipe；带设置 flags 只提示不写', async () => {
    const out = await cmd('swarm-mode', '--run SUBAG');
    assert.match(out, /## swarm-mode（只读/);
    assert.match(out, /subagents/);
    assert.match(out, /编排循环 recipe/);
    assert.match(out, /roleModels/);
    const out2 = await cmd('swarm-mode', '--run SUBAG --executor sessions');
    assert.match(out2, /只读/);
    assert.equal(subMeta().executor, 'subagents', 'mode 不得改 meta');
  });

  test('非法 executor 被拒（start/up 均拦），拒收不写 meta、不动 current', async () => {
    const out = await cmd('swarm-start', '--run SUBAG --executor bogus');
    assert.match(out, /只接受 sessions\|subagents\|hybrid/);
    assert.equal(subMeta().executor, 'subagents', '拒收后 meta 不动');
    // 全新 run：非法值既不落 meta，也不认领 current（后续无 --run 的 status 仍看旧轮）
    const bad = await cmd('swarm-start', '--run BOGUSAG --executor bogus');
    assert.match(bad, /只接受 sessions\|subagents\|hybrid/);
    assert.equal(existsSync(join(dir, '.swarm/runs/BOGUSAG/meta.json')), false, '拒收不落盘');
    const statusOut = await cmd('swarm-status', '');
    assert.match(statusOut, /Run：SUBAG/, 'current 未被非法输入拐走');
  });

  test('up dry-run 不写 meta（只打印计划）', async () => {
    const out = await cmd('swarm-up', '--run DRYEXEC --dry-run --executor subagents');
    assert.match(out, /未创建任何会话/);
    assert.equal(existsSync(join(dir, '.swarm/runs/DRYEXEC/meta.json')), false, 'dry-run 不落盘');
  });

  test('subagent 模式走完 claim→done→test 全绿：skipped 但状态机照走', async () => {
    const c = await run('swarm_claim', { run: 'SUBAG', task_id: 'S1' });
    assert.match(c, /已认领 S1/);
    const d = await run('swarm_done', { run: 'SUBAG', task_id: 'S1', summary: '子代理做完' });
    assert.match(d, /门禁通过/);
    assert.match(d, /subagent 模式/, 'test 唤醒同样短路');
    const t = await run('swarm_test', { run: 'SUBAG', task_id: 'S1', pass: true });
    assert.match(t, /通过/);
    assert.match(t, /subagent 模式|队列已清空|暂无可派发/, '派发下一单时的 dev 唤醒同样短路（或如实报暂无可派发/队列已空：三态对齐后有活不再报清空）');
    assert.equal(queueState().find((x) => x.id === 'S1').status, 'passed');
  });

  test('切回显式 sessions 后唤醒恢复（回退通道：status 显示 sessions）', async () => {
    await cmd('swarm-start', '--run SUBAG --executor sessions');
    assert.equal(subMeta().executor, 'sessions');
    const out = await cmd('swarm-status', '--run SUBAG');
    assert.match(out, /执行器：sessions/);
    await cmd('swarm-switch', '--run default', 'restore');
  });

  test('subagents 轮 #dev/#test 首行警告（PRD b，逐字锁 SUBAGENT_TAG_WARN）', async () => {
    await run('swarm_plan', {
      run: 'WARNAG',
      tasks: [{ id: 'WARN-1', wave: 'W1', title: '警告演练', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false}],
    });
    await cmd('swarm-start', '--run WARNAG --executor subagents');
    const evDev = { prompt: { text: '#dev WARN-1 开工' } };
    await promptHook(evDev);
    const firstDev = evDev.prompt.text.split('\n')[0];
    assert.equal(firstDev, SUBAGENT_TAG_WARN, 'dev 首行必须为子代理警告');
    assert.match(evDev.prompt.text, /你是 dev/);
    const evTest = { prompt: { text: '#test WARN-1 验证' } };
    await promptHook(evTest);
    assert.equal(evTest.prompt.text.split('\n')[0], SUBAGENT_TAG_WARN, 'test 首行必须为子代理警告');
    const evPlan = { prompt: { text: '#plan 拆解 warn 需求' } };
    await promptHook(evPlan);
    assert.doesNotMatch(evPlan.prompt.text.split('\n')[0], /子代理派发/, 'plan 不加警告');
    await new Promise((r) => setTimeout(r, 20)); // #plan 改名 fire-and-forget 落定
    // 切回 sessions：同 tag 不再警告（零变）
    await cmd('swarm-start', '--run WARNAG --executor sessions');
    const evDev2 = { prompt: { text: '#dev WARN-1 开工' } };
    await promptHook(evDev2);
    assert.notEqual(evDev2.prompt.text.split('\n')[0], SUBAGENT_TAG_WARN, 'sessions 下不得加警告');
    assert.doesNotMatch(evDev2.prompt.text.split('\n')[0], /子代理派发/);
    await cmd('swarm-switch', '--run default', 'restore-warn');
  });

  test('hybrid 按角色警告：dev 不警告 + test 警告（dev 常驻，test 走子代理）', async () => {
    await run('swarm_plan', {
      run: 'WARNHY',
      tasks: [{ id: 'WARN-H1', wave: 'W1', title: '混合警告', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false}],
    });
    await cmd('swarm-start', '--run WARNHY --executor hybrid');
    const evDev = { prompt: { text: '#dev WARN-H1 开工' } };
    await promptHook(evDev);
    assert.notEqual(evDev.prompt.text.split('\n')[0], SUBAGENT_TAG_WARN, 'hybrid dev 常驻不得加警告');
    assert.match(evDev.prompt.text, /你是 dev/);
    const evTest = { prompt: { text: '#test WARN-H1 验证' } };
    await promptHook(evTest);
    assert.equal(evTest.prompt.text.split('\n')[0], SUBAGENT_TAG_WARN, 'hybrid test 走子代理必须警告');
    const out = await cmd('swarm-status', '--run WARNHY');
    assert.match(out, /执行器：hybrid/);
    await cmd('swarm-switch', '--run default', 'restore-warnhy');
  });
});

describe('Reviewer-N1 全闭环（review=true）', () => {
  const fImp = (id, over = {}) => ({
    id, severity: 'Important', file: 'src/a.ts', line: 10, rule: 'no-any',
    evidence: '实测 any', suggestion: '改 unknown', status: 'open', ...over,
  });
  const fNit = (id, over = {}) => ({
    id, severity: 'Nit', file: 'src/a.ts', line: 20, rule: 'style',
    evidence: '空格', suggestion: '格式化', status: 'open', ...over,
  });

  test('review=false 零变：test pass 直通 passed（不进 reviewing）', async () => {
    await run('swarm_plan', {
      tasks: [{ id: 'REV-Z', wave: 'W9', title: '无评审', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false}],
    });
    await run('swarm_claim', { task_id: 'REV-Z' });
    await run('swarm_done', { task_id: 'REV-Z', summary: '无评审做完' });
    const out = await run('swarm_test', { task_id: 'REV-Z', pass: true });
    assert.match(out, /通过/);
    assert.doesNotMatch(out, /reviewing/, 'review=false 不得进 reviewing');
    assert.equal(queueState().find((t) => t.id === 'REV-Z').status, 'passed');
    assert.equal(queueState().find((t) => t.id === 'REV-Z').review, false);
  });

  test('medium 默认进评审：无 review 字段 test pass 进 reviewing（存量显式零变对照）', async () => {
    await run('swarm_plan', {
      tasks: [{ id: 'REV-D1', wave: 'W9', title: '默认评审', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' }],
    });
    await run('swarm_claim', { task_id: 'REV-D1' });
    await run('swarm_done', { task_id: 'REV-D1', summary: '默认开评' });
    const tp = await run('swarm_test', { task_id: 'REV-D1', pass: true });
    assert.match(tp, /reviewing待审/);
    assert.equal(queueState().find((t) => t.id === 'REV-D1').status, 'reviewing');
    assert.equal(queueState().find((t) => t.id === 'REV-D1').review, true);
    const ap = await run('swarm_review', { task_id: 'REV-D1', verdict: 'approve', findings: [] });
    assert.match(ap, /评审通过/);
    assert.equal(queueState().find((t) => t.id === 'REV-D1').status, 'passed');
  });

  test('low 默认直通：risk=low 无 review 字段 test pass 直接 passed', async () => {
    await run('swarm_plan', {
      tasks: [{ id: 'REV-D2', wave: 'W9', title: '低风险直通', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd', risk: 'low' }],
    });
    await run('swarm_claim', { task_id: 'REV-D2' });
    await run('swarm_done', { task_id: 'REV-D2', summary: '低风险做完' });
    const out = await run('swarm_test', { task_id: 'REV-D2', pass: true });
    assert.match(out, /通过/);
    assert.doesNotMatch(out, /reviewing/, 'low 默认不得进 reviewing');
    assert.equal(queueState().find((t) => t.id === 'REV-D2').status, 'passed');
    assert.equal(queueState().find((t) => t.id === 'REV-D2').review, false);
  });

  test('显式优先：risk=high + review=false 照直通（覆盖默认）', async () => {
    await run('swarm_plan', {
      tasks: [{ id: 'REV-D3', wave: 'W9', title: '显式关闭', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd', risk: 'high', review: false }],
    });
    await run('swarm_claim', { task_id: 'REV-D3' });
    await run('swarm_done', { task_id: 'REV-D3', summary: '显式关评' });
    const out = await run('swarm_test', { task_id: 'REV-D3', pass: true });
    assert.match(out, /通过/);
    assert.doesNotMatch(out, /reviewing/, '显式 false 不得进 reviewing');
    assert.equal(queueState().find((t) => t.id === 'REV-D3').status, 'passed');
  });

  test('approve 直过：test pass → reviewing → approve → passed（含 --task findings）', async () => {
    await run('swarm_plan', {
      tasks: [{ id: 'REV-A', wave: 'W9', title: '评审直过', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd', review: true, reviewDepth: 'quick' }],
    });
    await run('swarm_claim', { task_id: 'REV-A' });
    await run('swarm_done', { task_id: 'REV-A', summary: '待审' });
    const tp = await run('swarm_test', { task_id: 'REV-A', pass: true });
    assert.match(tp, /reviewing待审/);
    assert.match(tp, /reviewer/);
    assert.equal(queueState().find((t) => t.id === 'REV-A').status, 'reviewing');
    const ap = await run('swarm_review', { task_id: 'REV-A', verdict: 'approve', findings: [fNit('N1')] });
    assert.match(ap, /评审通过/);
    const t = queueState().find((x) => x.id === 'REV-A');
    assert.equal(t.status, 'passed');
    assert.ok(Array.isArray(t.findings) && t.findings.some((x) => x.id === 'N1'), 'findings 存 patch');
    const detail = await cmd('swarm-status', '--task REV-A');
    assert.match(detail, /findings/);
    assert.match(detail, /N1/);
  });

  test('verdict/关闭校验：非法一律拒收且状态不动', async () => {
    await run('swarm_plan', {
      tasks: [{ id: 'REV-V', wave: 'W9', title: '校验', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd', review: true }],
    });
    await run('swarm_claim', { task_id: 'REV-V' });
    await run('swarm_done', { task_id: 'REV-V', summary: '待校验' });
    await run('swarm_test', { task_id: 'REV-V', pass: true });
    assert.equal(queueState().find((t) => t.id === 'REV-V').status, 'reviewing');
    assert.match(await run('swarm_review', { task_id: 'REV-V', verdict: 'bogus', findings: [] }), /verdict 非法/);
    assert.match(await run('swarm_review', { task_id: 'REV-V', verdict: 'request-changes', findings: [] }), /open Important/);
    assert.match(await run('swarm_review', { task_id: 'REV-V', verdict: 'request-changes', findings: [fNit('N9')] }), /open Important/);
    assert.match(await run('swarm_review', { task_id: 'REV-V', verdict: 'approve', findings: [fImp('F9')] }), /open Important/);
    assert.match(await run('swarm_review', { task_id: 'REV-V', verdict: 'approve', findings: [{ ...fImp('F10'), status: 'wontfix' }] }), /reason/);
    assert.match(await run('swarm_review', { task_id: 'NOPE-9', verdict: 'approve', findings: [] }), /任务不存在/);
    assert.equal(queueState().find((t) => t.id === 'REV-V').status, 'reviewing', '拒收后状态不动');
    // 清理：正常 approve 过掉（含 wontfix+reason 关闭态）
    const ok = await run('swarm_review', { task_id: 'REV-V', verdict: 'approve', findings: [{ ...fImp('F10'), status: 'wontfix', reason: '存量，不修' }] });
    assert.match(ok, /评审通过/);
    assert.equal(queueState().find((t) => t.id === 'REV-V').status, 'passed');
  });

  test('request-changes 修后过：failed_ids 回注 + 排除集不重复贴', async () => {
    await run('swarm_plan', {
      tasks: [{ id: 'REV-B', wave: 'W9', title: '打回修后过', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd', review: true }],
    });
    await run('swarm_claim', { task_id: 'REV-B' });
    await run('swarm_done', { task_id: 'REV-B', summary: '第一版' });
    await run('swarm_test', { task_id: 'REV-B', pass: true });
    const rc = await run('swarm_review', { task_id: 'REV-B', verdict: 'request-changes', findings: [fImp('FB1')] });
    assert.match(rc, /评审打回/);
    assert.match(rc, /FB1/);
    let t = queueState().find((x) => x.id === 'REV-B');
    assert.equal(t.status, 'dev_doing');
    assert.equal(t.reviewRounds, 1);
    assert.equal(t.failed_ids, 'FB1');
    // dev 修后重走 gate→test→reviewing，第二轮 prompt 含排除集
    await run('swarm_done', { task_id: 'REV-B', summary: '修好 FB1' });
    const tp2 = await run('swarm_test', { task_id: 'REV-B', pass: true });
    assert.match(tp2, /reviewing待审/);
    assert.match(tp2, /FB1/, '第二轮排除集含已贴 FB1（不重复贴）');
    const ap2 = await run('swarm_review', { task_id: 'REV-B', verdict: 'approve', findings: [fNit('NB1')] });
    assert.match(ap2, /评审通过/);
    t = queueState().find((x) => x.id === 'REV-B');
    assert.equal(t.status, 'passed');
    assert.equal(t.reviewRounds, 1, 'approve 不计 reviewRounds');
  });

  test('reviewRounds 上限 HALT（两次 request-changes → halted）', async () => {
    await run('swarm_plan', {
      tasks: [{ id: 'REV-C', wave: 'W9', title: '上限熔断', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd', review: true }],
    });
    await run('swarm_claim', { task_id: 'REV-C' });
    await run('swarm_done', { task_id: 'REV-C', summary: '第一版' });
    await run('swarm_test', { task_id: 'REV-C', pass: true });
    await run('swarm_review', { task_id: 'REV-C', verdict: 'request-changes', findings: [fImp('FC1')] });
    assert.equal(queueState().find((t) => t.id === 'REV-C').reviewRounds, 1);
    await run('swarm_done', { task_id: 'REV-C', summary: '修一版' });
    await run('swarm_test', { task_id: 'REV-C', pass: true });
    const halt = await run('swarm_review', { task_id: 'REV-C', verdict: 'request-changes', findings: [fImp('FC2', { file: 'src/b.ts' })] });
    assert.match(halt, /HALT/);
    assert.match(halt, /重审/);
    const t = queueState().find((x) => x.id === 'REV-C');
    assert.equal(t.status, 'halted');
    assert.equal(t.reviewRounds, 2);
  });

  test('/swarm-retry 拉回 review 熔断任务且 reviewRounds 归零（否则下次打回即 HALT 死循环）', async () => {
    const out = await cmd('swarm-retry', '--task REV-C');
    assert.match(out, /已重派/);
    const t = queueState().find((x) => x.id === 'REV-C');
    assert.equal(t.status, 'dev_doing');
    assert.equal(t.reviewRounds, 0);
  });
});

describe('start 失败零落盘（校验前置）', () => {
  let dirC;
  let toolsC;
  let cmdsC;
  let promptsC;
  let sessionsC;
  let seqC = 0;

  const runC = async (name, input) => (await toolsC.get(name).execute(withForce(name, input))).content;
  const cmdC = async (name, text = '', sessionID = 's1') => {
    await cmdsC.get(name).execute({ sessionID, prompt: { text } });
    return promptsC.at(-1);
  };
  const metaOf = (run) => join(dirC, '.swarm', 'runs', run, 'meta.json');
  const queueOf = (run) => join(dirC, '.swarm', 'runs', run, 'queue.jsonl');
  const curFile = () => join(dirC, '.swarm', 'current');

  before(async () => {
    dirC = mkdtempSync(join(tmpdir(), 'swarm-cleanfail-'));
    writeFileSync(join(dirC, 'ok.mjs'), 'process.exit(0);\n');
    promptsC = [];
    toolsC = new Map();
    cmdsC = new Map();
    sessionsC = new Map();
    const ctxC = {
      location: { directory: dirC },
      // 注意：故意不传 queue → 按 run 切分，BADM 之类无队列 run 才真正走缺队列分支
      options: { channel: 'swarm-cleanfail', maxRetries: 3, verifyTimeoutMs: 20_000 },
      model: {
        list: async () => [
          { providerID: 'opencode-go', id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
          { providerID: 'opencode-go', id: 'muse-spark-1.3-contributor', name: 'Muse Spark' },
        ],
      },
      session: {
        prompt: async ({ sessionID, text }) => { promptsC.push(`[${sessionID}] ${text}`); },
        create: async ({ title, agent, model }) => {
          const id = `cf-${++seqC}`;
          sessionsC.set(id, { id, title, agent, model });
          return { id, title };
        },
        get: async ({ sessionID }) => sessionsC.get(sessionID),
        update: async ({ sessionID, title }) => {
          const s = sessionsC.get(sessionID) ?? { id: sessionID };
          s.title = title;
          sessionsC.set(sessionID, s);
        },
        switchModel: async () => {},
        hook: async () => {},
      },
      command: { transform: async (fn) => fn({ add: (d) => cmdsC.set(d.name, d) }) },
      tool: { transform: async (fn) => fn({ add: (d) => toolsC.set(d.name, d) }) },
    };
    await plugin.setup(ctxC);
  });

  after(() => { rmSync(dirC, { recursive: true, force: true }); });

  test('无队列 run 直接回：无 meta 落盘、current 不动（连文件都不建）', async () => {
    assert.equal(existsSync(curFile()), false, '前置：尚无 current 指针');
    const out = await cmdC('swarm-start', '--run BADM');
    assert.match(out, /队列不存在/);
    assert.match(out, /BADM/);
    assert.equal(existsSync(metaOf('BADM')), false, '失败 start 不写 meta');
    assert.equal(existsSync(queueOf('BADM')), false, '失败 start 不建队列文件');
    assert.equal(existsSync(curFile()), false, '失败 start 不动 current（连文件都不建）');
  });

  test('缺队列 + 非法 executor：先报队列缺失，同样零落盘', async () => {
    const out = await cmdC('swarm-start', '--run BADM --executor bogus');
    assert.match(out, /队列不存在/, '队列检查前置，优先于执行器校验');
    assert.equal(existsSync(metaOf('BADM')), false, '失败 start 不写 meta');
    assert.equal(existsSync(curFile()), false, '失败 start 不动 current');
  });

  test('非法 executor 仍拒收：有队列也不写 meta、不动 current', async () => {
    const p = await runC('swarm_plan', {
      run: 'OKR',
      tasks: [{ id: 'C-T1', wave: 'W1', title: 'cleanfail 演练', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false}],
    });
    assert.match(p, /C-T1: queued/);
    const metaBefore = readFileSync(metaOf('OKR'), 'utf8');
    const out = await cmdC('swarm-start', '--run OKR --executor bogus');
    assert.match(out, /只接受 sessions\|subagents\|hybrid/);
    assert.equal(readFileSync(metaOf('OKR'), 'utf8'), metaBefore, '拒收后 meta 原样不动');
    assert.equal(existsSync(curFile()), false, '拒收不动 current');
  });

  test('成功 start 照常派发并认领 current（成功路径零变）', async () => {
    const out = await cmdC('swarm-start', '--run OKR --executor sessions');
    assert.match(out, /已派发 C-T1/);
    assert.equal(readFileSync(curFile(), 'utf8').trim(), 'OKR', '成功 start 才认领 current');
  });

  test('up 队列无关项无副作用：dry-run/未知角色/模型非法不落 meta、不动 current', async () => {
    const curBefore = readFileSync(curFile(), 'utf8').trim();
    assert.equal(curBefore, 'OKR');
    const d = await cmdC('swarm-up', '--run DRYQ --dry-run --dev-model opencode-go/deepseek-v4.1-flash');
    assert.match(d, /未创建任何会话/);
    assert.equal(existsSync(metaOf('DRYQ')), false, 'dry-run 不落盘');
    const u = await cmdC('swarm-up', '--roles bogusrole');
    assert.match(u, /未知角色/);
    const m = await cmdC('swarm-up', '--run BADMUP --planner-model opencode-go/retired-model');
    assert.match(m, /未创建任何会话/);
    assert.match(m, /没有模型/);
    assert.equal(existsSync(metaOf('BADMUP')), false, '模型非法不落盘');
    assert.equal(readFileSync(curFile(), 'utf8').trim(), curBefore, 'up 失败不动 current');
  });

  test('start 坏 --dev-model 被拒收：不落盘、不动 current（含候选）', async () => {
    const p = await runC('swarm_plan', {
      run: 'MODELC',
      tasks: [{ id: 'C-M1', wave: 'W1', title: '模型校验演练', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false}],
    });
    assert.match(p, /C-M1: queued/);
    const curBefore = readFileSync(curFile(), 'utf8').trim();
    const metaBefore = readFileSync(metaOf('MODELC'), 'utf8'); // plan 已建空 meta：拒收后内容必须原样不动
    const out = await cmdC('swarm-start', '--run MODELC --dev-model opencode-go/retired-model');
    assert.match(out, /参数错误/);
    assert.match(out, /没有模型 "retired-model"/);
    assert.match(out, /你是不是想用/);
    assert.equal(readFileSync(metaOf('MODELC'), 'utf8'), metaBefore, '坏模型拒收不写 meta');
    assert.equal(readFileSync(curFile(), 'utf8').trim(), curBefore, '拒收不动 current');
  });

  test('start 模型口径与 up 一致：provider 大小写/格式错都给人话', async () => {
    const curBefore = readFileSync(curFile(), 'utf8').trim();
    const metaBefore = readFileSync(metaOf('MODELC'), 'utf8');
    const c = await cmdC('swarm-start', '--run MODELC --dev-model OpenCode/deepseek-v4.1-flash');
    assert.match(c, /参数错误/);
    assert.match(c, /opencode-go\/deepseek-v4\.1-flash/);
    assert.equal(readFileSync(metaOf('MODELC'), 'utf8'), metaBefore, '大小写错拒收不写 meta');
    const f = await cmdC('swarm-start', '--run MODELC --dev-model deepseek-v4.1-flash');
    assert.match(f, /格式不对/);
    assert.match(f, /provider\/model/);
    assert.equal(readFileSync(metaOf('MODELC'), 'utf8'), metaBefore, '格式错拒收不写 meta');
    assert.equal(readFileSync(curFile(), 'utf8').trim(), curBefore, '拒收不动 current');
  });

  test('start planner 系坏模型同样拒收（只验：非法即拦）', async () => {
    const metaBefore = readFileSync(metaOf('MODELC'), 'utf8');
    const out = await cmdC('swarm-start', '--run MODELC --planner-model opencode-go/retired-model');
    assert.match(out, /参数错误/);
    assert.match(out, /没有模型/);
    assert.equal(readFileSync(metaOf('MODELC'), 'utf8'), metaBefore, 'planner 坏模型拒收不写 meta');
  });

  test('start 好模型成功路径零变：roleModels 照落 dev/test 并派发', async () => {
    const out = await cmdC('swarm-start', '--run MODELC --dev-model opencode-go/muse-spark-1.3-contributor --tester-model opencode-go/deepseek-v4.1-flash');
    assert.match(out, /已派发 C-M1/);
    const meta = JSON.parse(readFileSync(metaOf('MODELC'), 'utf8'));
    assert.deepEqual(meta.roleModels, { dev: 'opencode-go/muse-spark-1.3-contributor', test: 'opencode-go/deepseek-v4.1-flash' });
    assert.equal(readFileSync(curFile(), 'utf8').trim(), 'MODELC', '成功 start 才认领 current');
  });
});

describe('模型注册表不可用时 fail-open（放行不卡编排）', () => {
  let dirF;
  let runF;
  let cmdsF;
  let promptsF;

  const cmdF = async (name, text = '', sessionID = 's1') => {
    await cmdsF.get(name).execute({ sessionID, prompt: { text } });
    return promptsF.at(-1);
  };
  const metaF = (run) => join(dirF, '.swarm', 'runs', run, 'meta.json');

  before(async () => {
    dirF = mkdtempSync(join(tmpdir(), 'swarm-failopen-'));
    writeFileSync(join(dirF, 'ok.mjs'), 'process.exit(0);\n');
    promptsF = [];
    const toolsF = new Map();
    cmdsF = new Map();
    const ctxF = {
      location: { directory: dirF },
      options: { channel: 'swarm-failopen', maxRetries: 3, verifyTimeoutMs: 20_000 },
      model: { list: async () => { throw new Error('registry down'); } },
      session: {
        prompt: async ({ sessionID, text }) => { promptsF.push(`[${sessionID}] ${text}`); },
        create: async ({ title }) => ({ id: 'f1', title }),
        get: async () => undefined,
        update: async () => {},
        switchModel: async () => {},
        hook: async () => {},
      },
      command: { transform: async (fn) => fn({ add: (d) => cmdsF.set(d.name, d) }) },
      tool: { transform: async (fn) => fn({ add: (d) => toolsF.set(d.name, d) }) },
    };
    await plugin.setup(ctxF);
    runF = async (name, input) => (await toolsF.get(name).execute(withForce(name, input))).content;
  });

  after(() => { rmSync(dirF, { recursive: true, force: true }); });

  test('注册表挂了：坏模型也放行（fail-open），start 照常派发落盘', async () => {
    const p = await runF('swarm_plan', {
      run: 'FO',
      tasks: [{ id: 'F-T1', wave: 'W1', title: 'failopen 演练', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false}],
    });
    assert.match(p, /F-T1: queued/);
    const out = await cmdF('swarm-start', '--run FO --dev-model bogus-prov-xyz/bogus-model-xyz');
    assert.match(out, /已派发 F-T1/, 'fail-open：注册表不可用时不拦模型');
    const meta = JSON.parse(readFileSync(metaF('FO'), 'utf8'));
    assert.equal(meta.roleModels.dev, 'bogus-prov-xyz/bogus-model-xyz', '放行即照常落盘');
  });
});

describe('/swarm-drained 只读判活（三态与 dispatchNext 同调）', () => {
  let dirD;
  let runD;
  let cmdD;
  let promptsD;
  let promptCountD;
  const queueFile = (run) => join(dirD, '.swarm', 'runs', run, 'queue.jsonl');
  const timelineFile = (run) => join(dirD, '.swarm', 'runs', run, 'timeline.jsonl');
  const queueRows = (run) => JSON.parse(`[${readFileSync(queueFile(run), 'utf8').split('\n').filter(Boolean).join(',')}]`);

  before(async () => {
    dirD = mkdtempSync(join(tmpdir(), 'swarm-drained-'));
    writeFileSync(join(dirD, 'ok.mjs'), 'process.exit(0);\n');
    promptsD = [];
    promptCountD = 0;
    const toolsD = new Map();
    const cmdsD = new Map();
    const ctxD = {
      location: { directory: dirD },
      // 注意：故意不传 queue → 按 run 切分，本 describe 全隔离
      options: { channel: 'swarm-drained-e2e', maxRetries: 3, verifyTimeoutMs: 20_000 },
      model: { list: async () => [] },
      session: {
        prompt: async ({ sessionID, text }) => { promptsD.push(`[${sessionID}] ${text}`); promptCountD += 1; },
        create: async ({ title }) => ({ id: 'd1', title }),
        get: async () => undefined,
        update: async () => {},
        switchModel: async () => {},
        hook: async () => {},
      },
      command: { transform: async (fn) => fn({ add: (d) => cmdsD.set(d.name, d) }) },
      tool: { transform: async (fn) => fn({ add: (d) => toolsD.set(d.name, d) }) },
    };
    await plugin.setup(ctxD);
    runD = async (name, input) => (await toolsD.get(name).execute(withForce(name, input))).content;
    cmdD = async (name, text = '', sessionID = 's1') => {
      await cmdsD.get(name).execute({ sessionID, prompt: { text } });
      return promptsD.at(-1);
    };
  });

  after(() => { rmSync(dirD, { recursive: true, force: true }); });

  test('缺队列视为 drained（无任务，无需派发）', async () => {
    const out = await cmdD('swarm-drained', '--run EMPTYQ');
    assert.match(out, /## swarm-drained/);
    assert.match(out, /drained/);
    assert.equal(existsSync(queueFile('EMPTYQ')), false, '只读命令不得建队列文件');
  });

  test('有活输出：queued 任务列 id（只读：队列+timeline 双快照不动）', async () => {
    await runD('swarm_plan', {
      run: 'DR',
      tasks: [
        { id: 'D-Q1', wave: 'W1', title: '待派发一', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false},
        { id: 'D-Q2', wave: 'W1', title: '待派发二', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false},
      ],
    });
    const qBefore = JSON.stringify(queueRows('DR'));
    const tlBefore = readFileSync(timelineFile('DR'), 'utf8');
    const out = await cmdD('swarm-drained', '--run DR');
    assert.match(out, /有活/);
    assert.match(out, /drained=false/);
    assert.match(out, /D-Q1.*queued/);
    assert.match(out, /D-Q2.*queued/);
    assert.equal(JSON.stringify(queueRows('DR')), qBefore, 'drained 不得改队列');
    assert.equal(readFileSync(timelineFile('DR'), 'utf8'), tlBefore, 'drained 不得写 timeline');
  });

  test('只读三不碰：不 transition、不 wake、不改状态（除回复外零 prompt）', async () => {
    const qBefore = JSON.stringify(queueRows('DR'));
    const nBefore = promptCountD;
    const out = await cmdD('swarm-drained', '--run DR');
    assert.match(out, /有活/);
    assert.equal(promptCountD, nBefore + 1, '除本次回复外不得再调 session.prompt（零唤醒）');
    assert.equal(JSON.stringify(queueRows('DR')), qBefore, '状态纹丝不动');
    for (const t of queueRows('DR')) assert.equal(t.status, 'queued');
  });

  test('三态都算活：dev_doing/test_doing/reviewing 任一非空即有活', async () => {
    await runD('swarm_plan', {
      run: 'DR3',
      tasks: [
        { id: 'D-D1', wave: 'W1', title: 'dev 中', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false},
        { id: 'D-D2', wave: 'W1', title: 'test 中', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false},
        { id: 'D-D3', wave: 'W1', title: '评审中', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd', review: true },
      ],
    });
    await runD('swarm_claim', { run: 'DR3', task_id: 'D-D1' }); // → dev_doing
    // D-D2 推到 test_doing（经合法边 dev_doing→gate_check→test_doing，带 timeline）
    const { transitionTask } = await import('../lib/swarm-store.js');
    const { resolveRun } = await import('../lib/swarm-run.js');
    const qp = queueFile('DR3');
    const tp = resolveRun(dirD, { run: 'DR3' }).timelinePath;
    const push = () => {
      const a = transitionTask(qp, tp, { taskId: 'D-D2', expect: 'dev_doing', patch: { status: 'gate_check' }, by: 'dev', reason: 'setup-push-enter' });
      if (!a.ok) return a;
      return transitionTask(qp, tp, { taskId: 'D-D2', expect: 'gate_check', patch: { status: 'test_doing', assignee: 'test' }, by: 'gate', reason: 'setup-push-pass' });
    };
    // D-D2 先 claim 到 dev_doing 才能进 gate
    await runD('swarm_claim', { run: 'DR3', task_id: 'D-D2' });
    assert.equal(push().ok, true);
    // D-D3 走全链路到 reviewing
    await runD('swarm_claim', { run: 'DR3', task_id: 'D-D3' });
    await runD('swarm_done', { run: 'DR3', task_id: 'D-D3', summary: '待审' });
    const tp3 = await runD('swarm_test', { run: 'DR3', task_id: 'D-D3', pass: true });
    assert.match(tp3, /reviewing待审/);
    const out = await cmdD('swarm-drained', '--run DR3');
    assert.match(out, /有活/);
    assert.match(out, /D-D1 dev_doing/);
    assert.match(out, /D-D2 test_doing/);
    assert.match(out, /D-D3 reviewing/);
  });

  test('收尾全过后 drained，且与 dispatchNext 同调（approve 报队列已清空）', async () => {
    await runD('swarm_done', { run: 'DR3', task_id: 'D-D1', summary: '做完' });
    await runD('swarm_test', { run: 'DR3', task_id: 'D-D1', pass: true });
    await runD('swarm_test', { run: 'DR3', task_id: 'D-D2', pass: true });
    const ap = await runD('swarm_review', { run: 'DR3', task_id: 'D-D3', verdict: 'approve', findings: [] });
    assert.match(ap, /评审通过/);
    assert.match(ap, /队列已清空/, 'dispatchNext 同调：真清空才报清空');
    const out = await cmdD('swarm-drained', '--run DR3');
    assert.match(out, /✅ drained/);
  });

  test('有活时 pass 报暂无可派发而非队列已清空（review 不再烂尾）', async () => {
    await runD('swarm_plan', {
      run: 'DR4',
      tasks: [
        { id: 'D-R1', wave: 'W1', title: '评审中', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd', review: true },
        { id: 'D-R2', wave: 'W1', title: '后过', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false},
      ],
    });
    // D-R1 走完全链路到 reviewing（待审）
    await runD('swarm_claim', { run: 'DR4', task_id: 'D-R1' });
    await runD('swarm_done', { run: 'DR4', task_id: 'D-R1', summary: '待审' });
    const t1 = await runD('swarm_test', { run: 'DR4', task_id: 'D-R1', pass: true });
    assert.match(t1, /reviewing待审/);
    // D-R2（review=false）pass：无 queued 但 D-R1 reviewing 有活 → 不得报清空
    await runD('swarm_claim', { run: 'DR4', task_id: 'D-R2' });
    await runD('swarm_done', { run: 'DR4', task_id: 'D-R2', summary: '后过做完' });
    const t2 = await runD('swarm_test', { run: 'DR4', task_id: 'D-R2', pass: true });
    assert.match(t2, /通过/);
    assert.doesNotMatch(t2, /队列已清空/, '有 reviewing 待审时不得报清空');
    assert.match(t2, /暂无可派发/, '应如实报暂无可派发（含进行中列表）');
    assert.match(t2, /D-R1 reviewing/);
    const out = await cmdD('swarm-drained', '--run DR4');
    assert.match(out, /有活/);
    assert.match(out, /D-R1 reviewing/);
    // 清场：approve → 真清空，drained 与 dispatchNext 同调
    const ap = await runD('swarm_review', { run: 'DR4', task_id: 'D-R1', verdict: 'approve', findings: [] });
    assert.match(ap, /评审通过/);
    assert.match(ap, /队列已清空/);
    assert.match(await cmdD('swarm-drained', '--run DR4'), /✅ drained/);
  });

  test('防漂：mode 输出与手册§9.2 逐字含同一 recipe 常量（单源 DRAINED_RECIPE）', async () => {
    // 防漂选型（PRD 二选一，选此项）：判活用语收敛到 swarm.js 唯一常量，
    // /swarm-mode 输出引用它，手册§9.2 逐字抄它，本用例断言两边都含它。
    const modeOut = await cmdD('swarm-mode', '--run DR');
    assert.ok(modeOut.includes(DRAINED_RECIPE), 'mode 输出须逐字含 DRAINED_RECIPE');
    assert.ok(modeOut.includes(DRAINED_END_LINE), 'mode 输出须含判活结束语');
    const manual = readFileSync(new URL('../docs/swarm-使用手册.md', import.meta.url), 'utf8');
    assert.ok(manual.includes(DRAINED_RECIPE), '手册§9.2 须逐字含 DRAINED_RECIPE（改文案先改 swarm.js 常量，两边同改）');
    assert.ok(manual.includes(DRAINED_END_LINE), '手册§9.2 须含判活结束语');
    assert.deepEqual(LIVE_STATUSES, ['dev_doing', 'test_doing', 'reviewing'], '判活三态口径锁死');
    assert.deepEqual(liveTasks([{ status: 'dev_doing' }, { status: 'queued' }, { status: 'passed' }]).map((t) => t.status), ['dev_doing']);
  });

  test('默认 hybrid：bare start 派发 dev 走会话唤醒口径（无登记会话则提示未登记，不短路）', async () => {
    await runD('swarm_plan', {
      run: 'DRSUB',
      tasks: [{ id: 'D-S1', wave: 'W1', title: '默认派发', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false}],
    });
    const nBefore = promptCountD;
    const out = await cmdD('swarm-start', '--run DRSUB');
    assert.match(out, /已派发 D-S1/);
    assert.match(out, /未自动唤醒/, 'hybrid dev 走会话唤醒口径：无登记会话则提示未登记');
    assert.match(out, /未登记 dev 会话/);
    assert.equal(promptCountD, nBefore + 1, '除本次回复外不得再调 session.prompt（无会话可唤醒，零投递）');
    assert.equal(queueRows('DRSUB').find((t) => t.id === 'D-S1').status, 'dev_doing', '状态照常流转');
  });

  test('默认 hybrid：status 显示 hybrid 执行器 + 会话表（无折叠）', async () => {
    const out = await cmdD('swarm-status', '--run DRSUB');
    assert.match(out, /执行器：hybrid/);
    assert.match(out, /默认 hybrid/);
    assert.doesNotMatch(out, /子代理派发中（无 role 会话）/, 'hybrid 不折叠会话区');
    assert.doesNotMatch(out, /待派发：/, 'hybrid 不走 subagents 待派发一行');
  });

  test('显式 subagents 仍折叠零变（整轮子代理）', async () => {
    await runD('swarm_plan', {
      run: 'DRSUB2',
      tasks: [{ id: 'D-S2', wave: 'W1', title: '显式折叠', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false}],
    });
    await runD('swarm_claim', { run: 'DRSUB2', task_id: 'D-S2' });
    await cmdD('swarm-start', '--run DRSUB2 --executor subagents');
    const out = await cmdD('swarm-status', '--run DRSUB2');
    assert.match(out, /执行器：subagents/);
    assert.match(out, /子代理派发中（无 role 会话）/);
    assert.match(out, /待派发：.*D-S2 dev_doing/);
    assert.doesNotMatch(out, /\| 手上任务 \|/, '显式 subagents 不得出现手上任务列表头');
  });

  test('混合派发锁定：dev 唤醒常驻 + test 走子代理（hybrid 按角色拆）', async () => {
    await runD('swarm_plan', {
      run: 'DRHY',
      tasks: [{ id: 'D-H1', wave: 'W1', title: '混合派发', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false}],
    });
    // hybrid 缺省：dev 派发走会话唤醒口径（本 ctx 无登记会话则提示未登记，非 subagent 短路）
    const out = await cmdD('swarm-start', '--run DRHY');
    assert.match(out, /已派发 D-H1/);
    assert.match(out, /执行器|未自动唤醒|未登记/, 'hybrid dev 派发应走会话唤醒口径');
    assert.doesNotMatch(out, /subagent 模式：编排会话用 subagent 工具直接派发/, 'hybrid dev 不得走整轮 subagent 短路');
    // test 唤醒在 hybrid 下短路（done 后 test 走子代理）
    await runD('swarm_claim', { run: 'DRHY', task_id: 'D-H1' });
    const done = await runD('swarm_done', { run: 'DRHY', task_id: 'D-H1', summary: '混合做完' });
    assert.match(done, /门禁通过/);
    assert.match(done, /subagent 模式/, 'hybrid test 走子代理：done 后 test 唤醒短路');
  });
});

describe('/swarm-eval 只读导出（幂等 + 只读）+ 门禁 warning 可见', () => {
  let dirE;
  let runE;
  let cmdE;
  let promptsE;
  const qFile = (run) => join(dirE, '.swarm', 'runs', run, 'queue.jsonl');
  const tlFile = (run) => join(dirE, '.swarm', 'runs', run, 'timeline.jsonl');
  const evalFile = (month) => join(dirE, '.swarm', 'eval', `${month}.jsonl`);
  const queueRows = (run) => JSON.parse(`[${readFileSync(qFile(run), 'utf8').split('\n').filter(Boolean).join(',')}]`);
  const evalRows = (month) => readFileSync(evalFile(month), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

  before(async () => {
    dirE = mkdtempSync(join(tmpdir(), 'swarm-eval-'));
    writeFileSync(join(dirE, 'ok.mjs'), 'process.exit(0);\n');
    promptsE = [];
    const toolsE = new Map();
    const cmdsE = new Map();
    const ctxE = {
      location: { directory: dirE },
      // 注意：故意不传 queue → 按 run 切分，本 describe 全隔离
      options: { channel: 'swarm-eval-e2e', maxRetries: 3, verifyTimeoutMs: 20_000 },
      model: { list: async () => [] },
      session: {
        prompt: async ({ sessionID, text }) => { promptsE.push(`[${sessionID}] ${text}`); },
        create: async ({ title }) => ({ id: 'e1', title }),
        get: async () => undefined,
        update: async () => {},
        switchModel: async () => {},
        hook: async () => {},
      },
      command: { transform: async (fn) => fn({ add: (d) => cmdsE.set(d.name, d) }) },
      tool: { transform: async (fn) => fn({ add: (d) => toolsE.set(d.name, d) }) },
    };
    await plugin.setup(ctxE);
    runE = async (name, input) => (await toolsE.get(name).execute(withForce(name, input))).content;
    cmdE = async (name, text = '', sessionID = 's1') => {
      await cmdsE.get(name).execute({ sessionID, prompt: { text } });
      return promptsE.at(-1);
    };
  });

  after(() => { rmSync(dirE, { recursive: true, force: true }); });

  test('warning 在门禁 reason 可见（done 放行输出带 security 占位 warning）', async () => {
    await runE('swarm_plan', {
      run: 'EV',
      tasks: [{ id: 'E-W1', wave: 'W1', title: 'warning 演练', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false}],
    });
    await runE('swarm_claim', { run: 'EV', task_id: 'E-W1' });
    const out = await runE('swarm_done', { run: 'EV', task_id: 'E-W1', summary: '做完待验' });
    assert.match(out, /门禁通过/);
    assert.match(out, /security-not-configured/, 'security 占位 warning 应在门禁 reason 可见');
    assert.match(out, /⚠️/, 'warning 应透出 warn 标记');
  });

  test('eval 导出 HALT/fail 打回/review/revert/approve 全类信号', async () => {
    // E-W1：test_doing → fail 打回（E-W1 当前 test_doing）
    const f1 = await runE('swarm_test', { run: 'EV', task_id: 'E-W1', pass: false, failed_ids: 'F1', detail: '挂一次', disposition: 'fixed' });
    assert.match(f1, /回 dev/);
    // E-H1：人工 HALT 行
    await runE('swarm_plan', {
      run: 'EV',
      tasks: [{ id: 'E-H1', wave: 'W1', title: '待熔断', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false}],
    });
    const h1 = await cmdE('swarm-halt', '--run EV --task E-H1 --reason 演练熔断');
    assert.match(h1, /已熔断 E-H1/);
    // E-R1：review 全链路（request-changes 打回边 + approve 行）
    await runE('swarm_plan', {
      run: 'EV',
      tasks: [{ id: 'E-R1', wave: 'W1', title: '评审演练', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd', review: true }],
    });
    await runE('swarm_claim', { run: 'EV', task_id: 'E-R1' });
    await runE('swarm_done', { run: 'EV', task_id: 'E-R1', summary: '待审' });
    const t1 = await runE('swarm_test', { run: 'EV', task_id: 'E-R1', pass: true });
    assert.match(t1, /reviewing待审/);
    const rc = await runE('swarm_review', { run: 'EV', task_id: 'E-R1', verdict: 'request-changes', findings: [{ id: 'FB-1', severity: 'Important', file: 'a.ts', line: 1, rule: 'r', evidence: 'e', status: 'open' }] });
    assert.match(rc, /评审打回/);
    await runE('swarm_done', { run: 'EV', task_id: 'E-R1', summary: '修后待审' });
    const t2 = await runE('swarm_test', { run: 'EV', task_id: 'E-R1', pass: true });
    assert.match(t2, /reviewing待审/);
    const ap = await runE('swarm_review', { run: 'EV', task_id: 'E-R1', verdict: 'approve', findings: [] });
    assert.match(ap, /评审通过/);
    // revert 行（passed → dev_doing）
    const rv = await cmdE('swarm-revert', '--run EV --task E-R1');
    assert.match(rv, /dev_doing/);
    // 导出
    const out = await cmdE('swarm-eval', '--run EV --month 2026-10');
    assert.match(out, /## swarm-eval/);
    assert.match(out, /只读，未改任何状态/);
    assert.equal(existsSync(evalFile('2026-10')), true, 'eval 文件应落盘');
    const rows = evalRows('2026-10');
    assert.ok(rows.length > 0, '应导出至少一行 eval 信号');
    assert.ok(rows.some((r) => r.to === 'halted'), '应含 HALT 行');
    assert.ok(rows.some((r) => r.kind === 'move' && r.to === 'dev_doing'), '应含 fail 打回边');
    assert.ok(rows.some((r) => r.kind === 'review'), '应含 review 行（request-changes/approve）');
    assert.ok(rows.some((r) => r.kind === 'revert'), '应含 revert 行');
    assert.ok(rows.some((r) => r.to === 'passed'), '应含 approve（to=passed）行');
    assert.equal(new Set(rows.map((r) => r.eid)).size, rows.length, 'eid 应唯一');
  });

  test('eval 幂等：跑两次行数不变 + 只读：队列快照一致', async () => {
    const n1 = evalRows('2026-10').length;
    const qBefore = JSON.stringify(queueRows('EV'));
    const tlBefore = readFileSync(tlFile('EV'), 'utf8');
    const out = await cmdE('swarm-eval', '--run EV --month 2026-10');
    assert.match(out, /只读，未改任何状态/);
    const n2 = evalRows('2026-10').length;
    assert.equal(n2, n1, '同 eid 跳过：第二次导出不得新增行');
    assert.equal(JSON.stringify(queueRows('EV')), qBefore, 'eval 不得改队列');
    assert.equal(readFileSync(tlFile('EV'), 'utf8'), tlBefore, 'eval 不得写 timeline');
  });

  test('month 非法回用法（不建文件）', async () => {
    const out = await cmdE('swarm-eval', '--run EV --month 202610');
    assert.match(out, /用法/);
    assert.equal(existsSync(evalFile('202610')), false, '非法 month 不得建文件');
  });

  test('eval 收 kind=approve 审计行（approve 后导出含该行）', async () => {
    await runE('swarm_plan', {
      run: 'EV',
      tasks: [{ id: 'E-AP1', wave: 'W1', title: '高风险待批', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd', risk: 'high', review: false }],
    });
    const ap = await runE('swarm_approve', { run: 'EV', task_id: 'E-AP1' });
    assert.match(ap, /已批准/);
    const out = await cmdE('swarm-eval', '--run EV --month 2026-11');
    assert.match(out, /## swarm-eval/);
    assert.equal(existsSync(evalFile('2026-11')), true, 'eval 文件应落盘');
    const rows = evalRows('2026-11');
    assert.ok(rows.some((r) => r.kind === 'approve' && r.taskId === 'E-AP1'), 'approve 后导出应含 kind=approve 行');
  });
});

describe('/swarm-clean 归档 + current 善后', () => {
  let dirL;
  let runL;
  let cmdL;
  let promptsL;
  const qFile = (run) => join(dirL, '.swarm', 'runs', run, 'queue.jsonl');
  const runDir = (run) => join(dirL, '.swarm', 'runs', run);
  const curFile = () => join(dirL, '.swarm', 'current');
  const queueRows = (run) => JSON.parse(`[${readFileSync(qFile(run), 'utf8').split('\n').filter(Boolean).join(',')}]`);

  before(async () => {
    dirL = mkdtempSync(join(tmpdir(), 'swarm-clean-'));
    writeFileSync(join(dirL, 'ok.mjs'), 'process.exit(0);\n');
    promptsL = [];
    const toolsL = new Map();
    const cmdsL = new Map();
    const ctxL = {
      location: { directory: dirL },
      options: { channel: 'swarm-clean-e2e', maxRetries: 3, verifyTimeoutMs: 20_000 },
      model: { list: async () => [] },
      session: {
        prompt: async ({ sessionID, text }) => { promptsL.push(`[${sessionID}] ${text}`); },
        create: async ({ title }) => ({ id: 'c1', title }),
        get: async () => undefined,
        update: async () => {},
        switchModel: async () => {},
        hook: async () => {},
      },
      command: { transform: async (fn) => fn({ add: (d) => cmdsL.set(d.name, d) }) },
      tool: { transform: async (fn) => fn({ add: (d) => toolsL.set(d.name, d) }) },
    };
    await plugin.setup(ctxL);
    runL = async (name, input) => (await toolsL.get(name).execute(withForce(name, input))).content;
    cmdL = async (name, text = '', sessionID = 's1') => {
      await cmdsL.get(name).execute({ sessionID, prompt: { text } });
      return promptsL.at(-1);
    };
  });

  after(() => { rmSync(dirL, { recursive: true, force: true }); });

  test('单轮归档：文件齐全（queue/timeline/events/round/meta 全在）+ current 善后清空', async () => {
    await runL('swarm_plan', {
      run: 'CLEAN1',
      name: '清理演练',
      tasks: [{ id: 'CL-1', wave: 'W1', title: '待归档', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false}],
    });
    await runL('swarm_claim', { run: 'CLEAN1', task_id: 'CL-1' });
    await runL('swarm_done', { run: 'CLEAN1', task_id: 'CL-1', summary: '做完' });
    await runL('swarm_test', { run: 'CLEAN1', task_id: 'CL-1', pass: true });
    assert.equal(queueRows('CLEAN1').find((t) => t.id === 'CL-1').status, 'passed');
    await cmdL('swarm-switch', '--run CLEAN1');
    assert.equal(readFileSync(curFile(), 'utf8').trim(), 'CLEAN1');
    const out = await cmdL('swarm-clean', '--run CLEAN1');
    assert.match(out, /已归档轮 \*\*CLEAN1\*\*/);
    assert.equal(existsSync(runDir('CLEAN1')), false, '源目录应已搬走');
    const { readdirSync: ls } = await import('node:fs');
    const arch = ls(join(dirL, '.swarm', 'archive')).find((n) => n.startsWith('CLEAN1-'));
    assert.ok(arch, 'archive 下应有 CLEAN1-<日期> 目录');
    for (const f of ['queue.jsonl', 'timeline.jsonl', 'events.jsonl', 'round.json', 'meta.json']) {
      assert.equal(existsSync(join(dirL, '.swarm', 'archive', arch, f)), true, `${f} 须保留供审计`);
    }
    // current 善后：无有活轮 → 清空（board 读不到指针走灰态）
    assert.equal(existsSync(curFile()), false, '无有活轮时 current 文件应被清空');
  });

  test('--all-done 不碰有活轮（混合轮断言）', async () => {
    await runL('swarm_plan', {
      run: 'DONEX',
      tasks: [{ id: 'DX-1', wave: 'W1', title: '已完工', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false}],
    });
    await runL('swarm_claim', { run: 'DONEX', task_id: 'DX-1' });
    await runL('swarm_done', { run: 'DONEX', task_id: 'DX-1', summary: '完工' });
    await runL('swarm_test', { run: 'DONEX', task_id: 'DX-1', pass: true });
    await runL('swarm_plan', {
      run: 'LIVEX',
      tasks: [{ id: 'LX-1', wave: 'W1', title: '进行中', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false}],
    });
    await runL('swarm_claim', { run: 'LIVEX', task_id: 'LX-1' });
    assert.equal(queueRows('LIVEX')[0].status, 'dev_doing');
    const out = await cmdL('swarm-clean', '--all-done');
    assert.match(out, /DONEX/);
    assert.match(out, /跳过/);
    assert.match(out, /LIVEX/);
    assert.equal(existsSync(runDir('LIVEX')), true, '有活轮不得被搬');
    assert.equal(existsSync(runDir('DONEX')), false, '完工轮应被搬走');
  });

  test('清 current 轮后 board 灰字而非红 STALE（空态区分锁）', async () => {
    const { readRunSnapshot } = await import('../lib/swarm-board-data.mjs');
    const { readCurrentRunId } = await import('../lib/swarm-run.js');
    // 当前 state：LIVEX 有活但非 current（current 已在首个用例被清空）；先指到 LIVEX 再清它
    await cmdL('swarm-switch', '--run LIVEX');
    assert.equal(readFileSync(curFile(), 'utf8').trim(), 'LIVEX');
    // 先把 LIVEX 走完再清，使清后无有活轮 → current 清空 → 灰态
    await runL('swarm_done', { run: 'LIVEX', task_id: 'LX-1', summary: '收尾' });
    await runL('swarm_test', { run: 'LIVEX', task_id: 'LX-1', pass: true });
    const out = await cmdL('swarm-clean', '--run LIVEX');
    assert.match(out, /已归档轮 \*\*LIVEX\*\*/);
    assert.equal(readCurrentRunId(dirL), null, '清 current 且无有活轮 → 指针清空');
    // tsx 空态分支依据：snap.runId === '' 即灰字，不走 readRunSnapshot 的 ok=false 红路。
    // 此处锁数据层语义不变：readRunSnapshot 本身仍按 run 目录判 ok（缺文件 → ok=false）。
    const snap = readRunSnapshot(dirL, 'LIVEX');
    assert.equal(snap.ok, false, '归档后原 run 目录缺文件 → ok=false（红 STALE 语义保留，真断源仍红）');
    assert.equal(readCurrentRunId(dirL), null, '灰态依据是 current 为空，而非 ok=false');
  });
});

describe('无参 /swarm-up 提问式开场卡（零会话零落盘零队列读）', () => {
  let dirU;
  let cmdsU;
  let toolsUMap;
  let promptsU;
  let createCount;
  const BAN_LINE = '本轮无需历史数据，不要调 swarm_read_queue /swarm-status /swarm-drained，直接用 question 工具问完上面三项。';

  const cmdU = async (name, text = '', sessionID = 's1') => {
    await cmdsU.get(name).execute({ sessionID, prompt: { text } });
    return promptsU.at(-1);
  };
  // 快照 .swarm + .trellis 下全部文件相对路径（落盘即多文件，读队列不留痕但分支代码无 loadQueue 调用）
  const snapU = async () => {
    const { readdirSync, statSync } = await import('node:fs');
    const { relative } = await import('node:path');
    const out = [];
    for (const base of ['.swarm', '.trellis']) {
      const root = join(dirU, base);
      if (!existsSync(root)) continue;
      const walk = (d) => {
        for (const n of readdirSync(d)) {
          const p = join(d, n);
          out.push(relative(dirU, p));
          if (statSync(p).isDirectory()) walk(p);
        }
      };
      walk(root);
    }
    return out.sort();
  };

  before(async () => {
    dirU = mkdtempSync(join(tmpdir(), 'swarm-noargup-'));
    writeFileSync(join(dirU, 'ok.mjs'), 'process.exit(0);\n');
    promptsU = [];
    const toolsU = new Map();
    toolsUMap = toolsU;
    cmdsU = new Map();
    createCount = 0;
    const sessionsU = new Map();
    let seq = 900;
    const ctxU = {
      location: { directory: dirU },
      options: { channel: 'swarm-noargup', maxRetries: 3, verifyTimeoutMs: 20_000 },
      model: {
        list: async () => [
          { providerID: 'opencode-go', id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
          { providerID: 'opencode-go', id: 'muse-spark-1.3-contributor', name: 'Muse Spark' },
        ],
      },
      session: {
        prompt: async ({ sessionID, text }) => { promptsU.push(`[${sessionID}] ${text}`); },
        create: async ({ title, agent, model }) => {
          createCount += 1;
          const id = `u-${++seq}`;
          sessionsU.set(id, { id, title, agent, model });
          return { id, title };
        },
        get: async ({ sessionID }) => sessionsU.get(sessionID),
        update: async ({ sessionID, title }) => {
          const s = sessionsU.get(sessionID) ?? { id: sessionID };
          s.title = title;
          sessionsU.set(sessionID, s);
        },
        switchModel: async () => {},
        hook: async () => {},
      },
      command: { transform: async (fn) => fn({ add: (d) => cmdsU.set(d.name, d) }) },
      tool: { transform: async (fn) => fn({ add: (d) => toolsU.set(d.name, d) }) },
    };
    await plugin.setup(ctxU);
  });

  after(() => { rmSync(dirU, { recursive: true, force: true }); });

  test('无参回开场卡：三问+默认值+禁令逐字+下一步，零会话零落盘', async () => {
    const before = await snapU();
    const nBefore = createCount;
    const out = await cmdU('swarm-up', '');
    assert.match(out, /开轮前先问三件事/);
    assert.match(out, /未创建任何会话/);
    assert.match(out, /planner 强推理/);
    assert.match(out, /dev 便宜量大/);
    assert.match(out, /tester 严格/);
    assert.match(out, /\/swarm-models --search/);
    assert.match(out, /需求名/);
    assert.match(out, /prd 路径/);
    assert.match(out, /sessions \| subagents \| hybrid/);
    assert.match(out, /默认 hybrid/);
    assert.match(out, /\/swarm-mode/);
    assert.ok(out.includes(BAN_LINE), '禁令行必须逐字');
    assert.match(out, /#plan 拆解/);
    assert.equal(createCount, nBefore, '零会话创建');
    assert.deepEqual(await snapU(), before, '零落盘：.swarm/.trellis 快照前后一致');
  });

  test('裸 --roles 视同无参：同样回开场卡，不报未知角色', async () => {
    const before = await snapU();
    const out = await cmdU('swarm-up', '--roles');
    assert.match(out, /开轮前先问三件事/);
    assert.ok(out.includes(BAN_LINE), '禁令行必须逐字');
    assert.doesNotMatch(out, /未知角色/);
    assert.deepEqual(await snapU(), before, '零落盘');
  });

  test('单 --name 建空轮：仍回开场卡（三问+需求名回显）+ 空轮落盘可辨非 STALE', async () => {
    const nBefore = createCount;
    const out = await cmdU('swarm-up', '--name 库房列表库存显示优化');
    assert.match(out, /开轮前先问三件事/);
    assert.match(out, /库房列表库存显示优化/);
    assert.match(out, /未创建任何会话/);
    assert.match(out, /空轮已建/);
    assert.match(out, /sidebar\/footer立刻可见/);
    assert.match(out, /零任务态非报错/);
    assert.ok(out.includes(BAN_LINE), '禁令行必须逐字');
    assert.match(out, /planner 强推理/);
    assert.match(out, /\/swarm-models --search/);
    assert.match(out, /#plan 拆解/);
    assert.match(out, /--run 库房列表库存显示优化/);
    assert.doesNotMatch(out, /仅 plan 建会话/);
    assert.equal(createCount, nBefore, '零会话创建');
    // 落盘：queue 空 + round/meta/current（sidebar/footer 可见口径）
    const runId = '库房列表库存显示优化';
    const qFile = join(dirU, '.swarm/runs', runId, 'queue.jsonl');
    const rFile = join(dirU, '.swarm/runs', runId, 'round.json');
    const mFile = join(dirU, '.swarm/runs', runId, 'meta.json');
    assert.ok(existsSync(qFile), '空轮 queue 文件应落盘');
    assert.ok(existsSync(rFile), '空轮 round.json 应落盘');
    assert.ok(existsSync(mFile), '空轮 meta.json 应落盘');
    assert.equal(readFileSync(qFile, 'utf8').trim(), '', '空轮 queue 应为空');
    const round = JSON.parse(readFileSync(rFile, 'utf8'));
    assert.equal(round.name, '库房列表库存显示优化');
    assert.deepEqual(round.sessions ?? {}, {}, '空轮零会话');
    const meta = JSON.parse(readFileSync(mFile, 'utf8'));
    assert.equal(meta.name, '库房列表库存显示优化');
    assert.equal(readFileSync(join(dirU, '.swarm/current'), 'utf8').trim(), runId, 'current 应指向空轮');
    // 零任务态非报错：status/drained 可读，非 STALE
    const st = await cmdU('swarm-status', `--run ${runId}`);
    assert.match(st, /库房列表库存显示优化/);
    assert.doesNotMatch(st, /STALE/);
    const dr = await cmdU('swarm-drained', `--run ${runId}`);
    assert.match(dr, /drained/);
  });

  test('开场卡双路径：确认门问句 + 主会话措辞（无 planner 会话）', async () => {
    const bare = await cmdU('swarm-up', '');
    assert.match(bare, /是否开始 planner？/);
    assert.match(bare, /主会话即 planner/);
    assert.match(bare, /不要自行开始分析需求/);
    assert.doesNotMatch(bare, /然后在 planner 会话里/);
    const named = await cmdU('swarm-up', '--name 确认门卡片');
    assert.match(named, /是否开始 planner？/);
    assert.match(named, /主会话即 planner/);
    assert.match(named, /不要自行开始分析需求/);
    assert.doesNotMatch(named, /然后在 planner 会话里/);
  });

  test('显式 --run 无名建空轮：同回开场卡不派生新轮，落盘可辨非 STALE', async () => {
    const nBefore = createCount;
    const out = await cmdU('swarm-up', '--run 显式空轮B');
    assert.match(out, /开轮前先问三件事/);
    assert.match(out, /空轮已建/);
    assert.match(out, /run=显式空轮B/);
    assert.match(out, /未创建任何会话/);
    assert.ok(out.includes(BAN_LINE), '禁令行必须逐字');
    assert.match(out, /#plan 拆解/);
    assert.doesNotMatch(out, /--name/, '无名空轮下一步不带 --name');
    assert.equal(createCount, nBefore, '零会话创建');
    const qFile = join(dirU, '.swarm/runs', '显式空轮B', 'queue.jsonl');
    assert.ok(existsSync(qFile), '空轮 queue 文件应落盘');
    assert.equal(readFileSync(qFile, 'utf8').trim(), '', '空轮 queue 应为空');
    const round = JSON.parse(readFileSync(join(dirU, '.swarm/runs', '显式空轮B', 'round.json'), 'utf8'));
    assert.deepEqual(round.sessions ?? {}, {}, '空轮零会话');
    assert.ok(existsSync(join(dirU, '.swarm/runs', '显式空轮B', 'meta.json')), '空轮 meta.json 应落盘');
    assert.equal(readFileSync(join(dirU, '.swarm/current'), 'utf8').trim(), '显式空轮B', 'current 应指向空轮');
    const st = await cmdU('swarm-status', '--run 显式空轮B');
    assert.match(st, /显式空轮B/);
    assert.doesNotMatch(st, /STALE/);
  });

  test('显式 --run 指非空旧轮：拒收同文案且队列不截断；--force 放行建卡保留任务', async () => {
    const planOut = (await toolsUMap.get('swarm_plan').execute({ tasks: [
      { id: 'CF-T1', wave: 'CF', title: '冲突任务一', acceptance: '人核', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' },
      { id: 'CF-T2', wave: 'CF', title: '冲突任务二', acceptance: '人核', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' },
    ], run: '冲突旧轮C' })).content;
    assert.match(planOut, /CF-T1: queued/);
    const qFile = join(dirU, '.swarm/runs', '冲突旧轮C', 'queue.jsonl');
    const qLines = () => readFileSync(qFile, 'utf8').split('\n').filter((l) => l.trim());
    assert.equal(qLines().length, 2, '前置：旧轮队列 2 行');
    const nBefore = createCount;
    const rej = await cmdU('swarm-up', '--run 冲突旧轮C');
    assert.match(rej, /拒绝复用非空旧轮/);
    assert.match(rej, /冲突旧轮C/);
    assert.match(rej, /swarm-clean --run 冲突旧轮C/);
    assert.match(rej, /--force/);
    assert.equal(createCount, nBefore, '拒收零会话');
    assert.equal(qLines().length, 2, '拒收不截断旧队列');
    // --force 放行：建卡复用，旧队列原样保留（不谎报空轮）
    const foc = await cmdU('swarm-up', '--run 冲突旧轮C --force');
    assert.match(foc, /开轮前先问三件事/);
    assert.match(foc, /轮已复用（--force）/);
    assert.match(foc, /旧队列原样保留未截断/);
    assert.doesNotMatch(foc, /空轮已建/, '非空轮不谎报空轮');
    assert.equal(createCount, nBefore, '复用卡零会话');
    assert.equal(qLines().length, 2, '--force 不截断旧队列');
    assert.equal(readFileSync(join(dirU, '.swarm/current'), 'utf8').trim(), '冲突旧轮C', 'current 应指向复用轮');
  });

  test('有会话轮无 flag 复用：保留 sessions 不新建，只对齐台账', async () => {
    const nBefore = createCount;
    const mk = await cmdU('swarm-up', '--run 会话轮D');
    assert.match(mk, /空轮已建/);
    // 手工注入一条会话登记，模拟“轮已有会话但队列为空”
    const rFile = join(dirU, '.swarm/runs', '会话轮D', 'round.json');
    const cur = JSON.parse(readFileSync(rFile, 'utf8'));
    writeFileSync(rFile, JSON.stringify({ ...cur, sessions: { plan: 's-keep' } }, null, 2) + '\n');
    const out = await cmdU('swarm-up', '--run 会话轮D --name 新需求名D');
    assert.match(out, /开轮前先问三件事/);
    assert.match(out, /轮已复用/);
    assert.match(out, /已有会话登记原样保留/);
    assert.doesNotMatch(out, /空轮已建/, '有会话轮不谎报空轮');
    assert.equal(createCount, nBefore, '复用卡零会话');
    const after = JSON.parse(readFileSync(rFile, 'utf8'));
    assert.deepEqual(after.sessions, { plan: 's-keep' }, 'sessions 原样保留');
    assert.equal(after.name, '新需求名D', '改名生效');
  });

  test('high-risk 未批直抢：claim 放行但带软提示（指去补批），不静默', async () => {
    const tRun = async (name, input) => (await toolsUMap.get(name).execute(withForce(name, input))).content;
    const p = await tRun('swarm_plan', { tasks: [{ id: 'NC-T1', wave: 'NC', title: '高风险直抢', acceptance: '人工复核通过', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd', risk: 'high', paths: ['src/pay.ts'] }], run: 'NAMECLAIM' });
    assert.match(p, /NC-T1: queued/);
    const c = await tRun('swarm_claim', { task_id: 'NC-T1', run: 'NAMECLAIM' });
    assert.match(c, /已认领 NC-T1/);
    assert.match(c, /swarm_approve|高风险未批|补批/);
  });

  test('裸 --dry-run 保持 dry-run 语义（不触发开场卡）', async () => {
    const out = await cmdU('swarm-up', '--dry-run');
    assert.match(out, /--dry-run/);
    assert.doesNotMatch(out, /开轮前先问三件事/);
  });

  test('未知角色仍报错（老行为零变）', async () => {
    const out = await cmdU('swarm-up', '--roles bogusrole');
    assert.match(out, /未知角色/);
  });

  test('默认 hybrid：有 flag 建 dev（plan=本会话、test 走子代理）', async () => {
    const nBefore = createCount;
    const out = await cmdU('swarm-up', '--name 开场卡回归 --dev-model opencode-go/deepseek-v4.1-flash');
    assert.match(out, /## swarm-up/);
    assert.match(out, /hybrid：plan=本会话 \+ dev/);
    assert.match(out, /跳过（hybrid 模式/);
    assert.match(out, /开场卡回归/);
    assert.match(out, /plan ✓ .*本会话（主会话即 planner/);
    assert.doesNotMatch(out, /开轮前先问三件事/);
    assert.equal(createCount - nBefore, 1, '默认 hybrid：plan 用主会话，只建 dev 一个会话');
  });

  test('显式 --executor subagents 不建会话（plan=主会话，dev/test 走子代理）', async () => {
    const nBefore = createCount;
    const out = await cmdU('swarm-up', '--name 子代理回退 --dev-model opencode-go/deepseek-v4.1-flash --executor subagents');
    assert.match(out, /## swarm-up/);
    assert.match(out, /subagents：plan=本会话/);
    assert.match(out, /跳过（subagent 模式/);
    assert.doesNotMatch(out, /开轮前先问三件事/);
    assert.equal(createCount - nBefore, 0, '显式 subagents：plan 用主会话，dev/test 不建会话');
  });

  test('显式 --executor sessions 照建 dev/test 两个会话（plan=主会话）', async () => {
    const nBefore = createCount;
    const out = await cmdU('swarm-up', '--name 回退通道 --dev-model opencode-go/deepseek-v4.1-flash --executor sessions');
    assert.match(out, /## swarm-up/);
    assert.match(out, /回退通道/);
    assert.doesNotMatch(out, /开轮前先问三件事/);
    assert.doesNotMatch(out, /仅 plan 建会话/);
    assert.equal(createCount - nBefore, 2, '显式 sessions：plan 用主会话，建 dev/test 两个会话');
  });
});

describe('wake 预检 + 投递口径 + 无人接单（PRD 10-30 swarm-wake-verify）', () => {
  let dirW;
  let toolsW;
  let cmdsW;
  let promptsW;
  let promptCallsW;
  let sessionsW;
  let seqW;

  const runW = async (name, input) => (await toolsW.get(name).execute(withForce(name, input))).content;
  const cmdW = async (name, text = '', sessionID = 's1') => {
    await cmdsW.get(name).execute({ sessionID, prompt: { text } });
    return promptsW.at(-1);
  };
  const devSidW = () => {
    try {
      const r = JSON.parse(readFileSync(join(dirW, '.swarm/runs/default/round.json'), 'utf8'));
      return r.sessions?.dev;
    } catch { return undefined; }
  };

  before(async () => {
    dirW = mkdtempSync(join(tmpdir(), 'swarm-wakeverify-'));
    writeFileSync(join(dirW, 'ok.mjs'), 'process.exit(0);\n');
    promptsW = [];
    promptCallsW = [];
    toolsW = new Map();
    cmdsW = new Map();
    sessionsW = new Map();
    seqW = 700;
    const ctxW = {
      location: { directory: dirW },
      options: { channel: 'swarm-wakeverify', maxRetries: 3, verifyTimeoutMs: 20_000 },
      model: {
        list: async () => [
          { providerID: 'opencode-go', id: 'good-model', name: 'Good' },
          { providerID: 'opencode-go', id: 'other-model', name: 'Other' },
        ],
      },
      session: {
        prompt: async ({ sessionID, text }) => { promptCallsW.push({ sessionID, text }); promptsW.push(`[${sessionID}] ${text}`); },
        create: async ({ title, agent, model }) => {
          const id = `w-${++seqW}`;
          sessionsW.set(id, { id, title, agent, model });
          return { id, title };
        },
        get: async ({ sessionID }) => sessionsW.get(sessionID),
        update: async ({ sessionID, title }) => {
          const s = sessionsW.get(sessionID) ?? { id: sessionID };
          s.title = title;
          sessionsW.set(sessionID, s);
        },
        switchModel: async () => {},
        hook: async () => {},
      },
      command: { transform: async (fn) => fn({ add: (d) => cmdsW.set(d.name, d) }) },
      tool: { transform: async (fn) => fn({ add: (d) => toolsW.set(d.name, d) }) },
    };
    await plugin.setup(ctxW);
    const up = await cmdW('swarm-up', '--run default --dev-model opencode-go/good-model --tester-model opencode-go/good-model --name wake演练 --executor sessions');
    assert.match(up, /## swarm-up/);
  });

  after(() => { rmSync(dirW, { recursive: true, force: true }); });

  test('坏模型拒投递：不调 prompt，文案含候选 + search 指引（状态已流转但唤醒未投递，显式 sessions）', async () => {
    const sid = devSidW();
    assert.ok(sid, '前置：dev 会话已登记');
    sessionsW.get(sid).model = { providerID: 'opencode-go', id: 'retired-model' };
    await runW('swarm_plan', {
      tasks: [{ id: 'W-WAKE-BAD', wave: 'W1', title: '坏模型', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false}],
    });
    const before = promptCallsW.filter((c) => c.sessionID === sid).length;
    const out = await cmdW('swarm-start', '--executor sessions');
    assert.match(out, /状态已流转/);
    assert.match(out, /W-WAKE-BAD/);
    assert.match(out, /唤醒未投递/);
    assert.match(out, /模型不可用/);
    assert.match(out, /你是不是想用|没有模型/);
    assert.match(out, /\/swarm-models --search/);
    const after = promptCallsW.filter((c) => c.sessionID === sid).length;
    assert.equal(after, before, '坏模型不得调 session.prompt（零投递）');
    // 状态照常流转（queued→dev_doing），只是唤醒被拦
    const qp = join(dirW, '.swarm/runs/default/queue.jsonl');
    const rows = JSON.parse(`[${readFileSync(qp, 'utf8').split('\n').filter(Boolean).join(',')}]`);
    assert.equal(rows.find((t) => t.id === 'W-WAKE-BAD').status, 'dev_doing');
    // 恢复好模型，供后续用例
    sessionsW.get(sid).model = { providerID: 'opencode-go', id: 'good-model' };
  });

  test('成功路径文案锁：投递口径 + 两段式，无“开始执行”（显式 sessions）', async () => {
    await runW('swarm_plan', {
      tasks: [{ id: 'W-WAKE-OK', wave: 'W1', title: '好模型', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false}],
    });
    // BAD 占着 dev_doing：走完闭环清掉，pass 的自动派发即把 OK 派下去（断言自动派发的回执同样两段式）
    await runW('swarm_done', { task_id: 'W-WAKE-BAD', summary: '坏模型占位清场' });
    const out = await runW('swarm_test', { task_id: 'W-WAKE-BAD', pass: true });
    assert.match(out, /已派发 W-WAKE-OK/);
    assert.match(out, /状态已流转/);
    assert.match(out, /W-WAKE-OK/);
    assert.match(out, /唤醒投递结果/);
    assert.match(out, /指令已投递/);
    assert.match(out, /未验证跑起来/);
    assert.match(out, /去 dev 会话确认/);
    assert.doesNotMatch(out, /开始执行/);
    const src = readFileSync(new URL('../plugins/swarm.js', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /开始执行/, 'swarm.js 成功文案不得再出现“开始执行”（grep 锁）');
  });

  test('陈旧 dev_doing 被 status 点名（超 15 分钟无后续行）', async () => {
    await runW('swarm_plan', {
      tasks: [{ id: 'W-OLD', wave: 'W1', title: '陈旧任务', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false}],
    });
    await runW('swarm_claim', { task_id: 'W-OLD' });
    // 把该任务最后一条 timeline 行 ts 回拨 20 分钟（模拟派了没人动）
    const tlFile = join(dirW, '.swarm/runs/default/timeline.jsonl');
    const lines = readFileSync(tlFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const mine = lines.filter((r) => r.taskId === 'W-OLD');
    assert.ok(mine.length > 0, '前置：W-OLD 应有 timeline 行');
    const last = mine[mine.length - 1];
    assert.equal(last.to, 'dev_doing');
    last.ts = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    writeFileSync(tlFile, `${lines.map((r) => JSON.stringify(r)).join('\n')}\n`);
    const out = await cmdW('swarm-status', '');
    assert.match(out, /疑似无人接单/);
    assert.match(out, /W-OLD/);
    assert.match(out, /已停留/);
    assert.match(out, /\/swarm-retry/);
  });
});

describe('HALT-only 主会话推送（10-30-swarm-halt-push）', () => {
  let dirH;
  let toolsH;
  let cmdsH;
  let promptsH;
  let promptCallsH;
  let sessionsH;
  let seqH;

  const runH = async (name, input) => (await toolsH.get(name).execute(withForce(name, input))).content;
  const cmdH = async (name, text = '', sessionID = 's1') => {
    await cmdsH.get(name).execute({ sessionID, prompt: { text } });
    return promptsH.at(-1);
  };
  const queueRowsH = (run) => JSON.parse(`[${readFileSync(join(dirH, '.swarm', 'runs', run, 'queue.jsonl'), 'utf8').split('\n').filter(Boolean).join(',')}]`);
  const metaH = (run) => JSON.parse(readFileSync(join(dirH, '.swarm', 'runs', run, 'meta.json'), 'utf8'));
  const toReq = (sid) => promptCallsH.filter((c) => c.sessionID === sid);
  const fImpH = (id, over = {}) => ({
    id, severity: 'Important', file: 'src/a.ts', line: 10, rule: 'no-any',
    evidence: '实测 any', suggestion: '改 unknown', status: 'open', ...over,
  });

  before(async () => {
    dirH = mkdtempSync(join(tmpdir(), 'swarm-haltpush-'));
    writeFileSync(join(dirH, 'ok.mjs'), 'process.exit(0);\n');
    promptsH = [];
    promptCallsH = [];
    toolsH = new Map();
    cmdsH = new Map();
    sessionsH = new Map();
    seqH = 300;
    const ctxH = {
      location: { directory: dirH },
      options: { channel: 'swarm-haltpush', maxRetries: 3, verifyTimeoutMs: 20_000 },
      model: { list: async () => [] },
      session: {
        prompt: async ({ sessionID, text }) => { promptCallsH.push({ sessionID, text }); promptsH.push(`[${sessionID}] ${text}`); },
        create: async ({ title, agent, model }) => {
          const id = `h-${++seqH}`;
          sessionsH.set(id, { id, title, agent, model });
          return { id, title };
        },
        get: async ({ sessionID }) => sessionsH.get(sessionID),
        update: async ({ sessionID, title }) => {
          const s = sessionsH.get(sessionID) ?? { id: sessionID };
          s.title = title;
          sessionsH.set(sessionID, s);
        },
        switchModel: async () => {},
        hook: async () => {},
      },
      command: { transform: async (fn) => fn({ add: (d) => cmdsH.set(d.name, d) }) },
      tool: { transform: async (fn) => fn({ add: (d) => toolsH.set(d.name, d) }) },
    };
    // 供静默清字段用例临时劫持 prompt 用
    ctxH.__calls = promptCallsH;
    globalThis.__haltPushCtx = ctxH;
    await plugin.setup(ctxH);
  });

  after(() => { rmSync(dirH, { recursive: true, force: true }); });

  test('start 记录 notify.requester 且覆盖写（up 不记）', async () => {
    await runH('swarm_plan', {
      run: 'HP',
      tasks: [{ id: 'H-S1', wave: 'W1', title: '记录演练', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false}],
    });
    await cmdH('swarm-start', '--run HP', 'req-main');
    assert.equal(metaH('HP').notify.requester, 'req-main');
    await cmdH('swarm-start', '--run HP', 'req-second');
    assert.equal(metaH('HP').notify.requester, 'req-second', '每次 start 覆盖，最新编排者为准');
  });

  test('第 3 次 fail 自动 HALT 推送 1 次且内容对（含恢复指令）', async () => {
    await runH('swarm_plan', {
      run: 'HA',
      tasks: [{ id: 'H-AUTO', wave: 'W7', title: '自动熔断', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false}],
    });
    await cmdH('swarm-start', '--run HA', 'req-auto');
    assert.equal(metaH('HA').notify.requester, 'req-auto');
    // start 已派发到 dev_doing：直接 done 进 test_doing
    await runH('swarm_done', { run: 'HA', task_id: 'H-AUTO', summary: '自动演练' });
    const { transitionTask } = await import('../lib/swarm-store.js');
    const { resolveRun } = await import('../lib/swarm-run.js');
    const qp = join(dirH, '.swarm', 'runs', 'HA', 'queue.jsonl');
    const tp = resolveRun(dirH, { run: 'HA' }).timelinePath;
    const push = () => {
      const a = transitionTask(qp, tp, { taskId: 'H-AUTO', expect: 'dev_doing', patch: { status: 'gate_check' }, by: 'dev', reason: 'setup-push-enter' });
      if (!a.ok) return a;
      return transitionTask(qp, tp, { taskId: 'H-AUTO', expect: 'gate_check', patch: { status: 'test_doing', assignee: 'test' }, by: 'gate', reason: 'setup-push-pass' });
    };
    const base = toReq('req-auto').length;
    await runH('swarm_test', { run: 'HA', task_id: 'H-AUTO', pass: false, failed_ids: 'F1', detail: '第一轮挂 detail-one', disposition: 'fixed' });
    assert.equal(toReq('req-auto').length, base, '未超限不得推送');
    assert.equal(push().ok, true);
    await runH('swarm_test', { run: 'HA', task_id: 'H-AUTO', pass: false, failed_ids: 'F2', detail: '第二轮挂 detail-two', disposition: 'fixed' });
    assert.equal(toReq('req-auto').length, base, '第 2 次仍不推送');
    assert.equal(push().ok, true);
    const last = await runH('swarm_test', { run: 'HA', task_id: 'H-AUTO', pass: false, failed_ids: 'F3', detail: '第三轮挂 detail-three', disposition: 'fixed' });
    assert.match(last, /HALT/);
    assert.equal(queueRowsH('HA').find((t) => t.id === 'H-AUTO').status, 'halted');
    const news = toReq('req-auto').slice(base);
    assert.equal(news.length, 1, '自动 HALT 恰推送 1 次');
    assert.match(news[0].text, /H-AUTO/);
    assert.match(news[0].text, /W7/);
    assert.match(news[0].text, /retries=3/);
    assert.match(news[0].text, /F3/);
    assert.match(news[0].text, /detail-three/);
    assert.match(news[0].text, /\/swarm-retry --task H-AUTO/);
  });

  test('/swarm-halt 人工熔断同样推送', async () => {
    await runH('swarm_plan', {
      run: 'HM',
      tasks: [{ id: 'H-MAN', wave: 'W8', title: '人工熔断', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false}],
    });
    await cmdH('swarm-start', '--run HM', 'req-man');
    const base = toReq('req-man').length;
    const out = await cmdH('swarm-halt', '--task H-MAN --reason 手动演练', 'other-sess');
    assert.match(out, /已熔断/);
    assert.equal(queueRowsH('HM').find((t) => t.id === 'H-MAN').status, 'halted');
    const news = toReq('req-man').slice(base);
    assert.equal(news.length, 1, '人工熔断恰推送 1 次给 requester');
    assert.match(news[0].text, /H-MAN/);
    assert.match(news[0].text, /W8/);
    assert.match(news[0].text, /\/swarm-retry --task H-MAN/);
  });

  test('review 超限 HALT 推送（含 findings 摘要）', async () => {
    await runH('swarm_plan', {
      run: 'HR',
      tasks: [{ id: 'H-REV', wave: 'W9', title: '评审熔断', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd', review: true }],
    });
    await cmdH('swarm-start', '--run HR', 'req-rev');
    await runH('swarm_done', { run: 'HR', task_id: 'H-REV', summary: '第一版' });
    await runH('swarm_test', { run: 'HR', task_id: 'H-REV', pass: true });
    const base = toReq('req-rev').length;
    const rc1 = await runH('swarm_review', { run: 'HR', task_id: 'H-REV', verdict: 'request-changes', findings: [fImpH('FR1')] });
    assert.match(rc1, /评审打回/);
    assert.equal(toReq('req-rev').length, base, '首次打回（回 dev）不推送');
    await runH('swarm_done', { run: 'HR', task_id: 'H-REV', summary: '修一版' });
    await runH('swarm_test', { run: 'HR', task_id: 'H-REV', pass: true });
    const halt = await runH('swarm_review', { run: 'HR', task_id: 'H-REV', verdict: 'request-changes', findings: [fImpH('FR2', { file: 'src/b.ts' })] });
    assert.match(halt, /HALT/);
    assert.equal(queueRowsH('HR').find((t) => t.id === 'H-REV').status, 'halted');
    const news = toReq('req-rev').slice(base);
    assert.equal(news.length, 1, 'review 超限恰推送 1 次');
    assert.match(news[0].text, /H-REV/);
    assert.match(news[0].text, /FR2/);
    assert.match(news[0].text, /\/swarm-retry --task H-REV/);
  });

  test('全绿 pass 推完工汇报 1 次（做了什么+证据+待验收点）', async () => {
    await runH('swarm_plan', {
      run: 'HG',
      tasks: [{ id: 'H-GREEN', wave: 'W1', title: '全绿', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false}],
    });
    await cmdH('swarm-start', '--run HG', 'req-green');
    const base = toReq('req-green').length;
    await runH('swarm_done', { run: 'HG', task_id: 'H-GREEN', summary: '全绿做完' });
    const out = await runH('swarm_test', { run: 'HG', task_id: 'H-GREEN', pass: true });
    assert.match(out, /通过/);
    assert.match(out, /队列已清空/);
    assert.match(out, /完工汇报已推送/);
    assert.equal(queueRowsH('HG').find((t) => t.id === 'H-GREEN').status, 'passed');
    const news = toReq('req-green').slice(base);
    assert.equal(news.length, 1, '全过恰推送 1 次完工汇报');
    assert.match(news[0].text, /完工汇报/);
    assert.match(news[0].text, /H-GREEN/);
    assert.match(news[0].text, /全绿/);
    assert.match(news[0].text, /验收/);
    assert.match(news[0].text, /证据/);
    assert.match(news[0].text, /swarm-status/);
    assert.match(news[0].text, /swarm-revert/);
    assert.match(news[0].text, /HG/);
    assert.equal(metaH('HG').doneNotified, true, '成功即记已推（幂等位）');
  });

  test('只读轮询不重复推送（drained/status 零新增，幂等位已记）', async () => {
    const base = toReq('req-green').length;
    const d = await cmdH('swarm-drained', '--run HG');
    assert.match(d, /✅ drained/);
    await cmdH('swarm-status', '--run HG');
    assert.equal(toReq('req-green').length, base, '只读命令不得再推送（推一次不刷屏）');
    assert.equal(metaH('HG').doneNotified, true, '幂等位保持');
  });

  test('无 requester 零动作（未 start 直接跑完不推送不崩）', async () => {
    await runH('swarm_plan', {
      run: 'HN',
      tasks: [{ id: 'H-NOREQ', wave: 'W1', title: '无主会话', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false}],
    });
    // 故意不 start → meta 无 notify.requester
    await runH('swarm_claim', { run: 'HN', task_id: 'H-NOREQ' });
    await runH('swarm_done', { run: 'HN', task_id: 'H-NOREQ', summary: '无主做完' });
    const nBefore = promptCallsH.length;
    const out = await runH('swarm_test', { run: 'HN', task_id: 'H-NOREQ', pass: true });
    assert.match(out, /通过/);
    assert.match(out, /队列已清空/);
    assert.doesNotMatch(out, /完工汇报已推送/);
    assert.equal(queueRowsH('HN').find((t) => t.id === 'H-NOREQ').status, 'passed');
    assert.equal(promptCallsH.length, nBefore, '无 requester 不得新增任何 prompt');
  });

  test('完工汇报推送失败静默（主迁移不受影响，不记已推）', async () => {
    await runH('swarm_plan', {
      run: 'HF',
      tasks: [{ id: 'H-FAILPUSH', wave: 'W1', title: '推送失败演练', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false}],
    });
    await cmdH('swarm-start', '--run HF', 'req-failpush');
    await runH('swarm_done', { run: 'HF', task_id: 'H-FAILPUSH', summary: '推送失败演练做完' });
    const ctxH = globalThis.__haltPushCtx;
    const realPrompt = ctxH.session.prompt;
    ctxH.session.prompt = async ({ sessionID, text }) => {
      if (sessionID === 'req-failpush') throw new Error('session gone');
      return realPrompt({ sessionID, text });
    };
    try {
      const out = await runH('swarm_test', { run: 'HF', task_id: 'H-FAILPUSH', pass: true });
      assert.match(out, /通过/, '主迁移不受推送失败影响');
      assert.doesNotMatch(out, /完工汇报已推送/);
      assert.equal(queueRowsH('HF').find((t) => t.id === 'H-FAILPUSH').status, 'passed');
      assert.ok(!metaH('HF').doneNotified, '失败不记已推（后续收敛可重试）');
    } finally {
      ctxH.session.prompt = realPrompt;
    }
  });

  test('A 语义锁死：revert 重做后二次收敛不二推（每轮只汇报一次，复查走 status）', async () => {
    await runH('swarm_plan', {
      run: 'HR2',
      tasks: [{ id: 'H-REVERT2', wave: 'W1', title: '二次收敛', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd', review: false }],
    });
    await cmdH('swarm-start', '--run HR2', 'req-revert2');
    await runH('swarm_done', { run: 'HR2', task_id: 'H-REVERT2', summary: '首版' });
    const first = await runH('swarm_test', { run: 'HR2', task_id: 'H-REVERT2', pass: true });
    assert.match(first, /完工汇报已推送/, '首次收敛推一次');
    const base = toReq('req-revert2').length;
    const rv = await runH('swarm_revert', { run: 'HR2', task_id: 'H-REVERT2', reason: '验收不通过重做' });
    assert.match(rv, /dev_doing/);
    await runH('swarm_claim', { run: 'HR2', task_id: 'H-REVERT2' });
    await runH('swarm_done', { run: 'HR2', task_id: 'H-REVERT2', summary: '重做版' });
    const out = await runH('swarm_test', { run: 'HR2', task_id: 'H-REVERT2', pass: true });
    assert.match(out, /通过/);
    assert.match(out, /队列已清空/);
    assert.doesNotMatch(out, /完工汇报已推送/, '二次收敛静默：复查走 status/drained，不二推');
    assert.equal(toReq('req-revert2').length, base, '不得新增推送');
    assert.equal(metaH('HR2').doneNotified, true, '幂等位保持');
  });

  test('halted 残留不推完工汇报（drained 但非全过 → 静默）', async () => {
    await runH('swarm_plan', {
      run: 'HX',
      tasks: [
        { id: 'H-MIX1', wave: 'W1', title: '熔断留痕', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd', review: false },
        { id: 'H-MIX2', wave: 'W1', title: '正常过', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd', review: false },
      ],
    });
    await cmdH('swarm-start', '--run HX', 'req-mix');
    await cmdH('swarm-halt', '--run HX --task H-MIX1 --reason 残留演练', 'other-sess');
    assert.equal(queueRowsH('HX').find((t) => t.id === 'H-MIX1').status, 'halted');
    const base = toReq('req-mix').length;
    await runH('swarm_claim', { run: 'HX', task_id: 'H-MIX2' });
    await runH('swarm_done', { run: 'HX', task_id: 'H-MIX2', summary: '正常做完' });
    const out = await runH('swarm_test', { run: 'HX', task_id: 'H-MIX2', pass: true });
    assert.match(out, /通过/);
    assert.match(out, /队列已清空/, '无 queued 且无进行中 → drained 照报（判活口径）');
    assert.doesNotMatch(out, /完工汇报已推送/, 'halted 残留（非全 passed）不得推完工汇报');
    assert.equal(toReq('req-mix').length, base, 'halted 残留不得新增完工汇报推送');
    assert.ok(!metaH('HX').doneNotified, '非全过不记已推');
  });

  test('review 路径收敛同样推完工汇报（approve→passed→drained）', async () => {
    await runH('swarm_plan', {
      run: 'HV',
      tasks: [{ id: 'H-REVPASS', wave: 'W1', title: '评审过', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd', review: true }],
    });
    await cmdH('swarm-start', '--run HV', 'req-revpass');
    await runH('swarm_done', { run: 'HV', task_id: 'H-REVPASS', summary: '待审版' });
    const base = toReq('req-revpass').length;
    const tp = await runH('swarm_test', { run: 'HV', task_id: 'H-REVPASS', pass: true });
    assert.match(tp, /reviewing待审/);
    assert.equal(toReq('req-revpass').length, base, 'reviewing 待审（未全过）不得提前推');
    const ap = await runH('swarm_review', { run: 'HV', task_id: 'H-REVPASS', verdict: 'approve', findings: [] });
    assert.match(ap, /评审通过/);
    assert.match(ap, /队列已清空/);
    assert.match(ap, /完工汇报已推送/);
    const news = toReq('req-revpass').slice(base);
    assert.equal(news.length, 1, 'review 收敛恰推送 1 次');
    assert.match(news[0].text, /完工汇报/);
    assert.match(news[0].text, /H-REVPASS/);
    assert.match(news[0].text, /证据/);
    assert.equal(metaH('HV').doneNotified, true, 'review 收敛同样记已推');
  });

  test('revert 后重过不重推（每轮只推一次，幂等位保持）', async () => {
    // HG 已全过且已推：revert 把 passed 打回 dev_doing
    const rv = await cmdH('swarm-revert', '--run HG --task H-GREEN', 'other-sess');
    assert.match(rv, /dev_doing/);
    assert.equal(queueRowsH('HG').find((t) => t.id === 'H-GREEN').status, 'dev_doing');
    const base = toReq('req-green').length;
    await runH('swarm_claim', { run: 'HG', task_id: 'H-GREEN' });
    await runH('swarm_done', { run: 'HG', task_id: 'H-GREEN', summary: '重做一版' });
    const out = await runH('swarm_test', { run: 'HG', task_id: 'H-GREEN', pass: true });
    assert.match(out, /通过/);
    assert.match(out, /队列已清空/);
    assert.doesNotMatch(out, /完工汇报已推送/, '已推过不再重推（不刷屏）');
    assert.equal(queueRowsH('HG').find((t) => t.id === 'H-GREEN').status, 'passed');
    assert.equal(toReq('req-green').length, base, 'revert 重过不得再推送');
    assert.equal(metaH('HG').doneNotified, true, '幂等位保持');
  });

  test('推送失败静默：会话不在了清掉字段且主迁移不受影响', async () => {
    await runH('swarm_plan', {
      run: 'HZ',
      tasks: [{ id: 'H-SILENT', wave: 'W1', title: '静默演练', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false}],
    });
    await cmdH('swarm-start', '--run HZ', 'req-gone');
    assert.equal(metaH('HZ').notify.requester, 'req-gone');
    const ctxH = globalThis.__haltPushCtx;
    const realPrompt = ctxH.session.prompt;
    ctxH.session.prompt = async ({ sessionID, text }) => {
      if (sessionID === 'req-gone') throw new Error('session gone');
      return realPrompt({ sessionID, text });
    };
    try {
      const out = await cmdH('swarm-halt', '--task H-SILENT --reason 演练', 'other-sess');
      assert.match(out, /已熔断/, '主迁移不受推送失败影响');
      assert.equal(queueRowsH('HZ').find((t) => t.id === 'H-SILENT').status, 'halted');
      const meta = metaH('HZ');
      assert.equal(meta?.notify?.requester ?? null, null, '失败静默清掉字段');
    } finally {
      ctxH.session.prompt = realPrompt;
    }
  });
});

describe('orchestrate tool 版（halt/revert/config，与命令共用函数）', () => {
  let dirO;
  let toolsO;
  let cmdsO;
  let promptsO;
  let promptCallsO;

  const runO = async (name, input) => (await toolsO.get(name).execute(withForce(name, input))).content;
  const cmdO = async (name, text = '', sessionID = 's1') => {
    await cmdsO.get(name).execute({ sessionID, prompt: { text } });
    return promptsO.at(-1);
  };
  const qFileO = (run) => join(dirO, '.swarm', 'runs', run, 'queue.jsonl');
  const tlFileO = (run) => join(dirO, '.swarm', 'runs', run, 'timeline.jsonl');
  const qRowsO = (run) => JSON.parse(`[${readFileSync(qFileO(run), 'utf8').split('\n').filter(Boolean).join(',')}]`);
  const toReqO = (sid) => promptCallsO.filter((c) => c.sessionID === sid);

  before(async () => {
    dirO = mkdtempSync(join(tmpdir(), 'swarm-orch-'));
    writeFileSync(join(dirO, 'ok.mjs'), 'process.exit(0);\n');
    promptsO = [];
    promptCallsO = [];
    toolsO = new Map();
    cmdsO = new Map();
    const ctxO = {
      location: { directory: dirO },
      options: { channel: 'swarm-orch', maxRetries: 3, verifyTimeoutMs: 20_000 },
      model: { list: async () => [] },
      session: {
        prompt: async ({ sessionID, text }) => { promptCallsO.push({ sessionID, text }); promptsO.push(`[${sessionID}] ${text}`); },
        create: async ({ title }) => ({ id: 'o1', title }),
        get: async () => undefined,
        update: async () => {},
        switchModel: async () => {},
        hook: async () => {},
      },
      command: { transform: async (fn) => fn({ add: (d) => cmdsO.set(d.name, d) }) },
      tool: { transform: async (fn) => fn({ add: (d) => toolsO.set(d.name, d) }) },
    };
    await plugin.setup(ctxO);
  });

  after(() => { rmSync(dirO, { recursive: true, force: true }); });

  test('halt 走 tool：状态 halted + 照推 requester（与命令同文案）', async () => {
    await runO('swarm_plan', {
      run: 'ORCH',
      tasks: [{ id: 'O-H1', wave: 'W1', title: '编排熔断', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false}],
    });
    await cmdO('swarm-start', '--run ORCH', 'req-orch');
    // 先走 gate 进 test_doing（revert 需要 gate_check 历史；halt 接受 test_doing）
    await runO('swarm_done', { run: 'ORCH', task_id: 'O-H1', summary: '编排演练做完' });
    const base = toReqO('req-orch').length;
    const out = await runO('swarm_halt', { task_id: 'O-H1', reason: '编排演练', run: 'ORCH' });
    assert.match(out, /已熔断 O-H1/);
    assert.match(out, /run=ORCH/);
    assert.equal(qRowsO('ORCH').find((t) => t.id === 'O-H1').status, 'halted');
    const news = toReqO('req-orch').slice(base);
    assert.equal(news.length, 1, 'tool 版 halt 同样推送 1 次给 requester');
    assert.match(news[0].text, /O-H1/);
    assert.match(news[0].text, /\/swarm-retry --task O-H1/);
  });

  test('halt tool 对不存在任务：与命令同拒（熔断失败）', async () => {
    const toolOut = await runO('swarm_halt', { task_id: 'O-NOPE', run: 'ORCH' });
    assert.match(toolOut, /熔断失败/);
    const cmdOut = await cmdO('swarm-halt', '--run ORCH --task O-NOPE');
    assert.match(cmdOut, /熔断失败/);
  });

  test('revert 走 tool：halted 回 dev_doing + kind=revert 行照写（与命令同文案）', async () => {
    const out = await runO('swarm_revert', { task_id: 'O-H1', run: 'ORCH' });
    assert.match(out, /dev_doing/);
    assert.match(out, /verdict 已清空/);
    const t = qRowsO('ORCH').find((x) => x.id === 'O-H1');
    assert.equal(t.status, 'dev_doing');
    assert.equal(t.verdict_path, null);
    const rows = readFileSync(tlFileO('ORCH'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(rows.some((r) => r.kind === 'revert' && r.taskId === 'O-H1'), 'timeline 应有 revert 行');
  });

  test('revert tool 拒 queued：与命令同拒（只有 halted/passed 可 revert）', async () => {
    await runO('swarm_plan', {
      run: 'ORCH',
      tasks: [{ id: 'O-Q1', wave: 'W1', title: 'queued 不可 revert', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false}],
    });
    const toolOut = await runO('swarm_revert', { task_id: 'O-Q1', run: 'ORCH' });
    assert.match(toolOut, /只有 halted\/passed 可 revert/);
    const cmdOut = await cmdO('swarm-revert', '--run ORCH --task O-Q1');
    assert.match(cmdOut, /只有 halted\/passed 可 revert/);
  });

  test('config 只读：返回执行器+模型+当前轮；调完队列/timeline 无新增行', async () => {
    const qBefore = readFileSync(qFileO('ORCH'), 'utf8');
    const tlBefore = readFileSync(tlFileO('ORCH'), 'utf8');
    const out = await runO('swarm_config', { run: 'ORCH' });
    const c = JSON.parse(out);
    assert.equal(c.runId, 'ORCH');
    assert.ok(c.executor === 'sessions' || c.executor === 'subagents' || c.executor === 'hybrid');
    assert.equal(typeof c.roleModels, 'object');
    assert.ok(typeof c.currentRun === 'string' && c.currentRun.length > 0);
    assert.equal(readFileSync(qFileO('ORCH'), 'utf8'), qBefore, 'config 不得改队列');
    assert.equal(readFileSync(tlFileO('ORCH'), 'utf8'), tlBefore, 'config 不得写 timeline');
  });
});

describe('secret 门禁（离线四例，真实 git commit + worktree）', () => {
  let dirS;
  let runS;
  let cmdS;
  let promptsS;
  const qFile = () => join(dirS, '.swarm', 'runs', 'default', 'queue.jsonl');
  const tlFile = () => join(dirS, '.swarm', 'runs', 'default', 'timeline.jsonl');
  const qRows = () => JSON.parse(`[${readFileSync(qFile(), 'utf8').split('\n').filter(Boolean).join(',')}]`);
  const tlRows = () => readFileSync(tlFile(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

  before(async () => {
    dirS = mkdtempSync(join(tmpdir(), 'swarm-secret-e2e-'));
    execFileSync('git', ['init', '-q'], { cwd: dirS });
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: dirS });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dirS });
    writeFileSync(join(dirS, 'ok.mjs'), 'process.exit(0);\n');
    execFileSync('git', ['add', '-A'], { cwd: dirS });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dirS });
    promptsS = [];
    const toolsS = new Map();
    const cmdsS = new Map();
    const ctxS = {
      location: { directory: dirS },
      options: { channel: 'swarm-secret-e2e', maxRetries: 3, verifyTimeoutMs: 20_000 },
      model: { list: async () => [] },
      session: {
        prompt: async ({ sessionID, text }) => { promptsS.push(`[${sessionID}] ${text}`); },
        create: async ({ title }) => ({ id: 's1', title }),
        get: async () => undefined,
        update: async () => {},
        switchModel: async () => {},
        hook: async () => {},
      },
      command: { transform: async (fn) => fn({ add: (d) => cmdsS.set(d.name, d) }) },
      tool: { transform: async (fn) => fn({ add: (d) => toolsS.set(d.name, d) }) },
    };
    await plugin.setup(ctxS);
    runS = async (name, input) => (await toolsS.get(name).execute(withForce(name, input))).content;
    cmdS = async (name, text = '', sessionID = 's1') => {
      await cmdsS.get(name).execute({ sessionID, prompt: { text } });
      return promptsS.at(-1);
    };
  });

  after(() => { rmSync(dirS, { recursive: true, force: true }); });

  test('干净过：无 secret 的 done 放行', async () => {
    await runS('swarm_plan', {
      tasks: [{ id: 'S-CLEAN', wave: 'W1', title: '干净任务', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false}],
    });
    await runS('swarm_claim', { task_id: 'S-CLEAN' });
    const out = await runS('swarm_done', { task_id: 'S-CLEAN', summary: '干净做完' });
    assert.match(out, /门禁通过/);
    assert.equal(qRows().find((t) => t.id === 'S-CLEAN').status, 'test_doing');
    await runS('swarm_test', { task_id: 'S-CLEAN', pass: true });
    assert.equal(qRows().find((t) => t.id === 'S-CLEAN').status, 'passed');
  });

  test('命中拦截（含文件+行）：secret commit 被拒并打回 dev_doing', async () => {
    await runS('swarm_plan', {
      tasks: [{ id: 'S-LEAK', wave: 'W1', title: '泄漏任务', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd' , review: false}],
    });
    await runS('swarm_claim', { task_id: 'S-LEAK' });
    writeFileSync(join(dirS, 'leak.ts'), 'const api_key = "supersecret123456";\n');
    execFileSync('git', ['add', '-A'], { cwd: dirS });
    execFileSync('git', ['commit', '-qm', 'leak'], { cwd: dirS });
    const out = await runS('swarm_done', { task_id: 'S-LEAK', summary: '带 secret 提交' });
    assert.match(out, /门禁拒绝/);
    assert.match(out, /gate=secret/);
    assert.match(out, /leak\.ts:\d+/);
    assert.equal(qRows().find((t) => t.id === 'S-LEAK').status, 'dev_doing');
    assert.ok(tlRows().some((r) => r.kind === 'secret-baseline' && r.taskId === 'S-LEAK'), '首次命中必须写 secret-baseline 里程碑行');
    assert.ok(existsSync(join(dirS, '.swarm/secret-baseline.json')), '基线文件必须落盘');
  });

  test('二次被基线抑制：同 commit 重跑放行', async () => {
    const out = await runS('swarm_done', { task_id: 'S-LEAK', summary: '同 commit 重跑' });
    assert.match(out, /门禁通过/);
    assert.equal(qRows().find((t) => t.id === 'S-LEAK').status, 'test_doing');
    await runS('swarm_test', { task_id: 'S-LEAK', pass: true });
    assert.equal(qRows().find((t) => t.id === 'S-LEAK').status, 'passed');
  });

  test('exception 放行：新 secret + policy_exception 照过', async () => {
    await runS('swarm_plan', {
      tasks: [{ id: 'S-EXC', wave: 'W1', title: '例外任务', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd', policy_exception: true , review: false}],
    });
    await runS('swarm_claim', { task_id: 'S-EXC' });
    writeFileSync(join(dirS, 'exc.ts'), 'const token = "exception-secret-99999999";\n');
    execFileSync('git', ['add', '-A'], { cwd: dirS });
    execFileSync('git', ['commit', '-qm', 'exc'], { cwd: dirS });
    const out = await runS('swarm_done', { task_id: 'S-EXC', summary: '例外放行' });
    assert.match(out, /门禁通过/);
    assert.match(out, /gate=secret: exception/);
    assert.equal(qRows().find((t) => t.id === 'S-EXC').status, 'test_doing');
    const pass = await runS('swarm_test', { task_id: 'S-EXC', pass: true });
    assert.match(pass, /通过/);
  });
});

describe('高风险软卡 approve（10-30-swarm-approve-softcard，五例锁死）', () => {
  let dirA;
  let runA;
  let cmdA;
  let promptsA;
  const qFileA = () => join(dirA, '.swarm', 'runs', 'default', 'queue.jsonl');
  const tlFileA = () => join(dirA, '.swarm', 'runs', 'default', 'timeline.jsonl');
  const qRowsA = () => JSON.parse(`[${readFileSync(qFileA(), 'utf8').split('\n').filter(Boolean).join(',')}]`);
  const tlRowsA = () => readFileSync(tlFileA(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

  before(async () => {
    dirA = mkdtempSync(join(tmpdir(), 'swarm-approve-'));
    writeFileSync(join(dirA, 'ok.mjs'), 'process.exit(0);\n');
    promptsA = [];
    const toolsA = new Map();
    const cmdsA = new Map();
    const ctxA = {
      location: { directory: dirA },
      // 注意：故意不传 queue → 按 run 切分，本 describe 全隔离
      options: { channel: 'swarm-approve-e2e', maxRetries: 3, verifyTimeoutMs: 20_000 },
      model: { list: async () => [] },
      session: {
        prompt: async ({ sessionID, text }) => { promptsA.push(`[${sessionID}] ${text}`); },
        create: async ({ title }) => ({ id: 'a1', title }),
        get: async () => undefined,
        update: async () => {},
        switchModel: async () => {},
        hook: async () => {},
      },
      command: { transform: async (fn) => fn({ add: (d) => cmdsA.set(d.name, d) }) },
      tool: { transform: async (fn) => fn({ add: (d) => toolsA.set(d.name, d) }) },
    };
    await plugin.setup(ctxA);
    runA = async (name, input) => (await toolsA.get(name).execute(withForce(name, input))).content;
    cmdA = async (name, text = '', sessionID = 's1') => {
      await cmdsA.get(name).execute({ sessionID, prompt: { text } });
      return promptsA.at(-1);
    };
  });

  after(() => { rmSync(dirA, { recursive: true, force: true }); });

  test('无批阻断：high-risk 无 approve 行派发被拦（文案含 id + /swarm_approve + diff 指引），状态不动', async () => {
    await runA('swarm_plan', {
      tasks: [{ id: 'H-AP1', wave: 'W1', title: '高风险改动', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd', risk: 'high', review: false }],
    });
    const out = await cmdA('swarm-start', '');
    assert.match(out, /无可派发/);
    assert.match(out, /H-AP1/);
    assert.match(out, /swarm_approve/);
    assert.match(out, /\/swarm_approve/);
    assert.match(out, /diff/);
    assert.equal(qRowsA().find((t) => t.id === 'H-AP1').status, 'queued', '阻断不得改状态');
  });

  test('批后放行：approve 写审计行（by+task+risk），start 派发且状态照走', async () => {
    const ap = await runA('swarm_approve', { task_id: 'H-AP1', as: 'approver-1' });
    assert.match(ap, /已批准/);
    assert.match(ap, /H-AP1/);
    const rows = tlRowsA().filter((r) => r.taskId === 'H-AP1' && r.kind === 'approve');
    assert.equal(rows.length, 1, '恰写一行 approve');
    assert.equal(rows[0].by, 'approver-1', 'by 可审计');
    assert.match(rows[0].reason, /high/, 'risk 可审计');
    const out = await cmdA('swarm-start', '');
    assert.match(out, /已派发 H-AP1/);
    assert.equal(qRowsA().find((t) => t.id === 'H-AP1').status, 'dev_doing', '批后派发照常流转');
  });

  test('重复批幂等：第二次返回已批且 timeline 仍一行；rebuild 干跑一致（approve 重放忽略）', async () => {
    const again = await runA('swarm_approve', { task_id: 'H-AP1', as: 'approver-1' });
    assert.match(again, /已批/);
    assert.equal(tlRowsA().filter((r) => r.taskId === 'H-AP1' && r.kind === 'approve').length, 1, '幂等：不重复写行');
    const dry = await cmdA('swarm-rebuild', '');
    assert.match(dry, /一致|0 差异/);
  });

  test('非 high 拒收：medium 任务批不得（明说无需审批），timeline 无 approve 行', async () => {
    await runA('swarm_plan', {
      tasks: [{ id: 'N-AP1', wave: 'W1', title: '普通改动', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd', review: false }],
    });
    const out = await runA('swarm_approve', { task_id: 'N-AP1' });
    assert.match(out, /无需审批/);
    assert.ok(!tlRowsA().some((r) => r.taskId === 'N-AP1' && r.kind === 'approve'), '拒收不得写行');
  });

  test('status 待批行：未批 high-risk 显示 pending-approval，批后消失', async () => {
    await runA('swarm_plan', {
      tasks: [{ id: 'H-AP2', wave: 'W1', title: '待批可见', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd', risk: 'high', review: false }],
    });
    const before = await cmdA('swarm-status', '');
    assert.match(before, /pending-approval/);
    assert.match(before, /H-AP2/);
    await runA('swarm_approve', { task_id: 'H-AP2' });
    const after = await cmdA('swarm-status', '');
    assert.doesNotMatch(after, /pending-approval/);
  });
});

describe('plan 非空轮提示（只提示不拦截，独占 run）', () => {
  let dirP;
  let runP;
  let cmdP;
  let promptsP;
  const qFileP = (run) => join(dirP, '.swarm', 'runs', run, 'queue.jsonl');
  const qRowsP = (run) => JSON.parse(`[${readFileSync(qFileP(run), 'utf8').split('\n').filter(Boolean).join(',')}]`);

  before(async () => {
    dirP = mkdtempSync(join(tmpdir(), 'swarm-planhint-'));
    writeFileSync(join(dirP, 'ok.mjs'), 'process.exit(0);\n');
    promptsP = [];
    const toolsP = new Map();
    const cmdsP = new Map();
    const ctxP = {
      location: { directory: dirP },
      // 注意：故意不传 queue → 按 run 切分，本 describe 全隔离；run id 独占（PNHINT 前缀全局唯一）
      options: { channel: 'swarm-planhint-e2e', maxRetries: 3, verifyTimeoutMs: 20_000 },
      model: { list: async () => [] },
      session: {
        prompt: async ({ sessionID, text }) => { promptsP.push(`[${sessionID}] ${text}`); },
        create: async ({ title }) => ({ id: 'p1', title }),
        get: async () => undefined,
        update: async () => {},
        switchModel: async () => {},
        hook: async () => {},
      },
      command: { transform: async (fn) => fn({ add: (d) => cmdsP.set(d.name, d) }) },
      tool: { transform: async (fn) => fn({ add: (d) => toolsP.set(d.name, d) }) },
    };
    await plugin.setup(ctxP);
    runP = async (name, input) => (await toolsP.get(name).execute(withForce(name, input))).content;
    cmdP = async (name, text = '', sessionID = 's1') => {
      await cmdsP.get(name).execute({ sessionID, prompt: { text } });
      return promptsP.at(-1);
    };
  });

  after(() => { rmSync(dirP, { recursive: true, force: true }); });

  test('空轮入队无提示', async () => {
    const out = await runP('swarm_plan', {
      run: 'PNHINT-E',
      tasks: [{ id: 'PH-E1', wave: 'W1', title: '空轮首单', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd', review: false }],
    });
    assert.match(out, /PH-E1: queued/);
    assert.doesNotMatch(out, /混排/);
    assert.doesNotMatch(out, /已有/);
    assert.equal(qRowsP('PNHINT-E').length, 1);
  });

  test('非空轮入队有提示且照常入队（只提示不拦截）', async () => {
    const first = await runP('swarm_plan', {
      run: 'PNHINT-N',
      tasks: [{ id: 'PH-N1', wave: 'W1', title: '非空轮首单', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd', review: false }],
    });
    assert.match(first, /PH-N1: queued/);
    assert.doesNotMatch(first, /混排/);
    assert.doesNotMatch(first, /已有/);
    const second = await runP('swarm_plan', {
      run: 'PNHINT-N',
      tasks: [{ id: 'PH-N2', wave: 'W1', title: '非空轮次单', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd', review: false }],
    });
    assert.match(second, /PH-N2: queued/);
    assert.match(second, /已有1个任务/);
    assert.match(second, /混排/);
    assert.match(second, /换run/);
    assert.match(second, /clean归档/);
    const rows = qRowsP('PNHINT-N');
    assert.equal(rows.length, 2, '提示不得拦截入队（两单都在）');
    assert.ok(rows.every((t) => t.status === 'queued'));
  });
});

describe('空轮不继承旧会话（W3-T1：空轮零继承 + 禁跨轮唤醒）', () => {
  // 事故复现（10-31）：planner 空轮 plan+name 时，旧全局 .trellis/swarm-state/round.json
  // 里的 stale 会话被当成本轮登记 —— 三个外来会话被改名，wakeRole 把本轮任务投给昨天的会话。
  const STALE = { plan: 'stale-plan', dev: 'stale-dev', test: 'stale-test' };

  /** 独立实例（不靠 describe 级 before：`--test-name-pattern` 过滤下也能单独跑）。 */
  const makeWorld = async () => {
    const d = mkdtempSync(join(tmpdir(), 'swarm-emptyround-'));
    writeFileSync(join(d, 'ok.mjs'), 'process.exit(0);\n');
    const prompts = [];
    const promptCalls = [];
    const sessions = new Map();
    const toolsM = new Map();
    const cmdsM = new Map();
    let seq = 0;
    const ctxM = {
      location: { directory: d },
      options: { channel: 'swarm-emptyround-e2e', maxRetries: 3, verifyTimeoutMs: 20_000 },
      model: { list: async () => [{ providerID: 'opencode-go', id: 'm-ok', name: 'OK' }] },
      session: {
        prompt: async ({ sessionID, text }) => { promptCalls.push({ sessionID, text }); prompts.push(`[${sessionID}] ${text}`); },
        create: async ({ title }) => { const id = `e-${++seq}`; sessions.set(id, { id, title }); return { id, title }; },
        get: async ({ sessionID }) => sessions.get(sessionID),
        update: async ({ sessionID, title }) => {
          const s = sessions.get(sessionID) ?? { id: sessionID };
          s.title = title;
          sessions.set(sessionID, s);
        },
        switchModel: async () => {},
        hook: async () => {},
      },
      command: { transform: async (fn) => fn({ add: (x) => cmdsM.set(x.name, x) }) },
      tool: { transform: async (fn) => fn({ add: (x) => toolsM.set(x.name, x) }) },
    };
    await plugin.setup(ctxM);
    return {
      d, prompts, promptCalls, sessions,
      run: async (name, input) => (await toolsM.get(name).execute(withForce(name, input))).content,
      cmd: async (name, text = '', sessionID = 'caller') => {
        await cmdsM.get(name).execute({ sessionID, prompt: { text } });
        return prompts.at(-1);
      },
      /** 播种事故现场：旧全局台账 + 一个真正持有 stale 会话的旧轮。 */
      seedStale: () => {
        for (const [role, sid] of Object.entries(STALE)) {
          sessions.set(sid, { id: sid, title: `旧会话标题 · ${role}`, model: { providerID: 'opencode-go', id: 'm-ok' } });
        }
        const round = { name: '旧需求名', sessions: { ...STALE }, createdAt: '2026-10-30T00:00:00.000Z' };
        for (const dir of [join(d, '.trellis/swarm-state'), join(d, '.swarm/runs/旧轮0')]) {
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, 'round.json'), `${JSON.stringify(round, null, 2)}\n`);
        }
      },
      titles: () => Object.fromEntries(Object.entries(STALE).map(([role, sid]) => [role, sessions.get(sid)?.title])),
    };
  };

  test('空轮不继承：plan+name 后 sessions 为空、旧全局会话不被改名、wake 未登记跳过', async () => {
    const w = await makeWorld();
    try {
      w.seedStale();
      // ① 事故现场：current 指向一个还没有 round.json 的新轮（/swarm-switch 只写指针+meta）。
      //    旧实现此时会回退读旧全局台账，把 stale 会话当成本轮登记。
      const sw = await w.cmd('swarm-switch', '--run 空轮需求');
      assert.match(sw, /已切换到轮 \*\*空轮需求\*\*/);
      assert.equal(existsSync(join(w.d, '.swarm/runs/空轮需求/round.json')), false, '前置：该轮尚无 round.json');

      // ② 空轮 plan+name：本轮 round.json 的 sessions 必须是空对象（不含任何外来 sessionID）
      const plan = await w.run('swarm_plan', {
        run: '空轮需求',
        name: '空轮新需求名',
        tasks: [{ id: 'ET-T1', wave: 'W1', title: '空轮首单', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd', review: false }],
      });
      assert.match(plan, /ET-T1: queued/);
      assert.match(plan, /本轮命名：\*\*空轮新需求名\*\*/);
      assert.match(plan, /已改名 0 个会话/, '空轮不得改名任何会话（含旧全局台账里的外来会话）');
      const round = JSON.parse(readFileSync(join(w.d, '.swarm/runs/空轮需求/round.json'), 'utf8'));
      assert.deepEqual(round.sessions, {}, '空轮 sessions 必须为空对象，不得继承旧全局台账');
      assert.equal(round.name, '空轮新需求名');
      assert.equal(readFileSync(join(w.d, '.swarm/current'), 'utf8').trim(), '空轮需求', 'current 照常指向本轮');

      // ③ 旧会话标题未被改
      assert.deepEqual(w.titles(), { plan: '旧会话标题 · plan', dev: '旧会话标题 · dev', test: '旧会话标题 · test' });

      // ④ wakeRole：本轮未登记 → 未自动唤醒，且不向任何角色会话投递（只剩 start 自己的回执）
      const before = w.promptCalls.length;
      const start = await w.cmd('swarm-start', '--run 空轮需求 --executor sessions');
      assert.match(start, /已派发 ET-T1/);
      assert.match(start, /未自动唤醒/);
      assert.match(start, /未登记 dev 会话/);
      assert.deepEqual(w.promptCalls.slice(before).filter((c) => c.sessionID !== 'caller'), [], '未登记时不得向任何会话 prompt');
    } finally {
      rmSync(w.d, { recursive: true, force: true });
    }
  });

  test('空轮不继承（禁跨轮唤醒）：本轮台账被塞外来 sid 也不改名、不投递', async () => {
    const w = await makeWorld();
    try {
      w.seedStale();
      // 本轮不起需求名：/swarm-start 的命名步骤（会顺手自愈台账）就不会抢在唤醒闸前面，
      // 这样第 ① 步能真实打到「唤醒时判外来」那条分支。
      await w.cmd('swarm-up', '--run 污染轮P');
      const rFile = join(w.d, '.swarm/runs/污染轮P/round.json');
      // 先落一单（不带 name，不触发命名），再制造污染：
      // 存量形态 = 别的轮的 dev 会话被历史 bug 写进本轮台账
      const first = await w.run('swarm_plan', {
        run: '污染轮P',
        tasks: [{ id: 'ET-T2', wave: 'W1', title: '污染轮首单', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd', review: false }],
      });
      assert.match(first, /ET-T2: queued/);
      const cur = JSON.parse(readFileSync(rFile, 'utf8'));
      writeFileSync(rFile, `${JSON.stringify({ ...cur, sessions: { dev: 'stale-dev' } }, null, 2)}\n`);

      // ① 唤醒闸（污染尚在台账里时）：判外来 → 不改名、不投递，给可执行出路
      const before = w.promptCalls.length;
      const start = await w.cmd('swarm-start', '--run 污染轮P --executor sessions');
      assert.match(start, /已派发 ET-T2/);
      assert.match(start, /未自动唤醒/);
      assert.match(start, /禁跨轮唤醒/);
      assert.match(start, /属 run=旧轮0/);
      assert.deepEqual(w.promptCalls.slice(before).filter((c) => c.sessionID === 'stale-dev'), [], '不得向别的轮的会话投递');

      // ② 命名闸 + 台账自愈（N1）：再命名一次，外来 sid 必须从 round.json「真删键」
      //    （只算 own 不传 replaceSessions 时 writeRound 默认合并，脏 sid 会被 prev 合回来）。
      const plan = await w.run('swarm_plan', {
        run: '污染轮P',
        name: '污染轮再命名',
        tasks: [{ id: 'ET-T3', wave: 'W1', title: '污染轮次单', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd', review: false }],
      });
      assert.match(plan, /ET-T3: queued/);
      assert.match(plan, /已改名 0 个会话/, '外来会话不属于本轮，不得改名');
      assert.equal(w.sessions.get('stale-dev').title, '旧会话标题 · dev', '外来会话标题原样');
      const healed = JSON.parse(readFileSync(rFile, 'utf8'));
      assert.deepEqual(healed.sessions, {}, 'N1：外来 sid 必须从 round.json 真删键（replaceSessions），不得留账');
      assert.equal(healed.name, '污染轮再命名', '改名照常落盘');

      // ③ 自愈之后：本轮真的「未登记」，唤醒按未登记跳过，且不向任何会话投递
      const before2 = w.promptCalls.length;
      const start2 = await w.cmd('swarm-start', '--run 污染轮P --executor sessions');
      assert.match(start2, /已派发 ET-T3/);
      assert.match(start2, /未自动唤醒/);
      assert.match(start2, /未登记 dev 会话/);
      assert.deepEqual(w.promptCalls.slice(before2).filter((c) => c.sessionID !== 'caller'), [], '自愈后不得向任何会话投递');
    } finally {
      rmSync(w.d, { recursive: true, force: true });
    }
  });

  test('空轮不继承（migrate 不搬旧会话）：/swarm-migrate 只搬 name/createdAt，新轮照常零继承', async () => {
    const w = await makeWorld();
    try {
      w.seedStale();
      // 事故第二入口（R1）：/swarm-migrate 一条命令就能把旧全局台账整份搬进新轮，
      // 而旧轮往往已归档（不在 listRuns 扫描范围）→ 归属闸 foreignOwnerOf 拦不住。
      const mig = await w.cmd('swarm-migrate', '--run 迁移轮M');
      assert.match(mig, /swarm-migrate → 迁移轮M/);
      assert.match(mig, /已丢弃 3 个历史会话/, '旧全局台账的会话必须丢弃并报数');
      assert.match(mig, /\/swarm-up/, '提示要给出可执行的出路（重建会话）');
      const round = JSON.parse(readFileSync(join(w.d, '.swarm/runs/迁移轮M/round.json'), 'utf8'));
      assert.deepEqual(round.sessions, {}, '迁移不得把旧全局 sessions 带进新轮');
      assert.equal(round.name, '旧需求名', 'name 照常沿用');
      assert.equal(round.createdAt, '2026-10-30T00:00:00.000Z', 'createdAt 照常沿用');
      // N7：round 落盘走 writeRound 原子接口（tmp+rename），行为特征是它总会补 updatedAt；
      // 直写 writeFileSync 不会写这个字段。只断言接口复用，不制造崩溃。
      assert.equal(typeof round.updatedAt, 'string', 'N7：migrate 的 round 应经 writeRound 落盘（带 updatedAt）');

      // 迁移后的轮再命名：不得改名任何旧会话，台账也不得被写回外来 sid（N1 自愈）
      const plan = await w.run('swarm_plan', {
        run: '迁移轮M',
        name: '迁移轮新名',
        tasks: [{ id: 'ET-T3', wave: 'W1', title: '迁移轮首单', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd', review: false }],
      });
      assert.match(plan, /已改名 0 个会话/);
      assert.deepEqual(w.titles(), { plan: '旧会话标题 · plan', dev: '旧会话标题 · dev', test: '旧会话标题 · test' });
      const round2 = JSON.parse(readFileSync(join(w.d, '.swarm/runs/迁移轮M/round.json'), 'utf8'));
      assert.deepEqual(round2.sessions, {}, '台账自愈：不得写回任何外来 sid');

      // 唤醒：未登记 → 不向任何旧会话投递
      const before = w.promptCalls.length;
      const start = await w.cmd('swarm-start', '--run 迁移轮M --executor sessions');
      assert.match(start, /未自动唤醒/);
      assert.deepEqual(w.promptCalls.slice(before).filter((c) => c.sessionID !== 'caller'), [], '不得向旧会话投递');
    } finally {
      rmSync(w.d, { recursive: true, force: true });
    }
  });

  test('空轮不继承（N6 归属 tie-break）：同 sid 多轮命中时最早登记者为属主', async () => {
    const w = await makeWorld();
    try {
      // 同一 sid 被历史污染同时写进两个轮台账：轮旧（先登记 = 真属主）与轮新（后写进来的副本）。
      const seedRun = (runId, createdAt) => {
        const dir = join(w.d, '.swarm/runs', runId);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'meta.json'), `${JSON.stringify({ name: runId, createdAt }, null, 2)}\n`);
        writeFileSync(join(dir, 'round.json'), `${JSON.stringify({ name: runId, sessions: { dev: 'dup-dev' }, createdAt }, null, 2)}\n`);
      };
      seedRun('轮旧', '2026-10-30T00:00:00.000Z');
      seedRun('轮新', '2026-10-31T00:00:00.000Z');
      w.sessions.set('dup-dev', { id: 'dup-dev', title: 'dup 旧标题', model: { providerID: 'opencode-go', id: 'm-ok' } });

      // ① 属主轮（轮旧，createdAt 更早）：自己的 dev 会话照常改名 —— 不得因为存在「非本轮命中」就被判外来。
      const owner = await w.run('swarm_plan', {
        run: '轮旧',
        name: '属主轮需求',
        tasks: [{ id: 'ET-T4', wave: 'W1', title: '属主轮首单', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd', review: false }],
      });
      assert.match(owner, /已改名 1 个会话/, 'N6：属主轮的会话不得被后写进来的副本挤成外来');
      assert.equal(w.sessions.get('dup-dev').title, '属主轮需求 · dev', '属主轮照常改名');
      assert.deepEqual(JSON.parse(readFileSync(join(w.d, '.swarm/runs/轮旧/round.json'), 'utf8')).sessions, { dev: 'dup-dev' }, '属主轮台账保留自有会话');

      // ② 副本轮（轮新，createdAt 更晚）：仍判外来 → 不改名 + 台账真删键（N1 自愈），属主会话不受影响。
      const dup = await w.run('swarm_plan', {
        run: '轮新',
        name: '污染轮需求',
        tasks: [{ id: 'ET-T5', wave: 'W1', title: '污染轮首单', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd', review: false }],
      });
      assert.match(dup, /已改名 0 个会话/, '后登记的副本轮不得抢属主');
      assert.equal(w.sessions.get('dup-dev').title, '属主轮需求 · dev', '副本轮不得改属主会话的标题');
      assert.deepEqual(JSON.parse(readFileSync(join(w.d, '.swarm/runs/轮新/round.json'), 'utf8')).sessions, {}, 'N1：副本轮台账自愈（真删键）');
    } finally {
      rmSync(w.d, { recursive: true, force: true });
    }
  });
});

describe('npm 包自带技能与 init（skills 随插件注册 + swarm-init 落盘）', () => {
  let dirN;
  let cmdsN;
  let skillsN;
  let promptsN;
  const cmdN = async (name, text = '', sessionID = 's1') => {
    await cmdsN.get(name).execute({ sessionID, prompt: { text } });
    return promptsN.at(-1);
  };

  before(async () => {
    dirN = mkdtempSync(join(tmpdir(), 'swarm-npm-'));
    cmdsN = new Map();
    skillsN = new Map();
    promptsN = [];
    const ctxN = {
      location: { directory: dirN },
      options: { channel: 'swarm-npm', maxRetries: 3, verifyTimeoutMs: 20000 },
      model: { list: async () => [] },
      session: {
        prompt: async ({ sessionID, text }) => { promptsN.push(`[${sessionID}] ${text}`); },
        create: async ({ title }) => ({ id: 'n1', title }),
        get: async () => undefined,
        update: async () => {},
        hook: async () => {},
      },
      command: { transform: async (fn) => fn({ add: (d) => cmdsN.set(d.name, d) }) },
      tool: { transform: async (fn) => fn({ add: () => {} }) },
      skill: {
        transform: async (fn) => fn({
          list: () => [],
          get: () => undefined,
          add: (d) => skillsN.set(typeof d.id === 'string' ? d.id : String(d.id ?? d.name), d),
          update: () => {},
          remove: () => {},
        }),
      },
    };
    await plugin.setup(ctxN);
  });

  after(() => { rmSync(dirN, { recursive: true, force: true }); });

  test('skills 随插件注册：swarm-orchestrate + swarm-quality（id/路径/内容）', () => {
    assert.deepEqual([...skillsN.keys()].sort(), ['swarm-orchestrate', 'swarm-quality']);
    for (const id of ['swarm-orchestrate', 'swarm-quality']) {
      const s = skillsN.get(id);
      assert.ok(s.path.endsWith('SKILL.md'), `${id} path 应指向 SKILL.md`);
      assert.ok(existsSync(s.path), `${id} path 必须在包内真实存在`);
      assert.ok(typeof s.description === 'string' && s.description.length > 10, `${id} 须带 description`);
      assert.ok(typeof s.content === 'string' && s.content.length > 100, `${id} 须带正文 content`);
    }
    assert.ok(skillsN.get('swarm-quality').content.includes('High'), 'quality 正文应含分级语义');
  });

  test('/swarm-init 落盘 agents + review：复制/跳过/--force', async () => {
    const want = [
      '.opencode/agents/swarm-plan.md',
      '.opencode/agents/swarm-dev.md',
      '.opencode/agents/swarm-test.md',
      '.opencode/agents/swarm-reviewer.md',
      '.opencode/review/_default.md',
    ];
    const out1 = await cmdN('swarm-init', '');
    assert.match(out1, /已安装/);
    for (const f of want) assert.ok(existsSync(join(dirN, f)), `${f} 应已落盘`);
    const out2 = await cmdN('swarm-init', '');
    assert.match(out2, /跳过/);
    assert.doesNotMatch(out2, /已安装/, '二次运行不得复写（无 --force 不覆盖）');
    writeFileSync(join(dirN, '.opencode/agents/swarm-plan.md'), 'MARKER');
    const out3 = await cmdN('swarm-init', '--force');
    assert.match(out3, /已安装/);
    assert.doesNotMatch(readFileSync(join(dirN, '.opencode/agents/swarm-plan.md'), 'utf8'), /MARKER/, '--force 应覆盖');
  });

  test('/swarm-init 不写 skills 目录（skills 走 API 注册）', async () => {
    await cmdN('swarm-init', '');
    assert.equal(existsSync(join(dirN, '.opencode/skills')), false, 'skills 不落盘，只走注册');
  });

  test('type 门禁默认显式必填（不指向外部项目）', async () => {
    const { typeGate } = await import('../lib/swarm-gate.js');
    const r = await typeGate({ cwd: dirN });
    assert.equal(r.ok, false);
    assert.match(r.reason, /type_cmd/);
    assert.doesNotMatch(r.reason, /smarterlab/, '默认不得再出现项目专属路径');
  });

  test('tenant 门禁默认指包内包装器（无脚本时给明确指引）', async () => {
    const { tenantGate } = await import('../lib/swarm-gate.js');
    const r = await tenantGate({ cwd: dirN });
    assert.match(r.reason, /gate=tenant/);
    assert.match(r.evidence.stderr, /SWARM_TENANT_CHECK|tenant_cmd/, '无脚本应指引配脚本，而非晦涩报错');
    assert.doesNotMatch(r.evidence.stderr ?? '', /smarterlab-backend.*ENOENT/i, '不得是裸路径缺失错');
  });
});

describe('P0/P1 编排闸门（并行两轮隔离 / start 授权 / 空入队不改名）', () => {
  let d;
  let t;
  let c;
  let sess;
  let prompts;
  let seq;

  const up = (sid, text) => c.get('swarm-up').execute({ sessionID: sid, prompt: { text } });
  const tool = async (sid, name, input) => (await t.get(name).execute(input, { sessionID: sid })).content;
  const cmdN = async (sid, name, text = '') => {
    await c.get(name).execute({ sessionID: sid, prompt: { text } });
    return prompts.at(-1)?.text;
  };
  const readRoundOf = (runId) => JSON.parse(readFileSync(join(d, '.swarm', 'runs', runId, 'round.json'), 'utf8'));
  const readQueueOf = (runId) => {
    try {
      return readFileSync(join(d, '.swarm', 'runs', runId, 'queue.jsonl'), 'utf8')
        .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  const tA = { id: 'A-1', wave: 'W1', title: 'A 任务一', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd', review: false };
  const tA2 = { id: 'A-2', wave: 'W1', title: 'A 任务二', acceptance: 'ok', verify_cmd: 'node ok.mjs', testing: '同 verify_cmd', review: false };

  before(async () => {
    d = mkdtempSync(join(tmpdir(), 'swarm-gate-'));
    writeFileSync(join(d, 'ok.mjs'), 'process.exit(0);\n');
    prompts = [];
    sess = new Map();
    seq = 0;
    t = new Map();
    c = new Map();
    const ctx = {
      location: { directory: d },
      options: { channel: 'swarm-gate-none', maxRetries: 3, verifyTimeoutMs: 10_000 },
      model: { list: async () => [] },
      session: {
        prompt: async ({ sessionID, text }) => { prompts.push({ sessionID, text }); },
        create: async ({ title, agent, model }) => {
          const id = `g-${++seq}`;
          sess.set(id, { id, title, agent, model });
          return { id, title };
        },
        get: async ({ sessionID }) => sess.get(sessionID),
        update: async ({ sessionID, title }) => {
          const s = sess.get(sessionID) ?? { id: sessionID };
          s.title = title;
          sess.set(sessionID, s);
        },
        switchModel: async () => {},
        hook: async () => {},
      },
      command: { transform: async (fn) => fn({ add: (x) => c.set(x.name, x) }) },
      tool: { transform: async (fn) => fn({ add: (x) => t.set(x.name, x) }) },
    };
    await plugin.setup(ctx);
  });

  after(() => { rmSync(d, { recursive: true, force: true }); });

  test('并行两轮：B 会话入队/读队列都落 B，不被全局 current=A 串走', async () => {
    await up('hostA', '--executor sessions --name 需求A');
    await up('hostB', '--executor sessions --name 需求B'); // current 指向 B
    await cmdN('hostA', 'swarm-switch', '--run 需求A'); // 故意把 current 抢回 A（模拟并行两轮）
    const planB = await tool('hostB', 'swarm_plan', { name: '需求B', tasks: [tA] });
    assert.match(planB, /A-1: queued/);
    assert.equal(readQueueOf('需求B').length, 1, 'B 会话的任务必须落 B');
    assert.equal(readQueueOf('需求A').length, 0, 'A 轮不得被 B 的入队污染');
    const qa = await tool('hostA', 'swarm_read_queue', {});
    const qb = await tool('hostB', 'swarm_read_queue', {});
    assert.doesNotMatch(qa, /A-1/, 'A 会话读 A（空队列）');
    assert.match(qb, /A-1/, 'B 会话读 B（有任务）');
  });

  test('会话绑定登记进 round.members（footer/sidebar 跟随的数据源）', async () => {
    const r = readRoundOf('需求A');
    assert.ok(r.members?.['hostA'], '主会话应登记进 members');
    assert.equal(r.sessions.plan, 'hostA', '默认主会话即 planner');
  });

  test('start 闸门：up 后认领被拒，/swarm-start 后才放行', async () => {
    const rejected = await tool('hostB', 'swarm_claim', { task_id: 'A-1' });
    assert.match(rejected, /已 plan 未派发/);
    assert.match(rejected, /swarm-start/);
    assert.equal(readQueueOf('需求B')[0].status, 'queued', '闸门拒绝不得改状态');

    const started = await cmdN('hostB', 'swarm-start');
    assert.match(started, /已派发 A-1/);
    const meta = JSON.parse(readFileSync(join(d, '.swarm/runs/需求B/meta.json'), 'utf8'));
    assert.ok(meta.startedAt, 'start 后写 startedAt');
    assert.equal(meta.pendingStart, false);

    // 第一个任务已由 start 派给 dev（可继续），再入队一个任务验证 start 后 claim 放行
    await tool('hostB', 'swarm_plan', { tasks: [tA2] });
    const ok = await tool('hostB', 'swarm_claim', { task_id: 'A-2' });
    assert.match(ok, /已认领 A-2/);
  });

  test('空入队（全部被校验拒）不得改轮名', async () => {
    const before = readRoundOf('需求B').name;
    const out = await tool('hostB', 'swarm_plan', { name: '不该生效的名字', tasks: [{ id: 'BAD', wave: 'W1', title: '缺验收' }] });
    assert.match(out, /BAD: missing\/invalid field/);
    assert.match(out, /未改名/);
    assert.equal(readRoundOf('需求B').name, before, 'round.name 必须原样');
    assert.equal(JSON.parse(readFileSync(join(d, '.swarm/runs/需求B/meta.json'), 'utf8')).name, before, 'meta.name 同步不动');
  });

  test('同一主会话开新轮：host 从旧轮摘走，归属新轮', async () => {
    await up('hostB', '--executor sessions --name 需求C');
    assert.ok(!readRoundOf('需求B').members?.['hostB'], '旧轮 members 不得留 hostB');
    assert.ok(!Object.values(readRoundOf('需求B').sessions).includes('hostB'), '旧轮 sessions 不得留 hostB');
    assert.equal(readRoundOf('需求C').sessions.plan, 'hostB', '新轮 hostB 即 planner');
  });
});

describe('确认门文案同步（卡片/swarm.js源码/skill/手册四处同词）', () => {
  const skill = readFileSync(new URL('../skills/swarm-orchestrate/SKILL.md', import.meta.url), 'utf8');
  const manual = readFileSync(new URL('../docs/swarm-使用手册.md', import.meta.url), 'utf8');
  const core = readFileSync(new URL('../plugins/swarm.js', import.meta.url), 'utf8');
  const G1 = '是否开始 planner？';
  const G2 = '是否 /swarm-start 派发？';

  test('skill 含两道门问句原文', () => {
    assert.ok(skill.includes(G1), 'skill 须含门一问句');
    assert.ok(skill.includes(G2), 'skill 须含门二问句');
    assert.ok(skill.includes('不要自行开始分析需求'), 'skill 须禁自行分析');
  });

  test('skill 已删旧口径（小活直接派/主会话代跑）', () => {
    assert.doesNotMatch(skill, /≤3 且无 high-risk 可直接派/);
    assert.doesNotMatch(skill, /或主会话代跑/);
  });

  test('手册含两道门问句原文', () => {
    assert.ok(manual.includes(G1), '手册须含门一问句');
    assert.ok(manual.includes(G2), '手册须含门二问句');
  });

  test('手册已删旧口径', () => {
    assert.doesNotMatch(manual, /≤3 且无 high-risk 可直接派/);
  });

  test('swarm.js 卡片无 planner 会话旧措辞', () => {
    assert.doesNotMatch(core, /然后在 planner 会话里/);
  });
});

describe('agent 前台不抢项目 shell 策略（bash 交给 opencode.json 统一管）', () => {
  const files = [
    'agents/swarm-plan.md',
    'agents/swarm-dev.md',
    'agents/swarm-test.md',
    'agents/swarm-reviewer.md',
  ];
  for (const f of files) {
    test(`${f} 不得含 bash/shell 规则（否则 agent 层覆盖项目白名单）`, () => {
      const text = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
      const fm = text.match(/^---\s*\n([\s\S]*?)\n---/);
      assert.ok(fm, `${f} 须有 frontmatter`);
      assert.doesNotMatch(fm[1], /^\s*bash\s*:/m, `${f} 不得有 bash 键（shell 一律走项目 permissions[]）`);
      assert.doesNotMatch(fm[1], /action:\s*["']?shell\b/, `${f} 不得有 v2 shell 规则`);
    });
  }
});
