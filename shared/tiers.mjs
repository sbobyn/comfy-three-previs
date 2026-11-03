// Draft/final model tiers for batch generation, and list-price estimates (USD) before anything is submitted.
// Prices mirror the presets: images from server/previs/refgen.mjs imagePresets, videos from server/previs/presets.mjs
// (tests/batch.test.mjs keeps them in sync). Estimates only; Comfy Cloud does not return a binding price.
export const TIERS = {
  draft: { looks: 'flux-2-pro', sheets: 'flux-2-pro', stills: 'flux-2-pro', videos: 'ltx-25-i2v-fast-v1' },
  // Final: FLUX 3 looks/sheets (best livery and identity from cast images, 2026-10-30 comparison) and GPT Image 2.5 stills
  // (held the blockout guide's framing best; see .evidence/models-20261030 in the integration checkout). Final video
  // follows the blockout clip itself, with the start and end stills as its look (shared/camera-source.mjs); draft
  // animates the start still (cheap; its camera only approximates the blockout).
  final: { looks: 'flux-3', sheets: 'flux-3', stills: 'gpt-image-25', videos: 'seedance-25-edit-v1' },
};
export const IMAGE_PRICES = { 'flux-2-pro': 0.028, 'flux-2-max': 0.071, 'flux-3': 0.066, 'flux-ultra': 0.06, 'gpt-image-25': 0.076, 'seedream-5-pro': 0.045, 'nano-banana-pro': 0.161, 'nano-banana-2-1': 0.05, 'nano-banana-2': 0.081, 'local-checkpoint': 0 };
// Paid still grader (PREVIS_MATCH_GRADER=gemini): token-billed (two small images in, one short verdict out). $0.01 per grade is the
// reservation. The server ledger once booked $0.05 per grade (39 grades on 2026-10-31, $1.95 that no batch estimate counted, so the
// regeneration overran its cap by $1.84); billing for that hour shows gemini-3.5-flash at $0.2529 for the ~40 grades (about $0.006
// each; `pnpm usage:settle`), so $0.01 keeps a margin of about 60% over real billing.
export const GRADER_PRICES = { gemini: 0.01 };
// Reference-image surcharges per image the model receives (a still's blockout guide counts as one). usdPerRef is an upper-bound
// assumption from the saved live price badges (docs: .evidence/CREDITS-AND-COMPUTE-2026-10-30.md, "Reference costs"); `free` images
// are not charged; known: false means no per-image price is documented, so $0 is assumed and the margin has to absorb it.
// tests/budget-margin.test.mjs keeps `max` equal to each image preset's maxRefs.
export const REFERENCE_PRICES = {
  'flux-2-pro': { usdPerRef: 0.017, max: 7, known: true, basis: 'badge: ≈ $0.03 output + up to $0.12 for 7 references' },
  'flux-2-max': { usdPerRef: 0.034, max: 7, known: true, basis: 'badge: reference surcharge $0.03–0.24 for 7 references; upper end' },
  'gpt-image-25': { usdPerRef: 0.0176, max: 9, known: true, basis: 'badge: $0.0117–0.0176 per reference; upper end' },
  'seedream-5-pro': { usdPerRef: 0.003, free: 1, max: 9, known: true, basis: 'badge: $0.003 per reference after the first (public page: 0.63 credits per extra input or output image)' },
  'nano-banana-2-1': { usdPerRef: 0.0076, max: 9, known: true, basis: 'observed: a still with 4 references billed ≈ 17 vs 10.6 credits' },
  'nano-banana-2': { usdPerRef: 0.0076, max: 9, known: true, basis: 'same node as Nano Banana 2.1; its observed per-reference input-token cost' },
  'nano-banana-pro': { usdPerRef: 0.0011, max: 9, known: true, basis: 'Google list price: 560 input tokens per image at $2 per million (not yet seen in Comfy billing)' },
  'flux-3': { usdPerRef: 0, max: 9, known: false, basis: 'no per-reference price documented; none added (the margin absorbs it until billing shows one)' },
  'flux-ultra': { usdPerRef: 0, max: 0, known: true, basis: 'takes no reference images' },
  'local-checkpoint': { usdPerRef: 0, max: 0, known: true, basis: 'local hardware' },
};
// Models that bill a request the provider refused (moderation) at their normal output price. 2026-10-31: FLUX.2 Pro refused
// 4 of 4 Wingspan stills with "Request Moderated" and they were still charged. Other models: the charge is unknown, so a refusal stays a hold.
export const BILLED_ON_MODERATION = { 'flux-2-pro': 'FLUX.2 Pro bills a moderated request at its output price (seen 2026-10-31)' };
export const DEFAULT_MARGIN_PCT = 10;
/** PREVIS_BUDGET_MARGIN → percent (0–100): "10" and "10%" are 10 percent; unset or invalid → the default. */
export function parseMarginPct(value) {
  if (value === undefined || value === null || String(value).trim() === '') return DEFAULT_MARGIN_PCT;
  const n = Number(String(value).trim().replace(/%$/, ''));
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : DEFAULT_MARGIN_PCT;
}
export const KEY_FRAME_SECONDS = [2, 3, 4, 5, 6, 8, 10];
// keyFrames: a start-still model bills the duration it is asked for, snapped to the clip lengths it accepts (`durations`,
// the same list as the preset's constraints.durations) — the values the browser, agent and batch send.
const FROM_4 = [4, 5, 6, 8, 10];
export const VIDEO_PRICES = {
  'ltx-25-i2v-fast-v1': { ratePerSecond: 0.1287, keyFrames: true, durations: KEY_FRAME_SECONDS },
  'ltx-25-i2v-v1': { ratePerSecond: 0.172, keyFrames: true, durations: KEY_FRAME_SECONDS },
  'ltx-25-flf-v1': { ratePerSecond: 0.172, keyFrames: true, durations: KEY_FRAME_SECONDS },
  'seedance-25-i2v-v1': { ratePerSecond: 0.334, keyFrames: true, durations: FROM_4 },
  'seedance-25-flf-v1': { ratePerSecond: 0.334, keyFrames: true, durations: FROM_4 },
  'kling-40-i2v-v1': { ratePerSecond: 0.2246, keyFrames: true, durations: [3, 4, 5, 6, 8, 10] },
  'kling-40-flf-v1': { ratePerSecond: 0.2246, keyFrames: true, durations: [3, 4, 5, 6, 8, 10] },
  'veo-31-i2v-v1': { ratePerSecond: 0.2, keyFrames: true, durations: [4, 6, 8] },
  'veo-31-flf-v1': { ratePerSecond: 0.2, keyFrames: true, durations: [4, 6, 8] },
  'hailuo-h3-i2v-v1': { ratePerSecond: 0.1287, keyFrames: true, durations: FROM_4 },
  'hailuo-h3-flf-v1': { ratePerSecond: 0.1287, keyFrames: true, durations: FROM_4 },
  'wan27-i2v-v1': { ratePerSecond: 0.1, keyFrames: true, durations: KEY_FRAME_SECONDS },
  'wan27-flf-v1': { ratePerSecond: 0.1, keyFrames: true, durations: KEY_FRAME_SECONDS },
  'seedance-25-edit-v1': { ratePerSecond: 0.395 },
  'kling-o1-edit-v1': { ratePerSecond: 0.126 },
  'wan-vace-13b-edge-v1': { ratePerSecond: 0, local: true },
  // Crop cost is a historical GPU planning envelope (not list $/s). Batches must not price or dispatch it.
  'wan-vace-14b-masked-v1': { ratePerSecond: 0, planning: true },
};
// A start→end video model falls back to its start-only sibling (same list price) when a shot's end still is missing.
export const FIRST_FRAME_FALLBACK = {
  'ltx-25-flf-v1': 'ltx-25-i2v-v1', 'seedance-25-flf-v1': 'seedance-25-i2v-v1', 'kling-40-flf-v1': 'kling-40-i2v-v1',
  'veo-31-flf-v1': 'veo-31-i2v-v1', 'hailuo-h3-flf-v1': 'hailuo-h3-i2v-v1', 'wan27-flf-v1': 'wan27-i2v-v1',
};
/** Nearest clip length a model accepts (default: the LTX lengths). */
export const snapSeconds = (d, list = KEY_FRAME_SECONDS) => list.reduce((x, y) => (Math.abs(y - d) < Math.abs(x - d) ? y : x));
/** Clip length a start-still preset is asked for, from its constraints.durations. */
export const clipSecondsFor = (def, d) => snapSeconds(d, def?.constraints?.durations || VIDEO_PRICES[def?.provenance?.presetId || def?.id]?.durations || KEY_FRAME_SECONDS);
/** The duration parameter in the preset's own type (LTX takes a combo string, the others an integer). */
export const durationValue = (current, secs) => (typeof current === 'number' ? secs : String(secs));
const STEP_OF = { look: 'looks', sheet: 'sheets', still: 'stills', video: 'videos' };
export const stepOf = type => STEP_OF[type] || null;

