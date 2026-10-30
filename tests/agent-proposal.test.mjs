import test from 'node:test';
import assert from 'node:assert/strict';
import { planProposal, sceneView } from '../server/previs/agent-proposal.mjs';
import { createProjectDocument, applyOps } from '../server/previs/director.mjs';

const street = () => createProjectDocument({ template: 'street' });

test('a proposal pins ids, validates on a copy and undoes back to the original', () => {
  const p = street();
  const before = JSON.stringify(p);
  const car = p.scene.entities.find(e => e.shape === 'car');
  const plan = planProposal(p, [
    { op: 'add_entity', entity: { name: 'Runner 2', shape: 'person', position: [2, 0, 1] } },
    { op: 'update_entity', id: car.name, patch: { color: '#ffffff', position: [-3, 0, 0] } },
    { op: 'set_keyframes', id: 'Runner 2', keys: [{ t: 0, position: [2, 0, 1] }, { t: 2, position: [-2, 0, 1] }] },
    { op: 'add_shot', shot: { title: 'Chase', camera: { move: 'orbit-left', target: car.name, mm: 35 }, duration: 4 } },
    { op: 'update_shot', id: 1, patch: { camera: { mm: 50 }, prompts: { video: { text: 'custom', edited: true } } } },
  ]);
  assert.equal(JSON.stringify(p), before, 'planning never touches the base project');
  assert.match(plan.ops[0].entity.id, /^[a-f0-9-]{36}$/, 'new objects get a fixed id');
  assert.match(plan.ops[3].shot.id, /^[a-f0-9-]{36}$/, 'new shots get a fixed id');
  assert.deepEqual(plan.summary.map(s => s.kind), ['add', 'change', 'animate', 'add', 'prompt']);
  assert.match(plan.summary[1].text, /recolour #ffffff/);
  assert.match(plan.summary[3].text, /Orbit left|orbit/i);
  assert.equal(plan.small, false);
  assert.equal(plan.preview.scene.entities.length, p.scene.entities.length + 1);
  // Apply then undo on a fresh copy: back to the start (ids included).
  const q = structuredClone(p);
  applyOps(q, plan.ops);
  assert.equal(q.shots.length, 2); assert.equal(q.shots[0].camera.mm, 50); assert.equal(q.shots[0].prompts.video.text, 'custom');
  applyOps(q, plan.undo);
  assert.deepEqual(q.scene.entities, p.scene.entities);
  assert.deepEqual(q.shots.map(s => ({ ...s, prompts: s.prompts || {} })), p.shots.map(s => ({ ...s, prompts: s.prompts || {} })));
});

test('removing an object is undone with its camera target restored', () => {
  const p = street();
  const target = p.scene.entities.find(e => e.id === p.shots[0].camera.target);
  const plan = planProposal(p, [{ op: 'remove_entity', id: target.id }]);
  const q = structuredClone(p); applyOps(q, plan.ops);
  assert.equal(q.shots[0].camera.target, null);
  applyOps(q, plan.undo);
  assert.equal(q.shots[0].camera.target, target.id);
  assert.deepEqual(q.scene.entities.find(e => e.id === target.id), target);
});

test('one update to one thing is a small proposal; bad ops fail at proposal time', () => {
  const p = street();
  assert.equal(planProposal(p, [{ op: 'update_shot', id: 1, patch: { camera: { mm: 85 } } }]).small, true);
  assert.throws(() => planProposal(p, [{ op: 'update_entity', id: 'Nobody', patch: { color: '#000000' } }]), /Unknown object Nobody/);
  assert.throws(() => planProposal(p, [{ op: 'set_edit', clips: [] }]), /cannot propose/);
  assert.throws(() => planProposal(p, []), /at least one/);
});

test('the scene view is compact and names things instead of ids', () => {
  const p = street();
  const v = sceneView(p, p.shots[0].id, [{ text: 'Add Tree' }]);
  assert.equal(v.currentShot, 1);
  assert.deepEqual(v.pendingChanges, ['Add Tree']);
  assert.equal(typeof v.shots[0].camera.target, 'string');
  assert.ok(v.objects.every(o => 'castCard' in o));
});
