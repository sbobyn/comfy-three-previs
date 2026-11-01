// The text alternative of the 3D viewport (shared/viewport-summary.mjs): same project and time, same words.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectDocument } from '../server/previs/director.mjs';
import { viewportSummary } from '../shared/viewport-summary.mjs';

test('summary names the view, the objects nearest the camera with where they sit, the camera and the selection', () => {
  const p = createProjectDocument({ template: 'street' }), shot = p.shots[0];
  const text = viewportSummary(p, shot);
  assert.match(text, /^Director view of the whole set\. \d+ objects?( and \d+ set pieces?)?: /);
  assert.match(text, /\([a-z]+\): (far left|left|centre|right|far right) of frame, [\d.]+ m from the camera/);
  assert.match(text, /Shot camera: [A-Za-z -]+( on [^,]+)?, \d+ mm [a-z-]+ lens, [\d.]+ m high, [a-z ]+, [\d.]+ s\.$/);
  assert.equal(viewportSummary(p, shot), text, 'deterministic');
  const named = p.scene.entities.find(e => e.shape !== 'group' && e.kind !== 'environment');
  assert.match(viewportSummary(p, shot, { selected: [named.id], view: 'camera' }), new RegExp(`^Looking through the shot camera\\..* Selected: ${named.name}\\.$`));
});

test('summary lists at most six objects and says where the rest are; a missing selection id is ignored', () => {
  const p = createProjectDocument({ template: 'street' }), shot = p.shots[0];
  const base = p.scene.entities.find(e => e.kind !== 'environment' && e.shape !== 'group');
  for (let i = 0; i < 9; i++) p.scene.entities.push({ ...base, id: `extra-${i}`, name: `Extra ${i}`, position: [i, 0, -3 - i] });
  const text = viewportSummary(p, shot, { selected: ['nope'] });
  assert.equal((text.match(/ m from the camera/g) || []).length, 6);
  assert.match(text, /; \d+ more are in the Scene list\./);
  assert.doesNotMatch(text, /Selected:/);
});
