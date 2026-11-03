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
const baseline = JSON.parse(readFileSync(new URL('./fixtures/starter-animation-baseline.json', import.meta.url), 'utf8'));

// The baseline hashes each pre-animation starter without its shot media (stills, clips, videos, cut), which is made again for
// each blocking and pinned byte for byte by tests/starters-roundtrip.test.mjs. Cast images and their media entries stay in the hash.
const withoutShotMedia = s => {
  const cast = new Set((s.scene.references || []).map(r => `media/refs/${r.id}.webp`));
  for (const shot of s.shots) delete shot.references;
  delete s.assets; delete s.edit;
  s.media = s.media.filter(m => cast.has(m.path));
  return s;
};

test('all starter objects have compatible meshes and animation leaves cameras, timing, set dressing and cast images unchanged', async () => {
  for (const s of await loadStarters()) {
    const fixed = structuredClone(s);
    const actors = { 'mountain-trail': [], 'city-blocks': [], 'camera-moves': [], 'look-lab': [], 'two-hander': [], 'breaking-news': ['News anchor', 'Camera operator'], wingspan: ['Bald eagle', 'Elk 1', 'Elk 2', 'Elk 3'], 'final-lap': ['Comfy car', 'Rival car'], posterized: ['Comfy guard', 'Rival defender', 'Basketball'] };
    const rewrittenCast = ['News anchor', 'Bald eagle', 'Comfy car', 'Rival car', 'Comfy guard', 'Rival defender'];
    for (const e of fixed.scene.entities) {
      if (actors[s.slug].includes(e.name)) for (const k of ['position', 'rotation', 'path', 'pose']) delete e[k];
      if (rewrittenCast.includes(e.name)) delete e.notes;
    }
    for (const shot of fixed.shots) for (const k of ['description', 'prompts']) delete shot[k];
    // The baseline pins the four finished starters (with the corrected stand yaw in Final Lap and Posterized); the blockout starters
    // (2026-11-02) came later and also use plain proxy shapes (buildings, rocks, chairs) that have no bundled mesh.
    const pinned = Object.hasOwn(baseline, s.slug);
    if (pinned) assert.equal(digest(withoutShotMedia(fixed)), baseline[s.slug], `${s.slug}: only the named actors' blocking, shot/cast action text and shot media may change`);
    for (const e of s.scene.entities) {
      if (e.shape === 'group') assert.equal(e.model, undefined);
      else if (e.model) assert.equal(blockoutModel(e), e.model, `${s.slug}: ${e.name}`);
      if (e.shape !== 'group' && pinned) assert.ok(e.model, `${e.name} needs a recognisable mesh`);
    }
    const copy = instantiateStarter(s);
    assert.deepEqual(copy.scene.entities.map(e => e.model), s.scene.entities.map(e => e.model));
    const sh = copy.shots[0], sig = shotSignature(copy, sh);
    copy.scene.entities.forEach(e => delete e.model);
    assert.notEqual(shotSignature(copy, sh), sig, 'a posed rig is camera truth, so removing it invalidates its silhouette');
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

// The bundled bleachers descend toward local -Z; their front rows must look into the venue.
test('race and basketball stands face inward, from the low row of the actual bundled mesh', async () => {
  const bytes = readFileSync(new URL('stands.glb', root));
  const { scene } = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  scene.updateMatrixWorld(true);
  const height = { front: -Infinity, back: -Infinity }, vertex = new Vector3();
  scene.traverse(mesh => {
    if (!mesh.isMesh || mesh.material.name !== 'entity-color') return;
    const positions = mesh.geometry.attributes.position;
    for (let i = 0; i < positions.count; i++) {
      vertex.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld);
      if (vertex.z < -0.4) height.front = Math.max(height.front, vertex.y);
      if (vertex.z > 0.4) height.back = Math.max(height.back, vertex.y);
    }
  });
  assert.ok(Number.isFinite(height.front) && Number.isFinite(height.back));
  assert.ok(height.back - height.front > 0.5, 'the low/front row points toward local -Z');
  for (const s of (await loadStarters()).filter(s => ['final-lap', 'posterized'].includes(s.slug))) {
    const limit = s.slug === 'final-lap' ? 60 : 14;
    const stands = s.scene.entities.filter(e => e.model === 'stands');
    assert.equal(stands.length, s.slug === 'final-lap' ? 34 : 22);
    for (const e of stands) {
      const [x, , z] = e.position, dx = Math.max(-limit, Math.min(limit, x)) - x, dz = -z;
      const yaw = e.rotation * Math.PI / 180;
      const inward = (-Math.sin(yaw) * dx - Math.cos(yaw) * dz) / Math.hypot(dx, dz);
      assert.ok(inward > 0.999, `${s.slug}: ${e.name} faces the track/court`);
    }
  }
});
