// Copyright (c) 2026 Steven Bobyn. SPDX-License-Identifier: MIT
// FBX, OBJ (+MTL), STL, PLY and USDZ → one GLB, in Node, with three.js's own loaders and GLTFExporter. Loaders only
// parse bytes; nothing in a file is executed. Two small shims stand in for the browser: a FileReader for the exporter,
// and an <img> that records each texture's bytes instead of decoding them. The original PNG/JPEG/WebP bytes are then
// written into the GLB, so textures survive without a canvas.
import { resolveObjectURL } from 'node:buffer';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { USDLoader } from 'three/examples/jsm/loaders/USDLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { readGlb, writeGlb, appendView, imageMime, dataUri, safeResourceUri } from './glb.mjs';

function fail(message, status = 400) { const e = Error(message); e.status = status; throw e; }
const arrayBuffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

// ---------- browser stand-ins (installed only while one conversion runs) ----------
class NodeFileReader {
  result = null; onload = null; onloadend = null; onerror = null;
  #done(result) { this.result = result; for (const f of [this.onload, this.onloadend]) f?.call(this, { target: this }); }
  readAsArrayBuffer(blob) { blob.arrayBuffer().then(b => this.#done(b), e => this.onerror?.(e)); }
  readAsDataURL(blob) { blob.arrayBuffer().then(b => this.#done(`data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(b).toString('base64')}`), e => this.onerror?.(e)); }
  addEventListener(type, f) { if (type === 'load') this.onload = f; else if (type === 'loadend') this.onloadend = f; else if (type === 'error') this.onerror = f; }
}
/** An <img> that never decodes: it records where its bytes are and reports a load on the next tick. */
function capturingImage(captured) {
  const listeners = {};
  const img = {
    width: 1, height: 1, isCapturedImage: true,
    addEventListener(type, f) { (listeners[type] ||= []).push(f); },
    removeEventListener(type, f) { listeners[type] = (listeners[type] || []).filter(x => x !== f); },
    set src(url) { img.url = String(url); img.blob = img.url.startsWith('blob:') ? resolveObjectURL(img.url) : null; captured.push(img); setTimeout(() => (listeners.load || []).slice().forEach(f => f.call(img, { target: img }))); },
    get src() { return img.url; },
  };
  return img;
}
let busy = Promise.resolve();
/** Run one conversion with the stand-ins installed; conversions are serialised so the globals never overlap. */
async function withShims(run) {
  const prev = busy; let release; busy = new Promise(r => { release = r; });
  await prev;
  const saved = { document: globalThis.document, FileReader: globalThis.FileReader, warn: console.warn };
  const captured = [], warnings = [];
  globalThis.document = { createElementNS: (_ns, name) => (name === 'img' ? capturingImage(captured) : fail(`Conversion needs a browser <${name}>`)) };
  globalThis.FileReader = NodeFileReader;
  console.warn = (...a) => { if (warnings.length < 20) warnings.push(a.map(String).join(' ').slice(0, 200)); };
  try { return await run({ captured, warnings }); }
  finally { Object.assign(globalThis, { document: saved.document, FileReader: saved.FileReader }); if (saved.document === undefined) delete globalThis.document; if (saved.FileReader === undefined) delete globalThis.FileReader; console.warn = saved.warn; release(); }
}

// ---------- texture bytes ----------
async function imageBytes(img, files) {
  if (!img?.isCapturedImage) return null;
  if (img.blob) return Buffer.from(await img.blob.arrayBuffer());
  const inline = dataUri(img.url); if (inline) return inline.bytes;
  const path = safeResourceUri(img.url);
  if (!path) return null;
  return files.get(path) || files.get(path.split('/').pop()) || [...files].find(([k]) => k.split('/').pop().toLowerCase() === path.split('/').pop().toLowerCase())?.[1] || null;
}

/** Plain PBR materials the exporter writes faithfully; each texture slot is recorded and re-attached after export. */
async function prepareMaterials(root, files, notes) {
  const images = [], seen = new Map();
  const slot = async tex => {
    if (!tex?.image) return null;
    if (seen.has(tex.image)) return seen.get(tex.image);
    const bytes = await imageBytes(tex.image, files), mime = bytes && imageMime(bytes);
    let index = null;
    if (mime) index = images.push({ bytes, mime }) - 1;
    else notes.push(`A texture (${String(tex.image.url || '').split('/').pop().slice(0, 60) || 'embedded'}) was left out: only PNG, JPEG and WebP textures are kept`);
    seen.set(tex.image, index);
    return index;
  };
  const convert = async m => {
    const out = new THREE.MeshStandardMaterial({ name: m.name || '', color: m.color?.clone?.() || new THREE.Color(0xcccccc), roughness: m.roughness ?? 0.8, metalness: m.metalness ?? 0, transparent: !!m.transparent && (m.opacity ?? 1) < 1, opacity: m.opacity ?? 1, side: m.side ?? THREE.FrontSide, vertexColors: !!m.vertexColors });
    if (m.emissive) out.emissive.copy(m.emissive);
    const tex = { map: await slot(m.map), normalMap: await slot(m.normalMap), emissiveMap: await slot(m.emissiveMap) };
    for (const k of Object.keys(tex)) if (tex[k] === null) delete tex[k];
    if (Object.keys(tex).length) out.userData.previsTex = tex;
    return out;
  };
  const cache = new Map();
  const meshes = [];
  root.traverse(o => { if (o.isMesh || o.isPoints || o.isLine) meshes.push(o); });
  for (const o of meshes) {
    if (!o.isMesh) { o.parent?.remove(o); continue; }
    const list = Array.isArray(o.material) ? o.material : [o.material];
    const done = [];
    for (const m of list) { if (!cache.has(m)) cache.set(m, await convert(m || {})); done.push(cache.get(m)); }
    o.material = Array.isArray(o.material) ? done : done[0];
  }
  return images;
}

/** Re-attach recorded textures (material extras.previsTex) as real glTF textures with the original image bytes. */
function attachTextures(glb, images) {
  const state = readGlb(glb), g = state.json;
  state.bin = state.bin ? Buffer.from(state.bin) : Buffer.alloc(0);
  const imageIndex = new Map();
  for (const m of g.materials || []) {
    const tex = m.extras?.previsTex;
    if (!tex) continue;
    delete m.extras.previsTex; if (!Object.keys(m.extras).length) delete m.extras;
    const textureOf = i => {
      if (!imageIndex.has(i)) {
        const view = appendView(state, images[i].bytes);
        (g.images ||= []).push({ bufferView: view, mimeType: images[i].mime });
        g.samplers ||= [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
        imageIndex.set(i, (g.textures ||= []).push({ sampler: 0, source: g.images.length - 1 }) - 1);
      }
      return imageIndex.get(i);
    };
    if (Number.isInteger(tex.map)) { (m.pbrMetallicRoughness ||= {}).baseColorTexture = { index: textureOf(tex.map) }; }
    if (Number.isInteger(tex.normalMap)) m.normalTexture = { index: textureOf(tex.normalMap) };
    if (Number.isInteger(tex.emissiveMap)) m.emissiveTexture = { index: textureOf(tex.emissiveMap) };
  }
  if ((g.images || []).some(i => i.mimeType === 'image/webp')) {
    g.extensionsUsed = [...new Set([...(g.extensionsUsed || []), 'EXT_texture_webp'])];
    for (const t of g.textures || []) if (g.images[t.source]?.mimeType === 'image/webp') { t.extensions = { EXT_texture_webp: { source: t.source } }; }
  }
  return writeGlb(g, state.bin);
}

// ---------- loaders ----------
const meshOf = geometry => {
  if (!geometry.index && !geometry.getAttribute('position')?.count) fail('The file has no geometry');
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({ color: 0xbfc4cc, roughness: 0.8, vertexColors: !!geometry.getAttribute('color') });
  return new THREE.Mesh(geometry, material);
};
const lower = s => s.toLowerCase();
async function load(format, main, files, notes) {
  const manager = new THREE.LoadingManager();
  switch (format) {
    case 'fbx': {
      const root = new FBXLoader(manager).parse(arrayBuffer(main.bytes), '');
      // FBX units are centimetres unless the file says otherwise (UnitScaleFactor = centimetres per unit).
      const unit = Number(root.userData?.unitScaleFactor) > 0 ? root.userData.unitScaleFactor / 100 : 0.01;
      return { root, animations: root.animations || [], metres: unit, units: unit === 0.01 ? 'FBX centimetres' : `FBX, ${unit} m per unit` };
    }
    case 'obj': {
      const loader = new OBJLoader(manager);
      const text = main.bytes.toString('utf8');
      const libs = [...text.matchAll(/^\s*mtllib\s+(.+?)\s*$/gm)].map(m => m[1]);
      for (const lib of libs) {
        const path = safeResourceUri(lib), bytes = path && (files.get(path) || [...files].find(([k]) => lower(k.split('/').pop()) === lower(path.split('/').pop()))?.[1]);
        if (!bytes) { notes.push(`Materials file ${lib.slice(0, 60)} was not included, so the model is plain grey`); continue; }
        const materials = new MTLLoader(manager).parse(bytes.toString('utf8'), '');
        materials.preload(); loader.setMaterials(materials);
      }
      return { root: loader.parse(text), animations: [], metres: null, units: 'OBJ (no units)' };
    }
    case 'stl': return { root: meshOf(new STLLoader(manager).parse(arrayBuffer(main.bytes))), animations: [], metres: null, units: 'STL (no units)' };
    case 'ply': {
      const head = main.bytes.subarray(0, 4096).toString('latin1');
      if (/property\s+\w+\s+f_dc_0/.test(head) || /property\s+\w+\s+opacity/.test(head)) fail('This PLY is a Gaussian splat, not a mesh. Splats are not supported yet (docs/import.md)');
      if (!/element\s+face\s+[1-9]/.test(head)) fail('This PLY has no faces (a point cloud). Import a mesh');
      return { root: meshOf(new PLYLoader(manager).parse(arrayBuffer(main.bytes))), animations: [], metres: null, units: 'PLY (no units)' };
    }
    case 'usdz': {
      const root = await new Promise((resolve, reject) => {
        try { const out = new USDLoader(manager).parse(arrayBuffer(main.bytes), '', resolve, reject); if (out?.isObject3D) resolve(out); } catch (e) { reject(e); }
      });
      return { root, animations: root.animations || [], metres: 1, units: 'USDZ metres' };
    }
  }
  fail(`Cannot convert ${format}`);
}

/** A three.js scene (and clips) as GLB bytes in Node: test fixtures and generated assets. */
export function exportGlb(root, animations = []) {
  return withShims(async () => Buffer.from(await new GLTFExporter().parseAsync(root, { binary: true, animations, onlyVisible: false })));
}

/**
 * Convert one file (main = { name, bytes }, files = Map(path → bytes) of everything beside it) to a GLB.
 * Returns { glb, metres (metres per file unit, or null when the format has none), units, notes }.
 */
export async function convertToGlb(format, main, files = new Map()) {
  return withShims(async ({ warnings }) => {
    const notes = [];
    let loaded;
    try { loaded = await load(format, main, files, notes); }
    catch (e) { if (e.status) throw e; fail(`Could not read this ${format.toUpperCase()} file: ${String(e.message || e).split('\n')[0].slice(0, 200)}`); }
    const { root, animations } = loaded;
    await new Promise(r => setTimeout(r, 1)); // the stand-in <img> reports its load on the next tick; textures get their image then
    root.updateMatrixWorld(true);
    let meshes = 0; root.traverse(o => { if (o.isMesh) meshes++; });
    if (!meshes) fail(animations.length ? 'This file holds only animation (no mesh). Import a character that includes its mesh' : 'The file has no meshes');
    const images = await prepareMaterials(root, files, notes);
    let glb;
    try { glb = Buffer.from(await new GLTFExporter().parseAsync(root, { binary: true, animations, onlyVisible: false })); }
    catch (e) { fail(`Could not convert this ${format.toUpperCase()} file: ${String(e.message || e).split('\n')[0].slice(0, 200)}`); }
    if (images.length) glb = attachTextures(glb, images);
    for (const w of warnings) if (/not supported|skipping|missing|not found/i.test(w)) notes.push(w.replace(/^THREE\.\w+:\s*/, ''));
    return { glb, metres: loaded.metres, units: loaded.units, notes: [...new Set(notes)].slice(0, 8) };
  });
}
