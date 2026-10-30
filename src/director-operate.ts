// Operate panel: fly the shot camera with keyboard or gamepad, record a position pass,
// then an aim pass (replaying that path in real time while aiming with mouse, gamepad
// or phone), and keep the take as custom camera keys in one undoable edit.
import './director-operate.css';
import './director-aim-sources';
import { h } from './director-common';
import { aimSources, createAimSource } from './director-aim';
import type { AimSource, Quat } from './director-aim';
import { isSeeded, pickPad, padsNow } from './director-aim-sources';
import { shotCameraAt } from '../shared/director.mjs';
import type { DirectorProject, Shot, Vec3 } from '../shared/director.mjs';
import type { UndoEntry } from '../shared/editor-controls.mjs';
import {
  TakeRecorder, ButtonEdges, BUTTON, LAYOUTS, MAX_TAKE, MIN_TAKE, createDrone, stepDrone, droneQuat, createDolly, stepDolly, dollyQuat, speedOf,
  padInput, padCentred, keyboardInput, noInput, defaultFlightSettings, defaultStickSettings, forwardOf, yawPitchOf, quatLookAt, alignYaw,
  sampleTrack, mergePasses, takeToKeys, takePatch,
} from '../shared/camera-operate.mjs';
import type { FlightInput, FlightSettings, Layout, TakeSample, Drone, Dolly } from '../shared/camera-operate.mjs';

// The phone link registers a 'phone' aim source when its module exists (built in another branch).
const phoneModule = import.meta.glob('./director-phone.ts', { eager: true })['./director-phone.ts'] as { setPhoneRig?: (r: { recording?: boolean }) => void } | undefined;
// Keep the phone's Record button in step with the take (it shows Recording / Record shot).
let phoneRec = false;
const tellPhone = (rec: boolean) => { if (rec !== phoneRec) { phoneRec = rec; phoneModule?.setPhoneRig?.({ recording: rec }); } };

type Pose = { p: Vec3; look: Vec3; mm: number };
export type OperateHost = {
  scene: { setLivePose(p: Pose | null): void; setView(v: 'set' | 'camera'): void };
  viewport: HTMLElement;
  project(): DirectorProject;
  shot(): Shot;
  /** Move the editor playhead (shot time) so animated objects follow the take. */
  setPlayhead(t: number): void;
  setView(v: 'set' | 'camera'): void;
  runEntry(entry: UndoEntry): Promise<boolean>;
  toast(text: string, error?: boolean): void;
};

type Pass = 'position' | 'aim';
type Phase = 'off' | 'live' | 'review';
const LOOK = 8; // metres ahead for look points
const store = (k: string, d: string) => localStorage.getItem('previs.operate.' + k) ?? d;
const save = (k: string, v: string) => localStorage.setItem('previs.operate.' + k, v);

let host: OperateHost;
const opts = {
  pass: store('pass', 'position') as Pass,
  source: store('source', 'keyboard'), // position pass: keyboard | gamepad. aim pass: pointer | gamepad | any registered id
  aim: store('aim', 'pointer'),
  mode: store('mode', 'drone') as 'drone' | 'dolly',
  layout: store('layout', 'game') as Layout,
  deshake: store('deshake', '1') === '1',
  flight: { ...defaultFlightSettings(), ...JSON.parse(store('flight', '{}')) } as FlightSettings,
};
const stick = defaultStickSettings();
const kids = (...n: (Node | null)[]) => n.filter((x): x is Node => !!x);

// Takes live per shot until kept or discarded.
let takeShot = '';
let positionTake: TakeSample[] | null = null;
let aimTake: TakeSample[] | null = null;
let reviewing: Pass | null = null;

let phase: Phase = 'off';
const recorder = new TakeRecorder(MAX_TAKE);
let rig: Drone | Dolly | null = null;
let aim: AimSource | null = null, aimOff: (() => void) | null = null, yawFix = 0;
let replayLength = 0; // aim pass: length of the path being replayed
let padArmed = false;
let lastP: Vec3 | null = null, replaySpeed = 0;
let last = 0, reviewStart = 0, raf = 0;
const edges = new ButtonEdges();
const down = new Set<string>();

