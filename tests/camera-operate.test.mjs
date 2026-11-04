import test from 'node:test';
import assert from 'node:assert/strict';
import {
  quatFromYawPitch, forwardOf, yawPitchOf, quatLookAt, quatSlerp, quatAngle, alignYaw, shapeAxis, shapeStick, padInput, padCentred, ButtonEdges, keyboardInput,
  createDrone, stepDrone, defaultFlightSettings, createDolly, stepDolly, stepHead, TakeRecorder, sampleTrack, mergePasses, takeToKeys, takePatch, takeDuration, smoothOrientations, MAX_TAKE,
} from '../shared/camera-operate.mjs';
import { cameraAt, normalizeCamera, shotCameraAt, makeShot } from '../shared/director.mjs';
import { createProjectDocument, applyOps } from '../server/previs/director.mjs';

const near = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) <= eps, msg ?? `${a} ≉ ${b}`);
const nearV = (a, b, eps = 1e-6) => a.forEach((v, i) => near(v, b[i], eps, `[${i}] ${a} ≉ ${b}`));
const pad = (axes = [0, 0, 0, 0], pressed = []) => ({ axes, buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i), value: pressed.includes(i) ? 1 : 0 })) });

test('orientation helpers follow the three.js camera convention', () => {
  nearV(forwardOf([0, 0, 0, 1]), [0, 0, -1]);
  nearV(forwardOf(quatFromYawPitch(Math.PI / 2, 0)), [-1, 0, 0]); // positive yaw turns left
  nearV(forwardOf(quatFromYawPitch(0, Math.PI / 4)), [0, Math.SQRT1_2, -Math.SQRT1_2]);
  const { yaw, pitch } = yawPitchOf(quatFromYawPitch(0.7, -0.3));
  near(yaw, 0.7); near(pitch, -0.3);
  nearV(forwardOf(quatLookAt([0, 0, 0], [3, 0, 0])), [1, 0, 0]);
  near(quatAngle(quatSlerp([0, 0, 0, 1], quatFromYawPitch(1, 0), 0.5), quatFromYawPitch(0.5, 0)), 0, 1e-6);
  near(yawPitchOf(alignYaw(quatFromYawPitch(2, 0.2), -1)).yaw, -1); near(yawPitchOf(alignYaw(quatFromYawPitch(2, 0.2), -1)).pitch, 0.2);
});

test('stick shaping: radial deadzone, expo, full deflection reaches 1', () => {
  assert.equal(shapeAxis(0.05), 0);
  near(shapeAxis(1), 1); near(shapeAxis(-1), -1);
  assert.ok(shapeAxis(0.5) < 0.5 && shapeAxis(0.5) > 0.2, 'expo softens the centre');
  const [x, y] = shapeStick(0.7071, 0.7071);
  near(x, y); near(Math.hypot(x, y), 1, 1e-3);
  assert.deepEqual(shapeStick(0.05, 0.05), [0, 0]);
});

test('gamepad layouts, LB slow, RB fast and centring', () => {
  const game = padInput(pad([0, -1, 1, 0], [7]), 'game');
  near(game.forward, 1); near(game.yaw, 1); near(game.vertical, 1); near(game.lateral, 0);
  const rc = padInput(pad([1, -1, 0, -1]), 'drone');
  near(rc.yaw, Math.SQRT1_2, 1e-3); near(rc.vertical, Math.SQRT1_2, 1e-3); near(rc.forward, 1);
  near(padInput(pad([0, -1, 0, 0], [4])).forward, 0.3);
  near(padInput(pad([0, -1, 0, 0], [5])).forward, 2.5);
  assert.equal(padCentred(pad([0.02, -0.03, 0, 0])), true);
  assert.equal(padCentred(pad([0, 0, 0, 0], [6])), false);
  const kb = keyboardInput(new Set(['KeyW', 'KeyD', 'Space', 'KeyQ']));
  assert.deepEqual([kb.forward, kb.lateral, kb.vertical, kb.yaw], [1, 1, 1, -1]);
});

