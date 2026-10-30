import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openProject } from '../server/previs/store.mjs';
import { createBackend } from '../server/previs/backends.mjs';
import { classifyFailure } from '../server/previs/failures.mjs';
import { createJobTracker } from '../server/previs/job-tracker.mjs';

// All writes are disposable; backend calls are injected fakes, never network calls.
test('engine additions serialize with edits, deduplicate inside the queue, and recover after rejection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'previs-reliability-')), p = await openProject(root);
  const edit = p.mutate(p.get().revision, q => { q.title = 'Edited'; });
  const append = () => p.append(async q => { await Promise.resolve(); if (q.renders.some(r => r.id === 'one')) return false; q.renders.push({ id: 'one' }); });
  await Promise.all([edit, append(), append()]);
  assert.equal(p.get().title, 'Edited'); assert.equal(p.get().renders.length, 1); assert.equal(p.get().revision, 3);
  await assert.rejects(p.append(() => { throw Error('fixture failure'); }), /fixture failure/);
  await p.append(q => { q.assets = [{ id: 'result' }]; });
  assert.deepEqual(JSON.parse(await readFile(join(root, 'project.json'))), p.get());
  await assert.rejects(p.mutate(1, () => {}), e => e.status === 409, 'interactive stale edits remain protected');
});

test('backend retries reads and pre-connection failures, never ambiguous paid submissions', async () => {
  let calls = 0, mode = 'read';
  const backend = createBackend({ kind: 'cloud' }, { env: { COMFY_CLOUD_API_KEY: 'fixture' }, sleep: async () => {}, fetch: async () => {
    calls++;
    if (mode === 'read' && calls < 3) return new Response('unavailable', { status: 503 });
    if (mode === 'connect' && calls < 3) throw new TypeError('fetch failed', { cause: Object.assign(Error('connect failed'), { code: 'ECONNREFUSED' }) });
    if (mode === 'ambiguous') throw Error('socket reset after send');
    if (mode === 'rate') return new Response('rate limit', { status: 429 });
    return new Response(JSON.stringify(mode === 'read' ? {} : { prompt_id: 'accepted' }));
  } });
  await backend.inspect(); assert.equal(calls, 3);
  mode = 'connect'; calls = 0; assert.equal((await backend.submit({ graph: {}, requestId: 'request', projectId: 'project' })).promptId, 'accepted'); assert.equal(calls, 3);
  mode = 'ambiguous'; calls = 0; await assert.rejects(backend.submit({ graph: {}, requestId: 'request' }), e => e.notSent !== true); assert.equal(calls, 1);
  mode = 'rate'; calls = 0; await assert.rejects(backend.submit({ graph: {}, requestId: 'request' }), e => e.notSent === true); assert.equal(calls, 1);
});

test('failure diagnosis never assumes a dispatch transport failure was free', () => {
  assert.deepEqual([classifyFailure({ status: 'failed', failure: { phase: 'dispatch', detail: 'socket timeout' } }).charged,
    classifyFailure({ status: 'uncertain' }).retryable], ['unknown', false]);
  assert.equal(classifyFailure({ status: 'failed', failure: { phase: 'dispatch', notSent: true } }).charged, 'no');
  assert.equal(classifyFailure({ status: 'failed', failure: { phase: 'execution' }, provider: { error: { message: 'Server side error' } } }).category, 'provider-transient');
});

test('jobs dashboard includes refused quotes with actionable diagnosis', () => {
  const job = { id: 'draft', status: 'quoted', createdAt: new Date().toISOString(), lastAttempt: { code: 'duplicate', error: 'An identical request is active' } };
  const tracker = createJobTracker({ tickMs: 0, sources: [{ name: 'fixture', list: () => [job], isActive: () => false, expectedSeconds: () => 90, label: () => 'Fixture', projectIdOf: () => null, costOf: () => null }] });
  const [row] = tracker.snapshot().jobs;
  assert.equal(row.diagnosis.category, 'duplicate'); assert.equal(row.diagnosis.charged, 'no'); assert.equal(row.lastAttempt.code, 'duplicate');
});

