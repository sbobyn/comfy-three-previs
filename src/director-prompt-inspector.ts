// Prompt inspector (Shot → Video): the final prompt a model receives, section by section, from the same assembly that
// generation sends (shared/prompt-plan.mjs). Each section shows where its words come from and its policy; composed sections
// can be overridden, locked, left out or reset, saved on the shot and undoable. System rules (the camera line, reference
// legend, still guide rules) are shown with what changes them. A version history diffs any two final prompts or takes.
// Model settings: what the shot's video and still models accept, their registry parameters and the estimate, saved per shot.
import './director-prompt-inspector.css';
import type { DirectorProject, Shot } from '../shared/director.mjs';
import type { PromptPlan, PlanRow } from '../shared/prompt-plan.mjs';
import { SECTION_GROUPS, promptHistory, comparePrompts } from '../shared/prompt-plan.mjs';
import { mergePromptSections } from '../shared/prompt-sections.mjs';
import type { ParamSpec } from '../shared/model-params.mjs';
import { videoParamSpecs, imageParamSpecs, resolveVideoParams, resolveImageParams, videoCapabilities, videoEstimate, imageEstimate, settingsApply, SEED_MAX } from '../shared/model-params.mjs';
import { resolveFrame } from '../shared/keyframes.mjs';
import { h, toast } from './director-common';

type Kind = 'video' | 'image';
type Entry = { label: string; redo: unknown[]; undo: unknown[] };
export type InspectorCtx = {
  project(): DirectorProject;
  runEntry(e: Entry): Promise<unknown>;
  edit(ops: unknown[]): Promise<unknown>;
  select(id: string): void;
  /** The plan generation would send now: video for the shot's model, image for its still model at shot time t. Null while models load. */
  plan(kind: Kind, p: DirectorProject, s: Shot, t: number): PromptPlan | null;
  playhead(): number;
  refresh(): void;
};

let kind: Kind = 'video';
let at: 'start' | 'here' | 'end' = 'start';
let editing: string | null = null;
let from = '', to = 'current';
const POLICY_LABEL: Record<string, string> = { inherit: 'Inherit', override: 'Override', lock: 'Locked', system: 'Rule' };
const STATUS_LABEL: Record<string, string> = { included: '', shortened: 'Shortened', omitted: 'Left out', removed: 'Removed', cut: 'Cut to fit', orphan: 'Not sent' };
// The encoded blockout frame a still there is made from (shared/keyframes.mjs): End is the last frame, as the storyboard sends it.
const timeOf = (s: Shot, ctx: InspectorCtx) => resolveFrame(ctx.project(), s, { at: at === 'here' ? ctx.playhead() : at }).t;

/** Save one section's policy (null = inherit) with a prompt version, undoable. */
async function setSection(s: Shot, ctx: InspectorCtx, plan: PromptPlan, key: string, value: { mode: 'override' | 'lock'; text: string; basedOn?: string } | null, label: string, reason: string) {
  const p = ctx.project(), t = timeOf(s, ctx), before = s.promptSections?.[kind]?.[key] ?? null;
  const next = structuredClone(p), ns = next.shots.find(x => x.id === s.id)!;
  const stamped = value ? { ...value, at: new Date().toISOString() } : null;
  ns.promptSections = mergePromptSections(ns.promptSections, { [kind]: { [key]: stamped } }) as Shot['promptSections'];
  const after = ctx.plan(kind, next, ns, t);
  const version = (x: PromptPlan | null, why: string) => (x ? [{ op: 'record_prompt_version', shotId: s.id, kind, version: { text: x.text, model: x.model, reason: why, by: 'you', sections: x.sections.filter(r => !r.system).map(r => ({ key: r.key, policy: r.policy })) } }] : []);
  await ctx.runEntry({ label, redo: [{ op: 'update_shot', id: s.id, patch: { promptSections: { [kind]: { [key]: stamped } } } }, ...version(after, reason)], undo: [{ op: 'update_shot', id: s.id, patch: { promptSections: { [kind]: { [key]: before } } } }, ...version(plan, 'undo')] });
  editing = null; ctx.refresh();
}

