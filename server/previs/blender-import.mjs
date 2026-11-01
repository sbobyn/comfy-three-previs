// Copyright (c) 2026 Steven Bobyn. SPDX-License-Identifier: MIT
// Blender → Previs, the thin import (docs/blender-import.md). Reads the folder (or a zip of it) that
// scripts/blender/previs_export.py writes: blender-previs.json plus frames/frame-000000.png… at 24 fps. The sidecar
// becomes ordinary Director edit ops (proxies sized from Blender's bounds, a custom camera from Blender's camera) and
// the PNGs go through the browser capture pipeline, so the shot's blockout clip is Blender's render and every video
// model, the batch, Cut and staleness work unchanged. Nothing in the export is executed; .blend files are never read.
import { lstat, readdir, realpath, rm, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { MESH_LIMITS, MESH_PATH, validateMesh } from './mesh.mjs';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SHAPES, KINDS, handleOf, clampDuration, focusPoint, normalizeCamera, shotSignature } from '../../shared/director.mjs';
import { shotProjector } from '../../shared/still-match.mjs';
import { shotPrompt } from '../../shared/prompt.mjs';
import { browserVideoPlan } from '../../shared/browser-delivery.mjs';
import { validateBrowser, addBrowserShot } from './store.mjs';
import { createFrameStage, writeFrame, encodeFrames, saveVideoAsset, releaseFrameStage, VIDEO_LIMITS } from './video.mjs';
import { readZip } from './zip.mjs';
import { bundledMesh, fixCoplanar, sceneAfterOps, meshLoader } from './coplanar.mjs';
import { parseGlb } from '../../shared/blockout-lint.mjs';

export const HANDOFF_FORMAT = 'comfy-previs-blender-handoff';
export const SIDECAR = 'blender-previs.json';
export const frameName = i => `frames/frame-${String(i).padStart(6, '0')}.png`;
const SIZES = ['1280x720', '640x360']; // the deliveries Previs plays (shared/browser-delivery.mjs)
const FITS = ['AUTO', 'HORIZONTAL', 'VERTICAL'];
const MAX_OBJECTS = 198; // one edit op each, plus the shot's ops, within one 200-op edit
const MAX_SIDECAR = 8 * 1024 * 1024;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function fail(message, status = 400) { const e = Error(message); e.status = status; throw e; }

// ---------- Geometry ----------
/** Blender Z-up → three.js Y-up: (x, y, z) → (x, z, −y). A proper rotation, so a yaw about Blender +Z is the same yaw about three +Y. */
export const three = v => [v[0], v[2], -v[1]];
const sub = (a, b) => a.map((v, i) => v - b[i]), add = (a, b) => a.map((v, i) => v + b[i]), mul = (a, k) => a.map(v => v * k);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = a => { const l = Math.hypot(...a) || 1; return a.map(v => v / l); };
const round = (v, k = 1000) => Math.round(v * k) / k;
const r3 = v => v.map(x => round(x));
const wrap = d => ((d % 360) + 360) % 360;
/** Indices of at most 64 samples of n frames: every ceil(n/64)-th plus the last. */
const samples = n => { const step = Math.ceil(n / 64), out = []; for (let i = 0; i < n; i += step) out.push(i); if (out.at(-1) !== n - 1) out.push(n - 1); return out; };

/**
 * Blender lens → Previs mm. Previs (three.js setFocalLength) fits a 35 mm gauge to the frame width of a landscape
 * frame; Blender fits sensorWidth to the width under AUTO/HORIZONTAL and sensorHeight to the height under VERTICAL.
 */
