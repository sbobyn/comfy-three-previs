// Copyright (c) 2026 Steven Bobyn. SPDX-License-Identifier: MIT
// Camera operating: flight rigs, stick shaping, take recording and take → shot camera keys.
// Pure math with plain arrays so it runs in the browser and under `node --test`.
// Conventions match three.js: a camera looks down its own -Z, yaw is about +Y
// (positive turns left seen from above), quaternions are [x, y, z, w].

export const MAX_TAKE = 5; // seconds; matches MAX_DURATION in director.mjs (120 frames at 24 fps).
export const MIN_TAKE = 0.5;
export const MAX_KEYS = 64;
const DEG = Math.PI / 180;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------- Quaternions ----------
export function quatMultiply(a, b) {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [ax * bw + aw * bx + ay * bz - az * by, ay * bw + aw * by + az * bx - ax * bz, az * bw + aw * bz + ax * by - ay * bx, aw * bw - ax * bx - ay * by - az * bz];
}
export function quatNormalize(q) {
  const l = Math.hypot(...q) || 1;
  return q.map(v => v / l);
}
const axisQuat = (axis, angle) => { const s = Math.sin(angle / 2), q = [0, 0, 0, Math.cos(angle / 2)]; q[axis] = s; return q; };
/** Orientation from yaw (about Y), then pitch (about X), then roll (about view Z) — Euler order YXZ. */
export function quatFromYawPitch(yaw, pitch, roll = 0) {
  return quatMultiply(quatMultiply(axisQuat(1, yaw), axisQuat(0, pitch)), axisQuat(2, roll));
}
export function rotateVector(q, v) {
  const [x, y, z, w] = q, [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
}
/** Unit view direction of a camera orientation. */
export const forwardOf = q => rotateVector(q, [0, 0, -1]);
/** Yaw and pitch (radians) of a view direction or orientation. */
export function yawPitchOf(qOrDir) {
  const d = qOrDir.length === 4 ? forwardOf(qOrDir) : qOrDir;
  const l = Math.hypot(...d) || 1;
  return { yaw: Math.atan2(-d[0], -d[2]), pitch: Math.asin(clamp(d[1] / l, -1, 1)) };
}
/** Orientation that looks from p toward look with world up (what the shot camera does). */
export function quatLookAt(p, look) {
  const { yaw, pitch } = yawPitchOf(look.map((v, i) => v - p[i]));
  return quatFromYawPitch(yaw, pitch);
}
export function quatSlerp(a, b, u) {
  let [bx, by, bz, bw] = b, dot = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (dot < 0) { dot = -dot; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  if (dot > 0.9995) return quatNormalize([a[0] + (bx - a[0]) * u, a[1] + (by - a[1]) * u, a[2] + (bz - a[2]) * u, a[3] + (bw - a[3]) * u]);
  const th = Math.acos(dot), s = Math.sin(th), wa = Math.sin((1 - u) * th) / s, wb = Math.sin(u * th) / s;
  return [a[0] * wa + bx * wb, a[1] * wa + by * wb, a[2] * wa + bz * wb, a[3] * wa + bw * wb];
}
export const quatAngle = (a, b) => 2 * Math.acos(clamp(Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]), 0, 1));
/** Rotate q about world up so its heading becomes `yaw`, keeping pitch and roll. */
export function alignYaw(q, yaw) {
  return quatNormalize(quatMultiply(axisQuat(1, yaw - yawPitchOf(q).yaw), q));
}

