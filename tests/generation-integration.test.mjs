// Generation engine: actual routes, store and backend adapter with a fake fetch.
// (The legacy generation.html page simulations were removed with that page.)
// Only disposable local fixtures are written. No server, browser, media process,
// Blender, Comfy, network, GPU, downloads or cleanup/deletion runs here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openProject } from '../server/previs/store.mjs';
import { generationRoutes } from '../server/previs/generation-routes.mjs';
import { hashBytes } from '../server/previs/workflows.mjs';
import { openGeneration } from '../server/previs/generation.mjs';
import { backendSnapshot } from '../server/previs/backends.mjs';
import { createSlots } from '../server/previs/concurrency.mjs';
import { createJobTracker } from '../server/previs/job-tracker.mjs';
import { assertNoSecrets } from '../server/previs/workflows.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');
const backend = { kind: 'local', url: 'http://127.0.0.1:8188' };
const sourceBinding = { source: 'blender', scene: 'Saved scene', camera: 'Source camera', start: 1, end: 72, frame: 1, fps: 24 };
const requestBinding = { ...sourceBinding, camera: 'Rebound camera', start: 40, end: 80, frame: 40 };
const definition = () => ({
  version: 1, id: 'definition', title: 'Simulated first frame', task: 'first-frame',
  graph: {
    '1': { class_type: 'LoadImage', inputs: { image: 'author.png' } },
    '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'author/output' } },
  },
  inputs: { firstFrame: { nodeId: '1', input: 'image' } },
  outputs: [{ nodeId: '2', mediaType: 'image/png' }],
});
const schema = {
  LoadImage: { python_module: 'nodes', output: ['IMAGE', 'MASK'], input: { required: { image: [['author.png'], { image_upload: true }] } } },
  SaveImage: { python_module: 'nodes', output_node: true, output: [], input: { required: { images: ['IMAGE'], filename_prefix: ['STRING'] } } },
  CLIPTextEncode: { python_module: 'nodes', output: ['CONDITIONING'], input: { required: { text: ['STRING'] } } },
};
const approval = job => ({ approved: true, fingerprint: job.fingerprint, allowance: { currency: 'USD', maxAmount: 0 } });

async function fixture(t, { workflow = definition() } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'previs-generation-integration-'));
  const project = await openProject(root), image = await project.image(png);
  await project.mutate(project.get().revision, p => {
    p.shots.push({ id: 'shot', title: 'Rebound shot', binding: requestBinding, renders: [image.id] });
    p.renders.push({ ...image, shotId: 'shot', source: 'blender', binding: sourceBinding, requestRevision: 1 });
    p.assets = []; p.workflowDefinitions = [workflow];
  });
  const state = { schema: structuredClone(schema), calls: [], uploads: [], submissions: [], views: [] };
  const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  // Intercept the actual backend adapter's transport, including unexpected URLs.
  // There is deliberately no fallback to the original fetch.
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const parsed = new URL(url); assert.equal(parsed.origin, backend.url);
    state.calls.push(parsed.pathname);
    if (parsed.pathname === '/object_info') return json(state.schema);
    if (parsed.pathname === '/queue') return json({ queue_running: [], queue_pending: [] });
    if (parsed.pathname === '/upload/image') {
      assert.equal(init.method, 'POST'); assert.ok(init.body instanceof FormData);
      const image = init.body.get('image'), bytes = Buffer.from(await image.arrayBuffer());
      state.uploads.push({ bytes, name: image.name });
      return json({ name: image.name, subfolder: init.body.get('subfolder'), type: 'input' });
    }
    if (parsed.pathname === '/prompt') {
      assert.equal(init.method, 'POST'); const body = JSON.parse(init.body);
      state.submissions.push(body); return json({ prompt_id: body.prompt_id });
    }
    if (parsed.pathname.startsWith('/history/')) {
      const id = parsed.pathname.split('/').at(-1), body = state.submissions.find(s => s.prompt_id === id);
      assert.ok(body, 'history must identify a submitted request');
      return json({ [id]: { prompt: [0, id, body.prompt, body.extra_data], status: { completed: true, status_str: 'success' }, outputs: {
        '2': { images: [{ filename: 'first.png', subfolder: '', type: 'output' }, { filename: 'second.png', subfolder: '', type: 'output' }] },
        '99': { images: [{ filename: 'undeclared.png', subfolder: '', type: 'output' }] },
      } } });
    }
    if (parsed.pathname === '/view') {
      const filename = parsed.searchParams.get('filename');
      assert.ok(['first.png', 'second.png'].includes(filename)); state.views.push(filename);
      return new Response(png);
    }
    assert.fail('Unexpected simulated backend endpoint: ' + parsed.pathname);
  });
  const routes = await generationRoutes(root, project);
  const route = (operation, input) => routes.route('/api/generation/' + operation, input);
  async function bind(extra = {}) {
    const bound = await route('bind', { revision: project.get().revision, definitionId: workflow.id, shotId: 'shot', assetBindings: { firstFrame: { renderId: image.id } }, prompt: 'New prompt', parameters: {}, ...extra });
    return { requestId: randomUUID(), revision: bound.project.revision, workflowBindingId: bound.workflowBindingId, backend };
  }
  async function complete() {
    const input = await bind(), { job: quoted } = await route('quote', input);
    assert.equal(quoted.validation.compatible, true);
    assert.equal((await route('submit', { ...input, approval: approval(quoted) })).job.status, 'queued');
    const { job } = await route('track', { jobId: input.requestId });
    assert.equal(job.status, 'completed'); return job;
  }
  return { root, project, image, workflow, state, routes, route, bind, complete };
}

