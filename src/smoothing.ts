import * as THREE from "three";

export type SmoothingSettings = {
  deshake: boolean;
  minCutoff: number; // Hz — lower smooths harder while the operator holds still
  beta: number; // how aggressively the cutoff opens up as the phone speeds up
  inertia: boolean;
  halfLife: number; // seconds for the remaining error to halve
};

export function defaultSettings(): SmoothingSettings {
  return { deshake: true, minCutoff: 1.2, beta: 0.05, inertia: true, halfLife: 0.08 };
}

function alphaFor(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

/**
 * Two deliberately different stages:
 *
 * Deshake is a One Euro filter adapted to quaternions — its cutoff rises with
 * angular speed, so it kills hand tremor while the operator holds a frame
 * without adding lag to a fast whip. A fixed low-pass cannot do both.
 *
 * Inertia is the opposite: a constant exponential lag that makes the head feel
 * like it has mass. It is first-order, not a real spring, so it settles without
 * overshoot — a geared head, not a counterweighted one.
 */
export class OrientationSmoother {
  private readonly deshaken = new THREE.Quaternion();
  private readonly inertial = new THREE.Quaternion();
  private readonly previousRaw = new THREE.Quaternion();
  private speed = 0;
  private primed = false;

  reset(q: THREE.Quaternion): void {
    this.deshaken.copy(q);
    this.inertial.copy(q);
    this.previousRaw.copy(q);
    this.speed = 0;
    this.primed = true;
  }

  apply(
    raw: THREE.Quaternion,
    dt: number,
    settings: SmoothingSettings,
    out: THREE.Quaternion,
  ): THREE.Quaternion {
    if (!this.primed || dt <= 0) {
      this.reset(raw);
      return out.copy(raw);
    }

    let stage = raw;
    if (settings.deshake) {
      const dot = Math.min(1, Math.abs(this.previousRaw.dot(raw)));
      const instantaneous = (2 * Math.acos(dot)) / dt;
      this.speed += alphaFor(1, dt) * (instantaneous - this.speed);
      this.deshaken.slerp(raw, alphaFor(settings.minCutoff + settings.beta * this.speed, dt));
      stage = this.deshaken;
    } else {
      // Keep the disabled stage tracking, so re-enabling it does not snap.
      this.deshaken.copy(raw);
    }
    this.previousRaw.copy(raw);

    if (settings.inertia) {
      this.inertial.slerp(stage, 1 - Math.pow(2, -dt / Math.max(settings.halfLife, 0.001)));
      return out.copy(this.inertial);
    }
    this.inertial.copy(stage);
    return out.copy(stage);
  }
}
