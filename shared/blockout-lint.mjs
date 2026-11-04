// Coplanar-surface lint for blockouts. Two surfaces that face the same way, lie in the same plane (within a
// millimetre) and overlap make the depth test flip between them pixel by pixel: z-fighting. It shows as stripes,
// speckles or shimmering in the viewport and in every blockout frame, and image/video models copy it.
//
// lintMesh checks one model (a GLB's triangles); lintScene checks placed entities against each other, in world
// metres, with each entity's own position, rotation and (non-uniform) scale. Surfaces that would draw the same
// pixel whichever wins (same material, same colour, same facing) are not reported: they cannot flicker. Nor are two
// downward faces that are both the very bottom of their objects (two things standing on one floor): the floor hides them.
// The fix is always geometric: cut or merge the overlap, or lift the decal/line off the surface along its normal by
// COPLANAR.decalOffset (2 mm). Rules for people and agents: docs/blockout-modeling-rules.md.
import { SHAPES } from './director.mjs';
import { blockoutModel, projectMesh } from './blockout-models.mjs';
import { terrainHeight } from './terrain.mjs';

export const COPLANAR = Object.freeze({
  /** Same-facing surfaces closer than this along their normal (metres) count as one plane. */
  tolerance: 0.001,
  /** Overlap smaller than this (square metres, 1 mm²) is a shared edge, not a shared surface. */
  minArea: 1e-6,
  /** Normals within this angle (degrees) face the same way. */
  angle: 0.5,
  /** The gap a decal, line or panel keeps from the surface it sits on (metres). */
  decalOffset: 0.002,
});

// ---------- small vector/matrix helpers (column-major 4×4, like glTF and three.js) ----------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = a => Math.hypot(a[0], a[1], a[2]);
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
const apply = (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
function compose(t = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1]) {
  const [x, y, z, w] = q, x2 = x + x, y2 = y + y, z2 = z + z, xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  return [(1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0, (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0, (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0, t[0], t[1], t[2], 1];
}
const rad = d => (d * Math.PI) / 180;
/** An entity's world matrix, as the viewport places it: translate · Ry(yaw) · Rx(pitch) · Rz(roll) · scale. */
export function entityMatrix(e) {
  const [a, b, c] = [rad(e.pitch || 0), rad(e.rotation || 0), rad(e.roll || 0)];
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cc = Math.cos(c), sc = Math.sin(c);
  // three.js Euler order 'YXZ' (x = pitch, y = yaw, z = roll).
  const r = [cb * cc + sb * sa * sc, ca * sc, -sb * cc + cb * sa * sc, 0, -cb * sc + sb * sa * cc, ca * cc, sb * sc + cb * sa * cc, 0, sb * ca, -sa, cb * ca, 0, 0, 0, 0, 1];
  const s = e.scale || [1, 1, 1];
  return mul([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ...(e.position || [0, 0, 0]), 1], mul(r, [s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0, 0, 0, 0, 1]));
}

// ---------- GLB ----------
const COMPONENTS = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const hex = rgb => '#' + rgb.slice(0, 3).map(c => Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)).toString(16).padStart(2, '0')).join('');
/**
 * Triangles of a binary glTF (node transforms applied), grouped by primitive:
 * [{ material: name, color: '#rrggbb' (sRGB), triangles: [[x,y,z]×3, …] }]. Throws on anything that is not a GLB.
 */
export function parseGlb(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes);
  if (buf.length < 28 || buf.readUInt32LE(0) !== 0x46546c67) throw Error('Not a GLB');
  const jsonLength = buf.readUInt32LE(12), g = JSON.parse(buf.toString('utf8', 20, 20 + jsonLength));
  const binStart = 20 + jsonLength + 8;
  const read = i => {
    const a = g.accessors[i], v = g.bufferViews[a.bufferView], T = COMPONENTS[a.componentType], n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type], size = T.BYTES_PER_ELEMENT;
    const stride = v.byteStride || size * n, start = binStart + (v.byteOffset || 0) + (a.byteOffset || 0), out = new Array(a.count * n);
    const get = size === 4 ? (T === Float32Array ? o => buf.readFloatLE(o) : o => buf.readUInt32LE(o)) : size === 2 ? o => buf.readUInt16LE(o) : o => buf.readUInt8(o);
    for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) out[k * n + c] = get(start + k * stride + c * size);
    return out;
  };
  const out = [];
  const visit = (index, parent) => {
    const node = g.nodes[index];
    const m = mul(parent, node.matrix || compose(node.translation, node.rotation, node.scale));
    if (node.mesh !== undefined) for (const p of g.meshes[node.mesh].primitives) {
      if ((p.mode ?? 4) !== 4) continue;
      const pos = read(p.attributes.POSITION), idx = p.indices !== undefined ? read(p.indices) : [...Array(pos.length / 3).keys()];
      const mat = g.materials?.[p.material] || {}, triangles = [];
      for (let k = 0; k + 2 < idx.length; k += 3) triangles.push([0, 1, 2].map(j => apply(m, pos.slice(idx[k + j] * 3, idx[k + j] * 3 + 3))));
      out.push({ material: mat.name || `material-${p.material ?? 0}`, color: hex(mat.pbrMetallicRoughness?.baseColorFactor || [1, 1, 1, 1]), triangles });
    }
    for (const c of node.children || []) visit(c, m);
  };
  for (const n of g.scenes?.[g.scene ?? 0]?.nodes || []) visit(n, IDENTITY);
  return out;
}

