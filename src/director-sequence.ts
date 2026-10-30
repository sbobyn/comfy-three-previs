// Sequence view: every shot in order, with its blockout render and generated video side by side.
// Reorder shots, render missing blockouts, quote and generate videos in one approved batch,
// choose the version each shot uses in the cut, trim, play the whole sequence and export it.
import './director-sequence.css';
import type { DirectorProject, Shot, Asset, EditClip } from '../shared/director.mjs';
import { api, h, toast } from './director-common';
import { shotCast, objectLooks } from '../shared/director.mjs';
import { prepareShotVideo, videoChoices, referenceCapacity, plannedReferences } from './director-videogen';
import type { Def, EngineRef } from './director-videogen';

export type SequenceCtx = {
  project(): DirectorProject;
  apply(p: DirectorProject): void;
  runEntry(e: { label: string; redo: unknown[]; undo: unknown[] }): Promise<void>;
  signature(p: DirectorProject, s: Shot): string;
  assetUrl(a: Asset): string;
  thumbnail(s: Shot, w: number, h: number): HTMLCanvasElement;
  prompt(s: Shot): string;
  capture(s: Shot, o: { onStatus?: (t: string) => void; onFrame?: (url: string, i: number, n: number) => void }): Promise<unknown>;
  openShot(id: string): void;
  openEditor(): void;
};

type Job = { id: string; shotId: string; status: string; message?: string; definition?: { title?: string; task?: string } };
type Quoted = { shot: Shot; est: number | null; ok: boolean; issue?: string; refs?: EngineRef[] };

const DONE = ['completed', 'failed', 'uncertain', 'closed', 'invalidated', 'error'];
const no = (p: DirectorProject, id: string) => String(p.shots.findIndex(s => s.id === id) + 1).padStart(2, '0');
const sec = (v: number | null | undefined) => (v == null ? '—' : `${Number(v).toFixed(2)}s`);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** A result is compared only with the immutable camera render recorded in its receipt. */
export function comparisonSource(assets: Asset[], result: Asset | null): Asset | null {
  const id = result?.source?.sourceAssetId;
  return id ? assets.find(a => a.id === id && a.kind === 'camera-render') || null : null;
}

export function comparisonFacts(source: Asset, result: Asset): string {
  const describe = (label: string, a: Asset) => `${label} · ${a.width ?? '?'}×${a.height ?? '?'} · ${a.fps ?? '?'} fps · ${a.frameCount ?? '?'} frames · ${a.duration == null ? '?' : a.duration.toFixed(6)} s`;
  const changed = (a: number | null | undefined, b: number | null | undefined) => a != null && b != null && Math.abs(a - b) > 0.000002;
  const timing = changed(source.frameCount, result.frameCount) || changed(source.fps, result.fps) || changed(source.duration, result.duration);
  const framing = changed(source.width, result.width) || changed(source.height, result.height);
  return [describe('Saved source', source), describe('Result', result),
    timing ? 'Timing differs. Comparison stops at the shorter clip; open Generated to inspect any extra result frames. Originals are unchanged.' : '',
    framing ? 'Resolution differs. Each original keeps its own framing.' : ''].filter(Boolean).join('\n');
}

