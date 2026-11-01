// Copyright (c) 2026 Steven Bobyn. SPDX-License-Identifier: MIT
// Small, static, self-contained GLBs for imported blockouts. No extensions, textures, animations or URLs.
export const MESH_LIMITS = Object.freeze({ bytes: 2 * 1024 ** 2, triangles: 20000, totalBytes: 32 * 1024 ** 2, totalTriangles: 100000 });
export const MESH_PATH = /^meshes\/[a-zA-Z0-9_-]{1,80}\.glb$/;
function fail(message) { const e = Error(`Mesh: ${message}`); e.status = 400; throw e; }
export function validateMesh(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 28 || bytes.length > MESH_LIMITS.bytes) fail('GLB must be under 2 MB');
  if (bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) fail('invalid GLB header');
  const len = bytes.readUInt32LE(12), end = 20 + len;
  if (len % 4 || end + 8 > bytes.length || bytes.readUInt32LE(16) !== 0x4e4f534a) fail('invalid JSON chunk');
  let g; try { g = JSON.parse(bytes.toString('utf8', 20, end)); } catch { fail('invalid glTF JSON'); }
  const bin = bytes.subarray(end + 8);
  if (bytes.readUInt32LE(end + 4) !== 0x004e4942 || bytes.readUInt32LE(end) !== bin.length || bin.length % 4) fail('invalid binary chunk');
  const keys = (v, allowed) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => allowed.includes(k));
  if (!keys(g, ['asset', 'scene', 'scenes', 'nodes', 'meshes', 'buffers', 'bufferViews', 'accessors', 'materials']) || g.asset?.version !== '2.0') fail('only static embedded geometry is supported');
  if (g.buffers?.length !== 1 || !keys(g.buffers[0], ['byteLength']) || !Number.isInteger(g.buffers[0].byteLength) || g.buffers[0].byteLength <= 0 || g.buffers[0].byteLength > bin.length || bin.length - g.buffers[0].byteLength > 3) fail('buffer must be embedded');
  if (g.scene !== 0 || g.scenes?.length !== 1 || !keys(g.scenes[0], ['nodes']) || JSON.stringify(g.scenes[0].nodes) !== '[0]' || g.nodes?.length !== 1 || !keys(g.nodes[0], ['mesh']) || g.nodes[0].mesh !== 0 || g.meshes?.length !== 1 || !keys(g.meshes[0], ['primitives'])) fail('expected one mesh, without transforms or instances');
  if (!Array.isArray(g.bufferViews) || !Array.isArray(g.accessors) || g.accessors.length > 64 || g.bufferViews.length > 64) fail('invalid accessors');
  for (const v of g.bufferViews) if (!keys(v, ['buffer', 'byteOffset', 'byteLength']) || v.buffer !== 0 || !Number.isInteger(v.byteOffset) || v.byteOffset < 0 || !Number.isInteger(v.byteLength) || v.byteLength <= 0 || v.byteOffset + v.byteLength > g.buffers[0].byteLength) fail('invalid buffer view');
  for (const a of g.accessors) {
    if (!keys(a, ['bufferView', 'componentType', 'count', 'type', 'min', 'max']) || !Number.isInteger(a.count) || a.count < 1 || a.count > MESH_LIMITS.triangles * 3 || a.componentType !== 5126 || a.type !== 'VEC3') fail('expected bounded FLOAT VEC3 accessor');
    const v = g.bufferViews[a.bufferView];
    if (!v || v.byteLength !== a.count * 12 || v.byteOffset % 4) fail('accessor exceeds buffer');
    for (let i = v.byteOffset; i < v.byteOffset + v.byteLength; i += 4) if (!Number.isFinite(bin.readFloatLE(i)) || Math.abs(bin.readFloatLE(i)) > 2) fail('vertices/normals must be finite and normalized to object bounds');
    for (const key of ['min', 'max']) if (a[key] !== undefined && (!Array.isArray(a[key]) || a[key].length !== 3 || !a[key].every(v => Number.isFinite(v) && Math.abs(v) <= 2))) fail('invalid accessor bounds');
  }
  if (!Array.isArray(g.materials) || g.materials.length > 16) fail('invalid materials');
  for (const m of g.materials) {
    const p = m.pbrMetallicRoughness;
    if (!keys(m, ['pbrMetallicRoughness', 'doubleSided']) || !keys(p, ['baseColorFactor', 'metallicFactor', 'roughnessFactor']) || !Array.isArray(p.baseColorFactor) || p.baseColorFactor.length !== 4 || ![...p.baseColorFactor, p.metallicFactor, p.roughnessFactor].every(v => Number.isFinite(v) && v >= 0 && v <= 1)) fail('only plain colour materials are supported');
  }
  const primitives = g.meshes[0].primitives;
  if (!Array.isArray(primitives) || !primitives.length || primitives.length > 16) fail('invalid primitives');
  let triangles = 0;
  for (const p of primitives) {
    if (!keys(p, ['attributes', 'material', 'mode']) || p.mode !== 4 || !keys(p.attributes, ['POSITION', 'NORMAL'])) fail('only plain triangles are supported');
    const pos = g.accessors[p.attributes.POSITION], normal = g.accessors[p.attributes.NORMAL];
    if (![p.attributes.POSITION, p.attributes.NORMAL, p.material].every(Number.isInteger) || !pos || !normal || pos.count !== normal.count || pos.count % 3 || !g.materials[p.material]) fail('invalid triangle attributes');
    triangles += pos.count / 3;
  }
  if (triangles > MESH_LIMITS.triangles) fail('more than 20000 triangles');
  return { triangles, bytes: bytes.length };
}