// ---------- the check ----------
/**
 * Same-facing, overlapping, coplanar triangle pairs, grouped per (owner pair, material pair, plane).
 * tris: [{ v: [[x,y,z]×3], owner, look }] in metres; `look` is the appearance key (material + colour).
 * pairs: 'all' | 'between' (different owners only) | 'within' (same owner only). focus: owners at least one side must have.
 */
export function findCoplanar(tris, { tolerance = COPLANAR.tolerance, minArea = COPLANAR.minArea, angle = COPLANAR.angle, pairs = 'all', focus = null, limit = 50 } = {}) {
  const cosSame = Math.cos(rad(angle)), cosCluster = Math.cos(rad(Math.max(1, angle * 2)));
  const clusters = [], buckets = new Map(), Q = 24, floor = new Map();
  const keyOf = n => n.map(c => Math.round(c * Q));
  for (const t of tris) floor.set(t.owner, Math.min(floor.get(t.owner) ?? Infinity, t.v[0][1], t.v[1][1], t.v[2][1]));
  for (const t of tris) {
    const [a, b, c] = t.v, cr = cross(sub(b, a), sub(c, a)), l = len(cr);
    if (!(l / 2 > minArea / 100)) continue; // degenerate
    const n = cr.map(x => x / l), k = keyOf(n);
    const base = n[1] < -cosSame && t.v.every(q => q[1] <= floor.get(t.owner) + tolerance);
    let home = null;
    for (let dx = -1; dx <= 1 && !home; dx++) for (let dy = -1; dy <= 1 && !home; dy++) for (let dz = -1; dz <= 1 && !home; dz++) {
      for (const ci of buckets.get(`${k[0] + dx},${k[1] + dy},${k[2] + dz}`) || []) if (dot(clusters[ci].n, n) >= cosCluster) { home = clusters[ci]; break; }
    }
    if (!home) { home = { n, items: [] }; clusters.push(home); const key = k.join(','); buckets.set(key, [...(buckets.get(key) || []), clusters.length - 1]); }
    home.items.push({ t, n, d: dot(n, a), base });
  }
  const groups = new Map();
  for (const cl of clusters) {
    if (cl.items.length < 2) continue;
    // A basis in the cluster plane: (u, v) across it, N along it.
    const N = cl.n, helper = Math.abs(N[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], U0 = cross(helper, N), U = U0.map(x => x / len(U0)), V = cross(N, U);
    const items = cl.items.map(it => {
      const p = it.t.v.map(q => [dot(q, U), dot(q, V)]);
      // Signed area so every 2D triangle is counter-clockwise for clipping.
      const s = (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[2][0] - p[0][0]) * (p[1][1] - p[0][1]);
      if (s < 0) p.reverse();
      const nN = dot(it.n, N), nu = dot(it.n, U), nv = dot(it.n, V);
      const xs = p.map(q => q[0]), ys = p.map(q => q[1]), hs = it.t.v.map(q => dot(q, N));
      return { ...it, p, h: (u, v) => (it.d - u * nu - v * nv) / nN, box: [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys), Math.min(...hs), Math.max(...hs)] };
    }).sort((a, b) => a.box[0] - b.box[0]);
    const active = [];
    for (const A of items) {
      for (let i = active.length - 1; i >= 0; i--) if (active[i].box[1] < A.box[0]) active.splice(i, 1);
      for (const B of active) {
        const ta = A.t, tb = B.t;
        if (ta.look === tb.look || (A.base && B.base)) continue;
        if (pairs === 'between' && ta.owner === tb.owner) continue;
        if (pairs === 'within' && ta.owner !== tb.owner) continue;
        if (focus && !focus.has(ta.owner) && !focus.has(tb.owner)) continue;
        if (dot(A.n, B.n) < cosSame) continue;
        if (A.box[2] > B.box[3] || B.box[2] > A.box[3] || A.box[4] > B.box[5] + tolerance || B.box[4] > A.box[5] + tolerance) continue;
        const poly = clip(A.p, B.p), area = polygonArea(poly);
        if (area < minArea) continue;
        let gap = 0;
        for (const [u, v] of poly) gap = Math.max(gap, Math.abs(A.h(u, v) - B.h(u, v)));
        if (gap > tolerance) continue;
        const [first, second] = String(ta.owner) + ta.look <= String(tb.owner) + tb.look ? [ta, tb] : [tb, ta];
        const key = `${first.owner}|${second.owner}|${first.look}|${second.look}|${N.map(x => x.toFixed(2))}|${Math.round(A.d / 0.01)}`;
        const [cu, cv] = poly.reduce((s, q) => [s[0] + q[0] / poly.length, s[1] + q[1] / poly.length], [0, 0]), ch = A.h(cu, cv);
        const at = [0, 1, 2].map(i => cu * U[i] + cv * V[i] + ch * N[i]);
        const g = groups.get(key);
        if (g) { g.area += area; g.gap = Math.max(g.gap, gap); }
        else groups.set(key, { a: { owner: first.owner, look: first.look }, b: { owner: second.owner, look: second.look }, normal: A.n.map(x => Math.round(x * 1000) / 1000), area, gap, at });
      }
      active.push(A);
    }
  }
  return [...groups.values()].sort((x, y) => y.area - x.area).slice(0, limit).map(f => ({ ...f, area: round(f.area, 1e6), gap: round(f.gap, 1e6), at: f.at.map(x => round(x, 1000)) }));
}
const round = (x, k) => Math.round(x * k) / k;
function polygonArea(p) { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; } return Math.abs(s) / 2; }
/** Sutherland–Hodgman: the part of convex polygon `subject` inside convex counter-clockwise polygon `by`. */
function clip(subject, by) {
  let out = subject;
  for (let i = 0; i < by.length && out.length; i++) {
    const a = by[i], b = by[(i + 1) % by.length], inside = p => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0;
    const cut = (p, q) => { const dx = q[0] - p[0], dy = q[1] - p[1], ex = b[0] - a[0], ey = b[1] - a[1], den = ex * dy - ey * dx; const t = den ? (ey * (p[0] - a[0]) - ex * (p[1] - a[1])) / den : 0; return [p[0] + t * dx, p[1] + t * dy]; };
    const input = out; out = [];
    for (let j = 0; j < input.length; j++) {
      const p = input[j], q = input[(j + 1) % input.length], pi = inside(p), qi = inside(q);
      if (pi) out.push(p);
      if (pi !== qi) out.push(cut(p, q));
    }
  }
  return out;
}

