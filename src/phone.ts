import * as THREE from "three";
import { element } from "./dom";
import { sliderToMm } from "./lens";
import {
  applyGrip,
  onDeviceQuaternion,
  requestMotionPermission,
  YawZero,
  type Grip,
} from "./orientation";
import {
  EVICTED_BY_VIEWER,
  relayUrl,
  REPLACED_BY_NEWER,
  type PhoneMessage,
  type ViewerMessage,
} from "./protocol";
import { createViewfinder } from "./scene";
import { defaultSettings, OrientationSmoother, type SmoothingSettings } from "./smoothing";

const canvas = element<HTMLCanvasElement>("scene");
const startCard = element("start");
const bar = element("bar");
const enableButton = element<HTMLButtonElement>("enable");
const zeroButton = element<HTMLButtonElement>("zero");
const chromeButton = element<HTMLButtonElement>("chrome");
const linkField = element("link");
const sensorField = element("sensor");
const gripSelect = element<HTMLSelectElement>("grip");
const zoomSlider = element<HTMLInputElement>("zoom");
const zoomValue = element("zoomValue");

const viewfinder = createViewfinder(canvas);
const smoother = new OrientationSmoother();
const yawZero = new YawZero();
const raw = new THREE.Quaternion();
const smoothed = new THREE.Quaternion();

let settings: SmoothingSettings = defaultSettings();
let socket: WebSocket | null = null;
let motionEnabled = false;
let detached = false;
let pendingZero = false;
let hasSample = false;
let chromeHidden = false;
let lastFrame = performance.now();

function refreshChrome(): void {
  startCard.hidden = motionEnabled && !detached;
  bar.hidden = !motionEnabled || chromeHidden;
  element("status").style.opacity = chromeHidden ? "0" : "1";
  enableButton.textContent = !motionEnabled ? "Enable Motion" : "Reconnect";
}

function send(message: PhoneMessage): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function sendLens(): void {
  const mm = sliderToMm(Number(zoomSlider.value));
  zoomValue.textContent = `${mm} mm`;
  viewfinder.setFocalLength(mm);
  send({ t: "lens", mm });
}

function connect(): void {
  detached = false;
  socket = new WebSocket(relayUrl("phone"));

  socket.addEventListener("open", () => {
    linkField.textContent = "linked";
    // Announce the lens on connect so the desktop adopts the operator's setting
    // rather than whatever it happened to be showing.
    sendLens();
    refreshChrome();
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as ViewerMessage;

    if (message.t === "rig") {
      // Only what the device cannot derive locally: everything to do with
      // aiming stays on this side of the link.
      settings = message.settings;
      viewfinder.setRig(message.demo, message.u);
      viewfinder.setFormat(message.format);
      return;
    }

    // Echoed immediately so the desktop can measure round-trip without needing
    // the two devices' clocks to agree.
    if (message.t === "ping") send({ t: "pong", id: message.id });
  });

  socket.addEventListener("close", (event) => {
    socket = null;
    if (event.code === REPLACED_BY_NEWER || event.code === EVICTED_BY_VIEWER) {
      // A deliberate handover. Staying down stops two controllers evicting each
      // other in a loop, but the sensor listener and its permission survive, so
      // taking the slot back is one tap rather than a reload.
      detached = true;
      linkField.textContent =
        event.code === EVICTED_BY_VIEWER ? "released by desktop" : "taken over";
      refreshChrome();
      return;
    }
    linkField.textContent = "reconnecting…";
    refreshChrome();
    setTimeout(connect, 1000);
  });
}

async function keepAwake(): Promise<void> {
  const wakeLock = (
    navigator as Navigator & { wakeLock?: { request: (type: string) => Promise<unknown> } }
  ).wakeLock;
  try {
    await wakeLock?.request("screen");
  } catch {
    // Unsupported or refused; the operator just gets a screen that may sleep.
  }
}

enableButton.addEventListener("click", async () => {
  if (!motionEnabled) {
    enableButton.disabled = true;
    sensorField.textContent = "requesting…";

    if (!(await requestMotionPermission())) {
      sensorField.textContent = "motion denied";
      enableButton.disabled = false;
      return;
    }

    onDeviceQuaternion((q) => {
      // Grip is a body-mount constant, so it applies before the re-zero that
      // decides which way the operator is pointing.
      applyGrip(q, gripSelect.value as Grip);
      if (pendingZero) {
        yawZero.capture(q);
        pendingZero = false;
      }
      yawZero.apply(q);
      raw.copy(q);
      hasSample = true;
      send({ t: "q", q: [q.x, q.y, q.z, q.w] });
    });

    motionEnabled = true;
    enableButton.disabled = false;
    zeroButton.disabled = false;
    sensorField.textContent = "live";
    void keepAwake();
  }

  if (!socket) connect();
  refreshChrome();
});

zeroButton.addEventListener("click", () => {
  pendingZero = true;
});

chromeButton.addEventListener("click", () => {
  chromeHidden = true;
  refreshChrome();
});

canvas.addEventListener("pointerdown", () => {
  if (!chromeHidden) return;
  chromeHidden = false;
  refreshChrome();
});

zoomSlider.addEventListener("input", sendLens);

const animate = (): void => {
  const now = performance.now();
  const dt = (now - lastFrame) / 1000;
  lastFrame = now;

  if (hasSample) {
    // The same filter the desktop runs, over the same samples, so the viewfinder
    // shows the shot being recorded rather than a shakier version of it.
    smoother.apply(raw, dt, settings, smoothed);
    viewfinder.camera.quaternion.copy(smoothed);
  }

  viewfinder.render();
  requestAnimationFrame(animate);
};

sendLens();
refreshChrome();
animate();
connect();
