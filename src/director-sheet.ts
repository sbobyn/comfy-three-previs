// Design sheet: consistent views of one scene object (turnarounds, headshots, expressions, details,
// establishing views). Every view is its own refgen request from the object's primary image (image 1),
// generated one at a time on the shared backend. Attempts are kept per slot; "selected" is what the
// slot shows, "accepted" (kept ✓) is what the sheet uses, so a retry never silently replaces kept work.
// The sheet itself is composed in the browser (no charge) and can be attached as the object's image.
import './director-sheet.css';
import { objectLooks, objectNotes, castCard } from '../shared/director.mjs';
import type { DirectorProject, Entity, Reference } from '../shared/director.mjs';
import { setsFor, setDef, planSlots, slotAspect, slotLayout, viewPrompt, editViewPrompt, slotPick, EXPRESSION_PACKS, INTENSITIES, ANGLE_LABELS, anglesFor, FRAMINGS, MAX_SHEET_SLOTS } from '../shared/sheet-presets.mjs';
import type { Sheet, SheetSlot, SheetAttempt, PlannedSlot } from '../shared/sheet-presets.mjs';
import { KIND_COLORS } from '../shared/prompt.mjs';
import { api, h, toast } from './director-common';
import { progressSlot } from './director-progress'; // [live-progress]
import { composeSheet, canvasBlob } from './director-sheet-compose';
import type { ComposeOptions } from './director-sheet-compose';

type Preset = { id: string; title: string; backend: string; maxRefs?: number; pricing?: { usdPerImage?: number | null } };
type RefgenState = { presets: Preset[]; jobs: any[]; paidExecutionEnabled: boolean; cloudCredential: boolean };
export type SheetCtx = {
  projectId: string;
  project(): DirectorProject;
  apply(p: DirectorProject): void;
  refgen(): RefgenState;
  loadRefgen(): Promise<void>;
};

let ctx: SheetCtx;
export function initSheets(c: SheetCtx) { ctx = c; }

type Ui = { mode: 'plan' | 'sheet'; sheetId: string | null; setId: string; options: Record<string, any>; presetId: string; focus: string | null; retry: string; edit: string };
const uis: Record<string, Ui> = {};
const sections = new Map<string, HTMLElement>();
type Live = { phase: 'queued' | 'preparing' | 'waiting' | 'generating' | 'failed'; message: string };
const live = new Map<string, Live>(); // `${sheetId}:${slotId}`
type Task = { entityId: string; sheetId: string; slotId: string; mode: 'generate' | 'retry' | 'edit'; note: string; from: string | null; presetId: string };
const queue: Task[] = [];
let running = false, stopAfterCurrent = false, presetsRequested = false;

const P = () => ctx.project();
const ent = (id: string) => P().scene.entities.find(e => e.id === id) || null;
const refById = (id: string | null) => (id ? (P().scene.references || []).find(r => r.id === id) || null : null);
const refUrl = (r: Reference) => `/director-refs/${P().id}/${r.file}`;
const keyOf = (sheetId: string, slotId: string) => `${sheetId}:${slotId}`;
const rid = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const imagePresets = () => ctx.refgen().presets.filter(p => p.backend === 'cloud' && (p.maxRefs ?? 0) > 0);
const usdPer = (presetId: string) => ctx.refgen().presets.find(p => p.id === presetId)?.pricing?.usdPerImage ?? null;
const money = (n: number) => `$${n < 0.1 ? n.toFixed(3) : n.toFixed(2)}`;
const est = (presetId: string, n: number) => { const u = usdPer(presetId); return u == null ? '' : `≈ ${money(u * n)}`; };
const jobOf = (requestId: string | null) => (requestId ? ctx.refgen().jobs.find(j => j.id === requestId) : null);

function uiFor(e: Entity): Ui {
  const sets = setsFor(e.kind);
  const u = uis[e.id] ||= { mode: e.sheets?.length ? 'sheet' : 'plan', sheetId: e.sheets?.[e.sheets.length - 1]?.id ?? null, setId: sets[0].id, options: { ...(sets[0].options || {}) }, presetId: localStorage.getItem('previs.sheet.model') || 'flux-2-pro', focus: null, retry: '', edit: '' };
  if (!sets.some(s => s.id === u.setId)) { u.setId = sets[0].id; u.options = { ...(sets[0].options || {}) }; }
  if (u.mode === 'sheet' && !e.sheets?.some(s => s.id === u.sheetId)) { u.sheetId = e.sheets?.[e.sheets.length - 1]?.id ?? null; if (!u.sheetId) u.mode = 'plan'; }
  const models = imagePresets();
  if (models.length && !models.some(p => p.id === u.presetId)) u.presetId = models.find(p => p.id === 'flux-2-pro')?.id || models[0].id;
  return u;
}

// ---------- Persistence: entity.sheets via update_entity, one write at a time ----------
let writes = Promise.resolve();
function mutate(entityId: string, fn: (sheets: Sheet[]) => void) {
  const next = writes.then(async () => {
    const e = ent(entityId); if (!e) throw Error('That object was removed');
    const sheets = structuredClone(e.sheets || []) as Sheet[];
    fn(sheets);
    const r = await api('director/edit', { projectId: ctx.projectId, ops: [{ op: 'update_entity', id: entityId, patch: { sheets } }] });
    ctx.apply(r.project);
    redraw(); // the object pane skips re-rendering while focus is inside it
  });
  writes = next.catch(() => {});
  return next;
}
const findSlot = (sheets: Sheet[], sheetId: string, slotId: string) => sheets.find(s => s.id === sheetId)?.slots.find(x => x.id === slotId) || null;

