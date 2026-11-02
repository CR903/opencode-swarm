/**
 * swarm-filebus — 自研文件事件通道（零外部二进制依赖）。
 *
 * 替代 `swarm-events.js` 里对 `trellis channel send/messages/wait` 的调用：
 * 事件直接 append 到本地 JSONL，读走末 N 行，等待用 mtime 轮询。
 *
 * 存储：
 *   <stateDir>/events.jsonl   # {seq,eid,ts,by,text,taskId,status,commit} append-only
 *
 * 并发与幂等：
 * - `send` 全程走 `swarm-store.withLock`（锁内读尾 seq → +1 → append → fsync），
 *   同进程/多进程并发 send 的 seq 永不重号。
 * - `eid = sha256(runId\\0task\\0status\\0commit)[0:16]`，写前扫末 2000 行索引，
 *   命中直接返回 `{duplicate:true}`（崩溃重试不产生重复事件）。
 *
 * 兼容：
 * - 接口与旧 `createChannel` 同形（`send/tail/flushOutbox/wait`），调用点一行替换。
 * - `tail` 先读新位，空/缺时回退 `legacyDir/events.jsonl`。
 * - `send` 永不抛错：内部异常收敛为 `{sent:false, reason}`。
 * - 坏行跳过计数，不抛错（`tail` 正常返回好行）。
 */
import { createHash } from 'node:crypto';
import {
  readFileSync, appendFileSync, existsSync, mkdirSync,
  openSync, closeSync, fsyncSync, statSync,
} from 'node:fs';
import { resolve, join } from 'node:path';

import { withLock } from './swarm-store.js';

/** 确定性事件 ID：同 (runId, task, status, commit) 只产生一条事件。
 * B1：TEST-FAIL / GATE-REJECT 另纳 failed+detail(截断后) 摘要，
 * TASK-ASSIGN 另纳 retry/wave 摘要（extra 为空时与旧公式逐字节一致）。 */
export function eventId(taskId, status, commit, runId = '-', extra = '') {
  const base = `${runId ?? '-'}\0${taskId ?? '-'}\0${status ?? '-'}\0${commit ?? '-'}`;
  return createHash('sha256')
    .update(extra ? `${base}\0${extra}` : base)
    .digest('hex')
    .slice(0, 16);
}

/** kv 摘要（与事件 text 里落盘的截断保持一致，超长先截断再 hash）。 */
export function kvDigest(status, kv = {}) {
  const k = kv ?? {};
  if (status === 'TEST-FAIL' || status === 'GATE-REJECT') {
    const failed = String(k.failed ?? '-');
    const detail = String(k.detail ?? k.reason ?? '-').slice(0, 500);
    return `${failed}\0${detail}`;
  }
  if (status === 'TASK-ASSIGN') {
    return `${String(k.retry ?? '-')}\0${String(k.wave ?? '-')}`;
  }
  return '';
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 文件指纹（mtime 轮询用）：缺文件返回常量，存在返回 mtime+size。 */
function fileKey(path) {
  try {
    const s = statSync(path);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return 'missing';
  }
}

/**
 * 读好行：坏行跳过计数，不抛错。
 * @returns {{rows: object[], bad: number}}
 */
function readGoodRows(path, fromLegacy = false) {
  try {
    if (!existsSync(path)) return { rows: [], bad: 0, fromLegacy };
    const text = readFileSync(path, 'utf8');
    const rows = [];
    let bad = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        bad += 1;
      }
    }
    return { rows, bad, fromLegacy };
  } catch {
    return { rows: [], bad: 0, fromLegacy };
  }
}

function parseTimeout(v, fallbackMs) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, v);
  const m = String(v ?? '').trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
  if (!m) return fallbackMs;
  const n = Number(m[1]);
  const unit = (m[2] ?? 's').toLowerCase();
  const mult = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60000 : 3600000;
  return n * mult;
}

