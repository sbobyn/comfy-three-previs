import { installPrevisCamera } from "./previs-camera";
import * as THREE from "three";
import { element } from "./dom";
import { createStudio } from "./scene";
import { horizontalFov, mmToSlider, sliderToMm } from "./lens";
import { relayUrl, type ViewerInbound, type ViewerMessage } from "./protocol";
import { OrientationSmoother, defaultSettings } from "./smoothing";
import { Take } from "./take";
import { addFlownDemo, demoById, demos, type Demo, type FlightSample } from "./demos";
import { defaultFlightSettings, Drone, type FlightInput, type FlightSettings } from "./flight";
import { activeGamepad, defaultStickSettings, readGamepad, type StickSettings } from "./gamepad";

const canvas = element<HTMLCanvasElement>("scene");
const fields = {
  source: element("source"),
  link: element("link"),
  rate: element("rate"),
  latency: element("latency"),
  jitter: element("jitter"),
  yaw: element("yaw"),
  drift: element("drift"),
  speed: element("speed"),
  altitude: element("altitude"),
  lag: element("lag"),
  takeCount: element("takeCount"),
  takeDuration: element("takeDuration"),
};
const markButton = element<HTMLButtonElement>("mark");
const kickButton = element<HTMLButtonElement>("kick");
const recordButton = element<HTMLButtonElement>("record");
const playButton = element<HTMLButtonElement>("play");
const loopToggle = element<HTMLInputElement>("loop");
const ghostToggle = element<HTMLInputElement>("showGhost");
const demoSelect = element<HTMLSelectElement>("demo");
const shotPlayButton = element<HTMLButtonElement>("shotPlay");
const scrub = element<HTMLInputElement>("scrub");
const scrubValue = element("scrubValue");
const shotDuration = element<HTMLInputElement>("shotDuration");
const shotDurationValue = element("shotDurationValue");
const shotLoop = element<HTMLInputElement>("shotLoop");
const focalSlider = element<HTMLInputElement>("focal");
const focalValue = element("focalValue");
const formatSelect = element<HTMLSelectElement>("format");
const lensPresets = element("lensPresets");
const flightRecordButton = element<HTMLButtonElement>("flightRecord");
const flightInfo = element("flightInfo");
const padInfo = element("padInfo");
const aimSourceSelect = element<HTMLSelectElement>("aimSource");
const mouseSens = element<HTMLInputElement>("mouseSens");
const mouseSensValue = element("mouseSensValue");
const cameraPane = element("cameraPane");

const studio = createStudio(canvas, element("worldPane"));
const updatePrevisCamera = installPrevisCamera(studio, (pose) => {
  stopPlayback(); pauseShot(); demoSelect.value = "locked"; applyDemo(demoById("locked"));
  raw.fromArray(pose.q); smoothed.copy(raw); smoother.reset(raw);
  const rotation = new THREE.Euler().setFromQuaternion(raw, "YXZ");
  mousePitch = THREE.MathUtils.radToDeg(rotation.x); mouseYaw = THREE.MathUtils.radToDeg(rotation.y); mouseRoll = rotation.z;
  aimSourceSelect.value = "mouse"; syncAimSource();
  studio.setCameraPosition(new THREE.Vector3().fromArray(pose.p));
  studio.pov.quaternion.copy(raw); studio.rawPov.quaternion.copy(raw);
  focalCurrent = pose.mm; setFocalTarget(pose.mm, true); studio.setFocalLength(pose.mm);
});
const smoother = new OrientationSmoother();
const settings = defaultSettings();
const take = new Take();

const raw = new THREE.Quaternion();
const smoothed = new THREE.Quaternion();
const aim = new THREE.Quaternion();

const drone = new Drone();
const flight = defaultFlightSettings();
const sticks = defaultStickSettings();
const heldKeys = new Set<string>();
const PILOT_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "Space", "ShiftLeft"]);

function isPiloting(): boolean {
  return demo.id === "pilot";
}

/** Non-null while a flight is being recorded. */
let flightSamples: FlightSample[] | null = null;
let flightStartedAt = 0;

let mouseYaw = 0;
let mousePitch = 0;
let mouseRoll = 0;
let dragging = false;
let lastPointerX = 0;
let lastPointerY = 0;

const usingMouseAim = (): boolean => aimSourceSelect.value === "mouse";
/** True when aiming is driven here rather than by the device's own sensor. */
const desktopOwnsAim = (): boolean => isPiloting() || usingMouseAim();

function syncAimSource(): void {
  cameraPane.classList.toggle("aiming", usingMouseAim());
}
aimSourceSelect.value = "mouse";
aimSourceSelect.addEventListener("change", syncAimSource);
syncAimSource();