// ---------- Slot state ----------
type SlotState = 'planned' | 'queued' | 'running' | 'failed' | 'uncertain' | 'done';
function slotState(sheet: Sheet, s: SheetSlot): { state: SlotState; message: string; shown: SheetAttempt | null } {
  const l = live.get(keyOf(sheet.id, s.id));
  const shown = s.attempts.find(a => a.id === s.selected) || s.attempts[s.attempts.length - 1] || null;
  if (l && l.phase !== 'failed') return { state: l.phase === 'queued' ? 'queued' : 'running', message: l.message, shown };
  if (l?.phase === 'failed') return { state: 'failed', message: l.message, shown };
  if (!shown) return { state: 'planned', message: 'Planned', shown };
  if (shown.referenceId) return { state: 'done', message: '', shown };
  if (shown.error) return { state: 'failed', message: shown.error, shown };
  const job = jobOf(shown.requestId);
  if (!job) { refreshJobs(); return { state: 'running', message: 'Checking request…', shown }; } // e.g. started by Claude
  if (job.status === 'completed') return { state: 'running', message: 'Finishing…', shown };
  if (job.status === 'submitted') return { state: 'running', message: 'Generating on Comfy Cloud…', shown };
  if (job.status === 'uncertain') return { state: 'uncertain', message: job.message, shown };
  if (job.status === 'quoted') return { state: 'failed', message: 'Prepared but never sent. Nothing was charged.', shown };
  return { state: 'failed', message: job.message || job.status, shown };
}

// Requests started outside this page (Claude's generate_sheet) appear once the job list is reloaded.
let lastJobsLoad = 0;
function refreshJobs() { if (Date.now() - lastJobsLoad < 5000) return; lastJobsLoad = Date.now(); setTimeout(() => void ctx.loadRefgen().then(redraw).catch(() => {}), 0); }

// ---------- Runner: one view at a time; only "another request is running" is waited on ----------
function enqueue(tasks: Task[]) {
  for (const t of tasks) { queue.push(t); live.set(keyOf(t.sheetId, t.slotId), { phase: 'queued', message: 'Queued' }); }
  stopAfterCurrent = false; redraw(); void run();
}
async function run() {
  if (running) return; running = true;
  try {
    while (queue.length && !stopAfterCurrent) {
      const t = queue.shift()!;
      const ok = await runTask(t).catch(err => { live.set(keyOf(t.sheetId, t.slotId), { phase: 'failed', message: (err as Error).message }); return true; });
      if (!ok) break; // backend uncertain: stop the batch, nothing is resent
    }
  } finally {
    for (const t of queue.splice(0)) live.delete(keyOf(t.sheetId, t.slotId));
    running = false; stopAfterCurrent = false;
    await ctx.loadRefgen().catch(() => {}); redraw();
  }
}
const setLive = (t: Task, phase: Live['phase'], message: string) => { live.set(keyOf(t.sheetId, t.slotId), { phase, message }); redraw(); };

/** Returns false when the batch must stop (an uncertain dispatch). */
async function runTask(t: Task): Promise<boolean> {
  const e = ent(t.entityId); if (!e) throw Error('That object was removed');
  const sheet = e.sheets?.find(s => s.id === t.sheetId), s = sheet?.slots.find(x => x.id === t.slotId);
  if (!sheet || !s) { live.delete(keyOf(t.sheetId, t.slotId)); return true; }
  const p = P(), identity = objectLooks(p, e.id)[0] || null;
  const card = castCard(p, e.id);
  const preset = ctx.refgen().presets.find(x => x.id === t.presetId);
  const from = t.mode === 'edit' ? s.attempts.find(a => a.id === t.from) : null;
  const fromRef = from ? refById(from.referenceId) : null;
  if (t.mode === 'edit' && !fromRef) throw Error('That image is no longer attached to this object');
  if (t.mode !== 'edit' && !identity) throw Error('Give this object a primary image first');
  const referenceIds = t.mode === 'edit' ? [fromRef!.id, ...(identity && identity.id !== fromRef!.id && (preset?.maxRefs ?? 0) > 1 ? [identity.id] : [])] : [identity!.id];
  const prompt = t.mode === 'edit'
    ? editViewPrompt({ kind: e.kind, instruction: t.note, styleNotes: card?.styleNotes, projectStyle: p.scene.environment.style, hasIdentity: referenceIds.length > 1 })
    : viewPrompt({ kind: e.kind, spec: s.spec as any, description: objectNotes(p, e), styleNotes: card?.styleNotes, projectStyle: p.scene.environment.style, note: t.note });
  const seed = Math.floor(Math.random() * 1e9);
  setLive(t, 'preparing', 'Preparing the request…');
  const { job } = await api('director/refgen/prepare', { projectId: ctx.projectId, entityId: e.id, presetId: t.presetId, prompt, aspect: slotAspect(s.spec as any, e.kind), count: 1, seed, referenceIds, sheet: { sheetId: sheet.id, slotId: s.id, label: s.label + (t.mode === 'edit' ? ' · edit' : '') } });
  const attempt: SheetAttempt = { id: rid(), requestId: job.id, referenceId: null, mode: t.mode, note: t.note.slice(0, 300), from: t.from, presetId: t.presetId, seed, error: '', createdAt: new Date().toISOString() };
  await mutate(e.id, sheets => { const x = findSlot(sheets, sheet.id, s.id); if (x) { x.attempts.push(attempt); x.selected = attempt.id; x.attempts = x.attempts.slice(-12); } });
  const fail = async (message: string) => { await mutate(e.id, sheets => { const a = findSlot(sheets, sheet.id, s.id)?.attempts.find(y => y.id === attempt.id); if (a) a.error = message.slice(0, 300); }); live.delete(keyOf(t.sheetId, t.slotId)); };
  // Submit. The click on Generate is the approval for this request at its quoted estimate.
  const max = Math.max(0.25, Math.ceil(((job.quote?.estimate ?? 0.2) * 2) * 100) / 100);
  let sent: any = null;
  for (let waited = 0; ; waited += 5) {
    if (stopAfterCurrent && waited) { await fail('Stopped before sending. Nothing was charged.'); return true; }
    try { sent = (await api('director/refgen/submit', { projectId: ctx.projectId, requestId: job.id, approval: { approved: true, fingerprint: job.fingerprint, allowance: { currency: 'USD', maxAmount: max, allowUnknownCharges: true } } })).job; break; }
    catch (err) {
      const msg = (err as Error).message;
      if (!/Another request on this backend/.test(msg) || waited > 900) { await fail(msg); return true; }
      setLive(t, 'waiting', 'Waiting for the image model…'); await sleep(5000);
    }
  }
  if (sent.status === 'uncertain') { await fail(sent.message); toast('Dispatch outcome unknown — the batch stopped. Nothing is resent.', true); return false; }
  setLive(t, 'generating', `Generating with ${preset?.title.split(' (')[0] || t.presetId}…`);
  await ctx.loadRefgen().catch(() => {});
  const t0 = Date.now();
  let done = sent;
  while (done.status === 'submitted' && Date.now() - t0 < 10 * 60_000) { await sleep(4000); done = (await api('director/refgen/track', { projectId: ctx.projectId, requestId: job.id }).catch(() => ({ job: done }))).job; }
  if (done.status === 'completed' && done.referenceIds?.[0]) {
    await mutate(e.id, sheets => { const a = findSlot(sheets, sheet.id, s.id)?.attempts.find(y => y.id === attempt.id); if (a) a.referenceId = done.referenceIds[0]; });
    live.delete(keyOf(t.sheetId, t.slotId));
  } else if (done.status === 'submitted') { live.delete(keyOf(t.sheetId, t.slotId)); toast(`${s.label}: still generating; it will appear when it finishes.`); }
  else await fail(done.message || `Request ${done.status}`);
  return true;
}