function rowEl(r: PlanRow, s: Shot, ctx: InspectorCtx, plan: PromptPlan) {
  const controls = plan.mode === 'sections' && r.editable && r.status !== 'orphan';
  const status = STATUS_LABEL[r.status];
  const head = h('div', { class: 'pi-rowhead' },
    h('i', { class: 'pi-dot', style: `--c:${r.color}`, 'aria-hidden': 'true' }),
    h('b', {}, r.label),
    h('span', { class: `pi-policy is-${r.policy}`, title: r.system ? 'A system rule: it follows the model and the blockout' : r.policy === 'lock' ? 'Frozen: never dropped to fit, edits refused until unlocked' : r.policy === 'override' ? 'Your text replaces the source' : 'Comes live from its source' }, POLICY_LABEL[r.policy]),
    status ? h('span', { class: `pi-status is-${r.status}`, title: r.why || '' }, status) : null,
    r.cameraWords ? h('span', { class: 'pi-status is-camera', title: 'The blockout is the camera; these words contradict it' }, `Camera words: ${r.cameraWords.join(', ')}`) : null);
  const objId = r.key.startsWith('obj:') ? r.key.slice(4) : null;
  const source = h('div', { class: 'pi-source' }, 'From ', objId ? h('button', { class: 'linklike', type: 'button', onclick: () => ctx.select(objId) }, r.source) : r.source,
    r.changes ? h('span', { class: 'pi-changes' }, ` · ${r.changes}`) : null);
  let body: Node;
  if (editing === r.key) {
    const ta = h('textarea', { class: 'field pi-edit', rows: 3, 'aria-label': `${r.label} text` }, r.text);
    const save = h('button', { class: 'btn sm primary', type: 'button', onclick: () => void setSection(s, ctx, plan, r.key, { mode: r.policy === 'lock' ? 'lock' : 'override', text: ta.value, basedOn: r.autoText }, `Override ${r.label}`, 'edit') }, 'Save override');
    body = h('div', { class: 'pi-editor' }, ta, h('div', { class: 'ap-actions' }, save, h('button', { class: 'btn sm ghost', type: 'button', onclick: () => { editing = null; ctx.refresh(); } }, 'Cancel'),
      r.autoText && r.autoText !== r.text ? h('span', { class: 'note' }, 'Source text: ', h('q', {}, r.autoText)) : null));
    requestAnimationFrame(() => ta.focus());
  } else body = h('div', { class: 'pi-text' + (r.status === 'omitted' || r.status === 'orphan' || r.status === 'removed' ? ' is-out' : '') }, r.text || h('em', {}, 'Left out of the prompt'));
  const actions = controls && editing !== r.key ? h('div', { class: 'pi-actions' },
    r.policy !== 'lock' ? h('button', { class: 'btn sm ghost', type: 'button', onclick: () => { editing = r.key; ctx.refresh(); } }, r.policy === 'override' ? 'Edit' : 'Override') : null,
    r.policy === 'lock'
      ? h('button', { class: 'btn sm ghost', type: 'button', title: 'Unlock: an edited text stays as an override; an unedited one follows its source again', onclick: () => void setSection(s, ctx, plan, r.key, r.text !== r.autoText ? { mode: 'override', text: r.text, basedOn: r.autoText } : null, `Unlock ${r.label}`, 'unlock') }, 'Unlock')
      : h('button', { class: 'btn sm ghost', type: 'button', title: 'Freeze this text: source changes and length fitting never drop it', onclick: () => void setSection(s, ctx, plan, r.key, { mode: 'lock', text: r.text, basedOn: r.autoText }, `Lock ${r.label}`, 'lock') }, 'Lock'),
    r.policy === 'inherit' && r.status !== 'omitted' ? h('button', { class: 'btn sm ghost', type: 'button', title: 'Leave this section out of the prompt', onclick: () => void setSection(s, ctx, plan, r.key, { mode: 'override', text: '', basedOn: r.autoText }, `Leave out ${r.label}`, 'edit') }, 'Leave out') : null,
    r.policy === 'override' ? h('button', { class: 'btn sm ghost', type: 'button', title: 'Back to the source text', onclick: () => void setSection(s, ctx, plan, r.key, null, `Reset ${r.label}`, 'reset') }, r.status === 'removed' ? 'Restore' : 'Reset') : null) : null;
  return h('div', { class: `pi-row is-${r.status}${r.system ? ' is-system' : ''}`, style: `--c:${r.color}`, 'data-key': r.key },
    head, source, body,
    r.sourceChanged ? h('p', { class: 'pi-warn' }, 'The source changed since you set this. ', controls ? h('button', { class: 'linklike', type: 'button', onclick: () => void setSection(s, ctx, plan, r.key, null, `Reset ${r.label}`, 'reset') }, 'Use the new source text') : null) : null,
    r.why && r.status !== 'included' ? h('p', { class: 'note pi-why' }, r.why) : null,
    actions);
}

