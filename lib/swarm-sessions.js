/**
 * swarm-sessions — 会话侧的三件小事（模型校验 / 需求命名 / 轮次台账）。
 *
 * 为什么单独一层：
 * - 模型校验必须发生在「建会话之前」。OpenCode 的 `session.switchModel` 对不存在的
 *   provider/model 会静默成功（204），错误要等该会话真正跑一步才以
 *   `ModelUnavailableError` 冒出来，看起来就像「swarm-up 成功了但没人干活」。
 * - 会话标题是唯一能让人在一堆会话里认出「哪个 swarm 是哪个需求」的线索，
 *   所以需求名要落盘（round.json），后续任何命令都能据此改名。
 *
 * 设计原则：注册表不可用时**降级放行**（fail-open），绝不因为拿不到模型列表
 * 就把整个编排卡死；但一旦拿到列表，就给明确结论 + 候选建议。
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** 角色 → 标题后缀。plan 是「主会话」，不加后缀。 */
export function roleTitle(name, role) {
  if (!name) return null;
  return role === 'plan' ? String(name) : `${name} · ${role}`;
}

/**
 * 把 `ctx.model.list()` 压成索引。返回 null 表示注册表不可用（老版本 / 读失败），
 * 调用方应当跳过校验而不是报错。
 */
export async function modelIndex(ctx) {
  let raw;
  try {
    raw = await ctx.model?.list?.();
  } catch {
    return null;
  }
  // 两种返回形态都要吃：插件内 `Model.Info[]`，以及客户端同款 `{ location, data }`。
  const models = Array.isArray(raw) ? raw : (Array.isArray(raw?.data) ? raw.data : null);
  if (!models || models.length === 0) return null;
  const byRef = new Map();
  const byProvider = new Map();
  const entries = [];
  for (const m of models) {
    const providerID = m?.providerID ?? m?.provider?.id;
    const id = m?.id ?? m?.modelID;
    if (!providerID || !id) continue;
    if (m.enabled === false) continue;
    entries.push({ providerID, id, name: m.name ?? id });
    byRef.set(`${providerID}/${id}`, m);
    if (!byProvider.has(providerID)) byProvider.set(providerID, []);
    byProvider.get(providerID).push(id);
  }
  if (!byRef.size) return null;
  return { byRef, byProvider, entries, providers: [...byProvider.keys()] };
}

/** 在候选里挑最像的几个（大小写/分隔符无关），用于「你是不是想用」。 */
function closeMatches(wanted, candidates, limit = 3) {
  const w = norm(wanted);
  if (!w) return candidates.slice(0, limit);
  const scored = candidates
    .map((c) => {
      const n = norm(c);
      let score = 0;
      if (n === w) score = 100;
      else if (n.startsWith(w) || w.startsWith(n)) score = 80;
      else if (n.includes(w) || w.includes(n)) score = 60;
      else {
        // 逐字符重合度，兜底模糊
        const chars = new Set(w.split(''));
        const hit = n.split('').filter((ch) => chars.has(ch)).length;
        score = Math.round((hit / Math.max(n.length, 1)) * 30);
      }
      return { c, score };
    })
    .filter((x) => x.score >= 30)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.c);
}

/**
 * 校验 `{providerID, id}`。
 * @returns {{ok:true, providerID:string, id:string} | {ok:false, reason:string, suggestions:string[]}}
 *   建议字符串已经是可直接粘贴的 `provider/model` 形式。
 */
