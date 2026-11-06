/**
 * swarm-gate — 客观门禁管道：verify_cmd exit 0 + verdict + commit 绑定 + Policy 禁区 + secret 扫描 + diff 证据 + security 占位。
 *
 * 设计要点：
 * - 全异步（runVerify 不阻塞事件循环）。
 * - 管道式：GATES 串行短路，加新 Gate 只需 `registerGate(gate)` 加一行。
 * - 每步签名 `(opts) -> {ok, reason, evidence}`，reason 带 `gate=<name>` 前缀。
 * - verifyGate/verdictGate 是旧 checkGate 代码块搬入；verdictGate 比较已归一化
 *  （short/full 任一为另一前缀即同一 commit，容忍 git rev-parse --short 混用）。
 * - policyGate：声明 paths 严格判定禁区；未声明 paths 时 git 工作区作补充信号，
 *   其中命中 `.opencode/**` 降级为 warning 证据（reason 带 `gate=policy:warning`）而不拒，
 *   其余禁区仍拒。policy_exception 命中恒放行。
 * - secretScanGate：真 secret 检查（默认进 GATES）：扫 `git show <commit>` 新增行
 *   全量 + worktree 未跟踪新文件仅扫 task.paths 命中（防全仓噪音），纯本地正则；
 *   基线 `.swarm/secret-baseline.json`（[{file,hash}]，hash=sha256(路径+命中行规范化)）
 *   只报新增（no-repeats 模式，不共用 reviewer 的 Pre-existing 表）；首次命中写基线
 *   + timeline kind='secret-baseline' 纯审计行；policy_exception 命中恒放行+warning。
 * - diffGate：只产出改动文件数证据，恒 ok（给“超大 diff 强制拆分”留插槽）。
 * - securityGate：占位恒 ok + warning（reason: gate=security: security-not-configured，
 *   evidence.warning=true，经 checkGate warnings 管道透出；证明“一行接入”）。
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative, sep, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runVerify } from './swarm-exec.js';

function spawnGit(cwd, args, gitBin = 'git') {
  return new Promise((res) => {
    const child = spawn(gitBin, args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c.toString('utf8'); });
    child.on('error', () => res(null));
    child.on('close', (code) => res(code === 0 ? out.trim() : null));
  });
}

function gitHead(cwd, gitBin = 'git') {
  return spawnGit(cwd, ['rev-parse', '--short', 'HEAD'], gitBin);
}

/**
 * R3：读 base 分支头（main 优先，master 回退；都取不到回 null，永不抛错）。
 * 供 swarm_done 在进 gate_check 时记录 task.baseHEAD，门禁通过后比对。
 */
export function baseHead(cwd, opts = {}) {
  const gitBin = opts?.gitBin ?? 'git';
  return (async () => {
    const main = await spawnGit(cwd, ['rev-parse', 'main'], gitBin);
    if (main) return main;
    const master = await spawnGit(cwd, ['rev-parse', 'master'], gitBin);
    return master || null;
  })().catch(() => null);
}

/** 工作区改动文件（相对 cwd）：git status --porcelain 解析，失败/非 git 仓回 []，永不抛错。 */
function gitChangedFiles(cwd, gitBin = 'git') {
  return new Promise((res) => {
    const child = spawn(gitBin, ['status', '--porcelain', '-uall'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c.toString('utf8'); });
    child.on('error', () => res([]));
    child.on('close', (code) => {
      if (code !== 0) return res([]);
      const files = [];
      for (const line of out.split('\n')) {
        const p = line.slice(3).trim().replace(/^"(.*)"$/, '$1');
        if (!p) continue;
        // 重命名形如 `R  old -> new`，取新路径
        const name = p.includes(' -> ') ? p.split(' -> ').pop().trim() : p;
        if (name) files.push(name);
      }
      res(files);
    });
  });
}

export async function headCommit(cwd, gitBin = 'git') {
  return gitHead(cwd, gitBin);
}

