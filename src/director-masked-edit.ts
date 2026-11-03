// Fixed-mask region edit UI for Take lab (experimental). Authoring + quote review only here;
// prepare/submit go through /api/director/masked-edit when Sol’s foundation lands. No direct provider calls.
import { api, h, toast, DEMO } from './director-common';
import type { DirectorProject, Asset, Shot } from '../shared/director.mjs';
import type { VideoTake } from '../shared/takes.mjs';

export const MASKED_EDIT_FRAMES = [81, 89, 113] as const;
export const MASKED_EDIT_SIZE: { width: number; height: number; fps: number } = { width: 1280, height: 720, fps: 24 };
const FEATHER_DEFAULT = 8;
const MAX_STROKES = 64;
const MAX_POINTS = 4000;

export type MaskStroke = { tool: 'brush' | 'erase'; size: number; points: { x: number; y: number }[] };
export type FixedMask = {
  v: 1; mode: 'fixed'; width: number; height: number; coordinateSpace: 'source-pixels';
  strokes: MaskStroke[]; featherPx: number;
  rect?: { x: number; y: number; w: number; h: number };
};

export type MaskedEditCtx = {
  project(): DirectorProject;
  assetUrl(a: Asset): string;
  focusReturn?: HTMLElement | null;
};

/** Offline-safe eligibility for the fixed-mask envelope (UX-AND-TESTS.md). */
export function maskedEditEligibility(asset: Pick<Asset, 'kind' | 'mime' | 'width' | 'height' | 'fps' | 'frameCount' | 'duration'> | null | undefined) {
  if (!asset) return { ok: false as const, reason: 'This take’s original media or provenance is unavailable. Restore it before editing.' };
  const a = asset;
  if (a.width !== MASKED_EDIT_SIZE.width || a.height !== MASKED_EDIT_SIZE.height
    || a.fps !== MASKED_EDIT_SIZE.fps
    || !MASKED_EDIT_FRAMES.includes(a.frameCount as typeof MASKED_EDIT_FRAMES[number])) {
    return {
      ok: false as const,
      reason: 'This preview supports silent 720p / 24 fps takes with 81, 89 or 113 frames. Nothing changed.',
      detail: `This take: ${a.width}×${a.height} · ${a.fps} fps · ${a.frameCount} frames.`,
    };
  }
  return { ok: true as const };
}

/** Planning estimate mirror of server estimateMaskedVaceCost (crop-scaled historical calibration). */
export function estimateMaskedEditUsd(crop: { width: number; height: number }, frames: number) {
  const basisGpu = 248.2, basisPx = 399_360, basisFrames = 81;
  const gpu = basisGpu * ((crop.width * crop.height) / basisPx) * (frames / basisFrames);
  const estimate = Math.round((gpu * 0.266 / 211) * 10000) / 10000;
  const reservationRequiredUsd = Math.round(estimate * 1.1 * 10000) / 10000;
  return { estimate, reservationRequiredUsd, currency: 'USD' as const, providerEnforcedCap: false as const };
}