/** Attempts whose request finished while the page was closed: attach the image or keep tracking. */
const reconciling = new Set<string>();
async function reconcile(e: Entity) {
  for (const sheet of e.sheets || []) for (const s of sheet.slots) for (const a of s.attempts) {
    if (a.referenceId || a.error || !a.requestId || live.has(keyOf(sheet.id, s.id)) || reconciling.has(a.id)) continue;
    let job = jobOf(a.requestId); if (!job || !['submitted', 'completed'].includes(job.status)) continue;
    reconciling.add(a.id);
    try {
      if (job.status === 'submitted' && !running) job = (await api('director/refgen/track', { projectId: ctx.projectId, requestId: job.id })).job;
      if (job.status === 'completed' && job.referenceIds?.[0]) await mutate(e.id, sheets => { const x = findSlot(sheets, sheet.id, s.id)?.attempts.find(y => y.id === a.id); if (x) x.referenceId = job.referenceIds[0]; });
    } catch {} finally { reconciling.delete(a.id); }
  }
}

// ---------- Actions ----------
async function createSheet(e: Entity, u: Ui) {
  const set = setDef(u.setId)!; const planned = planSlots(u.setId, e.kind, u.options);
  if (!planned.length) { toast('Nothing to generate — pick at least one option', true); return; }
  if ((e.sheets || []).length >= 8) { toast('This object already has 8 sets. Remove one first.', true); return; }
  const id = 's' + rid();
  const label = u.setId === 'expressions' ? `Expressions · ${EXPRESSION_PACKS.find(p => p.id === u.options.pack)?.label || ''}` : u.setId === 'custom' ? planned[0].label : set.label;
  const sheet: Sheet = { id, setId: u.setId, label, options: structuredClone(u.options), presetId: u.presetId, createdAt: new Date().toISOString(), slots: planned.map(p => ({ ...p, attempts: [], selected: null, accepted: null })) };
  await mutate(e.id, sheets => { sheets.push(sheet); });
  u.mode = 'sheet'; u.sheetId = id; u.focus = null;
  enqueue(planned.map(p => ({ entityId: e.id, sheetId: id, slotId: p.id, mode: 'generate', note: '', from: null, presetId: u.presetId })));
}
const missingSlots = (sheet: Sheet) => sheet.slots.filter(s => { const st = slotState(sheet, s).state; return st === 'planned' || (st === 'failed' && !s.attempts.some(a => a.referenceId)); });
async function toggleAccept(e: Entity, sheet: Sheet, s: SheetSlot, attemptId: string) {
  await mutate(e.id, sheets => { const x = findSlot(sheets, sheet.id, s.id); if (x) x.accepted = x.accepted === attemptId ? null : attemptId; }).catch(err => toast((err as Error).message, true));
}
async function selectAttempt(e: Entity, sheet: Sheet, s: SheetSlot, attemptId: string) {
  await mutate(e.id, sheets => { const x = findSlot(sheets, sheet.id, s.id); if (x) x.selected = attemptId; }).catch(() => {});
}
async function makePrimary(e: Entity, referenceId: string) {
  try { const r = await api('director/edit', { projectId: ctx.projectId, ops: [{ op: 'set_look', entityId: e.id, referenceId }] }); ctx.apply(r.project); redraw(); toast(`Primary image for ${e.name} updated`); }
  catch (err) { toast((err as Error).message, true); }
}
// Styled yes/no in the workspace's delete-dialog pattern.
function confirmDialog(title: string, body: string, ok: string): Promise<boolean> {
  return new Promise(resolve => {
    let yes = false;
    const okBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => { yes = true; dlg.close(); } }, ok);
    const dlg = h('dialog', { class: 'confirm', 'aria-labelledby': 'ds-confirm-title' }, h('div', { class: 'dialog-body' },
      h('h2', { id: 'ds-confirm-title', style: 'margin:0;font-size:15px' }, title),
      h('p', { class: 'muted', style: 'margin:0' }, body),
      h('div', { style: 'display:flex;gap:8px;justify-content:flex-end' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel'), okBtn)));
    dlg.addEventListener('close', () => { dlg.remove(); resolve(yes); });
    document.body.append(dlg); dlg.showModal(); okBtn.focus();
  });
}
async function removeSheet(e: Entity, sheet: Sheet) {
  if (!await confirmDialog(`Remove the set “${sheet.label}”?`, `Its images stay on ${e.name}.`, 'Remove set')) return;
  for (const s of sheet.slots) { const k = keyOf(sheet.id, s.id); if (live.get(k)?.phase === 'queued') { live.delete(k); const i = queue.findIndex(t => t.sheetId === sheet.id && t.slotId === s.id); if (i >= 0) queue.splice(i, 1); } }
  await mutate(e.id, sheets => { const i = sheets.findIndex(x => x.id === sheet.id); if (i >= 0) sheets.splice(i, 1); }).catch(err => toast((err as Error).message, true));
  const u = uiFor(e); u.sheetId = null; u.focus = null;
}

// ---------- Rendering ----------
function redraw() { for (const [id, el] of sections) if (el.isConnected) draw(id); }

/** The Design sheet block for the object editor. Kept alive across pane re-renders. */
export function sheetSection(e: Entity): HTMLElement {
  let el = sections.get(e.id);
  if (!el) { el = h('div', { class: 'block ds', 'data-entity': e.id }); sections.set(e.id, el); }
  if (!ctx.refgen().presets.length && !presetsRequested) { presetsRequested = true; void ctx.loadRefgen(); }
  draw(e.id); void reconcile(e);
  return el;
}

function draw(entityId: string) {
  const el = sections.get(entityId), e = ent(entityId); if (!el || !e) return;
  // Keep typing intact across live progress updates.
  const active = el.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
  const activeKey = active?.dataset.key, sel = active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement ? [active.selectionStart, active.selectionEnd] : null;
  const u = uiFor(e);
  el.style.setProperty('--kind', KIND_COLORS[e.kind as keyof typeof KIND_COLORS] || 'var(--accent)');
  const sheets = e.sheets || [];
  const tabs = h('div', { class: 'ds-tabs', role: 'tablist', 'aria-label': 'Sets' },
    ...sheets.map(sh => {
      const done = sh.slots.filter(s => slotPick(s)).length, busy = sh.slots.some(s => live.has(keyOf(sh.id, s.id)));
      const on = u.mode === 'sheet' && u.sheetId === sh.id;
      return h('button', { type: 'button', role: 'tab', 'aria-selected': String(on), class: 'ds-tab' + (on ? ' on' : '') + (busy ? ' busy' : ''), onclick: () => { u.mode = 'sheet'; u.sheetId = sh.id; u.focus = null; draw(e.id); } },
        h('span', {}, sh.label), h('small', {}, `${done}/${sh.slots.length}`));
    }),
    h('button', { type: 'button', role: 'tab', 'aria-selected': String(u.mode === 'plan'), class: 'ds-tab new' + (u.mode === 'plan' ? ' on' : ''), onclick: () => { u.mode = 'plan'; draw(e.id); } }, '＋ New set'));
  const sheet = u.mode === 'sheet' ? sheets.find(s => s.id === u.sheetId) || null : null;
  el.replaceChildren(
    h('div', { class: 'block-head ds-head' }, h('span', { class: 'eyebrow' }, 'Design sheet'), h('span', { class: 'ds-sub' }, 'Every view from the primary image')),
    tabs,
    sheet ? sheetView(e, u, sheet) : planView(e, u));
  if (activeKey) { const again = el.querySelector<HTMLElement>(`[data-key="${activeKey}"]`); if (again) { again.focus({ preventScroll: true }); if (sel && (again instanceof HTMLTextAreaElement || again instanceof HTMLInputElement)) try { again.setSelectionRange(sel[0], sel[1]); } catch {} } }
}

function plannedGrid(e: Entity, planned: PlannedSlot[]) {
  return h('div', { class: 'ds-grid planned' }, ...planned.map(p => h('div', { class: 'ds-slot is-planned', style: `--ar:${slotAspect(p.spec, e.kind).replace(':', '/')}` },
    h('div', { class: 'ds-frame' }, h('span', { class: 'ds-ph' }, glyph(p.spec.angle))), h('div', { class: 'ds-label' }, p.label))));
}
const glyph = (angle: string) => ({ front: '◉', left: '◐', right: '◑', back: '○', 'front-left': '◔', 'front-right': '◕', 'back-left': '◌', 'back-right': '◌', top: '⊙' } as Record<string, string>)[angle] || '◉';

function identityRow(e: Entity) {
  const id = objectLooks(P(), e.id)[0];
  return h('div', { class: 'ds-identity' + (id ? '' : ' missing') },
    id ? h('img', { src: refUrl(id), alt: '' }) : h('span', { class: 'ds-noid' }, '!'),
    h('span', {}, id ? h('b', {}, 'Identity: primary image') : h('b', {}, 'No primary image yet'), h('br'), h('small', {}, id ? 'Sent as image 1 with the object’s description and style.' : 'Generate or upload an image above first — every view is drawn from it.')));
}

function modelPicker(u: Ui, onChange: () => void) {
  const models = imagePresets();
  const sel = h('select', { class: 'field', 'aria-label': 'Image model' }, ...(models.length ? models.map(p => h('option', { value: p.id, selected: p.id === u.presetId }, `${p.title.replace(' (BFL)', '')}${p.pricing?.usdPerImage != null ? ` · ≈ ${money(p.pricing.usdPerImage)}/image` : ''}`)) : [h('option', { value: '' }, 'Loading models…')]));
  sel.onchange = () => { u.presetId = sel.value; localStorage.setItem('previs.sheet.model', sel.value); onChange(); };
  return sel;
}

function optionControls(e: Entity, u: Ui) {
  const redraw1 = () => draw(e.id);
  const seg = (label: string, value: string, choices: [string, string][], set: (v: string) => void) => h('label', { class: 'ds-opt' }, h('span', {}, label),
    h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label }, ...choices.map(([v, t]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(v === value), class: v === value ? 'on' : '', onclick: () => { set(v); redraw1(); } }, t))));
  const o = u.options;
  if (u.setId === 'expressions') {
    const pack = EXPRESSION_PACKS.find(p => p.id === o.pack) || EXPRESSION_PACKS[0];
    return h('div', { class: 'ds-opts' },
      seg('Pack', pack.id, EXPRESSION_PACKS.map(p => [p.id, p.label]), v => { o.pack = v; }),
      pack.mouth ? null : h('label', { class: 'ds-opt' }, h('span', {}, 'Intensity'), h('div', { class: 'seg multi', role: 'group', 'aria-label': 'Intensity' }, ...Object.entries(INTENSITIES).map(([k, v]) => {
        const on = (o.intensities || []).includes(k);
        return h('button', { type: 'button', 'aria-pressed': String(on), class: on ? 'on' : '', onclick: () => { const list = new Set<string>(o.intensities || []); if (on) list.delete(k); else list.add(k); o.intensities = Object.keys(INTENSITIES).filter(x => list.has(x)); redraw1(); } }, v.label);
      }))),
      seg('Angle', o.angle || 'front', [['front', 'Front'], ['front-left', '¾'], ['both', 'Both']], v => { o.angle = v; }),
      h('p', { class: 'note' }, pack.hint));
  }
  if (u.setId === 'obj-turn4' || u.setId === 'obj-turn8') return h('div', { class: 'ds-opts' }, h('label', { class: 'check-row ds-check' }, h('input', { type: 'checkbox', checked: !!o.top, onchange: (ev: Event) => { o.top = (ev.target as HTMLInputElement).checked; redraw1(); } }), 'Add a top view'));
  if (u.setId === 'custom') {
    const name = h('input', { class: 'field', maxlength: 40, placeholder: 'Name, e.g. “Seated”', value: o.label || '', 'data-key': 'custom-label' });
    name.oninput = () => { o.label = name.value; };
    name.onchange = redraw1;
    const dir = h('textarea', { class: 'field', rows: 2, maxlength: 300, placeholder: e.kind === 'character' ? 'Describe the view: “sitting on a crate, looking up”' : 'Describe the view: “low angle, dramatic, from below”', 'data-key': 'custom-dir' }, o.direction || '');
    dir.oninput = () => { o.direction = dir.value; };
    const angles = Object.keys(anglesFor(e.kind)).filter(a => e.kind !== 'character' || a !== 'top');
    const framings = e.kind === 'character' ? ['full', 'bust', 'head'] : e.kind === 'environment' ? ['wide'] : ['whole', 'detail'];
    return h('div', { class: 'ds-opts' }, h('label', { class: 'ds-opt' }, h('span', {}, 'Name'), name),
      e.kind === 'environment' ? null : h('div', { class: 'grid2' },
        h('label', {}, 'Angle', h('select', { class: 'field', onchange: (ev: Event) => { o.angle = (ev.target as HTMLSelectElement).value; redraw1(); } }, ...angles.map(a => h('option', { value: a, selected: a === (o.angle || 'front') }, ANGLE_LABELS[a] || a)))),
        h('label', {}, 'Framing', h('select', { class: 'field', onchange: (ev: Event) => { o.framing = (ev.target as HTMLSelectElement).value; redraw1(); } }, ...framings.map(f => h('option', { value: f, selected: f === (o.framing || framings[0]) }, FRAMINGS[f].label))))),
      h('label', { class: 'ds-opt' }, h('span', {}, 'Direction'), dir));
  }
  return null;
}

