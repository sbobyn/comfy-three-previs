import * as THREE from "three";

/** Normalised stick/key demands, each -1..1. */
export type FlightInput = {
  forward: number;
  lateral: number;
  vertical: number;
  yaw: number;
  pitch?: number;
};

export type FlightSettings = {
  maxSpeed: number; // horizontal, m/s
  climbSpeed: number; // m/s
  responseTime: number; // seconds to shed ~63% of the gap to demanded velocity
  yawRate: number; // deg/s
  bank: number; // max visual bank, degrees
  tilt: number; // fixed camera tilt while piloting, degrees (negative looks down)
};

export function defaultFlightSettings(): FlightSettings {
  return { maxSpeed: 9, climbSpeed: 4, responseTime: 0.55, yawRate: 80, bank: 16, tilt: -8 };
}

export function noInput(): FlightInput {
  return { forward: 0, lateral: 0, vertical: 0, yaw: 0 };
}

const euler = new THREE.Euler();

/**
 * A drone, not a free-fly camera. Input sets a demanded velocity that the actual
 * velocity chases with a time constant, so the rig accelerates, coasts and
 * overshoots — that mass is what makes a recorded move read as aerial rather
 * than as a mouse drag. Heading is integrated from yaw rather than derived from
 * travel, because a drone points where it is yawed and can strafe sideways.
 */
export class Drone {
  readonly position = new THREE.Vector3(0, 6, 20);
  heading = 0;
  bankAngle = 0;
  private pitch: number | null = null;

  private readonly velocity = new THREE.Vector3();
  private readonly demand = new THREE.Vector3();

  get speed(): number {
    return this.velocity.length();
  }

  adopt(position: THREE.Vector3, quaternion: THREE.Quaternion): void {
    this.position.copy(position);
    euler.setFromQuaternion(quaternion, "YXZ");
    this.heading = euler.y; this.pitch = euler.x; this.bankAngle = euler.z; this.halt();
  }

  halt(): void { this.velocity.set(0, 0, 0); }

  reset(): void {
    this.position.set(0, 6, 20);
    this.heading = 0;
    this.pitch = null;
    this.bankAngle = 0;
    this.velocity.set(0, 0, 0);
  }

  update(input: FlightInput, dt: number, settings: FlightSettings): void {
    dt = Math.min(0.05, Math.max(0, dt));
    if (this.pitch !== null) this.pitch = THREE.MathUtils.clamp(this.pitch + (input.pitch || 0) * THREE.MathUtils.degToRad(60) * dt, -Math.PI * 85 / 180, Math.PI * 85 / 180);
    this.heading -= input.yaw * THREE.MathUtils.degToRad(settings.yawRate) * dt;

    // Heading basis: a camera looks down its own -Z.
    const forwardX = -Math.sin(this.heading);
    const forwardZ = -Math.cos(this.heading);
    const rightX = Math.cos(this.heading);
    const rightZ = -Math.sin(this.heading);

    this.demand.set(
      (forwardX * input.forward + rightX * input.lateral) * settings.maxSpeed,
      input.vertical * settings.climbSpeed,
      (forwardZ * input.forward + rightZ * input.lateral) * settings.maxSpeed,
    );

    const blend = 1 - Math.exp(-dt / Math.max(settings.responseTime, 0.01));

    // Bank follows the velocity the rig is still trying to gain, which is what a
    // real airframe tilts into — using current sideways speed would keep it
    // banked through a steady strafe instead of only while changing.
    const lateralDemand =
      (this.demand.x - this.velocity.x) * rightX + (this.demand.z - this.velocity.z) * rightZ;
    const targetBank =
      -THREE.MathUtils.clamp(lateralDemand / Math.max(settings.maxSpeed, 0.001), -1, 1) *
      THREE.MathUtils.degToRad(settings.bank);
    this.bankAngle += (targetBank - this.bankAngle) * (1 - Math.exp(-dt / 0.3));

    this.velocity.lerp(this.demand, blend);
    this.position.addScaledVector(this.velocity, dt);
    this.position.y = Math.max(0.4, this.position.y);
  }

  orientation(out: THREE.Quaternion, settings: FlightSettings): THREE.Quaternion {
    euler.set(this.pitch ?? THREE.MathUtils.degToRad(settings.tilt), this.heading, this.bankAngle, "YXZ");
    return out.setFromEuler(euler);
  }
}
