// Copyright (c) 2026 Steven Bobyn. SPDX-License-Identifier: MIT
// What each model accepts and which of its settings an artist can change, read from the model registry (a video preset's
// `parameters` mapping and its graph defaults; an image preset's price and reference limit), plus the per-shot settings
// saved on the shot (`shot.settings`) and the list-price estimate they imply. Shared by the browser, the batch and MCP so a
// saved seed or clip length means the same thing everywhere.
//
// Only settings whose price effect is known are editable. Resolution, sound and model tier change the price and are not
// priced at other values yet, so they are shown with their current value and why they are fixed. The server still validates
// every bound value against the backend's live schema when it quotes.
import { clipSecondsFor, durationValue, estimateBreakdown, FIRST_FRAME_FALLBACK } from './tiers.mjs';
import { cameraSourceOf } from './camera-source.mjs';
import { maxReferences } from './video-refs.mjs';
import { VIDEO_PROMPT_CAP } from './prompt.mjs';
import { blockoutFidelity } from './blockout-fidelity.mjs';

export const SEED_MAX = 2147483647;
const presetOf = def => def?.provenance?.presetId || def?.id || '';
const SEED_NOTE = 'The same seed with the same inputs usually repeats a take on this model. Seeds are not comparable across models.';
const FIXED = {
  resolution: v => `Priced at ${v}. Other resolutions change the price and are not priced yet.`,
  audio: () => 'Off. Generated sound changes the price and is not priced yet.',
  keepSound: () => 'Off. The blockout clip has no sound to keep.',
  model: v => `The model version this preset is priced and checked for (${v}).`,
  frames: () => 'Follows the shot length and the workflow; changing it changes the timing.',
  fps: () => 'Follows the blockout clip; changing it changes the timing.',
};
const LABELS = { seed: 'Seed', duration: 'Clip length', resolution: 'Resolution', audio: 'Sound', keepSound: 'Keep source sound', model: 'Model version', steps: 'Steps', frames: 'Frames', fps: 'Frame rate' };

/**
 * Settings a video model exposes, from its registry mapping: [{ key, label, type, value (graph default), editable,
 * options?, min?, max?, unit?, costs, note }]. `shot` sets the automatic clip length of a start-still model.
 */
export function videoParamSpecs(def, shot = null) {
  const out = [];
  for (const [key, m] of Object.entries(def?.parameters || {})) {
    const value = def.graph?.[m.nodeId]?.inputs?.[m.input];
    const base = { key, label: LABELS[key] || key, value, costs: false };
    if (key === 'seed') out.push({ ...base, type: 'integer', min: 0, max: SEED_MAX, editable: true, note: SEED_NOTE });
    else if (key === 'duration' && def.task === 'first-frame' && def.constraints?.durations?.length) {
      const auto = shot ? clipSecondsFor(def, shot.duration) : Number(value);
      out.push({ ...base, value: auto, type: 'enum', options: [...def.constraints.durations], unit: 's', editable: true, costs: true, note: shot ? `Auto: ${auto} s, the length this model makes closest to the ${shot.duration} s shot. Billed per second.` : 'Billed per second.' });
    } else if (key === 'steps' && def.task === 'control-video') out.push({ ...base, type: 'integer', min: 1, max: 60, editable: true, note: 'More steps is slower on your GPU; no charge.' });
    else out.push({ ...base, type: typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'number' : 'string', editable: false, note: (FIXED[key] || (() => 'Fixed by the preset.'))(value) });
  }
  return out;
}

/** True when settings saved for model `saved` apply to definition `def` (the same preset, or its start-only sibling). */
export function settingsApply(saved, def) {
  if (!saved || !def) return false;
  const p = presetOf(def);
  return saved === def.id || saved === p || FIRST_FRAME_FALLBACK[saved] === p;
}
const validValue = (spec, v) => {
  if (!spec?.editable) return false;
  if (spec.type === 'integer') return Number.isInteger(v) && v >= spec.min && v <= spec.max;
  if (spec.type === 'enum') return spec.options.includes(v);
  if (spec.type === 'boolean') return typeof v === 'boolean';
  return false;
};
/**
 * The parameters a shot binds for `def`: graph defaults, the start-still clip length nearest the shot, then the shot's saved
 * settings when they were saved for this model. Returns { parameters, seconds (start-still models; else null), applied, ignored }.
 */
export function resolveVideoParams(def, shot, saved = shot?.settings?.video) {
  const parameters = {};
  for (const [k, m] of Object.entries(def?.parameters || {})) parameters[k] = def.graph?.[m.nodeId]?.inputs?.[m.input];
  let seconds = def?.task === 'first-frame' ? clipSecondsFor(def, shot.duration) : null;
  const applied = {}, ignored = [];
  if (saved?.params && settingsApply(saved.model, def)) {
    const specs = new Map(videoParamSpecs(def, shot).map(s => [s.key, s]));
    for (const [k, v] of Object.entries(saved.params)) {
      if (!validValue(specs.get(k), v)) { ignored.push(k); continue; }
      applied[k] = v;
      if (k === 'duration') seconds = v; else parameters[k] = v;
    }
  }
  if (seconds !== null && 'duration' in parameters) parameters.duration = durationValue(parameters.duration, seconds);
  return { parameters, seconds, applied, ignored };
}