/** The plan's sections grouped (shot, cast, style, camera rules, model-specific). Read-only when `ctx` is null. */
export function planSections(plan: PromptPlan, s: Shot | null = null, ctx: InspectorCtx | null = null) {
  const groups = (Object.keys(SECTION_GROUPS) as (keyof typeof SECTION_GROUPS)[]).map(g => [g, plan.sections.filter(r => r.group === g)] as const).filter(([, rows]) => rows.length);
  return h('div', { class: 'pi-groups' }, ...groups.map(([g, rows]) => h('section', { class: 'pi-group', 'aria-label': SECTION_GROUPS[g] },
    h('div', { class: 'pi-ghead' }, SECTION_GROUPS[g]),
    ...rows.map(r => (s && ctx ? rowEl(r, s, ctx, plan) : h('div', { class: `pi-row is-${r.status}${r.system ? ' is-system' : ''}`, style: `--c:${r.color}` },
      h('div', { class: 'pi-rowhead' }, h('i', { class: 'pi-dot', 'aria-hidden': 'true' }), h('b', {}, r.label), h('span', { class: `pi-policy is-${r.policy}` }, POLICY_LABEL[r.policy]), STATUS_LABEL[r.status] ? h('span', { class: `pi-status is-${r.status}`, title: r.why || '' }, STATUS_LABEL[r.status]) : null),
      h('div', { class: 'pi-source' }, 'From ', r.source), h('div', { class: 'pi-text' }, r.text)))))));
}

function diffView(parts: { op: string; text: string }[]) {
  return h('div', { class: 'pi-diff', tabindex: 0, role: 'region', 'aria-label': 'Word differences' }, ...parts.map(x => (x.op === 'same' ? document.createTextNode(x.text) : h(x.op === 'add' ? 'ins' : 'del', {}, x.text))));
}

