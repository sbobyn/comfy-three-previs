// Copyright (c) 2026 Steven Bobyn. SPDX-License-Identifier: MIT
// Per-node regeneration keys (docs/regeneration.md), ComfyUI-style: every generated output records a manifest of the
// inputs it was made from — { v, type, key, parts, ctx } with one short hash (or a readable id) per input part — and a node
// is made again only when its key differs from a kept output's. Pure functions shared by the batch planner
// (server/previs/batch.mjs), the recorders (refgen, the director render route, video binds), the MCP tools and the browser.
//
//   blockout  camera, timing, environment and the objects its frames can show (shared/director.mjs blockoutManifest)
//   look      the object's Cast Card, its look prompt, model, params and the reference images it was sent
//   still     the blockout parts + its moment + the composed image prompt + the cast's looks and Cast Cards + model, params, seed
//   video     the blockout parts + the composed video prompt + the stills or looks it is sent + camera source, model, params, seed
//
// Model, params, seed and refs are compared only when the caller knows them (the batch always does; the browser compares
// the model a shot has chosen). The seed part is the seed *setting* (a pinned seed, or "random"), not the drawn seed.
// Outputs without a manifest are judged by the older signature rules (shared/director.mjs stillStale and friends).
import { REGEN_VERSION, blockoutManifest, castCard, castRows, diffParts, hashValue, isBlockingPart, keyStills, lookPrompt, lookSource, manifestKey, objectLooks, LOOK_VIEWS, stillStale, videoStale, blockoutStale } from './director.mjs';
import { shotPrompt } from './prompt.mjs';
import { resolveImageParams, resolveVideoParams } from './model-params.mjs';
import { cameraSourceOf } from './camera-source.mjs';
import { maxReferences } from './video-refs.mjs';
import { winnerOf, cutClip } from './takes.mjs';
import { FIRST_FRAME_FALLBACK } from './tiers.mjs';

export { REGEN_VERSION };
const STILL_ASPECT = '16:9';
/** A look's default aspect by kind (src/director-looks.ts aspectFor, default view). */
export const lookAspect = e => (e.kind === 'character' ? '3:4' : e.kind === 'environment' ? '16:9' : '4:3');
const set = (parts, k, v) => { if (v !== undefined) parts[k] = v; };
const manifest = (type, parts, ctx) => ({ v: REGEN_VERSION, type, key: manifestKey(type, parts), parts, ...(ctx && Object.keys(ctx).length ? { ctx } : {}) });
/** True for a manifest this version can compare. */
export const isManifest = m => !!(m && typeof m === 'object' && m.v === REGEN_VERSION && m.parts && typeof m.parts === 'object' && typeof m.key === 'string');
/** A manifest from untrusted input (a request body), or null: bounded size, string/number parts only. */
export function cleanManifest(m) {
  if (!isManifest(m) || !['blockout', 'look', 'still', 'video'].includes(m.type)) return null;
  const entries = Object.entries(m.parts).filter(([k, v]) => /^[\w:.@-]{1,80}$/.test(k) && (typeof v === 'string' ? v.length <= 120 : typeof v === 'number' && Number.isFinite(v))).slice(0, 2000);
  const parts = Object.fromEntries(entries), ctx = m.ctx && typeof m.ctx === 'object' ? JSON.parse(JSON.stringify(m.ctx)) : undefined;
  return JSON.stringify(ctx || {}).length > 2000 ? null : { v: REGEN_VERSION, type: m.type, key: String(m.key).slice(0, 32), parts, ...(ctx ? { ctx } : {}) };
}

// ---------- Moments and cast ----------
/** A still's moment from its note: 'start' (also unpinned frames), 'end' or seconds. */
export function momentOf(ref) {
  const n = ref?.note || '';
  if (n === 'key frame end') return 'end';
  const m = /^key frame @([\d.]+)s$/.exec(n);
  return m ? Number(m[1]) : 'start';
}
const momentNote = at => (at === 'start' ? ['key frame start', ''] : at === 'end' ? ['key frame end'] : [`key frame @${at}s`]);
const normalAt = at => (at === 'end' ? 'end' : typeof at === 'number' && Number.isFinite(at) ? Math.round(at * 100) / 100 : 'start');
/** Cast Card text of an object as the prompts use it. */
const cardHash = (project, id) => { const c = castCard(project, id); return hashValue([c.name, c.kind, c.shape, c.description, c.styleNotes]); };
/** look:<id> (its primary image id) and card:<id> for every object in the shot's cast. */
function castParts(project, shot, parts) {
  for (const r of castRows(project, shot)) if (r.inCast) { parts[`look:${r.entity.id}`] = objectLooks(project, r.entity.id)[0]?.id || 'none'; parts[`card:${r.entity.id}`] = cardHash(project, r.entity.id); }
}
const blockingOf = (project, shot) => blockoutManifest(project, shot).parts;

