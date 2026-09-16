import * as THREE from "three";
import { element } from "./dom";
import { createStudio } from "./scene";
import { horizontalFov, mmToSlider, sliderToMm } from "./lens";
import { relayUrl, type ViewerInbound, type ViewerMessage } from "./protocol";
import { OrientationSmoother, defaultSettings } from "./smoothing";
import { Take } from "./take";
import { demoById, demos, type Demo } from "./demos";

const canvas = element<HTMLCanvasElement>("scene");
const fields = {
  source: element("source"),
  link: element("link"),
  rate: element("rate"),
  latency: element("latency"),
  jitter: element("jitter"),
  yaw: element("yaw"),
  drift: element("drift"),
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

const studio = createStudio(canvas, element("worldPane"));
const smoother = new OrientationSmoother();
const settings = defaultSettings();
const take = new Take();

const raw = new THREE.Quaternion();
const smoothed = new THREE.Quaternion();
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
  if (movable) {
    shotDuration.value = String(demo.duration);
    shotDurationValue.textContent = `${demo.duration} s`;
  }
  setDolly(0);
}

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
  const payload = JSON.stringify({
    t: "rig",
    demo: demo.id,
    u: dollyU,
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
    if (Number.isNaN(playingFrom)) {
      raw.set(message.q[0], message.q[1], message.q[2], message.q[3]);
      take.push(now, raw, dollyU, focalTarget);
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

  smoother.apply(raw, dt, settings, smoothed);
  studio.pov.quaternion.copy(smoothed);
  studio.rawPov.quaternion.copy(raw);
  studio.setRawVisible(ghostToggle.checked);

  euler.setFromQuaternion(raw, "YXZ");
  yawDeg = THREE.MathUtils.radToDeg(euler.y);

  sendRig();
  studio.render();
  requestAnimationFrame(animate);
};
animate();

connect();