function planView(e: Entity, u: Ui) {
  const sets = setsFor(e.kind);
  const planned = planSlots(u.setId, e.kind, u.options);
  const n = planned.length, identity = objectLooks(P(), e.id)[0];
  const st = ctx.refgen();
  const blocked = !identity ? 'Needs a primary image' : !st.paidExecutionEnabled ? 'Paid generation is off on this server' : !st.cloudCredential ? 'Cloud key not configured' : !imagePresets().length ? 'Loading models…' : n > MAX_SHEET_SLOTS ? `At most ${MAX_SHEET_SLOTS} views` : !n ? 'Pick at least one option' : '';
  const go = h('button', { class: 'btn cta ds-go', type: 'button', disabled: !!blocked, title: blocked || `Generates ${n} images, one at a time` }, n ? `Generate ${n} view${n === 1 ? '' : 's'}` : 'Generate', h('span', { class: 'ds-cost' }, est(u.presetId, n)));
  go.onclick = () => { go.disabled = true; void createSheet(e, u).catch(err => { toast((err as Error).message, true); go.disabled = false; }); };
  return h('div', { class: 'ds-body' },
    h('div', { class: 'ds-sets', role: 'radiogroup', 'aria-label': 'Set' }, ...sets.map(s => {
      const count = planSlots(s.id, e.kind, s.id === u.setId ? u.options : s.options || {}).length;
      return h('button', { type: 'button', role: 'radio', 'aria-checked': String(s.id === u.setId), class: 'ds-set' + (s.id === u.setId ? ' on' : ''), onclick: () => { if (u.setId !== s.id) { u.setId = s.id; u.options = structuredClone(s.options || {}); } draw(e.id); } },
        h('b', {}, s.label), h('small', {}, s.hint), h('span', { class: 'ds-n' }, `${count}`));
    })),
    optionControls(e, u),
    plannedGrid(e, planned),
    identityRow(e),
    h('div', { class: 'ds-foot' },
      h('label', { class: 'ds-opt grow' }, h('span', {}, 'Model'), modelPicker(u, () => draw(e.id))),
      h('div', { class: 'ds-total' }, h('span', {}, `${n} image${n === 1 ? '' : 's'} × ${usdPer(u.presetId) != null ? `≈ ${money(usdPer(u.presetId)!)}` : '?'}`), h('b', {}, est(u.presetId, n) || 'cost unknown'))),
    h('div', { class: 'ds-actions' }, go, blocked ? h('span', { class: 'note' }, blocked) : h('span', { class: 'note' }, 'One request per view, sent one at a time. Each finished view is added to this object’s images.')));
}

