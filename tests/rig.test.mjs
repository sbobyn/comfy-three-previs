// Copyright (c) 2026 Steven Bobyn. SPDX-License-Identifier: MIT
// Imported humanoid rigs (shared/rig.mjs, shared/imported-asset.mjs): bone names, canonical poses, IK, clips, and what
// enters a shot signature.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mapHumanoid, boneWords, poseJoints, solveLimb, groundDrop, RIG_POSES, POSE_NAMES, performanceAt, qEuler, eulerOf, jointRotation, qRotate } from '../shared/rig.mjs';
import { normalizeSource, normalizePerform } from '../shared/imported-asset.mjs';
import { makeEntity, shotSignature, makeShot } from '../shared/director.mjs';

const chain = (names, parentOf = {}) => names.map((name, i) => ({ id: i, name, parent: parentOf[name] !== undefined ? names.indexOf(parentOf[name]) : null }));
function skeleton(names) {
  // names: [hips, spine, neck, head, armL, forearmL, handL, armR, forearmR, handR, thighL, shinL, footL, thighR, shinR, footR, fingerL]
  const [hips, spine, neck, head, aL, fL, hL, aR, fR, hR, tL, sL, ftL, tR, sR, ftR, finger] = names;
  return chain(names, { [spine]: hips, [neck]: spine, [head]: neck, [aL]: spine, [fL]: aL, [hL]: fL, [aR]: spine, [fR]: aR, [hR]: fR, [tL]: hips, [sL]: tL, [ftL]: sL, [tR]: hips, [sR]: tR, [ftR]: sR, [finger]: hL });
}
const SCHEMES = {
  mixamo: ['mixamorigHips', 'mixamorigSpine', 'mixamorigNeck', 'mixamorigHead', 'mixamorigLeftArm', 'mixamorigLeftForeArm', 'mixamorigLeftHand', 'mixamorigRightArm', 'mixamorigRightForeArm', 'mixamorigRightHand', 'mixamorigLeftUpLeg', 'mixamorigLeftLeg', 'mixamorigLeftFoot', 'mixamorigRightUpLeg', 'mixamorigRightLeg', 'mixamorigRightFoot', 'mixamorigLeftHandIndex1'],
  mixamoColon: ['mixamorig:Hips', 'mixamorig:Spine', 'mixamorig:Neck', 'mixamorig:Head', 'mixamorig:LeftArm', 'mixamorig:LeftForeArm', 'mixamorig:LeftHand', 'mixamorig:RightArm', 'mixamorig:RightForeArm', 'mixamorig:RightHand', 'mixamorig:LeftUpLeg', 'mixamorig:LeftLeg', 'mixamorig:LeftFoot', 'mixamorig:RightUpLeg', 'mixamorig:RightLeg', 'mixamorig:RightFoot', 'mixamorig:LeftHandThumb1'],
  unreal: ['pelvis', 'spine_01', 'neck_01', 'head', 'upperarm_l', 'lowerarm_l', 'hand_l', 'upperarm_r', 'lowerarm_r', 'hand_r', 'thigh_l', 'calf_l', 'foot_l', 'thigh_r', 'calf_r', 'foot_r', 'index_01_l'],
  rigify: ['DEF-hips', 'DEF-spine', 'DEF-neck', 'DEF-head', 'DEF-upper_armL', 'DEF-forearmL', 'DEF-handL', 'DEF-upper_armR', 'DEF-forearmR', 'DEF-handR', 'DEF-thighL', 'DEF-shinL', 'DEF-footL', 'DEF-thighR', 'DEF-shinR', 'DEF-footR', 'DEF-f_index01L'],
  vrm: ['J_Bip_C_Hips', 'J_Bip_C_Spine', 'J_Bip_C_Neck', 'J_Bip_C_Head', 'J_Bip_L_UpperArm', 'J_Bip_L_LowerArm', 'J_Bip_L_Hand', 'J_Bip_R_UpperArm', 'J_Bip_R_LowerArm', 'J_Bip_R_Hand', 'J_Bip_L_UpperLeg', 'J_Bip_L_LowerLeg', 'J_Bip_L_Foot', 'J_Bip_R_UpperLeg', 'J_Bip_R_LowerLeg', 'J_Bip_R_Foot', 'J_Bip_L_Index1'],
  biped: ['Bip01_Pelvis', 'Bip01_Spine', 'Bip01_Neck', 'Bip01_Head', 'Bip01_L_UpperArm', 'Bip01_L_Forearm', 'Bip01_L_Hand', 'Bip01_R_UpperArm', 'Bip01_R_Forearm', 'Bip01_R_Hand', 'Bip01_L_Thigh', 'Bip01_L_Calf', 'Bip01_L_Foot', 'Bip01_R_Thigh', 'Bip01_R_Calf', 'Bip01_R_Foot', 'Bip01_L_Finger0'],
};
const JOINTS = ['body', 'spine', 'neck', 'head', 'armL', 'forearmL', 'handL', 'armR', 'forearmR', 'handR', 'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR'];