mouseSens.addEventListener("input", () => {
  mouseSensValue.textContent = Number(mouseSens.value).toFixed(2);
});

// Dragged like a stick rather than like the image: pulling right pans right, so
// the control matches the phone it stands in for.
cameraPane.addEventListener("pointerdown", (event) => {
  dragging = true;
  lastPointerX = event.clientX;
  lastPointerY = event.clientY;
  cameraPane.setPointerCapture(event.pointerId);
});
cameraPane.addEventListener("pointermove", (event) => {
  if (!dragging) return;
  const sensitivity = Number(mouseSens.value);
  mouseYaw -= (event.clientX - lastPointerX) * sensitivity;
  mousePitch = Math.min(
    85,
    Math.max(-85, mousePitch - (event.clientY - lastPointerY) * sensitivity),
  );
  lastPointerX = event.clientX;
  lastPointerY = event.clientY;
});
const endDrag = (): void => {
  dragging = false;
};
cameraPane.addEventListener("pointerup", endDrag);
cameraPane.addEventListener("pointercancel", endDrag);
const euler = new THREE.Euler();

let socket: WebSocket | null = null;
let arrivals: number[] = [];
let intervals: number[] = [];
let lastArrival = 0;
let lastFrame = performance.now();
let halfRtt = Number.NaN;
let yawDeg = Number.NaN;
let markYaw = Number.NaN;
let markAt = 0;
let playingFrom = Number.NaN;
let demo: Demo = demos[0];
let dollyU = 0;
let dollyPlaying = false;
let controllerPresent = false;
let focalTarget = -1;
let focalCurrent = 35;

let nextPingId = 0;
const pendingPings = new Map<number, number>();

function bindSlider(id: keyof typeof settings, format: (value: number) => string): void {
  const input = element<HTMLInputElement>(id);
  const readout = element(`${id}Value`);
  const sync = (): void => {
    const value = Number(input.value);
    (settings[id] as number) = value;
    readout.textContent = format(value);
  };
  input.addEventListener("input", sync);
  sync();
}

function bindToggle(id: keyof typeof settings): void {
  const input = element<HTMLInputElement>(id);
  const sync = (): void => {
    (settings[id] as boolean) = input.checked;
  };
  input.addEventListener("change", sync);
  sync();
}

function bindFlight(id: keyof FlightSettings, format: (value: number) => string): void {
  const input = element<HTMLInputElement>(id);
  const readout = element(`${id}Value`);
  const sync = (): void => {
    const value = Number(input.value);
    (flight[id] as number) = value;
    readout.textContent = format(value);
  };
  input.addEventListener("input", sync);
  sync();
}

function bindSticks(id: keyof StickSettings, format: (value: number) => string): void {
  const input = element<HTMLInputElement>(id);
  const readout = element(`${id}Value`);
  const sync = (): void => {
    const value = Number(input.value);
    (sticks[id] as number) = value;
    readout.textContent = format(value);
  };
  input.addEventListener("input", sync);
  sync();
}

bindSticks("deadzone", (v) => v.toFixed(2));
bindSticks("expo", (v) => v.toFixed(2));

bindFlight("maxSpeed", (v) => `${v.toFixed(0)} m/s`);
bindFlight("climbSpeed", (v) => `${v.toFixed(0)} m/s`);
bindFlight("responseTime", (v) => `${Math.round(v * 1000)} ms`);
bindFlight("yawRate", (v) => `${v.toFixed(0)}°/s`);
bindFlight("bank", (v) => `${v.toFixed(0)}°`);
bindFlight("tilt", (v) => `${v.toFixed(0)}°`);

// Keys are tracked rather than acted on directly, so several can be held at
// once and a stuck key cannot survive the window losing focus.
const typingInto = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName);

window.addEventListener("keydown", (event) => {
  if (typingInto(event.target)) return;
  heldKeys.add(event.code);
  if (isPiloting() && PILOT_KEYS.has(event.code)) event.preventDefault();
});
window.addEventListener("keyup", (event) => heldKeys.delete(event.code));
window.addEventListener("blur", () => heldKeys.clear());

const clampAxis = (value: number): number => Math.min(1, Math.max(-1, value));

