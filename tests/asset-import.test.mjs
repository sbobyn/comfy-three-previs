// Copyright (c) 2026 Steven Bobyn. SPDX-License-Identifier: MIT
// 3D model import (server/previs/asset-import.mjs, asset-convert.mjs, glb.mjs, asset-perform.mjs; docs/import.md).
// Every fixture is made here: a rigged figure (tests/helpers/rigged-figure.mjs), glTF, OBJ, STL and PLY text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as THREE from 'three';
import { riggedFigure, riggedFigureGlb } from './helpers/rigged-figure.mjs';
import { exportGlb, convertToGlb } from '../server/previs/asset-convert.mjs';
import { readGlb, writeGlb, packGltf } from '../server/previs/glb.mjs';
import { prepareImport, inspectGlb, sourceFromUpload, sourceFromBundle, sourceFromPath, sourceFromUrl, openAssetImport, IMPORT_LIMITS } from '../server/previs/asset-import.mjs';
import { planPerform } from '../server/previs/asset-perform.mjs';
import { openDirector } from '../server/previs/director.mjs';
import { writeZip } from '../server/previs/zip.mjs';
import { entityTriangles } from '../shared/blockout-lint.mjs';
import { imageSize } from '../server/previs/asset-card.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const withDir = async fn => { const dir = await realpath(await mkdtemp(join(tmpdir(), 'previs-import-'))); try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); } };
const prep = (src, extra = {}) => prepareImport(src, { convert: convertToGlb, file: '11111111-1111-1111-1111-111111111111.glb', projectId: '00000000-0000-0000-0000-000000000000', ...extra });
const near = (a, b, eps = 1e-3) => Math.abs(a - b) < eps;
// One triangle as a .gltf with an external .bin, and its texture.
function triangleGltf({ bin = 'tri.bin', image = 'tex.png' } = {}) {
  const positions = Buffer.from(new Float32Array([0, 0, 0, 2, 0, 0, 0, 3, 0]).buffer), uvs = Buffer.from(new Float32Array([0, 0, 1, 0, 0, 1]).buffer);
  const json = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'Tri' }], meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }], textures: [{ source: 0 }], images: [{ uri: image }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [2, 3, 0] }, { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 24 }], buffers: [{ uri: bin, byteLength: 60 }] };
  return { json, bin: Buffer.concat([positions, uvs]) };
}
const OBJ = 'mtllib crate.mtl\nv 0 0 0\nv 100 0 0\nv 100 50 0\nv 0 50 0\nv 0 0 80\nv 100 0 80\nv 100 50 80\nv 0 50 80\nvt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\nusemtl wood\nf 1/1 2/2 3/3 4/4\nf 5/1 8/4 7/3 6/2\nf 1/1 5/2 6/3 2/4\nf 4/1 3/2 7/3 8/4\n';
const MTL = 'newmtl wood\nKd 0.6 0.4 0.2\nmap_Kd crate.png\n';
const STL = 'solid t\n' + [[[0, 0, 0], [400, 0, 0], [0, 300, 0]], [[0, 0, 0], [0, 300, 0], [0, 0, 200]], [[0, 0, 0], [0, 0, 200], [400, 0, 0]], [[400, 0, 0], [0, 0, 200], [0, 300, 0]]].map(t => `facet normal 0 0 0\nouter loop\n${t.map(v => `vertex ${v.join(' ')}`).join('\n')}\nendloop\nendfacet`).join('\n') + '\nendsolid t\n';
const PLY = 'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n';
const SPLAT_PLY = 'ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nproperty float f_dc_0\nproperty float opacity\nend_header\n';

test('rigged GLB: humanoid found by bone names, clips listed, unit-fitted, 1.8 m character on its first clip', async () => {
  const r = await prep(sourceFromUpload(await riggedFigureGlb(), 'figure.glb'));
  assert.equal(r.info.humanoid, true);
  assert.deepEqual(r.info.clips.map(c => c.name), ['Wave', 'Walk']);
  assert.ok(near(r.info.size[1], 1.816, 0.01), `height ${r.info.size[1]}`);
  assert.ok(r.info.size[0] < 0.7, 'the box is the standing width, not the arm span');
  assert.equal(r.entity.shape, 'person'); assert.equal(r.entity.kind, 'character');
  assert.deepEqual(r.entity.perform, { clip: 'Wave', offset: 0, speed: 1 });
  const rig = r.entity.source.rig;
  assert.ok(rig.rest.armL[0] > 0 && rig.rest.armR[0] < 0, 'left arm on +x: the character faces +z');
  assert.ok(rig.rest.head[1] > 0.85 && rig.rest.footL[1] < 0.1, 'rest joints in the unit box');
  // The stored GLB re-inspects to the unit box: its root nodes are the fit.
  const { json, bin } = readGlb(r.glb), again = inspectGlb(json, bin);
  assert.ok(near(again.bounds.min.y, 0) && near(again.bounds.max.y, 1) && near(again.bounds.min.x, -again.bounds.max.x), JSON.stringify(again.bounds));
  assert.deepEqual(json.scenes[0].nodes.map(i => json.nodes[i].name), ['previs-import']);
});

