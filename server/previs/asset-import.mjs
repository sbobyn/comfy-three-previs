// Copyright (c) 2026 Steven Bobyn. SPDX-License-Identifier: MIT
// Import a 3D model as a scene object (docs/import.md). GLB, glTF (+ its files), FBX, OBJ (+MTL), STL, PLY meshes and
// USDZ become one self-contained GLB in the project's refs/, wrapped in a node that fits it to the unit box (bottom
// centre at the origin), so it renders through the same project-mesh path as Blender meshes: viewport, headless
// renderer, duplicate, export and library. The importer checks everything before it writes; a refused file leaves the
// project untouched. Content is parsed, never executed; external URIs are refused.
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as THREE from 'three';
import { readGlb, writeGlb, packGltf, safeResourceUri, imageMime } from './glb.mjs';
import { cardGlb } from './asset-card.mjs';
import { readZip, zipEntryNames } from './zip.mjs';
import { SHAPES, KINDS, handleOf } from '../../shared/director.mjs';
import { mapHumanoid, RIG_POSES } from '../../shared/rig.mjs';
import { IMPORT_FORMATS } from '../../shared/imported-asset.mjs';

export const IMPORT_LIMITS = Object.freeze({ uploadBytes: 200 * 1024 ** 2, fileBytes: 128 * 1024 ** 2, glbBytes: 96 * 1024 ** 2, triangles: 500_000, nodes: 8000, joints: 512, animations: 64, images: 64, files: 256 });
const EXTENSIONS_OK = new Set(['KHR_materials_unlit', 'KHR_texture_transform', 'KHR_mesh_quantization', 'EXT_texture_webp', 'KHR_materials_emissive_strength', 'KHR_materials_ior', 'KHR_materials_specular', 'KHR_materials_transmission', 'KHR_materials_clearcoat', 'KHR_materials_sheen', 'KHR_materials_volume', 'KHR_materials_iridescence', 'KHR_materials_anisotropy', 'KHR_materials_variants', 'KHR_lights_punctual', 'KHR_animation_pointer']);
const MAIN = ['glb', 'gltf', 'fbx', 'usdz', 'obj', 'stl', 'ply'];
function fail(message, status = 400) { const e = Error(message); e.status = status; throw e; }
const formatOf = name => { const ext = extname(String(name)).slice(1).toLowerCase(); return ext === 'usd' ? null : MAIN.includes(ext) ? ext : null; };

// ---------- sources ----------
/** The model file among a set of files (a zip or a multi-file drop): one .glb/.gltf/.fbx/.usdz/.obj/.stl/.ply. */
export function pickMain(files) {
  const names = [...files.keys()].filter(n => !n.startsWith('__MACOSX/') && !n.split('/').pop().startsWith('.'));
  for (const format of MAIN) {
    const hits = names.filter(n => formatOf(n) === format);
    if (hits.length > 1) fail(`Import one model at a time: found ${hits.slice(0, 4).map(n => n.split('/').pop()).join(', ')}`);
    if (hits.length) return { name: hits[0], format };
  }
  fail(`No model file found. Supported: ${MAIN.map(f => `.${f}`).join(', ')} (or a .zip of one with its textures)`);
}
/** Files next to the main file, keyed by their path relative to it. */
function relativeTo(files, main) {
  const dir = main.includes('/') ? main.slice(0, main.lastIndexOf('/') + 1) : '';
  return new Map([...files].filter(([n]) => n.startsWith(dir) && n !== main).map(([n, b]) => [n.slice(dir.length), b]));
}

/** { main: { name, bytes }, format, files } from uploaded bytes: a zip, or one model file named `name`. */
export function sourceFromUpload(bytes, name) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) fail('The upload is empty');
  if (bytes.length > IMPORT_LIMITS.uploadBytes) fail(`Imports are at most ${IMPORT_LIMITS.uploadBytes / 1024 ** 2} MB`, 413);
  const isZip = /\.zip$/i.test(name || '') || (!formatOf(name) && zipEntryNames(bytes).length > 0);
  if (isZip) {
    const files = readZip(bytes, { maxEntries: IMPORT_LIMITS.files, maxTotal: IMPORT_LIMITS.uploadBytes * 2 });
    const main = pickMain(files);
    return { main: { name: main.name.split('/').pop(), bytes: files.get(main.name) }, format: main.format, files: relativeTo(files, main.name) };
  }
  const format = formatOf(name) || (bytes.readUInt32LE(0) === 0x46546c67 ? 'glb' : imageMime(bytes) ? 'image' : null);
  if (!format) fail(`Unsupported file “${String(name || '').slice(0, 80)}”. Supported: ${MAIN.map(f => `.${f}`).join(', ')}, or a .zip`);
  return { main: { name: basename(String(name || `model.${format}`)), bytes }, format, files: new Map() };
}

