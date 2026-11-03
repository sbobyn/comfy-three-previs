// Fixed-mask video edit (v1): eligibility, geometry, mask rasterization, crop, input keys and
// acceptance checks. Shared by the Take lab UI and server/previs/masked-edit.mjs. Server alone
// decides approval; this module never talks to a provider.
import { createHash } from 'node:crypto';

export const MASKED_EDIT_VERSION = 1;
export const MASK_ALGORITHM_VERSION = 'fixed-feather-inside-v1';
export const COMPOSITE_VERSION = 'crop-blend-v1';
export const MASKED_EDIT_WORKFLOW = 'masked-video-edit';

export const ELIGIBLE_WIDTH = 1280;
export const ELIGIBLE_HEIGHT = 720;
export const ELIGIBLE_FPS = 24;
export const ELIGIBLE_FRAMES = Object.freeze([81, 89, 113]);

export const DEFAULT_FEATHER_PX = 8;
export const CROP_CONTEXT_PAD = 32;
export const CROP_ALIGN = 16;
export const CROP_MIN_DIM = 320;
export const CROP_MIN_AREA = 153_600;
export const CROP_MAX_FRAME_FRAC = 0.6;

export const MAX_PROMPT_CHARS = 4000;
export const MAX_NEGATIVE_PROMPT_CHARS = 2000;
export const MAX_STROKES = 256;
export const MAX_STROKE_POINTS = 4096;
export const MAX_MASK_JSON_BYTES = 1024 * 1024;

const UUID = /^[a-f0-9-]{36}$/i;
const round = (v, d = 6) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

function fail(message, code = 'masked-edit-invalid') {
  const e = Error(message);
  e.code = code;
  e.status = 400;
  throw e;
}

export function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function hashText(text) {
  return hashBytes(Buffer.from(String(text || ''), 'utf8'));
}

/** Silent 720p / 24 fps takes with exactly 81, 89 or 113 frames. */
export function sourceEligible(media = {}) {
  const issues = [];
  const width = Number(media.width), height = Number(media.height);
  const fps = Number(media.fps), frames = Number(media.frameCount);
  if (width !== ELIGIBLE_WIDTH || height !== ELIGIBLE_HEIGHT) issues.push(`size ${width || '?'}×${height || '?'} (need ${ELIGIBLE_WIDTH}×${ELIGIBLE_HEIGHT})`);
  if (!(Math.abs(fps - ELIGIBLE_FPS) < 1e-6)) issues.push(`fps ${fps || '?'} (need ${ELIGIBLE_FPS})`);
  if (!ELIGIBLE_FRAMES.includes(frames)) issues.push(`frames ${frames || '?'} (need ${ELIGIBLE_FRAMES.join(', ')})`);
  if (media.audio === true) issues.push('audio is present (need a silent take)');
  if (media.variableRate === true) issues.push('variable frame rate');
  return { ok: issues.length === 0, issues, width: ELIGIBLE_WIDTH, height: ELIGIBLE_HEIGHT, fps: ELIGIBLE_FPS, frameCount: frames };
}

/** True when the asset is an accepted masked-edit take (excluded from the implicit newest cut fallback). */
export function isMaskedEditAsset(asset) {
  return !!(asset?.source?.maskedEdit && asset.source.maskedEdit.v === MASKED_EDIT_VERSION);
}

/** Walk parentAssetId / sourceAssetId within the same shot; capped to avoid cycles. */
export function maskedEditLineage(project, asset, { limit = 32 } = {}) {
  const assets = project?.assets || [];
  const chain = [];
  let cur = asset, guard = 0;
  while (cur && guard++ < limit) {
    chain.push(cur.id);
    const me = cur.source?.maskedEdit;
    const parentId = me?.parentAssetId || (me ? cur.source?.sourceAssetId : null);
    if (!parentId) break;
    if (chain.includes(parentId)) break;
    cur = assets.find(a => a.id === parentId) || null;
  }
  return chain;
}

export function rootAssetId(project, asset) {
  const me = asset?.source?.maskedEdit;
  if (me?.rootAssetId) return me.rootAssetId;
  const chain = maskedEditLineage(project, asset);
  return chain.at(-1) || asset?.id || null;
}

function finiteNum(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n)) fail(`${name} must be a finite number`);
  return n;
}

function intNum(v, name, lo, hi) {
  const n = finiteNum(v, name);
  if (!Number.isInteger(n) || n < lo || n > hi) fail(`${name} must be a whole number from ${lo} to ${hi}`);
  return n;
}

