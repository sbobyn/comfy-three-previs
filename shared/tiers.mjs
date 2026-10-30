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
    return round(p.ratePerSecond * (p.keyFrames ? snapSeconds(duration, p.durations) : duration));
  }
  if (!STEP_OF[type]) return null;
  const per = IMAGE_PRICES[model];
  return per == null ? null : round(per * Math.max(1, Math.floor(count) || 1));
}