/** Models for a tier with per-step overrides; unknown tier → draft. */
export function modelsFor(tier = 'draft', overrides = {}) {
  const base = TIERS[tier] || TIERS.draft, out = { ...base };
  for (const k of Object.keys(base)) if (typeof overrides?.[k] === 'string' && overrides[k]) out[k] = overrides[k];
  return out;
}

/** Estimated USD for one batch node; null when the price is unknown (never submit unknown cost from a batch). */
export function estimateFor(type, model, { duration = 0, count = 1 } = {}) {
  if (type === 'blockout') return 0;
  const round = x => Math.round(x * 10000) / 10000;
  if (type === 'video') {
    const p = VIDEO_PRICES[model]; if (!p || !(duration > 0)) return null;
    if (p.planning || p.unknown) return null;
    return round(p.ratePerSecond * (p.keyFrames ? snapSeconds(duration, p.durations) : duration));
  }
  if (!STEP_OF[type]) return null;
  const per = IMAGE_PRICES[model];
  return per == null ? null : round(per * Math.max(1, Math.floor(count) || 1));
}

const r4 = x => Math.round(x * 10000) / 10000;
/** USD for `refs` input images sent to an image model (free ones and unpriced models count nothing). */
export function referenceUsd(model, refs = 0) {
  const p = REFERENCE_PRICES[model], n = Math.max(0, Math.floor(refs) || 0);
  return p ? r4(p.usdPerRef * Math.max(0, n - (p.free || 0))) : 0;
}
/** Most reference images a model takes (0 when none or unknown). */
export const maxRefsFor = model => REFERENCE_PRICES[model]?.max ?? 0;
/**
 * What one paid request is expected to bill, itemized: list (the displayed price), reference images, the paid grader (a
 * still only: `grades` grades), and the safety margin. expectedUsd = list + refs + grader. The margin is for reservations
 * only (reserveUsd = expectedUsd × (1 + margin)); it is never part of a displayed list price. Null when the price is unknown.
 */