/** Normalize and bound a client mask payload; server rasterization is canonical. */
export function normalizeMask(input, { width = ELIGIBLE_WIDTH, height = ELIGIBLE_HEIGHT } = {}) {
  if (!input || typeof input !== 'object') fail('mask is required');
  const raw = JSON.stringify(input);
  if (raw.length > MAX_MASK_JSON_BYTES) fail(`mask payload exceeds ${MAX_MASK_JSON_BYTES} bytes`);
  if (input.v !== MASKED_EDIT_VERSION) fail('Unknown mask version');
  if (input.mode !== 'fixed') fail('Only fixed masks are supported in v1');
  if (input.coordinateSpace !== 'source-pixels') fail('coordinateSpace must be source-pixels');
  const w = intNum(input.width ?? width, 'mask.width', 1, 7680);
  const h = intNum(input.height ?? height, 'mask.height', 1, 4320);
  if (w !== width || h !== height) fail(`mask size must match source (${width}×${height})`);
  const featherPx = input.featherPx == null ? DEFAULT_FEATHER_PX : intNum(input.featherPx, 'featherPx', 0, 64);
  const strokes = Array.isArray(input.strokes) ? input.strokes : fail('mask.strokes must be an array');
  if (strokes.length > MAX_STROKES) fail(`At most ${MAX_STROKES} strokes`);
  const out = [];
  for (const s of strokes) {
    if (!s || typeof s !== 'object') fail('Invalid stroke');
    const type = s.type || s.op;
    if (type === 'rect') {
      const x = finiteNum(s.x, 'rect.x'), y = finiteNum(s.y, 'rect.y');
      const rw = finiteNum(s.w ?? s.width, 'rect.w'), rh = finiteNum(s.h ?? s.height, 'rect.h');
      if (rw <= 0 || rh <= 0) fail('Rectangle size must be positive');
      out.push({ type: 'rect', x, y, w: rw, h: rh, erase: s.erase === true });
    } else if (type === 'brush' || type === 'erase') {
      const points = Array.isArray(s.points) ? s.points : fail('stroke.points must be an array');
      if (points.length < 1 || points.length > MAX_STROKE_POINTS) fail(`Each stroke needs 1–${MAX_STROKE_POINTS} points`);
      const radius = finiteNum(s.radius ?? s.size ?? 8, 'stroke.radius');
      if (!(radius > 0) || radius > 512) fail('stroke.radius must be in (0, 512]');
      const pts = points.map((p, i) => {
        if (Array.isArray(p) && p.length >= 2) return [finiteNum(p[0], `point[${i}].x`), finiteNum(p[1], `point[${i}].y`)];
        if (p && typeof p === 'object') return [finiteNum(p.x, `point[${i}].x`), finiteNum(p.y, `point[${i}].y`)];
        fail(`Invalid point at ${i}`);
      });
      out.push({ type: type === 'erase' || s.erase === true ? 'erase' : 'brush', points: pts, radius });
    } else fail(`Unknown stroke type ${type}`);
  }
  return { v: MASKED_EDIT_VERSION, mode: 'fixed', width: w, height: h, coordinateSpace: 'source-pixels', featherPx, strokes: out };
}

function fillCircle(alpha, width, height, cx, cy, radius, value) {
  const r = Math.ceil(radius), r2 = radius * radius;
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(width - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(height - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r2) alpha[y * width + x] = value;
    }
  }
}

function strokeSegment(alpha, width, height, x0, y0, x1, y1, radius, value) {
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.ceil(dist));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    fillCircle(alpha, width, height, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, radius, value);
  }
}

/** Paint binary support (0/255) from normalized strokes. */
export function rasterizeSupport(mask) {
  const { width, height, strokes } = mask;
  const alpha = new Uint8Array(width * height);
  for (const s of strokes) {
    if (s.type === 'rect') {
      const x0 = Math.max(0, Math.floor(s.x)), y0 = Math.max(0, Math.floor(s.y));
      const x1 = Math.min(width, Math.ceil(s.x + s.w)), y1 = Math.min(height, Math.ceil(s.y + s.h));
      const value = s.erase ? 0 : 255;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) alpha[y * width + x] = value;
    } else {
      const value = s.type === 'erase' ? 0 : 255;
      const pts = s.points;
      if (pts.length === 1) fillCircle(alpha, width, height, pts[0][0], pts[0][1], s.radius, value);
      else for (let i = 1; i < pts.length; i++) strokeSegment(alpha, width, height, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], s.radius, value);
    }
  }
  return alpha;
}

/**
 * Feather inside painted support: distance-to-outside within support, smooth ramp over featherPx.
 * Zero outside support; no dilation beyond the painted region.
 */