// ---------- Keys ----------
/** The blockout clip's manifest (shared/director.mjs). */
export const blockoutKey = (project, shot) => blockoutManifest(project, shot);

/**
 * A look's manifest. `view` is the look view its auto prompt was made for (null = default); `custom: true` records a
 * prompt the artist typed (it is then not compared). `refs` are the reference image ids it was sent.
 */
export function lookKey(project, entityId, { model, params, refs, view = null, custom = false } = {}) {
  const e = project.scene.entities.find(x => x.id === entityId); if (!e) return null;
  const parts = { card: cardHash(project, entityId) };
  if (!custom) parts.prompt = hashValue(lookPrompt(project, e, view));
  set(parts, 'model', model); set(parts, 'params', params === undefined ? undefined : hashValue(params)); set(parts, 'refs', refs === undefined ? undefined : hashValue([...refs]));
  return manifest('look', parts, { ...(view ? { view } : {}), ...(custom ? { custom: true } : {}) });
}
/** Which auto view a look prompt matches (for recording): { view } or { custom: true }. */
export function lookPromptView(project, entity, prompt) {
  const text = String(prompt || '').trim();
  for (const view of [null, ...Object.keys(LOOK_VIEWS[entity.kind] || LOOK_VIEWS.prop)]) if (text === lookPrompt(project, entity, view).trim()) return { view };
  return { custom: true };
}

/** A key-frame still's manifest at moment `at` ('start', 'end' or seconds). The seed is the shot's seed setting for `model`. */
export function stillKey(project, shot, at, { model } = {}) {
  const parts = { ...blockingOf(project, shot), moment: hashValue(normalAt(at)), prompt: hashValue(shotPrompt(project, shot, 'image')) };
  castParts(project, shot, parts);
  if (model !== undefined) { parts.model = model; parts.params = hashValue({ aspect: STILL_ASPECT }); parts.seed = resolveImageParams(model, shot).seed ?? 'random'; }
  return manifest('still', parts, { at: normalAt(at) });
}

/** What a video model is sent besides the prompt: start/end stills and/or the cast's looks. */
export function videoUses(def) {
  if (!def) return { stills: [], looks: false };
  if (def.task === 'first-frame') return { stills: ['start', ...(def.inputs?.lastFrame ? ['end'] : [])], looks: false };
  const refs = maxReferences(def) > 0;
  return { stills: refs && cameraSourceOf(def) === 'blockout' ? ['start', 'end'] : [], looks: refs };
}
/**
 * A video's manifest. With `def` (the preset), model, params and seed come from it and the shot's saved settings
 * (shared/model-params.mjs resolveVideoParams); `model` names the preset actually used (a start-only sibling).
 * `cameraSource` picks the prompt's camera line; `uses` (videoUses) which stills or looks it is sent.
 */
export function videoKey(project, shot, { def = null, model, cameraSource = def ? cameraSourceOf(def) : 'blockout', uses = videoUses(def) } = {}) {
  const parts = { ...blockingOf(project, shot), source: cameraSource, prompt: hashValue(shotPrompt(project, shot, 'video', { cameraSource })) };
  const ks = keyStills(shot);
  for (const at of uses.stills || []) parts[`still:${at}`] = (at === 'start' ? ks.start : ks.end)?.id || 'none';
  if (uses.looks) castParts(project, shot, parts);
  if (def) { const { seed, ...params } = resolveVideoParams(def, shot).parameters; parts.model = model || def.provenance?.presetId || def.id; parts.params = hashValue(params); parts.seed = seed ?? 'none'; }
  else set(parts, 'model', model);
  return manifest('video', parts, { cameraSource, uses: { stills: [...(uses.stills || [])], looks: !!uses.looks } });
}