// ---------- DOM ----------
const panel = h('div', { class: 'block op-panel' });
const hud = h('div', { class: 'op-hud', hidden: true, role: 'status' });
const padStatus = h('div', { class: 'op-pad' });
const recBtn = h('button', { class: 'btn camera sm', type: 'button' });
const releaseBtn = h('button', { class: 'btn sm ghost', type: 'button', title: 'Stop operating (B / Esc)' }, 'Release');
const takeRow = h('div', { class: 'op-take' });
const sourceSel = h('select', { class: 'field', 'aria-label': 'Operate source' });
const passSeg = h('div', { class: 'seg op-pass', role: 'radiogroup', 'aria-label': 'Pass' });

function select<T extends string>(label: string, value: T, options: [T, string][], onChange: (v: T) => void) {
  const el = h('select', { class: 'field', 'aria-label': label }, ...options.map(([k, v]) => h('option', { value: k, selected: k === value }, v)));
  el.onchange = () => onChange(el.value as T);
  return h('label', {}, label, el);
}
function slider(label: string, key: keyof FlightSettings, min: number, max: number, step: number, unit: string) {
  const out = h('output', {}, `${opts.flight[key]}${unit}`);
  const input = h('input', { type: 'range', min, max, step, value: opts.flight[key], 'aria-label': label });
  input.oninput = () => { opts.flight[key] = Number(input.value); out.textContent = `${input.value}${unit}`; save('flight', JSON.stringify(opts.flight)); };
  return h('div', { class: 'slider-row' }, label, input, out);
}

function buildPanel() {
  const passBtn = (p: Pass, text: string, tip: string) => h('button', { type: 'button', role: 'radio', class: opts.pass === p ? 'on' : '', 'aria-checked': String(opts.pass === p), title: tip, onclick: () => { if (phase === 'live') release(); opts.pass = p; save('pass', p); buildPanel(); } }, text);
  passSeg.replaceChildren(
    passBtn('position', '1 · Position pass', 'Fly the path (position + heading)'),
    passBtn('aim', '2 · Aim pass', 'Replay the path in real time and aim the camera'));
  const sources: [string, string][] = opts.pass === 'position'
    ? [['keyboard', 'Keyboard'], ['gamepad', 'Gamepad']]
    : aimSources().map(id => [id, id === 'pointer' ? 'Mouse + keys' : id === 'gamepad' ? 'Gamepad' : id === 'phone' ? 'Phone' : id] as [string, string]);
  const current = opts.pass === 'position' ? opts.source : opts.aim;
  sourceSel.replaceChildren(...sources.map(([k, v]) => h('option', { value: k, selected: k === current }, v)));
  sourceSel.onchange = () => { if (phase === 'live') release(); if (opts.pass === 'position') save('source', opts.source = sourceSel.value); else save('aim', opts.aim = sourceSel.value); buildPanel(); };
  const s = host.shot();
  const pathNote = opts.pass === 'aim'
    ? h('p', { class: 'note op-note' }, positionTake && takeShot === s.id ? `Replays your position take (${positionTake.at(-1)!.t.toFixed(2)}s) while you aim.` : `No position take yet — replays the shot's current camera path (${s.duration}s) while you aim.`)
    : h('p', { class: 'note op-note' }, opts.mode === 'drone' ? 'Free flight from the shot camera’s first frame. Heading becomes the aim; an aim pass can replace it.' : 'Rides the shot’s current camera path; forward/back sets speed, yaw/pitch aim.');
  panel.replaceChildren(...kids(
    h('div', { class: 'block-head' }, h('span', { class: 'eyebrow' }, 'Operate'), h('span', { class: 'muted op-sub' }, 'Fly or aim the shot camera live')),
    passSeg,
    h('div', { class: 'grid2' },
      h('label', {}, opts.pass === 'position' ? 'Fly with' : 'Aim with', sourceSel),
      opts.pass === 'position'
        ? select('Mode', opts.mode, [['drone', 'Drone free flight'], ['dolly', 'Dolly on path']], v => { opts.mode = v; save('mode', v); buildPanel(); })
        : h('label', { class: 'check-row op-check' }, h('input', { type: 'checkbox', checked: opts.deshake, onchange: (ev: Event) => { opts.deshake = (ev.target as HTMLInputElement).checked; save('deshake', opts.deshake ? '1' : '0'); } }), 'Deshake aim')),
    opts.pass === 'position' && opts.source === 'gamepad' ? h('div', { class: 'grid2' }, select('Stick layout', opts.layout, Object.entries(LAYOUTS) as [Layout, string][], v => { opts.layout = v; save('layout', v); buildPanel(); }), h('span')) : null,
    padStatus,
    opts.pass === 'position' ? h('details', { class: 'op-tune' }, h('summary', {}, 'Speeds'),
      slider('Speed', 'maxSpeed', 0.5, 20, 0.5, ' m/s'),
      slider('Climb', 'climbSpeed', 0.5, 10, 0.5, ' m/s'),
      slider('Turn', 'yawRate', 15, 180, 5, '°/s'),
      slider('Tilt', 'pitchRate', 10, 120, 5, '°/s'),
      slider('Ease', 'response', 0.05, 1.5, 0.05, ' s')) : null,
    pathNote,
    h('div', { class: 'op-actions' }, recBtn, releaseBtn),
    takeRow));
  refresh();
}

