// Copyright (c) 2026 Steven Bobyn. SPDX-License-Identifier: MIT
// What an imported character does (docs/import.md#rigged-characters): its clip (name, offset, speed) by default or from a
// moment on, its pose (a library pose, joint angles, IK targets for hands and feet) and how video models see it.
// Planned as ordinary edit ops, so the workspace, undo and shot signatures treat it like any other edit.
import { entityAt, entitySize, handleOf } from '../../shared/director.mjs';
import { RIG_POSES, POSE_NAMES, IK_EFFECTORS, solveLimb } from '../../shared/rig.mjs';
import { normalizePose } from '../../shared/blockout-pose.mjs';

function fail(message, status = 400) { const e = Error(message); e.status = status; throw e; }
const findEntity = (p, ref) => p.scene.entities.find(e => e.id === ref) || p.scene.entities.find(e => handleOf(e.name) === handleOf(String(ref || '').replace(/^@/, '')));
const findShot = (p, ref) => p.shots.find(s => s.id === ref) || p.shots.find(s => handleOf(s.title) === handleOf(ref)) || (/^\d+$/.test(String(ref)) ? p.shots[Number(ref) - 1] : null);

/**
 * input: { object, shot?, at? (seconds into the shot, or scene seconds without shot), clip? (name | null), offset?, speed?,
 * loop?, inPlace?, pose? (library name | { joint: [x, y, z] }), ik? ({ handL|handR|footL|footR: [x, y, z] object metres }),
 * standIn? ('posed' | 'neutral') }. Returns { ops, summary }.
 */
export function planPerform(p, input = {}) {
  const e = findEntity(p, input.object) || fail(`Unknown object ${input.object}`);
  if (!e.source) fail(`${e.name} is not an imported model. Clips and rig poses work on imported models (previs_import_asset)`);
  const shot = input.shot !== undefined && input.shot !== null ? findShot(p, input.shot) || fail(`Unknown shot ${input.shot}`) : null;
  const keyed = !!shot || Number.isFinite(input.at);
  const t = Math.round(((shot?.start || 0) + (Number.isFinite(input.at) ? Number(input.at) : 0)) * 100) / 100;
  const patch = {}, summary = [], ops = [];
  // Clip
  if (input.clip !== undefined || input.offset !== undefined || input.speed !== undefined || input.loop !== undefined || input.inPlace !== undefined) {
    const clips = e.source.clips || [];
    if (input.clip !== undefined && input.clip !== null && !clips.some(c => c.name === input.clip)) fail(clips.length ? `${e.name} has no clip “${input.clip}”. Clips: ${clips.map(c => c.name).join(', ')}` : `${e.name} has no animation clips`);
    const perform = structuredClone(e.perform || { clip: null, offset: 0, speed: 1 });
    const fields = { ...(input.offset !== undefined ? { offset: Number(input.offset) } : {}), ...(input.speed !== undefined ? { speed: Number(input.speed) } : {}) };
    if (keyed) {
      const keys = (perform.keys || []).filter(k => Math.abs(k.t - t) > 0.005);
      const before = (perform.keys || []).filter(k => k.t < t).at(-1);
      keys.push({ t, clip: input.clip !== undefined ? input.clip : before ? before.clip : perform.clip, offset: 0, speed: 1, ...fields });
      perform.keys = keys;
      summary.push(`${input.clip === null ? 'stops its clip' : `plays ${keys.at(-1).clip ?? 'no clip'}`} from ${t} s${shot ? ` (${shot.title})` : ''}`);
    } else {
      if (input.clip !== undefined) perform.clip = input.clip;
      Object.assign(perform, fields);
      summary.push(perform.clip ? `plays ${perform.clip}${perform.speed !== 1 ? ` at ${perform.speed}×` : ''}${perform.offset ? ` from ${perform.offset} s in` : ''}` : 'plays no clip');
    }
    if (input.loop !== undefined) { if (input.loop === false) perform.loop = false; else delete perform.loop; }
    if (input.inPlace !== undefined) { if (input.inPlace === false) perform.inPlace = false; else delete perform.inPlace; }
    patch.perform = perform;
  }
  // Pose (library, angles, then IK on top)
  if (input.pose !== undefined || input.ik !== undefined) {
    const rig = e.source.rig;
    if (!rig) fail(`${e.name} has no humanoid rig, so it has no poses (clips still work)`);
    let pose;
    if (typeof input.pose === 'string') pose = structuredClone(RIG_POSES[input.pose] ?? fail(`Unknown pose ${input.pose}. Poses: ${POSE_NAMES.join(', ')}`));
    else if (input.pose && typeof input.pose === 'object') pose = { ...(entityAt(e, t).pose || {}), ...(normalizePose(input.pose) || fail('pose must be a pose name or { joint: [x, y, z] degrees }')) };
    else pose = structuredClone(entityAt(e, t).pose || RIG_POSES.stand);
    if (input.ik !== undefined) {
      if (!input.ik || typeof input.ik !== 'object') fail(`ik must be { ${IK_EFFECTORS.join('|')}: [x, y, z] }`);
      for (const [effector, target] of Object.entries(input.ik)) pose = solveLimb(rig, entitySize(e), pose, effector, target);
    }
    pose = normalizePose(pose) || {};
    if (keyed) { ops.push({ op: 'set_keyframes', id: e.id, keys: [{ t, pose }] }); summary.push(`pose keyed at ${t} s`); }
    else { patch.pose = pose; summary.push(typeof input.pose === 'string' ? `stands in the ${input.pose} pose` : 'pose set'); }
  }
  if (input.standIn !== undefined) {
    if (!['posed', 'neutral'].includes(input.standIn)) fail('standIn must be posed or neutral');
    patch.standIn = input.standIn === 'neutral' ? 'neutral' : null;
    summary.push(input.standIn === 'neutral' ? 'goes to image and video models as a neutral grey stand-in' : 'goes to image and video models as posed');
  }
  if (Object.keys(patch).length) ops.unshift({ op: 'update_entity', id: e.id, patch });
  if (!ops.length) fail('Nothing to change: give clip, offset, speed, pose, ik or standIn');
  return { ops, entityId: e.id, summary: `${e.name} ${summary.join('; ')}` };
}
