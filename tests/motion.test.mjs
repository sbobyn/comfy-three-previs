import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEntity, makeShot, entityAt, upsertKey, normalizePath, shotCameraAt, sceneLength, cameraAt, cameraKeys } from '../shared/director.mjs';
import { createProjectDocument, applyOps } from '../server/previs/director.mjs';

test('paths are sorted, bounded and de-duplicated; objects face their travel', () => {
  assert.equal(normalizePath([]), null);
  const p = normalizePath([{ t: 4, p: [0, 0, -20] }, { t: 0, p: [0, 0, 0] }, { t: 4, p: [9, 9, 9] }, { t: 'x', p: [0, 0, 0] }]);
  assert.deepEqual(p.map(k => k.t), [0, 4]);
  const car = makeEntity({ shape: 'car', path: p }, 'c');
  assert.deepEqual(entityAt(car, 2).position, [0, 0, -10]);
  assert.equal(entityAt(car, 2).rotation, 180, 'driving toward -z faces 180°');
  assert.deepEqual(entityAt(car, -5).position, [0, 0, 0], 'holds before the first waypoint');
  assert.deepEqual(entityAt(car, 99).position, [0, 0, -20], 'holds after the last');
  const sideways = makeEntity({ shape: 'car', path: [{ t: 0, p: [0, 0, 0] }, { t: 1, p: [5, 0, 0] }] }, 's');
  assert.equal(entityAt(sideways, 0.5).rotation, 90);
  const yaw = makeEntity({ shape: 'car', path: [{ t: 0, p: [0, 0, 0], r: 350 }, { t: 1, p: [0, 0, 0], r: 10 }] }, 'y');
  assert.ok(Math.abs(entityAt(yaw, 0.5).rotation - 0) < 1e-6 || Math.abs(entityAt(yaw, 0.5).rotation - 360) < 1e-6, 'explicit yaw takes the short way round');
  assert.deepEqual(upsertKey(p, 4, [1, 0, -20]).map(k => k.p[0]), [0, 1], 'replaces the key at the same time');
  assert.equal(upsertKey(null, 2, [0, 0, 0]).length, 1);
});

test('shot cameras aimed at a moving object ride along; shot start sets the slice', () => {
  const car = makeEntity({ shape: 'car', path: [{ t: 0, p: [0, 0, 0] }, { t: 10, p: [0, 0, -50] }] }, 'car');
  const shot = makeShot({ start: 4, duration: 2, camera: { move: 'static', target: 'car', distance: 6, angle: 90 } }, 's', 1, [car]);
  assert.equal(shot.start, 4);
  const a = shotCameraAt(shot, [car], 0), b = shotCameraAt(shot, [car], 2);
  const carMoved = entityAt(car, 6).position[2] - entityAt(car, 4).position[2];
  assert.ok(carMoved < -5 && Math.abs((b.p[2] - a.p[2]) - carMoved) < 1e-6, 'camera travelled exactly as far as the car');
  assert.ok(Math.abs(a.look[2] - entityAt(car, 4).position[2]) < 1e-6, 'aims at the car where the shot starts');
  const still = makeShot({ camera: { move: 'static', target: null } }, 'z', 1, []);
  assert.deepEqual(shotCameraAt(still, [], 1), cameraAt(cameraKeys(still, []), still.duration, 1));
  const project = { scene: { entities: [car] }, shots: [shot] };
  assert.equal(sceneLength(project), 10);
});

test('edits carry paths and shot start through the server model', () => {
  const p = createProjectDocument({ template: 'street' });
  const runner = p.scene.entities.find(e => e.name === 'Runner');
  applyOps(p, [{ op: 'update_entity', id: 'Runner', patch: { path: [{ t: 0, p: runner.position }, { t: 3, p: [0, 0, -10] }] } }, { op: 'update_shot', id: '1', patch: { start: 1.5 } }]);
  assert.equal(p.scene.entities.find(e => e.name === 'Runner').path.length, 2);
  assert.equal(p.shots[0].start, 1.5);
  applyOps(p, [{ op: 'update_entity', id: 'Runner', patch: { path: null } }]);
  assert.equal(p.scene.entities.find(e => e.name === 'Runner').path, null);
  assert.equal(p.scene.entities.find(e => e.name === 'Car').path, null, 'static objects keep no path');
});

test('keyframe ops: merge, partial channels, keyed facing and scale, remove and clear', () => {
  const p = createProjectDocument({ template: 'street' });
  applyOps(p, [{ op: 'set_keyframes', id: 'Car', keys: [{ t: 0, position: [0, 0, 10] }, { t: 4, position: [0, 0, -10] }] }]);
  const car = () => p.scene.entities.find(e => e.name === 'Car');
  assert.equal(entityAt(car(), 2).rotation, 180, 'faces travel with no rotation keys');
  applyOps(p, [{ op: 'set_keyframes', id: 'Car', keys: [{ t: 2, rotation: 90, scale: [1, 2, 1] }] }]);
  assert.equal(car().path.length, 3);
  assert.deepEqual(car().path[1].p, entityAt({ ...car(), path: [car().path[0], car().path[2]] }, 2).position, 'missing position filled from the animated pose');
  assert.equal(entityAt(car(), 3).rotation, 90, 'a rotation key switches to keyed facing (held after)');
  assert.deepEqual(entityAt(car(), 2).scale, [1, 2, 1]);
  applyOps(p, [{ op: 'remove_keyframes', id: 'Car', times: [2] }]);
  assert.equal(car().path.length, 2);
  applyOps(p, [{ op: 'set_keyframes', id: 'Car', mode: 'replace', keys: [{ t: 1, position: [5, 0, 0] }] }]);
  assert.deepEqual(car().path.map(k => k.t), [1]);
  applyOps(p, [{ op: 'clear_animation', id: 'Car' }]);
  assert.equal(car().path, null);
  assert.throws(() => applyOps(p, [{ op: 'set_keyframes', id: 'Nope', keys: [] }]), /Unknown object/);
});

test('pitch and roll: base values, keyed barrel roll takes the long way round', () => {
  const p = createProjectDocument({ template: 'street' });
  applyOps(p, [{ op: 'update_entity', id: 'Car', patch: { pitch: 10, roll: -5 } }]);
  const car = () => p.scene.entities.find(e => e.name === 'Car');
  assert.equal(car().pitch, 10); assert.equal(entityAt(car(), 0).roll, -5);
  applyOps(p, [{ op: 'set_keyframes', id: 'Car', keys: [{ t: 0, position: [0, 0, 0], roll: 0 }, { t: 2, position: [0, 0, -10], roll: 360 }] }]);
  assert.equal(entityAt(car(), 1).roll, 180, 'halfway through a full roll, not snapped to 0');
  assert.equal(entityAt(car(), 1).rotation, 180, 'still faces travel');
  applyOps(p, [{ op: 'set_keyframes', id: 'Car', keys: [{ t: 2, position: [0, 0, -12] }] }]);
  assert.equal(car().path.at(-1).roll, 360, 'moving a key keeps its roll');
});