export function featherInside(support, width, height, featherPx) {
  const n = width * height;
  const out = new Uint8Array(n);
  if (!(featherPx > 0)) {
    out.set(support);
    return out;
  }
  // 0 = outside support; positive = approximate distance into support (chessboard + early-out).
  const dist = new Float32Array(n);
  dist.fill(Infinity);
  for (let i = 0; i < n; i++) if (support[i] === 0) dist[i] = 0;
  const pass = (x0, x1, xd, y0, y1, yd) => {
    for (let y = y0; y !== y1; y += yd) {
      for (let x = x0; x !== x1; x += xd) {
        const i = y * width + x;
        if (support[i] === 0) { dist[i] = 0; continue; }
        let d = dist[i];
        if (x - xd >= 0 && x - xd < width) d = Math.min(d, dist[y * width + (x - xd)] + 1);
        if (y - yd >= 0 && y - yd < height) d = Math.min(d, dist[(y - yd) * width + x] + 1);
        if (x - xd >= 0 && x - xd < width && y - yd >= 0 && y - yd < height) d = Math.min(d, dist[(y - yd) * width + (x - xd)] + Math.SQRT2);
        dist[i] = d;
      }
    }
  };
  pass(0, width, 1, 0, height, 1);
  pass(width - 1, -1, -1, height - 1, -1, -1);
  pass(0, width, 1, height - 1, -1, -1);
  pass(width - 1, -1, -1, 0, height, 1);
  for (let i = 0; i < n; i++) {
    if (support[i] === 0) { out[i] = 0; continue; }
    const d = dist[i];
    if (d >= featherPx) out[i] = 255;
    else {
      const t = d / featherPx;
      const s = t * t * (3 - 2 * t);
      out[i] = Math.max(1, Math.min(255, Math.round(s * 255)));
    }
  }
  return out;
}

export function rasterizeFixedMask(maskInput, opts = {}) {
  const mask = normalizeMask(maskInput, opts);
  const support = rasterizeSupport(mask);
  const alpha = featherInside(support, mask.width, mask.height, mask.featherPx);
  let nonzero = 0, full = 0;
  for (let i = 0; i < alpha.length; i++) {
    if (alpha[i] > 0) nonzero++;
    if (alpha[i] === 255) full++;
  }
  if (!nonzero) fail('Mask is empty; paint a region that may change', 'mask-empty');
  if (nonzero === alpha.length) fail('Mask covers the entire frame; choose a smaller region', 'mask-full');
  return { mask, support, alpha, nonzero, full, maskHash: hashBytes(Buffer.from(alpha)) };
}

function alignUp(n, a = CROP_ALIGN) { return Math.ceil(n / a) * a; }

/**
 * Crop around every nonzero alpha sample, + context pad, aligned to 16, meeting minima by
 * expanding padding (clamped at frame edges without dropping painted pixels).
 */
export function cropFromMask(alpha, width, height, { pad = CROP_CONTEXT_PAD } = {}) {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (alpha[y * width + x] > 0) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) fail('Mask is empty; nothing to crop', 'mask-empty');
  let x0 = Math.max(0, minX - pad), y0 = Math.max(0, minY - pad);
  let x1 = Math.min(width, maxX + 1 + pad), y1 = Math.min(height, maxY + 1 + pad);
  let w = x1 - x0, h = y1 - y0;
  w = Math.min(width, alignUp(w));
  h = Math.min(height, alignUp(h));
  // Expand toward minima while keeping painted pixels inside.
  while ((w < CROP_MIN_DIM || h < CROP_MIN_DIM || w * h < CROP_MIN_AREA) && (w < width || h < height)) {
    if (w < width && (w < CROP_MIN_DIM || w * h < CROP_MIN_AREA)) w = Math.min(width, w + CROP_ALIGN);
    if (h < height && (h < CROP_MIN_DIM || w * h < CROP_MIN_AREA)) h = Math.min(height, h + CROP_ALIGN);
    if (w >= width && h >= height) break;
  }
  // Place crop so it still contains [minX..maxX]×[minY..maxY].
  const needX0 = Math.max(0, maxX + 1 - w), needX1 = Math.min(minX, width - w);
  const needY0 = Math.max(0, maxY + 1 - h), needY1 = Math.min(minY, height - h);
  if (needX0 > needX1 || needY0 > needY1) fail('Crop cannot contain the painted region at the frame edge', 'crop-edge');
  x0 = Math.min(Math.max(needX0, Math.floor((minX + maxX + 1 - w) / 2)), needX1);
  y0 = Math.min(Math.max(needY0, Math.floor((minY + maxY + 1 - h) / 2)), needY1);
  const area = w * h, frameArea = width * height, frac = area / frameArea;
  const warnings = [];
  if (frac > CROP_MAX_FRAME_FRAC) warnings.push({ code: 'crop-broad', text: `This crop covers more than ${Math.round(CROP_MAX_FRAME_FRAC * 100)}% of the frame. Region editing may not save money. Choose a smaller region.` });
  return { x: x0, y: y0, w, h, frac: round(frac, 4), area, warnings, contains: { minX, minY, maxX, maxY } };
}