function historyEl(s: Shot, ctx: InspectorCtx, plan: PromptPlan) {
  const p = ctx.project(), hist = promptHistory(p, s, kind);
  const all = [...hist.versions.slice().reverse(), ...hist.takes.slice().reverse()];
  const valid = (id: string) => id === 'current' || all.some(x => x.id === id);
  if (!valid(from)) from = (hist.versions.slice().reverse().find(v => v.text !== plan.text) || hist.takes.at(-1) || hist.versions.at(-1))?.id || '';
  if (!valid(to)) to = 'current';
  const pick = (value: string, label: string, set: (v: string) => void) => {
    const sel = h('select', { class: 'field pi-pick', 'aria-label': label },
      h('option', { value: 'current', selected: value === 'current' }, 'Current final prompt'),
      hist.versions.length ? h('optgroup', { label: 'Versions' }, ...hist.versions.slice().reverse().map(v => h('option', { value: v.id, selected: v.id === value }, `${v.label} · ${v.at.slice(5, 16).replace('T', ' ')}`))) : null,
      hist.takes.length ? h('optgroup', { label: kind === 'video' ? 'Video takes' : 'Still takes' }, ...hist.takes.slice().reverse().map(x => h('option', { value: x.id, selected: x.id === value }, x.label))) : null);
    sel.onchange = () => { set(sel.value); ctx.refresh(); };
    return sel;
  };
  let out: Node = h('p', { class: 'note' }, all.length ? 'Choose two prompts to compare.' : 'No saved versions or takes yet. A version is saved when you change a section or prepare a quote; each take keeps the prompt it was made with.');
  if (from && valid(from)) {
    try {
      const c = comparePrompts(p, s, kind, from, to, plan.text);
      out = c.same ? h('p', { class: 'note' }, 'These two prompts are identical.') : h('div', {}, h('p', { class: 'note pi-diffstat' }, `+${c.added} words · −${c.removed} words`), diffView(c.diff));
    } catch (e) { out = h('p', { class: 'status-line err' }, (e as Error).message); }
  }
  const save = h('button', { class: 'btn sm ghost', type: 'button', title: 'Keep the current final prompt as a version', onclick: () => void ctx.edit([{ op: 'record_prompt_version', shotId: s.id, kind, version: { text: plan.text, model: plan.model, reason: 'edit', by: 'you' } }]).then(() => { toast('Version saved'); ctx.refresh(); }) }, 'Save version');
  return h('details', { class: 'pi-history', open: true },
    h('summary', {}, `History · ${hist.versions.length} version${hist.versions.length === 1 ? '' : 's'} · ${hist.takes.length} take${hist.takes.length === 1 ? '' : 's'}`),
    h('div', { class: 'pi-pickrow' }, pick(from, 'Compare from', v => { from = v; }), h('span', { 'aria-hidden': 'true' }, '→'), pick(to, 'Compare to', v => { to = v; }), save),
    out);
}