/** The clip length saved on the shot for start-still model `modelId` (one of `durations`), or null. The batch plans with it. */
export function savedClipSeconds(shot, modelId, durations) {
  const v = shot?.settings?.video, d = v?.params?.duration;
  return v && settingsApply(v.model, { id: modelId }) && Number.isInteger(d) && (durations || []).includes(d) ? d : null;
}
/**
 * The auto-prompt's length cap for video model `def`, in characters: the preset's `constraints.autoPromptCap`, else
 * VIDEO_PROMPT_CAP (600). A heuristic for how much optional detail the composed prompt carries, not the model's hard
 * limit (promptMaxLength) and not a known optimum; see shared/prompt.mjs.
 */
export function autoPromptCap(def) {
  const n = def?.constraints?.autoPromptCap;
  return Number.isInteger(n) && n > 0 ? n : VIDEO_PROMPT_CAP;
}
/** What a video model takes and costs, for pickers and the MCP model list. */
export function videoCapabilities(def) {
  const clip = def.task === 'transform-video' || def.task === 'control-video', local = presetOf(def).startsWith('wan-');
  return {
    id: def.id, title: def.title, task: def.task, cameraSource: cameraSourceOf(def),
    inputs: { blockoutClip: clip, startStill: def.task === 'first-frame', endStill: def.task === 'first-frame' && !!def.inputs?.lastFrame, referenceImages: maxReferences(def), prompt: !!def.inputs?.prompt },
    promptMaxLength: def.constraints?.promptMaxLength ?? null,
    autoPromptCap: { chars: autoPromptCap(def), heuristic: true, fromPreset: Number.isInteger(def.constraints?.autoPromptCap) && def.constraints.autoPromptCap > 0 },
    clipLengths: def.task === 'first-frame' ? def.constraints?.durations ?? null : null,
    sourceDuration: def.constraints?.sourceVideo?.duration ?? def.constraints?.controlVideo?.duration ?? null,
    ratePerSecond: local ? 0 : def.pricing?.ratePerSecond ?? null,
    blockoutFidelity: blockoutFidelity(def),
    priceSource: def.pricing?.source || null, priceCheckedAt: def.pricing?.checkedAt || null, local,
  };
}
/** List-price USD for `seconds` of `def`; 0 for a local model, null when unpriced. */
export function videoEstimate(def, seconds) {
  if (presetOf(def).startsWith('wan-')) return 0;
  const rate = def?.pricing?.ratePerSecond;
  return Number.isFinite(rate) && seconds > 0 ? Math.round(rate * seconds * 10000) / 10000 : null;
}

/** Settings a still model exposes: seed and takes (editable), and the frame's fixed aspect. */
export function imageParamSpecs(preset) {
  return [
    { key: 'seed', label: 'Seed', type: 'integer', min: 0, max: SEED_MAX, editable: true, costs: false, note: `${SEED_NOTE} Each extra take adds 1 to the seed.` },
    { key: 'count', label: 'Takes', type: 'enum', options: [1, 2, 3, 4], value: 1, editable: true, costs: true, note: 'Each take is billed as one image.' },
    { key: 'aspect', label: 'Aspect', type: 'string', value: '16:9', editable: false, costs: false, note: 'Stills match the 16:9 blockout frame.' },
    ...(preset?.maxRefs != null ? [{ key: 'references', label: 'Cast images', type: 'number', value: preset.maxRefs, editable: false, costs: true, note: preset.maxRefs ? `Up to ${preset.maxRefs} images besides the blockout frame.` : 'Takes no cast images; only the prompt and the blockout frame guide it.' }] : []),
  ];
}
/** The shot's still settings for `presetId`: { seed, count } with defaults, when saved for that model. */
export function resolveImageParams(presetId, shot, saved = shot?.settings?.image) {
  const out = { count: 1, seed: null };
  if (!saved?.params || (saved.model && saved.model !== presetId)) return out;
  const specs = new Map(imageParamSpecs(null).map(s => [s.key, s]));
  for (const k of ['seed', 'count']) if (validValue(specs.get(k), saved.params[k])) out[k] = saved.params[k];
  return out;
}
/** Itemized list-price estimate for `count` stills with `refs` input images (the blockout frame counts), or null. */
export const imageEstimate = (presetId, { count = 1, refs = 0 } = {}) => estimateBreakdown('still', presetId, { count, refs });

/** Saved per-shot model settings: { video?: { model, params }, image?: { model, params } }. */
export function normalizeShotSettings(v) {
  const out = {};
  for (const kind of ['video', 'image']) {
    const x = v?.[kind];
    if (!x || typeof x !== 'object') continue;
    const model = typeof x.model === 'string' && /^[\w.:-]{1,100}$/.test(x.model) ? x.model : undefined;
    const params = {};
    for (const [k, val] of Object.entries(x.params && typeof x.params === 'object' ? x.params : {}).slice(0, 12)) {
      if (!/^[a-zA-Z][\w]{0,30}$/.test(k)) continue;
      if (typeof val === 'boolean' || (typeof val === 'number' && Number.isFinite(val))) params[k] = val;
      else if (typeof val === 'string') params[k] = val.slice(0, 60);
    }
    if (model || Object.keys(params).length) out[kind] = { ...(model ? { model } : {}), ...(Object.keys(params).length ? { params } : {}) };
  }
  return out;
}