function sheetView(e: Entity, u: Ui, sheet: Sheet) {
  const states = sheet.slots.map(s => ({ s, ...slotState(sheet, s) }));
  const done = states.filter(x => slotPick(x.s)).length, kept = sheet.slots.filter(s => s.accepted).length;
  const missing = missingSlots(sheet).filter(s => !live.has(keyOf(sheet.id, s.id)));
  const busy = states.some(x => x.state === 'queued' || x.state === 'running');
  const st = ctx.refgen();
  const canPay = st.paidExecutionEnabled && st.cloudCredential && !!objectLooks(P(), e.id)[0];
  const grid = h('div', { class: 'ds-grid' }, ...states.map(({ s, state, message, shown }) => {
    const ref = refById(shown?.referenceId ?? null);
    const accepted = !!s.accepted && s.accepted === shown?.id, isPrimary = !!ref && e.look === ref.id;
    const removed = state === 'done' && !ref;
    return h('button', { type: 'button', class: `ds-slot is-${removed ? 'failed' : state}${accepted ? ' is-accepted' : ''}${u.focus === s.id ? ' focus' : ''}`, style: `--ar:${slotAspect(s.spec as any, e.kind).replace(':', '/')}`, 'aria-label': `${s.label}: ${removed ? 'image removed' : state}`, onclick: () => { u.focus = u.focus === s.id ? null : s.id; draw(e.id); } },
      h('div', { class: 'ds-frame' },
        ref && state !== 'running' && state !== 'queued' ? h('img', { src: refUrl(ref), alt: '', loading: 'lazy' }) : h('span', { class: 'ds-ph' }, state === 'failed' || state === 'uncertain' ? '!' : glyph(s.spec.angle)),
        state === 'running' || state === 'queued' ? h('span', { class: 'ds-status' }, message) : null,
        state === 'failed' || state === 'uncertain' || removed ? h('span', { class: 'ds-status bad' }, removed ? 'Image removed' : state === 'uncertain' ? 'Outcome unknown' : 'Failed') : null,
        accepted ? h('span', { class: 'ds-badge ok', title: 'Kept: used on the sheet' }, '✓') : null,
        isPrimary ? h('span', { class: 'ds-badge star', title: 'Primary image' }, '★') : null,
        s.attempts.length > 1 ? h('span', { class: 'ds-badge n' }, `×${s.attempts.length}`) : null),
      h('div', { class: 'ds-label' }, s.label));
  }));
  const focus = sheet.slots.find(s => s.id === u.focus) || null;
  const genMissing = h('button', { class: 'btn sm', type: 'button', disabled: !canPay || !missing.length, onclick: () => enqueue(missing.map(s => ({ entityId: e.id, sheetId: sheet.id, slotId: s.id, mode: 'generate', note: '', from: null, presetId: u.presetId }))) }, `Generate missing (${missing.length})`, missing.length ? h('span', { class: 'ds-cost' }, est(u.presetId, missing.length)) : null);
  return h('div', { class: 'ds-body' },
    h('div', { class: 'ds-bar' },
      h('span', { class: 'ds-progress' }, h('b', {}, `${done}/${sheet.slots.length}`), ' views', kept ? ` · ${kept} kept` : ''),
      busy ? h('button', { class: 'btn sm ghost', type: 'button', disabled: stopAfterCurrent, title: 'Finish the view being generated, then stop. Nothing already sent is cancelled.', onclick: () => { stopAfterCurrent = true; draw(e.id); } }, stopAfterCurrent ? 'Stopping…' : 'Stop after this view') : missing.length ? genMissing : null,
      h('button', { class: 'btn sm primary', type: 'button', disabled: !done, onclick: () => openCompose(e, sheet.id) }, 'Compose sheet…'),
      h('button', { class: 'btn sm ghost icon', type: 'button', title: 'Remove this set (images stay on the object)', 'aria-label': 'Remove set', onclick: () => void removeSheet(e, sheet) }, '✕')),
    grid,
    focus ? slotDetail(e, u, sheet, focus) : h('p', { class: 'note ds-hint' }, done ? 'Click a view to keep it, retry it or edit it.' : 'Views appear here as they finish.'),
    busy ? null : h('div', { class: 'ds-foot' }, h('label', { class: 'ds-opt grow' }, h('span', {}, 'Model for retries'), modelPicker(u, () => draw(e.id)))));
}

