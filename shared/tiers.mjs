// Draft/final model tiers for batch generation, and list-price estimates (USD) before anything is submitted.
// Prices mirror the presets: images from server/previs/refgen.mjs imagePresets, videos from server/previs/presets.mjs
// (tests/batch.test.mjs keeps them in sync). Estimates only; Comfy Cloud does not return a binding price.
export const TIERS = {
  draft: { looks: 'flux-2-pro', sheets: 'flux-2-pro', stills: 'flux-2-pro', videos: 'ltx-25-i2v-fast-v1' },
  final: { looks: 'flux-3', sheets: 'flux-3', stills: 'flux-3', videos: 'ltx-25-flf-v1' },
};
export const IMAGE_PRICES = { 'flux-2-pro': 0.028, 'flux-3': 0.066, 'flux-ultra': 0.06, 'nano-banana-2-1': 0.05, 'nano-banana-2': 0.081, 'local-checkpoint': 0 };
// keyFrames: LTX bills the duration it is asked for, snapped to the combo values the agent and batch send.
export const VIDEO_PRICES = {
  'ltx-25-i2v-fast-v1': { ratePerSecond: 0.1287, keyFrames: true },
  'ltx-25-i2v-v1': { ratePerSecond: 0.172, keyFrames: true },
  'ltx-25-flf-v1': { ratePerSecond: 0.172, keyFrames: true },
  'seedance-25-edit-v1': { ratePerSecond: 0.395 },
  'kling-o1-edit-v1': { ratePerSecond: 0.126 },
  'wan-vace-13b-edge-v1': { ratePerSecond: 0, local: true },
};
export const KEY_FRAME_SECONDS = [2, 3, 4, 5, 6, 8, 10];
export const snapSeconds = d => KEY_FRAME_SECONDS.reduce((x, y) => (Math.abs(y - d) < Math.abs(x - d) ? y : x));
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
    return round(p.ratePerSecond * (p.keyFrames ? snapSeconds(duration) : duration));
  }
  if (!STEP_OF[type]) return null;
  const per = IMAGE_PRICES[model];
  return per == null ? null : round(per * Math.max(1, Math.floor(count) || 1));
}
