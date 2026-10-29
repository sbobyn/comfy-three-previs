import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectDocument } from '../server/previs/director.mjs';
import { shotCast, videoReferences, compilePrompt, referenceLegend, lookPrompt, lookViews } from '../shared/director.mjs';
import { withReferenceImages, maxReferences } from '../shared/video-refs.mjs';
import { builtInPresets } from '../server/previs/presets.mjs';
import { validateWorkflowDefinition } from '../server/previs/workflows.mjs';

const ref = (id, entityId, role = 'character') => ({ id, name: id, file: `${id}.png`, mime: 'image/png', role, entityId, note: '', createdAt: '2026-10-28T00:00:00Z' });
function street() {
  const p = createProjectDocument({ title: 'Refs', template: 'street' });
  const runner = p.scene.entities.find(e => e.name === 'Runner'), car = p.scene.entities.find(e => e.name === 'Car');
  const s = p.shots[0];
  s.camera = { ...s.camera, move: 'static', target: runner.id, distance: 4, height: 1.6, angle: 0, mm: 35 };
  return { p, runner, car, s };
}

test('shotCast finds what the camera sees, subject first, and drops what is behind it', () => {
  const { p, runner, s } = street();
  const cast = shotCast(p, s);
  assert.equal(cast[0].entity.id, runner.id);
  assert.ok(cast[0].lead);
  // Put an object far behind the camera: it must not be in the cast.
  p.scene.entities.push({ ...p.scene.entities[1], id: 'behind', name: 'Behind', position: [runner.position[0], 0, runner.position[2] + 60] });
  assert.ok(!shotCast(p, s).some(c => c.entity.id === 'behind'));
});

test('videoReferences sends each object look in the shot, keeps a slot for the environment, and respects the cap', () => {
  const { p, runner, car, s } = street();
  p.scene.references = [ref('runner-look', runner.id), ref('car-look', car.id, 'prop')];
  runner.look = 'runner-look'; car.look = 'car-look';
  s.references = [ref('alley', null, 'environment'), ref('grade', null, 'style')];
  const all = videoReferences(p, s, 9);
  assert.equal(all[0].ref.id, 'runner-look');
  assert.ok(all.some(x => x.ref.id === 'alley'));
  const two = videoReferences(p, s, 2);
  assert.equal(two.length, 2);
  assert.deepEqual(two.map(x => x.ref.id), ['runner-look', 'alley']);
  assert.equal(videoReferences(p, s, 0).length, 0);
});

test('compilePrompt numbers references, includes style notes, and the legend maps numbers to objects', () => {
  const { p, runner, s } = street();
  p.scene.references = [ref('runner-look', runner.id)]; runner.look = 'runner-look';
  p.scene.environment.style = '35 mm anamorphic, teal and orange';
  const refs = videoReferences(p, s, 4);
  const text = compilePrompt(p, s, refs);
  assert.match(text, /Runner \(character\) — looks exactly like reference image 1/);
  assert.match(text, /Visual style: 35 mm anamorphic/);
  assert.match(referenceLegend(refs), /1 = Runner/);
  assert.match(lookPrompt(p, runner, 'sheet'), /front, side and back/);
  assert.ok(lookViews(runner).face);
});

test('withReferenceImages wires N images into Kling (batched) and Seedance (slots)', () => {
  const kling = builtInPresets.find(d => d.id === 'kling-o1-edit-v1'), seed = builtInPresets.find(d => d.id === 'seedance-25-edit-v1');
  assert.equal(maxReferences(kling), 4); assert.equal(maxReferences(seed), 9);
  const k3 = withReferenceImages(kling, 3);
  assert.deepEqual(Object.keys(k3.inputs).filter(n => n.startsWith('referenceImage')), ['referenceImage1', 'referenceImage2', 'referenceImage3']);
  assert.deepEqual(k3.graph['2'].inputs.reference_images, ['refbatch3', 0]);
  assert.deepEqual(k3.graph.refbatch2.inputs, { image1: ['ref1', 0], image2: ['ref2', 0] });
  assert.equal(withReferenceImages(kling, 9).provenance.referenceImages, 4);
  const s2 = withReferenceImages(seed, 2);
  assert.deepEqual(s2.graph['2'].inputs['model.reference_images.image_2'], ['ref2', 0]);
  assert.equal(withReferenceImages(kling, 0), kling);
  // The engine accepts the derived definition.
  for (const d of [k3, s2]) validateWorkflowDefinition({ ...d, verification: { status: 'imported' } });
  assert.equal(kling.graph['2'].inputs.reference_images, undefined, 'the preset itself is not modified');
});

test('objects can share another object’s looks and description, without loops', async () => {
  const { lookSource, objectNotes } = await import('../shared/director.mjs');
  const { p, car } = street();
  const car2 = { ...car, id: 'car-2', name: 'Car 2', notes: 'dented door', lookFrom: car.id, look: null };
  p.scene.entities.push(car2);
  car.notes = 'black-and-white police cruiser';
  p.scene.references = [ref('car-look', car.id, 'prop')]; car.look = 'car-look';
  assert.equal(lookSource(p, car2.id).id, car.id);
  const { objectLooks } = await import('../shared/director.mjs');
  assert.deepEqual(objectLooks(p, car2.id).map(r => r.id), ['car-look']);
  assert.equal(objectNotes(p, car2), 'black-and-white police cruiser; dented door');
  car.lookFrom = car2.id; // a loop must not hang
  assert.ok(lookSource(p, car2.id));
});

test('image presets wire the guide first, then reference images, into numbered slots', async () => {
  const { imagePresets } = await import('../server/previs/refgen.mjs');
  const f3 = imagePresets.find(x => x.id === 'flux-3'), f2 = imagePresets.find(x => x.id === 'flux-2-pro');
  const g = f3.build({ prompt: 'x', aspect: '16:9', count: 1, seed: 1, guide: true, refs: 2 });
  assert.deepEqual(g['1'].inputs['images.image_1'], ['100', 0]);
  assert.deepEqual(g['1'].inputs['images.image_3'], ['202', 0]);
  assert.equal(g['202'].class_type, 'LoadImage');
  const g2 = f2.build({ prompt: 'x', aspect: '4:3', count: 1, seed: 1, guide: false, refs: 1 });
  assert.deepEqual(g2['1'].inputs['model.images.image_1'], ['201', 0]);
  assert.equal(g2['1'].inputs['model.width'], 1024);
});
