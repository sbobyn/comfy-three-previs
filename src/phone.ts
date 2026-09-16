import { element } from "./dom";
import {
  applyGrip,
  onDeviceQuaternion,
  requestMotionPermission,
  YawZero,
  type Grip,
} from "./orientation";
import { relayUrl, type PhoneMessage, type ViewerMessage } from "./protocol";

const enableButton = element<HTMLButtonElement>("enable");
const zeroButton = element<HTMLButtonElement>("zero");
const linkField = element("link");
const sensorField = element("sensor");
const sentField = element("sent");
const gripSelect = element<HTMLSelectElement>("grip");

const yawZero = new YawZero();
let socket: WebSocket | null = null;
let sent = 0;
let pendingZero = false;

function send(message: PhoneMessage): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function connect(): void {
  socket = new WebSocket(relayUrl("phone"));

  socket.addEventListener("open", () => {
    linkField.textContent = "connected";
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as ViewerMessage;
    // Echoed immediately so the desktop can measure round-trip without needing
    // the two devices' clocks to agree.
    if (message.t === "ping") send({ t: "pong", id: message.id });
  });

  socket.addEventListener("close", () => {
    linkField.textContent = "reconnecting…";
    socket = null;
    setTimeout(connect, 1000);
  });
}

enableButton.addEventListener("click", async () => {
  enableButton.disabled = true;
  sensorField.textContent = "requesting…";

  if (!(await requestMotionPermission())) {
    sensorField.textContent = "permission denied";
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
    send({ t: "q", q: [q.x, q.y, q.z, q.w] });
    sent += 1;
    if (sent % 10 === 0) sentField.textContent = String(sent);
  });

  zeroButton.disabled = false;
  sensorField.textContent = "streaming";
});

zeroButton.addEventListener("click", () => {
  pendingZero = true;
});

connect();