// Engine checks against a fake Cloud adapter (backendFactory): nothing leaves the process and nothing is paid.
async function cloudFixture({ limit = '2', submitError = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'previs-generation-cloud-'));
  const project = await openProject(root), image = await project.image(png);
  await project.mutate(project.get().revision, p => {
    p.shots.push({ id: 'shot', title: 'Cloud shot', binding: requestBinding, renders: [image.id] });
    p.renders.push({ ...image, shotId: 'shot', source: 'blender', binding: sourceBinding, requestRevision: 1 });
    p.assets = []; p.workflowDefinitions = [definition()];
  });
  const calls = { uploads: 0, submits: 0, values: [] };
  const backendFactory = selection => ({
    snapshot: backendSnapshot(selection),
    async inspect() { return { objectInfo: structuredClone(schema) }; },
    async queue() { return { queue_running: [], queue_pending: [] }; },
    async upload(bytes) { calls.uploads++; return { name: hashBytes(bytes) + '.png', subfolder: '', type: 'input', value: hashBytes(bytes) + '.png' }; },
    async submit({ graph, requestId }) { calls.submits++; calls.values.push(graph['1'].inputs.image); if (submitError) throw submitError(); return { promptId: 'cloud-' + requestId.slice(0, 8) }; },
    async history() { return null; },
  });
  const generation = await openGeneration(root, project, { backendFactory, allowPaid: true, slots: createSlots({ env: { PREVIS_LIMIT_CLOUD_IMAGES: limit } }) });
  async function quoted() {
    const id = randomUUID();
    await project.mutate(project.get().revision, p => { p.workflowBindings.push({ id, definitionId: 'definition', shotId: 'shot', assetBindings: { firstFrame: { renderId: image.id } }, prompt: 'cloud', parameters: {}, createdAt: new Date().toISOString() }); });
    const input = { requestId: randomUUID(), revision: project.get().revision, workflowBindingId: id, backend: { kind: 'cloud' } };
    return { input, job: await generation.quote(input) };
  }
  const consent = job => ({ approved: true, fingerprint: job.fingerprint, allowance: { currency: 'USD', maxAmount: 1, allowUnknownCharges: true } });
  return { root, project, generation, calls, quoted, consent };
}

test('engine: two concurrent Cloud submits fit a limit of 2, the third is refused busy and stays quoted', async () => {
  const h = await cloudFixture({ limit: '2' }), requests = [await h.quoted(), await h.quoted(), await h.quoted()];
  const sent = await Promise.all(requests.slice(0, 2).map(({ input, job }) => h.generation.submit({ ...input, approval: h.consent(job) })));
  assert.deepEqual(sent.map(job => job.status), ['queued', 'queued']);
  const [, , third] = requests;
  await assert.rejects(h.generation.submit({ ...third.input, approval: h.consent(third.job) }),
    e => e.status === 409 && e.apiCode === 'busy' && e.retryAfterSeconds === 15 && e.message === 'Backend busy: 2 of 2 cloud image slots in use; retry when a job finishes');
  assert.equal(h.generation.get(third.input.requestId).status, 'quoted');
  assert.equal(h.calls.submits, 2);
  // Upload cache: three requests bound to the same render bytes uploaded them once.
  assert.equal(h.calls.uploads, 1); assert.equal(new Set(h.calls.values).size, 1);
  const cache = JSON.parse(await readFile(join(h.root, 'upload-cache.json'), 'utf8'));
  assert.equal(Object.keys(cache.entries).length, 1); assert.match(Object.keys(cache.entries)[0], /^[a-f0-9]{64}:cloud:https:\/\/cloud\.comfy\.org$/);
});