/** Recompute the current manifest for a recorded one, with its own context (moment, view, uses) and `opts` for what the caller knows. */
function currentFor(project, recorded, target, opts = {}) {
  const ctx = recorded.ctx || {};
  if (recorded.type === 'blockout') return blockoutManifest(project, target.shot);
  if (recorded.type === 'look') return lookKey(project, target.entityId, { model: opts.model, params: opts.params, refs: opts.refs, view: ctx.view || null, custom: !!ctx.custom });
  if (recorded.type === 'still') return stillKey(project, target.shot, ctx.at ?? target.at ?? 'start', { model: opts.model ?? target.shot.settings?.image?.model ?? recorded.parts.model });
  if (recorded.type === 'video') {
    // A shot set to a start → end model that was animated from its start still alone used the start-only sibling.
    const chosen = target.shot.settings?.video?.model, model = opts.model ?? (chosen && FIRST_FRAME_FALLBACK[chosen] === recorded.parts.model ? recorded.parts.model : chosen);
    return videoKey(project, target.shot, { def: opts.def || null, model, cameraSource: opts.cameraSource || ctx.cameraSource || 'blockout', uses: opts.uses || ctx.uses || { stills: [], looks: false } });
  }
  return null;
}
/** Reasons a recorded manifest no longer matches (diffParts). */
export function manifestChanges(project, recorded, target, opts = {}) {
  const now = currentFor(project, recorded, target, opts);
  return now ? diffParts(project, recorded.parts, now.parts) : [{ code: 'missing', part: 'target', text: 'the object or shot it was made for is gone' }];
}

// ---------- Outputs and explanations ----------
const isVideo = a => a?.kind === 'workflow-result' && String(a.mime || 'video/').startsWith('video/');
/** The output a node keeps now: blockout → shot.render, still → newest take at the moment, video → winner / cut / newest, look → primary image. */
export function nodeOutput(project, node) {
  const shot = node.shotId ? project.shots.find(s => s.id === node.shotId) : null;
  if (node.type === 'blockout') return shot?.render ? { id: shot.render.assetId, rec: shot.render } : null;
  if (node.type === 'still') {
    const at = normalAt(node.at), notes = momentNote(at);
    const ref = node.refId ? shot?.references.find(r => r.id === node.refId) : shot?.references.filter(r => r.role === 'frame' && notes.includes(r.note || '')).at(-1);
    return ref ? { id: ref.id, rec: ref } : null;
  }
  if (node.type === 'video') {
    const vids = (project.assets || []).filter(a => a.shotId === shot?.id && isVideo(a));
    const w = shot && winnerOf(project, shot), c = shot && cutClip(project, shot);
    const a = (node.assetId && vids.find(x => x.id === node.assetId)) || (w && vids.find(x => x.id === w.assetId)) || (c?.assetId && vids.find(x => x.id === c.assetId)) || vids.sort((x, y) => String(x.createdAt).localeCompare(String(y.createdAt))).at(-1);
    return a ? { id: a.id, rec: a } : null;
  }
  if (node.type === 'look') { const ref = objectLooks(project, node.entityId)[0]; return ref ? { id: ref.id, rec: ref } : null; }
  return null;
}
const recordedOf = (type, rec) => (type === 'blockout' ? rec.regen : type === 'video' ? rec.source?.regen : rec.generated?.regen);
const LEGACY = { code: 'blocking', part: 'signature', text: 'the camera, timing or scene changed since it was made (older output: no per-input record)' };

/**
 * Is a node's kept output current, and if not, why. node: { type: 'blockout'|'still'|'video'|'look', shotId?, at?, refId?,
 * assetId?, entityId? }; opts: what the caller knows about the next run ({ model, params, refs, def, cameraSource, uses }).
 * Returns { state: 'missing'|'fresh'|'stale'|'pinned'|'uploaded', output: { id }|null, legacy, blocking (a blocking reason),
 * reasons, key (current), madeKey }. Pinned outputs report their reasons but count as accepted.
 */
export function explainStale(project, node, opts = {}) {
  const shot = node.shotId ? project.shots.find(s => s.id === node.shotId) : null;
  if (node.shotId && !shot) return { state: 'missing', output: null, legacy: false, blocking: false, reasons: [{ code: 'missing', part: 'shot', text: 'unknown shot' }] };
  const out = nodeOutput(project, node);
  if (!out) return { state: 'missing', output: null, legacy: false, blocking: false, reasons: [{ code: 'missing', part: 'output', text: 'not made yet' }] };
  const { rec } = out, output = { id: out.id };
  if ((node.type === 'still' || node.type === 'look') && !rec.generated) return { state: 'uploaded', output, legacy: false, blocking: false, reasons: [] };
  const made = recordedOf(node.type, rec), target = { shot, at: node.at, entityId: node.entityId };
  let reasons, legacy = false, key = null;
  if (isManifest(made)) {
    const now = currentFor(project, made, target, opts);
    reasons = now ? diffParts(project, made.parts, now.parts) : [{ code: 'missing', part: 'target', text: 'the object or shot it was made for is gone' }];
    key = now?.key ?? null;
  } else {
    legacy = true;
    const old = node.type === 'blockout' ? blockoutStale(project, shot) : node.type === 'still' ? stillStale(project, shot, { ...rec, pinned: false }) : node.type === 'video' ? videoStale(project, shot, { ...rec, pinned: false }) : false;
    reasons = old ? [LEGACY] : [];
  }
  const blocking = reasons.some(r => r === LEGACY || isBlockingPart(r.part) || r.code.startsWith('object-'));
  const state = rec.pinned ? 'pinned' : reasons.length ? 'stale' : 'fresh';
  return { state, output, legacy, blocking, reasons, key, madeKey: isManifest(made) ? made.key : null };
}
/**
 * Whether a shot needs a new video for preset `runs` (the preset that will run; `def` the one chosen, when a start-only
 * sibling stands in), as the batch decides: the chosen take if pinned; else any take whose recorded key matches what this run
 * would send; a take from before manifests counts only when its blocking and its model (via `definitions`) still match.
 */