// ---------- Sticks ----------
export function defaultStickSettings() { return { deadzone: 0.08, expo: 0.45 }; }
/** Deadzone then expo: fine control near centre, full rate at the stops. */
export function shapeAxis(value, { deadzone, expo } = defaultStickSettings()) {
  if (!Number.isFinite(value)) return 0;
  const m = Math.min(1, Math.abs(value));
  if (m <= deadzone) return 0;
  const s = (m - deadzone) / (1 - deadzone);
  return Math.sign(value) * (expo * s ** 3 + (1 - expo) * s);
}
/** Radial deadzone for a stick, so diagonals are not cut into a cross. */
export function shapeStick(x, y, settings = defaultStickSettings()) {
  const l = Math.hypot(x, y);
  if (!Number.isFinite(l) || l === 0) return [0, 0];
  const k = shapeAxis(l, settings) / l;
  return [x * k, y * k];
}
export const LAYOUTS = { game: 'Game', drone: 'Drone RC Mode 2' };
export const BUTTON = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, UP: 12, DOWN: 13 };
const pressed = (pad, i) => Boolean(pad.buttons?.[i]?.pressed);
const value = (pad, i) => Number(pad.buttons?.[i]?.value ?? (pressed(pad, i) ? 1 : 0)) || 0;

/**
 * Standard-mapping pad → flight demands, each roughly -1..1 (×2.5 with RB held).
 * Game: LS strafe/forward, RS yaw/pitch, RT/LT climb/descend.
 * Drone RC Mode 2: LS yaw/climb, RS strafe/forward, D-pad up/down tilts the camera.
 * LB slows everything to ×0.3, RB speeds travel to ×2.5.
 */
export function padInput(pad, layout = 'game', settings = defaultStickSettings()) {
  const ax = i => Number(pad.axes?.[i]) || 0;
  const slow = pressed(pad, BUTTON.LB), move = slow ? 0.3 : pressed(pad, BUTTON.RB) ? 2.5 : 1, look = slow ? 0.3 : 1;
  if (layout === 'drone') {
    const [yaw, climb] = shapeStick(ax(0), ax(1), settings), [lat, fwd] = shapeStick(ax(2), ax(3), settings);
    return { forward: -fwd * move, lateral: lat * move, vertical: -climb * move, yaw: yaw * look, pitch: ((pressed(pad, BUTTON.UP) ? 1 : 0) - (pressed(pad, BUTTON.DOWN) ? 1 : 0)) * look };
  }
  const [lat, fwd] = shapeStick(ax(0), ax(1), settings), [yaw, pitch] = shapeStick(ax(2), ax(3), settings);
  return { forward: -fwd * move, lateral: lat * move, vertical: (shapeAxis(value(pad, BUTTON.RT), settings) - shapeAxis(value(pad, BUTTON.LT), settings)) * move, yaw: yaw * look, pitch: -pitch * look };
}
export function noInput() { return { forward: 0, lateral: 0, vertical: 0, yaw: 0, pitch: 0 }; }
/** True when sticks are centred and triggers released (safe to take control). */
export function padCentred(pad, settings = defaultStickSettings()) {
  return [0, 1, 2, 3].every(i => Math.abs(Number(pad.axes?.[i]) || 0) <= settings.deadzone) && [BUTTON.LT, BUTTON.RT].every(i => value(pad, i) <= settings.deadzone);
}
/** Rising edges only, so a held button never repeats and a newly connected pad never fires. */
export class ButtonEdges {
  constructor() { this.identity = ''; this.held = []; }
  read(identity, pressedList) {
    const edges = identity === this.identity ? pressedList.flatMap((p, i) => (p && !this.held[i] ? [i] : [])) : [];
    this.identity = identity; this.held = [...pressedList];
    return edges;
  }
  reset() { this.identity = ''; this.held = []; }
}
/** Keyboard flight: W/S forward, A/D strafe, Q/E yaw, Space/Shift up/down, arrows aim, Alt slow. */
export const FLIGHT_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'Space', 'ShiftLeft', 'ShiftRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
export function keyboardInput(down) {
  const k = c => (down.has(c) ? 1 : 0);
  const slow = down.has('AltLeft') || down.has('AltRight') ? 0.3 : 1;
  return {
    forward: (k('KeyW') - k('KeyS')) * slow, lateral: (k('KeyD') - k('KeyA')) * slow,
    vertical: (k('Space') - Math.max(k('ShiftLeft'), k('ShiftRight'))) * slow,
    yaw: (k('KeyE') + k('ArrowRight') - k('KeyQ') - k('ArrowLeft')) * slow, pitch: (k('ArrowUp') - k('ArrowDown')) * slow,
  };
}