test('button edges fire once per press and never on a new controller', () => {
  const e = new ButtonEdges();
  assert.deepEqual(e.read('0:pad', [true, false]), []); // held while connecting
  assert.deepEqual(e.read('0:pad', [true, false]), []);
  assert.deepEqual(e.read('0:pad', [false, false]), []);
  assert.deepEqual(e.read('0:pad', [true, true]), [0, 1]);
  assert.deepEqual(e.read('0:pad', [true, true]), []);
  assert.deepEqual(e.read('1:other', [false, true]), []);
});

test('drone eases toward demanded velocity relative to its heading and respects min altitude', () => {
  const s = defaultFlightSettings(), d = createDrone([0, 2, 0], 0, 0);
  stepDrone(d, { forward: 1, lateral: 0, vertical: 0, yaw: 0, pitch: 0 }, 1 / 60, s);
  assert.ok(Math.hypot(...d.v) < s.maxSpeed * 0.1, 'does not jump to full speed');
  for (let i = 0; i < 300; i++) stepDrone(d, { forward: 1, lateral: 0, vertical: 0, yaw: 0, pitch: 0 }, 1 / 60, s);
  near(d.v[2], -s.maxSpeed, 0.01); assert.ok(d.p[2] < -20);
  const turned = createDrone([0, 2, 0], Math.PI / 2, 0);
  for (let i = 0; i < 300; i++) stepDrone(turned, { forward: 1, lateral: 0, vertical: -1, yaw: 0, pitch: 0 }, 1 / 60, s);
  assert.ok(turned.p[0] < -20 && Math.abs(turned.p[2]) < 1e-6, 'flies along -X when yawed left');
  near(turned.p[1], s.minAltitude);
  const yawing = createDrone();
  for (let i = 0; i < 60; i++) stepDrone(yawing, { forward: 0, lateral: 0, vertical: 0, yaw: 1, pitch: 0 }, 1 / 60, s);
  near(yawing.yaw, -s.yawRate * Math.PI / 180, 1e-6);
});

test('dolly travels along the track by arc length and stops at the ends', () => {
  const d = createDolly([[0, 1, 0], [4, 1, 0], [4, 1, 4]]);
  assert.equal(d.length, 8);
  for (let i = 0; i < 600; i++) stepDolly(d, { forward: 1, lateral: 0, vertical: 0, yaw: 0, pitch: 0 }, 1 / 60);
  nearV(d.p, [4, 1, 4]); assert.equal(d.speed, 0);
  const q = stepHead(quatFromYawPitch(0, 0), { forward: 0, lateral: 0, vertical: 0, yaw: -1, pitch: 1 }, 0.5);
  assert.ok(yawPitchOf(q).yaw > 0 && yawPitchOf(q).pitch > 0);
});

test('recorder: A cycles arm → record → stop and auto-stops at 5 s', () => {
  const r = new TakeRecorder();
  assert.equal(r.cycle(0), 'armed');
  assert.equal(r.cycle(1000), 'recording');
  let now = 1000, ok = true;
  while (ok) { ok = r.push(now, { p: [0, 0, 0], q: [0, 0, 0, 1], mm: 35 }); now += 16; }
  assert.equal(r.state, 'done');
  near(r.duration, MAX_TAKE);
  assert.ok(r.samples.every((s, i) => i === 0 || s.t > r.samples[i - 1].t));
  assert.equal(r.cycle(now), 'armed');
});

// A 4 s orbit sampled at 60 Hz with a pan, constant then sped-up — timing must survive.
function orbitTake(seconds = 4, hz = 60) {
  return Array.from({ length: Math.round(seconds * hz) + 1 }, (_, i) => {
    const t = i / hz, a = (t / seconds) ** 2 * Math.PI; // accelerating
    const p = [6 * Math.sin(a), 1.6 + t * 0.3, 6 * Math.cos(a)];
    return { t, p, q: quatLookAt(p, [0, 1, 0]), mm: 35 };
  });
}

