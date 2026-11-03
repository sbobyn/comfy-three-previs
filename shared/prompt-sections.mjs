// Copyright (c) 2026 Steven Bobyn. SPDX-License-Identifier: MIT
// Per-section control of a shot's composed prompt: overrides and locks saved on the shot, a log of final-prompt
// versions, and a word diff between any two prompts. Pure data helpers with no scene imports, so shared/prompt.mjs
// (which composes the sections) and shared/prompt-plan.mjs (which assembles the final request) can both use them.
//
// A section is one composed segment of the auto-prompt (format, action, a cast member, the world, the look, a camera-style
// tag). Its policy is:
//   inherit  – the text comes live from its source (Cast Card, shot description, project style …).
//   override – your text replaces the source's; it can still be shortened to fit a model's prompt limit.
//   lock     – the text is frozen (the source's text when you locked it, or your override); it is never dropped to fit a
//              limit, and edits are refused until it is unlocked.
// System sections (the camera rule, the reference legend, the still's guide rules) are not editable here: they follow
// the model and the blockout, and the inspector says what changes them.

/** Section keys that are system rules: they follow the model and camera source and cannot be overridden. */
export const SYSTEM_KEYS = new Set(['camera']);
export const SECTION_POLICIES = ['inherit', 'override', 'lock'];
export const PROMPT_KINDS = ['video', 'image'];
const KEY = /^[a-z][\w:-]{0,80}$/i;
const clean = t => String(t ?? '').replace(/\s+/g, ' ').trim();

/** Saved per-shot section policies: { video?: { [key]: { mode, text, basedOn, at } }, image?: … }. */
export function normalizePromptSections(v) {
  const out = {};
  for (const kind of PROMPT_KINDS) {
    const src = v?.[kind];
    if (!src || typeof src !== 'object') continue;
    const m = {};
    for (const [k, o] of Object.entries(src).slice(0, 60)) {
      if (!KEY.test(k) || SYSTEM_KEYS.has(k) || !o || (o.mode !== 'override' && o.mode !== 'lock') || typeof o.text !== 'string') continue;
      m[k] = { mode: o.mode, text: clean(o.text).slice(0, 1500), basedOn: clean(o.basedOn).slice(0, 1500), at: typeof o.at === 'string' && o.at ? o.at.slice(0, 40) : new Date().toISOString() };
    }
    if (Object.keys(m).length) out[kind] = m;
  }
  return out;
}
/**
 * Merge a patch into saved section policies: { kind: null } clears a kind, { kind: { key: null } } returns one section to
 * inherit. Returns the normalized result ({} when nothing is overridden).
 */
export function mergePromptSections(current, patch) {
  const next = structuredClone(normalizePromptSections(current));
  for (const kind of PROMPT_KINDS) {
    if (!patch || !(kind in patch)) continue;
    if (patch[kind] === null) { delete next[kind]; continue; }
    const m = next[kind] || {};
    for (const [k, o] of Object.entries(patch[kind] || {})) { if (o === null) delete m[k]; else m[k] = o; }
    next[kind] = m;
  }
  return normalizePromptSections(next);
}

/**
 * Apply saved policies to composed segments. `capped` is what the auto-prompt keeps within its length budget, `full` every
 * candidate (same order). Returns one row per candidate section, in prompt order:
 *   { ...segment, autoText, policy, active, status, basedOn? }
 * status: 'included' | 'shortened' (the budget kept a shorter form) | 'omitted' (left out by the budget) | 'removed'
 * (overridden with empty text) | 'orphan' (a saved policy whose source is no longer in the shot; never sent).
 * Overridden and locked sections are always active, even when the budget would have left them out.
 */
export function applySections(capped, full, overrides = {}) {
  const kept = new Map(capped.map(s => [s.key, s])), rows = [];
  for (const f of full) {
    const c = kept.get(f.key), o = SYSTEM_KEYS.has(f.key) ? null : overrides?.[f.key];
    const base = c || f, autoText = base.text;
    if (o) rows.push({ ...base, text: o.text, autoText, fullText: f.text, policy: o.mode, basedOn: o.basedOn, at: o.at, active: true, status: o.text ? 'included' : 'removed', ...(o.preset ? { preset: true } : {}) });
    else if (c) rows.push({ ...c, autoText, fullText: f.text, policy: 'inherit', active: true, status: c.text === f.text ? 'included' : 'shortened' });
    else rows.push({ ...f, autoText, fullText: f.text, policy: 'inherit', active: false, status: 'omitted' });
  }
  for (const [k, o] of Object.entries(overrides || {})) {
    if (full.some(f => f.key === k)) continue;
    rows.push({ key: k, label: k.startsWith('obj:') ? 'Removed cast member' : k, source: 'No longer in this shot', color: '#8A8A8A', text: o.text, autoText: '', fullText: '', policy: o.mode, basedOn: o.basedOn, at: o.at, active: false, status: 'orphan' });
  }
  return rows;
}
/** The text of applied rows, as the composed prompt joins them. */
export const sectionsText = rows => rows.filter(r => r.active && r.text).map(r => r.text).join(' ');
/** True when a source changed since an override or lock was made from it. */
export const sourceChanged = row => row.policy !== 'inherit' && !!row.basedOn && row.basedOn !== row.fullText && row.basedOn !== row.autoText;