function keyHelp(): string {
  const src = opts.pass === 'position' ? opts.source : opts.aim;
  if (src === 'gamepad') return opts.pass === 'position'
    ? `A arm → record → stop · B release · X level · LB slow · RB fast · ${opts.layout === 'game' ? 'LS move · RS look · RT/LT up/down' : 'LS yaw/climb · RS move · D-pad tilt'}`
    : 'Right stick aims · A arm → record → stop · B release · X re-zero';
  if (opts.pass === 'position') return 'W/S forward · A/D strafe · Q/E turn · Space/Shift up/down · ↑↓ tilt · Alt slow · R record · Esc release';
  if (src === 'pointer') return 'Drag to aim · arrows / Q E turn · R record · Esc release';
  return 'R record · Esc release';
}

function padText(): string {
  const pads = padsNow();
  if (!pads.length) return 'No gamepad detected — connect one and press any button.';
  const p = pickPad()!;
  return `${p.id.replace(/\s*\(.*?Vendor.*?\)/i, '').slice(0, 48)} · ${p.mapping === 'standard' ? 'standard mapping' : 'unmapped — buttons may differ'}${pads.length > 1 ? ` · ${pads.length} pads` : ''}`;
}

const listeners = new Set<() => void>();
function refresh() {
  for (const f of listeners) f();
  const s = host.shot();
  if (takeShot !== s.id) { positionTake = aimTake = null; reviewing = null; takeShot = s.id; }
  const src = opts.pass === 'position' ? opts.source : opts.aim;
  const needsPad = src === 'gamepad';
  padStatus.hidden = !needsPad && !pickPad();
  padStatus.textContent = (aim && phase === 'live' && src !== 'gamepad' ? aim.status() + ' · ' : '') + padText();
  padStatus.classList.toggle('ok', !!pickPad());
  const state = phase === 'live' ? recorder.state : 'idle';
  recBtn.textContent = state === 'recording' ? '■ Stop' : state === 'armed' ? '● Record' : opts.pass === 'position' ? 'Arm · fly' : 'Arm · aim';
  recBtn.title = `${state === 'recording' ? 'Stop recording' : state === 'armed' ? 'Start recording' : 'Take control of the shot camera'} (${src === 'gamepad' ? 'A' : 'R'})`;
  recBtn.classList.toggle('rec', state === 'recording');
  releaseBtn.hidden = phase !== 'live';
  recBtn.onclick = () => { (recBtn as HTMLButtonElement).blur(); cycle(); };
  const take = reviewing === 'aim' ? aimTake : reviewing === 'position' ? positionTake : null;
  if (take && phase !== 'live') {
    const len = take.at(-1)!.t;
    takeRow.replaceChildren(
      h('span', { class: 'op-take-label' }, `${reviewing === 'aim' ? 'Aim' : 'Position'} take · ${len.toFixed(2)}s · ${take.length} samples`),
      h('button', { class: 'btn sm', type: 'button', onclick: () => playTake() }, phase === 'review' ? '↺ Replay' : '▶ Play take'),
      h('button', { class: 'btn sm primary', type: 'button', disabled: len < MIN_TAKE, title: len < MIN_TAKE ? `Takes need at least ${MIN_TAKE}s` : 'Apply as the shot camera (undoable)', onclick: () => void keep() }, 'Keep take'),
      h('button', { class: 'btn sm ghost', type: 'button', onclick: () => discard() }, 'Discard'));
    takeRow.hidden = false;
  } else { takeRow.replaceChildren(); takeRow.hidden = true; }
}