test('rigged GLB facing away or lying Z-up is turned to face +z, without correcting its lean', async () => {
  for (const turn of [new THREE.Euler(0, Math.PI, 0), new THREE.Euler(Math.PI / 2, 0, 0)]) {
    const { root, animations } = riggedFigure();
    const holder = new THREE.Group(); holder.rotation.copy(turn); holder.add(root); holder.updateMatrixWorld(true);
    for (const b of root.getObjectByName('Figure').skeleton.bones) b.name = b.name.replace(/[:.]/g, '');
    const r = await prep(sourceFromUpload(await exportGlb(holder, animations), 'turned.glb'));
    const rest = r.entity.source.rig.rest;
    assert.ok(rest.armL[0] > 0.1 && rest.head[1] > rest.body[1] + 0.2, `${turn.toArray()} → ${JSON.stringify(rest.armL)}`);
    assert.ok(near(r.info.size[1], 1.816, 0.02));
  }
});

test('glTF with its .bin and texture: packed into one GLB from a folder, a zip or a multi-file drop', async () => {
  const { json, bin } = triangleGltf();
  const zip = writeZip([{ name: 'model/tri.gltf', data: Buffer.from(JSON.stringify(json)) }, { name: 'model/tri.bin', data: bin }, { name: 'model/tex.png', data: PNG }, { name: '__MACOSX/._tri.gltf', data: Buffer.from('x') }]);
  const r = await prep(sourceFromUpload(zip, 'tri.zip'));
  const g = readGlb(r.glb).json;
  assert.equal(g.images[0].mimeType, 'image/png'); assert.equal(g.images[0].uri, undefined);
  assert.equal(g.buffers.length, 1); assert.equal(g.buffers[0].uri, undefined);
  assert.equal(r.entity.shape, 'box'); assert.deepEqual(r.info.size, [2, 3, 0.003]);
  // A multi-file drop body: [u32 header length][JSON [{ name, size }]][bytes …].
  const files = [['tri.gltf', Buffer.from(JSON.stringify(json))], ['tri.bin', bin], ['tex.png', PNG]];
  const head = Buffer.from(JSON.stringify(files.map(([name, b]) => ({ name, size: b.length })))), len = Buffer.alloc(4); len.writeUInt32LE(head.length);
  assert.equal(readGlb((await prep(sourceFromBundle(Buffer.concat([len, head, ...files.map(f => f[1])])))).glb).json.images.length, 1);
  await withDir(async dir => {
    for (const [name, b] of files) await writeFile(join(dir, name), b);
    await writeFile(join(dir, 'unrelated.txt'), 'not read');
    const src = await sourceFromPath(join(dir, 'tri.gltf'));
    assert.deepEqual([...src.files.keys()].sort(), ['tex.png', 'tri.bin'], 'only the files the model names are read');
  });
  // Missing files, paths outside the folder and URLs are refused with the file named.
  await assert.rejects(prep(sourceFromUpload(Buffer.from(JSON.stringify(json)), 'tri.gltf')), /buffer “tri.bin” is missing/);
  for (const uri of ['../secret.bin', 'https://example.org/tri.bin', 'file:///etc/passwd', '/etc/passwd']) assert.throws(() => packGltf(triangleGltf({ bin: uri }).json, { resource: () => bin }), /outside its folder/, uri);
});