/** Axis-aligned crop around nonzero painted support + pad, 16-aligned, minima from INTEGRATION.md. */
export function cropAroundMask(mask: FixedMask, frame = MASKED_EDIT_SIZE) {
  let minX = frame.width, minY = frame.height, maxX = -1, maxY = -1;
  if (mask.rect && mask.rect.w > 0 && mask.rect.h > 0) {
    minX = Math.floor(mask.rect.x); minY = Math.floor(mask.rect.y);
    maxX = Math.ceil(mask.rect.x + mask.rect.w) - 1; maxY = Math.ceil(mask.rect.y + mask.rect.h) - 1;
  }
  for (const s of mask.strokes) for (const p of s.points) {
    const r = Math.ceil(s.size / 2);
    minX = Math.min(minX, Math.floor(p.x - r)); minY = Math.min(minY, Math.floor(p.y - r));
    maxX = Math.max(maxX, Math.ceil(p.x + r)); maxY = Math.max(maxY, Math.ceil(p.y + r));
  }
  if (maxX < minX || maxY < minY) return null;
  const pad = 32;
  let x = Math.max(0, minX - pad), y = Math.max(0, minY - pad);
  let w = Math.min(frame.width, maxX + pad + 1) - x, h = Math.min(frame.height, maxY + pad + 1) - y;
  const grow = (need: number, cur: number, roomBefore: number, roomAfter: number) => {
    let add = Math.max(0, need - cur), before = Math.min(roomBefore, Math.ceil(add / 2)), after = Math.min(roomAfter, add - before);
    before += Math.min(roomBefore - before, add - before - after);
    return { before, after: add - before > after ? after + (add - before - after) : after };
  };
  while (w < 320 || h < 320 || w * h < 153_600) {
    if (w < 320 || w * h < 153_600) {
      const g = grow(Math.max(320, Math.ceil(153_600 / Math.max(h, 1))), w, x, frame.width - x - w);
      x -= g.before; w += g.before + g.after;
    }
    if (h < 320 || w * h < 153_600) {
      const g = grow(Math.max(320, Math.ceil(153_600 / Math.max(w, 1))), h, y, frame.height - y - h);
      y -= g.before; h += g.before + g.after;
    }
    if (x === 0 && y === 0 && w === frame.width && h === frame.height) break;
  }
  const align = (v: number, max: number, size: boolean) => {
    if (size) return Math.min(max, Math.ceil(v / 16) * 16);
    return Math.max(0, Math.floor(v / 16) * 16);
  };
  x = align(x, frame.width, false); y = align(y, frame.height, false);
  w = align(w, frame.width - x, true); h = align(h, frame.height - y, true);
  if (w * h > frame.width * frame.height * 0.6) return { ok: false as const, reason: 'This crop covers more than 60% of the frame. Region editing may not save money. Choose a smaller region.', crop: { x, y, w, h } };
  return { ok: true as const, crop: { x, y, w, h } };
}

export function emptyMask(width = MASKED_EDIT_SIZE.width, height = MASKED_EDIT_SIZE.height): FixedMask {
  return { v: 1, mode: 'fixed', width, height, coordinateSpace: 'source-pixels', strokes: [], featherPx: FEATHER_DEFAULT };
}

type Phase = 'paint' | 'quote' | 'active' | 'review';