/** 禁区模式：`**` 后缀为前缀匹配，其余精确匹配（相对路径归一化后比较）。 */
export const FORBIDDEN = ['tools/review/**', '.opencode/**', 'opencode.json'];

function normPath(p) {
  return String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

/** 相对路径 file 是否命中任一模式。 */
export function matchPatterns(file, patterns) {
  const f = normPath(file);
  if (!f) return null;
  for (const raw of patterns ?? []) {
    const pat = normPath(raw);
    if (!pat) continue;
    if (pat.endsWith('/**')) {
      if (f === pat.slice(0, -3) || f.startsWith(pat.slice(0, -2))) return pat;
    } else if (f === pat || f.endsWith(`/${pat}`)) {
      return pat;
    }
  }
  return null;
}

/** commit 同一性：相等或任一是另一的前缀（容忍 short/full 混用）；任一为空回 false。 */
function sameCommit(a, b) {
  const x = String(a ?? '').trim();
  const y = String(b ?? '').trim();
  if (!x || !y) return false;
  return x === y || x.startsWith(y) || y.startsWith(x);
}

/** `.opencode/**` 命中判定（工作区补充信号降级 warning 用）。 */
function isOpencodeHit(file) {
  return matchPatterns(file, ['.opencode/**']) !== null;
}

function toRel(cwd, p) {
  const s = String(p ?? '');
  if (!s) return '';
  const absP = s.startsWith('/') ? s : resolve(cwd, s);
  const rel = relative(cwd, absP).split(sep).join('/');
  return normPath(rel || s);
}

// ── 各 Gate（签名统一为 (opts) -> {ok, reason, evidence}） ──

export async function verifyGate(opts) {
  const { cwd, verify_cmd, timeoutMs = 300_000, allowlist } = opts;
  const run = await runVerify(verify_cmd, { cwd, timeoutMs, allowlist });
  if (!run.ok) {
    return {
      ok: false,
      reason: `gate=verify: ${run.reason}`,
      evidence: {
        kind: 'verify', durationMs: run.durationMs, code: run.code, timedOut: run.timedOut,
        stdout: run.stdout.slice(-2000), stderr: run.stderr.slice(-2000),
      },
    };
  }
  // B3③：改写类 flag 的 warn 证据经 warning 管道透出（checkGate 收集进 reason），不拦。
  const execWarnings = Array.isArray(run.warnings) ? run.warnings : [];
  if (execWarnings.length > 0) {
    return {
      ok: true,
      reason: `gate=verify: ok (warnings: ${execWarnings.join('; ')})`,
      evidence: { kind: 'verify', durationMs: run.durationMs, warnings: execWarnings, warning: true },
    };
  }
  return { ok: true, reason: 'gate=verify: ok', evidence: { kind: 'verify', durationMs: run.durationMs } };
}

export async function verdictGate(opts) {
  const { cwd, verdict_path, commit, requireVerdict = false, gitBin = 'git' } = opts;
  if (!verdict_path) {
    if (requireVerdict) return { ok: false, reason: 'gate=verdict: verdict required but verdict_path not set', evidence: { kind: 'verdict' } };
    return { ok: true, reason: 'gate=verdict: ok (no verdict required)', evidence: { kind: 'verdict' } };
  }
  const p = resolve(cwd, verdict_path);
  if (!existsSync(p)) {
    return { ok: false, reason: `gate=verdict: verdict missing: ${verdict_path}`, evidence: { kind: 'verdict' } };
  }
  let v;
  try {
    v = JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    return { ok: false, reason: `gate=verdict: verdict unreadable: ${String(e.message).slice(0, 200)}`, evidence: { kind: 'verdict' } };
  }
  if (v.allPassed !== true) {
    return { ok: false, reason: `gate=verdict: verdict allPassed != true (${verdict_path})`, evidence: { kind: 'verdict', verdict: v } };
  }
  const head = await gitHead(cwd, gitBin);
  const want = commit ?? v.reviewedCommit;
  if (want && v.reviewedCommit && !sameCommit(want, v.reviewedCommit)) {
    return { ok: false, reason: `gate=verdict: commit mismatch: msg=${want} verdict=${v.reviewedCommit}`, evidence: { kind: 'commit' } };
  }
  if (v.reviewedCommit && head && !sameCommit(v.reviewedCommit, head)) {
    return { ok: false, reason: `gate=verdict: stale verdict: reviewed=${v.reviewedCommit} HEAD=${head}`, evidence: { kind: 'commit', head } };
  }
  return { ok: true, reason: 'gate=verdict: ok', evidence: { kind: 'verdict', commit: head } };
}

export async function policyGate(opts) {
  const { cwd, paths = [], policy_exception = false, policyDeny = [], gitBin = 'git' } = opts;
  const declared = [...new Set((Array.isArray(paths) ? paths : []).map((p) => toRel(cwd, p)).filter(Boolean))];
  const patterns = [...FORBIDDEN, ...(Array.isArray(policyDeny) ? policyDeny : [])];
  // ① 声明路径：严格判定（.opencode/** 命中亦拒）。
  for (const f of declared) {
    const hit = matchPatterns(f, patterns);
    if (hit) {
      if (policy_exception) {
        return { ok: true, reason: `gate=policy: exception for ${f} (pattern ${hit})`, evidence: { kind: 'policy', files: declared, hit, exception: true } };
      }
      return { ok: false, reason: `gate=policy: forbidden path ${f} (pattern ${hit})`, evidence: { kind: 'policy', files: declared, hit } };
    }
  }
  // 声明了 paths：只看声明，不看工作区。
  if (declared.length > 0) {
    return { ok: true, reason: `gate=policy: ok (${declared.length} files)`, evidence: { kind: 'policy', files: declared } };
  }
  // ② 未声明 paths：git 工作区作补充信号；命中 .opencode/** 降级为 warning 而不拒。
  const changed = [...new Set((await gitChangedFiles(cwd, gitBin)).map(normPath).filter(Boolean))];
  let warnFile = null;
  let warnHit = null;
  for (const f of changed) {
    const hit = matchPatterns(f, patterns);
    if (!hit) continue;
    if (policy_exception) {
      return { ok: true, reason: `gate=policy: exception for ${f} (pattern ${hit})`, evidence: { kind: 'policy', files: changed, hit, exception: true } };
    }
    if (isOpencodeHit(f)) {
      warnFile = f;
      warnHit = hit;
      continue;
    }
    return { ok: false, reason: `gate=policy: forbidden path ${f} (pattern ${hit})`, evidence: { kind: 'policy', files: changed, hit } };
  }
  if (warnHit) {
    return { ok: true, reason: `gate=policy:warning dirty .opencode file ${warnFile} (pattern ${warnHit})`, evidence: { kind: 'policy', files: changed, hit: warnHit, warning: true } };
  }
  return { ok: true, reason: `gate=policy: ok (${changed.length} files)`, evidence: { kind: 'policy', files: changed } };
}

export async function diffGate(opts) {
  const { cwd, paths = [], gitBin = 'git' } = opts;
  const changed = await gitChangedFiles(cwd, gitBin);
  const declared = (Array.isArray(paths) ? paths : []).filter((p) => String(p ?? '').trim());
  const n = new Set([...changed, ...declared.map((p) => toRel(cwd, p))].filter(Boolean)).size;
  return { ok: true, reason: `gate=diff: ok (${n} files)`, evidence: { kind: 'diff', fileCount: n } };
}

export async function securityGate() {
  return { ok: true, reason: 'gate=security: security-not-configured', evidence: { kind: 'security', warning: true } };
}

// ── secret 扫描门（默认进 GATES，真检查；no-repeats 基线，不共用 reviewer 表） ──

/** 基线文件名（相对 cwd）：`.swarm/secret-baseline.json`，[{file, hash}]。 */
export const SECRET_BASELINE_FILE = '.swarm/secret-baseline.json';

/**
 * 纯本地 secret 正则（无网络）：
 * - private-key：`-----BEGIN .*PRIVATE KEY-----` 头
 * - aws-ak：AKIA + 16 位大写数字
 * - openai-sk：sk- + 8 位以上
 * - github-token：ghp/gho/ghu/ghs/ghr_ + 8 位以上
 * - secret-assign：PRD 原式 `(?i)(api[_-]?key|secret|token)\s*[:=]\s*['"][^'"]{8,}`
 * - aksk-assign：ak/sk 赋值（含无引号值，8 位以上）
 */
export const SECRET_PATTERNS = [
  { id: 'private-key', re: /-----BEGIN [^-]*PRIVATE KEY-----/ },
  { id: 'aws-ak', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'openai-sk', re: /\bsk-[A-Za-z0-9_-]{8,}\b/ },
  { id: 'github-token', re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{8,}\b/ },
  { id: 'secret-assign', re: /(api[_-]?key|secret|token)\s*[:=]\s*['"][^'"]{8,}/i },
  { id: 'aksk-assign', re: /(^|[^a-zA-Z])(ak|sk)\s*[:=]\s*['"]?[^'"\s]{8,}/i },
];

/** 单行命中返回 rule id，未命中回 null（永不抛错）。 */
export function scanSecretLine(line) {
  let s = '';
  try {
    s = String(line ?? '');
  } catch {
    return null;
  }
  for (const p of SECRET_PATTERNS) {
    try {
      if (p.re.test(s)) return p.id;
    } catch {
      // 坏正则跳过（防御性，永不抛错）
    }
  }
  return null;
}

/** 命中行规范化：空白折叠 + trim（hash 口径，改空格不算新增）。 */
export function normSecretLine(line) {
  return String(line ?? '').replace(/\s+/g, ' ').trim();
}

/** 基线 hash 口径：sha256(规范化路径 + '\0' + 规范化命中行)。 */
export function hashSecretHit(file, line) {
  return createHash('sha256').update(`${normPath(file)}\0${normSecretLine(line)}`).digest('hex');
}

/** worktree 未跟踪文件（`??` 行）：失败/非 git 仓回 []，永不抛错。 */
function gitUntrackedFiles(cwd, gitBin = 'git') {
  return new Promise((res) => {
    const child = spawn(gitBin, ['status', '--porcelain', '-uall'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c.toString('utf8'); });
    child.on('error', () => res([]));
    child.on('close', (code) => {
      if (code !== 0) return res([]);
      const files = [];
      for (const line of out.split('\n')) {
        if (!line.startsWith('??')) continue;
        const p = line.slice(2).trim().replace(/^"(.*)"$/, '$1');
        if (!p) continue;
        const name = p.includes(' -> ') ? p.split(' -> ').pop().trim() : p;
        if (name) files.push(name);
      }
      res(files);
    });
  });
}

/** declared 是否覆盖 file（相等或 dir 前缀；相对路径归一化后比较）。 */
function coversPath(declared, file) {
  const d = normPath(declared);
  const f = normPath(file);
  if (!d || !f) return false;
  if (f === d) return true;
  const prefix = d.endsWith('/') ? d : `${d}/`;
  return f.startsWith(prefix);
}

/**
 * diff 文本扫新增行 → hits[{file, line, text, rule}]：
 * 跟踪 `diff --git` / `+++ b/<file>` 定文件，`@@ -a,b +c,d @@` 定新行号；
 * `+`（非 `+++`）行逐行过正则。无 hunk 头时行号回退计数。永不抛错。
 */
export function scanDiffText(diffText) {
  const hits = [];
  try {
    let curFile = '';
    let newLine = 0;
    let fallback = 0;
    for (const raw of String(diffText ?? '').split('\n')) {
      if (raw.startsWith('diff --git ')) {
        const parts = raw.split(' ');
        const b = parts[parts.length - 1] ?? '';
        const f = b.startsWith('b/') ? b.slice(2) : b;
        if (f && f !== '/dev/null') curFile = f.replace(/^"(.*)"$/, '$1');
        continue;
      }
      if (raw.startsWith('+++ ')) {
        let f = raw.slice(4).trim().replace(/^"(.*)"$/, '$1');
        if (f.startsWith('b/')) f = f.slice(2);
        if (f && f !== '/dev/null') curFile = f;
        continue;
      }
      if (raw.startsWith('@@ ')) {
        const m = /\+(\d+)(?:,(\d+))?/.exec(raw);
        if (m) newLine = parseInt(m[1], 10);
        continue;
      }
      if (raw.startsWith('+') && !raw.startsWith('+++')) {
        const content = raw.slice(1);
        fallback += 1;
        const lineNo = newLine > 0 ? newLine : fallback;
        if (newLine > 0) newLine += 1;
        let rule = null;
        try {
          rule = scanSecretLine(content);
        } catch {
          rule = null;
        }
        if (rule) {
          hits.push({
            file: normPath(curFile || '(diff)'),
            line: lineNo,
            text: content.slice(0, 200),
            rule,
          });
        }
        continue;
      }
      if (raw.startsWith(' ') && newLine > 0) newLine += 1;
    }
  } catch {
    // 解析失败回已收集部分（永不抛错）
  }
  return hits;
}

/**
 * secret 扫描门（默认进 GATES）：
 * 扫描对象 = `git show <commit>` 新增行全扫 + worktree 未跟踪新文件仅扫 task.paths 命中。
 * opts 扩展（全可选，均有 fail-open 默认）：
 * - diffText：fixture 注入（单测离线用；给了就不用 git show）
 * - baselinePath：基线文件绝对/相对路径（缺省 `<cwd>/.swarm/secret-baseline.json`）
 * - timelinePath + taskId：给了则首次命中写 kind='secret-baseline' 纯审计行
 *   （rebuild 只认 create/move/revert，该 kind 不参与重放，零影响）。
 * 基线语义 no-repeats：fresh 为空（全命中已在基线）即放行；fresh 非空则写基线后
 * 按 policy_exception 分流（与 policyGate 同口径：命中恒放行+warning，不发明例外）。
 */
export async function secretScanGate(opts) {
  const {
    cwd, commit, paths = [], policy_exception = false, gitBin = 'git',
    diffText, baselinePath, timelinePath, taskId,
  } = opts ?? {};
  const dir = cwd ?? process.cwd();
  const basePath = baselinePath ?? resolve(dir, SECRET_BASELINE_FILE);
  let diffHits = [];
  try {
    let text = diffText;
    if (text === undefined && commit) {
      text = await spawnGit(dir, ['show', String(commit), '--format=', '--no-color', '--unified=0'], gitBin);
    }
    if (text) diffHits = scanDiffText(text);
  } catch {
    diffHits = [];
  }
  let workHits = [];
  try {
    const declared = [...new Set((Array.isArray(paths) ? paths : []).map((p) => toRel(dir, p)).filter(Boolean))];
    if (declared.length > 0) {
      const untracked = await gitUntrackedFiles(dir, gitBin);
      const targets = untracked.filter((f) => {
        const rel = normPath(f);
        return declared.some((d) => coversPath(d, rel));
      });
      for (const f of targets) {
        let content = '';
        try {
          content = readFileSync(resolve(dir, f), 'utf8');
        } catch {
          continue;
        }
        const slice = content.length > 512000 ? content.slice(0, 512000) : content;
        const lines = slice.split('\n');
        for (let i = 0; i < lines.length; i += 1) {
          let rule = null;
          try {
            rule = scanSecretLine(lines[i]);
          } catch {
            rule = null;
          }
          if (rule) {
            workHits.push({
              file: normPath(f),
              line: i + 1,
              text: String(lines[i]).slice(0, 200),
              rule,
            });
          }
        }
      }
    }
  } catch {
    workHits = [];
  }
  const allHits = [...diffHits, ...workHits];
  if (allHits.length === 0) {
    return { ok: true, reason: 'gate=secret: ok (no secrets in diff/worktree)', evidence: { kind: 'secret', hits: [] } };
  }
  let baseline = [];
  let baselineSet = new Set();
  try {
    if (existsSync(basePath)) {
      const arr = JSON.parse(readFileSync(basePath, 'utf8'));
      if (Array.isArray(arr)) {
        baseline = arr.filter((e) => e && typeof e.file === 'string' && typeof e.hash === 'string');
        baselineSet = new Set(baseline.map((e) => e.hash));
      }
    }
  } catch {
    baseline = [];
    baselineSet = new Set();
  }
  const withHash = allHits.map((h) => ({ ...h, hash: hashSecretHit(h.file, h.text) }));
  const fresh = withHash.filter((h) => !baselineSet.has(h.hash));
  if (fresh.length === 0) {
    return {
      ok: true,
      reason: `gate=secret: ok (${allHits.length} hits all baselined)`,
      evidence: { kind: 'secret', hits: allHits.map(({ hash, ...r }) => r), baselined: true },
    };
  }
  try {
    const next = [...baseline, ...fresh.map((h) => ({ file: h.file, hash: h.hash }))];
    const seen = new Set();
    const deduped = [];
    for (const e of next) {
      if (!seen.has(e.hash)) {
        seen.add(e.hash);
        deduped.push(e);
      }
    }
    mkdirSync(dirname(basePath), { recursive: true });
    const tmp = `${basePath}.tmp.${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(deduped, null, 2)}\n`, 'utf8');
    renameSync(tmp, basePath);
  } catch {
    // 基线写失败不拦（best-effort，下次重报）
  }
  try {
    if (timelinePath) {
      const { appendTimeline } = await import('./swarm-store.js');
      appendTimeline(timelinePath, {
        taskId: taskId ?? '-', kind: 'secret-baseline', from: null, to: null,
        by: 'gate', reason: `secret-baseline:${fresh.length}`,
        commit: commit ?? '-', retries: 0,
      });
    }
  } catch {
    // timeline 审计行 best-effort
  }
  if (policy_exception) {
    return {
      ok: true,
      reason: `gate=secret: exception for ${fresh[0].file}:${fresh[0].line} (policy_exception)`,
      evidence: { kind: 'secret', hits: fresh.map(({ hash, ...r }) => r), exception: true, warning: true },
    };
  }
  const first = fresh[0];
  return {
    ok: false,
    reason: `gate=secret: secret leak ${first.file}:${first.line} (${first.rule})`,
    evidence: { kind: 'secret', hits: fresh.map(({ hash, ...r }) => r) },
  };
}

// ── R2：文件级开关门禁（默认不进 GATES，经 opts.gates 白名单显式启用） ──

/**
 * lint 门禁：`make gate`。默认命令可在 opts.lint_cmd 覆盖（单测/特殊 cwd 用）。
 * reason 恒带 gate=lint。
 */
export async function lintGate(opts) {
  const { cwd, timeoutMs = 300_000, allowlist, lint_cmd } = opts;
  const cmd = lint_cmd ?? 'make gate';
  const run = await runVerify(cmd, { cwd, timeoutMs, allowlist });
  if (!run.ok) {
    return {
      ok: false,
      reason: `gate=lint: ${run.reason}`,
      evidence: {
        kind: 'lint', durationMs: run.durationMs, code: run.code, timedOut: run.timedOut,
        stdout: run.stdout.slice(-2000), stderr: run.stderr.slice(-2000),
      },
    };
  }
  return { ok: true, reason: 'gate=lint: ok', evidence: { kind: 'lint', durationMs: run.durationMs } };
}

/**
 * type 门禁：项目自备的类型检查命令（本包不假设具体技术栈）。
 * 必须显式传 opts.type_cmd（如 node scripts/tsc-gate.mjs）；未传直接拒收并指引。
 * reason 恒带 gate=type。
 */
export async function typeGate(opts) {
  const { cwd, timeoutMs = 300_000, allowlist, type_cmd } = opts;
  const cmd = (typeof type_cmd === 'string' && type_cmd.trim()) ? type_cmd : null;
  if (!cmd) {
    return {
      ok: false,
      reason: 'gate=type: type_cmd 未配置：启用 type 门须显式传 type_cmd（如 node scripts/tsc-gate.mjs，exit 0=过）',
      evidence: { kind: 'type' },
    };
  }
  const run = await runVerify(cmd, { cwd, timeoutMs, allowlist });
  if (!run.ok) {
    return {
      ok: false,
      reason: `gate=type: ${run.reason}`,
      evidence: {
        kind: 'type', durationMs: run.durationMs, code: run.code, timedOut: run.timedOut,
        stdout: run.stdout.slice(-2000), stderr: run.stderr.slice(-2000),
      },
    };
  }
  return { ok: true, reason: 'gate=type: ok', evidence: { kind: 'type', durationMs: run.durationMs } };
}

/**
 * tenant 门禁：tenant 检查的 node 包装器（tenant-check.sh 是 shell，
 * 不许加 bash 进 allowlist，经 node 中转；包装器 argv 守 B3 规则）。
 * 默认跑包内包装器（路径以本文件为基准，与包安装位置无关）；
 * 可在 opts.tenant_cmd 覆盖。reason 恒带 gate=tenant。
 */
export async function tenantGate(opts) {
  const { cwd, timeoutMs = 300_000, allowlist, tenant_cmd } = opts;
  const cmd = tenant_cmd ?? `node ${fileURLToPath(new URL('./swarm-tenant-check.mjs', import.meta.url))}`;
  const run = await runVerify(cmd, { cwd, timeoutMs, allowlist });
  if (!run.ok) {
    return {
      ok: false,
      reason: `gate=tenant: ${run.reason}`,
      evidence: {
        kind: 'tenant', durationMs: run.durationMs, code: run.code, timedOut: run.timedOut,
        stdout: run.stdout.slice(-2000), stderr: run.stderr.slice(-2000),
      },
    };
  }
  return { ok: true, reason: 'gate=tenant: ok', evidence: { kind: 'tenant', durationMs: run.durationMs } };
}

/**
 * 当前分支（11-06 单树复盘：dev 自建 worktree/分支导致 verify/test/reviewer 各看各的树）。
 * 返回 {ok, branch} / {ok:false, reason:'detached'|'not-a-repo'}，永不抛错。
 */
export async function gitBranch(cwd, gitBin = 'git') {
  try {
    const out = await spawnGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], gitBin);
    const b = String(out ?? '').trim();
    if (!b) return { ok: false, reason: 'not-a-repo' };
    if (b === 'HEAD') return { ok: false, reason: 'detached' };
    return { ok: true, branch: b };
  } catch {
    return { ok: false, reason: 'not-a-repo' };
  }
}

/**
 * branch 同分支门（11-06）：分支只能主会话经 `/swarm-up --branch` 声明，
 * dev/test 全员走同一条；dev 自建分支干活会在 done 这里被拦下。
 * 未声明（expectedBranch 为空）直接过——legacy 轮零变，不碰 git。
 * reason 恒带 gate=branch。
 */
export async function branchGate(opts) {
  const want = typeof opts?.expectedBranch === 'string' ? opts.expectedBranch.trim() : '';
  if (!want) {
    return { ok: true, reason: 'gate=branch: ok (no branch declared)', evidence: { kind: 'branch' } };
  }
  const gitBin = opts?.gitBin ?? 'git';
  const cur = await gitBranch(opts?.cwd, gitBin);
  if (!cur.ok) {
    const why = cur.reason === 'detached'
      ? '当前是 detached HEAD（不在任何分支上）'
      : '当前目录不是 git 仓（读不到分支）';
    return {
      ok: false,
      reason: `gate=branch: ${why}，本轮分支是 ${want}。主会话切到该分支后重跑 done（dev 禁自建 worktree/分支，分支只能主会话开）`,
      evidence: { kind: 'branch', expected: want },
    };
  }
  if (cur.branch !== want) {
    return {
      ok: false,
      reason: `gate=branch: 当前分支 ${cur.branch} ≠ 本轮分支 ${want}（疑似在别的分支/worktree 干活）。主会话切到 ${want} 后重跑 done；在 ${want} 上重做改动，不要跨分支交`,
      evidence: { kind: 'branch', expected: want, actual: cur.branch },
    };
  }
  return { ok: true, reason: 'gate=branch: ok', evidence: { kind: 'branch', expected: want, actual: cur.branch } };
}

verifyGate.gateName = 'verify';
verdictGate.gateName = 'verdict';
policyGate.gateName = 'policy';
secretScanGate.gateName = 'secret';
diffGate.gateName = 'diff';
securityGate.gateName = 'security';
lintGate.gateName = 'lint';
typeGate.gateName = 'type';
tenantGate.gateName = 'tenant';
branchGate.gateName = 'branch';

/** Gate 管道：串行短路，加新 Gate 只需 registerGate 加一行。 */
export const GATES = [verifyGate, verdictGate, policyGate, secretScanGate, diffGate, securityGate];

/** R2 开关门禁：默认不进 GATES，只经 checkGate(opts.gates) 白名单启用。 */
export const EXTRA_GATES = [lintGate, typeGate, tenantGate, branchGate];

const gateNameOf = (g) => (typeof g?.gateName === 'string' && g.gateName) || g?.name || '?';

/** 加新 Gate 只加一行：registerGate(myGate)。 */
export function registerGate(gate) {
  GATES.push(gate);
}

/**
 * 管道 runner：签名与旧 checkGate 一致（新增可选 paths/policy_exception/policyDeny）。
 * R2：opts.gates 白名单数组只跑交集（解决 GATES 全局 push-only：运行时传显式名单，
 * 误注册/残留的 Gate 不会被带跑）；不传则跑默认管线（旧行为兼容）。
 * @returns {Promise<{ok:boolean, reason:string, evidence?:object}>}
 */
export async function checkGate(opts) {
  let durationMs;
  let commit;
  const warnings = [];
  const all = [...GATES, ...EXTRA_GATES.filter((g) => !GATES.includes(g))];
  const list = Array.isArray(opts?.gates)
    ? all.filter((g) => opts.gates.includes(gateNameOf(g)))
    : all.filter((g) => !EXTRA_GATES.includes(g));
  for (const g of list) {
    const r = await g(opts);
    if (r && r.evidence !== undefined) {
      if (typeof r.evidence.durationMs === 'number') durationMs = r.evidence.durationMs;
      if (r.evidence.commit !== undefined && commit === undefined) commit = r.evidence.commit;
      if (r.ok && r.evidence.warning === true && typeof r.reason === 'string') warnings.push(r.reason);
    }
    if (!r || !r.ok) return r;
  }
  // 旧调用形状兼容：durationMs/commit 仍在顶层 evidence（swarm_done 回执用它）。
  // 有 warning 时 reason 透出（无 warning 时保持 'gate ok' 不变）。
  if (warnings.length > 0) {
    return { ok: true, reason: `gate ok (warnings: ${warnings.join('; ')})`, evidence: { kind: 'verify+verdict', durationMs, commit, warnings } };
  }
  return { ok: true, reason: 'gate ok', evidence: { kind: 'verify+verdict', durationMs, commit } };
}
