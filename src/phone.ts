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

const enableButton = element<HTMLButtonElement>("enable");
const zeroButton = element<HTMLButtonElement>("zero");
const linkField = element("link");
const sensorField = element("sensor");
const sentField = element("sent");
const gripSelect = element<HTMLSelectElement>("grip");
const zoomSlider = element<HTMLInputElement>("zoom");
const zoomValue = element("zoomValue");

const yawZero = new YawZero();
let socket: WebSocket | null = null;
let sent = 0;
let pendingZero = false;
let motionEnabled = false;
let detached = false;

function refreshPrimary(): void {
  if (!motionEnabled) {
    enableButton.textContent = "Enable Motion";
    enableButton.disabled = false;
  } else if (detached) {
    enableButton.textContent = "Reconnect";
    enableButton.disabled = false;
  } else {
    enableButton.textContent = "Streaming";
    enableButton.disabled = true;
  }
}

function send(message: PhoneMessage): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function sendLens(): void {
  const mm = sliderToMm(Number(zoomSlider.value));
  zoomValue.textContent = `${mm} mm`;
  send({ t: "lens", mm });
}

zoomSlider.addEventListener("input", sendLens);

function connect(): void {
  detached = false;
  socket = new WebSocket(relayUrl("phone"));

  socket.addEventListener("open", () => {
    linkField.textContent = "connected";
    // Announce the lens on connect so the desktop adopts the operator's setting
    // rather than whatever it happened to be showing.
    sendLens();
    refreshPrimary();
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as ViewerMessage;
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
        event.code === EVICTED_BY_VIEWER ? "released by the desktop" : "another controller took over";
      refreshPrimary();
      return;
    }
    linkField.textContent = "reconnecting…";
    refreshPrimary();
    setTimeout(connect, 1000);
  });
}

enableButton.addEventListener("click", async () => {
  if (!motionEnabled) {
    enableButton.disabled = true;
    sensorField.textContent = "requesting…";

    if (!(await requestMotionPermission())) {
      sensorField.textContent = "permission denied";
      refreshPrimary();
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
      send({ t: "q", q: [q.x, q.y, q.z, q.w] });
      sent += 1;
      if (sent % 10 === 0) sentField.textContent = String(sent);
    });

    motionEnabled = true;
    zeroButton.disabled = false;
    sensorField.textContent = "streaming";
  }

  if (!socket) connect();
  refreshPrimary();
});

zeroButton.addEventListener("click", () => {
  pendingZero = true;
});

refreshPrimary();
connect();
