/**
 * swarm-roles — 角色注册表 + tag 别名。
 *
 * 设计要点（可扩展，N 角色）：
 * - 角色不是写死的 if/else，而是一张表：新增 reviewer/qa 只加一行。
 * - 每个角色带 tag 别名（#dev / #test / #plan），用户只需敲 tag。
 * - 每个角色带 agent 文件 id + 默认模型 key，编排器 spawn 时直接用。
 * - 每个角色带精简的「行为契约」，由 prompt hook 注入，用户不必写长提示词。
 */

export const ROLES = {
  plan: {
    tag: ['plan', 'planner', '#plan'],
    agent: 'swarm-plan',
    modelKey: 'planner',
    canEdit: false,
    tools: ['swarm_plan', 'swarm_read_queue'],
    needsHuman: false,
    contract: [
      '你是 planner：只拆任务、不写实现代码。',
      '把需求拆成「单任务」——一行一任务，wave 只做分组标签。',
      '每个任务必须能独立验收：acceptance 一句话说清「怎样算过」，verify_cmd 是可直接执行的命令（白名单：node/npm/pnpm/go/git/pytest 等，禁 shell 拼接）。',
      '每个任务必须带 stack（三选一必填：backend=后端Go/Gin/GORM、frontend=前端Angular/UniApp、integration=前后端联调；缺 stack 入队会被拒收）。全栈需求按这三类拆，不许一个任务横跨两端。',
      '先把需求落成 PRD 文件，再拆任务；入队时 pin prd 路径（swarm_plan 的 prd 参数）+ name（一句话需求名）。',
      '用 swarm_plan 逐个入队；入队前先 swarm_read_queue 查重。入队时给 name 传本轮需求的一句话名（用于给会话命名）。',
      '派发由人执行 /swarm-start（它不是工具，你也调不到），不要假装调用了它。模型不用你定：start 时人按实际 stack 按需分配（backend→dev_backend、frontend→dev_frontend，另需 test，有评审再加 reviewer），缺啥门禁硬拦。',
    ].join('\n'),
  },
  dev: {
    tag: ['dev', 'developer', '#dev'],
    agent: 'swarm-dev',
    modelKey: 'dev',
    canEdit: true,
    tools: ['swarm_claim', 'swarm_next', 'swarm_done'],
    needsHuman: false,
    contract: [
      '你是 dev：只做被指派的那一个任务。',
      '先读队列：任务已是 dev_doing 且归你时跳过 claim 直接开工（属编排预派发），否则 swarm_claim 认领；再读任务里的 acceptance 与 verify_cmd，按它实现。',
      '实现完自己跑一遍 verify_cmd，绿了才 swarm_done（门禁会重跑一次，不过会被拒发）。',
      '收到 [TEST-FAIL] 就按 failed_ids/detail 逐条修，不要扩大范围、不要动 tools/review/**。',
      '绝不自己判定通过——判定权在 test。',
      'subagent 模式（被子代理派发）下：做完调 swarm_claim/swarm_done 即结束，不要等后续指令。',
    ].join('\n'),
  },
  test: {
    tag: ['test', 'tester', 'qa', '#test', '#qa'],
    agent: 'swarm-test',
    modelKey: 'tester',
    canEdit: false,
    tools: ['swarm_test', 'swarm_read_queue', 'swarm_next'],
    needsHuman: false,
    contract: [
      '你是 test：独立验证，不看 dev 的结论。',
      '对 status=test_doing 的任务，自己跑 verify_cmd；有 verdict 就核对 reviewedCommit==HEAD。',
      '过 → swarm_test pass=true；不过 → swarm_test pass=false，failed_ids 写具体项，detail 写实测差异。',
      '同一任务第 3 次 fail 会自动 HALT，不要绕过门禁放行。',
      '不要改代码；发现问题只上报。',
      'subagent 模式（被子代理派发）下：调 swarm_test 出结论即结束，不要等后续指令。',
    ].join('\n'),
  },
  reviewer: {
    tag: ['reviewer', '#reviewer'],
    agent: null, // 占位：reviewer 是 subagent 专属（见 agents/swarm-reviewer.md），不经会话/up，插件会给人话拒绝
    modelKey: 'reviewer',
    canEdit: false,
    tools: [],
    needsHuman: true,
    contract: [
      '你是 reviewer：只做语义复核，不改码。',
      'subagent 专属：由编排会话派发（agent=swarm-reviewer），调 swarm_review 出结论；不经 /swarm-up 建会话。',
    ].join('\n'),
  },
};