/** The prompt inspector block for one shot. */
export function promptInspectorBlock(s: Shot, ctx: InspectorCtx) {
  const p = ctx.project(), t = timeOf(s, ctx), plan = ctx.plan(kind, p, s, t);
  const tabs = h('div', { class: 'seg', role: 'tablist', 'aria-label': 'Prompt to inspect' }, ...(['video', 'image'] as const).map(k => h('button', { type: 'button', role: 'tab', class: k === kind ? 'on' : '', 'aria-selected': String(k === kind), onclick: () => { kind = k; editing = null; from = ''; ctx.refresh(); } }, k === 'video' ? 'Video' : 'Still')));
  const atRow = kind === 'image' ? h('div', { class: 'seg pi-at', role: 'group', 'aria-label': 'Still moment' }, ...(['start', 'here', 'end'] as const).map(k => h('button', { type: 'button', class: k === at ? 'on' : '', 'aria-pressed': String(k === at), onclick: () => { at = k; ctx.refresh(); } }, k === 'start' ? 'Start' : k === 'end' ? 'End' : `At ${(Math.round(ctx.playhead() * 100) / 100).toFixed(2)}s`))) : null;
  const head = h('div', { class: 'block-head' }, h('span', { class: 'eyebrow' }, 'Prompt inspector'), h('span', { style: 'flex:1' }), atRow, tabs);
  if (!plan) return h('div', { class: 'block pi' }, head, h('p', { class: 'note' }, 'Loading models…'));
  const facts = [plan.model || 'Model', `${plan.length.toLocaleString('en-US')}${plan.maxLength ? ` / ${plan.maxLength.toLocaleString('en-US')}` : ''} characters`, plan.overrides ? `${plan.overrides} override${plan.overrides > 1 ? 's' : ''}` : '', plan.locks ? `${plan.locks} locked` : '', plan.sections.filter(r => r.status === 'omitted' || r.status === 'cut').length ? `${plan.sections.filter(r => r.status === 'omitted' || r.status === 'cut').length} left out` : ''].filter(Boolean);
  const modeNote = plan.mode === 'edit' ? 'Your whole-prompt edit (Prompt block) is in use, so section controls are paused. Regenerate → Replace with new returns to the composed prompt.'
    : plan.mode === 'compiled' ? 'The shot has no composed prompt, so the compiled prompt with numbered references is sent.' : '';
  const copy = h('button', { class: 'btn sm ghost', type: 'button', onclick: () => void navigator.clipboard.writeText(plan.text).then(() => toast('Final prompt copied')) }, 'Copy');
  return h('div', { class: 'block pi', 'data-kind': kind },
    head,
    h('p', { class: 'pi-facts' }, ...facts.flatMap((f, i) => [i ? h('span', { class: 'pi-sep', 'aria-hidden': 'true' }, '·') : null, h('span', {}, f)])),
    // PV-02: the auto-prompt's length cap is per model and a rule of thumb; say so where it shapes the text.
    plan.kind === 'video' && plan.mode === 'sections' && plan.autoPromptCap ? h('p', { class: 'note pi-cap' }, `The auto-prompt aims for about ${plan.autoPromptCap.toLocaleString('en-US')} characters for this model. That cap is a heuristic, not a measured optimum.`) : null,
    plan.cameraLabel ? h('p', { class: 'note pi-cam' }, `${plan.cameraLabel}. Video prompts name no camera move: the camera rule below says which input to follow.`) : null,
    modeNote ? h('p', { class: 'pi-mode' }, modeNote) : null,
    plan.cameraWarning ? h('p', { class: 'status-line err pi-camwarn', role: 'status' }, plan.cameraWarning) : null,
    planSections(plan, s, ctx),
    h('details', { class: 'pi-final', open: true }, h('summary', {}, 'Final request · exactly what is sent'), h('pre', { tabindex: 0, role: 'region', 'aria-label': 'Final prompt text' }, plan.text), h('div', { class: 'ap-actions' }, copy)),
    historyEl(s, ctx, plan));
}

// ---------- Model settings ----------
type VideoDef = Parameters<typeof videoCapabilities>[0];
type StillPreset = { id: string; title: string; maxRefs?: number; pricing?: { usdPerImage?: number | null } };
export type SettingsCtx = InspectorCtx & { videoDef(s: Shot): VideoDef | null; stillPresets(): StillPreset[]; stillModel(s: Shot): string; stillRefs(s: Shot, presetId: string): number };

