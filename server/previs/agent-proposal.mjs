// [agent] Proposals: the built-in agent's edits are collected here instead of being applied.
// planProposal pins ids so apply and undo are deterministic, validates every op on a copy of the
// project (so a bad op fails at proposal time, not at Apply), computes inverse ops for one-step undo,
// and writes a plain-language summary the proposal card shows. Pure: no I/O.
import { randomUUID } from 'node:crypto';
import { applyOps } from './director.mjs';
import { MOVES, handleOf } from '../../shared/director.mjs';
import { recreateOps } from '../../shared/editor-controls.mjs';

const uuid = /^[a-f0-9-]{36}$/;
const findEntity = (p, ref) => p.scene.entities.find(e => e.id === ref) || p.scene.entities.find(e => handleOf(e.name) === handleOf(String(ref ?? ''))) || null;
const findShot = (p, ref) => p.shots.find(s => s.id === ref) || p.shots.find(s => handleOf(s.title) === handleOf(String(ref ?? ''))) || (/^\d+$/.test(String(ref)) ? p.shots[Number(ref) - 1] : null) || null;
const shotNo = (p, s) => p.shots.indexOf(s) + 1;
const m = n => `${Math.round(Number(n) * 10) / 10} m`;
const fail = message => { const e = Error(message); e.status = 400; throw e; };

// Ops the proposal card can apply and undo. Everything else is refused at proposal time.
export const PROPOSAL_OPS = ['add_entity', 'update_entity', 'remove_entity', 'set_keyframes', 'remove_keyframes', 'clear_animation', 'add_shot', 'update_shot', 'remove_shot', 'reorder_shots', 'set_scene', 'set_project'];

/** Give new objects/shots a fixed id so the same op applies (and undoes) identically later. */
function pin(op, p) {
  const o = structuredClone(op);
  if (o.op === 'add_entity') { o.entity ||= {}; if (!uuid.test(o.entity.id || '') || p.scene.entities.some(e => e.id === o.entity.id)) o.entity.id = randomUUID(); }
  if (o.op === 'add_shot') { o.shot ||= {}; if (!uuid.test(o.shot.id || '') || p.shots.some(s => s.id === o.shot.id)) o.shot.id = randomUUID(); }
  return o;
}

const strip = e => { const { id, ...rest } = structuredClone(e); return rest; };

/** The op that reverses `op` given the project state just before it. */
function inverse(p, op) {
  switch (op.op) {
    case 'add_entity': return { op: 'remove_entity', id: op.entity.id };
    case 'update_entity': { const e = findEntity(p, op.id) || fail(`Unknown object ${op.id}`); return { op: 'update_entity', id: e.id, patch: strip(e) }; }
    case 'set_keyframes': case 'remove_keyframes': case 'clear_animation': { const e = findEntity(p, op.id) || fail(`Unknown object ${op.id}`); return { op: 'update_entity', id: e.id, patch: { path: structuredClone(e.path ?? null) } }; }
    case 'remove_entity': { const e = findEntity(p, op.id) || fail(`Unknown object ${op.id}`); return { op: 'batch', ops: recreateOps(e, p) }; }
    case 'add_shot': return { op: 'remove_shot', id: op.shot.id };
    case 'update_shot': {
      const s = findShot(p, op.id) || fail(`Unknown shot ${op.id}`); const patch = op.patch || {}, before = {};
      for (const k of ['title', 'description', 'duration', 'start']) if (patch[k] !== undefined) before[k] = s[k] ?? (k === 'start' ? 0 : '');
      if (patch.prompts !== undefined) before.prompts = { video: s.prompts?.video ?? null, image: s.prompts?.image ?? null };
      if (patch.style !== undefined) before.style = s.style ? structuredClone(s.style) : null;
      if (patch.cast !== undefined) before.cast = structuredClone(s.cast || { include: [], exclude: [] });
      if (patch.camera !== undefined) before.camera = structuredClone(s.camera);
      if (patch.motionCritical !== undefined) before.motionCritical = s.motionCritical === true;
      return { op: 'update_shot', id: s.id, patch: before };
    }
    case 'remove_shot': { const s = findShot(p, op.id) || fail(`Unknown shot ${op.id}`); return { op: 'add_shot', index: p.shots.indexOf(s), shot: structuredClone(s) }; }
    case 'reorder_shots': return { op: 'reorder_shots', ids: p.shots.map(s => s.id) };
    case 'set_scene': return { op: 'set_scene', patch: { name: p.scene.name, environment: structuredClone(p.scene.environment) } };
    case 'set_project': return { op: 'set_project', patch: { title: p.title } };
    default: fail(`The agent cannot propose “${op.op}” edits`);
  }
}