// ---------- models and entities ----------
const boxTris = (x0, x1, y0, y1, z0, z1) => {
  const P = (i) => [i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? z1 : z0];
  // Outward-facing quads as two triangles each.
  return [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]].flatMap(([a, b, c, d]) => [[P(a), P(b), P(c)], [P(a), P(c), P(d)]]);
};
function prismTris(r, h, n = 24) {
  const out = [], at = (i, y) => [r * Math.sin((i / n) * Math.PI * 2), y, r * Math.cos((i / n) * Math.PI * 2)];
  for (let i = 0; i < n; i++) {
    out.push([[0, h, 0], at(i, h), at(i + 1, h)], [[0, 0, 0], at(i + 1, 0), at(i, 0)]);
    out.push([at(i, 0), at(i + 1, 0), at(i + 1, h)], [at(i, 0), at(i + 1, h), at(i, h)]);
  }
  return out;
}
/** The flat faces of a primitive proxy (no model) in its own units; round shapes contribute none. */
export function primitiveTriangles(shape) {
  const [w, h, d] = SHAPES[shape]?.size || [1, 1, 1];
  switch (shape) {
    case 'box': case 'building': case 'wall': return boxTris(-w / 2, w / 2, 0, h, -d / 2, d / 2);
    case 'cylinder': return prismTris(w / 2, h);
    case 'table': return boxTris(-w / 2, w / 2, h - 0.06, h, -d / 2, d / 2);
    case 'chair': return [...boxTris(-w / 2, w / 2, 0.42, 0.48, -d / 2, d / 2), ...boxTris(-w / 2, w / 2, 0.475, 0.925, -d / 2 + 0.005, -d / 2 + 0.055)];
    case 'terrain': {
      const out = [], n = 48, base = { position: [0, 0, 0], scale: [1, 1, 1] }, P = (i, j) => { const x = -w / 2 + (w * i) / n, z = -d / 2 + (d * j) / n; return [x, terrainHeight(base, x, z), z]; };
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) out.push([P(i, j), P(i, j + 1), P(i + 1, j)], [P(i + 1, j), P(i, j + 1), P(i + 1, j + 1)]);
      return out;
    }
    default: return [];
  }
}

