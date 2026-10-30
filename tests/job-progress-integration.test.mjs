import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDirector } from '../server/previs/director.mjs';
import { openRefgen } from '../server/previs/refgen.mjs';
import { backendSnapshot, createBackend } from '../server/previs/backends.mjs';
import { createProgressCoordinator } from '../server/previs/job-progress-coordinator.mjs';
import { telemetryHooks } from '../server/previs/job-progress.mjs';

// Disposable data and injected fakes only: no network, no models, no paid calls.
const n = (input, output) => ({ input: { required: input }, output, python_module: 'nodes' });
const objectInfo = {
  CheckpointLoaderSimple: n({ ckpt_name: [['sd15.safetensors']] }, ['MODEL', 'CLIP', 'VAE']),
  CLIPTextEncode: n({ text: ['STRING', {}], clip: ['CLIP'] }, ['CONDITIONING']),
  EmptyLatentImage: n({ width: ['INT', {}], height: ['INT', {}], batch_size: ['INT', {}] }, ['LATENT']),
  KSampler: n({ model: ['MODEL'], positive: ['CONDITIONING'], negative: ['CONDITIONING'], latent_image: ['LATENT'], seed: ['INT', {}], steps: ['INT', {}], cfg: ['FLOAT', {}], sampler_name: [['euler']], scheduler: [['normal']], denoise: ['FLOAT', {}] }, ['LATENT']),
  VAEDecode: n({ samples: ['LATENT'], vae: ['VAE'] }, ['IMAGE']),
  SaveImage: n({ images: ['IMAGE'], filename_prefix: ['STRING', {}] }, []),
};
function fakeBackend(log) {
  return input => ({
    snapshot: backendSnapshot(input),
    async inspect() { return { objectInfo: structuredClone(objectInfo) }; },
    async upload() { return { value: 'x.png' }; },
    async submit(req) { log.push(['submit', req.requestId, req.clientId]); if (log.ambiguous) throw Error('socket hang up'); return { promptId: req.requestId }; },
    async history() { return null; },
  });
}
function fakeObserver(log) {
  const calls = name => (...args) => { log.push([name, ...structuredClone(args)]); return name === 'begin' ? Promise.resolve(true) : true; };
  return { begin: calls('begin'), phase: calls('phase'), accept: calls('accept'), reconcile: calls('reconcile'), close: calls('close'), stop: calls('stop') };
}
async function setup(telemetry, log = []) {
  const root = await mkdtemp(join(tmpdir(), 'previs-progress-int-'));
  const director = await openDirector(root);
  const project = await director.create({ template: 'street' });
  const refgen = await openRefgen(root, director, { backend: fakeBackend(log), allowPaid: false, telemetry });
  const runner = project.scene.entities.find(e => e.name === 'Runner');
  const quote = () => refgen.prepare({ projectId: project.id, entityId: runner.id, presetId: 'local-checkpoint', prompt: 'a runner', aspect: '3:4', count: 1, seed: 7, checkpoint: 'sd15.safetensors' });
  const send = job => refgen.submit({ projectId: project.id, requestId: job.id, approval: { approved: true, fingerprint: job.fingerprint, allowance: { currency: 'USD', maxAmount: 0 } } });
  return { root, project, refgen, quote, send, log };
}

test('dispatch: per-job client ID is durable before uploads, observation opens before POST, accept follows the durable receipt', async () => {
  const log = [], sources = {};
  const coordinator = createProgressCoordinator({ observe: fakeObserver(log), sources, intervalMs: 0 });
  const { root, project, refgen, quote, send } = await setup(coordinator.telemetry('refgen'), log);
  sources.refgen = refgen.trackerSource();
  const job = await quote(), sent = await send(job);
  assert.equal(sent.status, 'submitted');
  const saved = JSON.parse(await readFile(join(root, 'director', project.id, 'refgen', job.id + '.json'), 'utf8'));
  assert.match(saved.progressClientId, /^[a-f0-9-]{36}$/); assert.notEqual(saved.progressClientId, project.id);
  const names = log.map(entry => entry[0] === 'phase' ? `phase:${entry[2]}` : entry[0]);
  assert.deepEqual(names, ['begin', 'phase:uploading', 'phase:submitting', 'submit', 'accept']);
  const [, key, options] = log[0];
  assert.deepEqual(key, { source: 'refgen', id: job.id, projectId: project.id });
  assert.deepEqual(options, { backend: { kind: 'local', url: 'http://127.0.0.1:8000' }, requestId: job.id, clientId: saved.progressClientId, dedicated: true });
  assert.equal(log[3][2], saved.progressClientId, 'the wire client_id is exactly the persisted identity');
  assert.deepEqual(log[4][2], { promptId: job.id });
  assert.ok(!JSON.stringify(log).includes('token'), 'no credential in any descriptor');
});