/** Multi-file drop body: [u32 header length][JSON [{ name, size }]][bytes …] (application/x-previs-files). */
export function sourceFromBundle(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 4) fail('The upload is empty');
  if (bytes.length > IMPORT_LIMITS.uploadBytes) fail(`Imports are at most ${IMPORT_LIMITS.uploadBytes / 1024 ** 2} MB`, 413);
  const n = bytes.readUInt32LE(0);
  let list; try { list = JSON.parse(bytes.toString('utf8', 4, 4 + n)); } catch { fail('Invalid file bundle'); }
  if (!Array.isArray(list) || !list.length || list.length > IMPORT_LIMITS.files) fail('Invalid file bundle');
  const files = new Map(); let at = 4 + n;
  for (const f of list) {
    const name = String(f?.name || '').split('/').pop();
    if (!name || name.startsWith('.') || !Number.isInteger(f.size) || f.size < 0 || at + f.size > bytes.length || files.has(name)) fail('Invalid file bundle');
    files.set(name, bytes.subarray(at, at + f.size)); at += f.size;
  }
  if (files.size === 1) { const [[name, b]] = files; return sourceFromUpload(b, name); }
  const main = pickMain(files);
  return { main: { name: main.name, bytes: files.get(main.name) }, format: main.format, files: relativeTo(files, main.name) };
}

async function regularFile(file, max = IMPORT_LIMITS.fileBytes) {
  const s = await lstat(file).catch(() => fail(`File not found: ${file}`, 404));
  if (s.isSymbolicLink() || !s.isFile()) fail(`Not a regular file: ${file}`);
  if (s.size > max) fail(`${basename(file)} is larger than ${max / 1024 ** 2} MB`, 413);
  return readFile(file);
}
/** The resource paths a model names beside itself (glTF buffers/images, OBJ mtllib, MTL maps). */
function wanted(format, bytes) {
  if (format === 'gltf') {
    let g; try { g = JSON.parse(bytes.toString('utf8')); } catch { fail('The .gltf file is not valid JSON'); }
    return [...(g.buffers || []), ...(g.images || [])].map(x => x?.uri).filter(u => typeof u === 'string' && !u.startsWith('data:'));
  }
  if (format === 'obj') return [...bytes.toString('utf8').matchAll(/^\s*mtllib\s+(.+?)\s*$/gm)].map(m => m[1]);
  return [];
}
/** { main, format, files } from an absolute path to a model file or a .zip. Reads only files the model names. */
export async function sourceFromPath(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail('path must be an absolute path to a model file or a .zip');
  const file = await realpath(path).catch(() => fail(`File not found: ${path}`, 404));
  const bytes = await regularFile(file, /\.zip$/i.test(file) ? IMPORT_LIMITS.uploadBytes : IMPORT_LIMITS.fileBytes);
  const src = sourceFromUpload(bytes, basename(file));
  if (/\.zip$/i.test(file)) return src;
  const dir = dirname(file), files = new Map();
  const add = async uri => {
    const rel = safeResourceUri(uri); if (!rel || files.has(rel)) return;
    const abs = resolve(dir, rel);
    if (!abs.startsWith(dir + sep)) return;
    try { files.set(rel, await regularFile(abs)); } catch {}
  };
  for (const uri of wanted(src.format, bytes)) await add(uri);
  if (src.format === 'obj') for (const [, mtl] of [...files]) for (const m of mtl.toString('utf8').matchAll(/^\s*(?:map_\w+|bump|norm)\s+(?:-\S+\s+\S+\s+)*(.+?)\s*$/gm)) await add(m[1]);
  return { ...src, files };
}

