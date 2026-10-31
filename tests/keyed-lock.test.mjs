import test from 'node:test';
import assert from 'node:assert/strict';
import { keyedLock } from '../server/previs/keyed-lock.mjs';
import { createLimiter, downloadLimit, downloadsFor } from '../server/previs/concurrency.mjs';

test('keyed lock: one key runs in order, other keys run alongside, and finished keys are dropped', async () => {
  const lock = keyedLock(), order = [];
  let release; const gate = new Promise(r => { release = r; });
  const a1 = lock('a', async () => { order.push('a1 start'); await gate; order.push('a1 end'); });
  const a2 = lock('a', async () => { order.push('a2'); });
  const b = lock('b', async () => { order.push('b'); });
  await b;
  assert.deepEqual(order, ['a1 start', 'b']);
  release(); await Promise.all([a1, a2]);
  assert.deepEqual(order, ['a1 start', 'b', 'a1 end', 'a2']);
  await assert.rejects(lock('c', async () => { throw Error('boom'); }), /boom/);
  assert.equal(await lock('c', async () => 'after a failure'), 'after a failure');
  await new Promise(r => setImmediate(r));
  assert.equal(lock.size(), 0);
});

test('download limiter: at most N at once, FIFO, failures free their place; env override with a default of 4', async () => {
  const run = createLimiter(2), order = [], gates = {};
  const job = name => run(async () => { order.push(`${name} start`); await new Promise(r => { gates[name] = r; }); order.push(`${name} end`); if (name === 'b') throw Error('b failed'); return name; });
  const a = job('a'), b = job('b'), c = job('c'), d = job('d');
  await new Promise(r => setImmediate(r));
  assert.deepEqual(order, ['a start', 'b start']); assert.deepEqual(run.stats(), { limit: 2, running: 2, waiting: 2 });
  gates.b(); await assert.rejects(b, /b failed/); await new Promise(r => setImmediate(r));
  assert.deepEqual(order, ['a start', 'b start', 'b end', 'c start']);
  gates.a(); gates.c(); assert.equal(await a, 'a'); assert.equal(await c, 'c'); await new Promise(r => setImmediate(r));
  gates.d(); assert.equal(await d, 'd'); assert.deepEqual(run.stats(), { limit: 2, running: 0, waiting: 0 });
  assert.deepEqual([downloadLimit({}), downloadLimit({ PREVIS_DOWNLOAD_CONCURRENCY: '8' }), downloadLimit({ PREVIS_DOWNLOAD_CONCURRENCY: '0' }), downloadLimit({ PREVIS_DOWNLOAD_CONCURRENCY: 'x' })], [4, 8, 4, 4]);
  assert.equal(downloadsFor('/tmp/previs-a'), downloadsFor('/tmp/previs-a/'), 'one limit per data directory');
});