test('telemetry failures never change dispatch: throwing, rejecting or hanging hooks still dispatch exactly once', async t => {
  for (const telemetry of [
    { begin() { throw Error('boom'); }, phase() { throw Error('boom'); }, accept() { throw Error('boom'); } },
    { begin: () => Promise.reject(Error('no')), phase: () => Promise.reject(Error('no')), accept: () => Promise.reject(Error('no')) },
    { begin: () => new Promise(() => {}) },
  ]) {
    const started = Date.now();
    const { quote, send, log } = await setup(telemetry);
    const sent = await send(await quote());
    assert.equal(sent.status, 'submitted');
    assert.equal(log.filter(entry => entry[0] === 'submit').length, 1);
    assert.ok(Date.now() - started < 4000, 'a hanging begin is bounded');
  }
  // An ambiguous dispatch stays uncertain with zero resubmissions and no accept.
  const log = [], { quote, send } = await setup(createProgressCoordinator({ observe: fakeObserver(log), sources: {}, intervalMs: 0 }).telemetry('refgen'), log);
  log.ambiguous = true;
  const job = await quote(), uncertain = await send(job);
  assert.equal(uncertain.status, 'uncertain');
  assert.equal((await send(job)).status, 'uncertain', 'never resent');
  assert.equal(log.filter(entry => entry[0] === 'submit').length, 1);
  assert.ok(!log.some(entry => entry[0] === 'accept'));
});

test('telemetryHooks bound begin and swallow errors', async () => {
  const hooks = telemetryHooks({ begin: () => new Promise(() => {}), phase() { throw Error('x'); } }, { boundMs: 10 });
  assert.equal(await hooks.begin({}), false);
  assert.doesNotThrow(() => hooks.phase({}, 'uploading'));
  assert.equal(await telemetryHooks(undefined).begin({}), undefined);
});

test('restore observes only durably accepted receipts; legacy receipts share the historical client ID', () => {
  const log = [], local = { kind: 'local', url: 'http://localhost:8000' };
  const jobs = [
    { id: 'a1', projectId: 'p1', status: 'submitted', promptId: 'a1', backend: local, progressClientId: 'c-a1' },
    { id: 'legacy', projectId: 'p1', status: 'submitted', promptId: 'legacy', backend: local },
    { id: 'unsure', projectId: 'p1', status: 'uncertain', promptId: null, backend: local },
    { id: 'collecting', projectId: 'p1', status: 'collecting', promptId: 'collecting', backend: local },
    { id: 'bad-url', projectId: 'p1', status: 'submitted', promptId: 'bad-url', backend: { kind: 'local', url: 'http://example.com:8000' } },
  ];
  const sources = { refgen: { list: () => jobs, projectIdOf: job => job.projectId }, generation: { list: () => [
    { id: 'g1', status: 'queued', acceptedAt: 'x', promptId: 'g1', projectId: 'legacy-project', shot: { browser: { director: { projectId: 'p2' } } }, backend: { kind: 'cloud' } },
    { id: 'g2', status: 'uploading', promptId: 'g2', projectId: 'legacy-project', shot: { browser: { director: { projectId: 'p2' } } }, backend: local },
  ], projectIdOf: job => job.shot.browser.director.projectId } };
  const coordinator = createProgressCoordinator({ observe: fakeObserver(log), sources, intervalMs: 0, cloudClientId: 'cloud-client' });
  assert.equal(coordinator.restore(), 3);
  const begun = log.filter(entry => entry[0] === 'begin').map(entry => [entry[1].id, entry[2]]);
  assert.deepEqual(begun, [
    ['g1', { backend: { kind: 'cloud' }, requestId: 'g1', clientId: 'cloud-client', accountKey: 'default-cloud-account' }],
    ['a1', { backend: { kind: 'local', url: 'http://localhost:8000' }, requestId: 'a1', clientId: 'c-a1', dedicated: true }],
    ['legacy', { backend: { kind: 'local', url: 'http://localhost:8000' }, requestId: 'legacy', clientId: 'p1', dedicated: false }],
  ]);
  assert.deepEqual(log.filter(entry => entry[0] === 'accept').map(entry => entry[2].promptId), ['g1', 'a1', 'legacy']);
});

