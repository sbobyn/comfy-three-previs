import * as THREE from "three";

const up = new THREE.Vector3(0, 1, 0);
const euler = new THREE.Euler();

// -90° about X: maps "phone held upright, screen toward you" into camera space,
// where the camera looks down -Z.
const deviceToCamera = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));

/**
 * alpha/beta/gamma are intrinsic Z-X'-Y'' rotations, so they cannot be assigned
 * to an Euler directly — the YXZ order and the negated gamma are load-bearing.
 *
 * Deliberately omits the `screen.orientation.angle` term that
 * DeviceOrientationControls applies. That term is for treating the phone as a
 * window you look through, where the view should stay upright as the device
 * rotates. Here the phone is a camera body, so rolling it into landscape is an
 * intentional camera roll and cancelling it would discard the operator's input.
 * Do not add it back.
 */
export function deviceQuaternion(
  target: THREE.Quaternion,
  alphaDeg: number,
  betaDeg: number,
  gammaDeg: number,
): THREE.Quaternion {
  euler.set(
    THREE.MathUtils.degToRad(betaDeg),
    THREE.MathUtils.degToRad(alphaDeg),
    -THREE.MathUtils.degToRad(gammaDeg),
    "YXZ",
  );
  target.setFromEuler(euler);
  target.multiply(deviceToCamera);
  return target;
}

/**
 * Cancels only the yaw captured at re-zero time. Pitch and roll are derived from
 * gravity and are absolute, so zeroing them would make "level" permanently
 * crooked; yaw is the magnetometer-derived axis that actually drifts.
 */
export class YawZero {
  private readonly offset = new THREE.Quaternion();
  private readonly scratch = new THREE.Euler();

  capture(q: THREE.Quaternion): void {
    this.scratch.setFromQuaternion(q, "YXZ");
    this.offset.setFromAxisAngle(up, -this.scratch.y);
  }

  apply(q: THREE.Quaternion): THREE.Quaternion {
    return q.premultiply(this.offset);
  }
}

export type Grip = "portrait" | "landscape-left" | "landscape-right";

const gripRoll: Record<Grip, number> = {
  portrait: 0,
  "landscape-left": Math.PI / 2,
  "landscape-right": -Math.PI / 2,
};

const gripQuaternion = new THREE.Quaternion();
const viewAxis = new THREE.Vector3(0, 0, 1);

/**
 * A fixed roll about the view axis declaring how the operator holds the device —
 * the rig equivalent of mounting a camera body sideways. Unlike the screen
 * orientation term this deliberately omits, it is a chosen constant, not a
 * reaction to the browser rotating, so it never fights the operator's own roll.
 */
export function applyGrip(q: THREE.Quaternion, grip: Grip): THREE.Quaternion {
  const roll = gripRoll[grip];
  if (roll === 0) return q;
  return q.multiply(gripQuaternion.setFromAxisAngle(viewAxis, roll));
}

type PermissionRequestable = {
  requestPermission?: () => Promise<"granted" | "denied" | "prompt">;
};

/** Must be called from a user gesture — iOS rejects it anywhere else. */
export async function requestMotionPermission(): Promise<boolean> {
  if (!globalThis.isSecureContext || typeof DeviceOrientationEvent === "undefined") return false;
  const ctor = DeviceOrientationEvent as unknown as PermissionRequestable;
  if (typeof ctor.requestPermission !== "function") return true;
  return (await ctor.requestPermission()) === "granted";
}

/** Attaches a deviceorientation listener; returns a detach function. */
export function onDeviceQuaternion(
  handler: (q: THREE.Quaternion, event: DeviceOrientationEvent) => void,
): () => void {
  const quaternion = new THREE.Quaternion();
  const listener = (event: DeviceOrientationEvent): void => {
    if (event.alpha === null || event.beta === null || event.gamma === null || ![event.alpha,event.beta,event.gamma].every(Number.isFinite)) return;
    deviceQuaternion(quaternion, event.alpha, event.beta, event.gamma);
    handler(quaternion, event);
  };
  window.addEventListener("deviceorientation", listener);
  return () => window.removeEventListener("deviceorientation", listener);
}
