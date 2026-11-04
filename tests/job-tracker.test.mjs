// Fake sources and a fake clock: no server, network, Comfy or paid execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createJobTracker } from '../server/previs/job-tracker.mjs';
import { createSlots, limitsFor } from '../server/previs/concurrency.mjs';
import { createBackend, errorDetail } from '../server/previs/backends.mjs';

const T0 = Date.parse('2026-10-30T12:00:00.000Z');
const ago = ms => new Date(T0 - ms).toISOString();

function fakeSource(name, list) {
  const jobs = new Map(list.map(job => [job.id, { ...job }])), calls = [], terminal = [];
  const source = {
    name, list: () => [...jobs.values()].map(job => structuredClone(job)), get: id => structuredClone(jobs.get(id)),
    isActive: job => ['queued', 'running', 'uncertain'].includes(job.status),
    async track(id, tracking) {
      calls.push({ id, tracking });
      const job = jobs.get(id);
      if (job.throws) throw Object.assign(Error('Backend transport failed; no automatic retry'), { detail: 'connect ECONNRESET' });
      if (tracking) job.tracking = tracking;
      if (calls.filter(c => c.id === id).length >= (job.doneAfter ?? Infinity)) { job.status = 'completed'; job.finishedAt = new Date(clock.t).toISOString(); }
      return structuredClone(job);
    },
    expectedSeconds: job => job.expected ?? 60, label: job => `Label ${job.id}`, projectIdOf: () => null, costOf: () => 0.1, kindOf: () => 'video',
    onTerminal: job => { terminal.push(job.id); },
  };
  return { jobs, calls, terminal, source };
}
const clock = { t: T0 };
const options = extra => ({ now: () => clock.t, tickMs: 0, holdMs: 15 * 60000, ...extra });