export function videoVerdict(project, shot, { def, runs = def, cameraSource = cameraSourceOf(runs), definitions = [] }) {
  const opts = { def: runs, model: runs.id, cameraSource, uses: videoUses(runs) };
  const chosen = explainStale(project, { type: 'video', shotId: shot.id }, opts);
  if (chosen.state === 'missing' || chosen.state === 'pinned') return chosen;
  const now = videoKey(project, shot, opts);
  const vids = (project.assets || []).filter(a => a.shotId === shot.id && isVideo(a));
  const same = vids.find(a => isManifest(a.source?.regen) && !diffParts(project, a.source.regen.parts, now.parts).length);
  if (same) return { ...chosen, state: 'fresh', output: { id: same.id }, reasons: [] };
  const presetOf = id => { const d = definitions.find(x => x.id === id); return d?.provenance?.presetId || d?.id || null; };
  const legacy = vids.filter(a => !isManifest(a.source?.regen)).find(a => { const m = presetOf(a.source?.definitionId); return (m === runs.id || m === def.id) && !explainStale(project, { type: 'video', shotId: shot.id, assetId: a.id }).reasons.length; });
  if (legacy) return { ...chosen, state: 'fresh', legacy: true, output: { id: legacy.id }, reasons: [] };
  return chosen.legacy && !chosen.reasons.length ? { ...chosen, state: 'stale', reasons: [LEGACY_VIDEO] } : chosen;
}
const LEGACY_VIDEO = { code: 'unrecorded', part: 'model', text: 'older take: the model it was made with is not recorded' };

/** One line for a tooltip: "Out of date: camera changed; Eagle moved." (or "Up to date", "Pinned …"). */
export function staleText(x) {
  if (!x) return '';
  const why = x.reasons.map(r => r.text).filter((t, i, a) => a.indexOf(t) === i);
  const list = why.length > 4 ? `${why.slice(0, 4).join('; ')}; +${why.length - 4} more` : why.join('; ');
  if (x.state === 'pinned') return why.length ? `Pinned: kept although ${list}` : 'Pinned: kept as is';
  if (x.state === 'stale') return `Out of date: ${list}.`;
  if (x.state === 'missing') return 'Not made yet';
  return x.state === 'uploaded' ? 'Uploaded: never out of date' : 'Up to date';
}

// ---------- What depends on an object ----------
/**
 * What would be remade if an object (or its look) changed: { object: { shots, stills, videos }, look: { shots, stills, videos } }.
 * object = shots whose blockout frames can show it (moving or reshaping it); look = shots whose cast uses its look (looks are
 * shared through "use look from"). stills/videos count the generated takes those shots keep now.
 */
export function dependentsOf(project, entityId) {
  const src = lookSource(project, entityId)?.id || entityId;
  const sharers = new Set(project.scene.entities.filter(e => (lookSource(project, e.id)?.id || e.id) === src).map(e => e.id));
  const count = shots => ({
    shots: shots.map(s => s.id),
    stills: shots.reduce((n, s) => n + (s.references || []).filter(r => r.role === 'frame' && r.generated).length, 0),
    videos: shots.reduce((n, s) => n + (project.assets || []).filter(a => a.shotId === s.id && isVideo(a)).length, 0),
  });
  return {
    object: count(project.shots.filter(s => `move:${entityId}` in blockoutManifest(project, s).parts)),
    look: count(project.shots.filter(s => castRows(project, s).some(r => r.inCast && sharers.has(r.entity.id)))),
  };
}
