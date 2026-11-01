// Copyright (c) 2026 Steven Bobyn. SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateMesh, MESH_LIMITS } from '../server/previs/mesh.mjs';
import { readHandoffDir, readHandoffZip, validateHandoff, handoffToOps, frameName } from '../server/previs/blender-import.mjs';
import { openDirector, createProjectDocument, applyOps } from '../server/previs/director.mjs';
import { readZip, writeZip } from '../server/previs/zip.mjs';
import { shotSignature } from '../shared/director.mjs';
const fixture = new URL('./fixtures/blender-handoff/shot.previs-blender/', import.meta.url);
const cone = await readFile(new URL('./fixtures/blender-handoff/cone.glb', import.meta.url));
const fresh = async () => JSON.parse(await readFile(new URL('blender-previs.json', fixture), 'utf8'));
const withDir = async fn => { const dir = await realpath(await mkdtemp(join(tmpdir(), 'previs-mesh-'))); try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); } };
function modify(fn) {
  const end = 20 + cone.readUInt32LE(12), g = JSON.parse(cone.toString('utf8', 20, end));
  const changed = fn(g, cone.subarray(end + 8)), bin = Buffer.isBuffer(changed) ? changed : cone.subarray(end + 8);
  const chunk = Buffer.alloc(8); chunk.writeUInt32LE(bin.length); chunk.writeUInt32LE(0x004e4942, 4);
  let json = Buffer.from(JSON.stringify(g)); json = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 32)]);
  const bytes = Buffer.concat([cone.subarray(0, 20), json, chunk, bin]);
  bytes.writeUInt32LE(bytes.length, 8); bytes.writeUInt32LE(json.length, 12); return bytes;
}
test('mesh boundary: real Blender GLB, caps, external resources, extensions and malformed accessors', () => {
  assert.equal(validateMesh(cone).triangles, 124);
  for (const fn of [g => g.buffers[0].uri = 'https://example.org/a.bin', g => g.images = [{ uri: 'file:///secret' }], g => g.extensionsUsed = ['KHR_draco_mesh_compression'], g => g.nodes[0].children = [0], g => g.accessors[0].count = 1e9, g => g.bufferViews[0].byteOffset = -4, g => g.accessors[0].sparse = {}, g => g.meshes[0].primitives[0].mode = 1]) assert.throws(() => validateMesh(modify(fn)), /Mesh:/);
  assert.throws(() => validateMesh(Buffer.alloc(MESH_LIMITS.bytes + 1)), /under 2 MB/);
  assert.throws(() => validateMesh(modify(g => { g.meshes[0].primitives = Array(200).fill(g.meshes[0].primitives[0]); })), /primitives/);
  const overTriangles = modify((g, bin) => {
    const one = g.bufferViews[0].byteLength;
    const positions = Buffer.concat(Array(11).fill(bin.subarray(0, one))), normals = Buffer.concat(Array(11).fill(bin.subarray(one)));
    g.accessors.forEach(a => a.count *= 11);
    g.bufferViews[0].byteLength = positions.length;
    g.bufferViews[1].byteOffset = positions.length; g.bufferViews[1].byteLength = normals.length;
    g.buffers[0].byteLength = positions.length + normals.length;
    g.meshes[0].primitives = Array(16).fill(g.meshes[0].primitives[0]);
    return Buffer.concat([positions, normals]);
  });
  assert.throws(() => validateMesh(overTriangles), /more than 20000 triangles/);
  const nan = Buffer.from(cone); nan.writeFloatLE(NaN, 28 + cone.readUInt32LE(12)); assert.throws(() => validateMesh(nan), /finite/);
});
test('handoff meshes: folder and zip, missing/undeclared meshes, traversal and symlink refusal', async () => withDir(async dir => {
  await cp(fixture, dir, { recursive: true }); await mkdir(join(dir, 'meshes'));
  const m = await fresh(); m.objects[0].mesh = 'meshes/cone.glb';
  await writeFile(join(dir, 'blender-previs.json'), JSON.stringify(m)); await writeFile(join(dir, m.objects[0].mesh), cone);
  const h = await readHandoffDir(dir); assert.deepEqual(h.meshes.get('meshes/cone.glb'), cone);
  const many = structuredClone(m); many.objects = Array.from({ length: 60 }, (_, i) => ({ ...m.objects[0], name: `Cone ${i}` }));
  const instanced = modify(g => { g.meshes[0].primitives = Array(16).fill(g.meshes[0].primitives[0]); });
  assert.throws(() => validateHandoff(many, null, new Map([['meshes/cone.glb', instanced]])), /100000 triangles total/);
  const entries = [{ name: 'blender-previs.json', data: Buffer.from(JSON.stringify(m)) }, ...[...h.frames].map(([i, data]) => ({ name: frameName(i), data })), { name: 'meshes/cone.glb', data: cone }];
  assert.deepEqual(readHandoffZip(writeZip(entries)).meshes, h.meshes);
  assert.throws(() => readHandoffZip(writeZip(entries.slice(0, -1))), /missing/);
  assert.throws(() => readHandoffZip(writeZip([...entries, { name: 'meshes/extra.glb', data: cone }])), /Undeclared mesh/);
  m.objects[0].mesh = '../escape.glb'; assert.throws(() => validateHandoff(m), /invalid mesh path/);
  await rm(join(dir, 'meshes/cone.glb')); await symlink(new URL('./fixtures/blender-handoff/cone.glb', import.meta.url), join(dir, 'meshes/cone.glb'));
  await assert.rejects(readHandoffDir(dir), /not a link/);
  await rm(join(dir, 'meshes'), { recursive: true }); await symlink(new URL('./fixtures/blender-handoff', import.meta.url), join(dir, 'meshes'));
  await assert.rejects(readHandoffDir(dir), /not a link/);
}));
test('mesh refresh retains names, looks and notes, updates geometry and invalidates older blockouts', async () => {
  const p = createProjectDocument({ template: 'empty' }), m = await fresh(); m.objects[0].mesh = 'meshes/cone.glb';
  const model = `/director-refs/${p.id}/${randomUUID()}.glb`;
  applyOps(p, handoffToOps(p, m, { models: new Map([['meshes/cone.glb', model]]) }).ops);
  const e = p.scene.entities[0]; e.look = 'existing-look'; e.notes = 'keep'; e.pitch = 25;
  const before = shotSignature(p, p.shots[0]);
  const next = model.replace(/[^/]+$/, `${randomUUID()}.glb`);
  applyOps(p, handoffToOps(p, m, { models: new Map([['meshes/cone.glb', next]]) }).ops);
  assert.equal(e.model, next); assert.equal(e.look, 'existing-look'); assert.equal(e.notes, 'keep'); assert.equal(e.pitch, 0);
  assert.notEqual(shotSignature(p, p.shots[0]), before);
  delete m.objects[0].mesh; applyOps(p, handoffToOps(p, m).ops); assert.equal(e.model, undefined);
});
test('library save, bundle, place, duplicate and project export carry mesh bytes independently of source', async () => withDir(async dir => {
  const d = await openDirector(dir), p = await d.create({ template: 'empty' });
  const file = `${randomUUID()}.glb`, id = randomUUID(); await d.storeMesh(p.id, file, cone);
  await d.edit(p.id, [{ op: 'add_entity', entity: { id, name: 'Cone', shape: 'box', model: `/director-refs/${p.id}/${file}` } }]);
  const saved = await d.library.save(p.id, { object: id });
  assert.equal(saved.asset.entities[0].model, `refs/${file}`);
  const zip = await d.library.exportZip('@cone'); assert.deepEqual(readZip(zip.data).get(`refs/${file}`), cone);
  const other = await openDirector(join(dir, 'other')); await other.library.importZip(zip.data);
  await d.archive(p.id);
  const q = await other.create({ template: 'empty' }), placed = await other.library.place(q.id, { asset: '@cone' });
  const e = placed.project.scene.entities[0]; assert.match(e.model, new RegExp(q.id));
  assert.deepEqual(await readFile(await other.refFile(q.id, e.model.split('/').pop())), cone);
  const duplicate = (await other.duplicate(q.id)).project;
  assert.match(duplicate.scene.entities[0].model, new RegExp(duplicate.id));
  const exported = await other.exportZip(q.id), imported = (await d.importZip(exported.data)).project;
  assert.match(imported.scene.entities[0].model, new RegExp(imported.id));
  assert.deepEqual(await readFile(await d.refFile(imported.id, imported.scene.entities[0].model.split('/').pop())), cone);
}));
test('library imports one Blender mesh directly, from folder and zip', async () => withDir(async dir => {
  const handoff = join(dir, 'shot'); await cp(fixture, handoff, { recursive: true }); await mkdir(join(handoff, 'meshes'));
  const m = await fresh(); m.objects[0].mesh = 'meshes/cone.glb';
  await writeFile(join(handoff, 'blender-previs.json'), JSON.stringify(m)); await writeFile(join(handoff, m.objects[0].mesh), cone);
  const d = await openDirector(join(dir, 'data'));
  const saved = await d.library.importPath({ path: handoff, object: m.objects[0].name });
  assert.match(saved.asset.entities[0].model, /^refs\/.*\.glb$/);
  const h = await readHandoffDir(handoff), zip = join(dir, 'shot.zip');
  await writeFile(zip, writeZip([{ name: 'blender-previs.json', data: Buffer.from(JSON.stringify(m)) }, ...[...h.frames].map(([i, data]) => ({ name: frameName(i), data })), { name: m.objects[0].mesh, data: cone }]));
  assert.equal((await d.library.importPath({ path: zip, object: m.objects[0].name })).action, 'unchanged');
}));