test('OBJ + MTL + texture, STL in millimetres, PLY mesh: converted with three.js loaders, units guessed and reported', async () => {
  const zip = writeZip([{ name: 'crate.obj', data: Buffer.from(OBJ) }, { name: 'crate.mtl', data: Buffer.from(MTL) }, { name: 'crate.png', data: PNG }]);
  const obj = await prep(sourceFromUpload(zip, 'crate.zip'));
  const g = readGlb(obj.glb).json;
  assert.equal(g.images?.[0]?.mimeType, 'image/png', 'the texture is carried as its original bytes');
  assert.equal(g.materials[0].pbrMetallicRoughness.baseColorTexture.index, 0);
  assert.match(obj.info.units, /centimetres/); assert.deepEqual(obj.info.size, [1, 0.5, 0.8]);
  const stl = await prep(sourceFromUpload(Buffer.from(STL), 'bracket.stl'));
  assert.match(stl.info.units, /millimetres/); assert.deepEqual(stl.info.size, [0.4, 0.3, 0.2]); assert.equal(stl.entity.name, 'Bracket');
  assert.equal((await prep(sourceFromUpload(Buffer.from(PLY), 'tri.ply'))).info.triangles, 1);
  await assert.rejects(prep(sourceFromUpload(Buffer.from(SPLAT_PLY), 'scan.ply')), /Gaussian splat/);
  await assert.rejects(prep(sourceFromUpload(Buffer.from(PLY.replace('element face 1', 'element face 0')), 'cloud.ply')), /no faces/);
  const height = await prep(sourceFromUpload(Buffer.from(STL), 'bracket.stl'), { height: 1.5 });
  assert.ok(near(height.info.size[1], 1.5));
});

test('refusals: unknown formats, compressed meshes, over-limit triangles and bad containers change nothing', async () => {
  assert.throws(() => sourceFromUpload(Buffer.from('hello'), 'notes.txt'), /Unsupported file/);
  assert.throws(() => sourceFromUpload(writeZip([{ name: 'a.glb', data: PNG }, { name: 'b.glb', data: PNG }]), 'two.zip'), /one model at a time/);
  assert.throws(() => sourceFromUpload(writeZip([{ name: 'readme.txt', data: PNG }]), 'none.zip'), /No model file/);
  const glb = await riggedFigureGlb(), { json, bin } = readGlb(glb);
  const variant = fn => { const j = structuredClone(json); fn(j); return writeGlb(j, bin); };
  await assert.rejects(prep(sourceFromUpload(variant(j => { j.extensionsRequired = ['KHR_draco_mesh_compression']; }), 'd.glb')), /Draco/);
  await assert.rejects(prep(sourceFromUpload(variant(j => { j.extensionsRequired = ['EXT_vendor_magic']; }), 'v.glb')), /EXT_vendor_magic/);
  await assert.rejects(prep(sourceFromUpload(variant(j => { j.accessors.push({ componentType: 5125, count: (IMPORT_LIMITS.triangles + 1) * 3, type: 'SCALAR' }); j.meshes[0].primitives[0].indices = j.accessors.length - 1; }), 'big.glb')), /triangles; the limit/);
  await assert.rejects(prep(sourceFromUpload(variant(j => { j.nodes[0].children = [0]; }), 'loop.glb')), /node tree/);
  await assert.rejects(prep(sourceFromUpload(variant(j => { j.bufferViews[0].byteLength = 1e9; }), 'short.glb')), /runs past/);
  assert.throws(() => readGlb(Buffer.from('glTF but not really')), /Not a GLB/);
  await assert.rejects(sourceFromUrl('http://example.org/a.glb'), /https/);
  await assert.rejects(sourceFromPath('relative/a.glb'), /absolute path/);
  await assert.rejects(sourceFromUrl('https://example.org/a.glb', { fetchImpl: async () => ({ ok: true, url: 'https://example.org/a.glb', headers: new Map([['content-length', String(1e12)]]), body: [] }) }), /at most/);
});

