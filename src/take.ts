import * as THREE from "three";

type Sample = { t: number; q: [number, number, number, number] };

/**
 * Stores raw, unsmoothed samples. Smoothing is applied downstream on playback so
 * the same recorded move can be replayed through different settings — baking it
 * in at capture would make the parameters impossible to compare.
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

  push(now: number, q: THREE.Quaternion): void {
    if (!this.recording) return;
    this.samples.push({ t: now - this.startedAt, q: [q.x, q.y, q.z, q.w] });
  }

  rewind(): void {
    this.cursor = 0;
  }

  sampleAt(time: number, out: THREE.Quaternion): boolean {
    if (this.samples.length === 0) return false;
    if (time <= 0) {
      const [x, y, z, w] = this.samples[0].q;
      out.set(x, y, z, w);
      return true;
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
    if (span > 0) {
      const next = new THREE.Quaternion(b.q[0], b.q[1], b.q[2], b.q[3]);
      out.slerp(next, Math.min(1, (time - a.t) / span));
    }
    return true;
  }
}