// ---------- Versions of the final prompt ----------
export const MAX_PROMPT_VERSIONS = 40;
const REASONS = ['edit', 'lock', 'unlock', 'reset', 'undo', 'quote', 'generate', 'agent', 'model'];
/** One saved version of a shot's final prompt (exactly what was, or would be, sent). */
export function normalizePromptVersion(v) {
  if (!v || typeof v.text !== 'string' || !v.text.trim()) return null;
  return {
    id: typeof v.id === 'string' && /^[\w-]{4,40}$/.test(v.id) ? v.id : Math.random().toString(36).slice(2, 10),
    at: typeof v.at === 'string' && v.at ? v.at.slice(0, 40) : new Date().toISOString(),
    text: v.text.slice(0, 8000),
    model: typeof v.model === 'string' ? v.model.slice(0, 80) : '',
    reason: REASONS.includes(v.reason) ? v.reason : 'edit',
    by: ['you', 'claude', 'batch'].includes(v.by) ? v.by : 'you',
    note: typeof v.note === 'string' ? clean(v.note).slice(0, 160) : '',
    sections: Array.isArray(v.sections) ? v.sections.filter(x => x && KEY.test(x.key || '') && SECTION_POLICIES.includes(x.policy)).slice(0, 60).map(x => ({ key: x.key, policy: x.policy })) : [],
  };
}
/** The version list with `v` appended; a version identical to the newest (same text and model) is not repeated. */
export function appendPromptVersion(list, v) {
  const one = normalizePromptVersion(v), all = Array.isArray(list) ? list.map(normalizePromptVersion).filter(Boolean) : [];
  if (!one) return all;
  const last = all.at(-1);
  if (last && last.text === one.text && last.model === one.model) return all;
  return [...all, one].slice(-MAX_PROMPT_VERSIONS);
}
export function normalizePromptVersions(v) {
  const out = {};
  for (const kind of PROMPT_KINDS) { const list = Array.isArray(v?.[kind]) ? v[kind].map(normalizePromptVersion).filter(Boolean).slice(-MAX_PROMPT_VERSIONS) : []; if (list.length) out[kind] = list; }
  return out;
}

// ---------- Word diff ----------
const tokens = t => String(t || '').match(/\s+|[\p{L}\p{N}’'_-]+|[^\s\p{L}\p{N}]/gu) || [];
const MAX_CELLS = 2_500_000;
/**
 * Word-level diff of two prompts: [{ op: 'same' | 'add' | 'del', text }], with neighbouring parts of one kind merged.
 * Common start and end are matched first; a very large middle falls back to one delete plus one add.
 */
export function wordDiff(a, b) {
  const A = tokens(a), B = tokens(b);
  let pre = 0; while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0; while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a2 = A.slice(pre, A.length - suf), b2 = B.slice(pre, B.length - suf), n = a2.length, m = b2.length;
  const parts = [];
  const push = (op, text) => { if (!text) return; const last = parts.at(-1); if (last && last.op === op) last.text += text; else parts.push({ op, text }); };
  push('same', A.slice(0, pre).join(''));
  if ((n + 1) * (m + 1) > MAX_CELLS) { push('del', a2.join('')); push('add', b2.join('')); }
  else {
    // Longest common subsequence table, filled from the end so the walk below goes forward.
    const w = m + 1, L = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * w + j] = a2[i] === b2[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a2[i] === b2[j]) { push('same', a2[i]); i++; j++; }
      else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) push('del', a2[i++]);
      else push('add', b2[j++]);
    }
    while (i < n) push('del', a2[i++]);
    while (j < m) push('add', b2[j++]);
  }
  push('same', A.slice(A.length - suf).join(''));
  return tidy(parts);
}
/** A lone space matched between two changes reads better inside the change ("crane up" rather than "crane", " ", "up"); each run of changes is one delete then one add. */
function tidy(parts) {
  const out = [];
  let del = '', add = '';
  const flush = () => { if (del) out.push({ op: 'del', text: del }); if (add) out.push({ op: 'add', text: add }); del = add = ''; };
  parts.forEach((x, i) => {
    const between = x.op === 'same' && /^\s+$/.test(x.text) && i > 0 && i < parts.length - 1 && parts[i - 1].op !== 'same' && parts[i + 1].op !== 'same';
    if (between) { del += x.text; add += x.text; }
    else if (x.op === 'del') del += x.text;
    else if (x.op === 'add') add += x.text;
    else { flush(); out.push({ op: 'same', text: x.text }); }
  });
  flush();
  return out;
}
/** Counts of added and removed words in a diff. */
export function diffStats(parts) {
  const words = t => (t.match(/[\p{L}\p{N}]+/gu) || []).length;
  return { added: parts.filter(p => p.op === 'add').reduce((a, p) => a + words(p.text), 0), removed: parts.filter(p => p.op === 'del').reduce((a, p) => a + words(p.text), 0) };
}