// ---------- Rig / pose ----------
function shotPose(t: number): Pose { const p = host.project(); return shotCameraAt(host.shot(), p.scene.entities, t); }
function positionAt(t: number): Vec3 {
  return positionTake && takeShot === host.shot().id ? sampleTrack(positionTake, t)!.p : shotPose(t).p;
}
/** Orientation at the start of the path being flown or replayed. */
function startAim(): Quat {
  if (opts.pass === 'aim' && positionTake && takeShot === host.shot().id) return positionTake[0].q;
  const start = shotPose(0); return quatLookAt(start.p, start.look);
}
const lookFrom = (p: Vec3, q: Quat): Vec3 => { const f = forwardOf(q); return p.map((v, i) => v + f[i] * LOOK) as Vec3; };

function engage() {
  const s = host.shot();
  host.setPlayhead(0);
  host.setView('camera');
  (document.activeElement as HTMLElement | null)?.blur?.();
  const start = shotPose(0), q0 = startAim(), { yaw, pitch } = yawPitchOf(q0);
  rig = null; disposeAim();
  if (opts.pass === 'position') {
    if (opts.mode === 'drone') rig = createDrone(start.p, yaw, pitch);
    else rig = createDolly(Array.from({ length: 65 }, (_, i) => shotPose((i / 64) * s.duration).p), yaw, pitch);
  } else {
    replayLength = Math.min(MAX_TAKE, positionTake && takeShot === s.id ? positionTake.at(-1)!.t : s.duration);
    aim = createAimSource(opts.aim) ?? createAimSource('pointer')!;
    if (isSeeded(aim)) { aim.seed(q0); yawFix = 0; }
    else { aim.rezero?.(); const q = aim.orientation(); yawFix = q ? yaw - yawPitchOf(q).yaw : 0; }
    aimOff = aim.onButton?.(b => (b === 'record' ? cycle() : rezero())) ?? null;
  }
  padArmed = false; edges.reset(); down.clear(); lastP = null; replaySpeed = 0;
  recorder.arm(); phase = 'live'; reviewing = null;
  hud.hidden = false;
  last = performance.now();
  loopStart();
}

function release() {
  if (recorder.state === 'recording') recorder.stop();
  tellPhone(false);
  if (recorder.state === 'done') finishTake(); else recorder.cancel();
  phase = reviewing ? phase : 'off';
  if (phase === 'off') { hud.hidden = true; host.scene.setLivePose(null); host.setPlayhead(0); }
  disposeAim(); rig = null; down.clear();
  refresh();
}
function disposeAim() { aimOff?.(); aimOff = null; aim?.dispose(); aim = null; }

function rezero() {
  if (opts.pass === 'aim' && aim) {
    const q0 = startAim();
    if (isSeeded(aim)) aim.seed(q0); else { aim.rezero?.(); const q = aim.orientation(); yawFix = q ? yawPitchOf(q0).yaw - yawPitchOf(q).yaw : 0; }
  } else if (rig) rig.pitch = 0;
}