/** Keys and sticks sum, so either can fly and neither locks the other out. */
function readFlightInput(): FlightInput {
  const axis = (positive: string, negative: string): number =>
    (heldKeys.has(positive) ? 1 : 0) - (heldKeys.has(negative) ? 1 : 0);

  const keyboard: FlightInput = {
    forward: axis("KeyW", "KeyS"),
    lateral: axis("KeyD", "KeyA"),
    vertical: axis("Space", "ShiftLeft"),
    yaw: axis("KeyE", "KeyQ"),
  };

  const pad = readGamepad(sticks);
  if (!pad) return keyboard;
  return {
    forward: clampAxis(keyboard.forward + pad.forward),
    lateral: clampAxis(keyboard.lateral + pad.lateral),
    vertical: clampAxis(keyboard.vertical + pad.vertical),
    yaw: clampAxis(keyboard.yaw + pad.yaw),
  };
}

bindSlider("minCutoff", (v) => `${v.toFixed(2)} Hz`);
bindSlider("beta", (v) => v.toFixed(3));
bindSlider("halfLife", (v) => `${Math.round(v * 1000)} ms`);
bindToggle("deshake");
bindToggle("inertia");

/** Whoever moved the lens last wins — the phone, the desktop, or a take. */
function setFocalTarget(mm: number, syncSlider: boolean): void {
  if (mm === focalTarget) return;
  focalTarget = mm;
  focalValue.textContent = `${mm} mm · ${horizontalFov(mm).toFixed(0)}°`;
  lensPresets.querySelectorAll<HTMLButtonElement>("button").forEach((preset) => {
    preset.classList.toggle("active", Number(preset.dataset.mm) === mm);
  });
  if (syncSlider) focalSlider.value = String(mmToSlider(mm));
}

focalSlider.addEventListener("input", () => {
  setFocalTarget(sliderToMm(Number(focalSlider.value)), false);
});

lensPresets.addEventListener("click", (event) => {
  const mm = Number((event.target as HTMLElement).dataset.mm);
  if (mm) setFocalTarget(mm, true);
});

formatSelect.addEventListener("change", () => {
  studio.setFormat(formatSelect.value === "fill" ? null : Number(formatSelect.value));
});

setFocalTarget(sliderToMm(Number(focalSlider.value)), false);

for (const entry of demos) {
  const option = document.createElement("option");
  option.value = entry.id;
  option.textContent = entry.label;
  demoSelect.append(option);
}

function setDolly(u: number): void {
  dollyU = Math.min(1, Math.max(0, u));
  studio.setDollyProgress(dollyU);
  scrub.value = String(dollyU);
  scrubValue.textContent = dollyU.toFixed(2);
}

function pauseShot(): void {
  dollyPlaying = false;
  shotPlayButton.textContent = "Play";
}

function applyDemo(next: Demo): void {
  demo = next;
  studio.setDemo(demo);
  pauseShot();
  const movable = demo.path !== null;
  shotPlayButton.disabled = !movable;
  scrub.disabled = !movable;
  flightRecordButton.disabled = !isPiloting();
  if (movable) {
    // Defaults to the recorded length so a flown move replays at the speed it
    // was flown; changing it afterwards is a deliberate retime.
    const seconds = Math.min(60, Math.max(1, demo.duration));
    shotDuration.value = String(seconds);
    shotDurationValue.textContent = `${seconds.toFixed(1)} s`;
  }
  setDolly(0);
}

flightRecordButton.addEventListener("click", () => {
  if (flightSamples) {
    const samples = flightSamples;
    flightSamples = null;
    flightRecordButton.textContent = "Record flight";
    if (samples.length < 3) return;

    // The flown track joins the built-in paths, so the gimbal pass needs no
    // further plumbing — select it and operate orientation over it.
    const flown = addFlownDemo(samples);
    const option = document.createElement("option");
    option.value = flown.id;
    option.textContent = flown.label;
    demoSelect.append(option);
    demoSelect.value = flown.id;
    applyDemo(flown);
    return;
  }

  if (!isPiloting()) return;
  flightSamples = [];
  flightStartedAt = performance.now();
  flightRecordButton.textContent = "Stop flight";
});

demoSelect.addEventListener("change", () => applyDemo(demoById(demoSelect.value)));
shotPlayButton.addEventListener("click", () => {
  dollyPlaying = !dollyPlaying;
  shotPlayButton.textContent = dollyPlaying ? "Pause" : "Play";
});
scrub.addEventListener("input", () => {
  pauseShot();
  setDolly(Number(scrub.value));
});
shotDuration.addEventListener("input", () => {
  shotDurationValue.textContent = `${shotDuration.value} s`;
});
applyDemo(demos[0]);

let lastRig = "";

/**
 * Pushes only what the phone cannot derive locally. Diffed rather than sent on a
 * timer, so a parked rig costs nothing and a moving one updates every frame.
 */
