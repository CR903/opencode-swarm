#!/usr/bin/env node
/**
 * swarm-tenant-check — tenant 门禁的 node 包装器（R2）。
 *
 * tenant-check.sh 是 shell 脚本，不许加 bash 进 verify allowlist：
 * 由本 node 脚本中转 spawn（数组传参，不经 shell；无 console.* 输出）。
 * argv 守 B3 规则：只认已知 flag 白名单，其余一律 exit 2 拒收。
 *
 * 用法：node swarm-tenant-check.mjs [--all] [--verbose] [--exit-zero]
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const ALLOW = new Set(['--all', '--verbose', '-v', '--exit-zero', '--help', '-h']);
const SHELL_METACHARS = /[;&|`\n\r]/;
const COMMAND_SUBST = /\$\(/;

const args = process.argv.slice(2);
for (const a of args) {
  if (!ALLOW.has(a) || SHELL_METACHARS.test(a) || COMMAND_SUBST.test(a)) {
    process.stderr.write(`swarm-tenant-check: unknown or unsafe arg: ${a} (allow: ${[...ALLOW].join(' ')})\n`);
    process.exit(2);
  }
}

// 通用包：检查脚本按 SWARM_TENANT_CHECK 环境变量 → 当前仓库 smarterlab-backend/ 下的脚本
// 依次查找；都没有则给出明确指引退出（不再假设包外固定相对路径）。
const override = (process.env.SWARM_TENANT_CHECK ?? '').trim();
const candidates = [
  override || null,
  resolve(process.cwd(), 'smarterlab-backend', 'scripts', 'tenant-check.sh'),
].filter(Boolean);
const script = candidates.find((p) => {
  try { return existsSync(p); } catch { return false; }
});
if (!script) {
  process.stderr.write(
    'swarm-tenant-check: no tenant check script found '
    + '(set SWARM_TENANT_CHECK=<script> or pass tenant_cmd; '
    + 'see README "tenant 门禁")\n',
  );
  process.exit(2);
}

const child = spawn(script, args, { stdio: 'inherit' });
child.on('error', (err) => {
  process.stderr.write(`swarm-tenant-check: spawn failed: ${err.message}\n`);
  process.exit(2);
});
child.on('close', (code) => {
  process.exit(code ?? 1);
});