test('bone names: Mixamo, Unreal, Rigify, VRM and Biped map to the same joints; fingers never do', () => {
  for (const [scheme, names] of Object.entries(SCHEMES)) {
    const map = mapHumanoid(skeleton(names));
    assert.ok(map, scheme);
    assert.deepEqual(JOINTS.map(j => map.joints[j]), JOINTS.map((_, i) => i), `${scheme}: every joint on its bone`);
    assert.equal(map.parents.forearmL, 'armL'); assert.equal(map.parents.armR, 'spine'); assert.equal(map.parents.body, null);
  }
  assert.deepEqual(boneWords('mixamorig:LeftForeArm'), { side: 'L', core: 'forearm' });
  assert.deepEqual(boneWords('Bip01 R Calf'), { side: 'R', core: 'calf' });
  assert.equal(boneWords('LeftHandIndex1').core, 'handindex1');
});

test('bone names: no arms, a hand outside its forearm or a sideless arm is not a humanoid', () => {
  const names = [...SCHEMES.mixamo];
  assert.equal(mapHumanoid(skeleton(names).filter(b => !/Arm|Hand/.test(b.name))), null, 'no arms');
  const swapped = skeleton(names); swapped[6].parent = 1; // LeftHand under Spine, not under LeftForeArm
  assert.equal(mapHumanoid(swapped), null, 'hand outside its forearm');
  assert.equal(mapHumanoid(chain(['Root', 'Tail1', 'Tail2'], { Tail1: 'Root', Tail2: 'Tail1' })), null, 'a tail is not a humanoid');
});

// A 1.8 m canonical figure: unit-box rest positions as the importer stores them, size in metres.
const RIG = {
  humanoid: true, joints: Object.fromEntries(JOINTS.map((j, i) => [j, i])),
  parents: { body: null, spine: 'body', neck: 'spine', head: 'neck', armL: 'spine', forearmL: 'armL', handL: 'forearmL', armR: 'spine', forearmR: 'armR', handR: 'forearmR', thighL: 'body', shinL: 'thighL', footL: 'shinL', thighR: 'body', shinR: 'thighR', footR: 'shinR' },
  // An A-pose: forearms and hands hang 45° down. The canonical skeleton straightens them to a T-pose.
  rest: { body: [0, 0.55, 0], spine: [0, 0.62, 0], neck: [0, 0.83, 0], head: [0, 0.88, 0], armL: [0.2, 0.8, 0], forearmL: [0.5, 0.7, 0], handL: [0.8, 0.6, 0], armR: [-0.2, 0.8, 0], forearmR: [-0.5, 0.7, 0], handR: [-0.8, 0.6, 0], thighL: [0.1, 0.52, 0], shinL: [0.1, 0.28, 0], footL: [0.1, 0.05, 0], thighR: [-0.1, 0.52, 0], shinR: [-0.1, 0.28, 0], footR: [-0.1, 0.05, 0] },
};
const SIZE = [0.5, 1.8, 0.3];
const close = (a, b, eps = 1e-3) => a.every((v, i) => Math.abs(v - b[i]) < eps);