/** One plain-language line per op, for the proposal card and the activity log. */
function describe(p, op) {
  const name = ref => findEntity(p, ref)?.name || op.entity?.name || String(ref);
  const shotLabel = ref => { const s = findShot(p, ref); return s ? `Shot ${shotNo(p, s)} “${s.title}”` : `Shot ${ref}`; };
  switch (op.op) {
    case 'add_entity': { const e = op.entity || {}; const at = Array.isArray(e.position) ? ` at ${m(e.position[0])}, ${m(e.position[2])}` : ''; return { kind: 'add', text: `Add ${e.name || e.shape || 'an object'}${e.shape ? ` (${e.shape})` : ''}${at}` }; }
    case 'update_entity': {
      const n = name(op.id), patch = op.patch || {}, parts = [];
      if (patch.position) parts.push(`move to ${m(patch.position[0])}, ${m(patch.position[2])}`);
      if (patch.rotation !== undefined) parts.push(`face ${Math.round(patch.rotation)}°`);
      if (patch.scale) parts.push('resize');
      if (patch.color) parts.push(`recolour ${patch.color}`);
      if (patch.name) parts.push(`rename to ${patch.name}`);
      if (patch.notes !== undefined || patch.styleNotes !== undefined) parts.push('update the Cast Card');
      if (patch.lookFrom !== undefined) parts.push(patch.lookFrom ? `share ${name(patch.lookFrom)}’s look` : 'stop sharing a look');
      if (patch.shape || patch.kind) parts.push('change type');
      if (patch.path !== undefined) parts.push('change the animation');
      if (patch.pitch !== undefined || patch.roll !== undefined) parts.push('tilt');
      return { kind: 'change', text: `${n}: ${parts.join(', ') || 'update'}` };
    }
    case 'set_keyframes': { const ks = (op.keys || []).map(k => Number(k.t)).filter(Number.isFinite); const span = ks.length ? ` from ${Math.min(...ks)}s to ${Math.max(...ks)}s` : ''; return { kind: 'animate', text: `Animate ${name(op.id)}: ${ks.length} keyframe${ks.length === 1 ? '' : 's'}${span}` }; }
    case 'remove_keyframes': return { kind: 'animate', text: `Remove ${(op.times || []).length} keyframe${(op.times || []).length === 1 ? '' : 's'} on ${name(op.id)}` };
    case 'clear_animation': return { kind: 'animate', text: `Clear ${name(op.id)}’s animation` };
    case 'remove_entity': return { kind: 'remove', text: `Remove ${name(op.id)}` };
    case 'add_shot': { const s = op.shot || {}; const cam = s.camera ? ` — ${MOVES[s.camera.move] || s.camera.move || 'camera'}${s.camera.target ? ` on ${name(s.camera.target)}` : ''}${s.camera.mm ? `, ${s.camera.mm}mm` : ''}` : ''; return { kind: 'add', text: `Add shot “${s.title || 'Untitled'}”${cam}${s.duration ? `, ${s.duration}s` : ''}` }; }
    case 'update_shot': {
      const patch = op.patch || {}, parts = [];
      if (patch.camera) { const c = patch.camera; parts.push(`camera ${[c.move && (MOVES[c.move] || c.move), c.target !== undefined && (c.target ? `on ${name(c.target)}` : 'free'), c.mm && `${c.mm}mm`, c.distance !== undefined && `${m(c.distance)} away`, c.height !== undefined && `${m(c.height)} high`, c.angle !== undefined && `${Math.round(c.angle)}°`].filter(Boolean).join(', ') || 'changed'}`); }
      if (patch.title) parts.push(`rename to “${patch.title}”`);
      if (patch.description !== undefined) parts.push('rewrite the description');
      if (patch.duration !== undefined) parts.push(`${patch.duration}s long`);
      if (patch.start !== undefined) parts.push(`start at ${patch.start}s`);
      if (patch.prompts) parts.push(`set the ${Object.keys(patch.prompts).join(' and ')} prompt`);
      if (patch.style !== undefined) parts.push('camera style tags');
      if (patch.cast !== undefined) parts.push('cast');
      if (patch.motionCritical !== undefined) parts.push(patch.motionCritical === true ? 'mark motion/direction-critical' : 'clear motion/direction-critical');
      return { kind: patch.prompts ? 'prompt' : 'camera', text: `${shotLabel(op.id)}: ${parts.join(', ') || 'update'}` };
    }
    case 'remove_shot': return { kind: 'remove', text: `Remove ${shotLabel(op.id)}` };
    case 'reorder_shots': return { kind: 'change', text: 'Reorder the shots' };
    case 'set_scene': { const env = op.patch?.environment || {}; const parts = [op.patch?.name && `rename to “${op.patch.name}”`, env.preset && `${env.preset} preset`, env.description !== undefined && 'world description', env.style !== undefined && 'visual style'].filter(Boolean); return { kind: 'scene', text: `Scene: ${parts.join(', ') || 'update'}` }; }
    case 'set_project': return { kind: 'scene', text: `Rename the project to “${op.patch?.title}”` };
    default: return { kind: 'change', text: op.op };
  }
}