export function resolveModelRef(index, ref) {
  const providerID = String(ref?.providerID ?? '').trim();
  const id = String(ref?.id ?? '').trim();
  if (!providerID || !id) return { ok: false, reason: '模型格式应为 provider/model', suggestions: [] };
  if (!index) return { ok: true, providerID, id };

  const hit = index.byRef.get(`${providerID}/${id}`);
  if (hit) return { ok: true, providerID, id };

  const provider = index.providers.find((p) => p === providerID)
    ?? index.providers.find((p) => norm(p) === norm(providerID))
    ?? index.providers.find((p) => norm(p).includes(norm(providerID)) || norm(providerID).includes(norm(p)));

  if (!provider) {
    const provs = closeMatches(providerID, index.providers);
    return {
      ok: false,
      reason: `没有 provider "${providerID}"`,
      suggestions: provs.flatMap((p) => (index.byProvider.get(p) ?? []).slice(0, 1).map((m) => `${p}/${m}`)).slice(0, 3),
    };
  }

  const ids = index.byProvider.get(provider) ?? [];
  const sameIdOtherCase = ids.find((x) => norm(x) === norm(id));
  if (sameIdOtherCase) {
    return {
      ok: false,
      reason: `模型名大小写不一致："${providerID}/${id}"（provider 应为 "${provider}"，模型应为 "${sameIdOtherCase}"）`,
      suggestions: [`${provider}/${sameIdOtherCase}`],
    };
  }

  // 跨 provider 找同名模型：真实的翻车大多是「provider 写错/拼错」（OpenCode → opencode-go、
  // Opencodel → opencode-go），此时同一个模型 ID 在别的 provider 下是存在的，直接给正确写法。
  const crossProvider = [];
  for (const [p, list] of index.byProvider) {
    if (p === provider) continue;
    const hitId = list.find((x) => norm(x) === norm(id));
    if (hitId) crossProvider.push(`${p}/${hitId}`);
  }
  if (crossProvider.length) {
    return {
      ok: false,
      reason: `provider "${providerID}" 下没有模型 "${id}"`,
      suggestions: crossProvider.slice(0, 3),
    };
  }

  const near = closeMatches(id, ids, 5);
  return {
    ok: false,
    reason: `provider "${provider}" 下没有模型 "${id}"`,
    suggestions: (near.length ? near : ids.slice(0, 3)).map((m) => `${provider}/${m}`),
  };
}

// ─── 轮次台账（.trellis/swarm-state/round.json） ────────────────────────────
// 记「这一轮需求的会话是谁」，供改名 / 唤醒 / 状态展示使用。
// 单文件 + 原子替换，和队列的写入哲学一致（tmp + rename）。

export function roundPath(stateDir) {
  return resolve(stateDir, 'round.json');
}

export function readRound(stateDir) {
  try {
    return JSON.parse(readFileSync(roundPath(stateDir), 'utf8')) ?? {};
  } catch {
    return {};
  }
}

export function writeRound(stateDir, patch, opts = {}) {
  mkdirSync(stateDir, { recursive: true });
  const prev = readRound(stateDir);
  const next = {
    ...prev,
    ...patch,
    // 默认合并 sessions（nameRound 等增量登记场景零变）；
    // replaceSessions=true 时整体替换（/swarm-up 新轮：只登记本次新建的，
    // 不合并旧轮残留 ID，防唤醒打到昨天的死会话）。
    sessions: opts.replaceSessions
      ? { ...(patch.sessions ?? {}) }
      : { ...(prev.sessions ?? {}), ...(patch.sessions ?? {}) },
    updatedAt: new Date().toISOString(),
  };
  const file = roundPath(stateDir);
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
  return next;
}

/**
 * 从需求文本推一个会话标题：去 markdown/标签噪音，取第一句，按视觉宽度截断。
 * 中文按 2 宽度算，保证「需求名」在 TUI 列表里不被截成半个词。
 */
export function deriveName(text, maxWidth = 46) {
  let s = String(text ?? '')
    .replace(/^#+[a-zA-Z][\w-]*/, '') // 去掉开头的 #plan
    .replace(/\b[A-Z]\d+-T\d+\b/g, '') // 去掉任务号
    .replace(/[*_`>#]/g, '')
    .replace(/^\s*需求[:：]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  s = s.split(/[\n。！？!?；;]/)[0].trim();
  if (!s) return '';
  let width = 0;
  let out = '';
  for (const ch of s) {
    const w = /[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
    if (width + w > maxWidth) return `${out.trim()}…`;
    out += ch;
    width += w;
  }
  return out.trim();
}