test('canonical pose: T-pose straightens an A-pose rig; stand is symmetric; right-side angles mirror', () => {
  const T = poseJoints(RIG, SIZE, {});
  assert.ok(Math.abs(T.handL.p[1] - T.armL.p[1]) < 1e-9, 'T-pose arm is level');
  assert.ok(T.handL.p[0] > T.forearmL.p[0] && T.forearmL.p[0] > T.armL.p[0], 'left arm points to +x (the character’s left)');
  const S = poseJoints(RIG, SIZE, RIG_POSES.stand);
  assert.ok(S.handL.p[1] < S.armL.p[1] - 0.3, 'stand lowers the hands');
  assert.ok(close([-S.handR.p[0], S.handR.p[1], S.handR.p[2]], S.handL.p), 'equal L and R angles make a mirror pose');
  for (const name of POSE_NAMES) assert.ok(poseJoints(RIG, SIZE, RIG_POSES[name]).head.p[1] > 1, name);
  // Angles round-trip through quaternions in three.js's XYZ order.
  for (const a of [[10, -20, 30], [0, 80, 0], [-45, 10, 5]]) assert.ok(close(eulerOf(qEuler(a)), a, 0.02), a.join());
  assert.ok(close(qRotate(jointRotation('armL', [0, 0, -90]), [1, 0, 0]), [0, -1, 0]) && close(qRotate(jointRotation('armR', [0, 0, -90]), [-1, 0, 0]), [0, -1, 0]), 'armL/armR [0,0,-90] both point down');
});

test('IK: reachable hand and foot targets are reached; elbows bend back, knees forward; far targets straighten', () => {
  for (const [effector, target, joint, check] of [
    ['handL', [0.35, 1.25, 0.2], 'forearmL', (e, s, t) => e[2] < (s[2] + t[2]) / 2],
    ['handR', [-0.25, 1.15, 0.2], 'forearmR', (e, s, t) => e[2] < (s[2] + t[2]) / 2],
    ['footL', [0.1, 0.35, 0.25], 'shinL', (e, s, t) => e[2] > (s[2] + t[2]) / 2],
    ['footR', [-0.1, 0.25, -0.2], 'shinR', (e, s, t) => e[2] > (s[2] + t[2]) / 2],
  ]) {
    const pose = solveLimb(RIG, SIZE, RIG_POSES.stand, effector, target), J = poseJoints(RIG, SIZE, pose);
    assert.ok(close(J[effector].p, target, 1e-3), `${effector} reaches ${target}: ${J[effector].p}`);
    const root = J[RIG.parents[joint]].p;
    assert.ok(check(J[joint].p, root, target), `${effector}: ${joint} bends the natural way`);
  }
  const far = poseJoints(RIG, SIZE, solveLimb(RIG, SIZE, {}, 'handL', [3, 1.44, 0]));
  assert.ok(far.handL.p[0] > far.forearmL.p[0] && Math.abs(far.handL.p[1] - 1.44) < 0.01, 'out of reach: straight toward the target');
  assert.throws(() => solveLimb(RIG, SIZE, {}, 'tail', [0, 0, 0]), /IK works on/);
});

test('ground drop: bent legs lower the hips onto a seat; standing does not', () => {
  assert.ok(Math.abs(groundDrop(RIG, SIZE, RIG_POSES.stand)) < 1e-9);
  const sit = groundDrop(RIG, SIZE, RIG_POSES.sit);
  assert.ok(sit > 0.3 && sit < 0.6, `sit drops ${sit}`);
});