export function lensMm(lens, camera, aspect = 16 / 9) {
  return camera.sensorFit === 'VERTICAL' ? (lens * (35 / aspect)) / camera.sensorHeight : (lens * 35) / camera.sensorWidth;
}
/** Degrees the camera's up leans from the level (world-up) camera Previs uses. */
export function rollOf(fwd, up) {
  const f = unit(fwd), right = cross(f, [0, 1, 0]);
  if (Math.hypot(...right) < 1e-6) return 0;
  const r = unit(right), level = cross(r, f);
  return (Math.atan2(dot(unit(up), r), dot(unit(up), level)) * 180) / Math.PI;
}
/** Unit quaternion [x, y, z, w] of the rotation whose columns are x, y, z. */
function quaternion([m00, m10, m20], [m01, m11, m21], [m02, m12, m22]) {
  const tr = m00 + m11 + m22; let q;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4]; }
  else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]; }
  else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s]; }
  else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s]; }
  return unit(q);
}
/** A three.js camera's orientation (looks down −Z, +Y up) from a view direction and up vector, roll included. */
export function cameraQuaternion(fwd, up) {
  const f = unit(fwd), right = unit(cross(f, unit(up))), u = cross(right, f);
  return quaternion(right, u, mul(f, -1));
}

// ---------- Validation ----------
function checkPng(bytes, width, height, i) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 33 || bytes.length > VIDEO_LIMITS.maxFrameBytes || !bytes.subarray(0, 8).equals(PNG) || bytes.toString('ascii', 12, 16) !== 'IHDR') fail(`${frameName(i)} is not a PNG under 8 MB`);
  const w = bytes.readUInt32BE(16), h = bytes.readUInt32BE(20);
  if (w !== width || h !== height) fail(`${frameName(i)} is ${w}×${h}; the export says ${width}×${height}`);
}
const vec = v => Array.isArray(v) && v.length === 3 && v.every(x => Number.isFinite(x) && Math.abs(x) < 100000);
const nameOf = o => (typeof o?.name === 'string' ? o.name.trim().slice(0, 60) : '');

/** Throws the user-facing reason an export cannot be imported. `frames` (Map index → PNG bytes) is checked when given. */
export function validateHandoff(m, frames = null, meshes = null) {
  if (!m || typeof m !== 'object' || m.format !== HANDOFF_FORMAT) fail(`Not a Blender export for Previs: ${SIDECAR} needs format "${HANDOFF_FORMAT}" (write it with scripts/blender/previs_export.py)`);
  if (m.version !== 1) fail(`Unsupported Blender export version ${m.version}; this Previs reads version 1`);
  if (m.fps !== 24) fail(`The export is ${m.fps} fps; set the scene to 24 fps (the helper does this with --fps24)`);
  const n = m.frameCount;
  if (!Number.isInteger(n) || n < 12 || n > 120) fail(`${n} frames; Previs shots are 12–120 frames (0.5–5 s at 24 fps)`);
  if (Number.isInteger(m.source?.frameStart) && Number.isInteger(m.source?.frameEnd) && m.source.frameEnd - m.source.frameStart + 1 !== n) fail('frameCount must equal frameEnd − frameStart + 1');
  if (!SIZES.includes(`${m.width}x${m.height}`)) fail(`Frames are ${m.width}×${m.height}; Previs plays 1280×720 or 640×360 (the helper's --size)`);
  if (m.axes !== 'blender-z-up') fail('axes must be "blender-z-up"');
  const c = m.camera, pos = v => Number.isFinite(v) && v > 0;
  if (!c || !pos(c.sensorWidth) || !pos(c.sensorHeight) || !FITS.includes(c.sensorFit)) fail('camera needs sensorWidth, sensorHeight and sensorFit (AUTO, HORIZONTAL or VERTICAL)');
  if (!Array.isArray(c.keys) || c.keys.length !== n || !c.keys.every(k => vec(k?.p) && vec(k.fwd) && vec(k.up) && Math.hypot(...k.fwd) > 0.5 && Math.hypot(...k.up) > 0.5 && pos(k.lens))) fail(`camera.keys needs one {p, fwd, up, lens} per frame (${n})`);
  if (c.checks !== undefined && (!Array.isArray(c.checks) || c.checks.length > 30 || !c.checks.every(x => Number.isInteger(x?.frame) && vec(x.point) && Array.isArray(x.px) && x.px.length === 2 && x.px.every(Number.isFinite)))) fail('camera.checks must be at most 30 {frame, point, px}');
  if (!Array.isArray(m.objects) || m.objects.length > MAX_OBJECTS) fail(`objects must be a list of at most ${MAX_OBJECTS}`);
  const seen = new Map();
  for (const o of m.objects) {
    const name = nameOf(o); if (!name) fail('Every object needs a name');
    const h = handleOf(name);
    if (seen.has(h)) fail(`Two Blender objects both become “${name}” in Previs (${seen.get(h)} and ${o.blenderName || name}); rename one or set previs_name`);
    seen.set(h, o.blenderName || name);
    if (o.mesh !== undefined && (typeof o.mesh !== 'string' || !MESH_PATH.test(o.mesh))) fail(`${name}: invalid mesh path`);
    if (!Array.isArray(o.frames) || !o.frames.length || !o.frames.every(f => vec(f?.position) && Number.isFinite(f.yaw) && vec(f.size) && f.size.every(s => s >= 0))) fail(`${name}: frames must be a list of {position, yaw, size}`);
    if (o.frames.length !== 1 && o.frames.length !== n) fail(`${name}: give one frame record (static) or one per frame (${n})`);
  }
  if (m.warnings !== undefined && !Array.isArray(m.warnings)) fail('warnings must be a list');
  if (frames) {
    for (let i = 0; i < n; i++) { if (!frames.has(i)) fail(`${frameName(i)} is missing`); checkPng(frames.get(i), m.width, m.height, i); }
    if (frames.size !== n) fail(`The export has ${frames.size} frames; its sidecar says ${n}`);
  }
  if (meshes) {
    const wanted = new Set(m.objects.map(o => o.mesh).filter(Boolean));
    let bytes = 0, triangles = 0;
    for (const path of wanted) {
      if (!meshes.has(path)) fail(`${path} is missing`);
      const info = validateMesh(meshes.get(path)); bytes += info.bytes; triangles += info.triangles * m.objects.filter(o => o.mesh === path).length;
    }
    if (meshes.size !== wanted.size || [...meshes.keys()].some(p => !wanted.has(p))) fail('Undeclared mesh in Blender export');
    if (bytes > MESH_LIMITS.totalBytes || triangles > MESH_LIMITS.totalTriangles) fail('Meshes exceed 32 MB or 100000 triangles total');
  }
  return m;
}

