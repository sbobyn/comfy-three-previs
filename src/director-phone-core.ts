import * as THREE from "three";
import { YawZero } from "./orientation";
import { OrientationSmoother, defaultSettings, type SmoothingSettings } from "./smoothing";
import { validPhoneMessage } from "../server/phone-protocol";
import type { Quat } from "./director-aim";

/**
 * DOM-free half of the phone aim source: everything that can be tested in Node.
 * The WebSocket, the rig heartbeat and the pairing dialog live in director-phone.ts.
 */

/** No sample for this long: hold the last aim and say "paused". */
export const PAUSED_AFTER_MS = 1000;
/** No sample for this long: stop aiming altogether (orientation() returns null). */
export const SILENT_AFTER_MS = 2000;

export type Motion = "none" | "streaming" | "paused" | "silent";
export type PhoneButton = "record" | "rezero";

export type Inbound =
  | { t: "presence"; controller: boolean; owner: boolean | null }
  | { t: "q"; q: Quat }
  | { t: "lens"; mm: number }
  | { t: "recenter" }
  | { t: "record" }
  | { t: "pause" }
  | { t: "pong"; id: number }
  | { t: "control" };

/**
 * Accepts only what the relay may forward: its own presence notice, or a phone
 * message that passes the same validator the relay uses. Anything else is null.
 */
export function parseInbound(text: string): Inbound | null {
  let message: any;
  try {
    message = JSON.parse(text);
  } catch {
    return null;
  }
  if (!message || typeof message !== "object") return null;
  if (message.t === "presence")
    return typeof message.controller === "boolean"
      ? { t: "presence", controller: message.controller, owner: typeof message.owner === "boolean" ? message.owner : null }
      : null;
  if (!validPhoneMessage(text)) return null;
  if (message.t === "q") return { t: "q", q: message.q };
  if (message.t === "lens") return { t: "lens", mm: message.mm };
  if (message.t === "pong") return { t: "pong", id: message.id };
  if (message.t === "control") return { t: "control" };
  return { t: message.t };
}

/** Yaw of a camera quaternion about world +Y (0 = looking down -Z). */
export function yawOf(q: Quat): number {
  return new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...q), "YXZ").y;
}

/** Pitch (+ looks up) of a camera quaternion, radians. */
export function pitchOf(q: Quat): number {
  return new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...q), "YXZ").x;
}

/** Rotates a zeroed phone aim so that "phone at zero" looks along `yaw`. */
export function withBaseYaw(q: Quat, yaw: number): Quat {
  const out = new THREE.Quaternion(...q).premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw));
  return out.toArray() as Quat;
}

/** Yaw that points a camera at `look` from `from` (three.js: forward is -Z). */
export function yawToward(from: [number, number, number], look: [number, number, number]): number {
  const dx = look[0] - from[0], dz = look[2] - from[2];
  return Math.hypot(dx, dz) < 1e-6 ? 0 : Math.atan2(-dx, -dz);
}

export class PhoneAim {
  socketOpen = false;
  phonePresent = false;
  /** null until the relay reports it (an older relay never does). */
  owner: boolean | null = null;
  halfRtt = Number.NaN;

  private readonly smoother = new OrientationSmoother();
  private readonly zero = new YawZero();
  private readonly raw = new THREE.Quaternion();
  private readonly smoothed = new THREE.Quaternion();
  private readonly scratch = new THREE.Quaternion();
  private hasSample = false;
  private zeroPending = true;
  private lastSample = 0;
  private lastEval = 0;
  private cached: Quat | null = null;
  private mm: number | null = null;
  private arrivals: number[] = [];
  private intervals: number[] = [];
  private pings = new Map<number, number>();
  private nextPing = 0;

  constructor(public settings: SmoothingSettings = defaultSettings()) {}

  /** Feeds one relay message; returns a phone button press, if it was one. */
  receive(text: string, now: number): PhoneButton | null {
    const m = parseInbound(text);
    if (!m) return null;
    switch (m.t) {
      case "presence":
        this.owner = m.owner;
        if (this.phonePresent && !m.controller) this.forget();
        this.phonePresent = m.controller;
        return null;
      case "q":
        this.sample(m.q, now);
        return null;
      case "lens":
        this.mm = m.mm;
        return null;
      case "recenter":
        this.rezero();
        return "rezero";
      case "record":
        return "record";
      case "pong": {
        const sent = this.pings.get(m.id);
        if (sent !== undefined) {
          this.halfRtt = (now - sent) / 2;
          this.pings.delete(m.id);
        }
        return null;
      }
      default:
        return null; // "pause" shows up as stalled samples; "control" sticks are not used for aim.
    }
  }

