// Look presets near the shot's generate controls (docs/look-presets.md): time of day, weather, season, lighting mood, wardrobe
// and art style as selects for this shot or the project default, subject swaps, and single-axis variants of the shot with
// their price before anything is made. A variant shows which one attribute differs from its base ("Night (vs base)").
import './director-look-presets.css';
import { h, api, toast } from './director-common';
import type { DirectorProject, Shot } from '../shared/director.mjs';
import { castRows } from '../shared/director.mjs';
import { LOOK_AXES, presetOf, normalizeLook, effectiveLook, lookLabels, baseShotOf, variantLabel, variantLooks, variantModels, lookDiff, NO_BRANDS_NEGATIVE } from '../shared/look-presets.mjs';
import type { Look, LookAxisId } from '../shared/look-presets.mjs';
import { estimateBreakdown, estimateFor, maxRefsFor } from '../shared/tiers.mjs';

export type LookCtx = {
  project: () => DirectorProject;
  runEntry: (e: { label: string; redo: unknown[]; undo: unknown[] }) => Promise<unknown>;
  edit: (ops: unknown[]) => Promise<unknown>;
  refresh: () => void;
  selectShot: (id: string) => void;
  /** False when the server has no Comfy Cloud key: quoting and making variants cannot run. */
  cloudKey?: () => boolean;
};

let scope: 'shot' | 'project' = 'shot';
const picks = new Map<string, Partial<Record<LookAxisId, string[]>>>();
let combine = false, quoting = false;
let quote: { shotId: string; key: string; estimateUsd: number; reserveUsd: number; rows: { label: string; existing?: boolean }[]; why?: string } | null = null;

const NO_KEY_TITLE = 'Add a Comfy Cloud key first';
const money = (x: number) => `$${x.toFixed(2)}`;
const round = (x: number) => Math.round(x * 100) / 100;

/** What one variant of `s` costs at list price: an edit of the base still, and its video (same blockout clip). */
function variantPrice(p: DirectorProject, s: Shot, look: Look) {
  const m = variantModels(p, s, look);
  const cast = castRows(p, s).filter(r => r.inCast && r.entity.kind !== 'environment').length;
  const refs = 1 + Math.min(Math.max(0, maxRefsFor(m.still) - 1), cast + (m.styleRef ? 1 : 0));
  const still = estimateBreakdown('still', m.still, { refs, marginPct: 0 })?.expectedUsd ?? 0;
  const video = estimateFor('video', m.video, { duration: s.duration }) ?? 0;
  return { still, video, models: m };
}