export function validateCropEnvelope(crop, width = ELIGIBLE_WIDTH, height = ELIGIBLE_HEIGHT) {
  const issues = [];
  if (!crop || ![crop.x, crop.y, crop.w, crop.h].every(Number.isFinite)) issues.push('crop is incomplete');
  else {
    if (crop.x < 0 || crop.y < 0 || crop.x + crop.w > width || crop.y + crop.h > height) issues.push('crop exceeds the frame');
    if (crop.w % CROP_ALIGN || crop.h % CROP_ALIGN) issues.push('crop dimensions must be multiples of 16');
    if (crop.w < CROP_MIN_DIM || crop.h < CROP_MIN_DIM) issues.push(`crop must be at least ${CROP_MIN_DIM} px on each side`);
    if (crop.w * crop.h < CROP_MIN_AREA) issues.push(`crop area must be at least ${CROP_MIN_AREA} px`);
  }
  return { ok: issues.length === 0, issues };
}

/** Exact alpha==0 samples stay source; nonzero blends float then clamps to u8. */
export function compositeFrame(sourceRgb, patchRgb, alpha, width, height, crop) {
  const out = Buffer.from(sourceRgb);
  const { x: cx, y: cy, w: cw, h: ch } = crop;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = alpha[y * width + x];
      if (a === 0) continue;
      const o = (y * width + x) * 3;
      if (a === 255) {
        const lx = x - cx, ly = y - cy;
        if (lx < 0 || ly < 0 || lx >= cw || ly >= ch) continue;
        const p = (ly * cw + lx) * 3;
        out[o] = patchRgb[p]; out[o + 1] = patchRgb[p + 1]; out[o + 2] = patchRgb[p + 2];
        continue;
      }
      const t = a / 255, lx = x - cx, ly = y - cy;
      if (lx < 0 || ly < 0 || lx >= cw || ly >= ch) continue;
      const p = (ly * cw + lx) * 3;
      out[o] = Math.round(sourceRgb[o] * (1 - t) + patchRgb[p] * t);
      out[o + 1] = Math.round(sourceRgb[o + 1] * (1 - t) + patchRgb[p + 1] * t);
      out[o + 2] = Math.round(sourceRgb[o + 2] * (1 - t) + patchRgb[p + 2] * t);
    }
  }
  return out;
}

/** Pre-encode preservation: every alpha==0 channel equals source. */
export function verifyOutsideExact(sourceRgb, compositeRgb, alpha) {
  let checked = 0;
  for (let i = 0, p = 0; i < alpha.length; i++, p += 3) {
    if (alpha[i] !== 0) continue;
    checked++;
    if (sourceRgb[p] !== compositeRgb[p] || sourceRgb[p + 1] !== compositeRgb[p + 1] || sourceRgb[p + 2] !== compositeRgb[p + 2]) {
      return { ok: false, checked, index: i };
    }
  }
  return { ok: true, checked };
}

export function validatePromptFields({ prompt, negativePrompt = '', seed } = {}) {
  const text = String(prompt ?? '');
  if (!text.trim()) fail('Edit prompt is required');
  if (text.length > MAX_PROMPT_CHARS) fail(`Prompt exceeds ${MAX_PROMPT_CHARS} characters`);
  const neg = String(negativePrompt ?? '');
  if (neg.length > MAX_NEGATIVE_PROMPT_CHARS) fail(`Negative prompt exceeds ${MAX_NEGATIVE_PROMPT_CHARS} characters`);
  const s = seed == null || seed === '' ? 0 : Number(seed);
  if (!Number.isInteger(s) || s < 0 || s > 0xffff_ffff) fail('seed must be an integer from 0 to 4294967295');
  return { prompt: text, negativePrompt: neg, seed: s };
}

export function composeInputKey(parts) {
  const ordered = {
    v: MASKED_EDIT_VERSION,
    maskAlgorithmVersion: MASK_ALGORITHM_VERSION,
    compositeVersion: COMPOSITE_VERSION,
    ...parts,
  };
  return hashText(JSON.stringify(ordered));
}