export function createFileBus({ stateDir, runId = 'default', legacyDir = null, logger = () => {} } = {}) {
  const dir = resolve(stateDir);
  mkdirSync(dir, { recursive: true });
  const eventsFile = join(dir, 'events.jsonl');
  const legacyFile = legacyDir ? join(resolve(legacyDir), 'events.jsonl') : null;

  /**
   * 发一条事件。本地原子写永不失败，幂等去重。
   * @returns {Promise<{sent:boolean, duplicate?:boolean, eid:string, seq?:number, reason?:string}>}
   */
  async function send({ as, prefix, kv = {}, body = '', taskId, status, commit } = {}) {
    try {
      const task = taskId ?? kv.task ?? '-';
      const st = status ?? String(prefix ?? '').replace(/[[\]]/g, '');
      const cm = commit ?? kv.commit ?? '-';
      const eid = eventId(task, st, cm, runId, kvDigest(st, kv));
      const text = `${prefix} ` +
        Object.entries({ ...kv, eid }).map(([k, v]) => `${k}=${v}`).join(' ') +
        (body ? `\n${body}` : '');

      return withLock(eventsFile, () => {
        // 锁内扫 eid 索引（末 2000 行）+ 取尾 seq，全同步无 await，不会被交错。
        let maxSeq = 0;
        let dup = false;
        if (existsSync(eventsFile)) {
          const lines = readFileSync(eventsFile, 'utf8').split('\n').filter((l) => l.trim());
          const scan = lines.slice(-2000);
          for (const line of scan) {
            let row = null;
            try {
              row = JSON.parse(line);
            } catch {
              continue; // 坏行跳过
            }
            if (row && typeof row.seq === 'number' && row.seq > maxSeq) maxSeq = row.seq;
            if (row && row.eid === eid) dup = true;
          }
        }
        if (dup) return { sent: false, duplicate: true, eid };

        const seq = maxSeq + 1;
        const row = {
          seq, eid, ts: new Date().toISOString(), by: as, text,
          taskId: task, status: st, commit: cm,
        };
        appendFileSync(eventsFile, `${JSON.stringify(row)}\n`, 'utf8');
        try {
          // 以追加模式 reopen 后 fsync，保证刚写入的行落盘（只读 fd 的 fsync 在部分平台是空操作）
          const fd = openSync(eventsFile, 'a');
          try {
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
        } catch {
          // fsync 失败不影响已落盘内容（best-effort），send 仍算成功
        }
        return { sent: true, eid, seq };
      });
    } catch (e) {
      try {
        logger('warn', 'filebus send failed', { error: String(e?.message ?? e).slice(0, 200) });
      } catch {
        // logger 永不影响主流程
      }
      return { sent: false, eid: eventId(taskId ?? '-', status ?? '-', commit ?? '-', runId), reason: String(e?.message ?? e).slice(0, 200) };
    }
  }

  /** 兼容旧 sweep：FileBus 无 outbox，恒返 0。 */
  async function flushOutbox() {
    return 0;
  }

  /** 读末 N 条好行；坏行跳过并记 warn；新位空/缺时回退旧位；永不抛错。 */
  async function tail(limit = 40) {
    try {
      const n = Math.max(0, Number(limit) || 0);
      if (n === 0) return [];
      let { rows, bad } = readGoodRows(eventsFile);
      if (!rows.length && legacyFile) {
        const fb = readGoodRows(legacyFile, true);
        rows = fb.rows;
        bad += fb.bad;
      }
      if (bad > 0) {
        try {
          logger('warn', 'filebus tail skipped bad lines', { bad });
        } catch { /* logger 永不影响主流程 */ }
      }
      return rows.slice(-n);
    } catch {
      return [];
    }
  }

  /**
   * mtime 轮询等新事件：文件有追加即返回末行 text，超时返回 null。
   * 上限 10s（调用方传更长也只等 10s，避免挂死；Swarm 靠 autoWake 唤醒，不依赖阻塞 wait）。
   */
  async function wait({ timeout = 10000, as = 'orchestrator' } = {}) {
    void as;
    try {
      const budget = Math.min(parseTimeout(timeout, 10000), 10000);
      const before = fileKey(eventsFile);
      const t0 = Date.now();
      for (;;) {
        await sleepMs(200);
        if (fileKey(eventsFile) !== before) {
          const { rows } = readGoodRows(eventsFile);
          const last = rows[rows.length - 1];
          if (last) return last.text ?? JSON.stringify(last);
          return null;
        }
        if (Date.now() - t0 >= budget) return null;
      }
    } catch {
      return null;
    }
  }

  return { send, flushOutbox, tail, wait, eventId };
}