/** { main, format, files } from an https URL (one model file or a .zip), size-capped, never following to http. */
export async function sourceFromUrl(url, { fetchImpl = fetch, maxBytes = IMPORT_LIMITS.uploadBytes } = {}) {
  let u; try { u = new URL(url); } catch { fail('url must be an https URL'); }
  if (u.protocol !== 'https:') fail('url must be an https URL');
  const r = await fetchImpl(u, { redirect: 'follow' });
  if (!r.ok) fail(`Download failed: HTTP ${r.status}`);
  if (r.url && new URL(r.url).protocol !== 'https:') fail('The download redirected away from https');
  if (Number(r.headers.get('content-length')) > maxBytes) fail(`Downloads are at most ${maxBytes / 1024 ** 2} MB`, 413);
  const parts = []; let size = 0;
  for await (const chunk of r.body) { size += chunk.length; if (size > maxBytes) fail(`Downloads are at most ${maxBytes / 1024 ** 2} MB`, 413); parts.push(Buffer.from(chunk)); }
  const name = decodeURIComponent(u.pathname.split('/').pop() || 'model');
  return sourceFromUpload(Buffer.concat(parts), name);
}

// ---------- GLB inspection ----------
const COMPONENT = { 5120: [1, 'readInt8'], 5121: [1, 'readUInt8'], 5122: [2, 'readInt16LE'], 5123: [2, 'readUInt16LE'], 5125: [4, 'readUInt32LE'], 5126: [4, 'readFloatLE'] };
const WIDTH = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
function accessorBytes(g, bin, i) {
  const a = g.accessors?.[i]; if (!a) fail('The model refers to a missing accessor');
  const [size] = COMPONENT[a.componentType] || fail('The model has an unknown component type'), n = WIDTH[a.type] || fail('The model has an unknown accessor type');
  if (!Number.isInteger(a.count) || a.count < 0) fail('The model has an invalid accessor');
  if (a.bufferView === undefined) return { a, size, n, read: () => 0 };
  const v = g.bufferViews?.[a.bufferView]; if (!v) fail('The model refers to a missing buffer view');
  const stride = v.byteStride || size * n, start = (v.byteOffset || 0) + (a.byteOffset || 0);
  if (a.count && start + stride * (a.count - 1) + size * n > (v.byteOffset || 0) + v.byteLength) fail('An accessor runs past its buffer view');
  const fn = COMPONENT[a.componentType][1];
  return { a, size, n, read: (k, c) => bin[fn](start + k * stride + c * size) };
}
function readFloats(g, bin, i) {
  const { a, n, read } = accessorBytes(g, bin, i), out = new Float64Array(a.count * n);
  for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) out[k * n + c] = read(k, c);
  return out;
}
const nodeMatrix = n => (Array.isArray(n.matrix) && n.matrix.length === 16 ? new THREE.Matrix4().fromArray(n.matrix) : new THREE.Matrix4().compose(new THREE.Vector3(...(n.translation || [0, 0, 0])), new THREE.Quaternion(...(n.rotation || [0, 0, 0, 1])), new THREE.Vector3(...(n.scale || [1, 1, 1]))));

/** Structure checks (no external files, known extensions, bounds of every buffer view) and limits. */
export function validateGlb(g, bin) {
  const binLength = bin?.length || 0;
  for (const b of g.buffers || []) if (b.uri !== undefined) fail('The model points to separate files. Import the folder as a .zip, or export a .glb');
  for (const img of g.images || []) if (img.uri !== undefined) fail('The model points to separate image files. Import the folder as a .zip, or export a .glb');
  const required = (g.extensionsRequired || []).filter(x => !EXTENSIONS_OK.has(x));
  if (required.includes('KHR_draco_mesh_compression') || required.includes('EXT_meshopt_compression')) fail('Compressed meshes (Draco/meshopt) are not supported yet. Export without mesh compression');
  if (required.length) fail(`The model needs ${required.join(', ')}, which video-lab does not load`);
  for (const v of g.bufferViews || []) if (!Number.isInteger(v.byteLength) || (v.byteOffset || 0) < 0 || (v.byteOffset || 0) + v.byteLength > binLength) fail('A buffer view runs past the file');
  if ((g.nodes || []).length > IMPORT_LIMITS.nodes) fail(`The model has more than ${IMPORT_LIMITS.nodes} nodes`);
  if ((g.animations || []).length > IMPORT_LIMITS.animations) fail(`The model has more than ${IMPORT_LIMITS.animations} animations`);
  if ((g.images || []).length > IMPORT_LIMITS.images) fail(`The model has more than ${IMPORT_LIMITS.images} textures`);
  for (const s of g.skins || []) if (!Array.isArray(s.joints) || s.joints.length > IMPORT_LIMITS.joints || s.joints.some(j => !g.nodes?.[j])) fail('The model has an invalid skeleton');
  const scene = g.scenes?.[g.scene ?? 0];
  if (!scene || !Array.isArray(scene.nodes) || !scene.nodes.length) fail('The model has no scene');
  // Every node reachable once from the scene; a cycle or a shared child is refused.
  const seen = new Set(), stack = [...scene.nodes];
  while (stack.length) { const i = stack.pop(); if (!Number.isInteger(i) || !g.nodes?.[i] || seen.has(i)) fail('The model’s node tree is invalid'); seen.add(i); stack.push(...(g.nodes[i].children || [])); }
}