// ---------- Mapping (pure) ----------
/** Where Previs puts each Blender landmark (camera.checks) through the imported camera, against Blender's pixel. */
export function projectionChecks(m, keys, duration) {
  const shot = { start: 0, duration, camera: normalizeCamera({ move: 'custom', timing: 'linear', keys }) };
  const first = m.source?.frameStart ?? m.camera.keys[0].frame ?? 0;
  return (m.camera.checks || []).map(c => {
    const q = shotProjector(shot, [], (c.frame - first) / 24, m.width / m.height).project(three(c.point));
    const px = [q.x * m.width, q.y * m.height];
    return { frame: c.frame, blender: c.px, previs: px.map(v => round(v, 100)), error: round(Math.hypot(px[0] - c.px[0], px[1] - c.px[1]) / m.width, 100000) };
  });
}

/**
 * The Director edit that brings an export into `project`: one add_entity / update_entity per object (matched by name
 * handle, the key @mentions use; looks, notes and names are never touched) and an add_shot / update_shot with a
 * custom linear camera. Also the 24 fps camera motion for the engine record (roll kept), the landmark checks and the
 * mapping. Pure: ids for new objects and a new shot are made here.
 */
export function handoffToOps(project, m, { shotId = null, title = null, retitle = false, models = new Map(), meshOf = bundledMesh } = {}) {
  validateHandoff(m);
  const n = m.frameCount, warnings = (m.warnings || []).map(w => String(w).slice(0, 300)).slice(0, 20);
  const shot = shotId ? project.shots.find(s => s.id === shotId) : null;
  if (shotId && !shot) fail('Unknown shot');
  const start = shot?.start || 0, duration = clampDuration(n / 24);
  const entities = project.scene.entities, byHandle = new Map(entities.map(e => [handleOf(e.name), e]));
  const adds = m.objects.filter(o => !byHandle.has(handleOf(nameOf(o)))).length;
  if (entities.length + adds > 200) fail(`The scene would hold ${entities.length + adds} objects; Previs holds 200. Set previs_ignore on set dressing in Blender, or import into a new project`);
  const ops = [], mapping = [], placed = new Map(), clamped = [];
  for (const o of m.objects) {
    const name = nameOf(o), existing = byHandle.get(handleOf(name));
    const wanted = SHAPES[o.shape] && !['group', 'terrain'].includes(o.shape) ? o.shape : 'box';
    // An object that already has a look keeps its shape (its images were made for it); only its extents change.
    const shape = existing && (existing.look || existing.lookFrom || existing.shape === 'group') ? existing.shape : wanted;
    const base = SHAPES[shape].size;
    const recs = o.frames.map(f => ({ position: three(f.position), yaw: wrap(f.yaw), scale: f.size.map((s, i) => s / base[i]) }));
    if (recs.some(r => r.scale.some(v => v < 0.05 || v > 50))) clamped.push(name);
    const fit = s => s.map(v => round(Math.max(0.05, Math.min(50, v)), 1e6)); // proxy extents = Blender bounds to the micrometre
    const first = recs[0];
    let path = null;
    if (recs.length > 1) {
      const resized = recs.some(r => r.scale.some((v, i) => Math.abs(v - first.scale[i]) > 0.15 * first.scale[i]));
      path = samples(n).map(i => ({ t: round(start + i / 24, 10000), p: r3(recs[i].position), r: round(recs[i].yaw, 100), ...(resized ? { s: fit(recs[i].scale) } : {}) }));
    }
    const fields = { model: o.mesh ? models.get(o.mesh) || null : null, pitch: 0, roll: 0, position: r3(first.position), rotation: round(first.yaw, 100), scale: fit(first.scale), path };
    let id;
    if (existing) {
      id = existing.id;
      ops.push({ op: 'update_entity', id, patch: { ...fields, ...(shape !== existing.shape ? { shape } : {}) } });
      mapping.push({ blenderName: o.blenderName || name, name: existing.name, entityId: id, action: 'updated' });
    } else {
      id = randomUUID();
      const own = KINDS.includes(o.kind) ? o.kind : SHAPES[shape].kind;
      const kind = !o.cast ? 'environment' : own === 'environment' ? 'prop' : own;
      ops.push({ op: 'add_entity', entity: { id, name, shape, kind, ...(/^#[0-9a-f]{6}$/i.test(o.color || '') ? { color: o.color } : {}), ...fields } });
      mapping.push({ blenderName: o.blenderName || name, name, entityId: id, action: 'added' });
    }
    placed.set(id, { shape, cast: !!o.cast, recs: recs.map(r => ({ ...r, scale: fit(r.scale) })) });
  }
  // Objects on one plane z-fight in the viewport and every Previs capture: lift thin, static imported objects 2 mm
  // off the surface they share (the Blender clip is unaffected), and report what could not be lifted.
  const coplanar = fixCoplanar(sceneAfterOps(entities, ops), { meshOf, movable: new Set(ops.map(o => o.entity?.id || o.id)) });
  for (const op of ops) {
    const to = coplanar.moves.get(op.entity?.id || op.id);
    if (to) { if (op.entity) op.entity.position = to; else op.patch.position = to; }
  }
  warnings.push(...coplanar.fixed, ...coplanar.warnings);
  if (clamped.length) warnings.push(`Sizes outside what a proxy shows (0.05–50× its shape) were clamped: ${clamped.slice(0, 6).join(', ')}${clamped.length > 6 ? '…' : ''}`);

  // The subject: the shot's target when it is still in the scene, else the cast object filling most of the first frame.
  const keys0 = m.camera.keys, mmAt = k => lensMm(k.lens, m.camera, m.width / m.height);
  const focusOf = (id, i) => {
    const p = placed.get(id); if (p) { const r = p.recs[Math.min(i, p.recs.length - 1)]; return focusPoint({ shape: p.shape, position: r.position, scale: r.scale }); }
    const e = entities.find(x => x.id === id); return e ? focusPoint(e) : null;
  };
  let target = shot?.camera.target && entities.some(e => e.id === shot.camera.target) ? shot.camera.target : null;
  if (!target) {
    const p0 = three(keys0[0].p), f0 = unit(three(keys0[0].fwd)), tanV = 35 / (m.width / m.height) / 2 / mmAt(keys0[0]);
    let best = 0;
    for (const [id, x] of placed) {
      if (!x.cast) continue;
      const r = x.recs[0], size = SHAPES[x.shape].size.map((v, i) => v * r.scale[i]), z = dot(sub(focusOf(id, 0), p0), f0);
      const cover = z > 0.1 ? Math.hypot(...size) / 2 / (z * tanV) : 0;
      if (cover > best) { best = cover; target = id; }
    }
  }
  const lens = keys0.map(mmAt);
  if (lens.some(v => v < 8 || v > 300)) warnings.push(`The lens maps to ${Math.round(Math.min(...lens))}–${Math.round(Math.max(...lens))} mm; Previs camera keys hold 8–300 mm, so camera words and boxes use the clamped lens`);
  const keys = samples(n).map(i => {
    const k = keys0[i], p = three(k.p), f = unit(three(k.fwd)), fp = target ? focusOf(target, i) : null;
    let d = fp ? dot(sub(fp, p), f) : 10; if (!(d > 0.5)) d = 10;
    return { t: Math.min(1, round(i / 24 / duration, 1e6)), p: r3(p), look: r3(add(p, mul(f, d))), mm: round(Math.max(8, Math.min(300, lens[i]))) };
  });
  const roll = Math.max(...keys0.map(k => Math.abs(rollOf(three(k.fwd), three(k.up)))));
  if (roll > 2 && !warnings.some(w => /roll/i.test(w))) warnings.push(`The camera rolls up to ${roll.toFixed(1)}°; the clip keeps it, Previs camera words and boxes assume a level camera`);
  const camera = { move: 'custom', timing: 'linear', keys, target, mm: keys[0].mm }; // mm: the lens the prompt and camera words name
  const newShotId = shot ? shot.id : randomUUID();
  const named = String(title || m.source?.camera || 'Blender shot').slice(0, 120);
  ops.push(shot ? { op: 'update_shot', id: shot.id, patch: { duration, camera, ...(retitle ? { title: named } : {}) } }
    : { op: 'add_shot', shot: { id: newShotId, title: named, description: '', duration, start: 0, camera } });
  const motion = keys0.map((k, i) => ({ t: i / 24, p: three(k.p), q: cameraQuaternion(three(k.fwd), three(k.up)), mm: Math.max(1, round(lens[i])) }));
  const subject = target ? focusOf(target, 0) : add(three(keys0[0].p), mul(unit(three(keys0[0].fwd)), 10));
  const checks = projectionChecks(m, keys, duration);
  const off = checks.filter(c => c.error > 0.01);
  if (off.length) warnings.push(`${off.length} of ${checks.length} Blender landmarks land more than 1% of the frame width away in Previs (worst ${(Math.max(...off.map(c => c.error)) * 100).toFixed(1)}%); camera words and overlay boxes may not match the clip`);
  return { ops, shotId: newShotId, duration, motion, subject: r3(subject), mapping, warnings, checks };
}

// ---------- Reading an export ----------
function parseSidecar(bytes) {
  try { return JSON.parse(bytes.toString('utf8')); } catch { fail(`${SIDECAR} is not valid JSON`); }
}
/** An export folder by absolute path. Reads the sidecar, PNGs and declared meshes; symlinks are refused. */
export async function readHandoffDir(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail('path must be the absolute path of the export folder');
  let real; try { real = await realpath(path); } catch { fail(`No export folder at ${path}`); }
  if (real !== path) fail(`Use the folder's real path, without symlinks: ${real}`);
  const read = async (rel, max) => {
    let fh;
    try { fh = await open(join(real, rel), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (e) { if (e.code === 'ENOENT') return null; fail(`${rel} must be a regular file (not a link)`); }
    try {
      const st = await fh.stat();
      if (!st.isFile() || st.size > max) fail(`${rel} must be a regular file (not a link) under ${Math.round(max / 1048576)} MB`);
      const bytes = Buffer.alloc(st.size + 1); let n = 0;
      while (n < bytes.length) { const r = await fh.read(bytes, n, bytes.length - n, null); if (!r.bytesRead) break; n += r.bytesRead; }
      if (n > st.size) fail(`${rel} changed while reading`);
      return bytes.subarray(0, n);
    } finally { await fh.close(); }
  };
  const json = await read(SIDECAR, MAX_SIDECAR); if (!json) fail(`No ${SIDECAR} in ${real}; export the shot with scripts/blender/previs_export.py`);
  const manifest = parseSidecar(json);
  const dir = await lstat(join(real, 'frames')).catch(() => null);
  if (!dir?.isDirectory()) fail(`No frames/ folder in ${real}`);
  const names = (await readdir(join(real, 'frames'))).filter(x => /^frame-\d{6}\.png$/.test(x)).sort();
  if (names.length > VIDEO_LIMITS.maxFrames) fail(`frames/ holds ${names.length} frames; Previs shots are at most 120`);
  const frames = new Map();
  for (const name of names) frames.set(Number(name.slice(6, 12)), await read(`frames/${name}`, VIDEO_LIMITS.maxFrameBytes));
  validateHandoff(manifest);
  const meshes = new Map(), paths = new Set(manifest.objects.map(o => o.mesh).filter(Boolean));
  if (paths.size) {
    if (!(await lstat(join(real, 'meshes')).catch(() => null))?.isDirectory()) fail('meshes/ must be a directory, not a link');
    let total = 0;
    for (const path of paths) { const bytes = await read(path, MESH_LIMITS.bytes); total += bytes?.length || 0; if (total > MESH_LIMITS.totalBytes) fail('Meshes exceed 32 MB total'); meshes.set(path, bytes); }
  }
  validateHandoff(manifest, frames, meshes);
  return { manifest, frames, meshes, from: real };
}
/** The same folder zipped (the browser drop). Finder's __MACOSX and .DS_Store entries are ignored; anything else is refused. */
export function readHandoffZip(buffer) {
  const files = readZip(buffer, { maxEntries: 600, maxTotal: VIDEO_LIMITS.maxFrames * VIDEO_LIMITS.maxFrameBytes + MAX_SIDECAR + MESH_LIMITS.totalBytes });
  const junk = name => name.startsWith('__MACOSX/') || name.split('/').pop() === '.DS_Store';
  const sidecars = [...files.keys()].filter(x => !junk(x) && x.split('/').pop() === SIDECAR);
  if (sidecars.length !== 1) fail(sidecars.length ? `The zip holds ${sidecars.length} exports; import one shot at a time` : `No ${SIDECAR} in the zip; zip the folder previs_export.py wrote`);
  const prefix = sidecars[0].slice(0, -SIDECAR.length);
  if (prefix.split('/').length > 2) fail(`Put ${SIDECAR} at the top of the zip or in one folder`);
  const frames = new Map(), meshes = new Map();
  for (const [name, data] of files) {
    if (junk(name) || name === sidecars[0]) continue;
    const hit = name.startsWith(prefix) && /^frames\/frame-(\d{6})\.png$/.exec(name.slice(prefix.length));
    if (name.startsWith(prefix) && MESH_PATH.test(name.slice(prefix.length))) { meshes.set(name.slice(prefix.length), data); continue; }
    if (!hit) fail(`Unexpected file in the Blender export: ${name}`);
    frames.set(Number(hit[1]), data);
  }
  const manifest = parseSidecar(files.get(sidecars[0]));
  validateHandoff(manifest, frames, meshes);
  return { manifest, frames, meshes, from: 'zip' };
}

// ---------- Import ----------
/**
 * Bring one export into a project shot: validate everything first (no partial edit on a bad export), apply the edit,
 * register the engine shot exactly as a browser capture does, encode the PNGs to the blockout MP4 and record it as
 * the shot's render with origin 'blender'. No projectId makes a new project; no shotId adds a shot.
 */
export function openBlenderImport({ data, director, previs }) {
  async function importHandoff({ projectId = null, shotId = null, title = null, handoff }) {
    const { manifest: m, frames, meshes = new Map() } = handoff;
    validateHandoff(m, frames, meshes);
    let project = projectId ? await director.get(projectId) : null;
    const shot = shotId ? project?.shots.find(s => s.id === shotId) || project?.shots.find(s => handleOf(s.title) === handleOf(shotId)) || (/^\d+$/.test(String(shotId)) ? project?.shots[Number(shotId) - 1] : null) : null;
    if (shotId && !shot) fail(`Unknown shot ${shotId}`);
    if (!project) project = await director.create({ title: String(title || m.source?.file?.replace(/\.blend$/i, '') || 'Blender shot').slice(0, 120), template: 'empty' });
    // A new project's empty first shot takes the import; otherwise a new shot is added unless one was named.
    const into = shot || (!projectId && project.shots.length === 1 && !project.scene.entities.length ? project.shots[0] : null);
    const models = new Map([...meshes].map(([path]) => [path, `/director-refs/${project.id}/${randomUUID()}.glb`]));
    const parsed = new Map();
    for (const [path, bytes] of meshes) { try { parsed.set(models.get(path), parseGlb(bytes)); } catch {} }
    const meshOf = await meshLoader(project.scene.entities, { refFile: (id, file) => director.refFile(id, file), parsed });
    const plan = handoffToOps(project, m, { shotId: into?.id ?? null, title: m.source?.camera, retitle: !projectId, models, meshOf });
    // Encode first: an ffmpeg failure leaves the project unedited.
    const stage = await createFrameStage({ width: m.width, height: m.height, fps: 24, frameCount: m.frameCount });
    let edited, s, previsShotId, asset;
    try {
      for (let i = 0; i < m.frameCount; i++) await writeFrame({ directory: stage.directory, index: i, bytes: frames.get(i) });
      const { file, metadata } = await encodeFrames(stage);
      for (const [path, bytes] of meshes) await director.storeMesh(project.id, models.get(path).split('/').pop(), bytes);
      edited = (await director.edit(project.id, plan.ops)).project;
      s = edited.shots.find(x => x.id === plan.shotId);
      // The engine shot a browser capture would save (POST /api/browser-shot), so video-refs and video jobs accept this clip.
      const browser = validateBrowser({ subject: plan.subject, camera: plan.motion[0], frames: plan.motion, delivery: { width: m.width, height: m.height, fps: 24 },
        director: { projectId: edited.id, shotId: s.id, projectRevision: edited.revision, sceneName: edited.scene.name, shotTitle: s.title, camera: s.camera, entities: edited.scene.entities } });
      const image = await previs.image(frames.get(0));
      previsShotId = randomUUID();
      await previs.append(q => addBrowserShot(q, { id: previsShotId, title: `${edited.title} · Shot ${edited.shots.indexOf(s) + 1} · ${s.title} · Blender`, browser, image }));
      const engineShot = previs.get().shots.find(x => x.id === previsShotId);
      ({ asset } = await saveVideoAsset({ root: data, project: previs, revision: previs.get().revision, shotId: previsShotId, file, metadata, binding: engineShot.binding,
        provenance: { browserSnapshot: engineShot.browser, sceneVersion: engineShot.browser.sceneVersion, delivery: browserVideoPlan(engineShot.browser.frames, engineShot.browser.delivery), renderer: 'Blender render, imported', pass: 'beauty', blender: { exporter: m.exporter ?? null, source: m.source ?? null }, sampling: 'one output frame per Blender frame' } }));
    } finally {
      releaseFrameStage(stage.directory);
      await rm(stage.directory, { recursive: true, force: true }); // the PNGs stay in the user's export folder
    }
    const r = await director.recordRender(edited.id, { shotId: s.id, previsShotId, assetId: asset.id, prompt: shotPrompt(edited, s, 'video'), signature: shotSignature(edited, s), origin: 'blender' }, previs);
    return { project: r.project, projectId: edited.id, shotId: s.id, previsShotId, assetId: asset.id, frameCount: m.frameCount, duration: plan.duration, mapping: plan.mapping, warnings: plan.warnings, checks: plan.checks };
  }
  return {
    importHandoff,
    fromPath: async input => importHandoff({ projectId: input.projectId || null, shotId: input.shotId || null, title: input.title || null, handoff: await readHandoffDir(input.path) }),
    fromZip: async (buffer, input) => importHandoff({ projectId: input.projectId || null, shotId: input.shotId || null, title: input.title || null, handoff: readHandoffZip(buffer) }),
  };
}
