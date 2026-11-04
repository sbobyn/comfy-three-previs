#!/usr/bin/env node
// Copyright (c) 2026 Steven Bobyn. SPDX-License-Identifier: MIT
// A procedural, rigged artist's mannequin for the starters (docs/import.md): original geometry made here, no
// third-party art. One skinned mesh of rounded segments with ball joints, rigidly weighted to a 1.8 m humanoid
// skeleton in a T-pose, facing +z, with plain bone names (hips, upper_arm_L, shin_R …) that the rig mapper reads.
// Clips loop in place: Walk (1.1 s, about 1.27 m/s when its path moves it 1.4 m per cycle), Idle and Wave.
//
//   node scripts/starters/mannequin.mjs <out.glb> [--body '#c9b79c'] [--trim '#5b5550']
//
// The output is deterministic for the same options, so re-running it makes the same bytes.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { writeFile } from 'node:fs/promises';
import { exportGlb } from '../../server/previs/asset-convert.mjs';

// name, parent, rest position (metres, world), radius of the segment drawn from the parent to it
const BONES = [
  ['hips', null, [0, 0.98, 0]], ['spine', 'hips', [0, 1.1, 0]], ['chest', 'spine', [0, 1.3, 0]], ['neck', 'chest', [0, 1.5, 0]], ['head', 'neck', [0, 1.58, 0]], ['head_end', 'head', [0, 1.8, 0]],
  ['shoulder_L', 'chest', [0.05, 1.44, 0]], ['upper_arm_L', 'shoulder_L', [0.19, 1.44, 0]], ['forearm_L', 'upper_arm_L', [0.47, 1.44, 0]], ['hand_L', 'forearm_L', [0.72, 1.44, 0]], ['hand_end_L', 'hand_L', [0.88, 1.44, 0]],
  ['shoulder_R', 'chest', [-0.05, 1.44, 0]], ['upper_arm_R', 'shoulder_R', [-0.19, 1.44, 0]], ['forearm_R', 'upper_arm_R', [-0.47, 1.44, 0]], ['hand_R', 'forearm_R', [-0.72, 1.44, 0]], ['hand_end_R', 'hand_R', [-0.88, 1.44, 0]],
  ['thigh_L', 'hips', [0.1, 0.93, 0]], ['shin_L', 'thigh_L', [0.1, 0.5, 0]], ['foot_L', 'shin_L', [0.1, 0.08, 0]], ['toe_L', 'foot_L', [0.1, 0.02, 0.14]],
  ['thigh_R', 'hips', [-0.1, 0.93, 0]], ['shin_R', 'thigh_R', [-0.1, 0.5, 0]], ['foot_R', 'shin_R', [-0.1, 0.08, 0]], ['toe_R', 'foot_R', [-0.1, 0.02, 0.14]],
];

