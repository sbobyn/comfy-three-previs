// Fixed-mask region edit UI for Take lab. Authoring → quote → submit → local resume/composite →
// review lanes → accept. Paid submit stays gated; resume never POSTs to Cloud.
import { api, h, toast, DEMO } from './director-common';
import type { DirectorProject, Asset, Shot } from '../shared/director.mjs';
import type { VideoTake } from '../shared/takes.mjs';

export const MASKED_EDIT_FRAMES = [81, 89, 113] as const;
export const MASKED_EDIT_SIZE: { width: number; height: number; fps: number } = { width: 1280, height: 720, fps: 24 };
const FEATHER_DEFAULT = 8;
const MAX_STROKES = 64;
const MAX_POINTS = 4000;
const POLL_MS = 2500;

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
  onAccepted?: (assetId: string) => void;
};

type Phase = 'paint' | 'quote' | 'active' | 'review';
type ReviewLane = 'original' | 'edited' | 'mask' | 'outside';

type StatusPayload = {
  editId: string;
  state: string;
  sourceAssetId: string;
  sourceSha256: string;
  candidateSha256?: string | null;
  cropRect?: { x: number; y: number; w: number; h: number };
  review?: { id: string } | null;
  acceptance?: { assetId: string } | null;
  preservation?: { outsideExact?: boolean } | null;
  inputKey?: string;
  quoteFingerprint?: string;
  jobId?: string | null;
  job?: { status?: string; message?: string } | null;
  needsResume?: boolean;
  canGenerate?: boolean;
  canResume?: boolean;
  canReview?: boolean;
  canAccept?: boolean;
  uncertain?: boolean;
  media?: { candidate?: string | null; mask?: string | null };
  patchJobId?: string | null;
  patchResultId?: string | null;
  patchSha256?: string | null;
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

function mediaUrl(path: string | null | undefined) {
  if (!path) return '';
  return path.startsWith('/') ? path : `/api/director/${path}`;
}

export async function openMaskedEdit(ctx: MaskedEditCtx, shotId: string, take: VideoTake, reopen?: { editId: string }) {
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
  let editId: string | null = reopen?.editId || null;
  let fingerprint: string | null = null;
  let crop: { x: number; y: number; w: number; h: number } | null = null;
  let statusInfo: StatusPayload | null = null;
  let reviewLane: ReviewLane = 'edited';
  let reviewedScope = false;
  let pollTimer = 0;
  let busy = false;

  const title = h('h2', { id: 'masked-edit-title' });
  const status = h('p', { class: 'note tk-edit-status', role: 'status' });
  const body = h('div', { class: 'tk-edit-body' });
  const close = h('button', { class: 'btn ghost sm icon', type: 'button', 'aria-label': 'Close region edit' }, '✕');
  const dlg = h('dialog', { class: 'takes tk-edit', id: 'masked-edit-dialog', 'aria-labelledby': 'masked-edit-title' },
    h('div', { class: 'dialog-head' }, title, close),
    body, status);
  close.onclick = () => dlg.close();
  dlg.addEventListener('close', () => {
    if (pollTimer) window.clearInterval(pollTimer);
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
    if (phase === 'review') return;
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

  function stopPoll() {
    if (pollTimer) { window.clearInterval(pollTimer); pollTimer = 0; }
  }

  async function refreshStatus() {
    if (!editId) return null;
    const st = await api<StatusPayload>(`director/masked-edit/status?projectId=${encodeURIComponent(P().id)}&editId=${encodeURIComponent(editId)}`);
    statusInfo = st;
    if (st.cropRect) crop = st.cropRect;
    if (st.state === 'ready-for-review' || st.state === 'accepted') {
      phase = 'review';
      stopPoll();
      if (st.acceptance?.assetId) say(`Saved as take ${st.acceptance.assetId.slice(0, 8)}. Cut unchanged.`);
      else if (st.preservation?.outsideExact) say('Ready for review. Outside-mask pixels match the original (exact).');
      else say('Ready for review.');
    } else if (st.uncertain) {
      phase = 'active';
      stopPoll();
      say('Model finished with an uncertain outcome. Do not Generate again. Wait for Jobs to settle, then Resume local composite if a patch appears.');
    } else if (st.needsResume || st.canResume) {
      say('Cloud patch ready. Running local composite (no Cloud POST)…');
      await runResume();
    } else if (st.state === 'submitted' || st.state === 'compositing' || st.state === 'verifying') {
      phase = 'active';
      const jobBit = st.job?.status ? ` · job ${st.job.status}` : '';
      say(`Generating one edit${jobBit}. Original and cut are unchanged.`);
    }
    draw();
    return st;
  }

  function startPoll() {
    stopPoll();
    pollTimer = window.setInterval(() => { void refreshStatus().catch(e => say((e as Error).message || 'Status failed')); }, POLL_MS);
  }

  async function runResume() {
    if (!editId || busy) return;
    busy = true;
    try {
      const st = await api<StatusPayload>('director/masked-edit/resume', { projectId: P().id, editId });
      statusInfo = st;
      if (st.state === 'ready-for-review') {
        phase = 'review';
        stopPoll();
        say(st.preservation?.outsideExact
          ? 'Local composite ready. Outside-mask pixels match exactly. Review Original vs Edited, then save.'
          : 'Local composite ready. Review carefully before saving.');
      } else if (st.uncertain) {
        say('Still uncertain — nothing billed again. Do not Generate.');
      } else {
        say(`Resume returned state ${st.state}${st.job?.status ? ` · job ${st.job.status}` : ''}.`);
        if (st.state === 'submitted') startPoll();
      }
      draw();
    } catch (e) {
      const msg = (e as Error).message || '';
      if (/uncertain/i.test(msg)) {
        say('Model outcome is uncertain. Do not Generate again.');
      } else if (/job-missing|refresh tracking/i.test(msg)) {
        say('Patch job not in local Jobs yet. Open Jobs once, then Resume — still no Cloud POST.');
      } else {
        say(msg);
        toast(msg, true);
      }
      draw();
    } finally {
      busy = false;
    }
  }

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
      say(msg); toast(msg, true); phase = 'paint';
    }
    draw();
  }

  async function generate() {
    if (!quote || !fingerprint || !unknownAck || !editId) return;
    if (statusInfo?.uncertain) { say('Outcome is uncertain — Generate is disabled.'); return; }
    if (allowance < quote.reservationRequiredUsd) { say('The required reservation exceeds your run allowance or remaining project/account budget. Nothing submitted.'); return; }
    phase = 'active';
    say('Generating one edit… Original and cut are unchanged.');
    draw();
    try {
      const submitted = await api('director/masked-edit/submit', {
        projectId: P().id, editId, draftRevision: 1, requestId: crypto.randomUUID(), fingerprint,
        maxCostUsd: allowance,
        approval: { approved: true, fingerprint, allowance: { currency: 'USD', maxAmount: allowance, allowUnknownCharges: true } },
      });
      say(submitted?.jobId
        ? `Generating one edit (job ${String(submitted.jobId).slice(0, 8)}…). Polling status…`
        : 'Generating one edit… Polling status…');
      startPoll();
      await refreshStatus();
    } catch (e) {
      const msg = (e as Error).message || '';
      if (/Paid and unknown|disabled at this checkpoint|generation authority|PREVIS_ALLOW_PAID/i.test(msg)) {
        say('Paid Cloud submit is disabled here (needs PREVIS_ALLOW_PAID=1 and an approved budget). Draft kept; nothing was billed.');
        phase = 'quote';
      } else { say(msg); toast(msg, true); phase = 'quote'; }
      draw();
    }
  }

  async function markReviewed() {
    if (!editId || !statusInfo?.candidateSha256 || !statusInfo.sourceSha256) return;
    try {
      const r = await api('director/masked-edit/review', {
        projectId: P().id,
        editId,
        candidateSha256: statusInfo.candidateSha256,
        sourceSha256: statusInfo.sourceSha256,
        fingerprint: statusInfo.inputKey || statusInfo.quoteFingerprint || fingerprint,
        reviewedScope: true,
      });
      reviewedScope = true;
      statusInfo = { ...statusInfo, review: { id: r.reviewId }, canAccept: true };
      say('Review recorded. You can save as a new take — cut stays unchanged.');
      draw();
    } catch (e) {
      const msg = (e as Error).message || '';
      say(msg); toast(msg, true);
    }
  }

  async function acceptEdit() {
    if (!editId || !statusInfo?.candidateSha256 || !statusInfo.review?.id) return;
    busy = true;
    try {
      const r = await api('director/masked-edit/accept', {
        projectId: P().id,
        editId,
        candidateSha256: statusInfo.candidateSha256,
        reviewId: statusInfo.review.id,
        acceptanceId: crypto.randomUUID(),
        expectedRevision: P().revision,
      });
      say(`Saved as new take ${String(r.assetId).slice(0, 8)}. Winner and cut unchanged.`);
      toast('Region edit saved as a new take');
      ctx.onAccepted?.(r.assetId);
      statusInfo = { ...statusInfo, state: 'accepted', acceptance: { assetId: r.assetId } };
      draw();
    } catch (e) {
      const msg = (e as Error).message || '';
      say(msg); toast(msg, true);
    } finally {
      busy = false;
    }
  }

  function reviewStage() {
    const src = asset() ? ctx.assetUrl(asset()!) : '';
    const candidate = mediaUrl(statusInfo?.media?.candidate || null);
    const maskSrc = mediaUrl(statusInfo?.media?.mask || null);
    const main = h('video', {
      class: 'tk-edit-video',
      src: reviewLane === 'edited' && candidate ? candidate : src,
      muted: true, playsinline: true, controls: true, preload: 'auto',
      'aria-label': reviewLane === 'edited' ? 'Edited candidate' : 'Original take',
    }) as HTMLVideoElement;
    const maskImg = reviewLane === 'mask' || reviewLane === 'outside'
      ? h('img', { class: 'tk-edit-mask', src: maskSrc, alt: 'Fixed mask alpha' }) as HTMLImageElement
      : null;
    const wrap = h('div', { class: `tk-edit-stage tk-edit-review tk-lane-${reviewLane}` },
      main,
      maskImg,
      reviewLane === 'outside' ? h('p', { class: 'tk-edit-lane-note' }, 'Outside-only: mask shows the region that was allowed to change; outside stayed exact before encode.') : null,
      reviewLane === 'mask' ? h('p', { class: 'tk-edit-lane-note' }, 'Mask lane: white = may change; black = preserved.') : null,
    );
    return wrap;
  }

  function draw() {
    const s = shot(); if (!s) { dlg.close(); return; }
    const no = String(P().shots.indexOf(s) + 1).padStart(2, '0');
    title.textContent = `Edit region · Shot ${no} · ${take.label}`;

    if (phase === 'review' && statusInfo?.candidateSha256) {
      const lanes = h('div', { class: 'tk-edit-lanes', role: 'tablist', 'aria-label': 'Review lanes' },
        ...(['original', 'edited', 'mask', 'outside'] as ReviewLane[]).map(lane => h('button', {
          type: 'button', role: 'tab', class: `btn sm${reviewLane === lane ? ' on' : ''}`,
          'aria-selected': String(reviewLane === lane),
          onclick: () => { reviewLane = lane; draw(); },
        }, lane === 'original' ? 'Original' : lane === 'edited' ? 'Edited' : lane === 'mask' ? 'Mask' : 'Outside-only')));
      const reviewChk = h('label', { class: 'tk-check' },
        h('input', {
          type: 'checkbox', checked: reviewedScope || Boolean(statusInfo.review?.id),
          onchange: (ev: Event) => {
            const on = (ev.target as HTMLInputElement).checked;
            if (on) void markReviewed();
            else { reviewedScope = false; draw(); }
          },
        }),
        'I reviewed Original vs Edited (and Mask / Outside-only).');
      const resumeBtn = statusInfo.canResume || statusInfo.state === 'failed-local'
        ? h('button', { type: 'button', class: 'btn', disabled: busy, onclick: () => void runResume() }, 'Resume local composite')
        : null;
      const acceptBtn = h('button', {
        type: 'button', class: 'btn primary',
        disabled: busy || !(statusInfo.review?.id || reviewedScope) || statusInfo.state === 'accepted',
        onclick: () => void acceptEdit(),
      }, statusInfo.state === 'accepted' ? 'Saved as take' : 'Save as new take');
      body.replaceChildren(
        h('p', { class: 'note' }, 'Original is kept. Saving adds a child take; it does not change your cut.'),
        h('p', { class: 'note tk-edit-meta mono' },
          `${take.id.slice(0, 8)} · edit ${editId?.slice(0, 8) || '—'} · ${statusInfo.preservation?.outsideExact ? 'outsideExact' : 'review'} · patch ${statusInfo.patchJobId?.slice(0, 8) || statusInfo.jobId?.slice(0, 8) || '—'}`),
        lanes,
        reviewStage(),
        reviewChk,
        h('div', { class: 'tk-edit-acts' }, resumeBtn, acceptBtn),
      );
      return;
    }

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
    const reviewBtn = h('button', { type: 'button', class: 'btn', disabled: phase === 'active' || Boolean(statusInfo?.uncertain), onclick: () => void reviewQuote() }, 'Review scope & quote');
    const genLabel = quote ? `Generate edit · estimated $${quote.estimate.toFixed(2)}` : 'Generate edit';
    const canGenerate = phase === 'quote' && !!quote && unknownAck && allowance >= (quote?.reservationRequiredUsd ?? Infinity) && !statusInfo?.uncertain;
    const genBtn = h('button', { type: 'button', class: 'btn primary', disabled: !canGenerate, onclick: () => void generate() }, genLabel);
    const resumeBtn = (phase === 'active' && (statusInfo?.canResume || statusInfo?.needsResume || statusInfo?.state === 'failed-local'))
      ? h('button', { type: 'button', class: 'btn', disabled: busy || Boolean(statusInfo?.uncertain), onclick: () => void runResume() }, 'Resume local composite')
      : null;

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
      h('div', { class: 'tk-edit-acts' }, reviewBtn, genBtn, resumeBtn),
    );
    paintOverlay();
  }

  document.body.append(dlg);
  draw();
  dlg.showModal();
  if (reopen?.editId) {
    say('Reopening saved receipt…');
    phase = 'active';
    void refreshStatus().then(st => {
      if (st?.state === 'prepared') { phase = 'quote'; say('Prepared draft reopened. Review quote or Generate.'); draw(); }
      else if (st?.state === 'submitted' || st?.needsResume) startPoll();
    }).catch(e => say((e as Error).message || 'Could not reopen'));
  } else {
    say('Paint what may change. The region stays fixed on screen.');
  }
}
