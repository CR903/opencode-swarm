/**
 * swarm-events — 异步事件通道（FileBus 为事实源）。
 *
 * 历史：曾直调 `trellis channel send/messages/wait` 二进制；现已切换为
 * 自研文件通道 `swarm-filebus.js`（零外部依赖），本模块仅保留薄适配，
 * 保证旧 `import { createChannel, eventId } from './swarm-events.js'` 不坏。
 */
import { createHash } from 'node:crypto';

import { createFileBus } from './swarm-filebus.js';

/** 确定性事件 ID：同 (task, status, commit) 只会产生一条事件（旧公式，原样保留）。 */
export function eventId(taskId, status, commit) {
  return createHash('sha256')
    .update(`${taskId}\0${status}\0${commit ?? '-'}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * 旧入口：内部委托 FileBus。`channel` 映射为 eid 命名空间（runId），
 * `stateDir` 即运行目录（events.jsonl 落此）。返回同形
 * `{send, flushOutbox, tail, wait, eventId}`。
 */
export function createChannel({ stateDir, channel, logger = () => {} } = {}) {
  const bus = createFileBus({ stateDir, runId: channel ?? 'default', logger });
  return { ...bus, eventId };
}