test('project: import stores the GLB, adds one object with its rights; perform keys clips and poses; export and duplicate keep it', async () => withDir(async dir => {
  const director = await openDirector(dir), p = await director.create({ template: 'empty' });
  const importer = openAssetImport({ director, convert: convertToGlb });
  const r = await importer.fromUpload(await riggedFigureGlb(), { projectId: p.id, file: 'figure.glb', licence: 'CC0', attribution: 'video-lab tests', place: { position: [2, 0, -1] } });
  const e = r.project.scene.entities.find(x => x.id === r.entityId);
  assert.equal(e.name, 'Figure'); assert.deepEqual(e.position, [2, 0, -1]);
  assert.equal(e.source.licence, 'CC0'); assert.equal(e.source.attribution, 'video-lab tests');
  assert.equal((await readdir(join(dir, 'director', p.id, 'refs'))).length, 1);
  assert.deepEqual(entityTriangles(e), [], 'imported models are not linted as blockout surfaces');
  // Rights can be edited; the file facts and rig cannot.
  const edited = (await director.edit(p.id, [{ op: 'update_entity', id: e.id, patch: { source: { licence: 'CC-BY 4.0', rig: null, file: 'x' } } }])).project.scene.entities[0];
  assert.equal(edited.source.licence, 'CC-BY 4.0'); assert.equal(edited.source.file, 'figure.glb'); assert.ok(edited.source.rig);
  // Clip from shot 2's start; a pose with an IK hand target at shot 1; a neutral stand-in.
  await director.edit(p.id, [{ op: 'add_shot', shot: { title: 'Two', duration: 2 } }, { op: 'update_shot', id: '2', patch: { start: 3 } }]);
  let q = await director.get(p.id);
  for (const input of [{ object: '@figure', shot: '2', clip: 'Walk', speed: 1.5 }, { object: 'Figure', shot: '1', pose: 'stand', ik: { handR: [-0.25, 1.4, 0.3] } }, { object: e.id, standIn: 'neutral' }]) {
    const plan = planPerform(q, input); q = (await director.edit(p.id, plan.ops)).project;
  }
  const f = q.scene.entities[0];
  assert.deepEqual(f.perform.keys, [{ t: 3, clip: 'Walk', offset: 0, speed: 1.5 }]);
  assert.equal(f.standIn, 'neutral');
  assert.ok(f.path.some(k => k.t === 0 && k.pose?.armR), 'the IK pose is keyed at shot 1');
  assert.throws(() => planPerform(q, { object: 'Figure', clip: 'Dance' }), /no clip “Dance”/);
  assert.throws(() => planPerform(q, { object: 'Figure', pose: 'moonwalk' }), /Unknown pose/);
  const box = (await director.edit(p.id, [{ op: 'add_entity', entity: { name: 'Crate', shape: 'box' } }])).project;
  assert.throws(() => planPerform(box, { object: 'Crate', pose: 'stand' }), /not an imported model/);
  // Export → import and duplicate carry the model; the library says plainly it does not take imported models yet.
  const { data } = await director.exportZip(p.id);
  const back = (await director.importZip(data)).project, copy = (await director.duplicate(p.id)).project;
  for (const x of [back, copy]) assert.ok(x.scene.entities[0].model.startsWith(`/director-refs/${x.id}/`) && x.scene.entities[0].source.rig);
  await assert.rejects(director.library.save(p.id, { object: 'Figure' }), /imported model/);
}));

test('server and MCP: raw upload and previs_import_asset by path, then previs_director_perform', { timeout: 60000 }, async () => withDir(async dir => {
  const port = 15000 + Math.floor(Math.random() * 1000), base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['server/previs/server.mjs'], { env: { ...process.env, PORT: String(port), PREVIS_DATA_DIR: join(dir, 'data'), PREVIS_HEADLESS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/director/projects`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
    const p = (await (await fetch(`${base}/api/director/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ template: 'empty' }) })).json()).project;
    const up = await fetch(`${base}/api/director/import-asset?projectId=${p.id}&name=bracket.stl&x=1&y=0&z=2&licence=CC0`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: STL });
    const u = await up.json();
    assert.equal(up.status, 200, u.error); assert.equal(u.name, 'Bracket');
    assert.deepEqual(u.project.scene.entities[0].position, [1, 0, 2]);
    const glb = await fetch(`${base}${u.model}`); assert.equal(glb.status, 200); assert.equal(glb.headers.get('content-type'), 'model/gltf-binary');
    assert.equal((await fetch(`${base}/api/director/import-asset?projectId=${p.id}&name=a.txt`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: 'x' })).status, 400);
    await mkdir(join(dir, 'in')); await writeFile(join(dir, 'in', 'figure.glb'), await riggedFigureGlb());
    const agent = spawn(process.execPath, ['server/previs/agent.mjs'], { env: { ...process.env, PREVIS_URL: base, PREVIS_MCP_LEGACY: '' }, stdio: ['pipe', 'pipe', 'inherit'] });
    try {
      let buf = ''; const waiting = new Map(); let id = 0;
      agent.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); } });
      const call = (name, args) => new Promise(r => { const n = ++id; waiting.set(n, r); agent.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method: 'tools/call', params: { name, arguments: args } }) + '\n'); });
      const imported = await call('previs_import_asset', { projectId: p.id, path: join(dir, 'in', 'figure.glb'), place: { position: [0, 0, 0] } });
      assert.equal(imported.result.isError, false, imported.result.content[0].text);
      const out = JSON.parse(imported.result.content[0].text);
      assert.equal(out.humanoid, true); assert.equal(out.project, undefined, 'the reply leaves the project document out');
      assert.match(out.text, /Imported Figure .*humanoid rig, clips Wave, Walk/);
      const perform = JSON.parse((await call('previs_director_perform', { projectId: p.id, object: 'Figure', clip: 'Walk', speed: 2 })).result.content[0].text);
      assert.deepEqual(perform.perform, { clip: 'Walk', offset: 0, speed: 2 });
      const bad = await call('previs_director_perform', { projectId: p.id, object: 'Bracket', pose: 'sit' });
      assert.equal(bad.result.isError, true); assert.match(bad.result.content[0].text, /no humanoid rig/);
    } finally { agent.kill(); }
  } finally { server.kill(); }
}));