// ---------- Rigs ----------
export function defaultFlightSettings() { return { maxSpeed: 6, climbSpeed: 3, response: 0.45, yawRate: 70, pitchRate: 50, minAltitude: 0.3 }; }
const easeBlend = (dt, response) => 1 - Math.exp(-dt / Math.max(0.01, response));
const PITCH_LIMIT = 85 * DEG;

/**
 * Drone free flight. Sticks demand a velocity relative to the heading and the
 * real velocity chases it (1 - e^(-dt/response)), so moves accelerate and coast
 * like an airframe with mass. Yaw and camera tilt are rates.
 */
export function createDrone(p = [0, 2, 6], yaw = 0, pitch = 0) { return { p: [...p], v: [0, 0, 0], yaw, pitch }; }
export function stepDrone(d, input, dt, s = defaultFlightSettings()) {
  dt = clamp(dt, 0, 0.1);
  d.yaw -= (input.yaw || 0) * s.yawRate * DEG * dt;
  d.pitch = clamp(d.pitch + (input.pitch || 0) * s.pitchRate * DEG * dt, -PITCH_LIMIT, PITCH_LIMIT);
  const fx = -Math.sin(d.yaw), fz = -Math.cos(d.yaw), rx = Math.cos(d.yaw), rz = -Math.sin(d.yaw);
  const f = input.forward || 0, l = input.lateral || 0;
  const demand = [(fx * f + rx * l) * s.maxSpeed, (input.vertical || 0) * s.climbSpeed, (fz * f + rz * l) * s.maxSpeed];
  const k = easeBlend(dt, s.response);
  d.v = d.v.map((v, i) => v + (demand[i] - v) * k);
  d.p = d.p.map((v, i) => v + d.v[i] * dt);
  if (d.p[1] < s.minAltitude) { d.p[1] = s.minAltitude; d.v[1] = Math.max(0, d.v[1]); }
  return d;
}
export const droneQuat = d => quatFromYawPitch(d.yaw, d.pitch);
export const speedOf = rig => Math.hypot(...rig.v);

/**
 * Dolly: travel along a fixed track (an existing camera path) at a stick-demanded
 * speed with the same easing, while the head pans/tilts freely from yaw/pitch.
 */
export function createDolly(points, yaw = 0, pitch = 0) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + Math.hypot(...points[i].map((v, k) => v - points[i - 1][k])));
  return { points: points.map(p => [...p]), cum, length: cum.at(-1) || 0, s: 0, speed: 0, yaw, pitch, p: [...points[0]], v: [0, 0, 0] };
}
export function dollyPoint(d, s) {
  const { points, cum } = d;
  if (points.length === 1 || s <= 0) return [...points[0]];
  if (s >= d.length) return [...points.at(-1)];
  let i = 1; while (cum[i] < s) i++;
  const u = cum[i] > cum[i - 1] ? (s - cum[i - 1]) / (cum[i] - cum[i - 1]) : 0;
  return points[i - 1].map((v, k) => v + (points[i][k] - v) * u);
}
export function stepDolly(d, input, dt, s = defaultFlightSettings()) {
  dt = clamp(dt, 0, 0.1);
  d.yaw -= (input.yaw || 0) * s.yawRate * DEG * dt;
  d.pitch = clamp(d.pitch + (input.pitch || 0) * s.pitchRate * DEG * dt, -PITCH_LIMIT, PITCH_LIMIT);
  d.speed += ((input.forward || 0) * s.maxSpeed - d.speed) * easeBlend(dt, s.response);
  const before = d.p;
  d.s = clamp(d.s + d.speed * dt, 0, d.length);
  if (d.s === 0 || d.s === d.length) d.speed = 0;
  d.p = dollyPoint(d, d.s);
  d.v = dt > 0 ? d.p.map((v, i) => (v - before[i]) / dt) : [0, 0, 0];
  return d;
}
export const dollyQuat = d => quatFromYawPitch(d.yaw, d.pitch);

