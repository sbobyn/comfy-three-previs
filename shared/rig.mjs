// Copyright (c) 2026 Steven Bobyn. SPDX-License-Identifier: MIT
// Imported humanoid rigs: which bone is which (by name, checked by hierarchy), the canonical pose frame, a small pose
// library and two-bone IK. Pure data and maths, shared by the server (import, agent tools) and the viewport.
//
// Pose angles on a rigged character are XYZ degrees about the character's own axes (x = its left, y = up, z = its
// front) relative to a canonical T-pose: arms straight out sideways, legs straight down. Each joint's rotation is
// relative to its parent joint (forward kinematics), and right-side joints are mirrored, so equal numbers on L and R
// are a symmetric pose. armL [0, 0, -80] lowers the left arm to the side; thighL [-90, 0, 0] lifts the left thigh
// forward; shinL [90, 0, 0] bends the knee; forearmL [0, -90, 0] bends the elbow; body [10, 0, 0] leans forward.

export const RIG_JOINTS = Object.freeze(['body', 'spine', 'neck', 'head', 'armL', 'forearmL', 'handL', 'armR', 'forearmR', 'handR', 'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR']);
const REQUIRED = ['body', 'armL', 'forearmL', 'handL', 'armR', 'forearmR', 'handR', 'thighL', 'shinL', 'thighR', 'shinR'];
/** Limb segments straightened to the canonical T-pose: segment → [child joint, canonical direction]. */
export const LIMBS = Object.freeze({
  armL: ['forearmL', [1, 0, 0]], forearmL: ['handL', [1, 0, 0]], armR: ['forearmR', [-1, 0, 0]], forearmR: ['handR', [-1, 0, 0]],
  thighL: ['shinL', [0, -1, 0]], shinL: ['footL', [0, -1, 0]], thighR: ['shinR', [0, -1, 0]], shinR: ['footR', [0, -1, 0]],
});
const RIGHT = new Set(['armR', 'forearmR', 'handR', 'thighR', 'shinR', 'footR']);