  /** Returns a ping id to send; the matching pong updates halfRtt. */
  ping(now: number): number {
    for (const [id, at] of this.pings) if (now - at > 5000) this.pings.delete(id);
    const id = ++this.nextPing;
    this.pings.set(id, now);
    return id;
  }

  private sample(q: Quat, now: number): void {
    this.scratch.set(...q).normalize();
    // Resuming after a stall: start from the new pose instead of swinging across.
    const stale = !this.hasSample || now - this.lastSample > PAUSED_AFTER_MS;
    this.raw.copy(this.scratch);
    if (stale) {
      this.smoother.reset(this.raw);
      this.smoothed.copy(this.raw);
      this.lastEval = now;
    }
    if (this.lastSample) this.intervals.push(now - this.lastSample);
    if (this.intervals.length > 120) this.intervals.splice(0, this.intervals.length - 120);
    this.arrivals.push(now);
    this.lastSample = now;
    this.hasSample = true;
    if (this.zeroPending) this.captureZero();
  }

  private captureZero(): void {
    // Zero against the smoothed pose so the very next output is exactly heading 0.
    this.zero.capture(this.smoothed);
    this.zeroPending = false;
    this.cached = null;
    this.lastEval = 0;
  }

  /** Yaw-only: pitch and roll come from gravity and stay absolute. */
  rezero(): void {
    if (this.hasSample) this.captureZero();
    else this.zeroPending = true;
  }

  lensMm(): number | null {
    return this.mm;
  }

  motion(now: number): Motion {
    if (!this.phonePresent || !this.hasSample) return "none";
    const age = now - this.lastSample;
    return age > SILENT_AFTER_MS ? "silent" : age > PAUSED_AFTER_MS ? "paused" : "streaming";
  }

  connected(): boolean {
    return this.socketOpen && this.phonePresent;
  }

  /** World-space camera orientation, smoothed and yaw-zeroed; null when not aiming. */
  orientation(now: number): Quat | null {
    const motion = this.motion(now);
    if (!this.socketOpen || motion === "none" || motion === "silent") return null;
    if (this.cached && now - this.lastEval < 1) return this.cached;
    const dt = this.lastEval ? Math.min(0.1, (now - this.lastEval) / 1000) : 0;
    if (dt > 0) this.smoother.apply(this.raw, dt, this.settings, this.smoothed);
    this.lastEval = now;
    const out = this.scratch.copy(this.smoothed);
    this.zero.apply(out);
    this.cached = out.normalize().toArray() as Quat;
    return this.cached;
  }

  stats(now: number) {
    this.arrivals = this.arrivals.filter((t) => now - t < 1000);
    const live = this.motion(now) === "streaming";
    let jitter = Number.NaN;
    if (live && this.intervals.length > 1) {
      const mean = this.intervals.reduce((s, v) => s + v, 0) / this.intervals.length;
      jitter = this.intervals.reduce((s, v) => s + Math.abs(v - mean), 0) / this.intervals.length;
    }
    return {
      rate: live ? this.arrivals.length : 0,
      jitter,
      lastSampleAge: this.hasSample ? now - this.lastSample : null,
      halfRtt: this.halfRtt,
    };
  }

  status(now: number): string {
    if (!this.socketOpen) return "Desktop link offline — is Comfy Three Previs running?";
    if (this.owner === false) return "Another Comfy Three Previs window is using the phone";
    if (!this.phonePresent) return "No phone connected";
    const motion = this.motion(now);
    if (motion === "none") return "Phone connected — tap Enable motion on the phone";
    if (motion === "silent") return "Motion stopped — wake the phone and tap Enable again";
    if (motion === "paused") return "Motion paused";
    return `Streaming motion · ${this.stats(now).rate} Hz`;
  }

  /** The socket closed: keep the zero/lens but drop everything live. */
  disconnected(): void {
    this.socketOpen = false;
    this.owner = null;
    this.phonePresent = false;
    this.forget();
  }

  private forget(): void {
    this.hasSample = false;
    this.lastSample = 0;
    this.cached = null;
    this.arrivals = [];
    this.intervals = [];
    // The next phone (or the same one re-enabled) zeroes on its first sample.
    this.zeroPending = true;
  }
}