/** Offline quote envelope (no provider). Estimate is informational; status stays unknown. */
export function offlineQuoteEnvelope({ frameCount, crop, steps = 20 } = {}) {
  const cropPixels = (crop?.w || 0) * (crop?.h || 0);
  const calibPixels = 320 * 480, calibFrames = 81, calibGpuS = 248.2;
  const gpuEstimate = calibGpuS * (cropPixels / calibPixels) * ((frameCount || calibFrames) / calibFrames);
  const creditsPerS = 0.266, creditsPerUsd = 211;
  const estimate = round((gpuEstimate * creditsPerS) / creditsPerUsd, 4);
  return {
    currency: 'USD',
    status: 'unknown',
    amount: null,
    estimate,
    providerEnforcedCap: false,
    basis: {
      gpuSecondsEstimate: round(gpuEstimate, 2),
      cropPixels,
      frames: frameCount || null,
      steps,
      calibration: 'historical-e4v-planning-envelope',
      note: 'Local preparation has no provider charge. A trusted Cloud estimate is required before submit.',
    },
    lineItems: { sam3: 0, grader: 0, retry: 0, localPrep: 0 },
  };
}

export function validateAcceptanceState({
  receipt, candidateSha256, sourceSha256, reviewId, project, shotId, parentAsset,
} = {}) {
  const issues = [];
  if (!receipt) issues.push('Unknown edit');
  else {
    if (receipt.state === 'accepted') {
      // Idempotent replay of a prior acceptance.
    } else if (receipt.state !== 'ready-for-review') {
      issues.push(`Edit is not ready to accept (state: ${receipt.state})`);
    }
    if (receipt.candidateSha256 && candidateSha256 && receipt.candidateSha256 !== candidateSha256) issues.push('candidateSha256 does not match the verified candidate');
    if (receipt.sourceSha256 && sourceSha256 && receipt.sourceSha256 !== sourceSha256) issues.push('sourceSha256 does not match the prepared source');
    if (reviewId && receipt.review?.id && receipt.review.id !== reviewId) issues.push('reviewId does not match the bound review');
    if (!receipt.review?.id && receipt.state !== 'accepted') issues.push('Review the edit before saving it as a take');
  }
  if (parentAsset) {
    if (shotId && parentAsset.shotId !== shotId) issues.push('Parent take belongs to another shot');
    if (isMaskedEditAsset(parentAsset)) issues.push('Chained masked edits are not supported in v1');
  }
  if (project && parentAsset) {
    const still = (project.assets || []).find(a => a.id === parentAsset.id);
    if (!still) issues.push('Parent take is no longer in the project');
    else if (still.sha256 && parentAsset.sha256 && still.sha256 !== parentAsset.sha256) issues.push('Parent take bytes changed');
  }
  return { ok: issues.length === 0, issues };
}

export function buildMaskedEditProvenance({
  editId, parent, rootId, maskHash, featherPx, cropRect, sourceTiming, prompt, negativePrompt, seed,
  patchJobId = null, patchResultId = null, patchSha256 = null, compositeSha256, inputKey,
  quoteFingerprint = null, estimateUsd = null, reviewId = null, preservationReportId = null,
} = {}) {
  if (!UUID.test(editId || '')) fail('editId must be a UUID');
  return {
    v: MASKED_EDIT_VERSION,
    editId,
    parentAssetId: parent.id,
    parentSha256: parent.sha256,
    rootAssetId: rootId || parent.id,
    maskMode: 'fixed',
    maskHash,
    maskAlgorithmVersion: MASK_ALGORITHM_VERSION,
    featherPx,
    cropRect: { x: cropRect.x, y: cropRect.y, w: cropRect.w, h: cropRect.h },
    sourceTiming: sourceTiming || { width: parent.width, height: parent.height, fps: parent.fps, frameCount: parent.frameCount, duration: parent.duration },
    prompt,
    negativePrompt: negativePrompt || '',
    seed,
    definitionHash: null,
    schemaHash: null,
    modelIdentifiers: null,
    parameters: null,
    patchJobId,
    patchResultId,
    patchSha256,
    compositeSha256,
    compositeVersion: COMPOSITE_VERSION,
    encodeSettings: { codec: 'libx264', pixFmt: 'yuv420p', note: 'Matches project MP4 convention; encoding can change outside pixels' },
    inputKey,
    quoteFingerprint,
    estimateUsd,
    reservationId: null,
    costStatus: 'local-offline',
    preservationReportId,
    reviewId,
    acceptedAt: new Date().toISOString(),
  };
}

export function assertUuid(id, name = 'id') {
  if (!UUID.test(id || '')) fail(`${name} must be a UUID`);
  return id;
}
