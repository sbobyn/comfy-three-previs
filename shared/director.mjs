// Copyright (c) 2026 Steven Bobyn. SPDX-License-Identifier: MIT
// Director scene model shared by the browser workspace, the server and MCP tools.
// Units are metres. The stage faces +z: "front" is toward the default camera,
// "left" is -x as seen from the default camera.
import { normalizePose, blendPose, keyEase } from './blockout-pose.mjs';
import { blockoutModel, projectMesh } from './blockout-models.mjs';
import { normalizeSheets } from './sheet-presets.mjs';
import { cameraLine } from './camera-source.mjs';
import { normalizeSource, normalizePerform, normalizeStandIn } from './imported-asset.mjs';

export const SHAPES = {
  person: { size: [0.5, 1.8, 0.35], kind: 'character', color: '#e8b04b' },
  car: { size: [1.9, 1.45, 4.5], kind: 'vehicle', color: '#d9534f' },
  bird: { size: [2.4, 0.5, 1.1], kind: 'prop', color: '#3b2a1e' },
  box: { size: [1, 1, 1], kind: 'prop', color: '#9aa7b8' },
  table: { size: [1.6, 0.75, 0.9], kind: 'prop', color: '#a07a55' },
  chair: { size: [0.5, 0.9, 0.5], kind: 'prop', color: '#8a6a4a' },
  sphere: { size: [1, 1, 1], kind: 'prop', color: '#7fb2e5' },
  cylinder: { size: [0.8, 1.2, 0.8], kind: 'prop', color: '#b4b4c4' },
  lamp: { size: [0.3, 4, 0.3], kind: 'prop', color: '#c9c27a' },
  building: { size: [6, 12, 6], kind: 'environment', color: '#59606e' },
  wall: { size: [8, 3, 0.25], kind: 'environment', color: '#6b7280' },
  tree: { size: [2.5, 5, 2.5], kind: 'environment', color: '#4f8a5b' },
  rock: { size: [1.5, 1, 1.3], kind: 'environment', color: '#7d7468' },
  // An empty that holds other objects; moving it moves its children. Never rendered or cast.
  group: { size: [0.5, 0.5, 0.5], kind: 'environment', color: '#9aa7b8' },
  // Sculpted ground: a valley ringed by mountains (heights from shared/terrain.mjs). 480 m across at scale 1.
  terrain: { size: [480, 160, 480], kind: 'environment', color: '#6f8f4e' },
};
export const KINDS = ['character', 'vehicle', 'prop', 'environment'];
export const ROLES = ['character', 'prop', 'environment', 'style', 'frame'];
export const MOVES = {
  static: 'Locked-off',
  'dolly-in': 'Dolly in',
  'dolly-out': 'Dolly out',
  'truck-left': 'Truck left',
  'truck-right': 'Truck right',
  'pan-left': 'Pan left',
  'pan-right': 'Pan right',
  'orbit-left': 'Orbit left',
  'orbit-right': 'Orbit right',
  'crane-up': 'Crane up',
  'crane-down': 'Crane down',
  'tilt-up': 'Tilt up',
  custom: 'Custom keys',
};
export const MAX_DURATION = 5; // Browser export supports at most 120 frames at 24 fps.

export function handleOf(name) {
  return String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item';
}

export function uniqueName(entities, wanted) {
  const taken = new Set(entities.map(e => handleOf(e.name)));
  if (!taken.has(handleOf(wanted))) return wanted;
  for (let i = 2; ; i++) if (!taken.has(handleOf(`${wanted} ${i}`))) return `${wanted} ${i}`;
}

export function makeEntity(input, id) {
  const shape = SHAPES[input.shape] ? input.shape : 'box';
  const base = SHAPES[shape];
  const vec = (v, n, d) => (Array.isArray(v) && v.length === n && v.every(Number.isFinite) ? v.map(x => Math.max(-500, Math.min(500, x))) : d);
  return {
    id,
    name: String(input.name || shape).slice(0, 60),
    kind: KINDS.includes(input.kind) ? input.kind : base.kind,
    shape,
    ...(blockoutModel({ ...input, shape }) ? { model: input.model } : {}),
    position: vec(input.position, 3, [0, 0, 0]),
    rotation: Number.isFinite(input.rotation) ? ((input.rotation % 360) + 360) % 360 : 0,
    scale: vec(input.scale, 3, [1, 1, 1]).map(x => Math.max(0.05, Math.min(50, x))),
    color: /^#[0-9a-f]{6}$/i.test(input.color || '') ? input.color : base.color,
    notes: String(input.notes || '').slice(0, 500),
    look: typeof input.look === 'string' ? input.look : null,
    lookFrom: typeof input.lookFrom === 'string' && input.lookFrom !== id ? input.lookFrom : null,
    styleNotes: String(input.styleNotes || '').slice(0, 300),
    pitch: tiltOf(input.pitch),
    roll: tiltOf(input.roll),
    path: normalizePath(input.path),
    ...(normalizePose(input.pose) ? { pose: normalizePose(input.pose) } : {}),
    parent: typeof input.parent === 'string' && input.parent !== id ? input.parent : null,
    ...sheetsOf(input.sheets),
    ...fromOf(input.from),
    ...importedOf(input),
  };
}
// Imported meshes (docs/import.md): provenance and rig (never in a shot signature), the clip it plays, its stand-in.
function importedOf(input) {
  const source = projectMesh(input.model) ? normalizeSource(input.source) : undefined;
  if (!source) return {};
  const perform = normalizePerform(input.perform, source), standIn = normalizeStandIn(input.standIn);
  return { source, ...(perform ? { perform } : {}), ...(standIn ? { standIn } : {}) };
}
// Design sheets (views generated from the primary look); stored only when present.
function sheetsOf(v) { const sheets = normalizeSheets(v); return sheets ? { sheets } : {}; }
// Library provenance of a placed object (server/previs/library.mjs); stored only when present, never part of a shot signature.
function fromOf(v) {
  if (!v || typeof v !== 'object' || !/^[a-f0-9-]{36}$/.test(v.asset || '')) return {};
  return { from: { asset: v.asset, version: Number.isInteger(v.version) && v.version > 0 ? v.version : 1, handle: handleOf(v.handle || 'asset').slice(0, 60) } };
}