test('takeToKeys keeps ≤64 keys, preserves timing with linear playback and stays within tolerance', () => {
  const take = orbitTake();
  const { keys, duration } = takeToKeys(take);
  assert.equal(duration, 4);
  assert.ok(keys.length <= 64 && keys.length >= 4, `${keys.length} keys`);
  assert.equal(keys[0].t, 0); assert.equal(keys.at(-1).t, 1);
  const cam = normalizeCamera({ move: 'custom', keys, timing: 'linear' });
  assert.equal(cam.timing, 'linear'); assert.equal(cam.keys.length, keys.length);
  let worst = 0;
  for (const s of take) { const pose = cameraAt(cam.keys, duration, s.t, 'linear'); worst = Math.max(worst, Math.hypot(...pose.p.map((v, i) => v - s.p[i]))); }
  assert.ok(worst < 0.05, `worst position error ${worst}`);
  // Eased playback would distort the take's pace; linear does not.
  const mid = take[60], eased = cameraAt(cam.keys, duration, mid.t), linear = cameraAt(cam.keys, duration, mid.t, 'linear');
  assert.ok(Math.hypot(...linear.p.map((v, i) => v - mid.p[i])) < Math.hypot(...eased.p.map((v, i) => v - mid.p[i])));
  // A fast, wiggly take is capped at 64 keys.
  const wild = take.map(s => ({ ...s, p: s.p.map((v, i) => v + Math.sin(s.t * 40 + i) * 0.5) }));
  assert.equal(takeToKeys(wild).keys.length, 64);
  assert.throws(() => takeToKeys(take.slice(0, 10)), /too short/);
});

test('takes longer than 5 s are trimmed; durations snap to 0.01 s', () => {
  assert.equal(takeDuration(7), 5); assert.equal(takeDuration(2.3456), 2.35); assert.equal(takeDuration(0.1), 0.5);
  const { duration, keys } = takeToKeys(orbitTake(6));
  assert.equal(duration, 5); assert.equal(keys.at(-1).t, 1);
});

test('aim pass merges pass-1 positions with pass-2 orientation', () => {
  const position = orbitTake(3);
  const aim = position.filter((_, i) => i % 2 === 0).map(s => ({ t: s.t, p: [0, 0, 0], q: quatFromYawPitch(s.t, -0.1), mm: 50 }));
  const merged = mergePasses(position, aim);
  assert.equal(merged.length, aim.length);
  nearV(merged[10].p, sampleTrack(position, aim[10].t).p);
  assert.deepEqual(merged[10].q, aim[10].q);
  const { keys } = takeToKeys(merged);
  const dir = keys[3].look.map((v, i) => v - keys[3].p[i]);
  near(yawPitchOf(dir).pitch, -0.1, 0.01);
  assert.equal(keys[0].mm, 50);
  // Function position sources (an existing shot camera) also work.
  const fixed = mergePasses(() => [1, 2, 3], aim);
  assert.deepEqual(fixed[5].p, [1, 2, 3]);
});

test('deshake smooths jitter but follows a deliberate turn', () => {
  const jitter = Array.from({ length: 121 }, (_, i) => ({ t: i / 60, p: [0, 0, 0], q: quatFromYawPitch((i % 2 ? 1 : -1) * 0.01 + (i > 60 ? 0.5 : 0), 0), mm: 35 }));
  const smooth = smoothOrientations(jitter);
  const wobble = (list, a, b) => Math.max(...list.slice(a, b).map((s, i, arr) => (i ? quatAngle(s.q, arr[i - 1].q) : 0)));
  assert.ok(wobble(smooth, 20, 55) < wobble(jitter, 20, 55) / 3);
  near(yawPitchOf(smooth.at(-1).q).yaw, 0.5, 0.03);
});

test('a kept take round-trips through update_shot with linear timing, and a preset move clears it', () => {
  const p = createProjectDocument({ template: 'street' }), s = p.shots[0];
  const result = takeToKeys(orbitTake(2.5));
  applyOps(p, [{ op: 'update_shot', id: s.id, patch: takePatch(result) }]);
  const shot = p.shots[0];
  assert.equal(shot.camera.move, 'custom'); assert.equal(shot.camera.timing, 'linear'); assert.equal(shot.duration, 2.5);
  const at = shotCameraAt(shot, p.scene.entities, 1.25), expect = sampleTrack(orbitTake(2.5), 1.25).p;
  assert.ok(Math.hypot(...at.p.map((v, i) => v - expect[i])) < 0.05);
  applyOps(p, [{ op: 'update_shot', id: s.id, patch: { camera: { move: 'dolly-in' } } }]);
  assert.equal(p.shots[0].camera.timing, undefined);
  assert.equal(makeShot({}, 'x', 1).camera.timing, undefined);
});