function sendRig(): void {
  const { x, y, z } = studio.pov.position;
  const round = (value: number): number => Math.round(value * 1000) / 1000;
  const payload = JSON.stringify({
    t: "rig",
    pos: [round(x), round(y), round(z)],
    aim: desktopOwnsAim() ? [aim.x, aim.y, aim.z, aim.w] : null,
    format: formatSelect.value === "fill" ? null : Number(formatSelect.value),
    settings,
  });
  if (payload === lastRig) return;
  lastRig = payload;
  if (socket?.readyState === WebSocket.OPEN) socket.send(payload);
}

function send(message: ViewerMessage): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function connect(): void {
  socket = new WebSocket(relayUrl("viewer"));

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as ViewerInbound;

    if (message.t === "presence") {
      controllerPresent = message.controller;
      kickButton.disabled = !controllerPresent;
      // A newly attached phone has no rig state, and the diff would otherwise
      // suppress the next send until something happened to change.
      if (controllerPresent) lastRig = "";
      return;
    }

    if (message.t === "lens") {
      setFocalTarget(message.mm, true);
      return;
    }

    if (message.t === "pong") {
      const sentAt = pendingPings.get(message.id);
      if (sentAt !== undefined) {
        halfRtt = (performance.now() - sentAt) / 2;
        pendingPings.delete(message.id);
      }
      return;
    }

    // Ignore anything else: the relay's vocabulary can grow, and a viewer left
    // open from an older build should go quiet rather than throw every frame.
    if (message.t !== "q") return;

    const now = performance.now();
    arrivals.push(now);
    if (lastArrival !== 0) intervals.push(now - lastArrival);
    if (intervals.length > 120) intervals = intervals.slice(-120);
    lastArrival = now;

    // Playback owns the raw stream while it runs, but the link metrics above
    // stay live so the HUD keeps reporting the phone.
    // Recording happens in the frame loop so it captures whatever is aiming,
    // not only the phone.
    if (Number.isNaN(playingFrom) && !usingMouseAim()) {
      raw.set(message.q[0], message.q[1], message.q[2], message.q[3]);
    }
  });

  socket.addEventListener("close", () => {
    socket = null;
    controllerPresent = false;
    kickButton.disabled = true;
    setTimeout(connect, 1000);
  });
}

/** Yaw wraps at ±180, so a naive subtraction reports a full turn of fake drift. */
function shortestDelta(a: number, b: number): number {
  return ((a - b + 540) % 360) - 180;
}

function angleBetween(a: THREE.Quaternion, b: THREE.Quaternion): number {
  return THREE.MathUtils.radToDeg(2 * Math.acos(Math.min(1, Math.abs(a.dot(b)))));
}

function stopPlayback(): void {
  playingFrom = Number.NaN;
  playButton.textContent = "Play";
  fields.source.textContent = "live";
}

recordButton.addEventListener("click", () => {
  if (take.isRecording) {
    take.stop();
    recordButton.textContent = "Record";
    playButton.disabled = take.count === 0;
    return;
  }
  stopPlayback();
  take.start(performance.now());
  recordButton.textContent = "Stop";
  playButton.disabled = true;
});

playButton.addEventListener("click", () => {
  if (!Number.isNaN(playingFrom)) {
    stopPlayback();
    return;
  }
  take.rewind();
  smoother.reset(raw);
  playingFrom = performance.now();
  playButton.textContent = "Stop";
  fields.source.textContent = "playback";
});

markButton.addEventListener("click", () => {
  markYaw = yawDeg;
  markAt = performance.now();
});

kickButton.addEventListener("click", () => send({ t: "kick" }));

