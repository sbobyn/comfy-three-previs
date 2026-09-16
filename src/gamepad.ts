import type { FlightInput } from "./flight";

export type StickSettings = {
  deadzone: number;
  /** 0 = linear, 1 = fully cubic: fine control near centre, full range at the stops. */
  expo: number;
};

export function defaultStickSettings(): StickSettings {
  return { deadzone: 0.08, expo: 0.45 };
}

/** Rescales past the deadzone so the axis eases in from zero instead of jumping. */
function shape(value: number, { deadzone, expo }: StickSettings): number {
  const magnitude = Math.abs(value);
  if (magnitude <= deadzone) return 0;
  const scaled = (magnitude - deadzone) / (1 - deadzone);
  const curved = expo * scaled ** 3 + (1 - expo) * scaled;
  return Math.sign(value) * curved;
}

export function activeGamepad(): Gamepad | null {
  for (const pad of navigator.getGamepads?.() ?? []) {
    if (pad?.connected && pad.axes.length >= 4) return pad;
  }
  return null;
}

/**
 * Mode 2, the standard RC transmitter layout: left stick is altitude and yaw,
 * right stick is forward and lateral. Anyone who has flown a drone is already
 * fluent in it, and anyone who has not learns something that transfers.
 *
 * Browser Y axes read negative upward, so climb and forward are negated.
 */
export function readGamepad(settings: StickSettings): FlightInput | null {
  const pad = activeGamepad();
  if (!pad) return null;
  return {
    vertical: -shape(pad.axes[1], settings),
    yaw: shape(pad.axes[0], settings),
    forward: -shape(pad.axes[3], settings),
    lateral: shape(pad.axes[2], settings),
  };
}