function parse(args) {
  const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
  return { out: args.find(a => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--')), body: opt('body', '#c9b79c'), trim: opt('trim', '#5b5550') };
}

/** { root, animations } of the mannequin. */
export function mannequin({ body = '#c9b79c', trim = '#5b5550' } = {}) {
  const at = new Map(BONES.map(([n, , p]) => [n, new THREE.Vector3(...p)]));
  const bones = new Map();
  for (const [name, parent] of BONES) {
    const b = new THREE.Bone(); b.name = name;
    b.position.copy(at.get(name)).sub(parent ? at.get(parent) : new THREE.Vector3());
    bones.set(name, b); if (parent) bones.get(parent).add(b);
  }
  const list = [...bones.values()];
  const skin = (g, bone) => {
    const n = g.getAttribute('position').count, i = list.indexOf(bones.get(bone));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(Array.from({ length: n * 4 }, (_, k) => (k % 4 === 0 ? i : 0)), 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: n * 4 }, (_, k) => (k % 4 === 0 ? 1 : 0)), 4));
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'skinIndex', 'skinWeight'].includes(k)) g.deleteAttribute(k);
    return g;
  };
  const place = (g, from, to) => {
    const a = at.get(from), b = to instanceof THREE.Vector3 ? to : at.get(to), d = b.clone().sub(a);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize()));
    g.translate(a.x + d.x / 2, a.y + d.y / 2, a.z + d.z / 2);
    return g;
  };
  // A limb segment: a capsule from joint a to joint b, weighted to a's bone.
  const limb = (a, b, r, shrink = 0.02) => { const len = at.get(a).distanceTo(at.get(b)) - 2 * r - shrink; return skin(place(new THREE.CapsuleGeometry(r, Math.max(0.01, len), 3, 8), a, b), a); };
  const ball = (bone, r, offset = [0, 0, 0]) => skin(new THREE.SphereGeometry(r, 8, 6).translate(...at.get(bone).clone().add(new THREE.Vector3(...offset)).toArray()), bone);
  const box = (bone, size, centre) => skin(new THREE.BoxGeometry(...size).translate(...centre), bone);
  const main = [], dark = [];
  // Torso: pelvis block, a waist and a broader chest, so front and back read in silhouette.
  main.push(box('hips', [0.3, 0.16, 0.19], [0, 0.96, 0]));
  main.push(skin(new THREE.CylinderGeometry(0.12, 0.13, 0.14, 10).translate(0, 1.12, 0), 'spine'));
  main.push(skin(new THREE.CylinderGeometry(0.19, 0.14, 0.26, 10).scale(1, 1, 0.68).translate(0, 1.33, 0.005), 'chest'));
  main.push(limb('neck', 'head', 0.045, -0.04));
  main.push(skin(new THREE.SphereGeometry(0.105, 12, 9).scale(0.92, 1.12, 1).translate(0, 1.685, 0.005), 'head'));
  // The face: a dark visor on the front of the head, so which way a figure faces reads from any distance.
  dark.push(box('head', [0.14, 0.05, 0.03], [0, 1.7, 0.095]));
  for (const s of ['L', 'R']) {
    main.push(ball(`upper_arm_${s}`, 0.06));
    main.push(limb(`upper_arm_${s}`, `forearm_${s}`, 0.048));
    main.push(ball(`forearm_${s}`, 0.045));
    main.push(limb(`forearm_${s}`, `hand_${s}`, 0.04));
    main.push(skin(new THREE.BoxGeometry(0.15, 0.03, 0.08).translate(at.get(`hand_${s}`).x + (s === 'L' ? 0.07 : -0.07), 1.44, 0), `hand_${s}`));
    main.push(ball(`thigh_${s}`, 0.07));
    main.push(limb(`thigh_${s}`, `shin_${s}`, 0.068));
    main.push(ball(`shin_${s}`, 0.058));
    main.push(limb(`shin_${s}`, `foot_${s}`, 0.052));
    // Dark shoes, longer to the front: the feet show the direction of travel.
    dark.push(box(`foot_${s}`, [0.1, 0.08, 0.26], [at.get(`foot_${s}`).x, 0.04, 0.06]));
  }
  const mat = (hex, name) => Object.assign(new THREE.MeshStandardMaterial({ color: new THREE.Color(hex), roughness: 0.7, metalness: 0 }), { name });
  const geo = mergeGeometries([mergeGeometries(main), mergeGeometries(dark)], true);
  const mesh = new THREE.SkinnedMesh(geo, [mat(body, 'mannequin'), mat(trim, 'mannequin-trim')]);
  mesh.name = 'Mannequin';
  const root = new THREE.Group(); root.name = 'Mannequin rig'; root.add(bones.get('hips')); root.add(mesh);
  root.updateMatrixWorld(true); mesh.bind(new THREE.Skeleton(list));
  return { root, animations: clips() };
}

