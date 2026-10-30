// Procedural terrain for blockouts: a valley floor ringed by mountains. Deterministic (seeded), shared by the
// browser (mesh) and scripts/agents (to stand objects on the ground). Heights are in metres, world space.
const hash = (x, z, s) => { const n = Math.sin(x * 127.1 + z * 311.7 + s * 74.7) * 43758.5453; return n - Math.floor(n); };
function noise(x, z, s) {
  const xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  const a = hash(xi, zi, s), b = hash(xi + 1, zi, s), c = hash(xi, zi + 1, s), d = hash(xi + 1, zi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const ridged = (x, z, s) => { let f = 0, amp = 0.55, fr = 1; for (let o = 0; o < 5; o++) { f += amp * (1 - Math.abs(noise(x * fr, z * fr, s + o) * 2 - 1)); amp *= 0.5; fr *= 2.03; } return f; };
/** Height at world (x, z) for a terrain entity t ({position, scale, terrain?: {seed, valley, peak}}). */
export function terrainHeight(t, x, z) {
  const o = t.terrain || {}, seed = o.seed ?? 7, valley = o.valley ?? 75, peak = o.peak ?? 150;
  const lx = (x - t.position[0]) / (t.scale?.[0] || 1), lz = (z - t.position[2]) / (t.scale?.[2] || 1);
  const r = Math.hypot(lx * 0.9, lz + 20);                    // valley centred a little north of the origin
  const rise = Math.min(1, Math.max(0, (r - valley) / 130)); // 0 on the valley floor → 1 up in the peaks
  const shape = rise * rise * (3 - 2 * rise);
  const rough = ridged(lx / 70, lz / 70, seed);
  const floor = (noise(lx / 25, lz / 25, seed + 9) - 0.5) * 1.2; // gentle meadow undulation
  return t.position[1] + (floor * (1 - shape) + shape * peak * (0.45 + 0.75 * rough)) * (t.scale?.[1] || 1);
}
/** Ground height under (x, z) from the scene's terrain objects (0 when there is none). */
export function groundAt(entities, x, z) {
  let h = 0; for (const t of entities) if (t.shape === 'terrain') h = Math.max(h, terrainHeight(t, x, z)); return h;
}
