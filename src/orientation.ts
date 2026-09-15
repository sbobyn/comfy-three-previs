import * as THREE from "three";

const zee = new THREE.Vector3(0, 0, 1);
const up = new THREE.Vector3(0, 1, 0);
const euler = new THREE.Euler();
const screenQuat = new THREE.Quaternion();

// -90° about X: maps "phone held upright, screen toward you" into camera space,
// where the camera looks down -Z.
const deviceToCamera = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));

/**
 * alpha/beta/gamma are intrinsic Z-X'-Y'' rotations, so they cannot be assigned
 * to an Euler directly — the YXZ order, the negated gamma and the two trailing
 * quaternions are all load-bearing.
 */
export function deviceQuaternion(
  target: THREE.Quaternion,
  alphaDeg: number,
  betaDeg: number,
  gammaDeg: number,
  screenDeg: number,
): THREE.Quaternion {
  euler.set(
    THREE.MathUtils.degToRad(betaDeg),
    THREE.MathUtils.degToRad(alphaDeg),
    -THREE.MathUtils.degToRad(gammaDeg),
    "YXZ",
  );
  target.setFromEuler(euler);
  target.multiply(deviceToCamera);
  target.multiply(screenQuat.setFromAxisAngle(zee, -THREE.MathUtils.degToRad(screenDeg)));
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

type PermissionRequestable = {
  requestPermission?: () => Promise<"granted" | "denied" | "prompt">;
};

/** Must be called from a user gesture — iOS rejects it anywhere else. */
export async function requestMotionPermission(): Promise<boolean> {
  const ctor = DeviceOrientationEvent as unknown as PermissionRequestable;
  if (typeof ctor.requestPermission !== "function") return true;
  return (await ctor.requestPermission()) === "granted";
}

export function screenAngle(): number {
  return screen.orientation?.angle ?? 0;
}

/** Attaches a deviceorientation listener; returns a detach function. */
export function onDeviceQuaternion(
  handler: (q: THREE.Quaternion, event: DeviceOrientationEvent) => void,
): () => void {
  const quaternion = new THREE.Quaternion();
  const listener = (event: DeviceOrientationEvent): void => {
    if (event.alpha === null || event.beta === null || event.gamma === null) return;
    deviceQuaternion(quaternion, event.alpha, event.beta, event.gamma, screenAngle());
    handler(quaternion, event);
  };
  window.addEventListener("deviceorientation", listener);
  return () => window.removeEventListener("deviceorientation", listener);
}