function updateHud(): void {
  const now = performance.now();

  arrivals = arrivals.filter((t) => now - t < 1000);
  const live = lastArrival !== 0 && now - lastArrival < 1000;
  // "connected, idle" is its own state on purpose: a controller holding the slot
  // without streaming looks identical to no controller if you only watch samples.
  fields.link.textContent = !socket
    ? "offline"
    : live
      ? "streaming"
      : controllerPresent
        ? "connected, idle"
        : "none";
  fields.rate.textContent = live ? `${arrivals.length} Hz` : "—";
  fields.latency.textContent = Number.isNaN(halfRtt) ? "—" : `${halfRtt.toFixed(1)} ms`;

  if (intervals.length > 1 && live) {
    const mean = intervals.reduce((sum, v) => sum + v, 0) / intervals.length;
    const deviation = intervals.reduce((sum, v) => sum + Math.abs(v - mean), 0) / intervals.length;
    fields.jitter.textContent = `${deviation.toFixed(1)} ms`;
  } else {
    fields.jitter.textContent = "—";
  }

  fields.yaw.textContent = Number.isNaN(yawDeg) ? "—" : `${yawDeg.toFixed(1)}°`;
  fields.lag.textContent = `${angleBetween(raw, smoothed).toFixed(2)}°`;

  if (!Number.isNaN(markYaw) && !Number.isNaN(yawDeg)) {
    const elapsed = (now - markAt) / 1000;
    fields.drift.textContent = `${shortestDelta(yawDeg, markYaw).toFixed(1)}° / ${elapsed.toFixed(0)}s`;
  } else {
    fields.drift.textContent = "—";
  }

  fields.speed.textContent = isPiloting() ? `${drone.speed.toFixed(1)} m/s` : "—";
  fields.altitude.textContent = isPiloting()
    ? `${studio.pov.position.y.toFixed(1)} m`
    : "—";

  const pad = activeGamepad();
  padInfo.textContent = pad ? `gamepad: ${pad.id.slice(0, 30)}` : "gamepad: none";

  flightInfo.textContent = flightSamples
    ? `recording · ${flightSamples.length} samples · ${((now - flightStartedAt) / 1000).toFixed(1)} s`
    : isPiloting()
      ? "ready to record"
      : "pilot mode only";

  fields.takeCount.textContent = String(take.count);
  fields.takeDuration.textContent =
    take.count > 0 ? `${(take.duration / 1000).toFixed(1)} s` : "—";
}

setInterval(() => {
  const id = (nextPingId += 1);
  pendingPings.set(id, performance.now());
  for (const [key, sentAt] of pendingPings) {
    if (performance.now() - sentAt > 5000) pendingPings.delete(key);
  }
  send({ t: "ping", id });
}, 500);

setInterval(updateHud, 250);

const animate = (): void => {
  const now = performance.now();
  const dt = (now - lastFrame) / 1000;
  lastFrame = now;

  if (!Number.isNaN(playingFrom)) {
    const elapsed = now - playingFrom;
    if (elapsed > take.duration) {
      if (loopToggle.checked) {
        playingFrom = now;
        take.rewind();
      } else {
        stopPlayback();
      }
    }
    // A take replays the whole shot: the dolly position and lens recorded with
    // each sample, not just the head movement.
    const head = take.sampleAt(Math.min(elapsed, take.duration), raw);
    if (head) {
      setDolly(head.u);
      setFocalTarget(Math.round(head.mm), true);
    }
  } else if (isPiloting()) {
    drone.update(readFlightInput(), dt, flight);
    studio.setCameraPosition(drone.position);
    if (flightSamples) {
      flightSamples.push({
        t: (now - flightStartedAt) / 1000,
        p: [drone.position.x, drone.position.y, drone.position.z],
      });
    }
  } else if (dollyPlaying && demo.path) {
    const seconds = Number(shotDuration.value);
    const next = dollyU + dt / seconds;
    if (next < 1) {
      setDolly(next);
    } else if (shotLoop.checked) {
      setDolly(next - 1);
    } else {
      setDolly(1);
      pauseShot();
    }
  }

  // A thumb dragging a slider is steppy, so the zoom mechanism gets the same
  // mass the head has: with inertia on, a zoom ramps instead of jumping.
  const zoomBlend = settings.inertia
    ? 1 - Math.pow(2, -dt / Math.max(settings.halfLife, 0.001))
    : 1;
  focalCurrent += (focalTarget - focalCurrent) * zoomBlend;
  studio.setFocalLength(focalCurrent);

  if (usingMouseAim() && Number.isNaN(playingFrom)) {
    euler.set(THREE.MathUtils.degToRad(mousePitch), THREE.MathUtils.degToRad(mouseYaw), mouseRoll, "YXZ");
    raw.setFromEuler(euler);
  }

  if (take.isRecording && Number.isNaN(playingFrom)) {
    take.push(now, raw, dollyU, focalTarget);
  }

  smoother.apply(raw, dt, settings, smoothed);
  if (isPiloting()) {
    // The pilot pass owns aiming: its orientation is a flying aid, replaced
    // wholesale by the gimbal pass afterwards.
    drone.orientation(aim, flight);
    studio.pov.quaternion.copy(aim);
    studio.rawPov.quaternion.copy(aim);
  } else {
    studio.pov.quaternion.copy(smoothed);
    studio.rawPov.quaternion.copy(raw);
    aim.copy(smoothed);
  }
  studio.setRawVisible(ghostToggle.checked && !isPiloting());

  euler.setFromQuaternion(raw, "YXZ");
  yawDeg = THREE.MathUtils.radToDeg(euler.y);

  sendRig();
  updatePrevisCamera();
  studio.render();
  requestAnimationFrame(animate);
};
animate();

connect();