function cycle() {
  if (phase !== 'live') { engage(); return; }
  const now = performance.now();
  const before = recorder.state;
  recorder.cycle(now);
  if (before === 'armed' && recorder.state === 'recording') host.setPlayhead(0);
  if (recorder.state === 'done') { finishTake(); return; }
  refresh();
}

function finishTake() {
  tellPhone(false);
  let samples = recorder.samples.slice();
  recorder.cancel();
  // An aim take ends exactly where the replayed path ends.
  if (opts.pass === 'aim' && samples.length && samples.at(-1)!.t > replayLength) {
    const lastQ = samples.at(-1)!;
    samples = [...samples.filter(x => x.t < replayLength), { ...lastQ, t: replayLength }];
  }
  if (opts.pass === 'position') positionTake = samples; else aimTake = samples;
  takeShot = host.shot().id;
  reviewing = opts.pass;
  disposeAim(); rig = null;
  playTake();
}

/** Samples of the take under review, merged with the position pass for an aim take. */
function reviewSamples(): TakeSample[] | null {
  if (reviewing === 'position') return positionTake;
  if (reviewing === 'aim' && aimTake) return positionTake ? mergePasses(positionTake, aimTake) : mergePasses(t => shotPose(t).p, aimTake);
  return null;
}

function playTake() {
  if (!reviewSamples()) return;
  host.setView('camera');
  phase = 'review'; hud.hidden = false; reviewStart = performance.now();
  loopStart(); refresh();
}

function discard() {
  if (reviewing === 'aim') aimTake = null; else positionTake = null;
  reviewing = null; phase = 'off'; hud.hidden = true;
  host.scene.setLivePose(null); host.setPlayhead(0); refresh(); buildPanel();
}

async function keep() {
  const samples = reviewSamples(); if (!samples) return;
  const s = host.shot();
  let result;
  try { result = takeToKeys(samples, { smoothing: reviewing === 'aim' && opts.deshake ? { minCutoff: 1.5, beta: 0.3 } : null, mm: s.camera.mm }); }
  catch (e) { host.toast((e as Error).message, true); return; }
  const before = s.camera;
  const which = reviewing;
  phase = 'off'; hud.hidden = true; host.scene.setLivePose(null); host.setPlayhead(0);
  const ok = await host.runEntry({
    label: which === 'aim' ? 'Aim pass' : 'Camera take',
    redo: [{ op: 'update_shot', id: s.id, patch: takePatch(result) }],
    undo: [{ op: 'update_shot', id: s.id, patch: { duration: s.duration, camera: { ...before, timing: before.timing ?? 'ease' } } }],
  });
  if (ok) {
    host.toast(`Kept ${which} take · ${result.keys.length} keys · ${result.duration}s`);
    if (which === 'aim') aimTake = null;
    reviewing = null;
  }
  buildPanel();
}

// ---------- Frame loop ----------
function loopStart() { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } }

function readInput(): { input: FlightInput; buttons: number[] } {
  const src = opts.pass === 'position' ? opts.source : opts.aim;
  const pad = pickPad();
  const buttons = pad ? edges.read(`${pad.index}:${pad.id}`, pad.buttons.map(b => b.pressed)) : (edges.reset(), []);
  if (src === 'gamepad' && pad) {
    if (!padArmed) { padArmed = padCentred(pad, stick); if (!padArmed) return { input: noInput(), buttons }; }
    return { input: padInput(pad, opts.layout, stick), buttons };
  }
  return { input: keyboardInput(down), buttons };
}

function frame(now: number) {
  raf = 0;
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (phase === 'live') liveFrame(now, dt);
  else if (phase === 'review') reviewFrame(now);
  if (phase !== 'off' && !raf) raf = requestAnimationFrame(frame);
}