// ---------- Hierarchy ----------
/** Every object below id (children, grandchildren…), parents before children. */
export function descendantsOf(entities, id) {
  const out = [], seen = new Set([id]);
  for (let i = -1; i < out.length; i++) {
    const pid = i < 0 ? id : out[i].id;
    for (const e of entities) if (e.parent === pid && !seen.has(e.id)) { seen.add(e.id); out.push(e); }
  }
  return out;
}
/** The top-most ancestor (itself when it has no parent). */
export function rootOf(entities, id) {
  let e = entities.find(x => x.id === id);
  for (let i = 0; e?.parent && i < 32; i++) { const p = entities.find(x => x.id === e.parent); if (!p) break; e = p; }
  return e || null;
}
/** ids plus all their descendants, without duplicates. */
export function withDescendants(entities, ids) {
  const out = new Set(ids);
  for (const id of ids) for (const d of descendantsOf(entities, id)) out.add(d.id);
  return [...out];
}

export function entitySize(entity) {
  const base = SHAPES[entity.shape]?.size || [1, 1, 1];
  return base.map((v, i) => v * entity.scale[i]);
}

// Point the camera looks at for an entity: chest/eye height for people, centre otherwise.
export function focusPoint(entity) {
  const [, h] = entitySize(entity);
  const y = entity.shape === 'person' ? h * 0.85 : entity.shape === 'building' ? Math.min(h * 0.5, 4) : h * 0.55;
  return [entity.position[0], entity.position[1] + y, entity.position[2]];
}

export function defaultCamera(target = null) {
  return { move: 'dolly-in', target, distance: 6, height: 1.6, angle: 0, mm: 35, keys: null };
}

export function makeShot(input, id, number, entities = []) {
  const target = input.camera?.target ?? entities.find(e => e.kind === 'character')?.id ?? entities[0]?.id ?? null;
  return {
    id,
    title: String(input.title || `Shot ${number}`).slice(0, 120),
    description: String(input.description || '').slice(0, 4000),
    duration: clampDuration(input.duration ?? 3),
    start: clampStart(input.start ?? 0),
    camera: normalizeCamera({ ...defaultCamera(target), ...(input.camera || {}) }),
    references: [],
    render: null,
    cast: normalizeCast(input.cast),
  };
}

// ---------- Cast ----------
/** A shot's explicit cast changes on top of what its camera sees: { include: ids, exclude: ids }. */
export function normalizeCast(c) {
  const ids = v => [...new Set((Array.isArray(v) ? v : []).filter(x => typeof x === 'string' && x).map(String))].slice(0, 200);
  const include = ids(c?.include), exclude = ids(c?.exclude).filter(id => !include.includes(id));
  return { include, exclude };
}
/**
 * The Cast Card of one object: everything a render needs to know about it. The blockout object *is* the record,
 * so blockoutId always matches the rendered object. Objects that share a look inherit its images, description and style notes.
 */
export function castCard(project, id) {
  const e = project.scene.entities.find(x => x.id === id); if (!e) return null;
  const src = lookSource(project, id) || e;
  return { id: e.id, blockoutId: e.id, name: e.name, kind: e.kind, shape: e.shape, description: objectNotes(project, e), styleNotes: [src.id !== e.id ? src.styleNotes : '', e.styleNotes].map(x => (x || '').trim().replace(/[\s.,;:]+$/, '')).filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join('; '), imageRefs: objectLooks(project, id).map(r => r.id), sharedFrom: src.id !== e.id ? src.id : null };
}
/**
 * Every object with its place in a shot's cast: auto (the camera sees it), added or removed by hand.
 * Returns [{ entity, coverage, lead, auto, inCast }] — inCast is the final answer.
 */
export function castRows(project, shot) {
  const seen = new Map(shotCast(project, shot).map(c => [c.entity.id, c]));
  const cast = normalizeCast(shot.cast);
  return project.scene.entities.filter(e => e.shape !== 'group').map(e => {
    const c = seen.get(e.id), auto = !!c;
    const inCast = cast.include.includes(e.id) || (auto && !cast.exclude.includes(e.id));
    return { entity: e, coverage: c?.coverage ?? 0, lead: c?.lead ?? false, auto, inCast, override: cast.include.includes(e.id) ? 'added' : cast.exclude.includes(e.id) ? 'removed' : null };
  });
}
/** The shot's cast: objects in it, most prominent first (same shape as shotCast). */
export function shotObjects(project, shot) {
  return castRows(project, shot).filter(r => r.inCast).sort((a, b) => (b.lead - a.lead) || (b.coverage - a.coverage)).map(r => ({ entity: r.entity, coverage: r.coverage, lead: r.lead }));
}

export function clampDuration(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(Math.max(0.5, Math.min(MAX_DURATION, n)) * 100) / 100 : 3;
}

export function normalizeCamera(c) {
  const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Number(v))) : d);
  const point = v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
  const keys = Array.isArray(c.keys) && c.keys.length >= 1 && c.keys.length <= 64 && c.keys.every(k => point(k.p) && point(k.look) && Number.isFinite(k.t))
    ? c.keys.map(k => ({ t: num(k.t, 0, 1, 0), p: k.p, look: k.look, mm: num(k.mm, 8, 300, 35) })).sort((a, b) => a.t - b.t)
    : null;
  const move = MOVES[c.move] ? c.move : 'static';
  return {
    move: move === 'custom' && !keys ? 'static' : move,
    target: typeof c.target === 'string' ? c.target : null,
    distance: num(c.distance, 0.5, 200, 6),
    height: num(c.height, 0.1, 200, 1.6),
    angle: num(c.angle, -720, 720, 0),
    mm: num(c.mm, 8, 300, 35),
    keys: move === 'custom' ? keys : null,
    // [operate] Recorded performances play back at their recorded pace (no whole-shot ease).
    ...(move === 'custom' && keys && c.timing === 'linear' ? { timing: 'linear' } : {}),
  };
}