export function estimateBreakdown(type, model, { duration = 0, count = 1, refs = 0, grades = 0, marginPct = DEFAULT_MARGIN_PCT } = {}) {
  const listUsd = estimateFor(type, model, { duration, count });
  if (listUsd == null) return null;
  const refsUsd = type === 'video' || type === 'blockout' ? 0 : referenceUsd(model, refs) * Math.max(1, Math.floor(count) || 1);
  const graderUsd = type === 'still' && IMAGE_PRICES[model] > 0 ? r4(GRADER_PRICES.gemini * Math.max(0, Math.floor(grades) || 0)) : 0;
  const expectedUsd = r4(listUsd + refsUsd + graderUsd), marginUsd = r4(expectedUsd * marginPct / 100);
  return { listUsd, refsUsd: r4(refsUsd), graderUsd, expectedUsd, marginPct, marginUsd, reserveUsd: r4(expectedUsd + marginUsd), refs: Math.max(0, Math.floor(refs) || 0), grades: graderUsd ? Math.max(0, Math.floor(grades) || 0) : 0 };
}
/** Sum itemized breakdowns (null entries count nothing). */
export function sumBreakdowns(list) {
  const t = { listUsd: 0, refsUsd: 0, graderUsd: 0, expectedUsd: 0, marginUsd: 0, reserveUsd: 0 };
  for (const b of list) if (b) for (const k of Object.keys(t)) t[k] = r4(t[k] + (b[k] || 0));
  return t;
}
