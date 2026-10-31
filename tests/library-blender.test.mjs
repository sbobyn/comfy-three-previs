import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDirector } from '../server/previs/director.mjs';
import { openLibrary, blenderHandoffReader, blenderObject, BLENDER_SIDECAR } from '../server/previs/library.mjs';
import { writeZip } from '../server/previs/zip.mjs';
import { SHAPES } from '../shared/director.mjs';

// The asset library, phase 4: one object out of a Blender handoff (blender-previs.json, written by the Blender
// thin import's previs_export.py) becomes a sized proxy asset. Reading and validating the export belong to
// server/previs/blender-import.mjs; until that module is in this build the library says so instead of guessing.
const READER = new URL('../server/previs/blender-import.mjs', import.meta.url);
const FIXTURE = new URL('./fixtures/blender-handoff/shot.previs-blender/', import.meta.url);
const withDir = async fn => { const root = await realpath(await mkdtemp(join(tmpdir(), 'previs-library-blender-'))); try { return await fn(root); } finally { await rm(root, { recursive: true, force: true }); } };

/** The sidecar fields the library reads, in the export's format (objects already in Previs names; positions Z-up). */
const sidecar = (carSize = [1.9, 1.45, 4.5]) => ({
  format: 'comfy-previs-blender-handoff', version: 1, source: { file: null, scene: 'Scene', camera: 'ShotCam', frameStart: 1, frameEnd: 12 }, fps: 24, frameCount: 12, width: 640, height: 360, axes: 'blender-z-up',
  objects: [
    { name: 'Crate', blenderName: 'Crate', cast: false, shape: 'box', color: '#e77c6c', frames: [{ frame: 1, position: [3, 2, 0], yaw: 0, size: [1, 1, 1] }] },
    { name: 'Comfy Car', blenderName: 'cast:Comfy Car', cast: true, shape: 'car', color: '#5d95ed', frames: [{ frame: 1, position: [-6, -2, 0], yaw: 120.964, size: carSize }, { frame: 2, position: [-5, -2, 0], yaw: 121, size: carSize }] },
    { name: 'Runner', blenderName: 'cast:Runner', cast: true, shape: 'person', color: '#f3da95', frames: [{ frame: 1, position: [1.5, -1, 0], yaw: 200, size: [0.5, 1.8, 0.35] }] },
  ],
});
/** A stand-in with blender-import.mjs's reader API: readDir(path) / readZip(buffer) → { manifest }, validate(m). */
const fakeReader = { calls: [], async readDir(path) { this.calls.push('dir'); return { manifest: JSON.parse(await readFile(join(path, BLENDER_SIDECAR), 'utf8')), frames: new Map() }; },
  readZip(buffer) { this.calls.push('zip'); return { manifest: JSON.parse(String(buffer.subarray(buffer.indexOf('{'), buffer.lastIndexOf('}') + 1))), frames: new Map() }; },
  validate(m) { if (m?.format !== 'comfy-previs-blender-handoff') throw Object.assign(Error('Not a Blender export for Previs'), { status: 400 }); return m; } };

test('without the Blender importer in this build, a Blender export is refused with a plain reason', { skip: existsSync(READER) && 'blender-import.mjs is present: the fixture test below covers the real reader' }, async () => {
  assert.equal(await blenderHandoffReader(), null);
  await withDir(async root => {
    const director = await openDirector(join(root, 'data'));
    const shot = join(root, 'shot.previs-blender'); await mkdir(shot);
    await writeFile(join(shot, BLENDER_SIDECAR), JSON.stringify(sidecar()));
    await assert.rejects(director.library.importPath({ path: shot, object: 'Comfy Car' }), e => e.status === 501 && /cannot read Blender exports yet: the Blender importer \(server\/previs\/blender-import\.mjs\) is not installed/.test(e.message));
    assert.deepEqual((await director.library.list()).assets, []);
  });
});