const add = (a, b) => a.map((x, i) => x + b[i]);
const lerp = (a, b, u) => a + (b - a) * u;
const lerp3 = (a, b, u) => a.map((x, i) => lerp(x, b[i], u));
const rad = d => (d * Math.PI) / 180;

// Normalised keyframes (t in 0..1) for a shot's camera.
export function cameraKeys(shot, entities) {
  const c = shot.camera;
  if (c.move === 'custom' && c.keys?.length) return c.keys;
  const target = entities.find(e => e.id === c.target);
  const look = target ? focusPoint(target) : [0, 1.2, 0];
  const place = (angle, distance, height) => [look[0] + distance * Math.sin(rad(angle)), height, look[2] + distance * Math.cos(rad(angle))];
  const { distance: d, height: h, angle: a, mm } = c;
  const key = (t, p, l = look) => ({ t, p, look: l, mm });
  const right = [Math.cos(rad(a)), 0, -Math.sin(rad(a))];
  switch (c.move) {
    case 'dolly-in': return [key(0, place(a, d, h)), key(1, place(a, d * 0.55, h))];
    case 'dolly-out': return [key(0, place(a, d * 0.55, h)), key(1, place(a, d, h))];
    case 'truck-left':
    case 'truck-right': {
      const s = (c.move === 'truck-left' ? -1 : 1) * d * 0.5;
      const off = right.map(x => x * s);
      const p = place(a, d, h);
      return [key(0, add(p, off.map(x => -x / 2)), add(look, off.map(x => -x / 2))), key(1, add(p, off.map(x => x / 2)), add(look, off.map(x => x / 2)))];
    }
    case 'pan-left':
    case 'pan-right': {
      const p = place(a, d, h), s = c.move === 'pan-left' ? 1 : -1;
      const aim = deg => { const dir = [look[0] - p[0], look[2] - p[2]], r = rad(deg), cs = Math.cos(r), sn = Math.sin(r); return [p[0] + dir[0] * cs - dir[1] * sn, look[1], p[2] + dir[0] * sn + dir[1] * cs]; };
      return [key(0, p, aim(-12 * s)), key(1, p, aim(18 * s))];
    }
    case 'orbit-left':
    case 'orbit-right': {
      const s = c.move === 'orbit-left' ? -1 : 1;
      return Array.from({ length: 9 }, (_, i) => key(i / 8, place(a + s * 60 * (i / 8), d, h)));
    }
    case 'crane-up': return [key(0, place(a, d, Math.max(0.3, h - 0.8))), key(1, place(a, d, h + 3))];
    case 'crane-down': return [key(0, place(a, d, h + 3)), key(1, place(a, d, Math.max(0.3, h - 0.8)))];
    case 'tilt-up': { const p = place(a, d, h); return [key(0, p, [look[0], Math.max(0, look[1] - 1), look[2]]), key(1, p, [look[0], look[1] + 2.5, look[2]])]; }
    default: { const p = place(a, d, h); return [key(0, p), key(1, p)]; }
  }
}

const ease = u => u * u * (3 - 2 * u);

// Camera pose at absolute time t seconds. timing 'linear' skips the whole-shot ease (recorded takes).
export function cameraAt(keys, duration, t, timing = 'ease') {
  const raw = Math.max(0, Math.min(1, duration > 0 ? t / duration : 0));
  const u = timing === 'linear' ? raw : ease(raw);
  if (keys.length === 1 || u <= keys[0].t) return { p: keys[0].p, look: keys[0].look, mm: keys[0].mm };
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1], b = keys[i];
    if (u <= b.t) { const v = b.t > a.t ? (u - a.t) / (b.t - a.t) : 1; return { p: lerp3(a.p, b.p, v), look: lerp3(a.look, b.look, v), mm: lerp(a.mm, b.mm, v) }; }
  }
  const last = keys.at(-1);
  return { p: last.p, look: last.look, mm: last.mm };
}

export function describeCamera(shot, entities) {
  const c = shot.camera, target = entities.find(e => e.id === c.target);
  const lens = c.mm <= 24 ? 'wide' : c.mm >= 70 ? 'telephoto' : 'normal';
  const angle = c.height < 0.9 ? 'low angle' : c.height > 3.5 ? 'high angle' : 'eye level';
  return `${MOVES[c.move]}${target && c.move !== 'custom' ? ` on ${target.name}` : ''}, ${Math.round(c.mm)}mm ${lens}, ${angle}, ${shot.duration}s`;
}

