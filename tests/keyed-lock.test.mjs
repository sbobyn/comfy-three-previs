import test from 'node:test';
import assert from 'node:assert/strict';
import { keyedLock } from '../server/previs/keyed-lock.mjs';

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
