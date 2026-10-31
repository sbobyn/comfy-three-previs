import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Box3, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { BLOCKOUT_MODELS, blockoutModel } from '../shared/blockout-models.mjs';
import { makeEntity, SHAPES, shotSignature } from '../shared/director.mjs';
import { loadStarters, instantiateStarter } from '../server/previs/starters.mjs';
import { terrainHeight } from '../shared/terrain.mjs';

const root = new URL('../public/models/blockouts/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));
const canonical = x => Array.isArray(x) ? x.map(canonical) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x;
const digest = x => createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
const baseline = JSON.parse(readFileSync(new URL('./fixtures/starter-blockout-baseline.json', import.meta.url), 'utf8'));

test('all starter objects have compatible meshes and only display model ids changed from the camera-truth baseline', async () => {
  for (const s of await loadStarters()) {
    const withoutModels = structuredClone(s);
    for (const e of withoutModels.scene.entities) delete e.model;
    assert.equal(digest(withoutModels), baseline[s.slug], `${s.slug}: cameras, entities, timing and media must stay unchanged`);
    for (const e of s.scene.entities) {
      if (e.shape === 'group') assert.equal(e.model, undefined);
      else assert.equal(blockoutModel(e), e.model, `${s.slug}: ${e.name}`);
      if (e.shape !== 'group') assert.ok(e.model, `${e.name} needs a recognisable mesh`);
    }
    const copy = instantiateStarter(s);
    assert.deepEqual(copy.scene.entities.map(e => e.model), s.scene.entities.map(e => e.model));
    const sh = copy.shots[0], sig = shotSignature(copy, sh);
    copy.scene.entities.forEach(e => delete e.model);
    assert.equal(shotSignature(copy, sh), sig, 'display fidelity does not invalidate unchanged camera truth');
    copy.scene.entities[0].position[0] += 1;
    assert.notEqual(shotSignature(copy, sh), sig, 'a blocking edit still invalidates media');
  }
});

test('model ids cannot be URLs, paths, prototype keys or meshes for a different proxy', () => {
  for (const model of ['../race-car', 'https://example.com/a.glb', '__proto__', 'constructor', 'eagle']) {
    assert.equal(makeEntity({ shape: 'car', model }, 'a').model, undefined);
  }
  assert.equal(makeEntity({ shape: 'car', model: 'race-car' }, 'a').model, 'race-car');
});

test('every GLB is self-contained, within its triangle/size budget and fitted to the unchanged proxy', async () => {
  assert.deepEqual(Object.keys(manifest).sort(), Object.keys(BLOCKOUT_MODELS).sort());
  let total = 0;
  for (const [id, meta] of Object.entries(manifest)) {
    const bytes = readFileSync(new URL(`${id}.glb`, root)); total += bytes.length;
    assert.equal(bytes.length, meta.bytes, id);
    const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString());
    assert.ok(!json.images?.length && !json.textures?.length, `${id}: no textures`);
    assert.ok(json.buffers.every(b => !b.uri), `${id}: no external dependencies`);
    const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
    let tris = 0;
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse(o => {
      if (!o.isMesh) return;
      tris += (o.geometry.index?.count || o.geometry.attributes.position.count) / 3;
      if (id === 'terrain') {
        const a = o.geometry.attributes.position, v = new Vector3();
        for (let i = 0; i < a.count; i++) {
          v.fromBufferAttribute(a, i).applyMatrix4(o.matrixWorld);
          assert.ok(Math.abs(v.y - terrainHeight({ position: [0,0,0], scale: [1,1,1] }, v.x, v.z)) < 0.0001, 'terrain samples keep the original landscape');
        }
      }
    });
    assert.equal(tris, meta.triangles, id);
    assert.ok(tris <= 5000 && bytes.length < 400_000, `${id}: low-poly budget`);
    if (id !== 'terrain') {
      const bounds = new Box3().setFromObject(gltf.scene), size = bounds.getSize(new Vector3());
      SHAPES[meta.shape].size.forEach((n, i) => assert.ok(Math.abs(size.getComponent(i) - n) < .00001, `${id}: axis ${i} fits proxy`));
      assert.ok(Math.abs(bounds.min.y) < .00001 && Math.abs(bounds.min.x + bounds.max.x) < .00001 && Math.abs(bounds.min.z + bounds.max.z) < .00001, `${id}: bottom-centre pivot`);
    }
  }
  assert.ok(total < 1_500_000, 'whole library stays small enough to bundle offline');
});