/**
 * One entity's surfaces in world metres. meshOf(modelId) returns parseGlb output for its display model (bundled id
 * or project mesh path) or null when it is not available, in which case the primitive proxy stands in.
 */
export function entityTriangles(e, { meshOf = () => null } = {}) {
  // Imported models (docs/import.md) are whole assets, not blockout surfaces: never linted, never lifted.
  if (e.shape === 'group' || e.source) return [];
  const m = entityMatrix(e), id = blockoutModel(e), parts = id ? meshOf(id) : null;
  const out = [], tint = e.color || SHAPES[e.shape]?.color || '#ffffff';
  if (parts) {
    // Project meshes have unit bounds and are fitted to the proxy size; bundled meshes are authored at that size.
    const fit = projectMesh(id) ? SHAPES[e.shape].size : [1, 1, 1];
    for (const p of parts) {
      const look = `${p.material}|${p.material === 'entity-color' ? tint : p.color}`;
      for (const t of p.triangles) out.push({ v: t.map(q => apply(m, [q[0] * fit[0], q[1] * fit[1], q[2] * fit[2]])), owner: e.id, look });
    }
    return out;
  }
  for (const t of primitiveTriangles(e.shape)) out.push({ v: t.map(q => apply(m, q)), owner: e.id, look: `primitive|${tint}` });
  return out;
}

/** Coplanar overlaps inside one model. scale stretches it first (an entity scale); units are metres after scaling. */
export function lintMesh(parts, { scale = [1, 1, 1], ...opts } = {}) {
  const tris = parts.flatMap(p => p.triangles.map(t => ({ v: t.map(q => [q[0] * scale[0], q[1] * scale[1], q[2] * scale[2]]), owner: 'mesh', look: `${p.material}|${p.color}` })));
  return findCoplanar(tris, { ...opts, pairs: 'within' });
}