// ---------- clips (bone-local rotations; every bone's rest rotation is identity, so axes are the character's) ----------
const D = Math.PI / 180;
const q = (x = 0, y = 0, z = 0) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x * D, y * D, z * D, 'XYZ'));
// Arms hang 78° down from the T-pose; swing is about x after that (negative = forward). Right side mirrors y and z.
const arm = (s, swing, out = 0) => new THREE.Quaternion().multiplyQuaternions(q(swing), q(0, 0, s === 'L' ? -78 + out : 78 - out));
const elbow = (s, bend) => q(0, s === 'L' ? -bend : bend, 0);
function track(name, times, values) {
  const flat = values.flatMap(v => v.toArray());
  return new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, times, flat);
}
function sampled(name, duration, n, fn) {
  const times = Array.from({ length: n + 1 }, (_, i) => Math.round((duration * i / n) * 1e4) / 1e4);
  return track(name, times, times.map(t => fn(t / duration)));
}
function clips() {
  const T = 1.1, N = 16, S = p => Math.sin(2 * Math.PI * p), C = p => Math.cos(2 * Math.PI * p);
  const walk = new THREE.AnimationClip('Walk', T, [
    new THREE.VectorKeyframeTrack('hips.position', Array.from({ length: N + 1 }, (_, i) => Math.round(T * i / N * 1e4) / 1e4), Array.from({ length: N + 1 }, (_, i) => [0, 0.98 + 0.022 * Math.cos(4 * Math.PI * i / N), 0]).flat()),
    sampled('hips', T, N, p => q(0, 5 * S(p), 0)),
    sampled('chest', T, N, p => q(3, -7 * S(p), 0)),
    sampled('head', T, N, p => q(-3, 3 * S(p), 0)),
    ...['L', 'R'].flatMap(s => {
      const o = s === 'L' ? 0 : 0.5;
      return [
        sampled(`thigh_${s}`, T, N, p => q(-24 * S(p + o))),
        sampled(`shin_${s}`, T, N, p => q(6 + 42 * Math.max(0, C(p + o + 0.05)) ** 1.6)),
        sampled(`foot_${s}`, T, N, p => q(10 * S(p + o) - 8 * Math.max(0, C(p + o)))),
        sampled(`upper_arm_${s}`, T, N, p => arm(s, 20 * S(p + o))),
        sampled(`forearm_${s}`, T, N, p => elbow(s, 18 + 10 * Math.max(0, -S(p + o)))),
      ];
    }),
  ]);
  const I = 3;
  const idle = new THREE.AnimationClip('Idle', I, [
    sampled('chest', I, 12, p => q(1.5 * S(p), 0, 0)),
    sampled('head', I, 12, p => q(-2, 8 * S(p * 1), 0)),
    sampled('hips', I, 12, p => q(0, 0, 1.2 * S(p))),
    ...['L', 'R'].flatMap(s => [sampled(`upper_arm_${s}`, I, 12, p => arm(s, 2 * S(p))), sampled(`forearm_${s}`, I, 12, () => elbow(s, 10))]),
  ]);
  const W = 2;
  const wave = new THREE.AnimationClip('Wave', W, [
    sampled('upper_arm_L', W, 8, () => arm('L', 0)), sampled('forearm_L', W, 8, () => elbow('L', 10)),
    sampled('upper_arm_R', W, 8, () => q(0, 0, -8)),
    sampled('forearm_R', W, 16, p => q(0, 0, -(95 + 25 * S(p * 2)))),
    sampled('head', W, 8, () => q(0, -6, 0)),
  ]);
  return [walk, idle, wave];
}

/** The mannequin as GLB bytes. */
export async function mannequinGlb(opts) {
  const { root, animations } = mannequin(opts);
  return exportGlb(root, animations);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const o = parse(process.argv.slice(2));
  if (!o.out) { console.error('Usage: node scripts/starters/mannequin.mjs <out.glb> [--body #rrggbb] [--trim #rrggbb]'); process.exit(2); }
  const bytes = await mannequinGlb(o);
  await writeFile(o.out, bytes);
  console.log(`✓ ${o.out}: ${bytes.length} bytes`);
}
