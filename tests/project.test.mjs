import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openProject, validateBinding } from '../server/previs/store.mjs';
const catalog = { file: '/fixture.blend', scenes: [{ name: 'A', cameras: ['Camera'], fps: 12, start: 1, end: 50 }, { name: 'B', cameras: ['Camera'], fps: 24, start: 1, end: 100 }] };
test('scene identity determines timing; malformed or unsaved bindings are refused', () => {
  const input = { scene: 'A', camera: 'Camera', start: 1, end: 40, frame: 10 };
  assert.equal(validateBinding(input, catalog).fps, 12);
  assert.equal(validateBinding({ ...input, scene: 'B' }, catalog).fps, 24);
  for (const bad of [{ frame: 0 }, { frame: 1.5 }, { end: 51 }, { scene: 'missing' }, { camera: 'missing' }, { frame: 41 }]) assert.throws(() => validateBinding({ ...input, ...bad }, catalog));
  assert.throws(() => validateBinding(input, { ...catalog, file: '' }));
});
test('serialized optimistic edits survive restart and reject stale writers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'previs-store-'));
  const store = await openProject(root);
  const revision = store.get().revision;
  const outcomes = await Promise.allSettled([store.mutate(revision, p => { p.title = 'First'; }), store.mutate(revision, p => { p.title = 'Stale'; })]);
  assert.equal(outcomes[0].status, 'fulfilled'); assert.equal(outcomes[1].status, 'rejected');
  assert.equal(outcomes[1].reason.status, 409);
  assert.deepEqual((await openProject(root)).get(), store.get());
  await assert.rejects(store.mutate(store.get().revision, p => { p.title = 'Broken'; throw Error('render failed'); }));
  assert.equal(store.get().title, 'First');
});