test('video duplicate detection survives restart and scopes identical work to its originating shot', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { randomUUID } = await import('node:crypto');
  const { openGeneration } = await import('../server/previs/generation.mjs');
  const root = await mkdtemp(join(tmpdir(), 'previs-video-duplicate-')), project = await openProject(root);
  await mkdir(join(root, 'generation-jobs'));
  const saved = { id: randomUUID(), shotId: 'shot', status: 'completed', completedAt: new Date().toISOString(), definitionHash: 'definition', definition: { outputs: [{ mediaType: 'video/mp4' }] }, preparedGraph: { model: { class_type: 'Fixture', inputs: { seed: 42 } } }, sources: { firstFrame: { sha256: 'bytes' } }, backend: { id: 'fixture', kind: 'cloud' } };
  await writeFile(join(root, 'generation-jobs', saved.id + '.json'), JSON.stringify(saved));
  const generation = await openGeneration(root, project);
  const next = { ...saved, id: randomUUID(), definitionHash: 'same-graph-new-preset-id', status: 'quoted' };
  assert.equal(generation.duplicateOf(next).id, saved.id);
  assert.equal(generation.duplicateOf({ ...next, shotId: 'another-shot' }), null);
  assert.equal(generation.duplicateOf({ ...next, sources: { firstFrame: { sha256: 'changed' } } }), null);
});

import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { openGeneration } from '../server/previs/generation.mjs';
import { generationRoutes } from '../server/previs/generation-routes.mjs';
import { backendSnapshot } from '../server/previs/backends.mjs';
import { hashValue } from '../server/previs/workflows.mjs';
import { atomicJson } from '../server/previs/atomic.mjs';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');
async function recoveryFixture() {
  const root = await mkdtemp(join(tmpdir(), 'previs-output-recovery-')), project = await openProject(root);
  const graph = { 1: { class_type: 'SaveImage', inputs: {} } };
  const job = { id: randomUUID(), status: 'queued', promptId: 'existing-prompt', backend: backendSnapshot({ kind: 'local' }), submittedGraphHash: hashValue(graph), definition: { outputs: [{ nodeId: '1', mediaType: 'image/png' }] }, results: [], shot: { binding: {} }, sources: {}, binding: {}, createdAt: new Date().toISOString() };
  await mkdir(join(root, 'generation-jobs'));
  const file = join(root, 'generation-jobs', job.id + '.json');
  await atomicJson(file, job);
  const counts = { history: 0, view: 0, submit: 0 };
  const adapter = { snapshot: job.backend, history: async () => { counts.history++; return { promptId: job.promptId, requestId: job.id, graph, status: { completed: true }, outputs: { 1: { images: [{ filename: 'output.png', subfolder: '', type: 'output' }] } } }; }, view: async () => { counts.view++; return PNG; }, submit: async () => { counts.submit++; throw Error('Forbidden submit'); } };
  return { root, project, job, file, counts, adapter, options: { backendFactory: () => adapter } };
}

test('output transfer recovery survives restart and expired history, using only the persisted output identity', async () => {
  const f = await recoveryFixture(), view = f.adapter.view;
  f.adapter.view = async () => { throw Error('fixture transfer failure'); };
  let generation = await openGeneration(f.root, f.project, f.options);
  const failed = await generation.track(f.job.id);
  assert.equal(failed.status, 'collecting'); assert.equal(failed.recovery.collection, 1); assert.equal(failed.collection.length, 1);
  f.adapter.history = async () => { throw Error('History expired'); }; f.adapter.view = view;
  generation = await openGeneration(f.root, f.project, f.options);
  const recovered = await generation.track(f.job.id);
  assert.equal(recovered.status, 'completed'); assert.equal(recovered.results.length, 1); assert.equal(recovered.recovery.collection, 2);
  assert.equal(f.counts.submit, 0); assert.equal(f.counts.history, 1);
});

