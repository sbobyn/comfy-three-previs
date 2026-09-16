import * as THREE from "three";

export type Demo = {
  id: string;
  label: string;
  /** null keeps the camera parked — the locked-off case for judging smoothing alone. */
  path: THREE.Curve<THREE.Vector3> | null;
  /** Seconds for one full traverse. */
  duration: number;
};

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
    path: new THREE.LineCurve3(v(-18, 1.7, 5), v(18, 1.7, 5)),
    duration: 14,
  },
  { id: "arc", label: "Dolly · arc around subject", path: arcAroundSubject(), duration: 16 },
  {
    id: "crane",
    label: "Crane · rise and push",
    path: new THREE.CatmullRomCurve3([
      v(10, 0.9, 9),
      v(6, 2.4, 6),
      v(1.5, 4.6, 2),
      v(-2, 6.8, -1.5),
    ]),
    duration: 12,
  },
];

export function demoById(id: string): Demo {
  return demos.find((demo) => demo.id === id) ?? demos[0];
}