/**
 * Plan a proposal from the base project and the full list of proposed ops (already-pending ones first).
 * Returns pinned ops, undo ops (reverse order), summary lines, the preview project and `small`
 * (one update to one existing object/shot: the UI may apply it straight away with an Undo chip).
 */
export function planProposal(base, ops) {
  if (!Array.isArray(ops) || !ops.length) fail('Propose at least one edit');
  if (ops.length > 60) fail('A proposal holds at most 60 edits');
  const p = structuredClone(base);
  const pinned = [], undo = [], summary = [];
  for (const raw of ops) {
    if (!PROPOSAL_OPS.includes(raw?.op)) fail(`The agent cannot propose “${raw?.op}” edits`);
    const op = pin(raw, p);
    const inv = inverse(p, op);
    summary.push(describe(p, op));
    applyOps(p, [op]); // throws with the server's own validation message
    pinned.push(op); undo.unshift(inv);
  }
  // Flatten batches (recreating a removed object is several ops).
  const flatUndo = undo.flatMap(u => (u.op === 'batch' ? u.ops : [u]));
  const small = pinned.length === 1 && ['update_entity', 'update_shot', 'set_keyframes'].includes(pinned[0].op);
  return { ops: pinned, undo: flatUndo, summary, preview: p, small };
}

/** Compact, agent-friendly view of a project (optionally with pending proposal ops applied). */
export function sceneView(p, currentShotId = null, pending = []) {
  const name = id => p.scene.entities.find(e => e.id === id)?.name ?? null;
  return {
    project: { id: p.id, title: p.title, revision: p.revision },
    world: { preset: p.scene.environment?.preset, description: p.scene.environment?.description || '', style: p.scene.environment?.style || '' },
    objects: p.scene.entities.map(e => ({ id: e.id, name: e.name, kind: e.kind, shape: e.shape, position: e.position, rotation: e.rotation, scale: e.scale, color: e.color, castCard: { description: e.notes || '', styleNotes: e.styleNotes || '' }, lookFrom: e.lookFrom ? name(e.lookFrom) : null, hasLook: !!e.look, keyframes: e.path?.length || 0 })),
    shots: p.shots.map((s, i) => ({ number: i + 1, id: s.id, title: s.title, description: s.description, duration: s.duration, start: s.start || 0, camera: { ...s.camera, target: s.camera.target ? name(s.camera.target) : null, keys: s.camera.keys ? s.camera.keys.length : undefined }, cast: { include: (s.cast?.include || []).map(name), exclude: (s.cast?.exclude || []).map(name) }, promptEdited: { video: !!s.prompts?.video?.edited, image: !!s.prompts?.image?.edited }, references: s.references.map(r => ({ name: r.name, role: r.role, object: r.entityId ? name(r.entityId) : null })) })),
    currentShot: Math.max(1, p.shots.findIndex(s => s.id === currentShotId) + 1),
    pendingChanges: pending.map(x => x.text),
    units: 'metres; ground y=0; +z toward the default camera; -x is screen left; rotation = yaw degrees, 0 faces the camera',
  };
}