export function lookPresetsBlock(s: Shot, ctx: LookCtx) {
  const p = ctx.project(), base = baseShotOf(p, s), eff = effectiveLook(p, s);
  const own = normalizeLook(scope === 'shot' ? s.look : p.look), def = normalizeLook(p.look);
  const setLook = (next: Look, label: string) => {
    const clean = normalizeLook(next);
    if (scope === 'project') void ctx.runEntry({ label, redo: [{ op: 'set_project', patch: { look: clean } }], undo: [{ op: 'set_project', patch: { look: normalizeLook(p.look) } }] });
    else void ctx.runEntry({ label, redo: [{ op: 'update_shot', id: s.id, patch: { look: clean } }], undo: [{ op: 'update_shot', id: s.id, patch: { look: normalizeLook(s.look) } }] });
  };

  // A variant: which attribute differs from its base, and a warning when it is more than one.
  const diff = base ? lookDiff(effectiveLook(p, base), eff) : [];
  const variantRow = base ? h('div', { class: 'lp-variant' + (diff.length > 1 ? ' warn' : '') },
    h('span', { class: 'lp-chip on', title: 'The one attribute this variant changes; everything else matches its base' }, variantLabel(p, effectiveLook(p, base), eff)),
    h('button', { class: 'linklike', type: 'button', onclick: () => ctx.selectShot(base.id) }, `Base: ${base.title}`),
    diff.length > 1 ? h('span', { class: 'lp-note' }, `Changes ${diff.length} attributes; a variant should change one`) : null) : null;

  // One select per axis: inherit (shot) / none (clear the default on this shot) / a preset.
  const selects = LOOK_AXES.map(a => {
    const value = own[a.id] ?? '';
    const inherited = scope === 'shot' && def[a.id] && def[a.id] !== 'none' ? ` (project: ${presetOf(a.id, def[a.id])?.label})` : '';
    const sel = h('select', { class: 'field lp-sel', 'aria-label': `${a.label} for ${scope === 'shot' ? 'this shot' : 'the project'}` },
      h('option', { value: '', selected: value === '' }, scope === 'shot' ? `—${inherited}` : '—'),
      ...(scope === 'shot' && def[a.id] ? [h('option', { value: 'none', selected: value === 'none' }, 'None on this shot')] : []),
      ...a.presets.map(x => h('option', { value: x.id, selected: value === x.id }, x.label))) as HTMLSelectElement;
    sel.onchange = () => { const next: Look = { ...own }; if (sel.value) (next as Record<string, string>)[a.id] = sel.value; else delete (next as Record<string, string>)[a.id]; setLook(next, `${a.label}: ${sel.value ? presetOf(a.id, sel.value)?.label || 'none' : 'default'}`); };
    return h('label', { class: 'lp-axis' }, h('span', {}, a.label), sel);
  });

  // Subject swaps (shot scope): what an object in the cast is, e.g. the eagle → a red-tailed hawk.
  // The shot's lead first: it is the usual subject to swap.
  const cast = castRows(p, s).filter(r => r.inCast && r.entity.kind !== 'environment').map(r => r.entity).sort((x, y) => Number(y.id === s.camera.target) - Number(x.id === s.camera.target));
  const swaps = Object.entries(own.subjects || {});
  const who = h('select', { class: 'field lp-sel', 'aria-label': 'Object to swap' }, ...cast.map(e => h('option', { value: e.id }, e.name))) as HTMLSelectElement;
  const what = h('input', { class: 'field', type: 'text', placeholder: 'e.g. a red-tailed hawk', 'aria-label': 'What it becomes', maxlength: '160' }) as HTMLInputElement;
  const swapRow = scope === 'shot' && cast.length ? h('div', { class: 'lp-swap' },
    h('span', { class: 'lp-k' }, 'Subject swap'), who, what,
    h('button', { class: 'btn sm', type: 'button', onclick: () => { if (what.value.trim()) setLook({ ...own, subjects: { ...(own.subjects || {}), [who.value]: what.value.trim() } }, 'Subject swap'); } }, 'Swap'),
    ...swaps.map(([id, t]) => h('span', { class: 'lp-chip on' }, `${p.scene.entities.find(e => e.id === id)?.name || 'Object'} → ${t}`,
      h('button', { class: 'lp-x', type: 'button', 'aria-label': 'Remove swap', onclick: () => { const subjects = { ...(own.subjects || {}) }; delete subjects[id]; setLook({ ...own, subjects }, 'Remove subject swap'); } }, '×')))) : null;

  // Variants: pick values per axis (each makes one single-axis variant), see the price, quote, then add and make them.
  const root = base || s, mine = picks.get(root.id) || {};
  const looks = (() => { try { return variantLooks(effectiveLook(p, root), mine, { combine }); } catch { return []; } })();
  const prices = looks.map(l => variantPrice(p, root, l));
  const stillUsd = round(prices.reduce((a, x) => a + x.still, 0)), videoUsd = round(prices.reduce((a, x) => a + x.video, 0));
  const key = JSON.stringify([root.id, mine, combine]);
  const toggle = (axis: LookAxisId, id: string) => {
    const cur = new Set(mine[axis] || []); if (cur.has(id)) cur.delete(id); else cur.add(id);
    picks.set(root.id, { ...mine, [axis]: [...cur] }); quote = null; ctx.refresh();
  };
  const chipRows = LOOK_AXES.map(a => h('div', { class: 'lp-row' }, h('span', { class: 'lp-k' }, a.label),
    ...a.presets.filter(x => x.id !== effectiveLook(p, root)[a.id]).map(x => h('button', { type: 'button', class: 'lp-chip' + ((mine[a.id] || []).includes(x.id) ? ' on' : ''), 'aria-pressed': String((mine[a.id] || []).includes(x.id)), onclick: () => toggle(a.id, x.id) }, x.label))));
  const variants = { shot: root.id, axes: mine, combine };
  const doQuote = async () => {
    quoting = true; ctx.refresh();
    try {
      const b = (await api<{ batch: any }>('director/batch', { projectId: p.id, dryRun: true, maxCostUsd: 100, variants })).batch;
      quote = { shotId: root.id, key, estimateUsd: b.estimateUsd, reserveUsd: b.reserveUsd, rows: b.variants.list.map((v: any) => ({ label: v.label, existing: v.existing })), why: b.variants.why };
    } catch (e) { toast((e as Error).message); } finally { quoting = false; ctx.refresh(); }
  };
  const doMake = async () => {
    if (!quote || quote.key !== key) return;
    if (!confirm(`Add ${quote.rows.length} variant${quote.rows.length === 1 ? '' : 's'} of “${root.title}” and make their stills and videos for about ${money(quote.estimateUsd)} (cap ${money(quote.reserveUsd)})?`)) return;
    try { await api('director/batch', { projectId: p.id, maxCostUsd: round(quote.reserveUsd + 0.01), variants }); toast('Variants added; the batch is running (Jobs).'); picks.delete(root.id); quote = null; }
    catch (e) { toast((e as Error).message); }
    ctx.refresh();
  };
  const addOnly = async () => { try { await ctx.edit([{ op: 'add_variants', shotId: root.id, axes: mine, combine }]); picks.delete(root.id); quote = null; ctx.refresh(); } catch (e) { toast((e as Error).message); } };
  const fresh = quote && quote.key === key, noKey = ctx.cloudKey?.() === false;
  const variantsBox = h('details', { class: 'lp-variants', open: looks.length > 0 || undefined },
    h('summary', {}, `Variants of ${base ? 'the base' : 'this shot'}`, h('span', { class: 'muted' }, looks.length ? ` · ${looks.length} · ≈ ${money(stillUsd + videoUsd)}` : ' · one change each')),
    h('p', { class: 'note' }, 'Each value makes one variant that changes only that attribute; the still is an edit of the base still, the video follows the same blockout.'),
    ...chipRows,
    h('label', { class: 'lp-combine', title: 'Every combination of the values picked, instead of one change each' }, h('input', { type: 'checkbox', checked: combine, onchange: (e: Event) => { combine = (e.target as HTMLInputElement).checked; quote = null; ctx.refresh(); } }), ' Combine (every combination)'),
    looks.length ? h('div', { class: 'lp-plan' },
      ...looks.map((l, i) => h('div', { class: 'lp-planrow' }, h('span', {}, variantLabel(p, effectiveLook(p, root), l)), h('span', { class: 'muted' }, `still ${money(prices[i].still)} · video ${money(prices[i].video)}`))),
      h('p', { class: 'note' }, prices[0]?.models.why || ''),
      noKey ? h('p', { class: 'note', role: 'note' }, 'Add a Comfy Cloud key in Setup to make variants. Add shots only works without one.') : null,
      h('div', { class: 'ap-actions' },
        h('button', { class: 'btn sm', type: 'button', disabled: quoting || noKey, title: noKey ? NO_KEY_TITLE : '', onclick: () => void doQuote() }, quoting ? 'Quoting…' : `Quote ${looks.length}`),
        h('button', { class: 'btn sm primary', type: 'button', disabled: !fresh || noKey, title: noKey ? NO_KEY_TITLE : fresh ? '' : 'Quote first', onclick: () => void doMake() }, fresh && !noKey ? `Add & make · ≈ ${money(quote!.estimateUsd)}` : 'Add & make'),
        h('button', { class: 'btn sm ghost', type: 'button', onclick: () => void addOnly(), title: 'Add the variant shots without generating anything' }, 'Add shots only'))) : null,
    fresh ? h('p', { class: 'note lp-quote' }, `Quote: ${quote!.rows.map(r => r.label + (r.existing ? ' (exists)' : '')).join(', ')} · ≈ ${money(quote!.estimateUsd)} expected, ${money(quote!.reserveUsd)} reserved.`) : null);

  const summary = lookLabels(p, eff).map(x => x.label).join(' · ') || 'As written (no presets)';
  return h('div', { class: 'block lp' },
    h('div', { class: 'block-head' }, h('span', { class: 'eyebrow' }, 'Look'), h('span', { class: 'muted', style: 'font-size:11.5px' }, summary)),
    variantRow,
    h('div', { class: 'lp-scope', role: 'group', 'aria-label': 'Apply presets to' },
      ...(['shot', 'project'] as const).map(k => h('button', { type: 'button', class: 'lp-seg' + (scope === k ? ' on' : ''), 'aria-pressed': String(scope === k), onclick: () => { scope = k; ctx.refresh(); } }, k === 'shot' ? 'This shot' : 'Project default'))),
    h('div', { class: 'lp-grid' }, ...selects),
    swapRow,
    h('p', { class: 'note lp-neg', title: 'Added to every preset look' }, NO_BRANDS_NEGATIVE),
    variantsBox);
}
