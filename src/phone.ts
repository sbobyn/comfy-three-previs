import { element } from "./dom";
import { mmToSlider, sliderToMm } from "./lens";
import {
  applyGrip,
  onDeviceQuaternion,
  requestMotionPermission,
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

const viewfinder = createViewfinder(element<HTMLCanvasElement>("scene"));
const start = element("start"),
  bar = element("bar"),
  link = element("link"),
  sensor = element("sensor");
const enable = element<HTMLButtonElement>("enable"),
  touch = element<HTMLButtonElement>("touchOnly");
const grip = element<HTMLSelectElement>("grip"),
  zoom = element<HTMLInputElement>("zoom");
let socket: WebSocket | null = null,
  retry: ReturnType<typeof setTimeout> | undefined;
let activation = 0;
let enabledAt = 0;
let enabled = false,
  motion = false,
  detached = false,
  lastSample = 0,
  lastRig = 0;
let detachSensor: (() => void) | undefined;
let wakeLock: { release: () => Promise<void> } | undefined;
const sticks = { forward: 0, lateral: 0, vertical: 0, yaw: 0, pitch: 0 };
let slow = false,
  fast = false;
const reset = () => {
  for (const key of Object.keys(sticks) as (keyof typeof sticks)[])
    sticks[key] = 0;
  slow = false;
  fast = false;
};
function send(message: PhoneMessage) {
  if (socket?.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify(message));
}
function refresh() {
  start.hidden = enabled && !detached;
  bar.hidden = !enabled;
  enable.disabled = false;
  touch.disabled = false;
}
function pause(reason: string) {
  const wasEnabled = enabled;
  activation++;
  enabled = false;
  motion = false;
  detachSensor?.();
  detachSensor = undefined;
  reset();
  send({ t: "control", active: false, input: { ...sticks } });
  if (wasEnabled) send({ t: "pause" });
  sensor.textContent = reason;
  void wakeLock?.release();
  wakeLock = undefined;
  refresh();
}
function connect() {
  if (socket || detached) return;
  socket = new WebSocket(relayUrl("phone"));
  socket.onopen = () => {
    link.textContent = "Linked · enable controls on Mac and phone";
    refresh();
  };
  socket.onmessage = (event) => {
    let message: ViewerMessage;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message.t === "ping") {
      send({ t: "pong", id: message.id });
      return;
    }
    if (message.t !== "rig") return;
    lastRig = performance.now();
    const record = element<HTMLButtonElement>("phoneRecord");
    record.textContent = message.controls?.recording
      ? "Stop shot"
      : message.controls?.enabled
        ? "Record shot"
        : "Arm camera";
    record.disabled = !enabled;
    viewfinder.setPosition(...message.pos);
    viewfinder.setFormat(message.format);
    if (message.aim) viewfinder.camera.quaternion.fromArray(message.aim);
    if (message.mm) {
      viewfinder.setFocalLength(message.mm);
      zoom.value = String(mmToSlider(message.mm));
      element("zoomValue").textContent = `${message.mm.toFixed(0)} mm`;
    }
    if (message.subject) viewfinder.setSubjectPosition(message.subject);
  };
  socket.onclose = (event) => {
    socket = null;
    pause("Connection lost; enable again after reconnect.");
    detached = [REPLACED_BY_NEWER, EVICTED_BY_VIEWER, 4003].includes(
      event.code,
    );
    link.textContent = detached
      ? "Pairing ended or another phone took over. Create/reopen a pairing link."
      : "Reconnecting…";
    if (!detached) retry = setTimeout(connect, 1000);
  };
}
async function activate(useMotion: boolean) {
  if (socket?.readyState !== WebSocket.OPEN) {
    link.textContent =
      "Wait for pairing connection. Reopen the current link if it expired.";
    return;
  }
  pause("Enabling…");
  const attempt = activation;
  enable.disabled = true;
  touch.disabled = true;
  try {
    if (useMotion) {
      if (!(await requestMotionPermission()))
        throw Error(
          "Motion unavailable or denied. Use trusted HTTPS and allow Motion & Orientation, or choose touch controls.",
        );
      if (attempt !== activation || document.hidden) return;
      motion = true;
      lastSample = 0;
      detachSensor = onDeviceQuaternion((q) => {
        if (!enabled || !motion) return;
        applyGrip(q, grip.value as Grip);
        lastSample = performance.now();
        sensor.textContent = "Motion samples live";
        send({ t: "q", q: q.toArray() as [number, number, number, number] });
      });
    }
    if (attempt !== activation || document.hidden) return;
    enabled = true;
    enabledAt = performance.now();
    send({ t: "recenter" });
    sensor.textContent = useMotion
      ? "Waiting for sensor samples…"
      : "Touch controls enabled";
    const api = navigator as Navigator & {
      wakeLock?: {
        request: (type: string) => Promise<{ release: () => Promise<void> }>;
      };
    };
    try {
      const lock = await api.wakeLock?.request("screen");
      if (attempt !== activation) void lock?.release();
      else wakeLock = lock;
    } catch {
      /* Screen lock remains a user/device setting. */
    }
  } catch (e) {
    sensor.textContent = (e as Error).message;
  } finally {
    refresh();
  }
}
enable.onclick = () => void activate(true);
touch.onclick = () => void activate(false);
element("phoneRecord").onclick = () => {
  if (
    enabled &&
    (!motion || (lastSample > 0 && performance.now() - lastSample < 500))
  )
    send({ t: "record" });
};
element("zero").onclick = () => {
  reset();
  send({ t: "recenter" });
  sensor.textContent = "Recentered against desktop framing";
};
element("chrome").onclick = () => pause("Paused. Enable controls to resume.");
grip.onchange = () => {
  reset();
  send({ t: "recenter" });
};
zoom.oninput = () => {
  if (enabled) send({ t: "lens", mm: sliderToMm(Number(zoom.value)) });
};

