import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createJobProgressRoutes } from '../server/previs/job-progress-routes.mjs';
class Response extends EventEmitter {
  frames = []; writableLength = 0; destroyed = false; slow = false;
  writeHead(status, headers) { this.status = status; this.headers = headers; }
  write(frame) { this.frames.push(frame); return !this.slow; }
  end(body) { this.body = body; }
  destroy() { this.destroyed = true; this.emit('close'); }
}
const row = (id = 'j', projectId = 'p') => ({ source: 'generation', id, projectId, status: 'running', label: 'Shot', results: [], backend: { kind: 'local', id: 'b' } });
function fixture(options = {}) {
  let jobs = [row(), row('foreign', 'q')];
  const listeners = new Set(), telemetry = new Set();
  const scope = { snapshot: () => ({ jobs, limits: { local: { active: 1, limit: 2 } }, tracker: { running: true } }),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, ownsJob: (source, id) => jobs.some(j => j.projectId === 'p' && j.source === source && j.id === id) };
  const observe = { subscribe(p, fn) { telemetry.add(fn); return () => telemetry.delete(fn); },
    preview: (key, version) => version === 2 ? { mime: 'image/png', bytes: Buffer.from('fixture') } : null };
  const routes = createJobProgressRoutes({ resolveProject: async (req, p) => p === 'p' ? scope : null, observe, ...options });
  const request = async (url = '/api/jobs/stream?projectId=p', slow = false) => {
    const req = Object.assign(new EventEmitter(), { method: 'GET', url, headers: { 'last-event-id': 'old:99' } });
    const res = new Response(); res.slow = slow; await routes.handle(req, res); return { req, res };
  };
  return { routes, scope, observe, listeners, telemetry, request, setJobs(value) { jobs = value; }, notify(change) { for (const fn of listeners) fn(change); } };
}
const events = res => res.frames.filter(f => f.startsWith('id:')).map(f => ({ type: /event: (.+)/.exec(f)[1], ...JSON.parse(/data: (.+)/.exec(f)[1]) }));
test('policy denial, malformed project, method, unrelated route', async () => {
  const f = fixture();
  assert.equal((await f.request('/api/jobs/stream?projectId=q')).res.status, 404);
  assert.equal((await f.request('/api/jobs/stream?projectId=../p')).res.status, 400);
  const res = new Response(); assert.equal(await f.routes.handle({ method: 'POST', url: '/api/jobs/stream?projectId=p' }, res), true); assert.equal(res.status, 405);
  assert.equal(await f.routes.handle({ url: '/api/jobs', method: 'GET' }, new Response()), false);
  assert.equal(f.listeners.size, 0);
});
test('full snapshot first on every reconnect; filtered rows and increasing sequences', async () => {
  const f = fixture(), { res } = await f.request();
  assert.equal(res.headers['X-Accel-Buffering'], 'no');
  const first = events(res)[0]; assert.equal(first.type, 'snapshot'); assert.equal(first.jobs.length, 1); assert.deepEqual(first.jobs[0], row());
  assert.deepEqual(first.limits, { local: { active: 1, limit: 2 } });
  f.setJobs([{ ...row(), status: 'completed', results: [{ id: 'asset' }] }]); f.notify({ type: 'job', source: 'generation', id: 'j' });
  const next = events(res)[1]; assert.equal(next.job.status, 'completed'); assert.ok(next.seq > first.seq); assert.equal(next.job.label, 'Shot');
  const reconnect = await f.request(); assert.equal(events(reconnect.res)[0].type, 'snapshot'); assert.equal(events(reconnect.res)[0].jobs[0].status, 'completed');
  f.routes.stop(); assert.equal(f.listeners.size, 0); assert.equal(f.telemetry.size, 0);
});
test('subscription/read boundary queues synchronous changes behind initial snapshot', async () => {
  const f = fixture(); const original = f.scope.snapshot; let once = true;
  f.scope.snapshot = () => { if (once) { once = false; f.notify({ type: 'job', source: 'generation', id: 'j' }); } return original(); };
  const { res } = await f.request(); assert.deepEqual(events(res).map(e => e.type), ['snapshot', 'job']); f.routes.stop();
});
test('explicit remove only after authoritative absence; foreign updates omitted', async () => {
  const f = fixture(), { res } = await f.request();
  f.notify({ type: 'remove', source: 'generation', id: 'j' }); f.notify({ type: 'job', source: 'generation', id: 'foreign' }); assert.equal(events(res).length, 1);
  f.setJobs([]); f.notify({ type: 'job', source: 'generation', id: 'j' }); assert.equal(events(res).length, 1);
  f.notify({ type: 'remove', source: 'generation', id: 'j' }); assert.equal(events(res)[1].type, 'remove'); f.routes.stop();
});
test('preview checks persisted ownership and exact version on each fetch', async () => {
  const f = fixture();
  assert.equal((await f.request('/api/jobs/generation/foreign/preview?projectId=p&version=2')).res.status, 404);
  assert.equal((await f.request('/api/jobs/generation/j/preview?projectId=p&version=1')).res.status, 404);
  assert.equal((await f.request('/api/jobs/generation/j/preview?projectId=p&version=1.5')).res.status, 400);
  const { res } = await f.request('/api/jobs/generation/j/preview?projectId=p&version=2'); assert.equal(res.status, 200); assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
  f.setJobs([]); assert.equal((await f.request('/api/jobs/generation/j/preview?projectId=p&version=2')).res.status, 404);
});
test('preview metadata URL is regenerated; no upstream URL or arbitrary preview fields', async () => {
  const f = fixture(); f.observe.enrich = s => ({ ...s, jobs: s.jobs.map(j => ({ ...j, live: { phase: 'running', preview: { version: 2, url: 'https://provider.invalid/private', secret: 'not-public', mime: 'image/png', width: 1, height: 1 } } })) });
  const { res } = await f.request(); for (const fn of f.telemetry) fn({ type: 'preview', source: 'generation', id: 'j' });
  assert.ok(!res.frames.join('').includes('provider.invalid')); assert.ok(!res.frames.join('').includes('not-public'));
  assert.equal(events(res)[1].preview.url, '/api/jobs/generation/j/preview?projectId=p&version=2'); f.routes.stop();
});
test('bounded queue closes a slow consumer and releases all subscriptions', async () => {
  const f = fixture({ maxBytes: 1200 }), { res } = await f.request(undefined, true);
  for (let i = 0; i < 20; i++) f.notify({ type: 'job', source: 'generation', id: 'j' });
  assert.equal(res.destroyed, true); assert.equal(f.listeners.size, 0); assert.equal(f.telemetry.size, 0); assert.equal(f.routes.stats().clients, 0);
});
test('drain preserves order; stalled writers timeout; aborted connections clean up', async () => {
  const f = fixture({ stallMs: 10 }), { req, res } = await f.request(undefined, true);
  f.notify({ type: 'job', source: 'generation', id: 'j' }); assert.equal(events(res).length, 1);
  res.slow = false; res.emit('drain'); assert.deepEqual(events(res).map(e => e.type), ['snapshot', 'job']);
  req.emit('aborted'); assert.equal(f.listeners.size, 0);
  const stalled = await f.request(undefined, true); await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(stalled.res.destroyed, true); f.routes.stop();
});

test('heartbeat comments and shutdown leave no active timer or subscriber', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const f = fixture(), { res } = await f.request();
  t.mock.timers.tick(15000); assert.equal(res.frames.at(-1), ': heartbeat\n\n');
  f.routes.stop(); const count = res.frames.length; t.mock.timers.tick(60000); assert.equal(res.frames.length, count); assert.equal(f.listeners.size, 0);
});