/** 按当前注册表重建别名索引（registerRole 后自动重建）。 */
export let TAG_INDEX = new Map();

export function rebuildTagIndex() {
  const m = new Map();
  for (const [role, def] of Object.entries(ROLES)) {
    for (const t of def.tag ?? []) m.set(String(t).replace(/^#/, '').toLowerCase(), role);
  }
  TAG_INDEX = m;
  return TAG_INDEX;
}

rebuildTagIndex();

/** 新增角色只加一行：`registerRole('security', {...})`（自动重建索引，无分支改动）。 */
export function registerRole(id, def) {
  ROLES[id] = def;
  rebuildTagIndex();
  return ROLES[id];
}

export function hasRole(id) {
  return Object.prototype.hasOwnProperty.call(ROLES, id);
}

/**
 * 解析用户输入里的 tag：必须 `#` 前缀（`#dev W3-T1 顺手修下空指针`）。
 * 裸词（`dev W3-T1`）不再命中——此前 `#?` 让正文首词 dev/test 误触发 prompt 改写。
 * @returns {{role:string, taskId?:string, rest:string, raw:string} | null}
 */
export function parseTag(text) {
  const m = String(text ?? '').match(/^\s*#([a-zA-Z][\w-]*)\b\s*([\s\S]*)$/);
  if (!m) return null;
  const role = TAG_INDEX.get(m[1].toLowerCase());
  if (!role) return null;
  const rest = m[2].trim();
  const taskMatch = rest.match(/^([A-Za-z][\w.-]*-\w+)\b\s*([\s\S]*)$/);
  return { role, taskId: taskMatch?.[1], rest: taskMatch ? taskMatch[2].trim() : rest, raw: text };
}

/** 任务块渲染（全量/增量唤醒共用：字段逐字一致，防漂移）。 */
export function renderTaskBlock(task) {
  return [
    `## 任务 ${task.id}（wave=${task.wave}，status=${task.status}）`,
    `- 标题：${task.title}`,
    `- 验收：${task.acceptance}`,
    `- 验证命令：\`${task.verify_cmd}\``,
    task.retries ? `- 已失败 ${task.retries} 次，重点看上次失败项` : '',
    task.risk ? `- 风险：${task.risk}${task.risk === 'high' ? '（高风险，建议两人复核）' : ''}` : '',
    Array.isArray(task.paths) && task.paths.length ? `- 涉及路径：${task.paths.join(', ')}` : '',
  ];
}

/** 把 tag 展开成完整指令（替代用户手写长提示词）。 */
export function expandTag({ role, taskId, rest }, task) {
  const def = ROLES[role];
  if (!def) return null;
  const lines = [`## 角色：${role}`, def.contract];
  if (task) {
    lines.push('', ...renderTaskBlock(task));
  } else if (taskId) {
    lines.push('', `## 任务 ${taskId} 未在队列中找到——先 swarm_read_queue 确认 ID。`);
  }
  if (rest) lines.push('', '## 补充要求', rest);
  return lines.filter(Boolean).join('\n');
}

/**
 * 增量唤醒体（1.6.0 token-economy）：同轮同会话的第 2+ 次唤醒用。
 * 任务块与 expandTag 逐字一致（经 renderTaskBlock 同源），契约压成一行引用。
 * 质量无损的前提：完整契约在首条唤醒历史 + 会话 instructions 里各有一份。
 */
export function expandTagCompact({ role, taskId, rest }, task) {
  const def = ROLES[role];
  if (!def) return null;
  const lines = [`## 角色：${role}`, `你是 ${role}：按本会话已注入的 ${role} 契约执行（完整版见本轮首条唤醒，不重复贴）。`];
  if (task) {
    lines.push('', ...renderTaskBlock(task));
  } else if (taskId) {
    lines.push('', `## 任务 ${taskId} 未在队列中找到——先 swarm_read_queue 确认 ID。`);
  }
  if (rest) lines.push('', '## 补充要求', rest);
  return lines.filter(Boolean).join('\n');
}
