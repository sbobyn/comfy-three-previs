import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDirector, directorRoutes } from '../server/previs/director.mjs';

function fakeRunner() {
  const started = [];
  return { started, available: () => true, status: () => ({ available: true, busy: [] }), start: (projectId, messageId, input) => { started.push({ projectId, messageId, input }); return { started: true }; }, stop: () => ({ stopped: true }), reset: () => ({ reset: true }) };
}

test('auto routes to the built-in runner; its edits become one reviewable, undoable proposal', async () => {
  const runner = fakeRunner();
  const director = await openDirector(await mkdtemp(join(tmpdir(), 'previs-agent-')), { runner: () => runner });
  const route = directorRoutes(director, { get: () => ({}) }, () => null, () => runner);
  const post = (path, body) => route('POST', new URL('http://x' + path), body, { agent: true });
  const p = await director.create({ template: 'street' });
  const { messageId, routed, project } = await director.message(p.id, { shotId: p.shots[0].id, text: 'add a tree left of the car', mode: 'auto' });
  assert.equal(routed, 'runner');
  assert.equal(project.messages.at(-1).status, 'claimed');
  assert.equal(project.messages.at(-1).handledBy, 'runner');
  assert.equal(runner.started.length, 1);
  assert.equal(runner.started[0].input.shotNumber, 1);
  assert.equal(director.agentStatus().runner.available, true);

  // The agent reads, proposes twice (cumulative), suggests a prompt, replies.
  const scene = await post('/api/director/agent/scene', { projectId: p.id, messageId });
  assert.equal(scene.currentShot, 1); assert.deepEqual(scene.pendingChanges, []);
  const r1 = await post('/api/director/agent/propose', { projectId: p.id, messageId, ops: [{ op: 'add_entity', entity: { name: 'Tree', shape: 'tree', position: [-4, 0, 0] } }] });
  assert.deepEqual(r1.summary, ['Add Tree (tree) at -4 m, 0 m']);
  const r2 = await post('/api/director/agent/propose', { projectId: p.id, messageId, ops: [{ op: 'update_entity', id: 'Tree', patch: { color: '#226633' } }] });
  assert.equal(r2.summary.length, 1, 'only the new lines come back');
  const scene2 = await post('/api/director/agent/scene', { projectId: p.id, messageId });
  assert.ok(scene2.objects.some(o => o.name === 'Tree'), 'the agent sees its pending edits as if applied');
  assert.equal(scene2.pendingChanges.length, 2);
  assert.ok(!(await director.get(p.id)).scene.entities.some(e => e.name === 'Tree'), 'nothing is applied yet');
  const prompt = await post('/api/director/agent/prompt', { projectId: p.id, messageId, shot: '1', kind: 'video' });
  assert.match(prompt.auto, /Cinematic live-action shot/);
  await post('/api/director/agent/suggest', { projectId: p.id, messageId, shot: '1', kind: 'video', text: 'A tree sways.' });
  await director.reply(p.id, { messageId, text: 'Proposed a tree.', via: 'runner' });

  let doc = await director.get(p.id);
  const m = doc.messages.find(x => x.id === messageId);
  assert.equal(m.status, 'handled'); assert.equal(m.proposal.status, 'pending'); assert.equal(m.proposal.ops.length, 2);
  assert.equal(m.suggestion.text, 'A tree sways.');
  assert.equal(doc.messages.at(-1).via, 'runner');
  assert.deepEqual(m.activity.map(a => a.text), ['Add Tree (tree) at -4 m, 0 m', 'Tree: recolour #226633']);

  // Apply, then undo through the stored inverse ops.
  const applied = await post('/api/director/agent/proposal', { projectId: p.id, messageId, action: 'apply' });
  assert.equal(applied.proposal.status, 'applied');
  assert.equal(applied.project.scene.entities.find(e => e.name === 'Tree').color, '#226633');
  await assert.rejects(post('/api/director/agent/proposal', { projectId: p.id, messageId, action: 'apply' }), /already decided/);
  const undone = await post('/api/director/agent/proposal', { projectId: p.id, messageId, action: 'undo' });
  assert.equal(undone.proposal.status, 'undone');
  assert.ok(!undone.project.scene.entities.some(e => e.name === 'Tree'));
});

test('Stop on a stale claimed message closes it with an error reply', async () => {
  const runner = { ...fakeRunner(), stop: () => ({ stopped: false }) };
  const director = await openDirector(await mkdtemp(join(tmpdir(), 'previs-agent-')), { runner: () => runner });
  const route = directorRoutes(director, { get: () => ({}) }, () => null, () => runner);
  const p = await director.create({ template: 'street' });
  const { messageId } = await director.message(p.id, { shotId: p.shots[0].id, text: 'hello', mode: 'auto' });
  const r = await route('POST', new URL('http://x/api/director/agent/stop'), { projectId: p.id, messageId }, {});
  assert.equal(r.project.messages.find(m => m.id === messageId).status, 'handled');
  assert.equal(r.project.messages.at(-1).error, true);
});

test('explicit routes still work: parser and external agent', async () => {
  const runner = fakeRunner();
  const director = await openDirector(await mkdtemp(join(tmpdir(), 'previs-agent-')), { runner: () => runner });
  const p = await director.create({ template: 'street' });
  const b = await director.message(p.id, { shotId: p.shots[0].id, text: 'add a tree', mode: 'builtin' });
  assert.equal(b.routed, 'builtin');
  const a = await director.message(p.id, { shotId: p.shots[0].id, text: 'add a tree', mode: 'agent' });
  assert.equal(a.routed, 'agent'); assert.equal(a.project.messages.at(-1).status, 'pending');
  assert.equal(runner.started.length, 0);
});

test('without Claude Code installed, auto falls back to the parser', async () => {
  const director = await openDirector(await mkdtemp(join(tmpdir(), 'previs-agent-')), { runner: () => ({ available: () => false, status: () => ({ available: false, busy: [] }) }) });
  const p = await director.create({ template: 'street' });
  const r = await director.message(p.id, { shotId: p.shots[0].id, text: 'add a tree', mode: 'auto' });
  assert.equal(r.routed, 'builtin');
  await assert.rejects(director.message(p.id, { shotId: p.shots[0].id, text: 'hi', mode: 'runner' }), /not installed/);
});
