import * as THREE from "three";

/**
 * A position source sampled by normalised progress. Built-in paths are curves
 * walked by arc length, which deliberately gives constant speed. Flown tracks
 * are sampled by *time* instead: resampling one onto a curve would replay it at
 * uniform speed and discard the acceleration and coasting the flight model
 * produced, which is the very thing that makes a flown move read as aerial.
 */
export type PathSource = {
  sample: (u: number, out: THREE.Vector3) => void;
  points: (divisions: number) => THREE.Vector3[];
};

export type Demo = {
  id: string;
  label: string;
  /** null keeps the camera parked or hands position to the flight model. */
  path: PathSource | null;
  /** Seconds for one full traverse. */
  duration: number;
};

export type FlightSample = { t: number; p: [number, number, number] };

const clamp01 = (u: number): number => Math.min(1, Math.max(0, u));

export function curveSource(curve: THREE.Curve<THREE.Vector3>): PathSource {
  return {
    sample: (u, out) => {
      curve.getPointAt(clamp01(u), out);
    },
    points: (divisions) => curve.getPoints(divisions),
  };
}

export function trackSource(samples: FlightSample[]): PathSource {
  const duration = samples[samples.length - 1].t;
  let cursor = 0;

  const sample = (u: number, out: THREE.Vector3): void => {
    const time = clamp01(u) * duration;
    if (cursor >= samples.length - 1 || samples[cursor].t > time) cursor = 0;
    while (cursor < samples.length - 2 && samples[cursor + 1].t <= time) cursor += 1;

    const a = samples[cursor];
    const b = samples[cursor + 1] ?? a;
    const span = b.t - a.t;
    const mix = span > 0 ? Math.min(1, (time - a.t) / span) : 0;
    out.set(
      a.p[0] + (b.p[0] - a.p[0]) * mix,
      a.p[1] + (b.p[1] - a.p[1]) * mix,
      a.p[2] + (b.p[2] - a.p[2]) * mix,
    );
  };

  return {
    sample,
    points: (divisions) => {
      const out: THREE.Vector3[] = [];
      for (let i = 0; i <= divisions; i += 1) {
        const point = new THREE.Vector3();
        sample(i / divisions, point);
        out.push(point);
      }
      return out;
    },
  };
}

const v = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

function arcAroundSubject(): THREE.CatmullRomCurve3 {
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= 8; i += 1) {
    const angle = Math.PI * (0.16 + (i / 8) * 0.68);
    points.push(v(Math.cos(angle) * 15, 1.8, -11 + Math.sin(angle) * 15));
  }
  return new THREE.CatmullRomCurve3(points);
}

export const demos: Demo[] = [
  { id: "locked", label: "Locked off", path: null, duration: 0 },
  // Position comes from the flight model rather than a path; the transport has
  // nothing to play, which is why this carries no curve.
  { id: "pilot", label: "Pilot · free flight", path: null, duration: 0 },
  {
    id: "track",
    label: "Dolly · straight track",
    path: curveSource(new THREE.LineCurve3(v(-18, 1.7, 5), v(18, 1.7, 5))),
    duration: 14,
  },
  {
    id: "arc",
    label: "Dolly · arc around subject",
    path: curveSource(arcAroundSubject()),
    duration: 16,
  },
  {
    id: "crane",
    label: "Crane · rise and push",
    path: curveSource(
      new THREE.CatmullRomCurve3([v(10, 0.9, 9), v(6, 2.4, 6), v(1.5, 4.6, 2), v(-2, 6.8, -1.5)]),
    ),
    duration: 12,
  },
];

let flownCount = 0;

/** Registers a flown take as a selectable position source for the gimbal pass. */
export function addFlownDemo(samples: FlightSample[]): Demo {
  flownCount += 1;
  const demo: Demo = {
    id: `flown-${flownCount}`,
    label: `Flown ${flownCount}`,
    path: trackSource(samples),
    duration: samples[samples.length - 1].t,
  };
  demos.push(demo);
  return demo;
}

export function demoById(id: string): Demo {
  return demos.find((demo) => demo.id === id) ?? demos[0];
}