// Independent pointer ownership for move, aim and altitude. Losing any pointer
// clears that control; no document-wide touch handler can leave movement latched.
function joystick(id: string, update: (x: number, y: number) => void) {
  const pad = element(id);
  let pointer: number | null = null,
    startX = 0,
    startY = 0;
  const release = () => {
    pointer = null;
    update(0, 0);
    pad.style.background = "";
  };
  pad.addEventListener("pointerdown", (event) => {
    if (!enabled || pointer !== null) return;
    pointer = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    pad.setPointerCapture(pointer);
    event.preventDefault();
  });
  pad.addEventListener("pointermove", (event) => {
    if (pointer !== event.pointerId) return;
    let x = (event.clientX - startX) / 50,
      y = (event.clientY - startY) / 50;
    const magnitude = Math.max(1, Math.hypot(x, y));
    x /= magnitude;
    y /= magnitude;
    update(x, y);
    pad.style.background = "#49378B";
  });
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"])
    pad.addEventListener(name, release);
  window.addEventListener("blur", release);
}
joystick("movePad", (x, y) => {
  sticks.lateral = x;
  sticks.forward = -y;
});
joystick("lookPad", (x, y) => {
  sticks.yaw = motion ? 0 : x;
  sticks.pitch = motion ? 0 : -y;
});
joystick("heightPad", (_x, y) => {
  sticks.vertical = -y;
});
for (const id of ["slow", "fast"]) {
  const button = element(id);
  const set = (v: boolean) => {
    if (id === "slow") slow = v;
    else fast = v;
  };
  button.addEventListener("pointerdown", (event) => {
    button.setPointerCapture(event.pointerId);
    set(true);
  });
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"])
    button.addEventListener(name, () => set(false));
}
window.addEventListener("blur", () => {
  if (enabled) pause("Phone lost focus. Enable again.");
});
window.addEventListener("pagehide", () => {
  pause("Page closed");
  clearTimeout(retry);
  detached = true;
  socket?.close();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) pause("Phone hidden/locked. Enable again.");
});
setInterval(() => {
  if (!enabled) return;
  if (
    socket?.readyState !== WebSocket.OPEN ||
    performance.now() - lastRig > 2000
  ) {
    pause("Desktop stopped responding. Return to Mac, then enable again.");
    return;
  }
  if (motion && (!lastSample || performance.now() - lastSample > 500)) {
    reset();
    send({ t: "control", active: false, input: { ...sticks } });
    if (lastSample || performance.now() - enabledAt > 1500)
      pause(
        "Motion samples unavailable. Enable motion again or choose touch-only controls.",
      );
    return;
  }
  const speed = slow ? 0.3 : fast ? 2.5 : 1,
    look = slow ? 0.3 : 1;
  send({
    t: "control",
    active: true,
    input: {
      forward: sticks.forward * speed,
      lateral: sticks.lateral * speed,
      vertical: sticks.vertical * speed,
      yaw: sticks.yaw * look,
      pitch: sticks.pitch * look,
    },
  });
  if (motion && performance.now() - lastSample > 1000)
    sensor.textContent =
      "No recent motion samples. Check Safari permission or use touch controls.";
}, 33);
function animate() {
  viewfinder.render();
  requestAnimationFrame(animate);
}
refresh();
connect();
animate();