/**
 * What the model is: rest bounds (with skins posed by their bind matrices), triangles, clips, skin and humanoid
 * rig (joints mapped by name, then a frame that faces the character to +z). align is a Matrix4 applied before bounds.
 */
export function inspectGlb(g, bin) {
  validateGlb(g, bin);
  const scene = g.scenes[g.scene ?? 0], world = new Map(), parent = new Map();
  const visit = (i, m) => { const w = m.clone().multiply(nodeMatrix(g.nodes[i])); world.set(i, w); for (const c of g.nodes[i].children || []) { parent.set(c, i); visit(c, w); } };
  for (const i of scene.nodes) visit(i, new THREE.Matrix4());
  let triangles = 0; const boxes = [];
  for (const [i, w] of world) {
    const node = g.nodes[i]; if (node.mesh === undefined) continue;
    const mesh = g.meshes?.[node.mesh]; if (!mesh) fail('The model refers to a missing mesh');
    let m = w;
    if (node.skin !== undefined) {
      const skin = g.skins?.[node.skin]; if (!skin) fail('The model refers to a missing skin');
      const ibm = skin.inverseBindMatrices !== undefined ? new THREE.Matrix4().fromArray(Array.from(readFloats(g, bin, skin.inverseBindMatrices).slice(0, 16))) : new THREE.Matrix4();
      m = (world.get(skin.joints[0]) || new THREE.Matrix4()).clone().multiply(ibm);
    }
    for (const p of mesh.primitives || []) {
      const mode = p.mode ?? 4, pos = g.accessors?.[p.attributes?.POSITION];
      if (!pos) continue;
      const count = p.indices !== undefined ? g.accessors?.[p.indices]?.count ?? 0 : pos.count;
      triangles += mode === 4 ? Math.floor(count / 3) : mode === 5 || mode === 6 ? Math.max(0, count - 2) : 0;
      if (mode < 4) continue;
      let min = pos.min, max = pos.max;
      if (!(Array.isArray(min) && Array.isArray(max) && min.length === 3 && max.length === 3)) {
        const f = readFloats(g, bin, p.attributes.POSITION); min = [Infinity, Infinity, Infinity]; max = [-Infinity, -Infinity, -Infinity];
        for (let k = 0; k < f.length; k += 3) for (let c = 0; c < 3; c++) { min[c] = Math.min(min[c], f[k + c]); max[c] = Math.max(max[c], f[k + c]); }
      }
      if (pos.normalized) continue; // quantized positions: their node scale carries the size; rare, skipped for bounds
      boxes.push({ box: new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max)), m });
    }
  }
  if (!boxes.length || !triangles) fail('The model has no surfaces to show (no triangle meshes)');
  if (triangles > IMPORT_LIMITS.triangles) fail(`The model has ${triangles.toLocaleString('en-US')} triangles; the limit is ${IMPORT_LIMITS.triangles.toLocaleString('en-US')}. Decimate it first`);
  const clips = (g.animations || []).map((a, i) => {
    let duration = 0;
    for (const s of a.samplers || []) { const inp = g.accessors?.[s.input]; if (Array.isArray(inp?.max)) duration = Math.max(duration, inp.max[0]); }
    return { name: String(a.name || `Clip ${i + 1}`).slice(0, 80), duration: Math.round(duration * 1000) / 1000, channels: (a.channels || []).length };
  }).filter(c => c.channels > 0 && c.duration >= 2 / 24); // one-frame clips are bind-pose snapshots (Mixamo's “mixamo.com”)
  // Unique clip names: the viewport finds a clip by name.
  const names = new Set();
  for (const c of clips) { let n = c.name, k = 2; while (names.has(n)) n = `${c.name} ${k++}`; names.add(n); c.name = n; }
  const joints = [...new Set((g.skins || []).flatMap(s => s.joints))], jointSet = new Set(joints);
  const boneParent = i => { for (let p = parent.get(i); p !== undefined; p = parent.get(p)) if (jointSet.has(p)) return p; return null; };
  const map = joints.length ? mapHumanoid(joints.map(i => ({ id: i, name: g.nodes[i].name || '', parent: boneParent(i) }))) : null;
  let align = new THREE.Matrix4();
  if (map) {
    const at = j => new THREE.Vector3().setFromMatrixPosition(world.get(map.joints[j]));
    const top = map.joints.head !== undefined ? at('head') : map.joints.neck !== undefined ? at('neck') : at('spine' in map.joints ? 'spine' : 'armL').add(at('armR')).multiplyScalar(0.5);
    // Snapped to the nearest axes: this fixes a Z-up or backwards-facing file, never the figure's natural lean.
    const snap = v => { const a = [Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)], i = a.indexOf(Math.max(...a)); return new THREE.Vector3(...[0, 1, 2].map(k => (k === i ? Math.sign(v.getComponent(k)) || 1 : 0))); };
    const up = snap(top.sub(at('body'))), left = at('armL').sub(at('armR'));
    left.sub(up.clone().multiplyScalar(left.dot(up)));
    const l = snap(left), forward = new THREE.Vector3().crossVectors(l, up);
    if (Math.abs(l.dot(up)) < 0.5 && forward.lengthSq() > 0.5) align = new THREE.Matrix4().makeBasis(l, up, forward).transpose();
  }
  const bounds = new THREE.Box3();
  for (const { box, m } of boxes) bounds.union(box.clone().applyMatrix4(align.clone().multiply(m)));
  return { triangles, clips: clips.map(({ channels, ...c }) => c), skinned: joints.length > 0, rig: map, align, bounds, world };
}

