import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDirector, directorRoutes } from '../server/previs/director.mjs';

test('agents narrate progress; their edits are logged; replying closes the log', async () => {
  const director = await openDirector(await mkdtemp(join(tmpdir(), 'previs-progress-')));
  const route = directorRoutes(director, { get: () => ({}) });
  const post = (path, body, meta) => route('POST', new URL('http://x' + path), body, meta);
  const p = await director.create({ template: 'street' });
  const waiting = director.wait(p.id, 5, 'test');
  await new Promise(r => setTimeout(r, 50));
  const { messageId } = await director.message(p.id, { shotId: p.shots[0].id, text: 'add a tree', mode: 'auto' });
  await waiting;
  await post('/api/director/agent/progress', { projectId: p.id, text: 'Reading the scene' });
  await post('/api/director/edit', { projectId: p.id, ops: [{ op: 'add_entity', entity: { name: 'Tree', shape: 'tree' } }, { op: 'add_shot', shot: { title: 'Overhead' } }] }, { agent: true });
  await post('/api/director/edit', { projectId: p.id, ops: [{ op: 'update_entity', id: 'Car', patch: { color: '#ffffff' } }] }, {});
  let m = (await director.get(p.id)).messages.find(x => x.id === messageId);
  assert.equal(m.status, 'claimed'); assert.ok(m.workStartedAt);
  assert.deepEqual(m.activity.map(a => a.text), ['Reading the scene', 'Added Tree · Added shot “Overhead”'], 'only agent edits are logged');
  assert.equal(m.activity[1].auto, true);
  await post('/api/director/agent/reply', { projectId: p.id, messageId, text: 'Added a tree.' });
  m = (await director.get(p.id)).messages.find(x => x.id === messageId);
  assert.equal(m.status, 'handled'); assert.ok(m.workEndedAt);
  assert.equal(director.agentStatus().connected, true, 'progress keeps the agent counted as present');
});