// ---------- bone names ----------
const NOISE = /^(mixamorig\d*|bip\d*|def|org|mch|j|jnt|joint|bone|b|c|cc|base|armature|skeleton|rig|sk)$/;
const SIDES = { l: 'L', left: 'L', lt: 'L', lft: 'L', r: 'R', right: 'R', rt: 'R', rgt: 'R' };
/** { side: 'L' | 'R' | null, core } for a bone name from any common naming scheme (Mixamo, UE, Rigify, VRM, Biped). */
export function boneWords(name) {
  const tokens = String(name).replace(/^.*[:|]/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  let side = null; const core = [];
  for (const t of tokens) { if (SIDES[t] && !side) side = SIDES[t]; else if (!NOISE.test(t)) core.push(t); }
  return { side, core: core.join('') };
}
const CORES = {
  body: ['hips', 'pelvis', 'hip'],
  spine: ['spine', 'spine0', 'spine00', 'spine01', 'spine1', 'chest', 'torso', 'abdomen'],
  neck: ['neck', 'neck0', 'neck01', 'neck1'],
  head: ['head'],
  arm: ['upperarm', 'uparm', 'arm'], forearm: ['forearm', 'lowerarm', 'elbow'], hand: ['hand', 'wrist'],
  thigh: ['upperleg', 'upleg', 'thigh'], shin: ['lowerleg', 'shin', 'calf', 'knee', 'leg'], foot: ['foot', 'ankle'],
};

/**
 * Map bones to canonical joints. bones: [{ id, name, parent }] (parent = another bone's id, or null). Returns
 * { humanoid, joints: { joint → id }, parents: { joint → nearest mapped ancestor joint | null } } or null when the
 * names or the hierarchy do not make a humanoid (arms and legs in order, under the hips).
 */
export function mapHumanoid(bones) {
  const byId = new Map(bones.map(b => [b.id, b])), words = new Map(bones.map(b => [b.id, boneWords(b.name)]));
  const depth = id => { let n = 0; for (let b = byId.get(id); b && b.parent != null && n < 512; b = byId.get(b.parent)) n++; return n; };
  const above = (anc, id) => { for (let b = byId.get(byId.get(id)?.parent), n = 0; b && n < 512; b = byId.get(b.parent), n++) if (b.id === anc) return true; return false; };
  const find = (kind, side, test = () => true) => {
    for (const core of CORES[kind]) {
      const hit = bones.filter(b => words.get(b.id).core === core && words.get(b.id).side === side && test(b.id)).sort((a, b) => depth(a.id) - depth(b.id))[0];
      if (hit) return hit.id;
    }
    return null;
  };
  const joints = {};
  joints.body = find('body', null);
  if (joints.body == null) return null;
  const under = id => above(joints.body, id);
  joints.spine = find('spine', null, under);
  joints.neck = find('neck', null, under);
  joints.head = find('head', null, under);
  for (const s of ['L', 'R']) {
    joints[`arm${s}`] = find('arm', s, under);
    joints[`forearm${s}`] = joints[`arm${s}`] == null ? null : find('forearm', s, id => above(joints[`arm${s}`], id));
    joints[`hand${s}`] = joints[`forearm${s}`] == null ? null : find('hand', s, id => above(joints[`forearm${s}`], id));
    joints[`thigh${s}`] = find('thigh', s, under);
    joints[`shin${s}`] = joints[`thigh${s}`] == null ? null : find('shin', s, id => above(joints[`thigh${s}`], id));
    joints[`foot${s}`] = joints[`shin${s}`] == null ? null : find('foot', s, id => above(joints[`shin${s}`], id));
  }
  if (REQUIRED.some(j => joints[j] == null)) return null;
  for (const j of Object.keys(joints)) if (joints[j] == null) delete joints[j];
  if (new Set(Object.values(joints)).size !== Object.keys(joints).length) return null;
  const owner = new Map(Object.entries(joints).map(([j, id]) => [id, j])), parents = {};
  for (const [j, id] of Object.entries(joints)) {
    parents[j] = null;
    for (let b = byId.get(byId.get(id).parent), n = 0; b && n < 512; b = byId.get(b.parent), n++) if (owner.has(b.id)) { parents[j] = owner.get(b.id); break; }
  }
  return { humanoid: true, joints, parents };
}

// ---------- quaternions [x, y, z, w] ----------
const D2R = Math.PI / 180;
export const qMul = (a, b) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
export const qInv = q => [-q[0], -q[1], -q[2], q[3]];
export function qRotate(q, v) { const p = qMul(qMul(q, [v[0], v[1], v[2], 0]), qInv(q)); return [p[0], p[1], p[2]]; }
const qAxis = (axis, angle) => { const s = Math.sin(angle / 2); return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)]; };
/** three.js Euler order 'XYZ' (degrees) → quaternion. */
export function qEuler([x, y, z]) { return qMul(qMul(qAxis([1, 0, 0], x * D2R), qAxis([0, 1, 0], y * D2R)), qAxis([0, 0, 1], z * D2R)); }
/** Quaternion → three.js Euler 'XYZ' degrees. */
export function eulerOf(q) {
  const [x, y, z, w] = q;
  const m11 = 1 - 2 * (y * y + z * z), m12 = 2 * (x * y - z * w), m13 = 2 * (x * z + y * w), m22 = 1 - 2 * (x * x + z * z), m23 = 2 * (y * z - x * w), m32 = 2 * (y * z + x * w), m33 = 1 - 2 * (x * x + y * y);
  const b = Math.asin(Math.max(-1, Math.min(1, m13)));
  const [a, c] = Math.abs(m13) < 0.9999999 ? [Math.atan2(-m23, m33), Math.atan2(-m12, m11)] : [Math.atan2(m32, m22), 0];
  return [a, b, c].map(v => Math.round(v / D2R * 100) / 100 || 0);
}
/** Mirror a rotation across the character's x = 0 plane (left ↔ right). */
export const qMirror = q => [q[0], -q[1], -q[2], q[3]];
/** The rotation a joint's stored angles stand for, in the character frame (right-side joints mirrored). */
export const jointRotation = (joint, angles = [0, 0, 0]) => (RIGHT.has(joint) ? qMirror(qEuler(angles)) : qEuler(angles));
function qBasis(c0, c1, c2) { // columns of a rotation matrix → quaternion
  const [m11, m21, m31] = c0, [m12, m22, m32] = c1, [m13, m23, m33] = c2, tr = m11 + m22 + m33;
  let q;
  if (tr > 0) { const s = 0.5 / Math.sqrt(tr + 1); q = [(m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s]; }
  else if (m11 > m22 && m11 > m33) { const s = 2 * Math.sqrt(1 + m11 - m22 - m33); q = [0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s]; }
  else if (m22 > m33) { const s = 2 * Math.sqrt(1 + m22 - m11 - m33); q = [(m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s]; }
  else { const s = 2 * Math.sqrt(1 + m33 - m11 - m22); q = [(m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s]; }
  const n = Math.hypot(...q); return q.map(v => v / n);
}
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = Math.hypot(...a); return l > 1e-12 ? scale(a, 1 / l) : null; };

// ---------- canonical skeleton ----------
/**
 * The canonical T-pose skeleton of a rig profile at a given object size (metres): joint → position in the object's
 * frame (origin at the bottom centre), and joint → offset from its parent joint. Limb segments are straightened along
 * their canonical direction, keeping each bone's length.
 */
export function canonicalSkeleton(rig, size = [1, 1, 1]) {
  const rest = Object.fromEntries(Object.entries(rig.rest || {}).map(([j, p]) => [j, p.map((v, i) => v * size[i])]));
  const offsets = {}, order = RIG_JOINTS.filter(j => rest[j]);
  for (const j of order) {
    const p = rig.parents?.[j];
    if (!p || !rest[p]) { offsets[j] = rest[j]; continue; }
    const v = sub(rest[j], rest[p]);
    offsets[j] = LIMBS[p] && LIMBS[p][0] === j ? scale(LIMBS[p][1], Math.hypot(...v)) : v;
  }
  return { order, offsets };
}
/** Forward kinematics of the canonical skeleton: joint → { p: position, q: accumulated rotation }. */
export function poseJoints(rig, size, pose = {}) {
  const { order, offsets } = canonicalSkeleton(rig, size), out = {};
  for (const j of order) {
    const parent = out[rig.parents?.[j]];
    const p = parent ? add(parent.p, qRotate(parent.q, offsets[j])) : offsets[j];
    out[j] = { p, q: parent ? qMul(parent.q, jointRotation(j, pose[j])) : jointRotation(j, pose[j]) };
  }
  return out;
}
/**
 * How far (metres) a posed character must drop so its lowest ankle stays where it was in the T-pose: bent legs lower
 * the hips onto a seat or the ground instead of lifting the feet into the air. 0 for rigs without feet.
 */
export function groundDrop(rig, size, pose = {}) {
  const feet = ['footL', 'footR'].filter(j => rig.rest?.[j]);
  if (!feet.length) return 0;
  const T = poseJoints(rig, size, {}), P = poseJoints(rig, size, pose);
  return Math.min(...feet.map(j => P[j].p[1])) - Math.min(...feet.map(j => T[j].p[1]));
}

// ---------- two-bone IK ----------
const IK = {
  handL: ['armL', 'forearmL', [0, -1, 0], [0, -0.5, -1]], handR: ['armR', 'forearmR', [0, -1, 0], [0, -0.5, -1]],
  footL: ['thighL', 'shinL', [1, 0, 0], [0, 0, 1]], footR: ['thighR', 'shinR', [1, 0, 0], [0, 0, 1]],
};
export const IK_EFFECTORS = Object.freeze(Object.keys(IK));
/**
 * Reach `target` (object frame, metres) with a hand or foot. Returns a new pose with the two limb joints solved;
 * elbows bend backward and knees forward. Out-of-reach targets straighten the limb toward them. Body, spine and
 * the other limbs keep their angles.
 */
export function solveLimb(rig, size, pose, effector, target) {
  const spec = IK[effector];
  if (!spec) throw Error(`IK works on ${IK_EFFECTORS.join(', ')}`);
  if (!Array.isArray(target) || target.length !== 3 || !target.every(Number.isFinite)) throw Error('IK target must be [x, y, z] in metres');
  const [upper, lower, hinge, pole] = spec, mirror = RIGHT.has(upper), m = v => (mirror ? [-v[0], v[1], v[2]] : v);
  if (!rig.joints?.[upper] || !rig.joints?.[lower] || !rig.joints?.[effector] || !rig.rest?.[effector]) throw Error(`This rig has no ${effector}`);
  const { offsets } = canonicalSkeleton(rig, size), J = poseJoints(rig, size, { ...pose, [upper]: [0, 0, 0], [lower]: [0, 0, 0] });
  const parentQ = J[rig.parents[upper]]?.q || [0, 0, 0, 1];
  // Solve as a left limb: mirrored positions and parent rotation for right-side limbs.
  const local = qRotate(qInv(mirror ? qMirror(parentQ) : parentQ), m(sub(target, J[upper].p)));
  const L1 = Math.hypot(...offsets[lower]), L2 = Math.hypot(...offsets[effector]);
  const rest = LIMBS[mirror ? upper.replace('R', 'L') : upper][1];
  const reach = Math.hypot(...local), d = Math.max(Math.abs(L1 - L2) + 1e-4, Math.min(L1 + L2 - 1e-4, reach));
  const u = norm(local) || rest;
  const side = norm(sub(pole, scale(u, dot(pole, u)))) || norm(cross(u, hinge)) || [0, 0, 1];
  const cosA = Math.max(-1, Math.min(1, (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d)));
  const a = add(scale(u, cosA), scale(side, Math.sqrt(1 - cosA * cosA)));
  const theta = Math.PI - Math.acos(Math.max(-1, Math.min(1, (L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2))));
  const f = norm(sub(scale(u, d), scale(a, L1))) || a;
  const bend = norm(sub(f, scale(a, dot(f, a)))) || norm(scale(sub(side, scale(a, dot(side, a))), -1)) || norm(cross(hinge, a));
  const h2 = norm(cross(a, bend));
  const R = qMul(qBasis(a, h2, cross(a, h2)), qInv(qBasis(rest, hinge, cross(rest, hinge))));
  return { ...pose, [upper]: eulerOf(R), [lower]: eulerOf(qAxis(hinge, theta)) };
}

// ---------- pose library ----------
const sym = (j, v) => ({ [`${j}L`]: v, [`${j}R`]: v });
/** Named poses for imported humanoids. stand is the neutral stand-in pose. */
export const RIG_POSES = Object.freeze({
  tpose: {},
  stand: { ...sym('arm', [0, 0, -78]), ...sym('forearm', [0, -8, 0]) },
  walk: { body: [4, 0, 0], armL: [18, 0, -80], armR: [-20, 0, -80], ...sym('forearm', [0, -18, 0]), thighL: [-24, 0, 0], shinL: [6, 0, 0], thighR: [16, 0, 0], shinR: [26, 0, 0] },
  run: { body: [14, 0, 0], armL: [45, 0, -72], armR: [-55, 0, -72], ...sym('forearm', [0, -95, 0]), thighL: [-62, 0, 0], shinL: [55, 0, 0], thighR: [28, 0, 0], shinR: [80, 0, 0] },
  sit: { body: [-4, 0, 0], ...sym('arm', [-32, 0, -80]), ...sym('forearm', [0, -55, 0]), ...sym('thigh', [-88, 0, 0]), ...sym('shin', [88, 0, 0]) },
  jump: { body: [8, 0, 0], ...sym('arm', [-20, 0, 55]), ...sym('forearm', [0, -15, 0]), ...sym('thigh', [-55, 0, 0]), ...sym('shin', [95, 0, 0]) },
  point: { head: [0, -12, 0], armL: [0, 0, -80], forearmL: [0, -10, 0], armR: [0, -82, 8], forearmR: [0, -4, 0] },
  wave: { head: [0, -6, 0], armL: [0, 0, -80], forearmL: [0, -10, 0], armR: [0, -10, 8], forearmR: [0, 0, 95] },
});
export const POSE_NAMES = Object.freeze(Object.keys(RIG_POSES));

// ---------- clips ----------
/**
 * The clip an imported object plays at scene time t, or null: the last performance key at or before t, else the
 * object's default clip. time is seconds into the clip (offset + elapsed × speed), before looping.
 */
export function performanceAt(entity, t) {
  const perf = entity?.perform;
  if (!perf) return null;
  const key = (perf.keys || []).filter(k => k.t <= t + 1e-6).at(-1);
  const from = key || { t: 0, clip: perf.clip, offset: perf.offset ?? 0, speed: perf.speed ?? 1 };
  if (!from.clip) return null;
  return { clip: from.clip, time: (from.offset ?? 0) + (t - from.t) * (from.speed ?? 1), loop: perf.loop !== false, inPlace: perf.inPlace !== false };
}