test('engine: a rejected dispatch persists redacted failure.detail and never the key', async t => {
  const secret = 'test-cloud-key-' + 'q'.repeat(20), previous = process.env.COMFY_CLOUD_API_KEY;
  process.env.COMFY_CLOUD_API_KEY = secret;
  t.after(() => { if (previous === undefined) delete process.env.COMFY_CLOUD_API_KEY; else process.env.COMFY_CLOUD_API_KEY = previous; });
  const h = await cloudFixture({ submitError: () => Object.assign(Error('Backend /prompt returned HTTP 400'), { httpStatus: 400, detail: `{"error":{"type":"prompt_outputs_failed_validation"},"extra_data":{"api_key_comfy_org":"${secret}"}}` }) });
  const { input, job } = await h.quoted();
  const failed = await h.generation.submit({ ...input, approval: h.consent(job) });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failure.phase, 'dispatch'); assert.equal(failed.failure.httpStatus, 400);
  assert.match(failed.failure.detail, /HTTP 400 — .*prompt_outputs_failed_validation/); assert.ok(failed.failure.detail.length <= 500);
  const receipt = await readFile(join(h.root, 'generation-jobs', job.id + '.json'), 'utf8');
  assert.equal(receipt.includes(secret), false); assert.doesNotThrow(() => assertNoSecrets(JSON.parse(receipt)));
  // A transport failure before dispatch (e.g. an upload timeout) is a preparation failure with its cause kept.
  const h2 = await cloudFixture();
  const { input: input2, job: job2 } = await h2.quoted();
  await h2.project.mutate(h2.project.get().revision, () => {}); // unrelated edit between quote and submit
  const slow = await openGeneration(h2.root, h2.project, { allowPaid: true, slots: createSlots(), backendFactory: selection => ({ snapshot: backendSnapshot(selection), inspect: async () => ({ objectInfo: structuredClone(schema) }), upload: async () => { throw Object.assign(Error('Backend transport failed; no automatic retry'), { detail: '/upload/image: timed out after 120 s' }); } }) });
  const prep = await slow.submit({ ...input2, approval: h2.consent(job2) });
  assert.equal(prep.status, 'failed'); assert.deepEqual(prep.failure, { phase: 'preparation', httpStatus: null, detail: 'Backend transport failed; no automatic retry — /upload/image: timed out after 120 s' });
});

test('engine: a quote survives unrelated project edits but not a changed source', async t => {
  const h = await fixture(t), input = await h.bind(), { job: quoted } = await h.route('quote', input);
  assert.equal(quoted.cameraSource, 'still', 'every video job records where its camera comes from');
  await h.bind(); // another pipeline binds a shot: the global revision moves
  await h.project.mutate(h.project.get().revision, p => { p.shots.push({ id: 'other', title: 'Other shot', binding: requestBinding, renders: [] }); });
  assert.ok(h.project.get().revision > input.revision);
  const { job } = await h.route('submit', { ...input, approval: approval(quoted) });
  assert.equal(job.status, 'queued'); assert.equal(job.requestRevision, input.revision, 'request revision stays as provenance');
  assert.equal((await h.route('track', { jobId: input.requestId })).job.status, 'completed');
  const second = await h.bind(), { job: q2 } = await h.route('quote', second);
  await h.project.mutate(h.project.get().revision, p => { p.renders[0].binding = { ...p.renders[0].binding, camera: 'Changed source camera' }; });
  await assert.rejects(h.route('submit', { ...second, approval: approval(q2) }), e => e.status === 409 && /Approval invalidated/.test(e.message));
  assert.equal(h.routes.state().jobs.find(j => j.id === second.requestId).status, 'invalidated');
  await assert.rejects(h.route('quote', { ...second, requestId: randomUUID(), revision: h.project.get().revision + 5 }), e => e.status === 409);
});

test('engine: the server tracker collects and attaches a queued job without a client track call', async t => {
  const h = await fixture(t), input = await h.bind(), { job: quoted } = await h.route('quote', input);
  let now = Date.parse('2026-10-30T12:00:00Z');
  const tracker = createJobTracker({ sources: [h.routes.trackerSource()], now: () => now, tickMs: 0 });
  h.routes.useTracker(tracker); tracker.start();
  assert.equal(tracker.snapshot().tracker.resumed, 0);
  await h.route('submit', { ...input, approval: approval(quoted) });
  let [row] = tracker.snapshot().jobs;
  assert.equal(row.status, 'queued'); assert.equal(row.source, 'generation'); assert.equal(row.kind, 'image'); assert.equal(row.expectedSeconds, 600, 'local backend');
  assert.match(row.label, /^Rebound shot · Simulated first frame$/); assert.ok(row.nextTrackAt);
  now += 5000; await tracker.tick();
  [row] = tracker.snapshot().jobs;
  assert.equal(row.status, 'completed'); assert.equal(row.trackCount, 1); assert.equal(row.results.length, 2);
  assert.equal(h.project.get().assets.length, 2, 'onTerminal attached results to the project');
  const receipt = JSON.parse(await readFile(join(h.root, 'generation-jobs', input.requestId + '.json'), 'utf8'));
  assert.equal(receipt.tracking.trackCount, 1); assert.ok(receipt.tracking.lastTrackedAt);
  // The HTTP route keeps its { job, project } shape and does not attach twice.
  const again = await h.route('track', { jobId: input.requestId });
  assert.equal(again.job.status, 'completed'); assert.equal(again.project.assets.length, 2);
});