test('viewport mesh bounds survive entity scaling for non-unit proxy shapes', async () => {
  const THREE = await import('three'), { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  const ts = (await import('typescript')).default, { runInNewContext } = await import('node:vm');
  const models = await import('../shared/blockout-models.mjs'), director = await import('../shared/director.mjs');
  const source = (await readFile(new URL('../src/director-models.ts', import.meta.url), 'utf8')).replaceAll('import.meta.env.BASE_URL', "'/'");
  const exports = {}, urls = [];
  class LocalLoader { async loadAsync(url) { urls.push(url); return new GLTFLoader().parseAsync(cone.buffer.slice(cone.byteOffset, cone.byteOffset + cone.byteLength), ''); } }
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, require: name => name === 'three' ? THREE : name.includes('GLTFLoader') ? { GLTFLoader: LocalLoader } : name.includes('blockout-models') ? models : director });
  const model = `/director-refs/${randomUUID()}/${randomUUID()}.glb`;
  for (const shape of ['person', 'car', 'cylinder']) {
    const e = director.makeEntity({ shape, model, scale: [2, 3, 4] }, randomUUID());
    await exports.loadBlockoutModels([e]);
    const mesh = exports.buildBlockoutModel(e); mesh.scale.fromArray(e.scale); // scene sync/pose overwrites root scale
    const size = new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3()).toArray();
    director.entitySize(e).forEach((v, i) => assert.ok(Math.abs(v - size[i]) < 0.002, `${shape} axis ${i}: ${size[i]} vs ${v}`));
  }
  assert.deepEqual(urls, [model], 'one cached project-local fetch');
});

test('Blender helper: selected evaluated mesh is decimated and source/settings are preserved', { skip: !process.env.PREVIS_BLENDER && 'set PREVIS_BLENDER to exercise the helper', timeout: 120000 }, async () => withDir(async dir => {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.env.PREVIS_BLENDER, ['-b', '--factory-startup', '--python', 'scripts/blender/build-mesh-test-scene.py', '--', '--out', join(dir, 'shot'), '--selected'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const h = await readHandoffDir(join(dir, 'shot'));
  assert.equal(h.manifest.objects.length, 1); assert.equal(h.manifest.objects[0].name, 'Suzanne');
  assert.equal(h.manifest.objects[0].shape, 'person');
  const info = validateMesh(h.meshes.values().next().value);
  assert.ok(info.triangles > 100 && info.triangles <= 2500);
}));