/** Wrap the scene in one node that maps the aligned rest bounds to the unit box, bottom centre at the origin. */
export function fitGlb(g, info) {
  const size = info.bounds.getSize(new THREE.Vector3()), floor = Math.max(size.x, size.y, size.z) * 1e-3 || 1e-6;
  // A humanoid's box is its standing width, not its T-pose arm span, so framing and cast boxes fit the figure.
  if (info.rig) {
    const at = j => new THREE.Vector3().setFromMatrixPosition(info.world.get(info.rig.joints[j])).applyMatrix4(info.align);
    size.x = Math.min(size.x, Math.max(at('armL').distanceTo(at('armR')) * 1.4, at('thighL').distanceTo(at('thighR')) * 2.2));
  }
  const dims = new THREE.Vector3(Math.max(size.x, floor), Math.max(size.y, floor), Math.max(size.z, floor));
  const centre = new THREE.Vector3((info.bounds.min.x + info.bounds.max.x) / 2, info.bounds.min.y, (info.bounds.min.z + info.bounds.max.z) / 2);
  const place = new THREE.Matrix4().makeScale(1 / dims.x, 1 / dims.y, 1 / dims.z).multiply(new THREE.Matrix4().makeTranslation(-centre.x, -centre.y, -centre.z));
  const fit = place.clone().multiply(info.align);
  // Two nodes, because a non-uniform scale after a rotation is not a glTF TRS: an outer scale + offset, an inner turn.
  const doc = structuredClone(g), sceneIndex = doc.scene ?? 0, roots = doc.scenes[sceneIndex].nodes;
  const q = new THREE.Quaternion().setFromRotationMatrix(info.align), clean = a => a.map(v => (Math.abs(v) < 1e-12 ? 0 : v));
  const turn = doc.nodes.push({ name: 'previs-import-facing', ...(q.angleTo(new THREE.Quaternion()) > 1e-9 ? { rotation: clean(q.toArray()) } : {}), children: roots }) - 1;
  const wrapper = doc.nodes.push({ name: 'previs-import', translation: clean([-centre.x / dims.x, -centre.y / dims.y, -centre.z / dims.z]), scale: [1 / dims.x, 1 / dims.y, 1 / dims.z], children: [turn] }) - 1;
  doc.scenes = [{ ...doc.scenes[sceneIndex], nodes: [wrapper] }]; doc.scene = 0;
  const rest = {};
  if (info.rig) for (const [j, i] of Object.entries(info.rig.joints)) { const p = new THREE.Vector3().setFromMatrixPosition(info.world.get(i)).applyMatrix4(fit); rest[j] = [p.x, p.y, p.z]; }
  return { json: doc, dims, rest };
}

