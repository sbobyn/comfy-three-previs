import type { FlightInput } from "./flight";

export type StickSettings = { deadzone: number; expo: number };
export type GamepadLayout = "game" | "drone";
export function defaultStickSettings(): StickSettings {
  return { deadzone: 0.08, expo: 0.45 };
}

// Existing Previs response curve, applied radially to a movement/look pair.
export function shape(
  value: number,
  { deadzone, expo }: StickSettings,
): number {
  if (!Number.isFinite(value)) return 0;
  const magnitude = Math.min(1, Math.abs(value));
  if (magnitude <= deadzone) return 0;
  const scaled = (magnitude - deadzone) / (1 - deadzone);
  return Math.sign(value) * (expo * scaled ** 3 + (1 - expo) * scaled);
}
function pair(x: number, y: number, settings: StickSettings): number[] {
  const length = Math.hypot(x, y);
  if (!Number.isFinite(length) || length === 0) return [0, 0];
  const scale = shape(length, settings) / length;
  return [x * scale, y * scale];
}
export function isStandardPad(pad: Gamepad | null): pad is Gamepad {
  return (
    !!pad?.connected &&
    pad.mapping === "standard" &&
    pad.axes.length >= 4 &&
    pad.buttons.length >= 8
  );
}
export function availableGamepads(): (Gamepad | null)[] {
  try {
    return Array.from(navigator.getGamepads?.() ?? []);
  } catch {
    return [];
  }
}
export function activeGamepad(): Gamepad | null {
  return availableGamepads().find(isStandardPad) ?? null;
}

// Match the established operator layout; no Otter or ComfyUI runtime dependency.
export function readGamepad(
  settings: StickSettings,
  pad = activeGamepad(),
  layout: GamepadLayout = "game",
): FlightInput | null {
  if (!isStandardPad(pad)) return null;
  const slow = pad.buttons[4].pressed;
  const move = slow ? 0.3 : pad.buttons[5].pressed ? 2.5 : 1;
  const look = slow ? 0.3 : 1;
  const [x, y] = pair(
    pad.axes[layout === "game" ? 0 : 2],
    pad.axes[layout === "game" ? 1 : 3],
    settings,
  );
  const [yaw, pitch] = pair(pad.axes[2], pad.axes[3], settings);
  return {
    forward: -y * move,
    lateral: x * move,
    vertical:
      (layout === "game"
        ? shape(pad.buttons[7].value, settings) -
          shape(pad.buttons[6].value, settings)
        : -shape(pad.axes[1], settings)) * move,
    yaw: (layout === "game" ? yaw : shape(pad.axes[0], settings)) * look,
    pitch: layout === "game" ? -pitch * look : 0,
  };
}
export function centeredGamepad(
  pad: Gamepad,
  settings: StickSettings,
): boolean {
  return (
    isStandardPad(pad) &&
    pad.axes
      .slice(0, 4)
      .every((v) => Number.isFinite(v) && Math.abs(v) <= settings.deadzone) &&
    [6, 7].every(
      (i) =>
        Number.isFinite(pad.buttons[i].value) &&
        pad.buttons[i].value <= settings.deadzone,
    )
  );
}

/** An explicit arm locks one controller. Disconnect never switches to another. */
export class GamepadSession {
  private identity: { index: number; id: string } | null = null;
  private armed = false;
  get ready(): boolean {
    return this.armed;
  }
  current(pads: (Gamepad | null)[]): Gamepad | null {
    return this.identity
      ? (pads.find(
          (p) =>
            p?.index === this.identity!.index && p?.id === this.identity!.id,
        ) ?? null)
      : null;
  }
  status = "Press a controller button, then enable Xbox / gamepad.";
  stop(reason = "Paused. Enable again to operate."): void {
    this.identity = null;
    this.armed = false;
    this.status = reason;
  }
  start(pad: Gamepad | null): boolean {
    if (!isStandardPad(pad)) {
      this.stop(
        "No standard controller detected. Connect Xbox by USB/Bluetooth and press a button.",
      );
      return false;
    }
    this.identity = { index: pad.index, id: pad.id };
    this.armed = false;
    this.status = "Center both sticks and release triggers to arm.";
    return true;
  }
  read(
    pads: (Gamepad | null)[],
    settings: StickSettings,
    layout: GamepadLayout,
  ): FlightInput | null {
    if (!this.identity) return null;
    const pad =
      pads.find(
        (p) => p?.index === this.identity!.index && p?.id === this.identity!.id,
      ) ?? null;
    if (!isStandardPad(pad)) {
      this.stop(
        "Controller disconnected. Reconnect, press a button, then enable again.",
      );
      return null;
    }
    if (!this.armed) {
      if (!centeredGamepad(pad, settings)) return null;
      this.armed = true;
    }
    this.status = `Operating · ${pad.id} · ${layout === "game" ? "Game layout" : "RC Mode 2"}`;
    return readGamepad(settings, pad, layout);
  }
}

/** Rising edges only; holding a button while connecting never records a take. */
export class GamepadButtons {
  private identity = "";
  private held: boolean[] = [];
  read(pad: Gamepad | null): number[] {
    if (!isStandardPad(pad)) {
      this.identity = "";
      this.held = [];
      return [];
    }
    const identity = `${pad.index}:${pad.id}`,
      next = pad.buttons.map((button) => button.pressed);
    const edges =
      identity === this.identity
        ? next.flatMap((pressed, index) =>
            pressed && !this.held[index] ? [index] : [],
          )
        : [];
    this.identity = identity;
    this.held = next;
    return edges;
  }
}
