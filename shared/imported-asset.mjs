// Copyright (c) 2026 Steven Bobyn. SPDX-License-Identifier: MIT
// Imported 3D assets on an object (server/previs/asset-import.mjs, docs/import.md): where the file came from, its
// rights, its rig and clips (entity.source), what it plays (entity.perform) and how video models see it (standIn).
import { RIG_JOINTS } from './rig.mjs';

export const IMPORT_FORMATS = Object.freeze(['glb', 'gltf', 'fbx', 'obj', 'stl', 'ply', 'usdz', 'image']);
const text = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n) : '');
const vec3 = v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite) ? v.map(x => Math.round(Math.max(-10, Math.min(10, x)) * 1e5) / 1e5) : null;

function rigOf(r) {
  if (!r || typeof r !== 'object' || r.humanoid !== true || !r.joints || typeof r.joints !== 'object') return null;
  const joints = {}, parents = {}, rest = {};
  for (const j of RIG_JOINTS) {
    if (!Number.isInteger(r.joints[j]) || r.joints[j] < 0) continue;
    joints[j] = r.joints[j];
    parents[j] = RIG_JOINTS.includes(r.parents?.[j]) ? r.parents[j] : null;
    const p = vec3(r.rest?.[j]); if (p) rest[j] = p;
  }
  return Object.keys(joints).length >= 11 ? { humanoid: true, joints, parents, rest } : null;
}

/** entity.source: provenance, rights and rig of an imported mesh, or undefined. Never part of a shot signature. */
export function normalizeSource(s) {
  if (!s || typeof s !== 'object' || !IMPORT_FORMATS.includes(s.format)) return undefined;
  const clips = (Array.isArray(s.clips) ? s.clips : []).filter(c => c && typeof c.name === 'string' && c.name && Number.isFinite(c.duration)).slice(0, 64)
    .map(c => ({ name: text(c.name, 80), duration: Math.round(Math.max(0, Math.min(3600, c.duration)) * 1000) / 1000 }));
  const rig = rigOf(s.rig);
  return {
    file: text(s.file, 120) || `model.${s.format}`,
    format: s.format,
    ...(text(s.url, 500) ? { url: text(s.url, 500) } : {}),
    licence: text(s.licence, 200),
    attribution: text(s.attribution, 300),
    ...(Number.isInteger(s.triangles) && s.triangles >= 0 ? { triangles: s.triangles } : {}),
    ...(Number.isInteger(s.bytes) && s.bytes >= 0 ? { bytes: s.bytes } : {}),
    ...(text(s.units, 120) ? { units: text(s.units, 120) } : {}),
    ...(clips.length ? { clips } : {}),
    ...(s.skinned === true ? { skinned: true } : {}),
    ...(rig ? { rig } : {}),
  };
}

const num = (v, lo, hi, d) => (Number.isFinite(v) ? Math.round(Math.max(lo, Math.min(hi, v)) * 1000) / 1000 : d);
/**
 * entity.perform: the clip an imported object plays. { clip, offset, speed, loop, inPlace, keys: [{ t, clip, offset,
 * speed }] } in scene seconds; a key with clip null stops the clip (back to pose keys). Only clips in the file count.
 */
export function normalizePerform(p, source) {
  if (!p || typeof p !== 'object' || !source?.clips?.length) return undefined;
  const names = new Set(source.clips.map(c => c.name)), clipOf = c => (typeof c === 'string' && names.has(c) ? c : null);
  const keys = (Array.isArray(p.keys) ? p.keys : []).filter(k => k && Number.isFinite(k.t)).slice(0, 64)
    .map(k => ({ t: num(k.t, 0, 120, 0), clip: clipOf(k.clip), offset: num(k.offset, -3600, 3600, 0), speed: num(k.speed, -4, 4, 1) }))
    .sort((a, b) => a.t - b.t).filter((k, i, all) => i === all.length - 1 || all[i + 1].t - k.t > 0.005);
  const out = { clip: clipOf(p.clip), offset: num(p.offset, -3600, 3600, 0), speed: num(p.speed, -4, 4, 1), ...(p.loop === false ? { loop: false } : {}), ...(p.inPlace === false ? { inPlace: false } : {}), ...(keys.length ? { keys } : {}) };
  return out.clip || keys.length ? out : undefined;
}

/** 'neutral' sends the object to image and video models as a plain grey figure in the stand pose. */
export const normalizeStandIn = v => (v === 'neutral' ? 'neutral' : undefined);
