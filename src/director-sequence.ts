// Cut view: every shot in order, with its blockout and generated video side by side.
// Reorder shots, make missing blockouts, quote and generate videos in one approved batch,
// choose the version each shot uses in the cut, trim, play the whole cut and export the film.
import './director-sequence.css';
import type { DirectorProject, Shot, Asset, EditClip } from '../shared/director.mjs';
import { progressSlot } from './director-progress'; // [live-progress]
import { api, h, toast } from './director-common';
import { shotCast, objectLooks, shotObjects, starterBlockout, videoStale } from '../shared/director.mjs';
import { autoPromptSegments, KIND_COLORS } from '../shared/prompt.mjs';
import { overlayCast, promptExcerpt, layoutChips, leaderFrom, compareBands, bandStops, sweepStops, moveStop } from './director-design-core';
import type { Box, BandSource } from './director-design-core';
import { prepareShotVideo, videoChoices, referenceCapacity, plannedReferences, clipSeconds, modelLabel } from './director-videogen';
import type { Def, EngineRef } from './director-videogen';
import { CAMERA_SOURCE_LABELS, CAMERA_SOURCE_GLYPHS, cameraSourceOf } from '../shared/camera-source.mjs';
import type { CameraSource } from '../shared/camera-source.mjs';

export type SequenceCtx = {
  project(): DirectorProject;
  apply(p: DirectorProject): void;
  runEntry(e: { label: string; redo: unknown[]; undo: unknown[] }): Promise<void>;
  signature(p: DirectorProject, s: Shot): string;
  assetUrl(a: Asset): string;
  thumbnail(s: Shot, w: number, h: number): HTMLCanvasElement;
  /** Screen boxes (0–1) of the objects the shot camera sees at time t, from the live scene. */
  boxes?(s: Shot, t: number): Box[];
  prompt(s: Shot): string;
  capture(s: Shot, o: { onStatus?: (t: string) => void; onFrame?: (url: string, i: number, n: number) => void }): Promise<unknown>;
  openShot(id: string): void;
  /** Unused: the Cut board is the only editor. Kept so the workspace can drop it in its own change. */
  openEditor?(): void;
  /** The export button's state, for the workspace top bar's Export film. */
  onExportState?(s: { ok: boolean; busy: boolean; reason: string }): void;
  /** [mobile] compact row template; the parts are today's controls, re-arranged by the mobile layer. */
  rowTemplate?(parts: RowParts): HTMLElement;
};
export type RowParts = { s: Shot; i: number; count: number; on: boolean; inCut: boolean; thumb: HTMLCanvasElement; pick: HTMLInputElement; version: HTMLSelectElement; trimIn: HTMLInputElement; trimOut: HTMLInputElement; include: HTMLButtonElement; moveUp: HTMLButtonElement; moveDown: HTMLButtonElement; open: HTMLButtonElement; bState: string[]; gState: string[]; progress?: HTMLElement | null; select(): void; reorder(from: number, to: number): Promise<void> };

type Job = { id: string; shotId: string; status: string; message?: string; definition?: { title?: string; task?: string } };
type Quoted = { shot: Shot; est: number | null; ok: boolean; issue?: string; refs?: EngineRef[]; cameraSource?: CameraSource };

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
  const describe = (label: string, a: Asset) => `${label} · ${a.width ?? '?'}×${a.height ?? '?'} · ${a.fps ?? '?'} fps · ${a.frameCount ?? '?'} frames · ${a.duration == null ? '?' : a.duration.toFixed(2)} s`;
  const changed = (a: number | null | undefined, b: number | null | undefined) => a != null && b != null && Math.abs(a - b) > 0.000002;
  const timing = changed(source.frameCount, result.frameCount) || changed(source.fps, result.fps) || changed(source.duration, result.duration);
  const framing = changed(source.width, result.width) || changed(source.height, result.height);
  return [describe('Blockout', source), describe('Generated', result),
    timing ? 'Timing differs. Compare stops at the shorter clip; switch to Generated to see any extra frames. Originals are unchanged.' : '',
    framing ? 'Resolution differs. Each original keeps its own framing.' : ''].filter(Boolean).join('\n');
}