test('tracker resumes active receipts on start and backs off until terminal, calling onTerminal once', async () => {
  clock.t = T0;
  const gen = fakeSource('generation', [
    { id: 'a', status: 'queued', createdAt: ago(1000), dispatchStartedAt: ago(1000), doneAfter: 7 },
    { id: 'done', status: 'completed', createdAt: ago(5000), finishedAt: ago(2000) },
    { id: 'draft', status: 'quoted', createdAt: ago(5000) },
  ]);
  const ref = fakeSource('refgen', [{ id: 'b', status: 'uncertain', createdAt: ago(1000), uncertainAt: ago(1000), expected: 3600 }]);
  const logs = [], tracker = createJobTracker({ sources: [gen.source, ref.source], ...options({ log: line => logs.push(line) }) });
  tracker.start();
  let snap = tracker.snapshot();
  assert.deepEqual(snap.tracker, { running: true, startedAt: new Date(T0).toISOString(), resumed: 2 });
  assert.deepEqual(snap.jobs.map(j => j.id).sort(), ['a', 'b', 'done'], 'drafts are not jobs');
  // Resumed jobs are tracked immediately, without any client call.
  await tracker.tick();
  assert.equal(gen.calls.length, 1); assert.equal(ref.calls.length, 1);
  assert.ok(logs.some(line => /resumed 2/.test(line)) && logs.some(line => /generation a tracked #1/.test(line)));
  for (let i = 0; i < 2000 && gen.terminal.length === 0; i++) { clock.t += 250; await tracker.tick(); }
  const gaps = gen.calls.map(c => Date.parse(c.tracking.nextTrackAt) - Date.parse(c.tracking.lastTrackedAt));
  assert.deepEqual(gaps.map(Math.round), [7500, 11250, 16875, 25312, 30000, 30000, 30000]);
  for (let i = 1; i < gen.calls.length; i++) assert.ok(Date.parse(gen.calls[i].tracking.lastTrackedAt) >= Date.parse(gen.calls[i - 1].tracking.nextTrackAt), 'never polls before nextTrackAt');
  assert.deepEqual(gen.calls.map(c => c.tracking.trackCount), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(gen.terminal, ['a']);
  for (let i = 0; i < 200; i++) { clock.t += 1000; await tracker.tick(); }
  assert.equal(gen.calls.length, 7, 'terminal jobs are no longer polled');
  await tracker.trackNow('generation', 'a');
  assert.deepEqual(gen.terminal, ['a'], 'terminal callback fires once');
  snap = tracker.snapshot();
  const a = snap.jobs.find(j => j.id === 'a');
  assert.equal(a.status, 'completed'); assert.equal(a.nextTrackAt, null); assert.equal(a.kind, 'video'); assert.equal(a.costUsd, 0.1);
  assert.equal(snap.jobs.find(j => j.id === 'b').nextTrackAt !== null, true, 'uncertain jobs keep being checked');
  tracker.stop();
  assert.equal(tracker.snapshot().tracker.running, false);
});

test('tracker picks up new jobs, tracks on demand and flags stuck jobs', async () => {
  clock.t = T0;
  const gen = fakeSource('generation', [
    { id: 'slow', status: 'running', createdAt: ago(130000), dispatchStartedAt: ago(121000) },
    { id: 'fine', status: 'running', createdAt: ago(60000), dispatchStartedAt: ago(60000) },
    { id: 'held', status: 'uncertain', createdAt: ago(16 * 60000), uncertainAt: ago(16 * 60000), expected: 3600 },
    { id: 'recent', status: 'uncertain', createdAt: ago(5 * 60000), uncertainAt: ago(5 * 60000), expected: 3600 },
    { id: 'broken', status: 'queued', createdAt: ago(1000), throws: true },
  ]);
  const tracker = createJobTracker({ sources: [gen.source], ...options() });
  tracker.start();
  const byId = () => Object.fromEntries(tracker.snapshot().jobs.map(j => [j.id, j]));
  let jobs = byId();
  assert.equal(jobs.slow.stuck, true, 'older than 2× expected');
  assert.equal(jobs.fine.stuck, false);
  assert.equal(jobs.held.stuck, true, 'uncertain beyond the hold'); assert.equal(jobs.held.uncertain, true);
  assert.equal(jobs.recent.stuck, false);
  assert.equal(jobs.slow.ageSeconds, 121); assert.equal(jobs.slow.expectedSeconds, 60);
  await tracker.tick();
  jobs = byId();
  assert.match(jobs.broken.trackingError, /ECONNRESET/); assert.equal(jobs.broken.status, 'queued');
  // A job submitted after start is found by the periodic scan, then polled after one interval.
  gen.jobs.set('new', { id: 'new', status: 'queued', createdAt: new Date(T0).toISOString(), doneAfter: 1 });
  clock.t += 5000; await tracker.tick();
  assert.equal(gen.calls.filter(c => c.id === 'new').length, 0);
  assert.ok(byId().new.nextTrackAt);
  clock.t += 5000; await tracker.tick();
  assert.equal(gen.calls.filter(c => c.id === 'new').length, 1); assert.deepEqual(gen.terminal, ['new']);
  // trackNow is the HTTP route path: immediate, counted, and returns the job.
  const before = byId().fine.trackCount, now = await tracker.trackNow('generation', 'fine');
  assert.equal(now.status, 'running'); assert.equal(byId().fine.trackCount, before + 1);
  assert.equal(tracker.watch('generation', 'missing'), false);
  await assert.rejects(tracker.trackNow('nope', 'x'), /Unknown job source/);
});

test('tracker gives up polling after giveUpMs and reports the job stuck', async () => {
  clock.t = T0;
  const gen = fakeSource('generation', [{ id: 'old', status: 'running', createdAt: ago(3 * 3600e3), dispatchStartedAt: ago(3 * 3600e3), expected: 99999 }]);
  const logs = [], tracker = createJobTracker({ sources: [gen.source], ...options({ log: line => logs.push(line) }) });
  tracker.start(); await tracker.tick();
  for (let i = 0; i < 20; i++) { clock.t += 30000; await tracker.tick(); }
  assert.equal(gen.calls.length, 1);
  const job = tracker.snapshot().jobs[0];
  assert.equal(job.stuck, true); assert.equal(job.nextTrackAt, null);
  assert.ok(logs.some(line => /automatic tracking stopped/.test(line)));
});

test('slots: per-backend and per-kind limits, reservations, uncertain hold', () => {
  let t = T0;
  const env = { PREVIS_LIMIT_CLOUD_IMAGES: '2', PREVIS_LIMIT_CLOUD_VIDEOS: '1', PREVIS_UNCERTAIN_HOLD_MINUTES: '15' };
  const slots = createSlots({ env, now: () => t }), cloud = { kind: 'cloud' }, local = { kind: 'local' };
  const active = [];
  slots.register('generation', () => active);
  assert.deepEqual(limitsFor(cloud, 'video', {}), { key: 'cloud:video', label: 'cloud video', limit: 3 });
  assert.deepEqual(limitsFor(local, 'video', {}).limit, 1);
  const r1 = slots.acquire({ id: 'i1', backend: cloud, kind: 'image' });
  active.push({ id: 'i1', backend: cloud, kind: 'image', status: 'queued' });
  slots.acquire({ id: 'i2', backend: cloud, kind: 'image' });
  assert.throws(() => slots.acquire({ id: 'i3', backend: cloud, kind: 'image' }), e => e.status === 409 && e.apiCode === 'busy' && e.retryAfterSeconds === 15 && e.message === 'Backend busy: 2 of 2 cloud image slots in use; retry when a job finishes');
  assert.doesNotThrow(() => slots.acquire({ id: 'v1', backend: cloud, kind: 'video' }), 'videos have their own pool');
  assert.doesNotThrow(() => slots.acquire({ id: 'l1', backend: local, kind: 'image' }), 'local has its own pool');
  assert.deepEqual(slots.snapshot(), { 'cloud:image': { limit: 2, active: 2 }, 'cloud:video': { limit: 1, active: 1 }, local: { limit: 1, active: 1 } });
  r1(); // released reservation, still active as a job
  assert.equal(slots.snapshot()['cloud:image'].active, 2);
  active[0] = { id: 'i1', backend: cloud, kind: 'image', status: 'uncertain', uncertainAt: new Date(t).toISOString() };
  assert.equal(slots.snapshot()['cloud:image'].active, 2, 'uncertain holds its slot');
  t += 16 * 60000;
  assert.equal(slots.snapshot()['cloud:image'].active, 1, 'then stops counting after the hold');
  assert.doesNotThrow(() => slots.acquire({ id: 'i3', backend: cloud, kind: 'image' }));
});

test('backend errors keep redacted detail; per-call timeouts; Cloud provider errors without raw bodies', async () => {
  const secret = 'sk-test-' + 'x'.repeat(24);
  assert.equal(errorDetail(Object.assign(Error('Backend /prompt returned HTTP 400'), { detail: `{"error":"bad","api_key_comfy_org":"${secret}"}` })).includes(secret), false);
  assert.match(errorDetail(Object.assign(Error('Backend /prompt returned HTTP 400'), { detail: 'Authorization: Bearer abc.def' })), /Authorization=\[redacted\]/);
  assert.equal(errorDetail(Error(`leaked ${secret}`)), '[redacted]');
  assert.equal(errorDetail(Error('x'.repeat(900))).length, 500);
  const env = { COMFY_CLOUD_API_KEY: 'k'.repeat(20) };
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  let behaviour;
  const backend = createBackend({ kind: 'cloud' }, { env, timeouts: { queue: 20, upload: 5000 }, retry: { delaysMs: [1] }, fetch: async (url, init) => behaviour(url, init) });
  behaviour = async () => { throw new TypeError('fetch failed', { cause: Error('connect ECONNREFUSED 1.2.3.4:443') }); };
  await assert.rejects(backend.inspect(), e => e.message === 'Backend transport failed' && /ECONNREFUSED/.test(e.detail) && e.attempts === 3);
  behaviour = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  const keepAlive = setInterval(() => {}, 1000); // AbortSignal.timeout timers do not hold the event loop open
  try { await assert.rejects(backend.queue(), e => /\/queue: timed out/.test(e.detail)); } finally { clearInterval(keepAlive); }
  behaviour = async () => new Response('{"error":{"message":"prompt has no outputs"}}' + ' '.repeat(5000), { status: 400 });
  await assert.rejects(backend.submit({ graph: {}, requestId: 'r', projectId: 'p' }), e => e.httpStatus === 400 && /prompt has no outputs/.test(e.detail) && e.detail.length <= 2048);
  behaviour = async () => json({ id: 'job', status: 'failed', workflow: { prompt: {}, extra_data: { previs: { requestId: 'r' } } }, execution_error: { node_id: '2', node_type: 'LtxApi25ImageToVideo', exception_message: 'Server side error', exception_type: 'Exception', traceback: ['secret trace'], current_inputs: {}, current_outputs: {} } });
  const history = await backend.history('job');
  assert.deepEqual(history.error, { nodeId: '2', nodeType: 'LtxApi25ImageToVideo', message: 'Server side error' });
  assert.equal(history.status.status_str, 'error'); assert.equal(JSON.stringify(history).includes('secret trace'), false);
});

test('the tracker forgets finished jobs after a while, so its memory stays bounded; onTerminal still fires once', async () => {
  clock.t = T0;
  const gen = fakeSource('generation', Array.from({ length: 50 }, (_, i) => ({ id: `j${i}`, status: 'queued', createdAt: ago(1000), doneAfter: 1 })));
  const tracker = createJobTracker({ sources: [gen.source], ...options() });
  tracker.start(); await tracker.tick();
  assert.equal(gen.terminal.length, 50); assert.equal(tracker.finishedCount(), 50);
  for (let i = 0; i < 70; i++) { clock.t += 5000; await tracker.tick(); }
  assert.equal(tracker.finishedCount(), 0);
  assert.equal(gen.terminal.length, 50, 'no second onTerminal');
  tracker.stop();
});