test('attachment callback failure after append resumes on restart without retransfer or duplicate assets', async () => {
  const f = await recoveryFixture();
  f.job.shot.browser = { director: { projectId: 'fixture-director' } }; await atomicJson(f.file, f.job);
  let routes = await generationRoutes(f.root, f.project, f.options);
  const director = { syncResults: async () => { throw Error('fixture attachment failure'); } };
  let tracker = createJobTracker({ sources: [routes.trackerSource({ director })], tickMs: 0 }); routes.useTracker(tracker);
  tracker.start(); await tracker.tick(); tracker.stop();
  assert.equal(routes.state().jobs[0].status, 'attaching'); assert.equal(f.project.get().assets.length, 1);
  assert.equal(routes.state().jobs[0].completedAt, undefined);
  const revision = f.project.get().revision;
  f.adapter.view = async () => { throw Error('Must not retransfer'); }; f.adapter.history = async () => { throw Error('Must not reread history'); };
  director.syncResults = async () => ({ project: { assets: f.project.get().assets.map(r => ({ source: { jobId: f.job.id, resultId: r.id } })) } });
  routes = await generationRoutes(f.root, f.project, f.options);
  tracker = createJobTracker({ sources: [routes.trackerSource({ director })], tickMs: 0 }); routes.useTracker(tracker);
  tracker.start();
  await Promise.all([tracker.tick(), f.project.append(p => { p.renders.push({ id: 'concurrent' }); })]); tracker.stop();
  const done = routes.state().jobs[0];
  assert.equal(done.status, 'completed'); assert.ok(done.attachment.completedAt); assert.equal(done.recovery.attachment, 2);
  assert.equal(f.project.get().assets.length, 1); assert.equal(f.project.get().renders.length, 1); assert.equal(f.project.get().revision, revision + 1);
  assert.equal(f.counts.submit, 0); assert.equal(f.counts.view, 1);
});

test('interrupted result receipt write reuses one stable media file', async () => {
  const f = await recoveryFixture(); let rejectResult = true;
  const persist = async (file, job) => { if (job.results.length && rejectResult) { rejectResult = false; throw Error('fixture receipt disk failure'); } await atomicJson(file, job); };
  let generation = await openGeneration(f.root, f.project, { ...f.options, persist });
  assert.equal((await generation.track(f.job.id)).status, 'collecting');
  const files = await readdir(join(f.root, 'renders')); assert.equal(files.length, 1);
  generation = await openGeneration(f.root, f.project, f.options);
  assert.equal((await generation.track(f.job.id)).status, 'completed');
  assert.deepEqual(await readdir(join(f.root, 'renders')), files); assert.equal(f.counts.submit, 0);
});

for (const phase of ['collection', 'attachment']) test(`${phase} recovery budget survives repeated restart and never reports success`, async () => {
  const f = await recoveryFixture();
  if (phase === 'collection') f.adapter.view = async () => { f.counts.view++; throw Error('fixture unavailable'); };
  let callbacks = 0;
  const options = { ...f.options, ...(phase === 'attachment' ? { onTerminal: async () => { callbacks++; throw Error('fixture unavailable'); } } : {}) };
  for (let i = 0; i < 5; i++) {
    const generation = await openGeneration(f.root, f.project, options);
    const job = await generation.track(f.job.id);
    assert.notEqual(job.status, 'completed');
    if (i >= 2) assert.equal(job.status, 'recovery-required');
  }
  assert.equal(phase === 'collection' ? f.counts.view : callbacks, 3); assert.equal(f.counts.submit, 0);
});

test('uncertain dispatch stays unsubmitted during recovery scans and explicit tracking', async () => {
  const f = await recoveryFixture(); await atomicJson(f.file, { ...f.job, status: 'submitting', promptId: null });
  const generation = await openGeneration(f.root, f.project, f.options);
  assert.equal((await generation.track(f.job.id)).status, 'uncertain');
  assert.deepEqual(f.counts, { history: 0, view: 0, submit: 0 });
});

test('incomplete director attachment never produces final success', async () => {
  const f = await recoveryFixture(); f.job.shot.browser = { director: { projectId: 'fixture-director' } }; await atomicJson(f.file, f.job);
  const routes = await generationRoutes(f.root, f.project, f.options);
  const source = routes.trackerSource({ director: { syncResults: async () => ({ project: { assets: [] } }) } });
  const job = await source.track(f.job.id);
  assert.equal(job.status, 'attaching'); assert.match(job.failure.detail, /attachment is incomplete/); assert.equal(job.completedAt, undefined);
  assert.equal(f.counts.submit, 0);
});