function slotDetail(e: Entity, u: Ui, sheet: Sheet, s: SheetSlot) {
  const { state, message, shown } = slotState(sheet, s);
  const ref = refById(shown?.referenceId ?? null);
  const busy = state === 'queued' || state === 'running';
  const st = ctx.refgen();
  const canPay = st.paidExecutionEnabled && st.cloudCredential;
  const idx = shown ? s.attempts.indexOf(shown) + 1 : 0;
  const job = jobOf(shown?.requestId ?? null);
  const retryNote = h('textarea', { class: 'field', rows: 2, maxlength: 300, placeholder: 'Optional extra direction: “arms at sides”, “hair tucked behind ear”…', 'aria-label': 'Extra direction for the retry', 'data-key': `retry-${s.id}` }, u.retry);
  retryNote.oninput = () => { u.retry = retryNote.value; };
  const editNote = h('textarea', { class: 'field', rows: 2, maxlength: 300, placeholder: 'What to change: “close the jacket”, “make the logo larger”…', 'aria-label': 'What to change in this image', 'data-key': `edit-${s.id}` }, u.edit);
  editNote.oninput = () => { u.edit = editNote.value; editBtn.disabled = busy || !canPay || !ref || !editNote.value.trim(); };
  const task = (mode: Task['mode'], note: string, from: string | null): Task => ({ entityId: e.id, sheetId: sheet.id, slotId: s.id, mode, note, from, presetId: u.presetId });
  const retryBtn = h('button', { class: 'btn sm', type: 'button', disabled: busy || !canPay || !objectLooks(P(), e.id)[0], onclick: () => { const note = u.retry.trim(); u.retry = ''; enqueue([task('retry', note, null)]); } }, 'Retry from the primary image', h('span', { class: 'ds-cost' }, est(u.presetId, 1)));
  const editBtn = h('button', { class: 'btn sm', type: 'button', disabled: busy || !canPay || !ref || !u.edit.trim(), onclick: () => { const note = u.edit.trim(); u.edit = ''; enqueue([task('edit', note, shown!.id)]); } }, 'Edit this image', h('span', { class: 'ds-cost' }, est(u.presetId, 1)));
  const accepted = !!shown && s.accepted === shown.id;
  return h('div', { class: 'ds-detail' },
    h('div', { class: 'ds-detail-head' }, h('b', {}, s.label), h('span', { class: 'muted' }, shown ? `attempt ${idx} of ${s.attempts.length}${shown.mode !== 'generate' ? ` · ${shown.mode}` : ''}` : 'not generated yet'), h('button', { class: 'btn ghost sm icon', type: 'button', 'aria-label': 'Close', onclick: () => { u.focus = null; draw(e.id); } }, '✕')),
    ref && !busy ? h('a', { class: 'ds-big', href: refUrl(ref), target: '_blank', rel: 'noopener', title: 'Open full size' }, h('img', { src: refUrl(ref), alt: `${s.label} view` })) : null,
    busy || state === 'failed' || state === 'uncertain' ? h('div', { class: 'status-line' + (busy ? '' : ' err') }, message) : null,
    (busy || state === 'uncertain') && shown?.requestId ? progressSlot(ctx.projectId, 'refgen', shown.requestId, `${e.name} · ${s.label}`, 'sheet') : null, // [live-progress]
    s.attempts.length ? h('div', { class: 'ds-attempts', role: 'listbox', 'aria-label': 'Attempts' }, ...s.attempts.map((a, i) => {
      const r = refById(a.referenceId), on = shown?.id === a.id;
      return h('button', { type: 'button', role: 'option', 'aria-selected': String(on), class: 'ds-att' + (on ? ' on' : '') + (s.accepted === a.id ? ' kept' : ''), title: `Attempt ${i + 1}${a.mode !== 'generate' ? ` (${a.mode}${a.note ? `: ${a.note}` : ''})` : ''}`, onclick: () => void selectAttempt(e, sheet, s, a.id) },
        r ? h('img', { src: refUrl(r), alt: '' }) : h('span', {}, a.error ? '!' : '…'), s.accepted === a.id ? h('i', {}, '✓') : null);
    })) : null,
    ref && !busy ? h('div', { class: 'ds-row' },
      h('button', { class: 'btn sm' + (accepted ? ' ds-kept' : ''), type: 'button', 'aria-pressed': String(accepted), title: accepted ? 'Kept views are used on the sheet; retries never replace them' : 'Keep this attempt for the sheet', onclick: () => void toggleAccept(e, sheet, s, shown!.id) }, accepted ? '✓ Kept' : 'Keep'),
      e.look === ref.id ? h('span', { class: 'ds-primary' }, '★ Primary image') : h('button', { class: 'btn sm ghost', type: 'button', title: 'The primary image is the one video models receive', onclick: () => void makePrimary(e, ref.id) }, '★ Make primary'),
      s.accepted && !accepted ? h('span', { class: 'note' }, 'Another attempt is kept') : null) : null,
    h('div', { class: 'ds-redo' },
      h('div', { class: 'ds-redo-col' }, h('span', { class: 'ds-redo-t' }, 'Retry', h('small', {}, 'new image from the primary image')), retryNote, retryBtn),
      h('div', { class: 'ds-redo-col' }, h('span', { class: 'ds-redo-t' }, 'Edit', h('small', {}, 'change this attempt, keep the rest')), editNote, editBtn)),
    job?.prompt ? h('details', { class: 'ds-prompt' }, h('summary', {}, 'Prompt sent'), h('pre', {}, job.prompt)) : null);
}