// ---------- sizing ----------
/** Real size in metres: glTF/USDZ are metres, FBX says its unit, OBJ/STL/PLY are guessed; humanoids land at human height. */
export function realSize(dims, { metres, humanoid, height = null, format }) {
  let k = metres, note = metres ? null : 'no units in the file';
  if (!metres) {
    const max = Math.max(dims.x, dims.y, dims.z);
    k = max > 100 ? 0.001 : max > 10 ? 0.01 : 1;
    note = `${format.toUpperCase()} has no units; read as ${k === 0.001 ? 'millimetres' : k === 0.01 ? 'centimetres' : 'metres'}`;
  }
  if (Number.isFinite(height) && height > 0) return { size: [dims.x, dims.y, dims.z].map(v => v * height / dims.y), note: `height set to ${height} m` };
  if (humanoid && (dims.y * k < 1.2 || dims.y * k > 2.3)) return { size: [dims.x, dims.y, dims.z].map(v => v * 1.8 / dims.y), note: `a ${Math.round(dims.y * k * 100) / 100} m tall figure was scaled to 1.8 m` };
  return { size: [dims.x * k, dims.y * k, dims.z * k], note };
}

const prettyName = file => {
  const stem = basename(String(file)).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
  return (stem.charAt(0).toUpperCase() + stem.slice(1)).slice(0, 60) || 'Imported model';
};

/**
 * Turn a source into the stored GLB and the add_entity op. convert(format, main, files) handles non-glTF formats.
 * Returns { glb, entity, info: { triangles, clips, humanoid, units, notes, warnings } }.
 */
export async function prepareImport(src, { convert, file, projectId, name = null, kind = null, place = {}, height = null, licence = '', attribution = '', url = null }) {
  if (!IMPORT_FORMATS.includes(src.format)) fail(`Unsupported format ${src.format}`);
  if (src.format === 'image') return prepareCard(src, { file, projectId, name, kind, place, height, licence, attribution, url });
  let json, bin, metres = 1, units = 'glTF metres', notes = [];
  if (src.format === 'glb' || src.format === 'gltf') {
    let doc;
    if (src.format === 'glb') ({ json: doc, bin } = readGlb(src.main.bytes));
    else { try { doc = JSON.parse(src.main.bytes.toString('utf8')); } catch { fail('The .gltf file is not valid JSON'); } if (doc?.asset?.version !== '2.0') fail('Only glTF 2.0 is supported'); }
    const lower = new Map([...src.files].map(([k, v]) => [k.toLowerCase(), v]));
    ({ json, bin } = packGltf(doc, { bin, resource: p => src.files.get(p) || lower.get(p.toLowerCase()) || null }));
  } else {
    const out = await convert(src.format, src.main, src.files);
    ({ json, bin } = readGlb(out.glb)); metres = out.metres; units = out.units; notes = out.notes || [];
  }
  const info = inspectGlb(json, bin);
  const fitted = fitGlb(json, info);
  const glb = writeGlb(fitted.json, bin);
  if (glb.length > IMPORT_LIMITS.glbBytes) fail(`The converted model is ${Math.round(glb.length / 1024 ** 2)} MB; the limit is ${IMPORT_LIMITS.glbBytes / 1024 ** 2} MB`, 413);
  const humanoid = !!info.rig;
  const { size, note } = realSize(fitted.dims, { metres, humanoid, height, format: src.format });
  const shape = humanoid ? 'person' : Math.max(...size) > 50 ? 'building' : 'box';
  const scale = size.map((v, i) => v / SHAPES[shape].size[i]);
  const warnings = [];
  if (scale.some(v => v > 50 || v < 0.05)) warnings.push(`The model is ${size.map(v => Math.round(v * 100) / 100).join(' × ')} m; video-lab objects are at most 50× their shape (${shape}), so it was clamped. Scale it in the inspector or pass height`);
  const objectKind = KINDS.includes(kind) ? kind : humanoid ? 'character' : Math.max(...size) > 8 ? 'environment' : 'prop';
  const clips = info.clips;
  const firstClip = clips.find(c => c.duration > 0.1)?.name || null;
  const position = Array.isArray(place.position) && place.position.length === 3 && place.position.every(Number.isFinite) ? place.position : [0, 0, 0];
  const entity = {
    name: String(name || prettyName(src.main.name)).slice(0, 60), kind: objectKind, shape, model: `/director-refs/${projectId}/${file}`,
    position, rotation: Number.isFinite(place.rotation) ? place.rotation : 0, scale, color: '#c8ccd4',
    source: {
      file: src.main.name, format: src.format, ...(url ? { url } : {}), licence, attribution, triangles: info.triangles, bytes: glb.length, units: note || units,
      clips, ...(info.skinned ? { skinned: true } : {}), ...(humanoid ? { rig: { humanoid: true, joints: info.rig.joints, parents: info.rig.parents, rest: fitted.rest } } : {}),
    },
    ...(firstClip ? { perform: { clip: firstClip, offset: 0, speed: 1 } } : humanoid ? { pose: RIG_POSES.stand } : {}),
  };
  return { glb, entity, info: { triangles: info.triangles, clips, humanoid, joints: humanoid ? Object.keys(info.rig.joints) : [], units: note || units, notes, warnings, size: size.map(v => Math.round(v * 1000) / 1000) } };
}