/**
 * Head (aim) driven by rates — the gamepad right stick or keyboard arrows in an aim pass.
 * Returns a new orientation: yaw about world up, pitch about the camera's own X.
 */
export function stepHead(q, input, dt, s = defaultFlightSettings()) {
  const { yaw, pitch } = yawPitchOf(q);
  return quatFromYawPitch(yaw - (input.yaw || 0) * s.yawRate * DEG * dt, clamp(pitch + (input.pitch || 0) * s.pitchRate * DEG * dt, -PITCH_LIMIT, PITCH_LIMIT));
}

// ---------- Takes ----------
/**
 * idle → armed (flying, not recording) → recording → done (take kept in memory).
 * cycle() is the A-button / R-key behaviour. Recording stops itself at maxDuration.
 */
export class TakeRecorder {
  constructor(maxDuration = MAX_TAKE) { this.maxDuration = maxDuration; this.state = 'idle'; this.samples = []; this.startedAt = 0; }
  arm() { if (this.state !== 'recording') this.state = 'armed'; return this.state; }
  start(now) { this.samples = []; this.startedAt = now; this.state = 'recording'; return this.state; }
  stop() { if (this.state === 'recording') this.state = this.samples.length > 1 ? 'done' : 'armed'; return this.state; }
  cancel() { this.state = 'idle'; return this.state; }
  cycle(now) { return this.state === 'recording' ? this.stop() : this.state === 'armed' ? this.start(now) : this.arm(); }
  /** Seconds into the current recording (0 when not recording). */
  elapsed(now) { return this.state === 'recording' ? Math.min(this.maxDuration, (now - this.startedAt) / 1000) : 0; }
  /** Add a sample at `now` (ms). Returns false once the take has auto-stopped. */
  push(now, sample) {
    if (this.state !== 'recording') return false;
    const t = (now - this.startedAt) / 1000;
    if (t >= this.maxDuration) {
      const last = this.samples.at(-1);
      if (!last || last.t < this.maxDuration) this.samples.push({ ...sample, t: this.maxDuration });
      this.stop(); return false;
    }
    if (this.samples.length && t <= this.samples.at(-1).t) return true;
    this.samples.push({ ...sample, t });
    return true;
  }
  get duration() { return this.samples.at(-1)?.t ?? 0; }
}

/** Pose of a sample track at time t: p lerped, q slerped, mm lerped. */
export function sampleTrack(samples, t) {
  if (!samples.length) return null;
  if (t <= samples[0].t) return { ...samples[0], t };
  const last = samples.at(-1);
  if (t >= last.t) return { ...last, t };
  let lo = 0, hi = samples.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (samples[mid].t <= t) lo = mid; else hi = mid; }
  const a = samples[lo], b = samples[hi], u = (t - a.t) / (b.t - a.t || 1);
  return {
    t,
    p: a.p.map((v, i) => v + (b.p[i] - v) * u),
    q: a.q && b.q ? quatSlerp(a.q, b.q, u) : a.q || b.q,
    mm: Number.isFinite(a.mm) && Number.isFinite(b.mm) ? a.mm + (b.mm - a.mm) * u : a.mm ?? b.mm,
  };
}

/**
 * One-euro deshake over recorded orientations, in time order. The cutoff opens
 * with angular speed, so holds lose tremor while whips stay sharp.
 */
export function smoothOrientations(samples, { minCutoff = 1.5, beta = 0.3 } = {}) {
  if (samples.length < 3) return samples;
  const alpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
  let q = samples[0].q, prev = samples[0].q, speed = 0;
  return samples.map((s, i) => {
    if (i === 0) return s;
    const dt = Math.max(1e-4, s.t - samples[i - 1].t);
    speed += alpha(1, dt) * (quatAngle(prev, s.q) / dt - speed);
    prev = s.q;
    q = quatSlerp(q, s.q, alpha(minCutoff + beta * speed, dt));
    return { ...s, q };
  });
}