test('Blender-made FBX, USDZ and OBJ (+MTL) of a rigged figure import as the same 1.78 m figure', { skip: !process.env.PREVIS_BLENDER && 'set PREVIS_BLENDER to build the fixture', timeout: 120000 }, async () => withDir(async dir => {
  const { spawnSync } = await import('node:child_process');
  const run = spawnSync(process.env.PREVIS_BLENDER, ['-b', '--factory-startup', '--python', 'scripts/blender/build-rigged-test-asset.py', '--', '--out', dir], { encoding: 'utf8' });
  assert.match(run.stdout, /PREVIS_FIXTURE_OK/, run.stderr);
  const fbx = await prep(await sourceFromPath(join(dir, 'figure.fbx')));
  assert.equal(fbx.info.humanoid, true); assert.equal(fbx.info.clips.length, 1); assert.ok(near(fbx.info.size[1], 1.78, 0.02));
  const usdz = await prep(await sourceFromPath(join(dir, 'figure.usdz')));
  assert.equal(usdz.info.humanoid, true); assert.ok(near(usdz.info.size[1], 1.78, 0.02));
  const obj = await prep(await sourceFromPath(join(dir, 'figure.obj')));
  assert.equal(obj.info.humanoid, false); assert.deepEqual(obj.info.notes, [], 'the .mtl beside it was read'); assert.ok(near(obj.info.size[1], 1.78, 0.02));
}));

test('backdrop card: a PNG, JPEG or WebP becomes an upright unlit quad, 4 m wide or the height asked for', async () => {
  // Headers only: the card carries the bytes as they are; nothing is decoded on the server.
  const png = Buffer.concat([PNG.subarray(0, 16), Buffer.from([0, 0, 6, 64, 0, 0, 3, 132]), PNG.subarray(24)]); // 1600 × 900
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 200, 1, 44, 3, 0, 0, 0, 0, 0, 0]); // 300 × 200
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8X'), Buffer.alloc(8), Buffer.from([127, 2, 0, 223, 1, 0])]); // 640 × 480
  assert.deepEqual([png, jpeg, webp].map(imageSize), [{ width: 1600, height: 900 }, { width: 300, height: 200 }, { width: 640, height: 480 }]);
  const card = await prep(sourceFromUpload(png, 'night-sky.png'));
  assert.deepEqual(card.info.size, [4, 2.25, 0.05]); assert.equal(card.entity.kind, 'environment'); assert.equal(card.entity.name, 'Night sky');
  const g = readGlb(card.glb).json;
  assert.deepEqual(g.extensionsUsed, ['KHR_materials_unlit']); assert.equal(g.materials[0].doubleSided, true); assert.equal(g.images[0].mimeType, 'image/png');
  const { json, bin } = readGlb(card.glb), box = inspectGlb(json, bin).bounds;
  assert.deepEqual([box.min.x, box.min.y, box.max.x, box.max.y], [-0.5, 0, 0.5, 1], 'already in the unit box');
  assert.deepEqual((await prep(sourceFromUpload(webp, 'plate.webp'), { height: 3 })).info.size, [4, 3, 0.05]);
  assert.equal(readGlb((await prep(sourceFromUpload(webp, 'plate.webp'))).glb).json.textures[0].extensions.EXT_texture_webp.source, 0);
});