test('clips: default clip, keyed changes from a moment, offset, speed, and a key that stops the clip', () => {
  const source = normalizeSource({ format: 'glb', file: 'a.glb', clips: [{ name: 'Walk', duration: 1 }, { name: 'Wave', duration: 2 }] });
  const perform = normalizePerform({ clip: 'Walk', offset: 0.5, speed: 2, keys: [{ t: 3, clip: 'Wave', offset: 0, speed: 1 }, { t: 1, clip: 'Nope' }, { t: 5, clip: null }] }, source);
  assert.deepEqual(perform.keys.map(k => [k.t, k.clip]), [[1, null], [3, 'Wave'], [5, null]], 'sorted; unknown clips stop');
  const e = { perform: { ...perform, keys: perform.keys.filter(k => k.t !== 1) } };
  assert.deepEqual(performanceAt(e, 0.5), { clip: 'Walk', time: 1.5, loop: true, inPlace: true });
  assert.deepEqual(performanceAt(e, 4), { clip: 'Wave', time: 1, loop: true, inPlace: true });
  assert.equal(performanceAt(e, 6), null);
  assert.equal(normalizePerform({ clip: 'Walk' }, normalizeSource({ format: 'glb' })), undefined, 'no clips in the file: nothing to play');
});

test('signature: clip, pose and stand-in invalidate the blockout; licence and credit do not', () => {
  const model = '/director-refs/00000000-0000-0000-0000-000000000000/11111111-1111-1111-1111-111111111111.glb';
  const base = makeEntity({ name: 'Runner', shape: 'person', model, source: { format: 'fbx', file: 'runner.fbx', clips: [{ name: 'Run', duration: 1 }], rig: RIG } }, 'e1');
  assert.equal(base.source.rig.joints.handL, 6, 'the rig is kept');
  assert.equal(makeEntity({ name: 'Box', shape: 'box', source: base.source }, 'e2').source, undefined, 'no imported file, no source');
  const p = e => ({ scene: { entities: [e], environment: { preset: 'stage' } } });
  const s = makeShot({}, 's1', 1, [base]), sig = e => shotSignature(p(e), s);
  assert.equal(sig(makeEntity({ ...base, source: { ...base.source, licence: 'CC0', attribution: 'Someone' } }, 'e1')), sig(base));
  for (const change of [{ perform: { clip: 'Run' } }, { pose: RIG_POSES.sit }, { standIn: 'neutral' }]) assert.notEqual(sig(makeEntity({ ...base, ...change }, 'e1')), sig(base), JSON.stringify(change));
});

test('runtime: posing the same moment twice still shows the clip (a capture at the playhead, frame 0 of a blockout)', async () => {
  const THREE = await import('three'), ts = (await import('typescript')).default, { runInNewContext } = await import('node:vm');
  const { readFile } = await import('node:fs/promises'), rig = await import('../shared/rig.mjs');
  const { mannequin } = await import('../scripts/starters/mannequin.mjs');
  const source = await readFile(new URL('../src/director-rig.ts', import.meta.url), 'utf8'), exports = {};
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, require: name => (name === 'three' ? THREE : rig) });
  const { root: model, animations } = mannequin(); model.animations = animations;
  const e = { perform: { clip: 'Walk', offset: 0, speed: 1 }, source: { clips: animations.map(c => ({ name: c.name, duration: c.duration })) } };
  const runtime = new exports.RigRuntime(model, e), holder = new THREE.Group(); holder.add(model);
  const arm = model.getObjectByName('upper_arm_L'), rest = arm.quaternion.clone();
  for (const t of [0, 0, 1.1, 1.1, 0.4, 0]) {
    runtime.apply(holder, e, t, undefined);
    assert.ok(arm.quaternion.angleTo(rest) > 1, `t=${t}: the arm hangs down as the Walk clip has it, not in the bind T-pose`);
  }
  runtime.apply(holder, e, 0, undefined, { neutral: true });
  assert.ok(arm.quaternion.angleTo(rest) < 1e-6, 'the neutral stand-in plays no clip');
});
