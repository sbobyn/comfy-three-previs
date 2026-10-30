// Procedural terrain for blockouts: a valley floor ringed by mountains. Deterministic (seeded), shared by the
// browser (mesh) and scripts/agents (to stand objects on the ground). Heights are in metres, world space.
const hash = (x, z, s) => { const n = Math.sin(x * 127.1 + z * 311.7 + s * 74.7) * 43758.5453; return n - Math.floor(n); };
function noise(x, z, s) {
  const xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  const a = hash(xi, zi, s), b = hash(xi + 1, zi, s), c = hash(xi, zi + 1, s), d = hash(xi + 1, zi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
// Smooth fractal noise in 0..1, and softened ridges (rounded crests, no needle spikes).
const fbm = (x, z, s, oct = 4) => { let f = 0, amp = 0.5, fr = 1, n = 0; for (let o = 0; o < oct; o++) { f += amp * noise(x * fr, z * fr, s + o); n += amp; amp *= 0.5; fr *= 2.01; } return f / n; };
const ridge = (x, z, s) => { let f = 0, amp = 0.6, fr = 1; for (let o = 0; o < 3; o++) { const r = 1 - Math.abs(noise(x * fr, z * fr, s + 20 + o) * 2 - 1); f += amp * r * r; amp *= 0.45; fr *= 2.1; } return f; };
const smooth = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
/** Height at world (x, z) for a terrain entity t ({position, scale, terrain?: {seed, valley, peak}}). */
export function terrainHeight(t, x, z) {
  const o = t.terrain || {}, seed = o.seed ?? 7, valley = o.valley ?? 75, peak = o.peak ?? 150;
  const lx = (x - t.position[0]) / (t.scale?.[0] || 1), lz = (z - t.position[2]) / (t.scale?.[2] || 1);
  const r = Math.hypot(lx * 0.9, lz + 20);                    // valley centred a little north of the origin
  const floor = (noise(lx / 25, lz / 25, seed + 9) - 0.5) * 1.2; // gentle meadow undulation (unchanged: props sit on it)
  // Rolling foothills just past the valley floor, then the range proper further out.
  const hillsMask = smooth(valley, valley + 45, r), rangeMask = smooth(valley + 25, valley + 150, r);
  const hills = (fbm(lx / 45, lz / 45, seed + 3) - 0.35) * 22 * hillsMask;
  const lift = 0.6 * peak * smooth(valley, valley + 130, r); // the broad rise out of the valley (props on the lower slopes rely on it)
  const range = rangeMask * peak * (0.08 + 0.3 * fbm(lx / 120, lz / 120, seed + 5, 3) + 0.2 * ridge(lx / 90, lz / 90, seed));
  // A handful of distinct summits around the ring (deterministic per seed).
  let summits = 0;
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2 + hash(k, 1, seed) * 0.9, R = valley + 120 + hash(k, 2, seed) * 40;
    const px = Math.cos(a) * R / 0.9, pz = Math.sin(a) * R - 20, sig = 38 + hash(k, 3, seed) * 22;
    const d2 = (lx - px) ** 2 + (lz - pz) ** 2;
    summits += peak * (0.45 + 0.35 * hash(k, 4, seed)) * Math.exp(-d2 / (2 * sig * sig));
  }
  const mountains = Math.max(0, lift + hills + range + summits * rangeMask);
  return t.position[1] + (floor * (1 - hillsMask) + mountains) * (t.scale?.[1] || 1);
}
/** Ground height under (x, z) from the scene's terrain objects (0 when there is none). */
export function groundAt(entities, x, z) {
  let h = 0; for (const t of entities) if (t.shape === 'terrain') h = Math.max(h, terrainHeight(t, x, z)); return h;
}