/**
 * Aim pass merge: position from the position source (a recorded take or a
 * function of time, e.g. the shot's existing camera), orientation and lens from
 * the aim take, at the aim take's sample times.
 */
export function mergePasses(position, aim) {
  const at = typeof position === 'function' ? position : t => sampleTrack(position, t)?.p;
  return aim.map(s => ({ t: s.t, p: [...at(s.t)], q: s.q, mm: s.mm }));
}

/** Take length → shot duration (0.01 s steps, MIN_TAKE..MAX_TAKE). */
export const takeDuration = seconds => Math.round(clamp(seconds, MIN_TAKE, MAX_TAKE) * 100) / 100;

/**
 * Samples [{t, p, q, mm}] → at most maxKeys custom camera keys with linear timing.
 * Keys are chosen greedily where the playback error is worst (position in metres,
 * look point at lookDistance in metres, lens in mm) until every sample is within
 * tolerance. Key times are the recorded times, so playback keeps the take's pace.
 */
export function takeToKeys(samples, o = {}) {
  const { lookDistance = 8, posTolerance = 0.02, lookTolerance = 0.06, mmTolerance = 0.5, maxKeys = MAX_KEYS, smoothing = null, mm = 35 } = o;
  if (samples.length < 2) throw new Error('The take is empty — record a few moments of movement.');
  const t0 = samples[0].t;
  let src = samples.map(s => ({ ...s, t: s.t - t0 }));
  const length = src.at(-1).t;
  if (length < MIN_TAKE - 1e-6) throw new Error(`The take is too short (${length.toFixed(2)}s) — record at least ${MIN_TAKE}s.`);
  const duration = takeDuration(length);
  src = src.filter(s => s.t <= duration + 1e-6);
  if (smoothing) src = smoothOrientations(src, smoothing);
  const pts = src.map(s => {
    const f = forwardOf(quatNormalize(s.q));
    return { t: Math.min(1, s.t / duration), p: s.p, look: s.p.map((v, i) => v + f[i] * lookDistance), mm: Number.isFinite(s.mm) ? s.mm : mm };
  });
  const keep = [0, pts.length - 1];
  const errorAt = (i, a, b) => {
    const A = pts[a], B = pts[b], P = pts[i], u = B.t > A.t ? (P.t - A.t) / (B.t - A.t) : 0;
    const d = (x, y) => Math.hypot(...x.map((v, k) => A[y][k] + (B[y][k] - A[y][k]) * u - P[y][k]));
    return Math.max(d(P.p, 'p') / posTolerance, d(P.look, 'look') / lookTolerance, Math.abs(A.mm + (B.mm - A.mm) * u - P.mm) / mmTolerance);
  };
  while (keep.length < Math.min(maxKeys, pts.length)) {
    keep.sort((x, y) => x - y);
    let worst = -1, worstErr = 1;
    for (let k = 1; k < keep.length; k++) for (let i = keep[k - 1] + 1; i < keep[k]; i++) {
      const e = errorAt(i, keep[k - 1], keep[k]);
      if (e > worstErr) { worstErr = e; worst = i; }
    }
    if (worst < 0) break;
    keep.push(worst);
  }
  keep.sort((x, y) => x - y);
  const r = v => Math.round(v * 1000) / 1000;
  const keys = keep.map(i => ({ t: Math.round(pts[i].t * 10000) / 10000, p: pts[i].p.map(r), look: pts[i].look.map(r), mm: Math.round(pts[i].mm * 10) / 10 }));
  keys[keys.length - 1].t = 1;
  return { keys, duration };
}

/** Patch for update_shot that applies a take as the shot camera. */
export function takePatch(result) {
  return { duration: result.duration, camera: { move: 'custom', keys: result.keys, timing: 'linear', mm: result.keys[0].mm } };
}
