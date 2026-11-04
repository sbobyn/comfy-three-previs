import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openOperations } from '../server/previs/operations.mjs';
import { catalogToken } from '../server/previs/blender.mjs';

test('dispatch receipt survives interruption; no restart or partial acknowledgment clears uncertainty', async () => {
  const root = await mkdtemp(join(tmpdir(), 'previs-operation-'));
  const first = await openOperations(root);
  const id = await first.begin('render-preview', { shotId: 'fixture' });
  assert.throws(() => first.assertIdle());
  const restarted = await openOperations(root);
  assert.equal(restarted.get().status, 'uncertain');
  assert.throws(() => restarted.assertIdle());
  await assert.rejects(restarted.reconcile({ operationId: id, blenderIdle: true }));
  await assert.rejects(restarted.reconcile({ operationId: 'other', blenderIdle: true, settingsReviewed: true }));
  await restarted.reconcile({ operationId: id, blenderIdle: true, settingsReviewed: true });
  const again = await openOperations(root); again.assertIdle();
  assert.equal(again.get().status, 'reconciled');
  assert.match(again.get().outcome, /No retry/);
});
test('catalog identity rejects files, cameras and timing changes; playback does not invalidate identity', () => {
  const a = { file: 'a.blend', scenes: [{ name: 'Scene', cameras: ['Camera'], fps: 24, start: 1, end: 48, frame: 1 }] };
  assert.notEqual(catalogToken(a), catalogToken({ ...a, file: 'b.blend' }));
  for (const change of [{ cameras: ['Renamed'] }, { fps: 12 }, { end: 24 }]) assert.notEqual(catalogToken(a), catalogToken({ ...a, scenes: [{ ...a.scenes[0], ...change }] }));
  assert.equal(catalogToken(a), catalogToken({ ...a, scenes: [{ ...a.scenes[0], frame: 22 }] }));
});

test('journal write failure does not publish an undispatched operation or clear a running receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'previs-write-failure-'));
  let failed = true;
  const operations = await openOperations(root, async () => { if(failed) throw Error('SIMULATED disk full'); });
  await assert.rejects(operations.begin('render',{}), /disk full/);
  operations.assertIdle(); assert.equal(operations.get(),null);
  failed=false; const id=await operations.begin('render',{});
  failed=true; await assert.rejects(operations.finish(id,'completed'),/disk full/);
  assert.equal(operations.get().status,'running'); assert.throws(()=>operations.assertIdle());
});