export async function openMaskedEdit(ctx: MaskedEditCtx, shotId: string, take: VideoTake) {
  document.getElementById('masked-edit-dialog')?.remove();
  const P = () => ctx.project();
  const shot = (): Shot | null => P().shots.find(s => s.id === shotId) || null;
  const asset = (): Asset | null => P().assets?.find(a => a.id === take.id) || null;
  const elig = maskedEditEligibility(asset() || { kind: 'workflow-result', mime: 'video/mp4', width: take.media.width!, height: take.media.height!, fps: take.media.fps!, frameCount: take.media.frames!, duration: take.media.duration! } as Asset);
  if (DEMO) {
    toast('Region editing needs the local app and an eligible generated take.');
    return;
  }
  if (!elig.ok) {
    toast(elig.reason + (elig.detail ? ` ${elig.detail}` : ''));
    return;
  }

  let mask = emptyMask();
  let history: FixedMask[] = [structuredClone(mask)];
  let histIdx = 0;
  let tool: 'rect' | 'brush' | 'erase' = 'rect';
  let brushSize = 28;
  let prompt = '';
  let seed = 42;
  let phase: Phase = 'paint';
  let scopeChecked = false;
  let unknownAck = false;
  let allowance = 0.5;
  let quote: { estimate: number; reservationRequiredUsd: number } | null = null;
  let editId: string | null = null;
  let fingerprint: string | null = null;
  let crop: { x: number; y: number; w: number; h: number } | null = null;

  const title = h('h2', { id: 'masked-edit-title' });
  const status = h('p', { class: 'note tk-edit-status', role: 'status' });
  const body = h('div', { class: 'tk-edit-body' });
  const close = h('button', { class: 'btn ghost sm icon', type: 'button', 'aria-label': 'Close region edit' }, '✕');
  const dlg = h('dialog', { class: 'takes tk-edit', id: 'masked-edit-dialog', 'aria-labelledby': 'masked-edit-title' },
    h('div', { class: 'dialog-head' }, title, close),
    body, status);
  close.onclick = () => dlg.close();
  dlg.addEventListener('close', () => {
    dlg.remove();
    ctx.focusReturn?.focus?.();
  });

  const say = (t: string) => { status.textContent = t; };
  const pushHist = () => { history = history.slice(0, histIdx + 1); history.push(structuredClone(mask)); histIdx = history.length - 1; if (history.length > 40) { history.shift(); histIdx--; } };
  const undo = () => { if (histIdx > 0) { histIdx--; mask = structuredClone(history[histIdx]!); draw(); } };
  const redo = () => { if (histIdx < history.length - 1) { histIdx++; mask = structuredClone(history[histIdx]!); draw(); } };

  const video = h('video', {
    class: 'tk-edit-video', src: asset() ? ctx.assetUrl(asset()!) : '', muted: true, playsinline: true, preload: 'auto',
    'aria-label': `Source ${take.label}`,
  }) as HTMLVideoElement;
  const overlay = h('canvas', { class: 'tk-edit-overlay', width: MASKED_EDIT_SIZE.width, height: MASKED_EDIT_SIZE.height, 'aria-hidden': 'true' }) as HTMLCanvasElement;
  const stage = h('div', { class: 'tk-edit-stage' }, video, overlay);

  function paintOverlay() {
    const c = overlay.getContext('2d')!;
    c.clearRect(0, 0, overlay.width, overlay.height);
    c.fillStyle = 'rgba(20, 120, 200, 0.35)';
    if (mask.rect) { c.fillRect(mask.rect.x, mask.rect.y, mask.rect.w, mask.rect.h); c.strokeStyle = 'rgba(0,0,0,0.85)'; c.setLineDash([6, 4]); c.strokeRect(mask.rect.x, mask.rect.y, mask.rect.w, mask.rect.h); c.setLineDash([]); }
    for (const s of mask.strokes) {
      c.strokeStyle = s.tool === 'erase' ? 'rgba(0,0,0,1)' : 'rgba(20, 120, 200, 0.7)';
      c.lineWidth = s.size; c.lineCap = 'round'; c.lineJoin = 'round';
      if (s.tool === 'erase') c.globalCompositeOperation = 'destination-out';
      else c.globalCompositeOperation = 'source-over';
      c.beginPath();
      s.points.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
      c.stroke();
    }
    c.globalCompositeOperation = 'source-over';
    if (crop) { c.strokeStyle = 'rgba(255,255,255,0.9)'; c.lineWidth = 2; c.setLineDash([4, 4]); c.strokeRect(crop.x, crop.y, crop.w, crop.h); c.setLineDash([]); }
  }

  function sourcePoint(ev: PointerEvent) {
    const r = overlay.getBoundingClientRect();
    const x = ((ev.clientX - r.left) / r.width) * MASKED_EDIT_SIZE.width;
    const y = ((ev.clientY - r.top) / r.height) * MASKED_EDIT_SIZE.height;
    return { x: Math.min(MASKED_EDIT_SIZE.width, Math.max(0, x)), y: Math.min(MASKED_EDIT_SIZE.height, Math.max(0, y)) };
  }

  let drawing = false, rectStart: { x: number; y: number } | null = null, stroke: MaskStroke | null = null;
  overlay.onpointerdown = ev => {
    if (phase !== 'paint') return;
    overlay.setPointerCapture(ev.pointerId); drawing = true;
    const p = sourcePoint(ev);
    if (tool === 'rect') { rectStart = p; mask.rect = { x: p.x, y: p.y, w: 0, h: 0 }; }
    else {
      if (mask.strokes.length >= MAX_STROKES) { say('Stroke limit reached.'); return; }
      stroke = { tool: tool === 'erase' ? 'erase' : 'brush', size: brushSize, points: [p] };
      mask.strokes.push(stroke);
    }
    paintOverlay();
  };
  overlay.onpointermove = ev => {
    if (!drawing || phase !== 'paint') return;
    const p = sourcePoint(ev);
    if (tool === 'rect' && rectStart) {
      mask.rect = { x: Math.min(rectStart.x, p.x), y: Math.min(rectStart.y, p.y), w: Math.abs(p.x - rectStart.x), h: Math.abs(p.y - rectStart.y) };
    } else if (stroke && stroke.points.length < MAX_POINTS) stroke.points.push(p);
    paintOverlay();
  };
  overlay.onpointerup = () => {
    if (!drawing) return;
    drawing = false; rectStart = null; stroke = null; pushHist(); quote = null; fingerprint = null; phase = 'paint'; draw();
  };
  overlay.onpointercancel = () => { drawing = false; rectStart = null; stroke = null; };

  async function reviewQuote() {
    const cropped = cropAroundMask(mask);
    if (!cropped) { say('Paint what may change. The region stays fixed on screen.'); return; }
    if (!cropped.ok) { say(cropped.reason); crop = cropped.crop; paintOverlay(); return; }
    if (!prompt.trim()) { say('Describe the surface edit inside the region.'); return; }
    if (!scopeChecked) { say('Confirm you checked this region through the whole clip.'); return; }
    crop = cropped.crop;
    const cropNow = crop;
    quote = estimateMaskedEditUsd({ width: cropNow.w, height: cropNow.h }, take.media.frames || 81);
    allowance = Math.max(allowance, quote.reservationRequiredUsd);
    phase = 'quote';
    say('Preparing your crop and quote locally. Nothing submitted.');
    // Preferred path: foundation prepare route. Offline-safe fallback keeps the trusted local estimate.
    try {
      const r = await api('director/masked-edit/prepare', {
        projectId: P().id, shotId, sourceAssetId: take.id, sourceSha256: asset()?.sha256,
        expectedRevision: P().revision, draftId: crypto.randomUUID(), mask, prompt, seed, maxCostUsd: allowance,
      });
      editId = r.editId; fingerprint = r.quote?.fingerprint || r.fingerprint || null;
      if (r.quote?.estimate != null) quote = { estimate: r.quote.estimate, reservationRequiredUsd: r.quote.reservationRequiredUsd ?? r.quote.estimate * 1.1 };
      if (r.cropRect) crop = r.cropRect;
      say('Estimated cost ready. Review scope & allowance before Generate.');
    } catch (e) {
      const msg = (e as Error).message || '';
      if (/Unknown|404|not found|masked-edit/i.test(msg)) {
        const c = crop || cropNow;
        fingerprint = `local:${take.id}:${c.x},${c.y},${c.w},${c.h}:${prompt}:${seed}`;
        say('Estimated $' + quote!.estimate.toFixed(2) + ' · reserves $' + quote!.reservationRequiredUsd.toFixed(2) + ' (local planning estimate; foundation prepare not mounted yet).');
      } else { say(msg); toast(msg); phase = 'paint'; }
    }
    draw();
  }

  async function generate() {
    if (!quote || !fingerprint || !unknownAck) return;
    if (allowance < quote.reservationRequiredUsd) { say('The required reservation exceeds your run allowance or remaining project/account budget. Nothing submitted.'); return; }
    phase = 'active';
    say('Generating one edit… Original and cut are unchanged.');
    draw();
    try {
      await api('director/masked-edit/submit', {
        projectId: P().id, editId, draftRevision: 1, requestId: crypto.randomUUID(), fingerprint,
        maxCostUsd: allowance,
        approval: { approved: true, fingerprint, allowance: { currency: 'USD', maxAmount: allowance, allowUnknownCharges: true } },
      });
      say('Generating one edit… Check Jobs for progress. Original and cut are unchanged.');
    } catch (e) {
      const msg = (e as Error).message || '';
      if (/Unknown|404|not found|masked-edit|Paid and unknown/i.test(msg)) {
        say('Submit path refused or not mounted (offline/experimental). Draft kept; nothing was billed here.');
        phase = 'quote';
      } else { say(msg); toast(msg); phase = 'quote'; }
      draw();
    }
  }

  function draw() {
    const s = shot(); if (!s) { dlg.close(); return; }
    const no = String(P().shots.indexOf(s) + 1).padStart(2, '0');
    title.textContent = `Edit region · Shot ${no} · ${take.label}`;
    const tools = h('div', { class: 'tk-edit-tools', role: 'toolbar', 'aria-label': 'Mask tools' },
      ...(['rect', 'brush', 'erase'] as const).map(t => h('button', { type: 'button', class: `btn sm${tool === t ? ' on' : ''}`, 'aria-pressed': String(tool === t), onclick: () => { tool = t; draw(); } }, t === 'rect' ? 'Rectangle' : t === 'brush' ? 'Brush' : 'Erase')),
      h('label', { class: 'tk-edit-field' }, 'Brush', h('input', { type: 'range', min: 8, max: 96, value: brushSize, oninput: (ev: Event) => { brushSize = Number((ev.target as HTMLInputElement).value); } })),
      h('button', { type: 'button', class: 'btn sm', onclick: undo }, 'Undo'),
      h('button', { type: 'button', class: 'btn sm', onclick: redo }, 'Redo'),
      h('button', { type: 'button', class: 'btn sm', onclick: () => { mask = emptyMask(); pushHist(); quote = null; crop = null; draw(); paintOverlay(); } }, 'Reset'));
    const rectFields = h('div', { class: 'tk-edit-rect', role: 'group', 'aria-label': 'Rectangle in source pixels' },
      ...(['x', 'y', 'w', 'h'] as const).map(k => {
        const val = mask.rect?.[k] ?? 0;
        return h('label', { class: 'tk-edit-field' }, k.toUpperCase(), h('input', {
          class: 'field sm', type: 'number', min: 0, max: k === 'w' || k === 'x' ? MASKED_EDIT_SIZE.width : MASKED_EDIT_SIZE.height, value: Math.round(val),
          onchange: (ev: Event) => {
            const n = Number((ev.target as HTMLInputElement).value);
            mask.rect = { x: mask.rect?.x ?? 0, y: mask.rect?.y ?? 0, w: mask.rect?.w ?? 0, h: mask.rect?.h ?? 0, [k]: n };
            pushHist(); quote = null; draw(); paintOverlay();
          },
        }));
      }));
    const promptEl = h('textarea', { class: 'field tk-edit-prompt', rows: 3, maxlength: 2500, placeholder: 'Change the dark coat to a red parka. Keep the pose.', value: prompt, oninput: (ev: Event) => { prompt = (ev.target as HTMLTextAreaElement).value; quote = null; } }) as HTMLTextAreaElement;
    const scope = h('label', { class: 'tk-check' }, h('input', { type: 'checkbox', checked: scopeChecked, onchange: (ev: Event) => { scopeChecked = (ev.target as HTMLInputElement).checked; } }), 'I checked this region through the whole clip.');
    const ack = h('label', { class: 'tk-check' }, h('input', { type: 'checkbox', checked: unknownAck, onchange: (ev: Event) => { unknownAck = (ev.target as HTMLInputElement).checked; draw(); } }), 'I understand Cloud runtime charges may exceed this estimate; this allowance is not a provider billing cap.');
    const allow = h('label', { class: 'tk-edit-field' }, 'Run allowance (USD)', h('input', { class: 'field sm', type: 'number', min: 0, step: 0.01, value: allowance, onchange: (ev: Event) => { allowance = Number((ev.target as HTMLInputElement).value); draw(); } }));
    const reviewBtn = h('button', { type: 'button', class: 'btn', disabled: phase === 'active', onclick: () => void reviewQuote() }, 'Review scope & quote');
    const genLabel = quote ? `Generate edit · estimated $${quote.estimate.toFixed(2)}` : 'Generate edit';
    const canGenerate = phase === 'quote' && !!quote && unknownAck && allowance >= (quote?.reservationRequiredUsd ?? Infinity);
    const genBtn = h('button', { type: 'button', class: 'btn primary', disabled: !canGenerate, onclick: () => void generate() }, genLabel);

    const quoteBlock = quote ? h('div', { class: 'tk-edit-quote' },
      h('p', {}, `Estimated $${quote.estimate.toFixed(2)} · reserves $${quote.reservationRequiredUsd.toFixed(2)} · run allowance $${allowance.toFixed(2)}`),
      h('p', { class: 'note' }, crop ? `Crop ${crop.w}×${crop.h} at (${crop.x},${crop.y}). Only this crop and mask are uploaded to Comfy Cloud.` : ''),
      allow, ack) : undefined;
    body.replaceChildren(
      h('p', { class: 'note' }, 'Original is kept. This does not change your cut. Fixed on screen · same region in every frame.'),
      h('p', { class: 'note tk-edit-meta mono' }, `${take.id.slice(0, 8)} · ${take.model} · ${take.media.width}×${take.media.height} · ${take.media.fps} fps · ${take.media.frames} frames`),
      stage,
      h('p', { class: 'note' }, 'Paint what may change. The region stays fixed on screen.'),
      tools, rectFields,
      h('label', { class: 'tk-edit-field tk-edit-prompt-label' }, 'Edit prompt', promptEl),
      h('p', { class: 'note' }, 'Everything inside the region may change. Faces, identity and exact colors are not guaranteed.'),
      scope,
      ...(quoteBlock ? [quoteBlock] : []),
      h('div', { class: 'tk-edit-acts' }, reviewBtn, genBtn),
    );
    paintOverlay();
  }

  document.body.append(dlg);
  draw();
  dlg.showModal();
  say('Paint what may change. The region stays fixed on screen.');
}
