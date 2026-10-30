import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectDocument } from '../server/previs/director.mjs';
import { loadStarters, starterSnapshot } from '../server/previs/starters.mjs';

test('starter snapshots load in launch-page order and carry no media or absolute paths', async () => {
  const starters = await loadStarters();
  assert.deepEqual(starters.map(s => s.slug), ['breaking-news', 'wingspan', 'final-lap', 'posterized']);
  for (const s of starters) {
    const text = JSON.stringify(s);
    assert.ok(!/"\/(Users|home)\//.test(text), `${s.slug} has an absolute path`);
    assert.deepEqual(s.media, []);
    for (const shot of s.shots) for (const k of ['references', 'render', 'id']) assert.equal(shot[k], undefined, `${s.slug} shot keeps ${k}`);
    for (const e of s.scene.entities) assert.equal(e.look, undefined);
  }
});

test('creating from a starter deep-copies it with fresh, consistent ids', async () => {
  const starters = await loadStarters();
  const snap = starters.find(s => s.slug === 'final-lap');
  const a = createProjectDocument({ template: 'final-lap' }, undefined, starters);
  const b = createProjectDocument({ template: 'final-lap', title: 'Mine' }, undefined, starters);
  assert.equal(a.title, 'Final Lap'); assert.equal(b.title, 'Mine'); assert.equal(a.template, 'final-lap');
  assert.equal(a.scene.entities.length, snap.scene.entities.length);
  assert.equal(a.shots.length, snap.shots.length);
  const ids = new Set(a.scene.entities.map(e => e.id));
  assert.ok(!a.scene.entities.some(e => snap.scene.entities.some(x => x.id === e.id)), 'ids are fresh');
  assert.ok(!a.scene.entities.some(e => b.scene.entities.some(x => x.id === e.id)), 'projects do not share ids');
  for (const e of a.scene.entities) { if (e.parent) assert.ok(ids.has(e.parent)); if (e.lookFrom) assert.ok(ids.has(e.lookFrom)); }
  a.shots.forEach((s, i) => {
    const t = snap.shots[i].camera.target;
    if (t) assert.equal(a.scene.entities.find(e => e.id === s.camera.target)?.name, snap.scene.entities.find(e => e.id === t).name);
    for (const id of [...s.cast.include, ...s.cast.exclude]) assert.ok(ids.has(id));
  });
  assert.equal(a.scene.entities.filter(e => e.parent).length, snap.scene.entities.filter(e => e.parent).length, 'groups survive');
  // Mutating the copy never touches the snapshot.
  a.scene.entities[0].name = 'changed';
  assert.notEqual(snap.scene.entities[0].name, 'changed');
});

test('unknown templates still fall back to the empty stage; built-in blockouts still work', () => {
  assert.equal(createProjectDocument({ template: 'nope' }, undefined, []).template, 'empty');
  assert.equal(createProjectDocument({ template: 'street' }).template, 'street');
});

test('snapshots strip renders, references and looks from a project', () => {
  const p = createProjectDocument({ template: 'street' });
  p.shots[0].render = { file: '/abs/x.mp4' }; p.shots[0].references = [{ id: 'r' }]; p.scene.entities[0].look = 'r';
  const s = starterSnapshot(p, { slug: 'x', title: 'X', description: 'd' });
  assert.equal(s.shots[0].render, undefined); assert.equal(s.shots[0].references, undefined); assert.equal(s.scene.entities[0].look, undefined);
  assert.equal(s.format, 'comfy-previs-starter');
});