export function createSequence(ctx: SequenceCtx) {
  let gen: { presets: Def[]; definitions: Def[]; jobs: Job[] } = { presets: [], definitions: [], jobs: [] };
  let selected = '', view: 'generated' | 'blockout' | 'compare' = 'generated', busy = false, picked = new Set<string>();
  let quoted: Quoted[] = [];
  const P = () => ctx.project();

  // ---------- Data ----------
  const videos = (s: Shot) => (P().assets || []).filter(a => a.shotId === s.id && a.mime?.startsWith('video/')).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const renders = (s: Shot) => videos(s).filter(a => a.kind === 'camera-render');
  const results = (s: Shot) => videos(s).filter(a => a.kind === 'workflow-result');
  const fresh = (s: Shot) => !!s.render && (!s.render.signature || s.render.signature === ctx.signature(P(), s));
  const blockout = (s: Shot) => renders(s)[0] || null;
  const engineShots = (s: Shot) => new Set([s.render?.previsShotId, ...renders(s).map(a => a.source.engineShotId)].filter(Boolean) as string[]);
  const activeJob = (s: Shot) => { const ids = engineShots(s); return gen.jobs.filter(j => ids.has(j.shotId) && !DONE.includes(j.status) && j.status !== 'quoted').at(-1) || null; };
  // The cut follows shot order; each shot keeps its chosen version and trims.
  const clipFor = (s: Shot): EditClip | null => { const p = P(); if (!p.edit?.clips?.length) return { id: s.id, shotId: s.id, assetId: null, in: 0, out: null }; return p.edit.clips.find(c => c.shotId === s.id) || null; };
  const media = (s: Shot, c = clipFor(s)) => { if (c?.assetId) return videos(s).find(a => a.id === c.assetId) || null; return results(s)[0] || renders(s)[0] || null; };
  const customOrder = () => { const c = P().edit?.clips; if (!c?.length) return false; const order = P().shots.map(s => s.id).filter(id => c.some(x => x.shotId === id)); return c.length !== order.length || c.some((x, i) => x.shotId !== order[i]); };
  async function writeCut(change: (byShot: Map<string, EditClip | null>) => void, label: string) {
    const p = P(), before = structuredClone(p.edit?.clips || []);
    const byShot = new Map(p.shots.map(s => [s.id, clipFor(s) && structuredClone(clipFor(s)!)] as const));
    change(byShot);
    const clips = p.shots.map(s => byShot.get(s.id)).filter(Boolean) as EditClip[];
    await ctx.runEntry({ label, redo: [{ op: 'set_edit', clips }], undo: [{ op: 'set_edit', clips: before }] });
  }

  // ---------- Layout ----------
  const modelSel = h('select', { class: 'field', 'aria-label': 'Video model' });
  const renderAllBtn = h('button', { class: 'btn', type: 'button', title: 'Capture the camera video of every shot that has none, or whose blockout changed' }, 'Make missing blockouts');
  const quoteBtn = h('button', { class: 'btn camera', type: 'button' }, 'Quote selected');
  // Rough cost on the button: rate × seconds (LTX rounds to its clip lengths).
  const estShots = () => { const d = choice().find(x => x.id === modelSel.value); const rate = d?.pricing?.ratePerSecond; if (!rate) return ''; const secs = (s: Shot) => (d!.task === 'first-frame' ? [2, 3, 4, 5, 6, 8, 10].reduce((a, b) => (Math.abs(b - s.duration) < Math.abs(a - s.duration) ? b : a)) : s.render?.duration ?? s.duration); return ` · ≈ $${P().shots.filter(s => picked.has(s.id)).reduce((t, s) => t + rate * secs(s), 0).toFixed(2)}`; };
  const useRefs = h('input', { type: 'checkbox', checked: localStorage.getItem('previs.seq.refs') !== '0' });
  useRefs.onchange = () => { localStorage.setItem('previs.seq.refs', useRefs.checked ? '1' : '0'); drawBoard(); };
  const refUrl = (file: string) => `/director-refs/${P().id}/${file}`;
  /** Thumbnails of the reference images going into a shot, numbered as the prompt names them. */
  function refStrip(list: { file: string; name: string; label: string; role: string }[]) {
    return h('span', { class: 'sq-refs' }, ...list.map((r, i) => h('span', { class: 'sq-ref', title: `${i + 1} · ${r.label}${r.role === 'environment' || r.role === 'style' || r.role === 'frame' ? ` (${r.role})` : ''} — ${r.name}` }, h('img', { src: refUrl(r.file), alt: '', loading: 'lazy' }), h('i', {}, String(i + 1)))));
  }
  const pickAll = h('input', { type: 'checkbox', 'aria-label': 'Select every shot' });
  const batch = h('div', { class: 'sq-batch', hidden: true });
  const board = h('div', { class: 'sq-board', role: 'list', 'aria-label': 'Shots in order' });
  const banner = h('div', { class: 'sq-banner', hidden: true });
  const video = h('video', { playsinline: true, controls: true, preload: 'metadata' });
  // Compare: the generated video sits over the blockout and is revealed right of a draggable seam.
  const over = h('video', { class: 'sq-over', playsinline: true, muted: true, preload: 'auto', hidden: true, 'aria-hidden': 'true' });
  const seam = h('div', { class: 'sq-seam', hidden: true, role: 'slider', tabindex: 0, 'aria-label': 'Compare seam: blockout left, generated right', 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('span', { class: 'sq-seam-grip' }), h('span', { class: 'sq-seam-l' }, 'Blockout'), h('span', { class: 'sq-seam-r' }, 'Generated'));
  let seamAt = 50;
  const setSeam = (pct: number) => { seamAt = Math.max(0, Math.min(100, pct)); over.style.clipPath = `inset(0 0 0 ${seamAt}%)`; seam.style.left = `${seamAt}%`; seam.setAttribute('aria-valuenow', String(Math.round(seamAt))); };
  setSeam(50);
  seam.onpointerdown = ev => {
    ev.preventDefault(); seam.setPointerCapture(ev.pointerId);
    const box = seam.parentElement!.getBoundingClientRect();
    const move = (e: PointerEvent) => setSeam(((e.clientX - box.left) / box.width) * 100);
    move(ev); seam.onpointermove = move; seam.onpointerup = () => { seam.onpointermove = null; };
  };
  seam.onkeydown = ev => { if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') { ev.preventDefault(); setSeam(seamAt + (ev.key === 'ArrowLeft' ? -5 : 5)); } };
  // Keep the overlay in step with the main player (which owns the controls).
  const follow = () => { if (over.hidden) return; if (Math.abs(over.currentTime - video.currentTime) > 0.06) over.currentTime = Math.min(video.currentTime, over.duration > 0 ? over.duration : video.currentTime); };
  video.addEventListener('play', () => { if (!over.hidden) { follow(); if (over.duration > 0 && video.currentTime >= over.duration) { video.pause(); return; } void over.play().catch(() => {}); } });
  video.addEventListener('pause', () => over.pause());
  video.addEventListener('seeked', follow);
  video.addEventListener('timeupdate', follow);
  video.addEventListener('ratechange', () => { over.playbackRate = video.playbackRate; });
  video.addEventListener('ended', () => { if (!over.hidden) { over.pause(); if (over.duration > 0) over.currentTime = Math.min(video.currentTime, over.duration); } });
  over.addEventListener('ended', () => { if (!over.hidden) { video.pause(); video.currentTime = Math.min(video.currentTime, over.duration); } });
  const compareOff = () => { over.hidden = true; seam.hidden = true; over.pause(); comparisonInfo.hidden = true; comparisonPosition.hidden = true; };
  const empty = h('div', { class: 'sq-empty' });
  const abSeg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Version' });
  const caption = h('div', { class: 'sq-caption' });
  const comparisonInfo = h('div', { class: 'sq-comparison-info', hidden: true });
  const comparisonPosition = h('div', { class: 'sq-comparison-position mono', hidden: true });
  const position = (label: string, v: HTMLVideoElement) => `${label} ${v.currentTime.toFixed(3)} s${v.duration > 0 && v.currentTime >= v.duration - 0.0005 ? ' · ended' : ''}`;
  const syncPosition = () => { if (!over.hidden) comparisonPosition.textContent = `${position('Source', video)} / ${position('Result', over)}`; };
  for (const v of [video, over]) for (const name of ['timeupdate', 'seeked', 'pause', 'ended', 'loadedmetadata']) v.addEventListener(name, syncPosition);
  const playSeqBtn = h('button', { class: 'btn', type: 'button' }, '▶ Play sequence');
  const exportBtn = h('button', { class: 'btn camera', type: 'button' }, 'Export final video');
  const exportStatus = h('div', { class: 'status-line' });
  const exportsList = h('div', { class: 'sq-exports' });
  const totals = h('span', { class: 'muted mono' });
  const el = h('section', { class: 'sequence', hidden: true, 'aria-label': 'Sequence' },
    h('div', { class: 'sq-main' },
      h('div', { class: 'sq-toolbar' },
        h('label', { class: 'sq-pickall' }, pickAll, 'All'),
        h('label', { class: 'sq-model' }, 'Video model', modelSel),
        h('label', { class: 'sq-pickall', title: 'Send the image of every cast member the shot camera sees (plus environment, style and key frame) with the request' }, useRefs, 'Send cast images'), quoteBtn, h('span', { style: 'flex:1' }), renderAllBtn,
        h('button', { class: 'btn ghost', type: 'button', title: 'Timeline with duplicates, custom order and frame-accurate trims', onclick: () => ctx.openEditor() }, 'Timeline')),
      banner, batch, board),
    h('aside', { class: 'sq-viewer' },
      h('div', { class: 'sq-screen' }, video, over, seam, empty),
      h('div', { class: 'sq-ctl' },
        h('div', { class: 'sq-vbar' }, abSeg, caption), comparisonInfo, comparisonPosition,
        h('div', { class: 'sq-vbar' }, playSeqBtn, totals),
        h('div', { class: 'sq-export' }, h('div', { class: 'sq-vbar' }, exportBtn, h('span', { class: 'note' }, '1280×720 · 24 fps · H.264, in shot order')), exportStatus, exportsList))));

  // ---------- Board ----------
  let dragFrom = -1;
  function row(s: Shot, i: number) {
    const p = P(), c = clipFor(s), inCut = !!c, a = media(s, c), job = activeJob(s), b = blockout(s), res = results(s);
    const thumb = h('canvas', { width: 160, height: 90 });
    requestAnimationFrame(() => { try { thumb.getContext('2d')!.drawImage(ctx.thumbnail(s, 160, 90), 0, 0); } catch {} });
    const pick = h('input', { type: 'checkbox', checked: picked.has(s.id), 'aria-label': `Select shot ${i + 1} for generation` });
    pick.onchange = () => { pick.checked ? picked.add(s.id) : picked.delete(s.id); syncPickAll(); };
    const bState = !s.render ? ['missing', 'No blockout'] : fresh(s) ? ['ok', 'Blockout ready'] : ['stale', 'Blockout changed'];
    const gState = job ? ['run', `Generating · ${job.status}`] : res.length ? ['ok', `${res.length} generated`] : ['none', 'Not generated'];
    const version = h('select', { class: 'field', 'aria-label': `Version of shot ${i + 1} in the cut`, disabled: !inCut },
      h('option', { value: '' }, 'Newest (generated, else blockout)'),
      ...res.map((x, k) => h('option', { value: x.id, selected: c?.assetId === x.id }, `Generated ${res.length - k} · ${(x.source.workflow || '').split(' ·')[0]}`)),
      ...renders(s).map(x => h('option', { value: x.id, selected: c?.assetId === x.id }, `Blockout v${x.version ?? 1}`)));
    version.onchange = () => void writeCut(m => { const k = m.get(s.id); if (k) { k.assetId = version.value || null; k.in = 0; k.out = null; } }, 'Choose version');
    const dur = a?.duration || 0;
    const trim = (which: 'in' | 'out') => {
      const input = h('input', { class: 'field mono', type: 'number', min: 0, max: dur, step: 1 / 24, value: which === 'in' ? (c?.in || 0).toFixed(2) : (c?.out ?? dur).toFixed(2), disabled: !inCut || !a, 'aria-label': `${which === 'in' ? 'In' : 'Out'} point of shot ${i + 1}` });
      input.onchange = () => void writeCut(m => { const k = m.get(s.id); if (!k) return; const v = Math.max(0, Math.min(dur, Number(input.value) || 0)); if (which === 'in') k.in = v; else k.out = v >= dur - 0.001 ? null : v; }, 'Trim');
      return input;
    };
    const include = h('button', { class: 'btn sm' + (inCut ? ' on' : ''), type: 'button', 'aria-pressed': String(inCut), title: inCut ? 'In the cut — click to leave it out' : 'Left out of the cut — click to include' }, inCut ? 'In cut' : 'Excluded');
    include.onclick = () => void writeCut(m => m.set(s.id, inCut ? null : { id: crypto.randomUUID(), shotId: s.id, assetId: null, in: 0, out: null }), inCut ? 'Leave shot out of cut' : 'Include shot in cut');
    const move = (d: -1 | 1) => h('button', { class: 'btn ghost sm icon', type: 'button', disabled: i + d < 0 || i + d >= p.shots.length, 'aria-label': d < 0 ? 'Move earlier' : 'Move later', onclick: (ev: Event) => { ev.stopPropagation(); void reorder(i, i + d); } }, d < 0 ? '↑' : '↓');
    const el = h('div', { class: 'sq-row' + (s.id === selected ? ' on' : '') + (inCut ? '' : ' out'), role: 'listitem', draggable: true, tabindex: 0, 'aria-label': `Shot ${i + 1} ${s.title}` },
      h('span', { class: 'sq-grip', title: 'Drag to reorder', 'aria-hidden': 'true' }, '⋮⋮'), pick,
      h('span', { class: 'sq-num mono' }, String(i + 1).padStart(2, '0')),
      thumb,
      h('div', { class: 'sq-title' }, h('strong', {}, s.title), h('span', { class: 'muted' }, `${s.duration}s${a ? ` · cut uses ${a.kind === 'workflow-result' ? 'generated' : 'blockout'}` : ''}`), castLine(s)),
      h('div', { class: 'sq-cell' }, h('span', { class: `sq-st ${bState[0]}` }, bState[1]),
        h('div', { class: 'sq-acts' },
          b ? h('button', { class: 'btn sm', type: 'button', onclick: (ev: Event) => { ev.stopPropagation(); select(s.id, 'blockout'); } }, '▶') : null,
          h('button', { class: 'btn sm', type: 'button', disabled: busy, onclick: (ev: Event) => { ev.stopPropagation(); void renderShots([s]); } }, s.render ? 'Remake' : 'Make'))),
      h('div', { class: 'sq-cell' }, h('span', { class: `sq-st ${gState[0]}` }, gState[1]),
        h('div', { class: 'sq-acts' },
          res.length ? h('button', { class: 'btn sm', type: 'button', onclick: (ev: Event) => { ev.stopPropagation(); select(s.id, 'generated'); } }, '▶') : null,
          h('button', { class: 'btn sm', type: 'button', disabled: busy || !!job, title: 'Generate this shot with the selected model', onclick: (ev: Event) => { ev.stopPropagation(); picked = new Set([s.id]); void quote(); } }, 'Generate'))),
      h('div', { class: 'sq-cell sq-cut' }, version, h('div', { class: 'sq-trim' }, trim('in'), h('span', { class: 'muted' }, '→'), trim('out'))),
      h('div', { class: 'sq-side' }, include, h('div', { class: 'sq-move' }, move(-1), move(1)),
        h('button', { class: 'btn ghost sm', type: 'button', title: 'Open this shot in the scene', onclick: (ev: Event) => { ev.stopPropagation(); ctx.openShot(s.id); } }, 'Open')));
    el.onclick = ev => { if ((ev.target as HTMLElement).closest('input,select,button')) return; select(s.id); };
    el.onkeydown = ev => { if (ev.target !== el) return; if (ev.key === 'Enter') select(s.id); if (ev.altKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) { ev.preventDefault(); void reorder(i, i + (ev.key === 'ArrowUp' ? -1 : 1)); } };
    el.ondragstart = ev => { dragFrom = i; ev.dataTransfer?.setData('text/plain', String(i)); el.classList.add('dragging'); };
    el.ondragend = () => el.classList.remove('dragging');
    el.ondragover = ev => { ev.preventDefault(); el.classList.add('drop'); };
    el.ondragleave = () => el.classList.remove('drop');
    el.ondrop = ev => { ev.preventDefault(); el.classList.remove('drop'); if (dragFrom >= 0 && dragFrom !== i) void reorder(dragFrom, i); dragFrom = -1; };
    return el;
  }
  // Who is in the shot, and which of their looks will be sent with the video request.
  function castLine(s: Shot) {
    const cast = shotCast(P(), s).filter(c => c.entity.kind !== 'environment');
    const refs = useRefs.checked && modelSel.value ? plannedReferences(P(), s, gen, modelSel.value) : [];
    // Only flag objects big enough in frame to matter.
    const missing = cast.filter(c => (c.lead || c.coverage >= 0.15) && !objectLooks(P(), c.entity.id).length).map(c => c.entity.name);
    return h('span', { class: 'sq-cast' },
      refs.length ? refStrip(refs.map(r => ({ file: r.ref.file, name: r.ref.name, label: r.label, role: r.role }))) : null,
      h('span', { class: 'muted', title: cast.map(c => `${c.entity.name} · ${Math.round(c.coverage * 100)}% of frame`).join('\n') }, cast.length ? `In shot: ${cast.slice(0, 4).map(c => c.entity.name).join(', ')}${cast.length > 4 ? ` +${cast.length - 4}` : ''}` : 'No objects in frame'),
      missing.length ? h('span', { class: 'sq-nolook', title: `${missing.join(', ')} ${missing.length === 1 ? 'has' : 'have'} no look yet — open Looks to make one` }, `${missing.length} without a look`) : null);
  }
  async function reorder(from: number, to: number) {
    const p = P(); if (to < 0 || to >= p.shots.length) return;
    const before = p.shots.map(s => s.id), ids = [...before]; const [m] = ids.splice(from, 1); ids.splice(to, 0, m);
    const cutBefore = structuredClone(p.edit?.clips || []);
    // Keep the cut in shot order too.
    const cut = p.edit?.clips?.length ? ids.flatMap(id => p.edit!.clips.filter(c => c.shotId === id)) : null;
    await ctx.runEntry({ label: 'Reorder shots', redo: [{ op: 'reorder_shots', ids }, ...(cut ? [{ op: 'set_edit', clips: cut }] : [])], undo: [{ op: 'reorder_shots', ids: before }, ...(cut ? [{ op: 'set_edit', clips: cutBefore }] : [])] });
  }
  const syncPickAll = () => { const n = P().shots.length; pickAll.checked = picked.size === n; pickAll.indeterminate = picked.size > 0 && picked.size < n; quoteBtn.textContent = picked.size ? `Quote ${picked.size} shot${picked.size === 1 ? '' : 's'}${estShots()}` : 'Quote selected'; quoteBtn.disabled = busy || !picked.size; };
  pickAll.onchange = () => { picked = pickAll.checked ? new Set(P().shots.map(s => s.id)) : new Set(); draw(); };

  // ---------- Viewer ----------
  let seq: { list: { s: Shot; a: Asset; c: EditClip }[]; i: number } | null = null;
  let pinned: Asset | null = null; // an export being watched
  function select(id: string, v?: typeof view) { selected = id; pinned = null; if (v) view = v; stopSeq(); draw(); }
  function watchExport(a: Asset) { compareOff(); stopSeq(); selected = ''; pinned = a; abSeg.replaceChildren(); abSeg.hidden = true; caption.textContent = `Export v${a.version ?? 1} · ${a.source.clips?.length ?? 0} clips · ${sec(a.duration)}`; show(a); void video.play().catch(() => {}); drawBoard(); }
  let shownId = '';
  // Returns true when a different video was loaded (so callers only restart playback then).
  function show(a: Asset | null, from = 0, msg = '', force = true) {
    if (!a) { shownId = ''; video.removeAttribute('src'); video.load(); video.hidden = true; empty.hidden = false; empty.textContent = msg; return false; }
    video.hidden = false; empty.hidden = true;
    const changed = shownId !== a.id; shownId = a.id;
    const url = ctx.assetUrl(a); if (!video.src.endsWith(url)) video.src = url;
    if (changed || force) video.currentTime = from;
    return changed || force;
  }
  function drawViewer() {
    const p = P(), s = p.shots.find(x => x.id === selected);
    if (seq || pinned) return;
    abSeg.hidden = !s;
    if (!s) { compareOff(); abSeg.replaceChildren(); caption.textContent = ''; show(null, 0, 'Pick a shot to watch it, or play the whole sequence.'); return; }
    const generated = results(s)[0], b = blockout(s);
    if (view !== 'blockout' && !generated && b) view = 'blockout';
    abSeg.replaceChildren(...(['blockout', 'compare', 'generated'] as const).map(k => h('button', { type: 'button', role: 'radio', 'aria-checked': String(view === k), class: view === k ? 'on' : '', title: k === 'compare' ? 'Blockout and generated with a draggable seam' : '', disabled: k === 'blockout' ? !b : !generated, onclick: () => { view = k; drawViewer(); } }, k === 'blockout' ? 'Blockout' : k === 'compare' ? 'Compare' : 'Generated')));
    const c = clipFor(s), chosen = c?.assetId ? videos(s).find(x => x.id === c.assetId) : null;
    const genPick = chosen?.kind === 'workflow-result' ? chosen : generated;
    const bPick = view === 'compare' ? comparisonSource(renders(s), genPick || null) : chosen?.kind === 'camera-render' ? chosen : b;
    const a = view === 'generated' ? genPick : bPick;
    if (view === 'compare' && genPick && bPick) {
      const url = ctx.assetUrl(genPick); if (!over.src.endsWith(url)) over.src = url;
      over.hidden = false; seam.hidden = false; setSeam(seamAt);
      comparisonInfo.hidden = false; comparisonPosition.hidden = false;
      const task = gen.jobs.find(j => j.id === genPick.source.jobId)?.definition?.task;
      comparisonInfo.textContent = comparisonFacts(bPick, genPick) + (task === 'first-frame' ? '\nKey-frame animation: the full source camera-motion clip was not supplied to this workflow.' : '');
      syncPosition();
    } else compareOff();
    caption.textContent = `Shot ${no(p, s.id)} · ${s.title}${view === 'compare' && genPick ? ` · ${(genPick.source.workflow || 'generated').split(' ·')[0]}${bPick ? ` vs original blockout v${bPick.version ?? 1}` : ' · original source unavailable'}` : a ? ` · ${a.kind === 'workflow-result' ? (a.source.workflow || 'generated').split(' ·')[0] : `blockout v${a.version ?? 1}`} · ${sec(a.duration)}` : ''}`;
    if (show(a || null, 0, view === 'compare' ? 'The original camera render for this result is unavailable. A newer blockout will not be substituted.' : view === 'generated' ? 'No generated video yet.' : 'No blockout yet. Use Make blockout on the board.', false) && a) void video.play().catch(() => {});
  }
  function cutList() { return P().shots.map(s => ({ s, c: clipFor(s)!, a: media(s)! })).filter(x => x.c && x.a); }
  function stopSeq() { if (!seq) return; seq = null; playSeqBtn.textContent = '▶ Play sequence'; video.pause(); }
  function playAt(i: number) {
    if (!seq) return;
    seq.i = i; const x = seq.list[i];
    if (!x) { stopSeq(); drawViewer(); return; }
    selected = x.s.id; drawBoard();
    caption.textContent = `Sequence · ${i + 1} / ${seq.list.length} · Shot ${no(P(), x.s.id)} ${x.s.title}`;
    compareOff(); abSeg.replaceChildren(); show(x.a, x.c.in || 0); void video.play().catch(() => {});
  }
  playSeqBtn.onclick = () => {
    if (seq) { stopSeq(); drawViewer(); return; }
    const list = cutList(); if (!list.length) { toast('Nothing in the cut has a blockout yet', true); return; }
    pinned = null; abSeg.hidden = true; seq = { list, i: 0 }; playSeqBtn.textContent = '❚❚ Stop'; playAt(0);
  };
  video.ontimeupdate = () => { if (!seq) return; const x = seq.list[seq.i]; if (x && video.currentTime >= (x.c.out ?? x.a.duration ?? Infinity) - 0.03) playAt(seq.i + 1); };
  video.onended = () => { if (seq) playAt(seq.i + 1); };
  function drawExports() {
    const p = P(), list = cutList(), total = list.reduce((t, x) => t + Math.max(0, (x.c.out ?? x.a.duration ?? 0) - (x.c.in || 0)), 0);
    const missing = p.shots.filter(s => clipFor(s) && !media(s)).length;
    totals.textContent = `${list.length} of ${p.shots.length} shots · ${total.toFixed(2)}s${missing ? ` · ${missing} not rendered` : ''}`;
    exportBtn.disabled = busy || !list.length || missing > 0;
    exportBtn.title = missing ? 'Make a blockout for every shot in the cut first' : '';
    const edits = (p.assets || []).filter(a => a.kind === 'edit').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    exportsList.replaceChildren(...(edits.length ? [h('span', { class: 'eyebrow' }, 'Exports')] : []), ...edits.slice(0, 4).map(a => h('div', { class: 'sq-exp' },
      h('button', { class: 'btn ghost sm', type: 'button', 'aria-label': `Play export v${a.version ?? 1}`, onclick: () => watchExport(a) }, '▶'),
      h('span', {}, `v${a.version ?? 1} · ${a.source.clips?.length ?? 0} clips · ${sec(a.duration)}`),
      h('span', { class: 'muted' }, new Date(a.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })),
      h('a', { class: 'btn sm', href: ctx.assetUrl(a), download: `${p.title}-v${a.version ?? 1}.mp4` }, 'Download'))));
  }
  exportBtn.onclick = async () => {
    busy = true; draw(); exportStatus.className = 'status-line'; exportStatus.textContent = 'Exporting with FFmpeg…';
    try {
      const r = await api('director/edit-export', { projectId: P().id });
      ctx.apply(r.project);
      exportStatus.textContent = `Exported v${r.asset.version}: ${sec(r.asset.duration)} · ${r.asset.frameCount} frames · ${r.asset.width}×${r.asset.height}.`;
      watchExport(r.asset);
    } catch (e) { exportStatus.className = 'status-line err'; exportStatus.textContent = (e as Error).message; }
    finally { busy = false; draw(); }
  };

  // ---------- Blockout renders ----------
  async function renderShots(list: Shot[]) {
    if (!list.length) { toast('Every blockout is up to date'); return; }
    busy = true; draw();
    const bar = h('i'), status = h('span');
    batch.hidden = false; batch.replaceChildren(h('div', { class: 'sq-batch-head' }, h('strong', {}, `Rendering ${list.length} blockout${list.length === 1 ? '' : 's'}`), status), h('div', { class: 'progress' }, bar));
    try {
      for (const [k, s] of list.entries()) {
        const label = `Shot ${no(P(), s.id)} ${s.title}`;
        await ctx.capture(s, { onStatus: t => { status.textContent = `${label} · ${t}`; }, onFrame: (_u, i, n) => { status.textContent = `${label} · frame ${i + 1}/${n}`; bar.style.width = `${((k + (i + 1) / n) / list.length) * 100}%`; } });
      }
      batch.hidden = true; toast(`Rendered ${list.length} blockout${list.length === 1 ? '' : 's'}`);
    } catch (e) { batch.replaceChildren(h('p', { class: 'status-line err' }, (e as Error).message)); }
    finally { busy = false; draw(); }
  }
  renderAllBtn.onclick = () => void renderShots(P().shots.filter(s => !fresh(s)));

  // ---------- Batch generation: quote → one approval → submit one at a time ----------
  const choice = () => videoChoices(gen);
  async function loadGen() {
    try { gen = await api('generation'); } catch { return; }
    const keep = modelSel.value;
    modelSel.onchange = () => syncPickAll();
    modelSel.replaceChildren(...choice().map(d => h('option', { value: d.id }, `${d.title}${referenceCapacity(gen, d.id) ? ` · up to ${referenceCapacity(gen, d.id)} refs` : ''}`)));
    if (keep && choice().some(d => d.id === keep)) modelSel.value = keep;
  }
  // Every submit needs a fresh binding against the engine's current revision.
  const bindAndQuote = (s: Shot) => prepareShotVideo({ project: P(), shot: s, st: gen, definitionId: modelSel.value, useReferences: useRefs.checked });
  async function quote() {
    const p = P(), shots = p.shots.filter(s => picked.has(s.id));
    if (!shots.length) return;
    busy = true; draw();
    batch.hidden = false; batch.replaceChildren(h('p', { class: 'status-line' }, 'Preparing each shot…'));
    try {
      const id = modelSel.value, def = choice().find(d => d.id === id)!;
      quoted = [];
      for (const s of shots) {
        if (!s.render || !fresh(s)) { quoted.push({ shot: s, est: null, ok: false, issue: s.render ? 'Blockout changed — make it again first' : 'Make the blockout first' }); continue; }
        if (activeJob(s)) { quoted.push({ shot: s, est: null, ok: false, issue: 'Already generating' }); continue; }
        try {
          const { job, est, refs } = await bindAndQuote(s);
          quoted.push({ shot: s, est, refs, ok: !!job.validation?.compatible, issue: job.validation?.compatible ? undefined : (job.validation?.issues || []).map((x: any) => x.message).slice(0, 2).join('; ') || 'Not compatible' });
        } catch (e) {
          let msg = (e as Error).message; const lim = def.constraints?.sourceVideo?.duration;
          if (/duration/.test(msg) && lim) msg = `Needs a ${lim.min}–${Math.floor(lim.max)} s shot (this is ${s.duration} s)`;
          quoted.push({ shot: s, est: null, ok: false, issue: msg });
        }
      }
      drawQuote(def, id); // Quote only; submission requires the visible approval controls.
    } catch (e) { batch.replaceChildren(h('p', { class: 'status-line err' }, (e as Error).message)); }
    finally { busy = false; draw(); }
  }
  quoteBtn.onclick = () => void quote();
  function drawQuote(def: Def, id: string) {
    const ready = quoted.filter(q => q.ok), total = ready.reduce((t, q) => t + (q.est ?? 0), 0), unknownCost = ready.some(q => q.est == null);
    const approve = h('input', { type: 'checkbox' }), unknown = h('input', { type: 'checkbox' });
    const revision = P().revision, references = useRefs.checked;
    let dispatched = false;
    const max = h('input', { class: 'field mono', type: 'number', min: 0, step: 0.01, value: (Math.ceil(total * 1.5 * 100) / 100 || 1).toFixed(2), style: 'width:84px', 'aria-label': 'Maximum USD for the batch' });
    const go = h('button', { class: 'btn camera', type: 'button', disabled: true }, `Approve & generate ${ready.length}`);
    const sync = () => { go.disabled = dispatched || !approve.checked || !unknown.checked || !ready.length || !Number.isFinite(Number(max.value)) || Number(max.value) < 0; };
    approve.onchange = unknown.onchange = max.oninput = sync;
    go.onclick = () => {
      sync(); if (go.disabled) return;
      if (P().revision !== revision || modelSel.value !== id || useRefs.checked !== references) { batch.replaceChildren(h('p', { class: 'status-line err' }, 'Project, model or images changed. Quote again; nothing submitted.')); return; }
      dispatched = true; go.disabled = true;
      void runBatch(def, id, ready, Number(max.value));
    };
    batch.replaceChildren(
      h('div', { class: 'sq-batch-head' }, h('strong', {}, `${def.title}`), h('span', { class: 'muted' }, 'Quote — nothing has been sent'), h('span', { style: 'flex:1' }), h('button', { class: 'btn ghost sm icon', type: 'button', 'aria-label': 'Close quote', onclick: () => { batch.hidden = true; quoted = []; } }, '✕')),
      h('table', { class: 'sq-quote' }, h('tbody', {}, ...quoted.map(q => h('tr', { class: q.ok ? '' : 'skip' },
        h('td', { class: 'mono' }, no(P(), q.shot.id)), h('td', {}, q.shot.title), h('td', { class: 'mono' }, `${q.shot.render?.duration != null ? Number(q.shot.render.duration).toFixed(2) : q.shot.duration}s`),
        h('td', {}, refStrip(q.refs || [])),
        h('td', { class: 'mono' }, q.ok ? (q.est != null ? `≈ $${q.est.toFixed(3)}` : 'unknown') : ''), h('td', { class: q.ok ? 'ok' : 'muted' }, q.ok ? 'Ready' : `Skipped · ${q.issue}`))))),
      ready.length ? h('div', { class: 'sq-approve' },
        h('span', {}, `Estimated total `, h('b', { class: 'mono' }, unknownCost ? `≥ $${total.toFixed(2)}` : `≈ $${total.toFixed(2)}`), ' · Cloud totals are estimates'),
        h('label', {}, approve, 'I approve these requests, with an allowance of ', max, ' USD in total'),
        h('label', {}, unknown, 'I accept unresolved provider/runtime charges. The allowance is not a provider-enforced spending cap.'), go,
        h('p', { class: 'note', style: 'margin:0' }, 'Shots run one at a time (one job per backend). Each is re-checked just before it is sent; a failed or uncertain job stops the batch and is never retried.')) : h('p', { class: 'note' }, 'Nothing to generate.'));
  }
  async function runBatch(def: Def, id: string, list: Quoted[], cap: number) {
    if (modelSel.value !== id) modelSel.value = id;
    busy = true; draw();
    let spent = 0; const log = h('div', { class: 'sq-log' });
    batch.replaceChildren(h('div', { class: 'sq-batch-head' }, h('strong', {}, `Generating ${list.length} shot${list.length === 1 ? '' : 's'} · ${def.title.split(' ·')[0]}`)), log);
    const line = (t: string, cls = '') => { const l = h('div', { class: cls }, t); log.append(l); return l; };
    try {
      for (const q of list) {
        const label = `Shot ${no(P(), q.shot.id)} ${q.shot.title}`;
        const s = P().shots.find(x => x.id === q.shot.id);
        if (!s?.render || !fresh(s)) { line(`${label}: blockout changed since the quote — skipped`, 'muted'); continue; }
        const { job, request, est } = await bindAndQuote(s);
        if (!job.validation?.compatible) { line(`${label}: no longer compatible — stopped`, 'err'); break; }
        const cost = est ?? q.est ?? 0;
        if (spent + cost > cap + 1e-9) { line(`${label}: would pass the $${cap.toFixed(2)} limit — stopped`, 'err'); break; }
        const allowance = { currency: 'USD', maxAmount: Math.max(0.01, Math.min(cap - spent, Math.ceil(cost * 150) / 100 || cap - spent)), allowUnknownCharges: true };
        const sub = (await api('generation/submit', { ...request, approval: { approved: true, fingerprint: job.fingerprint, allowance } })).job;
        spent += cost;
        const l = line(`${label}: ${sub.status}…`);
        let t = sub; const t0 = Date.now();
        while (!DONE.includes(t.status)) {
          await sleep(6000);
          t = (await api('generation/track', { jobId: sub.id })).job;
          l.textContent = `${label}: ${t.status} · ${Math.round((Date.now() - t0) / 1000)}s`;
          if (Date.now() - t0 > 20 * 60000) { l.textContent = `${label}: still ${t.status} after 20 min — left running, batch stopped`; throw Error('stop'); }
        }
        l.className = t.status === 'completed' ? 'ok' : 'err';
        l.textContent = `${label}: ${t.status}${t.message ? ` · ${t.message}` : ''}`;
        await api(`director/project?id=${P().id}`).then(r => r.project && ctx.apply(r.project)).catch(() => {});
        if (t.status !== 'completed') { line('Batch stopped. Nothing is retried automatically.', 'err'); break; }
      }
      line(`Done · estimated spend ≈ $${spent.toFixed(2)}`, 'muted');
    } catch (e) { if ((e as Error).message !== 'stop') line((e as Error).message, 'err'); }
    finally { busy = false; quoted = []; await loadGen(); draw(); }
  }

  // ---------- Draw ----------
  function drawBoard() { board.replaceChildren(...P().shots.map(row)); }
  function draw() {
    if (el.hidden) return;
    const p = P();
    picked = new Set([...picked].filter(id => p.shots.some(s => s.id === id)));
    banner.hidden = !customOrder();
    banner.textContent = 'The cut has a custom order or duplicate clips from the advanced timeline. Changes here put it back in shot order.';
    renderAllBtn.disabled = busy || p.shots.every(fresh);
    renderAllBtn.textContent = p.shots.every(fresh) ? 'All blockouts ready' : `Render ${p.shots.filter(s => !fresh(s)).length} missing blockout${p.shots.filter(s => !fresh(s)).length === 1 ? '' : 's'}`;
    drawBoard(); syncPickAll(); drawExports();
    if (!seq) drawViewer();
  }
  let timer = 0;
  return {
    el,
    async show(on: boolean) {
      el.hidden = !on;
      clearInterval(timer);
      if (!on) { stopSeq(); video.pause(); return; }
      if (!selected) selected = P().shots[0]?.id || '';
      draw(); await loadGen(); draw();
      // Keep job status fresh while the view is open.
      timer = window.setInterval(() => { if (!busy && gen.jobs.some(j => !DONE.includes(j.status) && j.status !== 'quoted')) void loadGen().then(draw); }, 8000);
    },
    refresh() { if (!el.hidden && !busy) { if (!seq) draw(); else { drawBoard(); drawExports(); } } },
  };
}