// ---------- Compose (browser canvas, no charge) ----------
const composeOpts: Record<string, ComposeOptions & { sets: string[] }> = {};
function openCompose(e: Entity, sheetId: string) {
  document.getElementById('ds-compose')?.remove();
  const usable = (e.sheets || []).filter(sh => sh.slots.some(s => slotPick(s)));
  const first = usable.find(s => s.id === sheetId) || usable[0];
  const o = composeOpts[e.id] ||= { layout: setDef(first.setId)?.layout || 'turnaround', name: true, labels: true, swatches: true, sameScale: true, sets: [first.id] };
  o.sets = o.sets.filter(id => usable.some(s => s.id === id)); if (!o.sets.length) o.sets = [first.id];
  let canvas: HTMLCanvasElement | null = null, token = 0;
  const preview = h('div', { class: 'ds-preview' }, h('span', { class: 'muted' }, 'Composing…'));
  const status = h('div', { class: 'status-line' });
  const primaryBox = h('input', { type: 'checkbox', checked: true });
  const items = () => usable.filter(sh => o.sets.includes(sh.id)).flatMap(sh => sh.slots.map(s => ({ s, a: slotPick(s) })).filter(x => x.a && refById(x.a.referenceId)).map(x => ({ src: refUrl(refById(x.a!.referenceId)!), label: x.s.label, layout: slotLayout(x.s.spec as any) })));
  const render = async () => {
    const my = ++token; preview.classList.add('busy');
    try {
      const list = items(); if (!list.length) { preview.replaceChildren(h('span', { class: 'muted' }, 'Choose a set with finished views.')); canvas = null; return; }
      const id = objectLooks(P(), e.id)[0];
      const c = await composeSheet({ name: e.name, items: list, reference: id ? refUrl(id) : null, options: o });
      if (my !== token) return;
      canvas = c; c.className = 'ds-canvas'; preview.replaceChildren(c);
      dims.textContent = `${c.width} × ${c.height}px · ${list.length} view${list.length === 1 ? '' : 's'}`;
    } catch (err) { preview.replaceChildren(h('span', { class: 'status-line err' }, (err as Error).message)); }
    finally { if (my === token) preview.classList.remove('busy'); }
  };
  const dims = h('span', { class: 'muted' });
  const seg = (k: 'layout', choices: [ComposeOptions['layout'], string][]) => h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Layout' }, ...choices.map(([v, t]) => h('button', { type: 'button', class: o[k] === v ? 'on' : '', onclick: (ev: Event) => { o[k] = v; (ev.currentTarget as HTMLElement).parentElement!.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === ev.currentTarget)); void render(); } }, t)));
  const toggle = (k: 'name' | 'labels' | 'swatches' | 'sameScale', text: string) => h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: o[k], onchange: (ev: Event) => { o[k] = (ev.target as HTMLInputElement).checked; void render(); } }), text);
  const fileName = `${e.name.replace(/[^\w.-]+/g, '-').replace(/-+/g, '-')}-sheet.png`;
  const download = h('button', { class: 'btn', type: 'button', onclick: async () => { if (!canvas) return; const url = URL.createObjectURL(await canvasBlob(canvas)); const a = h('a', { href: url, download: fileName }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000); } }, 'Download PNG');
  const attach = h('button', { class: 'btn cta', type: 'button' }, 'Use sheet as this object’s image');
  attach.onclick = async () => {
    if (!canvas) return; attach.disabled = true; status.className = 'status-line'; status.textContent = 'Attaching…';
    try {
      let blob = await canvasBlob(canvas);
      if (blob.size > 9.5 * 1024 * 1024) blob = await canvasBlob(canvas, 'image/jpeg', 0.92);
      const data = await new Promise<string>((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = () => rej(Error('Could not read the sheet')); fr.readAsDataURL(blob); });
      const r = await api('director/reference', { projectId: ctx.projectId, scope: 'object', entityId: e.id, name: `${e.name} · design sheet`, data, note: 'sheet:composed' });
      ctx.apply(r.project);
      if (primaryBox.checked) { const r2 = await api('director/edit', { projectId: ctx.projectId, ops: [{ op: 'set_look', entityId: e.id, referenceId: r.referenceId }] }); ctx.apply(r2.project); }
      status.className = 'status-line ok'; status.textContent = primaryBox.checked ? 'Attached and set as the primary image — video models now receive the whole sheet.' : 'Attached to the object’s images.';
    } catch (err) { status.className = 'status-line err'; status.textContent = (err as Error).message; }
    finally { attach.disabled = false; }
  };
  const dlg = h('dialog', { class: 'dialog ds-dialog', id: 'ds-compose', 'aria-labelledby': 'ds-compose-title' },
    h('div', { class: 'dialog-head' }, h('h2', { id: 'ds-compose-title' }, `Compose sheet · ${e.name}`), h('span', { class: 'note' }, 'Drawn in your browser — no charge'), h('button', { class: 'btn ghost sm icon', type: 'button', 'aria-label': 'Close', onclick: () => dlg.close() }, '✕')),
    h('div', { class: 'ds-compose' },
      h('div', { class: 'ds-compose-side' },
        h('div', { class: 'ds-opt' }, h('span', { class: 'eyebrow' }, 'Sets'), ...usable.map(sh => h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: o.sets.includes(sh.id), onchange: (ev: Event) => { const on = (ev.target as HTMLInputElement).checked; o.sets = on ? [...o.sets, sh.id] : o.sets.filter(x => x !== sh.id); void render(); } }), `${sh.label}`, h('small', { class: 'muted' }, ` ${sh.slots.filter(s => slotPick(s)).length} views`)))),
        h('div', { class: 'ds-opt' }, h('span', { class: 'eyebrow' }, 'Layout'), seg('layout', [['turnaround', 'Turnaround row'], ['full', 'Full sheet'], ['expressions', 'Grid']])),
        h('div', { class: 'ds-opt' }, h('span', { class: 'eyebrow' }, 'Show'), toggle('name', 'Name label'), toggle('labels', 'View labels'), toggle('swatches', 'Colour swatches'), toggle('sameScale', 'Same scale')),
        h('p', { class: 'note' }, 'Kept ✓ views are used; slots without a kept view use the attempt they show.'),
        h('div', { class: 'ds-compose-actions' }, attach, h('label', { class: 'check-row' }, primaryBox, 'Make it the primary image'), download, status),
        h('p', { class: 'note' }, 'A turnaround sheet as the only image suits video models that take few images.')),
      h('div', { class: 'ds-compose-main' }, preview, dims)));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg); dlg.showModal(); void render();
}