function liveFrame(now: number, dt: number) {
  const { input, buttons } = readInput();
  if (buttons.includes(BUTTON.A)) { cycle(); if (phase !== 'live') return; }
  if (buttons.includes(BUTTON.B)) { release(); return; }
  if (buttons.includes(BUTTON.X)) rezero();
  const s = host.shot();
  const recording = recorder.state === 'recording';
  tellPhone(recording);
  const t = recording ? recorder.elapsed(now) : 0;
  let p: Vec3, q: Quat;
  if (opts.pass === 'position' && rig) {
    if ('points' in rig) { stepDolly(rig, input, dt, opts.flight); q = dollyQuat(rig); }
    else { stepDrone(rig, input, dt, opts.flight); q = droneQuat(rig); }
    p = [...rig.p] as Vec3;
  } else {
    p = positionAt(Math.min(t, replayLength));
    const src = aim!;
    if (isSeeded(src) && src.nudge && opts.aim !== 'gamepad') src.nudge(input.yaw, input.pitch, dt);
    const raw = src.orientation();
    q = raw ? (yawFix ? alignYaw(raw, yawPitchOf(raw).yaw + yawFix) : raw) : quatLookAt(p, shotPose(t).look);
  }
  const mm = aim?.lensMm?.() ?? s.camera.mm;
  if (recording) {
    const more = recorder.push(now, { p, q, mm }) && !(opts.pass === 'aim' && t >= replayLength);
    host.setPlayhead(t);
    if (!more) { if (recorder.state === 'recording') recorder.stop(); if (recorder.state === 'done') { finishTake(); return; } }
  }
  if (!rig && lastP && dt > 0) replaySpeed += (Math.hypot(...p.map((v, i) => v - lastP![i])) / dt - replaySpeed) * 0.2;
  lastP = p;
  host.scene.setLivePose({ p, look: lookFrom(p, q), mm });
  drawHud(t, p, rig ? speedOf(rig) : replaySpeed);
  if (Math.floor(now / 250) !== Math.floor((now - dt * 1000) / 250)) refresh();
}

function reviewFrame(now: number) {
  const samples = reviewSamples();
  if (!samples) { phase = 'off'; return; }
  const len = samples.at(-1)!.t, t = Math.min(len, (now - reviewStart) / 1000);
  const a = sampleTrack(samples, t)!;
  host.scene.setLivePose({ p: a.p, look: lookFrom(a.p, a.q), mm: a.mm });
  host.setPlayhead(t);
  drawHud(t, a.p, 0);
  if (t >= len) { phase = 'off'; hud.hidden = true; host.scene.setLivePose(null); host.setPlayhead(0); refresh(); }
}

function drawHud(t: number, p: Vec3, speed: number) {
  const state = phase === 'review' ? 'PLAYBACK' : recorder.state === 'recording' ? 'REC' : 'ARMED';
  const limit = opts.pass === 'aim' ? replayLength : MAX_TAKE;
  hud.className = 'op-hud ' + state.toLowerCase();
  hud.replaceChildren(...kids(
    h('div', { class: 'op-hud-row' },
      h('span', { class: 'op-state' }, h('i'), state),
      h('span', { class: 'op-time' }, `${t.toFixed(2)} / ${(phase === 'review' ? t : limit).toFixed(2)}s`),
      h('span', {}, `${opts.pass === 'position' ? (opts.mode === 'drone' ? 'DRONE' : 'DOLLY') : 'AIM'}`)),
    h('div', { class: 'op-hud-row' },
      h('span', {}, `SPD ${speed.toFixed(1)} m/s`),
      h('span', {}, `ALT ${p[1].toFixed(1)} m`),
      h('span', {}, `SHOT ${host.shot().duration.toFixed(2)}s`)),
    h('div', { class: 'op-hud-bar' }, h('i', { style: `width:${Math.min(100, (t / Math.max(0.01, limit)) * 100)}%` })),
    phase === 'live' ? h('div', { class: 'op-hud-help' }, keyHelp()) : null));
}