/** An image as an upright backdrop card, 4 m wide (or `height` tall), facing +z. */
function prepareCard(src, { file, projectId, name, kind, place, height, licence, attribution, url }) {
  const { glb, width, height: px } = cardGlb(src.main.bytes);
  const { json, bin } = readGlb(glb); validateGlb(json, bin);
  const h = Number.isFinite(height) && height > 0 ? height : 4 * px / width, w = h * width / px;
  const size = [w, h, 0.05], warnings = [];
  if (size.some(v => v > 50)) warnings.push(`The card is ${size.map(v => Math.round(v * 100) / 100).join(' × ')} m; objects are at most 50 m, so it was clamped`);
  const position = Array.isArray(place.position) && place.position.length === 3 && place.position.every(Number.isFinite) ? place.position : [0, 0, 0];
  const entity = {
    name: String(name || prettyName(src.main.name)).slice(0, 60), kind: KINDS.includes(kind) ? kind : 'environment', shape: 'box', model: `/director-refs/${projectId}/${file}`,
    position, rotation: Number.isFinite(place.rotation) ? place.rotation : 0, scale: size, color: '#c8ccd4',
    source: { file: src.main.name, format: 'image', ...(url ? { url } : {}), licence, attribution, triangles: 2, bytes: glb.length, units: `backdrop card, ${width}×${px} px` },
  };
  return { glb, entity, info: { triangles: 2, clips: [], humanoid: false, joints: [], units: entity.source.units, notes: [], warnings, size: size.map(v => Math.round(v * 1000) / 1000) } };
}

/** Wire the importer to a director store: import into a project (new object), returning the edit result. */
export function openAssetImport({ director, convert }) {
  async function run(src, input = {}) {
    if (!input.projectId) fail('projectId is required');
    const project = await director.get(input.projectId);
    if (project.scene.entities.length >= 200) fail('Scene supports at most 200 objects');
    const file = `${randomUUID()}.glb`;
    const kind = input.kind === 'auto' ? null : input.kind;
    const { glb, entity, info } = await prepareImport(src, { convert, file, projectId: project.id, name: input.name, kind, place: input.place || {}, height: Number(input.height) || null, licence: input.licence || '', attribution: input.attribution || '', url: input.url || null });
    const id = randomUUID();
    await director.storeAsset(project.id, file, glb);
    const r = await director.edit(project.id, [{ op: 'add_entity', entity: { ...entity, id } }]);
    const e = r.project.scene.entities.find(x => x.id === id);
    return { project: r.project, entityId: id, name: e.name, handle: handleOf(e.name), model: e.model, ...info };
  }
  return {
    /** input.file: the uploaded file's name; input.name: the object's name (default: from the file). */
    fromUpload: (bytes, input) => run(input.bundle ? sourceFromBundle(bytes) : sourceFromUpload(bytes, input.file), input),
    fromPath: async input => run(await sourceFromPath(input.path), input),
    fromUrl: async (input, opts) => run(await sourceFromUrl(input.url, opts), { ...input, url: input.url }),
  };
}
export { prettyName };
