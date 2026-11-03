// Copyright (c) 2026 Steven Bobyn. SPDX-License-Identifier: MIT
// Binary glTF containers: read, write and pack. JSON-level only: vertex data is copied, never decoded or executed.
const MAGIC = 0x46546c67, JSON_CHUNK = 0x4e4f534a, BIN_CHUNK = 0x004e4942;
function fail(message, status = 400) { const e = Error(message); e.status = status; throw e; }
const pad4 = n => (n + 3) & ~3;

/** { json, bin } from GLB bytes. bin is null when the file has no binary chunk. */
export function readGlb(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.length < 20 || buf.readUInt32LE(0) !== MAGIC) fail('Not a GLB file');
  if (buf.readUInt32LE(4) !== 2) fail('Only glTF 2.0 GLB files are supported');
  if (buf.readUInt32LE(8) > buf.length) fail('The GLB file is cut short');
  const total = Math.min(buf.readUInt32LE(8), buf.length);
  const jsonLength = buf.readUInt32LE(12);
  if (buf.readUInt32LE(16) !== JSON_CHUNK || 20 + jsonLength > total) fail('The GLB has no valid JSON chunk');
  let json;
  try { json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLength)); } catch { fail('The GLB JSON is invalid'); }
  let bin = null, at = 20 + jsonLength;
  if (at + 8 <= total) {
    const length = buf.readUInt32LE(at), type = buf.readUInt32LE(at + 4);
    if (type === BIN_CHUNK) { if (at + 8 + length > total) fail('The GLB binary chunk is cut short'); bin = buf.subarray(at + 8, at + 8 + length); }
  }
  if (!json || typeof json !== 'object' || json.asset?.version !== '2.0') fail('Only glTF 2.0 is supported');
  return { json, bin };
}

/** GLB bytes from a glTF JSON document and its single binary buffer. */
export function writeGlb(json, bin = null) {
  const doc = structuredClone(json);
  if (bin?.length) { doc.buffers = [{ byteLength: bin.length }]; } else delete doc.buffers;
  const text = Buffer.from(JSON.stringify(doc), 'utf8');
  const jsonChunk = Buffer.alloc(pad4(text.length), 0x20); text.copy(jsonChunk);
  const binChunk = bin?.length ? Buffer.alloc(pad4(bin.length)) : null; if (binChunk) bin.copy(binChunk);
  const total = 12 + 8 + jsonChunk.length + (binChunk ? 8 + binChunk.length : 0);
  const head = Buffer.alloc(20);
  head.writeUInt32LE(MAGIC, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(total, 8); head.writeUInt32LE(jsonChunk.length, 12); head.writeUInt32LE(JSON_CHUNK, 16);
  const parts = [head, jsonChunk];
  if (binChunk) { const h = Buffer.alloc(8); h.writeUInt32LE(binChunk.length, 0); h.writeUInt32LE(BIN_CHUNK, 4); parts.push(h, binChunk); }
  return Buffer.concat(parts);
}

/** Decode a base64 data: URI, or null for anything else. */
export function dataUri(uri) {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(uri || '');
  if (!m) return null;
  return { mime: m[1] || 'application/octet-stream', bytes: m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8') };
}

/** A relative resource path inside the import (no scheme, no absolute path, no `..`). */
export function safeResourceUri(uri) {
  let path;
  try { path = decodeURIComponent(String(uri)); } catch { return null; }
  if (!path || path.length > 240 || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return null;
  const parts = path.split('/').filter(p => p !== '.');
  if (parts.some(p => !p || p === '..')) return null;
  return parts.join('/');
}

/**
 * One self-contained GLB from a .gltf document (or a GLB's JSON + BIN). Buffers and images are taken from data: URIs,
 * the GLB's own binary chunk, or `resource(path)` for relative files (the same folder or zip). Anything else (http,
 * file:, absolute or `..` paths, a missing file) is refused with the file named.
 */
export function packGltf(json, { bin = null, resource = () => null } = {}) {
  const doc = structuredClone(json);
  const buffers = (doc.buffers || []).map((b, i) => {
    let bytes = null;
    if (b.uri === undefined) bytes = i === 0 ? bin : null;
    else bytes = dataUri(b.uri)?.bytes || (safeResourceUri(b.uri) ? resource(safeResourceUri(b.uri)) : null);
    if (!bytes) fail(b.uri === undefined || dataUri(b.uri) || safeResourceUri(b.uri) ? `The model's buffer ${b.uri ? `“${String(b.uri).slice(0, 80)}”` : i} is missing. Import the whole folder, or a zip of it.` : `The model points outside its folder (${String(b.uri).slice(0, 80)}). Export it as a .glb, or keep its files next to the .gltf.`);
    if (bytes.length < (b.byteLength || 0)) fail(`The model's buffer ${b.uri ? `“${String(b.uri).slice(0, 80)}”` : i} is shorter than it says`);
    return bytes.subarray(0, b.byteLength || bytes.length);
  });
  const chunks = [], offsets = [];
  let size = 0;
  const push = bytes => { const at = size; chunks.push(bytes); size += bytes.length; const padding = pad4(size) - size; if (padding) { chunks.push(Buffer.alloc(padding)); size += padding; } return at; };
  for (const bytes of buffers) offsets.push(push(bytes));
  for (const v of doc.bufferViews || []) {
    if (!Number.isInteger(v.buffer) || !buffers[v.buffer]) fail('The model has a buffer view without a buffer');
    v.byteOffset = (v.byteOffset || 0) + offsets[v.buffer]; v.buffer = 0;
  }
  doc.bufferViews ||= [];
  for (const img of doc.images || []) {
    if (img.uri === undefined) continue;
    const inline = dataUri(img.uri), path = inline ? null : safeResourceUri(img.uri);
    const bytes = inline?.bytes || (path ? resource(path) : null);
    if (!bytes) fail(inline || path ? `The model's texture “${String(img.uri).slice(0, 80)}” is missing. Import the whole folder, or a zip of it.` : `The model points outside its folder (${String(img.uri).slice(0, 80)}). Export it as a .glb, or keep its files next to the .gltf.`);
    img.mimeType = imageMime(bytes) || fail(`The model's texture “${String(img.uri).slice(0, 80)}” is not a PNG, JPEG or WebP image`);
    img.bufferView = doc.bufferViews.push({ buffer: 0, byteOffset: push(bytes), byteLength: bytes.length }) - 1;
    delete img.uri;
  }
  const out = Buffer.concat(chunks);
  if (out.length) doc.buffers = [{ byteLength: out.length }]; else delete doc.buffers;
  return { json: doc, bin: out };
}

/** Append bytes as a new buffer view; returns its index. */
export function appendView(state, bytes) {
  const at = pad4(state.bin.length), bin = Buffer.alloc(at + bytes.length);
  state.bin.copy(bin); bytes.copy(bin, at); state.bin = bin;
  (state.json.bufferViews ||= []).push({ buffer: 0, byteOffset: at, byteLength: bytes.length });
  return state.json.bufferViews.length - 1;
}

export function imageMime(bytes) {
  if (!bytes || bytes.length < 12) return null;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}