test('a Blender object becomes a sized proxy asset: shape, kind, colour, yaw and size from its first frame', async () => {
  await withDir(async root => {
    const lib = openLibrary(join(root, 'library'), { blender: async () => fakeReader });
    const shot = join(root, 'shot.previs-blender'); await mkdir(shot);
    await writeFile(join(shot, BLENDER_SIDECAR), JSON.stringify(sidecar()));
    await assert.rejects(lib.importPath(shot, {}), /This is a Blender export; name the object to take from it: Crate, Comfy Car, Runner/);
    await assert.rejects(lib.importPath(shot, { object: 'Blue car' }), e => e.status === 404 && /No object called “Blue car” in that Blender export/.test(e.message));
    const car = await lib.importPath(shot, { object: 'cast:Comfy Car', tags: ['car'] });
    assert.equal(car.action, 'added'); assert.equal(car.text, 'Saved @comfy-car v1 with no images yet (a sized proxy: add its description and images)');
    const m = await lib.get('@comfy-car');
    assert.equal(m.origin.source, 'blender'); assert.equal(m.origin.projectId, ''); assert.deepEqual(m.references, []); assert.deepEqual(m.media, []);
    const [e] = m.entities;
    assert.equal(e.shape, 'car'); assert.equal(e.kind, 'vehicle'); assert.equal(e.color, '#5d95ed'); assert.equal(e.rotation, 120.964);
    assert.deepEqual(e.position, [0, 0, 0]);
    assert.deepEqual(e.scale.map((v, i) => Math.round(v * SHAPES.car.size[i] * 1000) / 1000), [1.9, 1.45, 4.5], 'size / the shape size');
    assert.deepEqual(m.footprint, [1.9, 1.45, 4.5]);
    assert.equal((await lib.importPath(shot, { object: 'Comfy Car', tags: ['car'] })).action, 'unchanged', 'the same Blender object again is the same asset');
    await writeFile(join(shot, BLENDER_SIDECAR), JSON.stringify(sidecar([2, 1.5, 4.8])));
    const v2 = await lib.importPath(shot, { object: '@comfy-car', tags: ['car'] });
    assert.equal(v2.action, 'updated'); assert.equal(v2.asset.version, 2); assert.equal(v2.asset.id, m.id);
    // Set dressing (not cast:) is environment; a zip of the export works the same way.
    const zip = join(root, 'shot.zip');
    await writeFile(zip, writeZip([{ name: `shot.previs-blender/${BLENDER_SIDECAR}`, data: Buffer.from(JSON.stringify(sidecar())) }]));
    const crate = await lib.importPath(zip, { object: 'Crate' });
    assert.equal(crate.asset.kind, 'environment'); assert.equal(crate.asset.shape, 'box');
    assert.deepEqual(fakeReader.calls, ['dir', 'dir', 'dir', 'dir', 'dir', 'zip']);
    // A sidecar the reader refuses never reaches the library.
    await writeFile(join(shot, BLENDER_SIDECAR), JSON.stringify({ ...sidecar(), format: 'something-else' }));
    await assert.rejects(lib.importPath(shot, { object: 'Runner' }), /Not a Blender export for Previs/);
  });
});

test('a Blender proxy places like any asset', async () => {
  await withDir(async root => {
    const { project, entity } = blenderObject(sidecar(), 'Runner');
    assert.equal(entity.kind, 'character'); assert.equal(project.scene.entities.length, 1);
    const director = await openDirector(join(root, 'data'));
    const shot = join(root, 'shot.previs-blender'); await mkdir(shot);
    await writeFile(join(shot, BLENDER_SIDECAR), JSON.stringify(sidecar()));
    const lib = openLibrary(join(root, 'data', 'library'), { blender: async () => fakeReader });
    await lib.importPath(shot, { object: 'Runner' });
    const p = await director.create({ template: 'empty' });
    const r = await director.library.place(p.id, { asset: '@runner', position: [2, 0, 0] });
    const e = r.project.scene.entities.find(x => x.id === r.root);
    assert.equal(e.shape, 'person'); assert.equal(e.rotation, 200); assert.deepEqual(e.position, [2, 0, 0]); assert.equal(e.look, null);
  });
});

test('the Blender importer’s own reader and fixture: "Comfy Car" out of a real export', { skip: !(existsSync(READER) && existsSync(FIXTURE)) && 'needs server/previs/blender-import.mjs and its fixture (feat/previs-blender-import-20261031)' }, async () => {
  await withDir(async root => {
    const director = await openDirector(join(root, 'data'));
    const r = await director.library.importPath({ path: await realpath(new URL(FIXTURE).pathname.replace(/\/$/, '')), object: 'Comfy Car' });
    assert.equal(r.action, 'added'); assert.equal(r.asset.handle, 'comfy-car'); assert.equal(r.asset.kind, 'vehicle');
    assert.deepEqual(r.asset.footprint, [1.9, 1.45, 4.5]);
  });
});