test('coordinator reconciles from C1, publishes changed keys per project, removals close observation; ownership is persisted', () => {
  const log = [], events = [], rows = [
    { id: 'j1', source: 'refgen', projectId: 'p1', status: 'submitted', ageSeconds: 1, trackCount: 0, results: [] },
    { id: 'j2', source: 'refgen', projectId: 'p2', status: 'submitted', ageSeconds: 1, trackCount: 0, results: [] },
  ];
  const tracker = { snapshot: () => ({ jobs: structuredClone(rows), limits: {}, tracker: {} }) };
  const store = { j1: { id: 'j1', projectId: 'p1' }, j2: { id: 'j2', projectId: 'p2' } };
  const sources = { refgen: { get: id => { if (!store[id]) throw Error('Unknown'); return store[id]; }, projectIdOf: job => job.projectId } };
  const coordinator = createProgressCoordinator({ observe: fakeObserver(log), sources, intervalMs: 0 });
  const off = coordinator.subscribe('p1', change => events.push(change));
  coordinator.start(tracker);
  assert.deepEqual(events, [{ type: 'job', source: 'refgen', id: 'j1' }], 'foreign project keys are never published');
  coordinator.tick(); assert.equal(events.length, 1, 'unchanged rows are quiet');
  rows[0].status = 'completed'; coordinator.tick();
  assert.deepEqual(events.at(-1), { type: 'job', source: 'refgen', id: 'j1' });
  assert.equal(log.filter(entry => entry[0] === 'reconcile').length, 3, 'every pass feeds C1 to the observer');
  rows.shift(); coordinator.tick();
  assert.deepEqual(events.at(-1), { type: 'remove', source: 'refgen', id: 'j1' });
  assert.deepEqual(log.find(entry => entry[0] === 'close')[1], { source: 'refgen', id: 'j1', projectId: 'p1' });
  const scope = coordinator.scope('p1');
  assert.equal(scope.ownsJob('refgen', 'j1'), true);
  assert.equal(scope.ownsJob('refgen', 'j2'), false, 'another project');
  assert.equal(scope.ownsJob('refgen', 'missing'), false);
  assert.equal(scope.ownsJob('generation', 'j1'), false, 'unknown source store');
  assert.deepEqual(scope.snapshot().jobs.map(row => row.id), []);
  off(); off(); coordinator.stop();
  assert.ok(log.some(entry => entry[0] === 'stop'));
});

test('local submit sends the per-job client_id; Cloud never sends client or prompt overrides', async () => {
  const bodies = [];
  const fetch = async (url, init) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify({ prompt_id: JSON.parse(init.body).prompt_id || 'cloud-1' })); };
  const local = createBackend({ kind: 'local', url: 'http://127.0.0.1:8188' }, { fetch, env: {} });
  await local.submit({ graph: {}, requestId: 'r1', projectId: 'p1', clientId: 'c1' });
  await local.submit({ graph: {}, requestId: 'r2', projectId: 'p1' });
  await assert.rejects(local.submit({ graph: {}, requestId: 'r3', projectId: 'p1', clientId: 'bad id/..' }), e => e.notSent === true);
  const cloud = createBackend({ kind: 'cloud' }, { fetch, env: { COMFY_CLOUD_API_KEY: 'fixture' } });
  await cloud.submit({ graph: {}, requestId: 'r4', projectId: 'p1', clientId: 'c4' });
  assert.deepEqual(bodies.map(body => [body.client_id, body.prompt_id]), [['c1', 'r1'], ['p1', 'r2'], [undefined, undefined]]);
});