// ---------- Keyboard claim ----------
// While live, every unmodified key goes to the operator so editor shortcuts (G/R/S/X…) never fire.
function onKey(ev: KeyboardEvent) {
  if (phase === 'off' || ev.ctrlKey || ev.metaKey) return;
  const t = ev.target as HTMLElement;
  if (t?.closest?.('input:not([type=range]):not([type=checkbox]), textarea, select, [contenteditable="true"]')) return;
  if (phase === 'review') { if (ev.type === 'keydown' && ev.key === 'Escape') { ev.preventDefault(); ev.stopImmediatePropagation(); discardPlayback(); } return; }
  if (ev.key === 'Tab') return;
  ev.preventDefault(); ev.stopImmediatePropagation();
  if (ev.type === 'keyup') { down.delete(ev.code); return; }
  if (ev.repeat) return;
  if (ev.code === 'Escape') { release(); return; }
  if (ev.code === 'KeyR') { cycle(); return; }
  down.add(ev.code);
}
function discardPlayback() { phase = 'off'; hud.hidden = true; host.scene.setLivePose(null); host.setPlayhead(0); refresh(); }

/** Call once from the workspace. */
export function initOperate(h0: OperateHost) {
  host = h0;
  host.viewport.append(hud);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);
  window.addEventListener('blur', () => down.clear());
  // While operating, viewport drags aim (pointer source) or do nothing — never orbit or pick.
  window.addEventListener('pointerdown', ev => { if (phase !== 'off' && (ev.target as HTMLElement)?.matches?.('canvas.main')) { ev.stopPropagation(); ev.preventDefault(); } }, true);
  window.addEventListener('gamepadconnected', () => refresh());
  window.addEventListener('gamepaddisconnected', () => refresh());
  // Idle polling keeps the controller status fresh (Chrome only reveals pads after a button press);
  // the gamepad's A button arms from idle, so a take can start without touching the mouse.
  setInterval(() => {
    if (!panel.isConnected) return;
    if (phase === 'off') {
      const src = opts.pass === 'position' ? opts.source : opts.aim, pad = pickPad();
      if (pad && src === 'gamepad') { const b = edges.read(`${pad.index}:${pad.id}`, pad.buttons.map(x => x.pressed)); if (b.includes(BUTTON.A)) engage(); }
      refresh();
    }
  }, 120);
}

/** The Operate block for the Shot tab. Returns the same element every render so live state survives. */
export function operateBlock(_shot: Shot): HTMLElement {
  if (phase === 'off') buildPanel(); else refresh();
  return panel;
}

export type FlyDevice = 'keyboard' | 'gamepad' | 'phone';
/** The transport's hero "Fly camera" button drives the same Operate flow as the panel. */
export const fly = {
  /** Take the shot camera with a device: keyboard/gamepad fly a position pass, phone aims along the shot's path. */
  start(device: FlyDevice) {
    if (phase === 'live') { release(); return; }
    if (device === 'phone') { opts.pass = 'aim'; save('pass', 'aim'); opts.aim = 'phone'; save('aim', 'phone'); }
    else { opts.pass = 'position'; save('pass', 'position'); opts.source = device; save('source', device); }
    buildPanel(); engage(); refresh();
  },
  /** Choose the device without taking control (a gamepad's A then arms from idle). */
  setDevice(device: FlyDevice) {
    if (phase === 'live') return;
    if (device === 'phone') { opts.pass = 'aim'; save('pass', 'aim'); opts.aim = 'phone'; save('aim', 'phone'); }
    else { opts.pass = 'position'; save('pass', 'position'); opts.source = device; save('source', device); }
    buildPanel();
  },
  cycle() { cycle(); },
  release() { release(); },
  state: () => ({ phase, rec: phase === 'live' ? recorder.state : 'idle', device: (opts.pass === 'aim' ? opts.aim : opts.source) as string, pad: !!pickPad(), help: keyHelp() }),
  onChange(f: () => void) { listeners.add(f); },
};

/** Test hook for browser checks: current operate state. */
(window as any).__operate = { state: () => ({ phase, recorder: recorder.state, pass: opts.pass, positionTake: positionTake?.length ?? 0, aimTake: aimTake?.length ?? 0, reviewing }) };
