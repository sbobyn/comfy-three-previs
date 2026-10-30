import * as THREE from "three";

type Sample = {
  t: number;
  q: [number, number, number, number];
  u: number;
  mm: number;
};

export type Playhead = { u: number; mm: number };

/**
 * Stores raw, unsmoothed samples plus the rig state they were shot at. Smoothing
 * is applied downstream on playback so the same recorded move can be replayed
 * through different settings, but dolly position and focal length travel with
 * each sample: a zoom and a dolly move are part of the shot, and replaying head
 * movement without them would reproduce something the operator never performed.
 */
export class Take {
  private samples: Sample[] = [];
  private startedAt = 0;
  private cursor = 0;
  private recording = false;

  get isRecording(): boolean {
    return this.recording;
  }

  get count(): number {
    return this.samples.length;
  }

  get duration(): number {
    return this.samples.length > 0 ? this.samples[this.samples.length - 1].t : 0;
  }

  start(now: number): void {
    this.samples = [];
    this.startedAt = now;
    this.recording = true;
  }

  stop(): void {
    this.recording = false;
  }

  push(now: number, q: THREE.Quaternion, u: number, mm: number): void {
    if (!this.recording) return;
    this.samples.push({ t: now - this.startedAt, q: [q.x, q.y, q.z, q.w], u, mm });
  }

  rewind(): void {
    this.cursor = 0;
  }

  /** Writes orientation into `out` and returns the rig state at that instant. */
  sampleAt(time: number, out: THREE.Quaternion): Playhead | null {
    if (this.samples.length === 0) return null;
    if (time <= 0) {
      const first = this.samples[0];
      out.set(first.q[0], first.q[1], first.q[2], first.q[3]);
      return { u: first.u, mm: first.mm };
    }

    if (this.cursor >= this.samples.length - 1 || this.samples[this.cursor].t > time) {
      this.cursor = 0;
    }
    while (this.cursor < this.samples.length - 2 && this.samples[this.cursor + 1].t <= time) {
      this.cursor += 1;
    }

    const a = this.samples[this.cursor];
    const b = this.samples[this.cursor + 1] ?? a;
    const span = b.t - a.t;
    out.set(a.q[0], a.q[1], a.q[2], a.q[3]);
    if (span <= 0) return { u: a.u, mm: a.mm };

    const mix = Math.min(1, (time - a.t) / span);
    out.slerp(new THREE.Quaternion(b.q[0], b.q[1], b.q[2], b.q[3]), mix);
    return { u: a.u + (b.u - a.u) * mix, mm: a.mm + (b.mm - a.mm) * mix };
  }
}