/**
 * Coplanar overlaps between placed entities (and, with within: true, inside each one). only: ids of entities that
 * were just added or moved; then only pairs involving one of them are reported. Entities are checked at rest
 * (their own position, not along an animation path).
 */
export function lintScene(entities, { meshOf, only = null, within = false, ...opts } = {}) {
  const solid = entities.filter(e => e.shape !== 'group');
  let candidates = solid;
  if (only) {
    // Only entities whose bounds touch an edited one can share a surface with it.
    const boxes = new Map(solid.map(e => [e.id, worldBox(e)])), edited = solid.filter(e => only.has(e.id));
    candidates = solid.filter(e => only.has(e.id) || edited.some(x => boxesTouch(boxes.get(x.id), boxes.get(e.id))));
  }
  const tris = candidates.flatMap(e => entityTriangles(e, { meshOf }));
  return findCoplanar(tris, { ...opts, pairs: within ? 'all' : 'between', focus: only });
}
function worldBox(e) {
  const [w, h, d] = SHAPES[e.shape]?.size || [1, 1, 1], m = entityMatrix(e), lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) { const p = apply(m, [i & 1 ? w / 2 : -w / 2, i & 2 ? h * 1.05 : 0, i & 4 ? d / 2 : -d / 2]); for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); } }
  return [lo, hi];
}
const boxesTouch = (a, b, pad = 0.01) => [0, 1, 2].every(k => a[0][k] <= b[1][k] + pad && b[0][k] <= a[1][k] + pad);

// ---------- reporting and fixing ----------
const axisName = n => { const k = [0, 1, 2].reduce((best, i) => (Math.abs(n[i]) > Math.abs(n[best]) ? i : best), 0); return Math.abs(n[k]) > 0.999 ? `${n[k] > 0 ? '+' : '-'}${'xyz'[k]}` : `[${n.map(x => x.toFixed(2)).join(', ')}]`; };
const lookName = look => look.split('|')[0].replace(/^primitive$/, 'surface');
/** One line a person or agent can act on. names: owner id → display name. */
export function describeFinding(f, names = {}) {
  const who = o => (o === 'mesh' ? 'the model' : `“${names[o] || o}”`);
  const pair = f.a.owner === f.b.owner ? `${who(f.a.owner)} has two ${lookName(f.a.look)}/${lookName(f.b.look)} surfaces` : `${who(f.a.owner)} and ${who(f.b.owner)} share a surface`;
  return `${pair} on one plane (facing ${axisName(f.normal)}, ${f.area < 0.01 ? `${Math.round(f.area * 1e6)} mm²` : `${round(f.area, 100)} m²`} overlap near [${f.at.join(', ')}]): they will z-fight. Never put two surfaces on the same plane: offset the decal or line ${COPLANAR.decalOffset * 1000} mm along its normal, or cut the overlap.`;
}

/**
 * A safe automatic fix for one finding between two entities, or null: lift the thinner, static one by
 * COPLANAR.decalOffset along the shared normal. Never moves a camera target, an animated object or a group.
 */
export function offsetFix(f, entities, { protect = new Set() } = {}) {
  if (f.a.owner === f.b.owner) return null;
  const byId = new Map(entities.map(e => [e.id, e])), a = byId.get(f.a.owner), b = byId.get(f.b.owner);
  if (!a || !b) return null;
  const extent = e => { const s = SHAPES[e.shape]?.size || [1, 1, 1]; return Math.abs(f.normal[0]) * s[0] * e.scale[0] + Math.abs(f.normal[1]) * s[1] * e.scale[1] + Math.abs(f.normal[2]) * s[2] * e.scale[2]; };
  const movable = e => !e.path?.length && e.shape !== 'group' && !protect.has(e.id);
  const pick = [a, b].filter(movable).sort((x, y) => extent(x) - extent(y))[0];
  if (!pick) return null;
  return { id: pick.id, position: pick.position.map((p, i) => round(p + f.normal[i] * COPLANAR.decalOffset, 1e6)) };
}