const usd = (x: number | null | undefined) => (x == null ? 'unpriced' : x === 0 ? 'free (local)' : `≈ $${x.toFixed(x < 1 ? 3 : 2)}`);
function seedControl(value: number | null, label: string, onSave: (v: number | null) => void, fallback?: unknown) {
  const input = h('input', { class: 'field pi-num', type: 'number', min: 0, max: SEED_MAX, step: 1, value: value ?? '', placeholder: fallback != null ? `Preset (${fallback})` : 'Random', 'aria-label': label });
  const commit = () => { const v = input.value.trim() === '' ? null : Math.round(Number(input.value)); if (v !== null && !(v >= 0 && v <= SEED_MAX)) { toast(`Seed must be 0–${SEED_MAX}`, true); return; } if (v !== value) onSave(v); };
  input.onchange = commit;
  return h('span', { class: 'pi-ctl' }, input, h('button', { class: 'btn sm ghost', type: 'button', title: 'A new random seed, saved on the shot', onclick: () => onSave(Math.floor(Math.random() * 1e6)) }, 'Random'), value != null ? h('button', { class: 'btn sm ghost', type: 'button', onclick: () => onSave(null) }, 'Clear') : null);
}
function paramRow(spec: ParamSpec, current: unknown, saved: boolean, onSave: (v: unknown) => void, auto?: unknown) {
  let ctl: Node;
  if (!spec.editable) ctl = h('span', { class: 'pi-fixed' }, typeof spec.value === 'boolean' ? (spec.value ? 'On' : 'Off') : String(spec.value));
  else if (spec.key === 'seed') ctl = seedControl(saved ? (current as number) : null, spec.label, v => onSave(v), spec.value);
  else if (spec.type === 'enum') {
    const sel = h('select', { class: 'field pi-sel', 'aria-label': spec.label }, ...(auto !== undefined ? [h('option', { value: '', selected: !saved }, `Auto · ${auto}${spec.unit ? ` ${spec.unit}` : ''}`)] : []), ...(spec.options || []).map(o => h('option', { value: String(o), selected: saved && o === current }, `${o}${spec.unit ? ` ${spec.unit}` : ''}`)));
    sel.onchange = () => onSave(sel.value === '' ? null : Number(sel.value));
    ctl = sel;
  } else {
    const input = h('input', { class: 'field pi-num', type: 'number', min: spec.min, max: spec.max, step: 1, value: saved ? String(current) : '', placeholder: `Preset (${spec.value})`, 'aria-label': spec.label });
    input.onchange = () => onSave(input.value.trim() === '' ? null : Math.round(Number(input.value)));
    ctl = input;
  }
  return h('div', { class: 'pi-param' + (spec.editable ? '' : ' is-fixed') }, h('span', { class: 'pi-plabel' }, spec.label, spec.costs ? h('small', { title: 'Changes the price' }, ' $') : null), ctl, h('small', { class: 'pi-pnote' }, spec.note));
}

