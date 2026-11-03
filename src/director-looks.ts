// Cast images board: every object's image in one place. Project-wide world and style notes, a card per
// object (its image, description and the shots it appears in), and one approved batch that generates
// cast images on Cloud for every selected object. Results attach to each object automatically.
import './director-looks.css';
import { objectLooks, lookPrompt, lookViews, shotCast, handleOf, lookSource } from '../shared/director.mjs';
import type { DirectorProject, Entity } from '../shared/director.mjs';
import { api, h, shapeIcon, toast, announce, refocus } from './director-common';
import { expectedUsd, isFree, submitImage, suggestedCap } from './director-spend';

type Preset = { id: string; title: string; backend: 'cloud' | 'local'; note: string };
export type LooksCtx = {
  project(): DirectorProject;
  edit(ops: unknown[]): Promise<unknown>;
  refgen(): { presets: Preset[]; jobs: any[]; paidExecutionEnabled: boolean; cloudCredential: boolean };
  reloadRefgen(): Promise<void>;
  openObject(id: string): void;
};
type Planned = { e: Entity; job: any | null; issue?: string };

const ASPECT: Record<string, string> = { full: '3:4', sheet: '16:9', face: '3:4', three: '4:3', side: '16:9', wide: '16:9', detail: '4:3' };
export const aspectFor = (e: Entity, view: string) => ASPECT[view] || (e.kind === 'character' ? '3:4' : e.kind === 'environment' ? '16:9' : '4:3');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export function openLooksBoard(ctx: LooksCtx) {
  document.getElementById('looks-dialog')?.remove();
  const P = ctx.project;
  const refUrl = (file: string) => `/director-refs/${P().id}/${file}`;
  const picked = new Set<string>();
  const views: Record<string, string> = {};
  let onlyMissing = false, busy = false, plan: Planned[] = [];

  const casts = P().shots.map(s => shotCast(P(), s));
  const shotsWith = (id: string) => P().shots.map((s, i) => ({ s, i })).filter(x => casts[x.i].some(c => c.entity.id === id));
  const prominent = (id: string) => casts.some(c => c.some(x => x.entity.id === id && (x.lead || x.coverage >= 0.15)));

  // ---------- World & style ----------
  const world = h('textarea', { class: 'field', rows: 2, maxlength: 500, placeholder: 'Where and when: “a desert highway at golden hour, heat haze”' }, P().scene.environment.description || '');
  const style = h('textarea', { class: 'field', rows: 2, maxlength: 500, placeholder: 'Look of the film: “35 mm anamorphic, teal-and-orange grade, light grain, photoreal”' }, P().scene.environment.style || '');
  const saveScene = async () => { try { await ctx.edit([{ op: 'set_scene', patch: { environment: { description: world.value, style: style.value } } }]); draw(); } catch {} };
  world.onchange = style.onchange = () => void saveScene();

  // ---------- Toolbar ----------
  const presetSel = h('select', { class: 'field', 'aria-label': 'Image model' });
  const fillPresets = () => {
    const list = ctx.refgen().presets, keep = [presetSel.value, localStorage.getItem('previs.looks.model'), 'flux-3'].find(id => id && list.some(p => p.id === id)) || list[0]?.id;
    presetSel.replaceChildren(...list.map((p: any) => h('option', { value: p.id, selected: p.id === keep }, `${p.title}${p.backend === 'cloud' ? ' · Cloud' : ''}${p.pricing?.usdPerImage != null ? (p.pricing.usdPerImage ? ` · ≈ $${p.pricing.usdPerImage.toFixed(2)}/image` : ' · free') : ''}${p.maxRefs ? ` · up to ${p.maxRefs} refs` : ''}`)));
  };
  presetSel.onchange = () => { localStorage.setItem('previs.looks.model', presetSel.value); syncToolbar(); };
  const countSel = h('select', { class: 'field', 'aria-label': 'Images per object' }, ...[1, 2, 3, 4].map(n => h('option', { value: n, selected: n === 2 }, `${n} per object`)));
  countSel.onchange = () => syncToolbar();
  const pickAll = h('input', { type: 'checkbox', 'aria-label': 'Select every object' });
  const missingBox = h('input', { type: 'checkbox' });
  const quoteBtn = h('button', { class: 'btn camera', type: 'button' }, 'Generate');
  const estLooks = () => { const p: any = ctx.refgen().presets.find(x => x.id === presetSel.value); if (p?.backend === 'local') return ' · free'; const usd = p?.pricing?.usdPerImage; const n = P().scene.entities.filter(e => picked.has(e.id) && !e.lookFrom).length; return usd != null && n ? ` · list ≈ $${(usd * n * Number(countSel.value)).toFixed(2)}` : ''; };
  // Bulk: give every selected object the image of one object (e.g. all police cars → Police 1).
  const shareFrom = h('select', { class: 'field', 'aria-label': 'Use the image of' });
  const shareBtn = h('button', { class: 'btn', type: 'button', title: 'Selected objects reuse this object’s images and description' }, 'Use this image');
  shareBtn.onclick = async () => {
    const id = shareFrom.value, ids = [...picked].filter(x => x !== id); if (!id || !ids.length) return;
    try { await ctx.edit(ids.map(x => ({ op: 'update_entity', id: x, patch: { lookFrom: id } }))); toast(`${ids.length} object${ids.length === 1 ? '' : 's'} now use ${P().scene.entities.find(x => x.id === id)?.name}’s image`); picked.clear(); draw(); }
    catch (err) { toast((err as Error).message, true); }
  };
  const grid = h('div', { class: 'lk-grid' });
  const batch = h('div', { class: 'lk-batch', hidden: true, role: 'region', 'aria-label': 'Quote', tabindex: -1 });
  const shown = () => P().scene.entities.filter(e => !onlyMissing || !objectLooks(P(), e.id).length);
  shareFrom.onchange = () => syncToolbar();
  pickAll.onchange = () => { for (const e of shown()) pickAll.checked ? picked.add(e.id) : picked.delete(e.id); draw(); };
  missingBox.onchange = () => { onlyMissing = missingBox.checked; draw(); };

  // ---------- Cards ----------
  function card(e: Entity) {
    const looks = objectLooks(P(), e.id), primary = looks[0], jobs = ctx.refgen().jobs.filter(j => j.entityId === e.id);
    const running = jobs.some(j => j.status === 'submitted');
    const inShots = shotsWith(e.id);
    const box = h('input', { type: 'checkbox', checked: picked.has(e.id), 'aria-label': `Select ${e.name}` });
    if (e.lookFrom) { box.title = 'Uses another object’s image — select it to share a different one'; }
    box.onchange = () => { box.checked ? picked.add(e.id) : picked.delete(e.id); syncToolbar(); el.classList.toggle('on', box.checked); };
    const notes = h('textarea', { class: 'field', rows: 3, maxlength: 400, placeholder: e.kind === 'character' ? 'Age, build, wardrobe, hair, materials…' : e.kind === 'vehicle' ? 'Make, era, paint, damage, details…' : 'Materials, colour, condition, details…', 'aria-label': `${e.name} description` }, e.notes || '');
    notes.onchange = async () => { try { await ctx.edit([{ op: 'update_entity', id: e.id, patch: { notes: notes.value } }]); } catch {} };
    const vs = lookViews(e); views[e.id] ||= Object.keys(vs)[0];
    const src = lookSource(P(), e.id), shared = src && src.id !== e.id ? src : null;
    const shareSel = h('select', { class: 'field', 'aria-label': `${e.name} image` }, h('option', { value: '' }, 'Own image'),
      ...P().scene.entities.filter(x => x.id !== e.id && lookSource(P(), x.id)?.id !== e.id).sort((a, b) => (b.kind === e.kind ? 1 : 0) - (a.kind === e.kind ? 1 : 0) || a.name.localeCompare(b.name)).map(x => h('option', { value: x.id, selected: e.lookFrom === x.id }, `Same as ${x.name}`)));
    shareSel.onchange = async () => { try { await ctx.edit([{ op: 'update_entity', id: e.id, patch: { lookFrom: shareSel.value || null } }]); picked.delete(e.id); draw(); } catch {} };
    const viewSel = h('select', { class: 'field', 'aria-label': `${e.name} view` }, ...Object.entries(vs).map(([k, label]) => h('option', { value: k, selected: k === views[e.id] }, label)));
    viewSel.onchange = () => { views[e.id] = viewSel.value; };
    const el = h('div', { class: 'lk-card' + (picked.has(e.id) ? ' on' : '') + (primary ? '' : ' empty') },
      h('div', { class: 'lk-img' },
        primary ? h('img', { src: refUrl(primary.file), alt: `${e.name} cast image`, loading: 'lazy' }) : h('div', { class: 'lk-ph' }, shapeIcon(e.shape), h('span', {}, 'No image yet')),
        h('label', { class: 'lk-pick' }, box),
        shared ? h('span', { class: 'lk-count' }, `= ${shared.name}`) : looks.length > 1 ? h('span', { class: 'lk-count' }, `${looks.length} images`) : null,
        running ? h('span', { class: 'lk-run' }, 'Generating…') : null),
      h('div', { class: 'lk-body' },
        h('div', { class: 'lk-name' }, h('strong', { title: e.name }, e.name), h('span', { class: 'muted' }, `${e.kind} · @${handleOf(e.name)}`)),
        h('div', { class: 'lk-shots' }, inShots.length ? `In shot ${inShots.map(x => String(x.i + 1).padStart(2, '0')).join(' · ')}` : 'Not seen by any shot camera'),
        notes, shareSel,
        h('div', { class: 'lk-row' }, shared ? h('span', { class: 'muted', style: 'flex:1;font-size:11.5px' }, 'Shared image · notes add to it') : viewSel, h('button', { class: 'btn sm ghost', type: 'button', onclick: () => { dlg.close(); ctx.openObject(e.id); } }, 'Open'))));
    return el;
  }
  function syncToolbar() {
    const list = shown();
    pickAll.checked = list.length > 0 && list.every(e => picked.has(e.id)); pickAll.indeterminate = !pickAll.checked && list.some(e => picked.has(e.id));
    quoteBtn.textContent = picked.size ? `Quote ${picked.size} image${picked.size === 1 ? '' : 's'}${estLooks()}` : 'Quote';
    quoteBtn.disabled = busy || !picked.size;
    const keep = shareFrom.value;
    shareFrom.replaceChildren(h('option', { value: '' }, 'Give selected the image of…'), ...P().scene.entities.filter(x => !x.lookFrom && objectLooks(P(), x.id).length).map(x => h('option', { value: x.id, selected: x.id === keep }, x.name)));
    shareBtn.disabled = busy || !picked.size || !shareFrom.value;
  }
  function draw() {
    const ents = shown();
    // Subjects first, then environment pieces; inside each, objects the shots see come first.
    const order = (e: Entity) => (e.kind === 'environment' ? 2 : 0) + (shotsWith(e.id).length ? 0 : 1);
    grid.replaceChildren(...(ents.length ? [...ents].sort((a, b) => order(a) - order(b)).map(card) : [h('div', { class: 'empty-state', style: 'grid-column:1/-1' }, onlyMissing ? 'Every object has an image.' : 'Add objects to the scene first.')]));
    syncToolbar();
  }

  // ---------- Batch: prepare (quote) every selected object, show the quote, one approval, generate one at a time ----------
  quoteBtn.onclick = async () => {
    busy = true; syncToolbar();
    batch.hidden = false; batch.replaceChildren(h('p', { class: 'status-line' }, 'Preparing each object…'));
    plan = [];
    const presetId = presetSel.value, count = Number(countSel.value);
    // A cloud model with no key on the server: say so here instead of asking the server (which answers 400).
    const noKey = ctx.refgen().presets?.find(p => p.id === presetId)?.backend === 'cloud' && !ctx.refgen().cloudCredential;
    for (const e of P().scene.entities.filter(x => picked.has(x.id))) {
      if (e.lookFrom) { plan.push({ e, job: null, issue: `uses ${lookSource(P(), e.id)?.name}’s image` }); continue; }
      if (noKey) { plan.push({ e, job: null, issue: 'Add a Comfy Cloud key in Setup (COMFY_CLOUD_API_KEY in .env), or switch to Local ComfyUI. Nothing was sent.' }); continue; }
      const view = views[e.id] || Object.keys(lookViews(e))[0];
      try {
        const r = await api('director/refgen/prepare', { projectId: P().id, entityId: e.id, presetId, prompt: lookPrompt(P(), e, view), aspect: aspectFor(e, view), count, seed: Math.floor(Math.random() * 1e6) });
        plan.push({ e, job: r.job, issue: r.job.validation && !r.job.validation.compatible ? (r.job.validation.issues || []).map((i: any) => i.message).slice(0, 2).join('; ') : undefined });
      } catch (err) { plan.push({ e, job: null, issue: (err as Error).message }); }
    }
    busy = false; await ctx.reloadRefgen(); draw();
    // Nothing is sent yet: the quote table asks for approval of a total.
    drawPlan(); refocus(batch);
  };
  function drawPlan() {
    // A request without an estimate is skipped, never sent under a guessed price.
    for (const x of plan) if (x.job && !x.issue && expectedUsd(x.job) === null) x.issue = 'no cost estimate for this model';
    const ready = plan.filter(x => x.job && !x.issue), total = ready.reduce((t, x) => t + (expectedUsd(x.job) ?? 0), 0);
    const free = ready.every(x => isFree(x.job));
    const blocked = !free && !ctx.refgen().paidExecutionEnabled;
    const approve = h('input', { type: 'checkbox' });
    const cap = h('input', { class: 'field mono', type: 'number', min: 0, step: 0.01, value: suggestedCap(total).toFixed(2), style: 'width:84px', 'aria-label': 'Maximum USD for the batch' });
    const go = h('button', { class: 'btn camera', type: 'button', disabled: true }, `${free ? 'Generate' : 'Approve & generate'} ${ready.length}`);
    approve.onchange = () => { go.disabled = blocked || !approve.checked || !ready.length; };
    go.onclick = () => void run(ready, free ? 0 : Number(cap.value) || 0);
    announce(ready.length ? `Quote ready for ${ready.length} object${ready.length === 1 ? '' : 's'}, ${free ? 'no charge' : `about $${total.toFixed(2)}`}. Nothing has been sent; approve to generate.` : 'Nothing to generate: every selected object was skipped.');
    batch.replaceChildren(
      h('div', { class: 'lk-batch-head' }, h('strong', {}, 'Quote'), h('span', { class: 'muted' }, 'Nothing has been sent'), h('span', { style: 'flex:1' }), h('button', { class: 'btn ghost sm icon', type: 'button', 'aria-label': 'Close quote', onclick: () => { batch.hidden = true; } }, '✕')),
      h('table', { class: 'lk-quote' }, h('tbody', {}, ...plan.map(x => h('tr', { class: x.issue || !x.job ? 'skip' : '' },
        h('td', {}, x.e.name), h('td', { class: 'muted' }, x.job ? `${x.job.count} × ${x.job.aspect}` : ''),
        h('td', { class: 'mono' }, x.job && !x.issue ? x.job.quote?.label || '' : ''), h('td', { class: x.issue ? 'muted' : 'ok' }, x.issue ? `Skipped · ${x.issue}` : 'Ready'))))),
      ready.length ? h('div', { class: 'lk-approve' },
        free ? h('span', {}, 'Local generation · no charge') : h('span', {}, 'Estimated total ', h('b', { class: 'mono' }, `≈ $${total.toFixed(2)}`), ' · Cloud totals are estimates'),
        h('label', {}, approve, free ? 'I approve these requests' : 'I approve these requests, up to'), free ? null : cap, free ? null : h('span', {}, 'USD in total'), go,
        blocked ? h('p', { class: 'note', style: 'margin:0;flex-basis:100%' }, 'Paid generation is off on this server (PREVIS_ALLOW_PAID≠1). Nothing will be sent.') : h('p', { class: 'note', style: 'margin:0;flex-basis:100%' }, 'Objects run one at a time. A failed or uncertain request stops the batch and is never retried. New images become primary on objects that had none.')) : h('p', { class: 'note' }, 'Nothing to generate.'));
  }
  async function run(list: Planned[], cap: number) {
    busy = true; syncToolbar();
    const log = h('div', { class: 'lk-log', role: 'log', 'aria-label': 'Image generation progress' }), bound = { capUsd: cap, spentUsd: 0 }, free = list.every(x => isFree(x.job));
    batch.replaceChildren(h('div', { class: 'lk-batch-head' }, h('strong', {}, `Generating images for ${list.length} object${list.length === 1 ? '' : 's'}`)), log);
    const line = (t: string, cls = '') => { const l = h('div', { class: cls }, t); log.append(l); return l; };
    try {
      for (const x of list) {
        // Sent once under the approved total; a request whose estimate would pass it is not sent and stops the batch.
        let job: any;
        try { job = (await submitImage(api, P().id, x.job, bound)).job; }
        catch (err) { if (!(err as any).refused) throw err; line(`${x.e.name}: ${(err as Error).message} Stopped.`, 'err'); break; }
        const l = line(`${x.e.name}: ${job.status}…`); const t0 = Date.now();
        while (job.status === 'submitted') {
          await sleep(5000);
          job = (await api('director/refgen/track', { projectId: P().id, requestId: x.job.id })).job;
          l.textContent = `${x.e.name}: ${job.status} · ${Math.round((Date.now() - t0) / 1000)}s`;
          if (Date.now() - t0 > 10 * 60000) { l.textContent = `${x.e.name}: still running after 10 min — batch stopped (never retried)`; throw Error('stop'); }
        }
        l.className = job.status === 'completed' ? 'ok' : 'err'; l.textContent = `${x.e.name}: ${job.status}${job.message ? ` · ${job.message}` : ''}`;
        await ctx.reloadRefgen(); draw();
        if (job.status !== 'completed') { line('Batch stopped. Nothing is retried automatically.', 'err'); break; }
      }
      line(free ? 'Done' : `Done · estimated spend ≈ $${bound.spentUsd.toFixed(2)} of $${cap.toFixed(2)} approved`, 'muted');
    } catch (err) { if ((err as Error).message !== 'stop') line((err as Error).message, 'err'); }
    finally { busy = false; picked.clear(); await ctx.reloadRefgen(); draw(); toast('Cast images updated'); }
  }

  const dlg = h('dialog', { class: 'looks', id: 'looks-dialog', 'aria-labelledby': 'looks-title' },
    h('div', { class: 'dialog-head' }, h('h2', { id: 'looks-title', title: P().title }, `Cast images · ${P().title}`), h('span', { class: 'muted', style: 'font-size:12px' }, 'Each object’s image is sent with every shot it appears in.'), h('button', { class: 'btn ghost sm icon', type: 'button', 'aria-label': 'Close', onclick: () => dlg.close() }, '✕')),
    h('div', { class: 'lk-body-wrap' },
      h('section', { class: 'lk-style' },
        h('label', {}, h('span', { class: 'eyebrow' }, 'World'), world),
        h('label', {}, h('span', { class: 'eyebrow' }, 'Visual style'), style),
        h('p', { class: 'note', style: 'margin:0;grid-column:1/-1' }, 'Used in every cast image and every shot prompt, so objects and shots share one world.')),
      h('div', { class: 'lk-toolbar' },
        h('label', { class: 'lk-check' }, pickAll, 'All'), h('label', { class: 'lk-check' }, missingBox, 'Without an image'),
        h('span', { class: 'lk-share' }, shareFrom, shareBtn),
        h('span', { style: 'flex:1' }),
        h('label', { class: 'lk-field' }, 'Model', presetSel), h('label', { class: 'lk-field' }, countSel), quoteBtn),
      batch, grid));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg); dlg.showModal();
  fillPresets(); draw();
  // Default selection: objects that are prominent in some shot and have no look yet.
  for (const e of P().scene.entities) if (!e.lookFrom && !objectLooks(P(), e.id).length && prominent(e.id) && e.kind !== 'environment') picked.add(e.id);
  draw();
  return { refresh: () => { if (!busy && dlg.open && !dlg.contains(document.activeElement)) draw(); } };
}
