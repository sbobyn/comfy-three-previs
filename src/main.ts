import * as THREE from "three";
import { element } from "./dom";
import { createStage } from "./scene";
import { relayUrl, type PhoneMessage, type ViewerMessage } from "./protocol";

const canvas = element<HTMLCanvasElement>("scene");
const markButton = element<HTMLButtonElement>("mark");
const fields = {
  link: element("link"),
  rate: element("rate"),
  latency: element("latency"),
  jitter: element("jitter"),
  yaw: element("yaw"),
  drift: element("drift"),
};

const stage = createStage(canvas);
const incoming = new THREE.Quaternion();
const euler = new THREE.Euler();

let socket: WebSocket | null = null;
let arrivals: number[] = [];
let intervals: number[] = [];
let lastArrival = 0;
let halfRtt = Number.NaN;
let yawDeg = Number.NaN;
let markYaw = Number.NaN;
let markAt = 0;

let nextPingId = 0;
const pendingPings = new Map<number, number>();

function send(message: ViewerMessage): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function connect(): void {
  socket = new WebSocket(relayUrl("viewer"));

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as PhoneMessage;

    if (message.t === "pong") {
      const sentAt = pendingPings.get(message.id);
      if (sentAt !== undefined) {
        halfRtt = (performance.now() - sentAt) / 2;
        pendingPings.delete(message.id);
      }
      return;
    }

    incoming.set(message.q[0], message.q[1], message.q[2], message.q[3]);
    stage.target.quaternion.copy(incoming);

    const now = performance.now();
    arrivals.push(now);
    if (lastArrival !== 0) intervals.push(now - lastArrival);
    if (intervals.length > 120) intervals = intervals.slice(-120);
    lastArrival = now;

    euler.setFromQuaternion(incoming, "YXZ");
    yawDeg = THREE.MathUtils.radToDeg(euler.y);
  });

  socket.addEventListener("close", () => {
    socket = null;
    setTimeout(connect, 1000);
  });
}

/** Yaw wraps at ±180, so a naive subtraction reports a full turn of fake drift. */
function shortestDelta(a: number, b: number): number {
  return ((a - b + 540) % 360) - 180;
}

function updateHud(): void {
  const now = performance.now();

  arrivals = arrivals.filter((t) => now - t < 1000);
  const live = lastArrival !== 0 && now - lastArrival < 1000;
  fields.link.textContent = live ? "streaming" : socket ? "waiting" : "offline";
  fields.rate.textContent = live ? `${arrivals.length} Hz` : "—";

  fields.latency.textContent = Number.isNaN(halfRtt) ? "—" : `${halfRtt.toFixed(1)} ms`;

  if (intervals.length > 1 && live) {
    const mean = intervals.reduce((sum, v) => sum + v, 0) / intervals.length;
    const deviation =
      intervals.reduce((sum, v) => sum + Math.abs(v - mean), 0) / intervals.length;
    fields.jitter.textContent = `${deviation.toFixed(1)} ms`;
  } else {
    fields.jitter.textContent = "—";
  }

  fields.yaw.textContent = Number.isNaN(yawDeg) ? "—" : `${yawDeg.toFixed(1)}°`;

  if (!Number.isNaN(markYaw) && !Number.isNaN(yawDeg)) {
    const elapsed = (now - markAt) / 1000;
    fields.drift.textContent = `${shortestDelta(yawDeg, markYaw).toFixed(1)}° / ${elapsed.toFixed(0)}s`;
  } else {
    fields.drift.textContent = "—";
  }
}

markButton.addEventListener("click", () => {
  markYaw = yawDeg;
  markAt = performance.now();
});

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
  stage.render();
  requestAnimationFrame(animate);
};
animate();

connect();