/** What the shot's video and still models accept, their settings from the registry, and the estimate; saved on the shot. */
export function modelSettingsBlock(s: Shot, ctx: SettingsCtx) {
  const def = ctx.videoDef(s);
  const saveKind = (k: Kind, next: { model?: string; params?: Record<string, unknown> } | null, label: string) =>
    ctx.runEntry({ label, redo: [{ op: 'update_shot', id: s.id, patch: { settings: { [k]: next } } }], undo: [{ op: 'update_shot', id: s.id, patch: { settings: { [k]: s.settings?.[k] ?? null } } }] }).then(() => ctx.refresh());
  const withParam = (k: Kind, model: string, cur: Record<string, unknown>, key: string, v: unknown) => { const params = { ...cur }; if (v === null) delete params[key]; else params[key] = v; return saveKind(k, { model, params }, `${k === 'video' ? 'Video' : 'Still'} ${key}`); };

  let video: Node = h('p', { class: 'note' }, 'Loading models…');
  if (def) {
    const cap = videoCapabilities(def), applies = settingsApply(s.settings?.video?.model, def), cur = (applies ? s.settings?.video?.params : null) || {};
    const r = resolveVideoParams(def, s), seconds = r.seconds ?? s.render?.duration ?? s.duration, est = videoEstimate(def, seconds);
    const chips = [cap.cameraSource === 'blockout' ? 'Follows the blockout clip' : cap.cameraSource === 'keyframes' ? 'Start → end stills' : 'One start still', cap.inputs.referenceImages ? `Up to ${cap.inputs.referenceImages} cast images` : 'No cast images', cap.promptMaxLength ? `Prompt ≤ ${cap.promptMaxLength.toLocaleString('en-US')} chars` : null, cap.clipLengths ? `Clips ${cap.clipLengths.join('/')} s` : cap.sourceDuration ? `Source ${cap.sourceDuration.min}–${Math.floor(cap.sourceDuration.max)} s` : null, cap.local ? 'Your GPU · free' : cap.ratePerSecond ? `$${cap.ratePerSecond.toFixed(3)}/s list` : 'Unpriced'].filter(Boolean) as string[];
    video = h('div', { class: 'pi-model' },
      h('div', { class: 'pi-mhead' }, h('b', {}, def.title || def.id), h('span', { class: 'pi-est' }, `${usd(est)} for ${seconds} s`)),
      h('div', { class: 'pi-chips' }, ...chips.map(c => h('span', { class: 'chip' }, c))),
      ...videoParamSpecs(def, s).map(spec => paramRow(spec, cur[spec.key], spec.key in r.applied, v => void withParam('video', def.id, cur, spec.key, v), spec.key === 'duration' ? (def.task === 'first-frame' ? resolveVideoParams(def, s, null).seconds : undefined) : undefined)),
      r.ignored.length ? h('p', { class: 'pi-warn' }, `Saved ${r.ignored.join(', ')} ${r.ignored.length > 1 ? 'are' : 'is'} not valid for this model and is not sent.`) : null,
      cap.priceSource ? h('p', { class: 'note pi-psrc', title: cap.priceSource }, `List price checked ${cap.priceCheckedAt || ''}; every run shows its quote first.`) : null);
  }

  const presets = ctx.stillPresets(), stillId = ctx.stillModel(s), preset = presets.find(x => x.id === stillId);
  const ip = resolveImageParams(stillId, s), savedImage = s.settings?.image?.model === stillId || !s.settings?.image?.model ? s.settings?.image?.params || {} : {};
  const refs = ctx.stillRefs(s, stillId), est = imageEstimate(stillId, { count: ip.count, refs: refs + 1 });
  const model = h('select', { class: 'field pi-sel', 'aria-label': 'Still model for this shot' }, ...(presets.length ? presets : [{ id: stillId, title: stillId }]).map(x => h('option', { value: x.id, selected: x.id === stillId }, `${x.title}${x.pricing?.usdPerImage ? ` · ≈ $${x.pricing.usdPerImage.toFixed(3)}/image` : ''}`)));
  model.onchange = () => void saveKind('image', { model: model.value, params: {} }, 'Still model');
  const still = h('div', { class: 'pi-model' },
    h('div', { class: 'pi-mhead' }, h('b', {}, 'Stills'), h('span', { class: 'pi-est' }, est ? `${usd(est.expectedUsd)} for ${ip.count} take${ip.count > 1 ? 's' : ''}${est.refsUsd ? ` (incl. $${est.refsUsd.toFixed(3)} for ${refs + 1} input images)` : ''}` : 'unpriced')),
    h('div', { class: 'pi-param' }, h('span', { class: 'pi-plabel' }, 'Model'), model, h('small', { class: 'pi-pnote' }, 'The storyboard composer, Claude and the batch (when it uses this model) start from it.')),
    ...imageParamSpecs(preset || null).map(spec => paramRow(spec, savedImage[spec.key], spec.key in savedImage, v => void withParam('image', stillId, savedImage, spec.key, v))));

  const saved = !!(s.settings?.video || s.settings?.image);
  return h('div', { class: 'block pi pi-settings' },
    h('div', { class: 'block-head' }, h('span', { class: 'eyebrow' }, 'Model settings'), h('span', { class: 'muted', style: 'font-size:11.5px' }, 'Saved on this shot'), h('span', { style: 'flex:1' }),
      saved ? h('button', { class: 'btn sm ghost', type: 'button', title: 'Clear this shot’s saved models and settings', onclick: () => void ctx.runEntry({ label: 'Reset model settings', redo: [{ op: 'update_shot', id: s.id, patch: { settings: null } }], undo: [{ op: 'update_shot', id: s.id, patch: { settings: s.settings ?? null } }] }).then(() => ctx.refresh()) }, 'Reset') : null),
    video, still,
    h('p', { class: 'note', style: 'margin:0' }, 'Settings marked $ change the price. Resolution, sound and model version stay fixed until they are priced. The server checks every value against the model’s live schema when it quotes.'));
}
