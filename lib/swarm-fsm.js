/**
 * swarm-fsm — 状态机唯一真相（纯函数，无 IO，可单测）。
 *
 * 队列只是快照，合法迁移由下表唯一决定：
 *
 *   queued     → dev_doing                    (claim/dispatch)
 *   dev_doing  → gate_check                   (done 步骤1，进门禁)
 *   gate_check → test_doing                   (门禁 ok)
 *   gate_check → dev_doing                    (门禁拒绝，打回，不计 retries)
 *   test_doing → passed                       (test pass)
 *   test_doing → reviewing                    (test pass 且 task.review=true，评审待审)
 *   reviewing  → passed                       (review approve)
 *   reviewing  → dev_doing                    (review request-changes，reviewRounds+1)
 *   reviewing  → halted                       (review request-changes 且 reviewRounds>=2，或人工 halt)
 *   test_doing → dev_doing                    (test fail，retries+1)
 *   test_doing → halted                       (test fail 且超限)
 *   halted     → dev_doing                    (retry，retries=0)
 *   passed     → dev_doing                    (R4 revert：回到门禁前重做)
 *   queued/dev_doing/gate_check/test_doing/reviewing/passed → halted (人工 halt)
 *
 * 调用方仍按原样传 expect（期望当前状态），本层多做一层表校验：
 * 即使 expect 命中当前状态，只要 (cur → patch.status) 不在表中就拒绝，
 * 并在 reason 里给出 `allowed:` 人话列表（评审门要求）。
 */
export const STATUSES = ['queued', 'dev_doing', 'gate_check', 'test_doing', 'reviewing', 'passed', 'halted'];

export const TRANSITIONS = {
  queued: ['dev_doing', 'halted'],
  dev_doing: ['gate_check', 'halted'],
  gate_check: ['test_doing', 'dev_doing', 'halted'],
  test_doing: ['passed', 'dev_doing', 'halted', 'reviewing'],
  reviewing: ['passed', 'dev_doing', 'halted'],
  passed: ['halted', 'dev_doing'],
  halted: ['dev_doing'],
};

/** 某状态允许去哪；未知状态返回空数组（永不抛错）。 */
export function allowedFrom(from) {
  const v = TRANSITIONS[String(from ?? '')];
  return v ? [...v] : [];
}

/** 单边是否合法。 */
export function can(from, to) {
  return allowedFrom(from).includes(String(to));
}

/**
 * 完整校验：expect 命中 + 表中有边。
 * - patch 无 status 或 to === cur（同态重进）→ 只做 expect 检查，不建边。
 * - 失败一律在 reason 里带 `allowed: <a/b/c>`（非法迁移评审门）。
 */
export function checkTransition(curStatus, expectArg, toStatus, taskId = '?') {
  const cur = String(curStatus ?? '');
  const expects = Array.isArray(expectArg) ? expectArg.map(String) : [String(expectArg)];
  if (!expects.includes(cur)) {
    return {
      ok: false,
      reason: `cannot transition: ${taskId} is ${cur}, expect ${expects.join('/')}; allowed: ${allowedFrom(cur).join('/') || '(none)'}`,
    };
  }
  if (toStatus === undefined || toStatus === null || String(toStatus) === cur) return { ok: true };
  if (!can(cur, toStatus)) {
    return {
      ok: false,
      reason: `illegal transition: ${taskId} ${cur}→${toStatus} not allowed; allowed: ${allowedFrom(cur).join('/') || '(none)'}`,
    };
  }
  return { ok: true };
}
