// Copyright (c) 2026 Steven Bobyn. SPDX-License-Identifier: MIT
// An image as a backdrop card (docs/import.md#backdrop-cards): one unlit, two-sided quad carrying the image's own bytes,
// already in the unit box (x −0.5…0.5, y 0…1, z 0), so it renders through the same project-mesh path as a model.
import { writeGlb, imageMime } from './glb.mjs';

function fail(message, status = 400) { const e = Error(message); e.status = status; throw e; }

/** { width, height } in pixels of a PNG, JPEG or WebP, read from its header; null when unreadable. */
export function imageSize(bytes) {
  const mime = imageMime(bytes);
  if (mime === 'image/png') return bytes.length >= 24 ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : null;
  if (mime === 'image/jpeg') {
    for (let i = 2; i + 9 < bytes.length;) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1], len = bytes.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: bytes.readUInt16BE(i + 7), height: bytes.readUInt16BE(i + 5) };
      i += 2 + len;
    }
    return null;
  }
  if (mime === 'image/webp' && bytes.length >= 30) {
    const kind = bytes.toString('latin1', 12, 16);
    if (kind === 'VP8 ') return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') { const b = bytes.readUInt32LE(21); return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }; }
    if (kind === 'VP8X') return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
  }
  return null;
}

/** The card GLB for an image (PNG, JPEG or WebP bytes) and its pixel size. */
export function cardGlb(bytes) {
  const mime = imageMime(bytes) || fail('A backdrop card needs a PNG, JPEG or WebP image');
  const size = imageSize(bytes);
  if (!size?.width || !size?.height) fail('Could not read the image size');
  const positions = new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0]);
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), uvs = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]), index = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const parts = [positions, normals, uvs, index].map(a => Buffer.from(a.buffer));
  const pad = b => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
  const chunks = [...parts.map(pad), pad(bytes)], offsets = []; let at = 0;
  for (const c of chunks) { offsets.push(at); at += c.length; }
  const json = {
    asset: { version: '2.0', generator: 'video-lab backdrop card' }, extensionsUsed: ['KHR_materials_unlit', ...(mime === 'image/webp' ? ['EXT_texture_webp'] : [])],
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'previs-import', mesh: 0 }],
    meshes: [{ name: 'Card', primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    materials: [{ name: 'card', doubleSided: true, pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 }, extensions: { KHR_materials_unlit: {} } }],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
    textures: [mime === 'image/webp' ? { sampler: 0, extensions: { EXT_texture_webp: { source: 0 } } } : { sampler: 0, source: 0 }],
    images: [{ bufferView: 4, mimeType: mime }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-0.5, 0, 0], max: [0.5, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' }, { bufferView: 2, componentType: 5126, count: 4, type: 'VEC2' },
      { bufferView: 3, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
    bufferViews: [...parts, bytes].map((b, i) => ({ buffer: 0, byteOffset: offsets[i], byteLength: b.length, ...(i < 3 ? { target: 34962 } : i === 3 ? { target: 34963 } : {}) })),
  };
  return { glb: writeGlb(json, Buffer.concat(chunks)), width: size.width, height: size.height };
}