// Text prompt handed to the render workflow. References are listed by name and link.
// ---------- What a shot sees ----------
const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = a => { const l = Math.hypot(...a) || 1; return a.map(v => v / l); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/**
 * Objects the shot camera actually sees, most prominent first: [{ entity, coverage }].
 * Samples the camera over the shot (objects animate on the scene timeline) and keeps anything whose
 * bounding sphere enters the 16:9 frame at a readable size. coverage ≈ share of frame height (0–1).
 */
export function shotCast(project, shot, { samples = 12, aspect = 16 / 9, minCoverage = 0.06 } = {}) {
  const entities = project.scene.entities, start = shot.start || 0, best = new Map();
  for (let i = 0; i < samples; i++) {
    const t = samples === 1 ? 0 : (shot.duration * i) / (samples - 1);
    const cam = shotCameraAt(shot, entities, t);
    const f = unit(sub(cam.look, cam.p));
    let r = cross(f, [0, 1, 0]); if (Math.hypot(...r) < 1e-6) r = [1, 0, 0]; r = unit(r);
    const u = cross(r, f);
    // three.js setFocalLength with a 35 mm film gauge: film height = 35 / aspect for landscape frames.
    const tanV = (35 / aspect) / 2 / Math.max(1, cam.mm), tanH = tanV * aspect;
    for (const e of entities) {
      if (e.shape === 'group') continue;
      const at = e.path?.length ? { ...e, ...entityAt(e, start + t) } : e;
      const size = entitySize(at), radius = Math.hypot(...size) / 2;
      const d = sub([at.position[0], at.position[1] + size[1] / 2, at.position[2]], cam.p);
      const z = dot(d, f);
      if (z + radius <= 0.05) continue;
      const zz = Math.max(z, 0.05);
      if (Math.abs(dot(d, r)) - radius > zz * tanH || Math.abs(dot(d, u)) - radius > zz * tanV) continue;
      const coverage = Math.min(1, radius / (zz * tanV));
      if (coverage < minCoverage) continue;
      best.set(e.id, Math.max(best.get(e.id) || 0, coverage));
    }
  }
  if (shot.camera.target && entities.some(e => e.id === shot.camera.target)) best.set(shot.camera.target, Math.max(best.get(shot.camera.target) || 0, 1.01)); // the subject leads
  return entities.filter(e => best.has(e.id)).map(e => ({ entity: e, coverage: Math.min(1, best.get(e.id)) , lead: e.id === shot.camera.target })).sort((a, b) => (b.lead - a.lead) || (b.coverage - a.coverage));
}

/** Camera-truth hash: unposed bundled models keep the legacy fidelity-only policy.
 * Imported meshes and posed rigs determine the silhouette; their IDs and all pose keys invalidate earlier media.
 * Same text as src/director-capture.ts shotSignature (tests/headless.test.mjs). */
export const shotSignature = (p, s) => { const text = JSON.stringify([cameraKeys(s, p.scene.entities), s.duration, s.start || 0, p.scene.entities.filter(e => e.shape !== 'group').map(({ look, notes, name, styleNotes, lookFrom, parent, sheets, model, from, source, ...e }) => ({ ...e, ...(projectMesh(model) || e.pose || e.path?.some(k => k.pose) ? { model: model?.split('/').pop() } : {}) })), p.scene.environment.preset]); let x = 5381; for (let i = 0; i < text.length; i++) x = ((x << 5) + x + text.charCodeAt(i)) | 0; return (x >>> 0).toString(16); };
/** The shot's blockout clip no longer matches its camera, timing or scene (it is made again before a video uses it). */
export const blockoutStale = (project, shot) => !!(shot.render && shot.render.signature && shot.render.signature !== shotSignature(project, shot));
/** The shot's blockout clip is a Blender render (server/previs/blender-import.mjs) that still matches the shot, so its frames are the still guide. */
export const blenderBlockout = (project, shot) => shot.render?.origin === 'blender' && !blockoutStale(project, shot);

/**
 * A generated key-frame still made for an earlier blocking (camera, timing or scene). New stills record the shot
 * signature they were made at; an older generated still without one counts as stale when the shot's blockout clip is
 * newer than it (blockouts are made again only when the shot changes). Uploaded frames are never stale.
 */
export function stillStale(project, shot, ref) {
  if (!ref?.generated) return false;
  const made = ref.generated.signature;
  if (made) return made !== shotSignature(project, shot);
  return !!(shot.render?.createdAt && ref.createdAt && ref.createdAt < shot.render.createdAt);
}

/**
 * A generated video made for an earlier blocking: the blockout clip it was made from recorded another shot
 * signature, or (no signature recorded) the shot has a newer blockout clip. A video whose source clip is unknown
 * is not judged.
 */
export function videoStale(project, shot, video) {
  if (video?.kind !== 'workflow-result') return false;
  const assets = project.assets || [];
  const src = assets.find(a => a.id === video.source?.sourceAssetId && a.kind === 'camera-render');
  if (!src) return false;
  const made = src.source?.signature || (shot.render?.assetId === src.id ? shot.render.signature : null);
  if (made) return made !== shotSignature(project, shot);
  return assets.some(a => a.kind === 'camera-render' && a.shotId === shot.id && a.id !== src.id && String(a.createdAt) > String(src.createdAt));
}

/**
 * The blockout clip a starter shipped for a shot that has no blockout of its own yet (its newest one), and whether it
 * shows the shot as it is now (`fresh` is null when the clip recorded no signature). Starter clips can be watched,
 * but generating still makes the shot's own blockout first.
 */
export function starterBlockout(project, shot) {
  if (shot.render) return null;
  const clip = (project.assets || []).filter(a => a.kind === 'camera-render' && a.shotId === shot.id && a.starter).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  if (!clip) return null;
  const made = clip.source?.signature;
  return { asset: clip, fresh: made ? made === shotSignature(project, shot) : null };
}

/**
 * What a project made from a starter is missing or has out of date: media files the snapshot lists that were not in
 * the checkout (`starterFiles.missing`, recorded when the project was created) and shots whose generated stills or
 * cut video were made for an earlier blocking. Null for other projects or when nothing is off.
 */
export function starterMediaStatus(project) {
  if (!(project.assets || []).some(a => a.starter) && !project.starterFiles) return null;
  const clipOf = s => { const c = project.edit?.clips?.find(x => x.shotId === s.id); return (project.assets || []).find(a => a.id === c?.assetId) || null; };
  const staleShots = project.shots.filter(s => (s.references || []).some(r => r.role === 'frame' && stillStale(project, s, r)) || videoStale(project, s, clipOf(s))).map(s => s.id);
  const missing = project.starterFiles?.missing || 0, listed = project.starterFiles?.listed || 0;
  return missing || staleShots.length ? { missing, listed, staleShots } : null;
}

/** The shot's chosen start still and end still (its newest key frames), each null when missing. */
export function keyStills(shot) {
  const frames = (shot.references || []).filter(r => r.role === 'frame');
  const start = frames.filter(r => r.note === 'key frame start').at(-1) || frames.filter(r => !r.note).at(-1) || frames.filter(r => r.note !== 'key frame end').at(0) || null;
  return { start, end: frames.filter(r => r.note === 'key frame end').at(-1) || null };
}

/** The shot's chosen start and end stills with readiness: 'missing', 'stale' (made for an earlier blocking) or 'ready'. */
export function keyStillState(project, shot) {
  const ks = keyStills(shot), state = r => (!r ? 'missing' : stillStale(project, shot, r) ? 'stale' : 'ready');
  return { start: ks.start, end: ks.end, startState: state(ks.start), endState: state(ks.end) };
}

/**
 * Reference images a shot's video generation should use, in order, capped at `max`:
 * the look of each object in the shot (subject first), then environment references, then style, then key frames.
 * With `stills` (a model that follows the blockout clip) the start and end stills lead instead, as the look
 * of the shot, and the cast follows. Stills made for an earlier blocking (stillStale) are never used.
 * Returns [{ ref, entityId, role, label }].
 */
export function videoReferences(project, shot, max = 4, { stills = false } = {}) {
  const cast = shotObjects(project, shot);
  const look = id => objectLooks(project, id)[0] || shot.references.find(r => r.entityId === id && r.role !== 'frame') || null;
  const subjects = cast.filter(c => c.entity.kind !== 'environment').map(c => ({ ref: look(c.entity.id), entityId: c.entity.id, role: c.entity.kind, label: c.entity.name })).filter(x => x.ref);
  const envObjects = cast.filter(c => c.entity.kind === 'environment').map(c => ({ ref: look(c.entity.id), entityId: c.entity.id, role: 'environment', label: c.entity.name })).filter(x => x.ref);
  const envShot = shot.references.filter(r => r.role === 'environment' && !r.entityId).map(r => ({ ref: r, entityId: null, role: 'environment', label: 'environment' }));
  const style = shot.references.filter(r => r.role === 'style').map(r => ({ ref: r, entityId: null, role: 'style', label: 'style' }));
  // A still made for an earlier blocking would hand the model the old layout: it is left out (the caller says so).
  const ks = keyStills(shot), fresh = r => r && !stillStale(project, shot, r);
  const lead = stills ? [fresh(ks.start) && { ref: ks.start, entityId: null, role: 'frame', label: 'start still' }, fresh(ks.end) && ks.end.id !== ks.start?.id && { ref: ks.end, entityId: null, role: 'frame', label: 'end still' }].filter(Boolean) : [];
  const frames = stills ? [] : shot.references.filter(r => r.role === 'frame').slice(-1).filter(fresh).map(r => ({ ref: r, entityId: null, role: 'frame', label: 'key frame' }));
  const env = [...envShot, ...envObjects];
  // Keep a slot for the environment when there is one, so every shot shares the same world (the stills already show it).
  const room = Math.max(0, max - lead.length - (env.length && !lead.length ? 1 : 0));
  const out = [...lead, ...subjects.slice(0, room), ...env, ...style, ...subjects.slice(room), ...frames];
  const seen = new Set();
  return out.filter(x => !seen.has(x.ref.id) && seen.add(x.ref.id)).slice(0, Math.max(0, max));
}

/**
 * Prompt for a shot. With `refs` (from videoReferences) each object names its numbered reference image.
 * It never describes the camera move: it ends with the camera line for `cameraSource` (shared/camera-source.mjs).
 */
export function compilePrompt(project, shot, refs = null, { cameraSource = 'blockout' } = {}) {
  const { entities, environment } = project.scene;
  const lines = [];
  const desc = shot.description.replace(/@([a-z0-9-]+)/gi, (m, h) => entities.find(e => handleOf(e.name) === h.toLowerCase())?.name || m);
  lines.push(desc.trim() || shot.title);
  lines.push(`Lens: ${Math.round(shot.camera.mm)}mm.`);
  const num = id => (refs ? refs.findIndex(x => x.ref.id === id) + 1 : 0);
  const refFor = id => [...objectLooks(project, id).slice(0, 1), ...shot.references.filter(r => r.entityId === id && r.role !== 'frame')];
  const describe = e => {
    // Objects sharing a look point at the same numbered image.
    const own = refFor(e.id), mine = new Set(own.map(r => r.id));
    const numbered = refs ? [...new Set(refs.filter(x => x.entityId === e.id || mine.has(x.ref.id)).map(x => num(x.ref.id)))] : [];
    const match = refs ? (numbered.length ? ` — looks exactly like reference image ${numbered.join(' and ')}` : '') : own.length ? ` — match reference ${own.map(r => `“${r.name}”`).join(', ')}` : '';
    const notes = objectNotes(project, e);
    return `${e.name} (${e.kind}${notes ? `, ${notes}` : ''})${match}`;
  };
  // Only what the camera sees; fall back to everything when nothing is in frame (e.g. an empty stage).
  const castIds = new Set(shotObjects(project, shot).map(c => c.entity.id));
  const inShot = castIds.size ? entities.filter(e => castIds.has(e.id)) : entities;
  const subjects = inShot.filter(e => e.kind !== 'environment');
  if (subjects.length) lines.push(`In shot: ${subjects.slice(0, 10).map(describe).join('; ')}.`);
  const env = inShot.filter(e => e.kind === 'environment');
  const envRefs = shot.references.filter(r => r.role === 'environment' && !r.entityId);
  const envRefText = refs ? envRefs.filter(r => num(r.id)).map(r => `match the environment in reference image ${num(r.id)}`) : envRefs.map(r => `match reference “${r.name}”`);
  if (environment?.description || env.length || envRefText.length) lines.push(`Environment: ${[environment?.description, env.length ? env.slice(0, 6).map(describe).join('; ') : '', envRefText.join(', ')].filter(Boolean).join('; ')}.`);
  const frames = shot.references.filter(r => r.role === 'frame');
  if (frames.length) lines.push(refs ? (frames.some(r => num(r.id)) ? `Look: match the key frame in reference image ${frames.map(r => num(r.id)).filter(Boolean).join(', ')}.` : '') : `Look: match key frame ${frames.map(r => `“${r.name}”`).join(', ')}.`);
  const style = shot.references.filter(r => r.role === 'style');
  if (style.length) lines.push(refs ? (style.some(r => num(r.id)) ? `Style: match reference image ${style.map(r => num(r.id)).filter(Boolean).join(', ')}.` : '') : `Style: match ${style.map(r => `“${r.name}”`).join(', ')}.`);
  if (environment?.style) lines.push(`Visual style: ${environment.style}.`);
  if (refs?.length) lines.push(`Keep every object consistent with its reference image across the whole shot.`);
  lines.push(cameraLine(cameraSource));
  return lines.filter(Boolean).join('\n');
}

/** Short legend appended to a hand-edited prompt so numbered references still map to objects. */
export function referenceLegend(refs) {
  return refs.length ? `Reference images: ${refs.map((x, i) => `${i + 1} = ${x.role === 'frame' ? (/^(start|end) still$/.test(x.label) ? x.label : 'key frame') : x.role === 'style' ? 'style' : x.role === 'environment' && !x.entityId ? 'environment' : x.label}`).join('; ')}.` : '';
}

const ent = (name, shape, position, extra = {}) => ({ name, shape, position, ...extra });
export const TEMPLATES = {
  empty: { title: 'Empty stage', description: 'A clean ground plane.', environment: { preset: 'stage', description: '' }, entities: [] },
  street: {
    title: 'Night street',
    description: 'City block with a car and a runner.',
    environment: { preset: 'street', description: 'a wet city street at night, sodium streetlights' },
    entities: [
      ent('Runner', 'person', [1.5, 0, 2], { rotation: 300, color: '#e8b04b' }),
      ent('Car', 'car', [-1.6, 0, -1], { rotation: 0 }),
      ent('Building left', 'building', [-9, 0, -6]),
      ent('Building right', 'building', [9, 0, -8], { scale: [1, 1.4, 1] }),
      ent('Streetlamp', 'lamp', [3.5, 0, -2]),
    ],
  },
  interior: {
    title: 'Two-hander interior',
    description: 'Two characters across a table.',
    environment: { preset: 'interior', description: 'a dim kitchen interior, practical lamp light' },
    entities: [
      ent('Ava', 'person', [-1.1, 0, 0], { rotation: 90, color: '#e8b04b' }),
      ent('Ben', 'person', [1.1, 0, 0], { rotation: 270, color: '#6fb7d8' }),
      ent('Table', 'table', [0, 0, 0]),
      ent('Back wall', 'wall', [0, 0, -3]),
      ent('Side wall', 'wall', [-4, 0, 1], { rotation: 90 }),
    ],
  },
  hero: {
    title: 'Hero reveal',
    description: 'One subject with a rock and tree, for turnarounds.',
    environment: { preset: 'stage', description: 'a minimal studio cyclorama' },
    entities: [ent('Hero', 'person', [0, 0, 0], { color: '#e8b04b' }), ent('Rock', 'rock', [2.4, 0, -1.5]), ent('Tree', 'tree', [-4, 0, -4])],
  },
};

// Object-level references ("looks"), shared by every shot. The primary look comes first.
/** The object whose looks and description an object uses: itself, or the one it shares a look with. */
export function lookSource(project, entityId) {
  let e = project.scene.entities.find(x => x.id === entityId) || null;
  for (let i = 0, seen = new Set(); e?.lookFrom && i < 4 && !seen.has(e.id); i++) {
    seen.add(e.id);
    const next = project.scene.entities.find(x => x.id === e.lookFrom);
    if (!next) break; e = next;
  }
  return e;
}
/** Description used in prompts: the shared object's description plus this object's own notes. */
export function objectNotes(project, entity) {
  const src = lookSource(project, entity.id);
  const parts = [...new Set([src && src.id !== entity.id ? src.notes : '', entity.notes].map(x => (x || '').trim()).filter(Boolean))];
  // Joined parts drop their own end punctuation, so a prompt never reads ".;".
  return parts.length > 1 ? parts.map(x => x.replace(/[\s.,;:]+$/, '')).join('; ') : parts.join('');
}
export function objectLooks(project, entityId) {
  const shared = lookSource(project, entityId);
  if (shared && shared.id !== entityId) return objectLooks(project, shared.id);
  const e = project.scene.entities.find(x => x.id === entityId);
  const list = (project.scene.references || []).filter(r => r.entityId === entityId);
  return list.sort((a, b) => (b.id === e?.look ? 1 : 0) - (a.id === e?.look ? 1 : 0));
}

const NAMED = [['red', [217, 83, 79]], ['blue', [63, 127, 214]], ['green', [79, 154, 91]], ['yellow', [232, 197, 71]], ['orange', [232, 135, 58]], ['purple', [142, 91, 214]], ['pink', [226, 127, 176]], ['black', [34, 36, 40]], ['white', [238, 238, 238]], ['grey', [138, 143, 152]], ['silver', [195, 199, 207]], ['gold', [212, 169, 58]], ['brown', [138, 90, 58]], ['teal', [58, 166, 160]], ['amber', [232, 176, 75]]];
export function colourName(hex) {
  const v = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  return NAMED.map(([n, c]) => [n, c.reduce((d, x, i) => d + (x - v[i]) ** 2, 0)]).sort((a, b) => a[1] - b[1])[0][0];
}

// Starting prompt for generating a reference image of one blockout object.
// Ways to photograph an object's look. Each kind offers the views that make a good reference.
export const LOOK_VIEWS = {
  character: { full: 'Full body', sheet: 'Character sheet', face: 'Face close-up' },
  vehicle: { three: 'Three-quarter', side: 'Side profile', sheet: 'Turnaround' },
  environment: { wide: 'Wide plate', detail: 'Detail' },
  prop: { three: 'Three-quarter', sheet: 'Turnaround' },
};
export const lookViews = entity => LOOK_VIEWS[entity.kind] || LOOK_VIEWS.prop;
export function lookPrompt(project, entity, view = null) {
  const style = project.scene.environment?.style ? ` Visual style: ${project.scene.environment.style}.` : '';
  // Names are for us, not the image: models otherwise paint them on as lettering or add extra copies.
  const only = entity.kind === 'environment' ? '' : ` Show exactly one ${entity.kind === 'character' ? 'person' : entity.kind === 'vehicle' ? 'vehicle' : 'object'}. No text, numbers, names or lettering anywhere in the image.`;
  const card = castCard(project, entity.id);
  const own = card?.styleNotes ? ` Look: ${card.styleNotes}.` : '';
  return lookPromptBase(project, entity, view) + own + only + style;
}
function lookPromptBase(project, entity, view) {
  const desc = objectNotes(project, entity), notes = desc ? `, ${desc}` : '';
  const colour = colourName(entity.color);
  const setting = project.scene.environment?.description;
  const v = view && lookViews(entity)[view] ? view : null;
  if (v === 'sheet') return `Turnaround reference sheet of ${entity.name}${notes}: the same ${entity.kind === 'character' ? 'person' : entity.kind === 'vehicle' ? 'vehicle' : 'object'} shown front, side and back in one image, evenly spaced, identical design in every view, ${colour} accents. Plain light grey background, soft even lighting, photorealistic.`;
  if (v === 'face') return `Close-up portrait reference of ${entity.name}${notes}. Head and shoulders, neutral expression, front three-quarter view, soft even lighting, plain light grey background, photorealistic, sharp focus.`;
  if (v === 'side') return `Side profile reference photo of ${entity.name}${notes}, a ${colour} ${entity.shape === 'car' ? 'car' : 'vehicle'}. Whole vehicle in frame, exact side view, plain studio background, soft even lighting, photorealistic.`;
  if (v === 'detail') return `Detail reference photo of ${entity.name}${notes}${setting ? ` in ${setting}` : ''}: surface materials and textures up close, natural light, photorealistic.`;
  switch (entity.kind) {
    case 'character': return `Character reference photo of ${entity.name}${notes}. Full body, standing, front three-quarter view, ${colour} accents in the wardrobe. Plain light grey studio background, soft even lighting, photorealistic, sharp focus.${setting ? ` Wardrobe suits ${setting}.` : ''}`;
    case 'vehicle': return `Reference photo of ${entity.name}${notes}, a ${colour} ${entity.shape === 'car' ? 'car' : 'vehicle'}. Whole vehicle in frame, front three-quarter view, plain studio background, soft even lighting, photorealistic.`;
    case 'environment': return `Reference photo of ${entity.name}${notes}${setting ? ` in ${setting}` : ''}. Wide view, no people, natural light, photorealistic.`;
    default: return `Product reference photo of ${entity.name}${notes}, ${colour}. Whole object in frame, three-quarter view, plain studio background, soft even lighting, photorealistic.`;
  }
}

// ---------- Object motion ----------
// An object's path is timed waypoints on the scene timeline: [{ t: seconds, p: [x,y,z], r?: yawDegrees }].
// Without r, objects face their direction of travel. Each shot shows the slice [start, start + duration].
export const MAX_SCENE_TIME = 120;
// Pitch/roll in degrees, unwrapped (720 = two full turns) so keyed spins interpolate the long way.
const tiltOf = v => (Number.isFinite(Number(v)) ? Math.max(-3600, Math.min(3600, Number(v))) : 0);
export function clampStart(value) { const n = Number(value); return Number.isFinite(n) ? Math.round(Math.max(0, Math.min(MAX_SCENE_TIME, n)) * 100) / 100 : 0; }
export function normalizePath(path) {
  if (!Array.isArray(path) || !path.length) return null;
  const ok = path.filter(k => k && Number.isFinite(k.t) && Array.isArray(k.p) && k.p.length === 3 && k.p.every(Number.isFinite)).slice(0, 64)
    .map(k => ({ t: Math.round(Math.max(0, Math.min(MAX_SCENE_TIME, k.t)) * 100) / 100, p: k.p.map(v => Math.max(-500, Math.min(500, v))), ...(Number.isFinite(k.r) ? { r: ((k.r % 360) + 360) % 360 } : {}), ...(Array.isArray(k.s) && k.s.length === 3 && k.s.every(Number.isFinite) ? { s: k.s.map(v => Math.max(0.05, Math.min(50, v))) } : {}), ...(Number.isFinite(k.pitch) ? { pitch: tiltOf(k.pitch) } : {}), ...(Number.isFinite(k.roll) ? { roll: tiltOf(k.roll) } : {}), ...(normalizePose(k.pose) ? { pose: normalizePose(k.pose) } : {}), ...(['linear', 'smoothstep'].includes(k.ease) ? { ease: k.ease } : {}) }))
    .sort((a, b) => a.t - b.t);
  const dedup = ok.filter((k, i) => i === 0 || k.t !== ok[i - 1].t);
  return dedup.length ? dedup : null;
}
/** Insert or replace the key at time t. */
export function upsertKey(path, t, p, r, s, tilt = {}) {
  const old = (path || []).find(k => Math.abs(k.t - t) <= 0.005) || {};
  const keys = (path || []).filter(k => Math.abs(k.t - t) > 0.005);
  const pitch = Number.isFinite(tilt.pitch) ? tilt.pitch : old.pitch, roll = Number.isFinite(tilt.roll) ? tilt.roll : old.roll;
  keys.push({ t: Math.round(t * 100) / 100, p: p.map(v => Math.round(v * 1000) / 1000), ...(Number.isFinite(r) ? { r: Math.round(r * 100) / 100 } : {}), ...(Array.isArray(s) ? { s: s.map(v => Math.round(v * 1000) / 1000) } : {}), ...(Number.isFinite(pitch) ? { pitch } : {}), ...(Number.isFinite(roll) ? { roll } : {}), ...(tilt.pose !== undefined || old.pose !== undefined ? { pose: tilt.pose ?? old.pose } : {}), ...(tilt.ease || old.ease ? { ease: tilt.ease || old.ease } : {}) });
  return normalizePath(keys);
}
export function removeKeys(path, times) { return normalizePath((path || []).filter(k => !times.some(t => Math.abs(k.t - t) <= 0.005))); }
/**
 * Set keyframes from partial input. Each key may give position, rotation (yaw degrees) and/or scale;
 * missing position is filled from the current animated pose at that time. mode 'replace' starts over.
 */
export function setKeyframes(entity, keys, mode = 'merge') {
  let path = mode === 'replace' ? null : entity.path;
  for (const k of keys || []) {
    if (!Number.isFinite(k?.t)) continue;
    const now = entityAt({ ...entity, path }, k.t);
    path = upsertKey(path, k.t, Array.isArray(k.position) ? k.position : now.position, Number.isFinite(k.rotation) ? k.rotation : undefined, Array.isArray(k.scale) ? k.scale : undefined, { pitch: k.pitch, roll: k.roll, pose: k.pose, ease: k.ease });
  }
  return path;
}
const cr = (p0, p1, p2, p3, u) => { const u2 = u * u, u3 = u2 * u; return 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3); };
function pathPoint(path, t) {
  if (t <= path[0].t) return path[0].p;
  const last = path.at(-1); if (t >= last.t) return last.p;
  let i = 1; while (path[i].t < t) i++;
  const a = path[i - 1], b = path[i], u = (t - a.t) / (b.t - a.t);
  if (a.ease) return a.p.map((v, k) => v + (b.p[k] - v) * keyEase(a, u));
  const p0 = (path[i - 2] || a).p, p3 = (path[i + 1] || b).p;
  return a.p.map((_, k) => cr(p0[k], a.p[k], b.p[k], p3[k], u));
}
const angLerp = (a, b, u) => { const d = ((b - a + 540) % 360) - 180; return (a + d * u + 360) % 360; };
/** Position and facing of an object at scene time t. */
export function entityAt(entity, t) {
  const path = entity.path;
  if (!path?.length) return { position: entity.position, rotation: entity.rotation, scale: entity.scale, pitch: entity.pitch || 0, roll: entity.roll || 0, ...(entity.pose ? { pose: entity.pose } : {}) };
  const position = pathPoint(path, t);
  let rotation = entity.rotation, scale = entity.scale;
  // Rotation keys (if any) drive facing; otherwise the object faces its direction of travel.
  const rk = path.filter(k => Number.isFinite(k.r));
  const sk = path.filter(k => Array.isArray(k.s));
  const seg = (keys, fn) => {
    if (t <= keys[0].t) return fn(keys[0], keys[0], 0);
    if (t >= keys.at(-1).t) return fn(keys.at(-1), keys.at(-1), 0);
    let i = 1; while (keys[i].t < t) i++;
    return fn(keys[i - 1], keys[i], keyEase(keys[i - 1], (t - keys[i - 1].t) / (keys[i].t - keys[i - 1].t)));
  };
  if (sk.length) scale = seg(sk, (a, b, u) => a.s.map((v, i) => v + (b.s[i] - v) * u));
  const pk = path.filter(k => Number.isFinite(k.pitch)), qk = path.filter(k => Number.isFinite(k.roll));
  const pitch = pk.length ? seg(pk, (a, b, u) => a.pitch + (b.pitch - a.pitch) * u) : entity.pitch || 0;
  const roll = qk.length ? seg(qk, (a, b, u) => a.roll + (b.roll - a.roll) * u) : entity.roll || 0;
  if (rk.length) rotation = seg(rk, (a, b, u) => angLerp(a.r, b.r, u));
  else if (path.length > 1) {
    const dt = 0.05, t0 = Math.max(path[0].t, Math.min(path.at(-1).t - dt, t - dt / 2));
    const p0 = pathPoint(path, t0), p1 = pathPoint(path, t0 + dt), dx = p1[0] - p0[0], dz = p1[2] - p0[2];
    if (Math.hypot(dx, dz) > 1e-4) rotation = ((Math.atan2(dx, dz) * 180) / Math.PI + 360) % 360;
  }
  const poses = path.filter(k => k.pose);
  const pose = poses.length ? seg(poses, (a, b, u) => blendPose(a.pose, b.pose, u)) : entity.pose;
  return { position, rotation, scale, pitch, roll, ...(pose ? { pose } : {}) };
}
export function entitiesAt(entities, t) { return entities.map(e => (e.path?.length ? { ...e, ...entityAt(e, t) } : e)); }
export function sceneLength(project) {
  return Math.max(0, ...project.scene.entities.flatMap(e => (e.path || []).map(k => k.t)), ...project.shots.map(s => (s.start || 0) + s.duration));
}
/** Shot camera at shot time t. Preset moves aimed at a moving object ride along with it. */
export function shotCameraAt(shot, entities, t) {
  const start = shot.start || 0, atStart = entitiesAt(entities, start);
  const pose = cameraAt(cameraKeys(shot, atStart), shot.duration, t, shot.camera.move === 'custom' ? shot.camera.timing : undefined);
  const target = entities.find(e => e.id === shot.camera.target);
  if (!target?.path?.length || shot.camera.move === 'custom') return pose;
  const a = entityAt(target, start).position, b = entityAt(target, start + t).position, d = b.map((v, i) => v - a[i]);
  return { p: pose.p.map((v, i) => v + d[i]), look: pose.look.map((v, i) => v + d[i]), mm: pose.mm };
}