export function createSequence(ctx: SequenceCtx) {
  let gen: { presets: Def[]; definitions: Def[]; jobs: Job[] } = { presets: [], definitions: [], jobs: [] };
  let selected = '', view: 'generated' | 'blockout' | 'compare' | 'overlay' = 'generated', busy = false, picked = new Set<string>();
  let quoted: Quoted[] = [];
  const P = () => ctx.project();

  // ---------- Data ----------
  const videos = (s: Shot) => (P().assets || []).filter(a => a.shotId === s.id && a.mime?.startsWith('video/')).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const renders = (s: Shot) => videos(s).filter(a => a.kind === 'camera-render');
  const results = (s: Shot) => videos(s).filter(a => a.kind === 'workflow-result');
  // Where a version's camera came from; versions made before it was recorded take it from their preset's inputs.
  const cameraOf = (a: Asset): CameraSource | null => {
    const known = (a.source as any)?.cameraSource as CameraSource | undefined; if (known) return known;
    const job: any = gen.jobs.find(j => j.id === a.source?.jobId); if (job) return job.cameraSource || cameraSourceOf(job.definition, job.binding?.assetBindings);
    const w = String(a.source?.workflow || ''), d = w && [...gen.presets, ...gen.definitions].find(x => w === x.title || w.startsWith(x.title + ' · '));
    return d ? cameraSourceOf(d) : null;
  };
  const camGlyph = (a: Asset | null | undefined) => {
    const cam = a && a.kind === 'workflow-result' ? cameraOf(a) : a ? 'blockout' as const : null;
    return cam ? h('span', { class: `sq-camglyph c-${cam}`, title: a!.kind === 'workflow-result' ? CAMERA_SOURCE_LABELS[cam] : 'The blockout itself', 'aria-label': CAMERA_SOURCE_LABELS[cam] }, CAMERA_SOURCE_GLYPHS[cam]) : null;
  };
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
  const renderAllBtn = h('button', { class: 'btn', type: 'button', title: 'Make the blockout of every shot that has none, or whose scene changed' }, 'Make missing blockouts');
  const allReady = h('span', { class: 'sq-allready muted', role: 'status', hidden: true }, '✓ All blockouts ready');
  const quoteBtn = h('button', { class: 'btn camera', type: 'button' }, 'Quote selected');
  // Rough cost on the button: rate × seconds (start-still models round to the clip lengths they accept).
  const estShots = () => { const d = choice().find(x => x.id === modelSel.value); const rate = d?.pricing?.ratePerSecond; if (!rate) return ''; return ` · ≈ $${P().shots.filter(s => picked.has(s.id)).reduce((t, s) => t + rate * clipSeconds(d, s), 0).toFixed(2)}`; };
  const useRefs = h('input', { type: 'checkbox', checked: localStorage.getItem('previs.seq.refs') !== '0' });
  useRefs.onchange = () => { localStorage.setItem('previs.seq.refs', useRefs.checked ? '1' : '0'); drawBoard(); };
  const refUrl = (file: string) => `/director-refs/${P().id}/${file}`;
  /** Thumbnails of the cast images going into a shot, numbered as the prompt names them. */
  function refStrip(list: { file: string; name: string; label: string; role: string }[]) {
    return h('span', { class: 'sq-refs' }, ...list.map((r, i) => h('span', { class: 'sq-ref', title: `${i + 1} · ${r.label}${r.role === 'environment' || r.role === 'style' || r.role === 'frame' ? ` (${r.role})` : ''} — ${r.name}` }, h('img', { src: refUrl(r.file), alt: '', loading: 'lazy' }), h('i', {}, String(i + 1)))));
  }
  const pickAll = h('input', { type: 'checkbox', 'aria-label': 'Select every shot' });
  const batch = h('div', { class: 'sq-batch', hidden: true });
  const board = h('div', { class: 'sq-board', role: 'list', 'aria-label': 'Shots in order' });
  const banner = h('div', { class: 'sq-banner', hidden: true });
  const video = h('video', { playsinline: true, controls: true, preload: 'metadata' });
  // Compare: bands across one frame — blockout, start still, then each generated version — split by draggable seams.
  // `over` is the newest generated version (the first video band); `extra` holds older takes and other models.
  const over = h('video', { class: 'sq-over', playsinline: true, muted: true, preload: 'auto', hidden: true, 'aria-hidden': 'true' });
  const stillLayer = h('img', { class: 'sq-over sq-still', alt: '', hidden: true, 'aria-hidden': 'true', draggable: false });
  const extra = [0, 1, 2].map(() => h('video', { class: 'sq-over', playsinline: true, muted: true, preload: 'auto', hidden: true, 'aria-hidden': 'true' }));
  // First-use hint, gone after a seam is moved once.
  const seamHint = h('span', { class: 'sq-seam-hint', hidden: localStorage.getItem('previs.seq.seamHint') === '0' }, 'Drag a seam · ← → keys');
  const seamUsed = () => { if (seamHint.hidden) return; seamHint.hidden = true; localStorage.setItem('previs.seq.seamHint', '0'); };
  const seamLayer = h('div', { class: 'sq-seams', hidden: true }, seamHint);
  let bands: { src: BandSource; el: HTMLVideoElement | HTMLImageElement }[] = [], stops: number[] = [], seams: HTMLElement[] = [], tags: HTMLElement[] = [];
  let sweepRaf = 0, bandKey = '';
  const paintStops = () => {
    bands.forEach((b, k) => { if (k) b.el.style.clipPath = `inset(0 0 0 ${stops[k - 1]}%)`; });
    seams.forEach((sm, i) => { sm.style.left = `${stops[i]}%`; sm.setAttribute('aria-valuenow', String(Math.round(stops[i]!))); });
    tags.forEach((t, k) => { const l = k ? stops[k - 1]! : 0, r = k < stops.length ? stops[k]! : 100; t.style.left = `${(l + r) / 2}%`; t.hidden = r - l < 7; });
  };
  const stopSweep = () => { cancelAnimationFrame(sweepRaf); sweepRaf = 0; };
  // Once per shot and session: the seams slide in from the right, then wait for the user.
  const swept = new Set<string>();
  function sweepOnce(key: string) {
    if (swept.has(key) || matchMedia('(prefers-reduced-motion: reduce)').matches) { stops = bandStops(bands.length); paintStops(); return; }
    swept.add(key); const t0 = performance.now(), ms = 1800;
    const step = (now: number) => { sweepRaf = 0; if (!bands.length) return; stops = sweepStops(bands.length, Math.min(1, (now - t0) / ms)); paintStops(); if (now - t0 < ms) sweepRaf = requestAnimationFrame(step); };
    sweepRaf = requestAnimationFrame(step);
  }
  function seamEl(i: number) {
    const left = () => bands[i]?.src.label || '', right = () => bands[i + 1]?.src.label || '';
    const sm = h('div', { class: 'sq-seam', role: 'slider', tabindex: 0, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': `Seam ${i + 1}: ${left()} left, ${right()} right` }, h('span', { class: 'sq-seam-grip' }));
    sm.onpointerdown = ev => {
      ev.preventDefault(); stopSweep(); sm.setPointerCapture(ev.pointerId); seamUsed();
      const box = seamLayer.getBoundingClientRect();
      const move = (e: PointerEvent) => { stops = moveStop(stops, i, ((e.clientX - box.left) / box.width) * 100); paintStops(); };
      move(ev); sm.onpointermove = move; sm.onpointerup = () => { sm.onpointermove = null; };
    };
    sm.onkeydown = ev => { if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') { ev.preventDefault(); stopSweep(); seamUsed(); stops = moveStop(stops, i, stops[i]! + (ev.key === 'ArrowLeft' ? -5 : 5) * (ev.shiftKey ? 4 : 1)); paintStops(); } };
    return sm;
  }
  /** Lay out the compare bands for a shot: one layer per band, n − 1 seams, a label per band. */
  function setBands(list: { src: BandSource; url: string }[], key: string) {
    const vids = [over, ...extra]; let vi = 0;
    bands = list.map((b, k) => {
      if (k === 0) return { src: b.src, el: video };
      const el = b.src.kind === 'image' ? stillLayer : vids[vi++]!;
      if (el instanceof HTMLImageElement) { if (!el.src.endsWith(b.url)) el.src = b.url; } else if (!el.src.endsWith(b.url)) el.src = b.url;
      el.hidden = false; el.classList.remove('dissolve'); el.style.opacity = '';
      return { src: b.src, el };
    });
    for (const v of vids.slice(vi)) { v.hidden = true; v.pause(); }
    if (!list.some(b => b.src.kind === 'image')) stillLayer.hidden = true;
    seams = list.slice(1).map((_, i) => seamEl(i));
    tags = list.map(b => h('span', { class: `sq-band-tag r-${b.src.role}` }, b.src.label));
    seamLayer.replaceChildren(...tags, ...seams, seamHint); seamLayer.hidden = false;
    // A redraw of the same bands keeps the seams where they are (and lets a running sweep finish).
    if (key === bandKey && stops.length === list.length - 1) paintStops(); else { stopSweep(); bandKey = key; sweepOnce(key); }
    follow(); if (!video.paused) for (const v of followers()) void v.play().catch(() => {});
  }
  const followers = () => [over, ...extra].filter(v => !v.hidden);
  // Keep the overlays in step with the main player (which owns the controls).
  const follow = () => { for (const o of followers()) if (Math.abs(o.currentTime - video.currentTime) > 0.06) o.currentTime = Math.min(video.currentTime, o.duration > 0 ? o.duration : video.currentTime); };
  video.addEventListener('play', () => { if (!over.hidden) { follow(); if (over.duration > 0 && video.currentTime >= over.duration) { video.pause(); return; } for (const o of followers()) void o.play().catch(() => {}); } });
  video.addEventListener('pause', () => { for (const o of [over, ...extra]) o.pause(); });
  video.addEventListener('seeked', follow);
  video.addEventListener('timeupdate', follow);
  video.addEventListener('ratechange', () => { for (const o of followers()) o.playbackRate = video.playbackRate; });
  video.addEventListener('ended', () => { if (!over.hidden) { over.pause(); if (over.duration > 0) over.currentTime = Math.min(video.currentTime, over.duration); } });
  over.addEventListener('ended', () => { if (!over.hidden) { video.pause(); video.currentTime = Math.min(video.currentTime, over.duration); } });
  const compareOff = () => {
    for (const o of [over, ...extra]) { o.hidden = true; o.pause(); o.style.clipPath = ''; o.classList.remove('dissolve'); }
    stillLayer.hidden = true; seamLayer.hidden = true; bands = []; comparisonInfo.hidden = true; comparisonPosition.hidden = true; overlayOff();
  };

  // ---------- Overlay: the blockout's boxes, leader lines to cast chips, the generated frame dissolving in under them ----------
  const SVG = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(SVG, 'svg'); svg.setAttribute('viewBox', '0 0 1600 900'); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('class', 'sq-ov-svg');
  const ovLayer = h('div', { class: 'sq-ov', hidden: true, 'aria-label': 'Overlay: the objects the shot camera sees, with their cast images and prompt words' });
  ovLayer.append(svg);
  let ov: { s: Shot; items: { id: string; color: string; side: 'l' | 'r'; y: number; g: SVGGElement; rect: SVGRectElement; line: SVGLineElement; dot: SVGCircleElement }[]; cache: Map<number, Box[]>; frame: number; raf: number } | null = null;
  const CHIP_H = 0.17, CHIP_W = 0.2, CHIP_PAD = 0.014;
  const boxesFor = (s: Shot, t: number) => { try { return ctx.boxes?.(s, Math.max(0, Math.min(s.duration, t))) || []; } catch { return []; } };
  function overlayOff() { if (ov) cancelAnimationFrame(ov.raf); ov = null; ovLayer.hidden = true; ovLayer.replaceChildren(svg); svg.replaceChildren(); }
  function overlayOn(s: Shot) {
    overlayOff();
    const p = P(), byId = new Map(p.scene.entities.map(e => [e.id, e]));
    const segs = autoPromptSegments(p, s, 'video'), words = (id: string) => segs.find(x => (x as { ids?: string[] }).ids?.includes(id));
    const cast = overlayCast(shotObjects(p, s).map(c => ({ id: c.entity.id, kind: c.entity.kind, lead: c.lead, coverage: c.coverage, hero: words(c.entity.id) ? 2 : objectLooks(p, c.entity.id).length ? 1 : 0 })));
    const ids = new Set(cast.map(c => c.id));
    // Chips are placed once, from where each object sits through the shot; boxes and lines follow every frame.
    const seen = new Map<string, Box>();
    for (const u of [0.5, 0.25, 0.75, 0, 1]) for (const b of boxesFor(s, s.duration * u)) if (ids.has(b.id) && !seen.has(b.id)) seen.set(b.id, b);
    const slots = layoutChips(cast.map(c => seen.get(c.id)).filter(Boolean) as Box[], CHIP_H, 0.04, 0.08);
    const items = slots.map(slot => {
      const e = byId.get(slot.id)!, color = (KIND_COLORS as Record<string, string>)[e.kind] || '#3B5BA9';
      const g = document.createElementNS(SVG, 'g'), rect = document.createElementNS(SVG, 'rect'), line = document.createElementNS(SVG, 'line'), dot = document.createElementNS(SVG, 'circle');
      dot.setAttribute('r', '6'); g.setAttribute('style', `--c:${color}`); g.append(rect, line, dot); svg.append(g);
      const look = objectLooks(p, e.id)[0], seg = words(e.id);
      const chip = h('div', { class: `sq-chip ${slot.side}`, style: `--c:${color};top:${slot.y * 100}%;height:${CHIP_H * 100}%;width:${CHIP_W * 100}%;${slot.side === 'l' ? 'left' : 'right'}:${CHIP_PAD * 100}%` },
        look ? h('img', { src: refUrl(look.file), alt: '', loading: 'lazy' }) : h('span', { class: 'sq-chip-swatch' }),
        h('span', { class: 'sq-chip-t' }, h('b', {}, e.name), h('span', {}, seg ? `“${promptExcerpt(seg.text)}”` : e.kind)));
      chip.onpointerenter = () => g.classList.add('hot'); chip.onpointerleave = () => g.classList.remove('hot');
      ovLayer.append(chip);
      return { id: e.id, color, side: slot.side, y: slot.y, g, rect, line, dot };
    });
    ov = { s, items, cache: new Map(), frame: -1, raf: 0 };
    ovLayer.hidden = false;
    const tick = () => {
      if (!ov) return;
      const f = Math.round(Math.min(video.currentTime || 0, s.duration) * 24);
      if (f !== ov.frame) {
        ov.frame = f;
        let list = ov.cache.get(f); if (!list) { list = boxesFor(s, f / 24); ov.cache.set(f, list); }
        const at = new Map(list.map(b => [b.id, b]));
        for (const it of ov.items) {
          const b = at.get(it.id); it.g.style.display = b ? '' : 'none'; if (!b) continue;
          it.rect.setAttribute('x', String(b.x0 * 1600)); it.rect.setAttribute('y', String(b.y0 * 900)); it.rect.setAttribute('width', String((b.x1 - b.x0) * 1600)); it.rect.setAttribute('height', String((b.y1 - b.y0) * 900));
          const [fx, fy] = leaderFrom(b, it.side), cx = it.side === 'l' ? CHIP_PAD + CHIP_W : 1 - CHIP_PAD - CHIP_W;
          it.line.setAttribute('x1', String(fx * 1600)); it.line.setAttribute('y1', String(fy * 900)); it.dot.setAttribute('cx', String(fx * 1600)); it.dot.setAttribute('cy', String(fy * 900)); it.line.setAttribute('x2', String(cx * 1600)); it.line.setAttribute('y2', String((it.y + CHIP_H / 2) * 900));
        }
      }
      ov.raf = requestAnimationFrame(tick);
    };
    tick();
  }
  const empty = h('div', { class: 'sq-empty' });
  const abSeg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Version' });
  const caption = h('div', { class: 'sq-caption' });
  const setCaption = (t: string) => { caption.textContent = t; caption.title = t; };
  const comparisonInfo = h('div', { class: 'sq-comparison-info', hidden: true });
  const comparisonPosition = h('div', { class: 'sq-comparison-position mono', hidden: true });
  const position = (label: string, v: HTMLVideoElement) => `${label} ${v.currentTime.toFixed(3)} s${v.duration > 0 && v.currentTime >= v.duration - 0.0005 ? ' · ended' : ''}`;
  const syncPosition = () => { if (!over.hidden) comparisonPosition.textContent = `${position('Blockout', video)} / ${position('Generated', over)}`; };
  for (const v of [video, over]) for (const name of ['timeupdate', 'seeked', 'pause', 'ended', 'loadedmetadata']) v.addEventListener(name, syncPosition);
  const playSeqBtn = h('button', { class: 'btn sq-playcut', type: 'button' }, '▶ Play cut');
  const exportBtn = h('button', { class: 'btn camera', type: 'button' }, 'Export film');
  const exportStatus = h('div', { class: 'status-line' });
  const exportsList = h('div', { class: 'sq-exports' });
  const totals = h('span', { class: 'muted mono' });
  // The viewer sits on top at the full content width; the shot rows follow below it.
  const el = h('section', { class: 'sequence', hidden: true, 'aria-label': 'Cut' },
    h('div', { class: 'sq-main' },
      h('aside', { class: 'sq-viewer' },
        h('div', { class: 'sq-screen' }, video, stillLayer, over, ...extra, ovLayer, seamLayer, empty),
        h('div', { class: 'sq-ctl' },
          h('div', { class: 'sq-vbar' }, abSeg, caption), comparisonInfo, comparisonPosition,
          h('div', { class: 'sq-vbar sq-playbar' }, playSeqBtn, totals),
          h('div', { class: 'sq-export' }, h('div', { class: 'sq-vbar' }, exportBtn, h('span', { class: 'note' }, '1280×720 · 24 fps · H.264, in shot order')), exportStatus, exportsList))),
      h('div', { class: 'sq-toolbar' },
        h('label', { class: 'sq-pickall' }, pickAll, 'All'),
        h('label', { class: 'sq-model' }, 'Video model', modelSel),
        h('label', { class: 'sq-pickall', title: 'Send the image of every cast member the shot camera sees (plus environment, style and key frame) with the request' }, useRefs, 'Send cast images'), quoteBtn, h('span', { style: 'flex:1' }), allReady, renderAllBtn),
      banner, batch, board));

  // ---------- Board ----------
  let dragFrom = -1;
  function row(s: Shot, i: number) {
    const p = P(), c = clipFor(s), inCut = !!c, a = media(s, c), job = activeJob(s), b = blockout(s), res = results(s);
    const thumb = h('canvas', { width: 160, height: 90, title: a?.kind === 'workflow-result' ? `The version in the cut: ${(a.source.workflow || 'generated').split(' ·')[0]}` : 'The blockout' });
    // The thumbnail shows the version the cut plays: a generated frame when there is one, else the blockout.
    const cached = a?.kind === 'workflow-result' ? frames.get(a.id) : undefined;
    if (cached instanceof HTMLCanvasElement) thumb.getContext('2d')?.drawImage(cached, 0, 0);
    else requestAnimationFrame(() => { try { thumb.getContext('2d')!.drawImage(ctx.thumbnail(s, 160, 90), 0, 0); } catch {} if (a?.kind === 'workflow-result') void frameOf(a).then(f => { if (f) thumb.getContext('2d')?.drawImage(f, 0, 0); }); });
    const pick = h('input', { type: 'checkbox', checked: picked.has(s.id), 'aria-label': `Select shot ${i + 1} for generation` });
    pick.onchange = () => { pick.checked ? picked.add(s.id) : picked.delete(s.id); syncPickAll(); };
    // A starter's bundled clip is not this shot's own blockout (generating makes that first), but it is not missing either.
    const bundled = !s.render && starterBlockout(p, s);
    const bState = !s.render ? (bundled ? ['none', bundled.fresh === false ? 'Starter blockout · older' : 'Starter blockout'] : ['missing', 'No blockout']) : fresh(s) ? ['ok', 'Blockout ready'] : ['stale', 'Blockout changed'];
    const older = a?.kind === 'workflow-result' && videoStale(p, s, a);
    const gState = job ? ['run', `Generating · ${job.status}`] : res.length ? (older ? ['stale', `${res.length} generated · older`] : ['ok', `${res.length} generated`]) : ['none', 'Not generated'];
    const version = h('select', { class: 'field', 'aria-label': `Version of shot ${i + 1} in the cut`, title: 'Newest uses the latest generated video, or the blockout if there is none', disabled: !inCut },
      h('option', { value: '' }, 'Newest'),
      ...res.map((x, k) => { const cam = cameraOf(x); return h('option', { value: x.id, selected: c?.assetId === x.id, title: cam ? CAMERA_SOURCE_LABELS[cam] : '' }, `${cam ? CAMERA_SOURCE_GLYPHS[cam] + ' ' : ''}Generated ${res.length - k} · ${(x.source.workflow || '').split(' ·')[0]}`); }),
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
    const trimIn = trim('in'), trimOut = trim('out'), moveUp = move(-1), moveDown = move(1), open = h('button', { class: 'btn ghost sm', type: 'button', title: 'Open this shot in the scene', onclick: (ev: Event) => { ev.stopPropagation(); ctx.openShot(s.id); } }, 'Open');
    // [live-progress] A new version's progress, separate from the version selected for the cut.
    const progress = job ? progressSlot(p.id, 'generation', job.id, `Shot ${i + 1} new version`, 'cut') : null;
    if (ctx.rowTemplate) return ctx.rowTemplate({ s, i, count: p.shots.length, on: s.id === selected, inCut, thumb, pick, version, trimIn, trimOut, include, moveUp, moveDown, open, bState, gState, progress, select: () => select(s.id), reorder });
    const el = h('div', { class: 'sq-row' + (s.id === selected ? ' on' : '') + (inCut ? '' : ' out'), role: 'listitem', draggable: true, tabindex: 0, 'aria-label': `Shot ${i + 1} ${s.title}` },
      h('span', { class: 'sq-grip', title: 'Drag to reorder', 'aria-hidden': 'true' }, '⋮⋮'), pick,
      h('span', { class: 'sq-num mono' }, String(i + 1).padStart(2, '0')),
      thumb,
      h('div', { class: 'sq-title' }, h('strong', { title: s.title }, s.title), h('span', { class: 'muted', title: a ? `The cut uses the ${a.kind === 'workflow-result' ? 'generated video' : 'blockout'}` : '' }, `${s.duration}s${a ? ` · cut uses ${a.kind === 'workflow-result' ? 'generated' : 'blockout'}` : ''}`), castLine(s)),
      h('div', { class: 'sq-cell' }, h('span', { class: `sq-st ${bState[0]}` }, bState[1]),
        h('div', { class: 'sq-acts' },
          b ? h('button', { class: 'btn sm', type: 'button', 'aria-label': `Play the blockout of shot ${i + 1}`, title: 'Play the blockout', onclick: (ev: Event) => { ev.stopPropagation(); select(s.id, 'blockout'); } }, '▶') : null,
          h('button', { class: 'btn sm', type: 'button', disabled: busy, 'aria-label': `${s.render ? 'Remake' : 'Make'} the blockout of shot ${i + 1}`, onclick: (ev: Event) => { ev.stopPropagation(); void renderShots([s]); } }, s.render ? 'Remake blockout' : 'Make blockout'))),
      h('div', { class: 'sq-cell' }, h('span', { class: `sq-st ${gState[0]}` }, gState[1]), progress,
        h('div', { class: 'sq-acts' },
          res.length ? h('button', { class: 'btn sm', type: 'button', 'aria-label': `Play the generated video of shot ${i + 1}`, title: 'Play the generated video', onclick: (ev: Event) => { ev.stopPropagation(); select(s.id, 'generated'); } }, '▶') : null,
          h('button', { class: 'btn sm', type: 'button', disabled: busy || !!job, title: 'Generate this shot with the selected model', 'aria-label': `Generate shot ${i + 1}`, onclick: (ev: Event) => { ev.stopPropagation(); picked = new Set([s.id]); void quote(); } }, 'Generate'))),
      h('div', { class: 'sq-cell sq-cut' }, h('div', { class: 'sq-ver' }, version, camGlyph(a)), h('div', { class: 'sq-trim' }, trimIn, h('span', { class: 'muted' }, '→'), trimOut)),
      h('div', { class: 'sq-side' }, include, h('div', { class: 'sq-move' }, moveUp, moveDown), open));
    el.onclick = ev => { if ((ev.target as HTMLElement).closest('input,select,button')) return; select(s.id); };
    el.onkeydown = ev => { if (ev.target !== el) return; if (ev.key === 'Enter') select(s.id); if (ev.altKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) { ev.preventDefault(); void reorder(i, i + (ev.key === 'ArrowUp' ? -1 : 1)); } };
    el.ondragstart = ev => { dragFrom = i; ev.dataTransfer?.setData('text/plain', String(i)); el.classList.add('dragging'); };
    el.ondragend = () => el.classList.remove('dragging');
    el.ondragover = ev => { ev.preventDefault(); el.classList.add('drop'); };
    el.ondragleave = () => el.classList.remove('drop');
    el.ondrop = ev => { ev.preventDefault(); el.classList.remove('drop'); if (dragFrom >= 0 && dragFrom !== i) void reorder(dragFrom, i); dragFrom = -1; };
    return el;
  }
  /** A generated version's mid-clip frame at 160×90 (cover), decoded once per version. */
  const frames = new Map<string, HTMLCanvasElement | Promise<HTMLCanvasElement | null>>();
  function frameOf(a: Asset): Promise<HTMLCanvasElement | null> {
    const hit = frames.get(a.id); if (hit) return Promise.resolve(hit);
    const job = new Promise<HTMLCanvasElement | null>(resolve => {
      const v = document.createElement('video'); v.muted = true; v.preload = 'auto'; v.playsInline = true;
      const done = (c: HTMLCanvasElement | null) => { v.removeAttribute('src'); v.load(); if (c) frames.set(a.id, c); else frames.delete(a.id); resolve(c); };
      v.onloadedmetadata = () => { v.currentTime = Math.max(0, (v.duration || a.duration || 0) / 2); };
      v.onseeked = () => {
        const c = document.createElement('canvas'); c.width = 160; c.height = 90;
        const k = Math.max(160 / (v.videoWidth || 160), 90 / (v.videoHeight || 90)), w = (v.videoWidth || 160) * k, hh = (v.videoHeight || 90) * k;
        try { c.getContext('2d')!.drawImage(v, (160 - w) / 2, (90 - hh) / 2, w, hh); done(c); } catch { done(null); }
      };
      v.onerror = () => done(null);
      v.src = ctx.assetUrl(a);
    });
    frames.set(a.id, job);
    return job;
  }
  // Who is in the shot, and which cast images will be sent with the video request.
  function castLine(s: Shot) {
    const cast = shotCast(P(), s).filter(c => c.entity.kind !== 'environment');
    const refs = useRefs.checked && modelSel.value ? plannedReferences(P(), s, gen, modelSel.value) : [];
    // Only flag objects big enough in frame to matter.
    const missing = cast.filter(c => (c.lead || c.coverage >= 0.15) && !objectLooks(P(), c.entity.id).length).map(c => c.entity.name);
    return h('span', { class: 'sq-cast' },
      refs.length ? refStrip(refs.map(r => ({ file: r.ref.file, name: r.ref.name, label: r.label, role: r.role }))) : null,
      h('span', { class: 'muted', title: cast.map(c => `${c.entity.name} · ${Math.round(c.coverage * 100)}% of frame`).join('\n') }, cast.length ? `In shot: ${cast.slice(0, 4).map(c => c.entity.name).join(', ')}${cast.length > 4 ? ` +${cast.length - 4}` : ''}` : 'No objects in frame'),
      missing.length ? h('span', { class: 'sq-nolook', title: `${missing.join(', ')} ${missing.length === 1 ? 'has' : 'have'} no cast image yet — open Cast images in the Library to make one` }, `${missing.length} without a cast image`) : null);
  }
  async function reorder(from: number, to: number) {
    const p = P(); if (to < 0 || to >= p.shots.length) return;
    const before = p.shots.map(s => s.id), ids = [...before]; const [m] = ids.splice(from, 1); ids.splice(to, 0, m);
    const cutBefore = structuredClone(p.edit?.clips || []);
    // Keep the cut in shot order too.
    const cut = p.edit?.clips?.length ? ids.flatMap(id => p.edit!.clips.filter(c => c.shotId === id)) : null;
    await ctx.runEntry({ label: 'Reorder shots', redo: [{ op: 'reorder_shots', ids }, ...(cut ? [{ op: 'set_edit', clips: cut }] : [])], undo: [{ op: 'reorder_shots', ids: before }, ...(cut ? [{ op: 'set_edit', clips: cutBefore }] : [])] });
  }
  const syncPickAll = () => { const n = P().shots.length; pickAll.checked = picked.size === n; pickAll.indeterminate = picked.size > 0 && picked.size < n; quoteBtn.textContent = picked.size ? `Quote ${picked.size} shot${picked.size === 1 ? '' : 's'}${estShots()}` : 'Quote selected'; quoteBtn.disabled = busy || !picked.size; quoteBtn.title = picked.size ? 'Estimate the cost of the ticked shots. Nothing is sent until you approve.' : 'Tick shots on the board (or All) to quote them'; };
  pickAll.onchange = () => { picked = pickAll.checked ? new Set(P().shots.map(s => s.id)) : new Set(); draw(); };

  // ---------- Viewer ----------
  let seq: { list: { s: Shot; a: Asset; c: EditClip }[]; i: number } | null = null;
  let pinned: Asset | null = null; // an export being watched
  function select(id: string, v?: typeof view) { selected = id; pinned = null; if (v) view = v; stopSeq(); draw(); revealViewer(); }
  /** Picking a shot further down the board brings the viewer back into view. */
  function revealViewer() {
    const main = el.querySelector<HTMLElement>('.sq-main'), screen = el.querySelector<HTMLElement>('.sq-screen');
    if (!main || !screen || ctx.rowTemplate) return;
    if (screen.getBoundingClientRect().top < main.getBoundingClientRect().top - 8) main.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
  function watchExport(a: Asset) { compareOff(); stopSeq(); selected = ''; pinned = a; abSeg.replaceChildren(); abSeg.hidden = true; setCaption(`Export v${a.version ?? 1} · ${a.source.clips?.length ?? 0} clips · ${sec(a.duration)}`); show(a); void video.play().catch(() => {}); drawBoard(); }
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
    if (!s) { compareOff(); abSeg.replaceChildren(); setCaption(''); show(null, 0, 'Pick a shot to watch it, or play the whole cut.'); return; }
    const generated = results(s)[0], b = blockout(s);
    if (view !== 'blockout' && !generated && b) view = 'blockout';
    if (view === 'overlay' && !b) view = generated ? 'generated' : 'blockout';
    const TITLES = { blockout: 'The blockout this shot was made from', generated: 'The version in the cut', compare: 'Blockout, start still and every generated version, split by draggable seams', overlay: 'Boxes around what the shot camera sees, linked to each cast image and its words in the prompt; the generated frame fades in under them' };
    abSeg.replaceChildren(...(['blockout', 'generated', 'compare', 'overlay'] as const).map(k => h('button', { type: 'button', role: 'radio', 'aria-checked': String(view === k), class: view === k ? 'on' : '', title: TITLES[k], disabled: k === 'blockout' || k === 'overlay' ? !b : !generated, onclick: () => { view = k; drawViewer(); } }, k === 'blockout' ? 'Blockout' : k === 'compare' ? 'Compare' : k === 'overlay' ? 'Overlay' : 'Generated')));
    const c = clipFor(s), chosen = c?.assetId ? videos(s).find(x => x.id === c.assetId) : null;
    const genPick = chosen?.kind === 'workflow-result' ? chosen : generated;
    const bPick = view === 'compare' || view === 'overlay' ? comparisonSource(renders(s), genPick || null) || (view === 'overlay' ? b : null) : chosen?.kind === 'camera-render' ? chosen : b;
    const a = view === 'generated' ? genPick : bPick;
    compareOff();
    if (view === 'compare' && genPick && bPick) {
      // Versions made from this blockout (others would not line up), the newest per model first.
      const same = results(s).filter(x => x.id === genPick.id || x.source.sourceAssetId === bPick.id);
      const ordered = [genPick, ...same.filter(x => x.id !== genPick.id)];
      const start = [...(s.references || [])].reverse().find(r => r.role === 'frame' && (r.note === 'key frame start' || !r.note)) || null;
      const list = compareBands(bPick, start, ordered.map(x => ({ id: x.id, createdAt: x.id === genPick.id ? '9999' : x.createdAt, source: x.source })));
      setBands(list.map(src => ({ src, url: src.role === 'still' ? refUrl(start!.file) : ctx.assetUrl(videos(s).find(x => x.id === src.id)!) })), `${s.id}:${list.map(x => x.id).join()}`);
      comparisonInfo.hidden = false; comparisonPosition.hidden = false;
      const task = gen.jobs.find(j => j.id === genPick.source.jobId)?.definition?.task;
      comparisonInfo.textContent = comparisonFacts(bPick, genPick) + (task === 'first-frame' ? '\nThis model animates between your start and end stills; it did not see the camera move.' : '');
      syncPosition();
    } else if (view === 'overlay' && bPick) {
      if (genPick) { const url = ctx.assetUrl(genPick); if (!over.src.endsWith(url)) over.src = url; over.hidden = false; over.classList.add('dissolve'); follow(); if (!video.paused) void over.play().catch(() => {}); }
      overlayOn(s);
    }
    const model = (x: Asset) => (x.source.workflow || 'generated').split(' ·')[0];
    setCaption(`Shot ${no(p, s.id)} · ${s.title}${view === 'compare' && genPick ? ` · ${bands.length ? bands.map(x => x.src.label).join(' · ') : model(genPick)}${bPick ? '' : ' · original source unavailable'}` : view === 'overlay' && bPick ? ` · overlay on blockout v${bPick.version ?? 1}${genPick ? ` → ${model(genPick)}` : ''}` : a ? ` · ${a.kind === 'workflow-result' ? model(a) : `blockout v${a.version ?? 1}`} · ${sec(a.duration)}` : ''}`);
    if (show(a || null, 0, view === 'compare' ? 'The blockout this video was made from is no longer available. A newer blockout is not swapped in.' : view === 'generated' ? 'No generated video yet.' : 'No blockout yet. Use Make blockout on the board.', false) && a) void video.play().catch(() => {});
  }
  function cutList() { return P().shots.map(s => ({ s, c: clipFor(s)!, a: media(s)! })).filter(x => x.c && x.a); }
  function stopSeq() { if (!seq) return; seq = null; playSeqBtn.textContent = '▶ Play cut'; video.pause(); }
  function playAt(i: number) {
    if (!seq) return;
    seq.i = i; const x = seq.list[i];
    if (!x) { stopSeq(); drawViewer(); return; }
    selected = x.s.id; drawBoard();
    setCaption(`Cut · ${i + 1} / ${seq.list.length} · Shot ${no(P(), x.s.id)} ${x.s.title}`);
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
    totals.textContent = `${list.length} of ${p.shots.length} shots · ${total.toFixed(2)}s${missing ? ` · ${missing} without a blockout` : ''}`;
    exportBtn.disabled = busy || !list.length || missing > 0;
    exportBtn.title = missing ? 'Make a blockout for every shot in the cut first' : '';
    ctx.onExportState?.({ ok: !!list.length && !missing, busy, reason: !list.length ? 'Nothing in the cut yet' : missing ? `Make a blockout for every shot in the cut first (${missing} missing)` : '' });
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
    batch.hidden = false; batch.replaceChildren(h('div', { class: 'sq-batch-head' }, h('strong', {}, `Making ${list.length} blockout${list.length === 1 ? '' : 's'}`), status), h('div', { class: 'progress' }, bar));
    try {
      for (const [k, s] of list.entries()) {
        const label = `Shot ${no(P(), s.id)} ${s.title}`;
        await ctx.capture(s, { onStatus: t => { status.textContent = `${label} · ${t}`; }, onFrame: (_u, i, n) => { status.textContent = `${label} · frame ${i + 1}/${n}`; bar.style.width = `${((k + (i + 1) / n) / list.length) * 100}%`; } });
      }
      batch.hidden = true; toast(`Made ${list.length} blockout${list.length === 1 ? '' : 's'}`);
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
    modelSel.replaceChildren(...choice().map(d => h('option', { value: d.id }, `${modelLabel(d)}${referenceCapacity(gen, d.id) ? ` · up to ${referenceCapacity(gen, d.id)} images` : ''}`)));
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
          const { job, est, refs, cameraSource } = await bindAndQuote(s);
          quoted.push({ shot: s, est, refs, cameraSource, ok: !!job.validation?.compatible, issue: job.validation?.compatible ? undefined : (job.validation?.issues || []).map((x: any) => x.message).slice(0, 2).join('; ') || 'Not compatible' });
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
        h('td', { class: 'sq-cam' + (q.cameraSource && q.cameraSource !== 'blockout' ? ' approx' : ''), title: 'Where this video’s camera motion comes from' }, q.cameraSource ? CAMERA_SOURCE_LABELS[q.cameraSource] : ''),
        h('td', { class: 'mono' }, q.ok ? (q.est != null ? `≈ $${q.est.toFixed(3)}` : 'unknown') : ''), h('td', { class: q.ok ? 'ok' : 'muted' }, q.ok ? 'Ready' : `Skipped · ${q.issue}`))))),
      ready.length ? h('div', { class: 'sq-approve' },
        h('span', {}, `Estimated total `, h('b', { class: 'mono' }, unknownCost ? `≥ $${total.toFixed(2)}` : `≈ $${total.toFixed(2)}`), ' · Cloud totals are estimates'),
        h('label', {}, approve, 'I approve these requests, with an allowance of ', max, ' USD in total'),
        h('label', {}, unknown, 'I accept unresolved provider/runtime charges. The allowance is not a provider-enforced spending cap.'), go,
        h('p', { class: 'note', style: 'margin:0' }, 'Shots run one at a time. Each is re-checked just before it is sent; a failed or uncertain job stops the batch and is never retried.')) : h('p', { class: 'note' }, 'Nothing to generate.'));
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
        // [live-progress] Display only: reload jobs so the row shows the new version's progress while it runs
        // (the periodic refresh is paused while busy). Never affects dispatch or tracking.
        try { await loadGen(); draw(); } catch { /* tracking continues */ }
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
    banner.textContent = 'The cut has a custom order or duplicate clips. Changes here put it back in shot order.';
    const stale = p.shots.filter(s => !fresh(s)).length;
    allReady.hidden = !!stale || !p.shots.length; renderAllBtn.hidden = !stale;
    renderAllBtn.disabled = busy;
    // Shots that only have a starter's clip still need their own blockout before a quote, but nothing is missing.
    const absent = p.shots.filter(s => !s.render && !starterBlockout(p, s)).length;
    renderAllBtn.textContent = `Make ${stale}${absent === stale ? ' missing' : ''} blockout${stale === 1 ? '' : 's'}`;
    drawBoard(); syncPickAll(); drawExports();
    if (!seq) drawViewer();
  }
  let timer = 0;
  return {
    el, parts: { viewer: el.querySelector<HTMLElement>('.sq-viewer')!, board, batch, toolbar: el.querySelector<HTMLElement>('.sq-toolbar')! }, // [mobile]
    mobile(o: Pick<SequenceCtx, 'rowTemplate'>) { Object.assign(ctx, o); if (!el.hidden) draw(); }, // [mobile]
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
    /** Export the film (the Cut view's Export film), from the workspace top bar. */
    exportFilm() { if (!exportBtn.disabled) exportBtn.click(); else toast(exportBtn.title || 'Nothing to export yet'); },
    /** Select a shot and show it in the viewer (e.g. 'compare'). Call after switching to the Cut step. */
    open(shotId: string, v: typeof view = 'generated') {
      if (!P().shots.some(s => s.id === shotId)) return;
      pinned = null; selected = shotId; view = v; stopSeq(); draw();
      requestAnimationFrame(() => board.querySelector('.sq-row.on')?.scrollIntoView({ block: 'nearest' }));
    },
  };
}
