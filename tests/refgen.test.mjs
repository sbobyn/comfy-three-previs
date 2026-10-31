import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDirector } from '../server/previs/director.mjs';
import { openRefgen, imagePresets, GUIDE_INPUT } from '../server/previs/refgen.mjs';
import { validateGraph } from '../server/previs/workflows.mjs';
import { backendSnapshot } from '../server/previs/backends.mjs';
import { createSlots } from '../server/previs/concurrency.mjs';
import { createJobTracker } from '../server/previs/job-tracker.mjs';
import { lookPrompt, compilePrompt, objectLooks } from '../shared/director.mjs';
import { IMAGE_PRICES, referenceUsd } from '../shared/tiers.mjs';

// Live Comfy Cloud /object_info for the partner nodes the presets use (captured 2026-10-30, trimmed to the schema).
const liveInfo = JSON.parse(await readFile(new URL('./fixtures/partner-object-info.json', import.meta.url), 'utf8'));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');
const n = (input, output, extra = {}) => ({ input: { required: input }, output, python_module: 'nodes', ...extra });
const objectInfo = {
  CheckpointLoaderSimple: n({ ckpt_name: [['sd15.safetensors']] }, ['MODEL', 'CLIP', 'VAE']),
  CLIPTextEncode: n({ text: ['STRING', {}], clip: ['CLIP'] }, ['CONDITIONING']),
  EmptyLatentImage: n({ width: ['INT', {}], height: ['INT', {}], batch_size: ['INT', {}] }, ['LATENT']),
  KSampler: n({ model: ['MODEL'], positive: ['CONDITIONING'], negative: ['CONDITIONING'], latent_image: ['LATENT'], seed: ['INT', {}], steps: ['INT', {}], cfg: ['FLOAT', {}], sampler_name: [['euler']], scheduler: [['normal']], denoise: ['FLOAT', {}] }, ['LATENT']),
  VAEDecode: n({ samples: ['LATENT'], vae: ['VAE'] }, ['IMAGE']),
  SaveImage: n({ images: ['IMAGE'], filename_prefix: ['STRING', {}] }, []),
  LoadImage: n({ image: [['a.png'], { image_upload: true }] }, ['IMAGE', 'MASK']),
  ImageScale: n({ image: ['IMAGE'], upscale_method: [['bilinear']], width: ['INT', {}], height: ['INT', {}], crop: [['disabled']] }, ['IMAGE']),
  VAEEncode: n({ pixels: ['IMAGE'], vae: ['VAE'] }, ['LATENT']),
  FluxProUltraImageNode: n({ prompt: ['STRING', {}], prompt_upsampling: ['BOOLEAN', {}], seed: ['INT', {}], aspect_ratio: ['STRING', {}], raw: ['BOOLEAN', {}] }, ['IMAGE'], { api_node: true, python_module: 'comfy_api_nodes.nodes_bfl' }),
};

function mockBackend(log) {
  return input => ({
    snapshot: backendSnapshot(input),
    async inspect() { log.push('inspect'); return { objectInfo: structuredClone(log.objectInfo || objectInfo) }; },
    async upload(bytes, o) { log.push('upload:' + bytes.length); return { value: `previs/${o.filename}` }; },
    async submit(req) { log.push('submit'); log.graph = req.graph; if (log.submitError) throw log.submitError(); if (log.failSubmit) throw Error('socket hang up'); return { promptId: 'p-' + req.requestId.slice(0, 8) }; },
    async history() { log.push('history'); if (log.historyError) return { status: { status_str: 'error', completed: false }, error: log.historyError }; return log.done ? { status: { completed: true, status_str: 'success' }, outputs: log.outputs || { 7: { images: [{ filename: 'a.png', subfolder: '', type: 'output' }, { filename: 'b.png', subfolder: '', type: 'output' }] } } } : null; },
    async view() { log.push('view'); return log.view ? log.view() : PNG; },
  });
}

async function setup(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'previs-refgen-'));
  const director = await openDirector(root);
  const project = await director.create({ template: 'street' });
  const log = [];
  const refgen = await openRefgen(root, director, { backend: mockBackend(log), allowPaid: false, ...options });
  const runner = project.scene.entities.find(e => e.name === 'Runner');
  return { root, director, project, refgen, log, runner };
}

test('local generation: quote is free, approval required, results attach as primary look', async () => {
  const { director, project, refgen, log, runner } = await setup();
  const base = { projectId: project.id, entityId: runner.id, presetId: 'local-checkpoint', prompt: lookPrompt(project, runner), aspect: '3:4', count: 2, seed: 7 };
  await assert.rejects(refgen.prepare(base), /Choose an installed checkpoint: sd15/);
  const job = await refgen.prepare({ ...base, checkpoint: 'sd15.safetensors' });
  assert.equal(job.status, 'quoted'); assert.equal(job.quote.status, 'known'); assert.equal(job.quote.amount, 0);
  assert.equal(job.graph[4].inputs.batch_size, 2);
  assert.ok(!log.includes('submit'), 'quoting sends nothing');
  await assert.rejects(refgen.submit({ projectId: project.id, requestId: job.id, approval: { approved: true, fingerprint: 'other', allowance: { currency: 'USD', maxAmount: 0 } } }), /approval must match/);
  const sent = await refgen.submit({ projectId: project.id, requestId: job.id, approval: { approved: true, fingerprint: job.fingerprint, allowance: { currency: 'USD', maxAmount: 0 } } });
  assert.equal(sent.status, 'submitted');
  assert.equal((await refgen.submit({ projectId: project.id, requestId: job.id, approval: {} })).status, 'submitted', 'a sent request is never resent');
  assert.equal(log.filter(x => x === 'submit').length, 1);
  assert.equal((await refgen.track({ projectId: project.id, requestId: job.id })).status, 'submitted');
  log.done = true;
  const done = await refgen.track({ projectId: project.id, requestId: job.id });
  assert.equal(done.status, 'completed'); assert.equal(done.referenceIds.length, 2);
  const p = await director.get(project.id);
  const looks = objectLooks(p, runner.id);
  assert.equal(looks.length, 2); assert.equal(p.scene.entities.find(e => e.id === runner.id).look, looks[0].id);
  assert.equal(looks[0].generated.seed, 7); assert.equal(looks[0].generated.presetId, 'local-checkpoint');
  assert.match(compilePrompt(p, p.shots[0]), /Runner \(character\) — match reference “Runner · Local ComfyUI/);
});

test('cloud generation stays quote-only unless paid execution is enabled', async () => {
  const { project, refgen, log, runner } = await setup();
  const job = await refgen.prepare({ projectId: project.id, entityId: runner.id, presetId: 'flux-ultra', prompt: 'a runner', count: 2 });
  assert.equal(job.quote.status, 'unknown'); assert.equal(job.quote.credits, 25.32); assert.ok(job.quote.estimate > 0.1 && job.quote.estimate < 0.13);
  assert.equal(job.partnerNodes, true);
  await assert.rejects(refgen.submit({ projectId: project.id, requestId: job.id, approval: { approved: true, fingerprint: job.fingerprint, allowance: { currency: 'USD', maxAmount: 1, allowUnknownCharges: true } } }), /disabled on this server/);
  assert.ok(!log.includes('submit'));
});

test('paid submission needs unknown-charge consent; uncertain dispatch is never resent; schema drift invalidates', async () => {
  const { project, refgen, log, runner } = await setup({ allowPaid: true, slots: createSlots({ env: { PREVIS_LIMIT_CLOUD_IMAGES: '1' } }) });
  const job = await refgen.prepare({ projectId: project.id, entityId: runner.id, presetId: 'flux-ultra', prompt: 'a runner' });
  await assert.rejects(refgen.submit({ projectId: project.id, requestId: job.id, approval: { approved: true, fingerprint: job.fingerprint, allowance: { currency: 'USD', maxAmount: 1 } } }), /allowUnknownCharges/);
  log.failSubmit = true;
  const uncertain = await refgen.submit({ projectId: project.id, requestId: job.id, approval: { approved: true, fingerprint: job.fingerprint, allowance: { currency: 'USD', maxAmount: 1, allowUnknownCharges: true } } });
  assert.equal(uncertain.status, 'uncertain');
  const second = await refgen.prepare({ projectId: project.id, entityId: runner.id, presetId: 'flux-ultra', prompt: 'another' });
  await assert.rejects(refgen.submit({ projectId: project.id, requestId: second.id, approval: { approved: true, fingerprint: second.fingerprint, allowance: { currency: 'USD', maxAmount: 1, allowUnknownCharges: true } } }), e => e.status === 409 && e.apiCode === 'busy' && /1 of 1 cloud image slot in use/.test(e.message), 'an uncertain request holds its slot');
  assert.equal(log.filter(x => x === 'submit').length, 1);

  const fresh = await setup({ allowPaid: true });
  const q = await fresh.refgen.prepare({ projectId: fresh.project.id, entityId: fresh.runner.id, presetId: 'flux-ultra', prompt: 'x' });
  fresh.log.objectInfo = { ...objectInfo, FluxProUltraImageNode: { ...objectInfo.FluxProUltraImageNode, input: { required: { ...objectInfo.FluxProUltraImageNode.input.required, extra: ['INT', {}] } } } };
  await assert.rejects(fresh.refgen.submit({ projectId: fresh.project.id, requestId: q.id, approval: { approved: true, fingerprint: q.fingerprint, allowance: { currency: 'USD', maxAmount: 1, allowUnknownCharges: true } } }), /Quote changed/);
  assert.ok(!fresh.log.includes('submit'));
});

test('presets build schema-shaped graphs with one save per request', () => {
  for (const p of imagePresets) {
    const g = p.build({ prompt: 'x', aspect: '1:1', count: 3, seed: 1, checkpoint: 'c' });
    assert.ok(Object.values(g).some(node => node.class_type === 'SaveImage'), p.id);
  }
  assert.equal(Object.values(imagePresets[0].build({ prompt: 'x', aspect: '1:1', count: 3, seed: 1 })).filter(x => x.class_type === 'FluxProUltraImageNode').length, 3);
});

test('every Cloud image preset validates against the live schema with the guide and its maximum references', () => {
  const refInput = i => ({ nodeId: `${200 + i}`, input: 'image', kind: 'image', mime: 'image/png', filename: `previs-ref-${i}.png` });
  const cloud = imagePresets.filter(p => p.backend === 'cloud');
  assert.deepEqual(cloud.map(p => p.id), ['flux-ultra', 'flux-3', 'flux-2-pro', 'flux-2-max', 'gpt-image-25', 'seedream-5-pro', 'nano-banana-pro', 'nano-banana-2-1', 'nano-banana-2']);
  for (const p of cloud) {
    assert.ok(liveInfo[p.node], `${p.node} in the captured schema`);
    for (const [guide, refs] of [[false, 0], [true, 0], [true, p.maxRefs || 0], [false, p.maxRefs || 0]]) {
      const graph = p.build({ prompt: 'x', aspect: guide ? '16:9' : '3:4', count: 2, seed: 1, guide, refs });
      const v = validateGraph(graph, liveInfo, { deferredInputs: [...(guide ? [GUIDE_INPUT] : []), ...Array.from({ length: refs }, (_, i) => refInput(i + 1))] });
      assert.ok(v.compatible, `${p.id} guide=${guide} refs=${refs}: ${JSON.stringify(v.issues.slice(0, 2))}`);
      // Every image loader feeds the model: the guide first, then the references in order.
      const loaders = Object.entries(graph).filter(([, n]) => n.class_type === 'LoadImage').map(([id]) => id);
      assert.deepEqual(loaders, [...(guide ? ['100'] : []), ...Array.from({ length: refs }, (_, i) => `${201 + i}`)].sort(), p.id);
      const fed = new Set(Object.values(graph).flatMap(n => Object.values(n.inputs)).filter(x => Array.isArray(x)).map(x => x[0]));
      assert.ok(loaders.every(id => fed.has(id)), `${p.id}: every loaded image is wired in`);
    }
    if (p.maxRefs) assert.equal(IMAGE_PRICES[p.id], p.pricing.usdPerImage, `${p.id} has a batch price`);
  }
  // Nano Banana Pro takes one IMAGE input: guide + references are padded to one size and batched in order.
  const pro = imagePresets.find(p => p.id === 'nano-banana-pro').build({ prompt: 'x', aspect: '16:9', count: 1, seed: 1, guide: true, refs: 2 });
  assert.deepEqual(pro[399].inputs, { 'images.image0': ['301', 0], 'images.image1': ['302', 0], 'images.image2': ['303', 0] });
  assert.deepEqual([pro[301].inputs.image, pro[302].inputs.image, pro[303].inputs.image, pro[301].inputs.target_width, pro[301].inputs.target_height], [['100', 0], ['201', 0], ['202', 0], 1344, 768]);
  assert.deepEqual(pro[1].inputs.images, ['399', 0]);
  const nb21 = imagePresets.find(p => p.id === 'nano-banana-2-1').build({ prompt: 'x', aspect: '16:9', count: 1, seed: 1, guide: true, refs: 2 })[1].inputs;
  assert.deepEqual([nb21['model.images.image_1'], nb21['model.images.image_2'], nb21['model.images.image_3']], [['100', 0], ['201', 0], ['202', 0]]);
});

// A small valid RGB PNG (references are normalised through ffmpeg).
function rgbPng(width = 32, height = 32, color = 90) {
  const chunk = (kind, bytes) => {
    const body = Buffer.concat([Buffer.from(kind), bytes]); let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const len = Buffer.alloc(4), sum = Buffer.alloc(4); len.writeUInt32BE(bytes.length); sum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, body, sum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc(height * (width * 3 + 1), color); for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
test('Nano Banana Pro and 2.1 take cast references on the single-request route; FLUX Ultra still refuses them', async () => {
  const { director, project, refgen, log, runner } = await setup({ allowPaid: true });
  log.objectInfo = liveInfo;
  const looks = [];
  for (const n of [1, 2]) looks.push((await director.reference(project.id, { scope: 'object', entityId: runner.id, name: `Runner look ${n}`, data: rgbPng(32, 32, 40 * n).toString('base64') })).referenceId);
  const shot = project.shots[0], base = { projectId: project.id, target: 'shot', shotId: shot.id, prompt: 'Image 1 is the blockout; the runner looks like images 2 and 3.', aspect: '16:9', count: 1, seed: 3, referenceIds: looks, guide: PNG.toString('base64') };
  for (const presetId of ['nano-banana-pro', 'nano-banana-2-1', 'gpt-image-25', 'seedream-5-pro', 'flux-2-max']) {
    const job = await refgen.prepare({ ...base, presetId });
    assert.equal(job.refs.length, 2, presetId); assert.equal(job.status, 'quoted');
    // The estimate is the list price plus the three image inputs (the guide and two cast looks); the list price itself is unchanged.
    assert.equal(job.quote.breakdown.listUsd, IMAGE_PRICES[presetId], `${presetId} quotes its list price`);
    assert.equal(job.quote.breakdown.refs, 3, presetId);
    assert.equal(job.quote.estimate, Math.round((IMAGE_PRICES[presetId] + referenceUsd(presetId, 3)) * 10000) / 10000, `${presetId} estimate = list + references`);
  }
  const pro = await refgen.prepare({ ...base, presetId: 'nano-banana-pro', seed: 4 });
  await refgen.submit({ projectId: project.id, requestId: pro.id, approval: consent(pro) });
  assert.deepEqual([log.graph[100].inputs.image, log.graph[201].inputs.image, log.graph[202].inputs.image], [`previs/${pro.id}-guide.png`, `previs/${pro.id}-ref1.png`, `previs/${pro.id}-ref2.png`]);
  assert.equal(log.graph[1].class_type, 'GeminiImage2Node'); assert.deepEqual(log.graph[1].inputs.images, ['399', 0]);
  await assert.rejects(refgen.prepare({ ...base, presetId: 'flux-ultra' }), /can’t take reference images; choose a model that does/);
  await assert.rejects(refgen.prepare({ ...base, presetId: 'flux-2-max', referenceIds: [...looks, ...looks, ...looks, looks[0], looks[1]] }), /at most 7 reference images/);
});

test('shot key frames: blockout guide is quoted, uploaded at submit and attached to the shot', async () => {
  const { director, project, refgen, log } = await setup();
  const shot = project.shots[0];
  const base = { projectId: project.id, target: 'shot', shotId: shot.id, presetId: 'local-checkpoint', checkpoint: 'sd15.safetensors', prompt: 'night street, cinematic', aspect: '16:9', count: 3, seed: 5 };
  await assert.rejects(refgen.prepare({ ...base, guide: Buffer.from('not a png').toString('base64') }), /must be a PNG/);
  const job = await refgen.prepare({ ...base, guide: PNG.toString('base64') });
  assert.equal(job.target, 'shot'); assert.equal(job.count, 1, 'local image-to-image makes one frame');
  assert.ok(job.guide?.sha256); assert.equal(job.graph[100].class_type, 'LoadImage'); assert.equal(job.graph[5].inputs.denoise, 0.6);
  assert.equal(job.quote.status, 'known', 'local img2img stays free');
  assert.ok(!log.some(x => x.startsWith('upload')), 'quoting uploads nothing');
  await refgen.submit({ projectId: project.id, requestId: job.id, approval: { approved: true, fingerprint: job.fingerprint, allowance: { currency: 'USD', maxAmount: 0 } } });
  assert.ok(log.some(x => x === 'upload:' + PNG.length)); assert.equal(log.graph[100].inputs.image, `previs/${job.id}-guide.png`);
  log.done = true;
  const done = await refgen.track({ projectId: project.id, requestId: job.id });
  assert.equal(done.status, 'completed'); assert.match(done.message, /key frame/);
  const p = await director.get(project.id);
  const frames = p.shots[0].references.filter(r => r.role === 'frame');
  assert.equal(frames.length, 2); assert.equal(frames[0].generated.presetId, 'local-checkpoint');
  const { shotSignature, stillStale } = await import('../shared/director.mjs');
  assert.equal(frames[0].generated.signature, shotSignature(p, p.shots[0]), 'a key frame records the blocking it was made from');
  assert.equal(stillStale(p, p.shots[0], frames[0]), false);
  const { compilePrompt } = await import('../shared/director.mjs');
  assert.match(compilePrompt(p, p.shots[0]), /Look: match key frame/);
});

const consent = job => ({ approved: true, fingerprint: job.fingerprint, allowance: { currency: 'USD', maxAmount: 1, allowUnknownCharges: true } });

test('cloud image slots: two concurrent submits fit a limit of 2, the third is busy (409, retryable)', async () => {
  const { project, refgen, log, runner } = await setup({ allowPaid: true, slots: createSlots({ env: { PREVIS_LIMIT_CLOUD_IMAGES: '2' } }) });
  const jobs = [];
  for (const prompt of ['one', 'two', 'three']) jobs.push(await refgen.prepare({ projectId: project.id, entityId: runner.id, presetId: 'flux-ultra', prompt }));
  const sent = await Promise.all(jobs.slice(0, 2).map(job => refgen.submit({ projectId: project.id, requestId: job.id, approval: consent(job) })));
  assert.deepEqual(sent.map(job => job.status), ['submitted', 'submitted']);
  await assert.rejects(refgen.submit({ projectId: project.id, requestId: jobs[2].id, approval: consent(jobs[2]) }),
    e => e.status === 409 && e.apiCode === 'busy' && e.retryAfterSeconds === 15 && e.message === 'Backend busy: 2 of 2 cloud image slots in use; retry when a job finishes');
  assert.equal(log.filter(x => x === 'submit').length, 2);
  assert.equal(refgen.list(project.id).find(j => j.id === jobs[2].id).status, 'quoted', 'a busy refusal leaves the quote untouched');
});

test('rejected dispatch persists redacted failure.detail and never the key; provider errors surface on track', async t => {
  const secret = 'test-cloud-key-' + 'z'.repeat(20), previous = process.env.COMFY_CLOUD_API_KEY;
  process.env.COMFY_CLOUD_API_KEY = secret;
  t.after(() => { if (previous === undefined) delete process.env.COMFY_CLOUD_API_KEY; else process.env.COMFY_CLOUD_API_KEY = previous; });
  const { root, project, refgen, log, runner } = await setup({ allowPaid: true });
  log.submitError = () => Object.assign(Error('Backend /prompt returned HTTP 400'), { httpStatus: 400, detail: `{"error":"invalid prompt","extra_data":{"api_key_comfy_org":"${secret}"}}` });
  const job = await refgen.prepare({ projectId: project.id, entityId: runner.id, presetId: 'flux-ultra', prompt: 'a runner' });
  const failed = await refgen.submit({ projectId: project.id, requestId: job.id, approval: consent(job) });
  assert.equal(failed.status, 'failed', 'a 400 rejection never ran, so it frees the slot');
  assert.equal(failed.failure.phase, 'dispatch'); assert.equal(failed.failure.httpStatus, 400);
  assert.match(failed.failure.detail, /invalid prompt/); assert.ok(failed.failure.detail.length <= 500);
  const receipt = await readFile(join(root, 'director', project.id, 'refgen', job.id + '.json'), 'utf8');
  assert.equal(receipt.includes(secret), false); assert.equal(JSON.stringify(failed).includes(secret), false);
  log.submitError = null;
  log.historyError = { nodeId: '1', nodeType: 'FluxProUltraImageNode', message: 'Server side error' };
  const other = await refgen.prepare({ projectId: project.id, entityId: runner.id, presetId: 'flux-ultra', prompt: 'again' });
  await refgen.submit({ projectId: project.id, requestId: other.id, approval: consent(other) });
  const tracked = await refgen.track({ projectId: project.id, requestId: other.id });
  assert.equal(tracked.status, 'failed'); assert.deepEqual(tracked.provider, { status: 'error', error: log.historyError });
  assert.match(tracked.failure.detail, /FluxProUltraImageNode: Server side error/); assert.match(tracked.message, /Server side error/);
});

test('upload cache: identical guide bytes are uploaded once per Cloud backend', async () => {
  const { project, refgen, log } = await setup({ allowPaid: true });
  const ultra = objectInfo.FluxProUltraImageNode;
  log.objectInfo = { ...objectInfo, FluxProUltraImageNode: { ...ultra, input: { ...ultra.input, optional: { image_prompt: ['IMAGE'], image_prompt_strength: ['FLOAT', {}] } } } };
  const base = { projectId: project.id, target: 'shot', shotId: project.shots[0].id, presetId: 'flux-ultra', prompt: 'night street', aspect: '16:9', guide: PNG.toString('base64') };
  const first = await refgen.prepare({ ...base, seed: 1 }), second = await refgen.prepare({ ...base, seed: 2 });
  await refgen.submit({ projectId: project.id, requestId: first.id, approval: consent(first) });
  const value = log.graph[100].inputs.image;
  await refgen.submit({ projectId: project.id, requestId: second.id, approval: consent(second) });
  assert.equal(log.filter(x => x.startsWith('upload')).length, 1);
  assert.equal(log.graph[100].inputs.image, value, 'the second request reuses the stored Cloud input');
});

test('job tracker drives refgen to completion; the track route keeps its shape and records attempts', async () => {
  const { project, refgen, log, runner } = await setup();
  let t = Date.parse('2026-10-30T12:00:00Z');
  const tracker = createJobTracker({ sources: [refgen.trackerSource()], now: () => t, tickMs: 0 });
  refgen.useTracker(tracker); tracker.start();
  const job = await refgen.prepare({ projectId: project.id, entityId: runner.id, presetId: 'local-checkpoint', checkpoint: 'sd15.safetensors', prompt: 'a runner', seed: 3 });
  await refgen.submit({ projectId: project.id, requestId: job.id, approval: { approved: true, fingerprint: job.fingerprint, allowance: { currency: 'USD', maxAmount: 0 } } });
  const viaRoute = await refgen.track({ projectId: project.id, requestId: job.id });
  assert.equal(viaRoute.status, 'submitted'); assert.equal(viaRoute.tracking.trackCount, 1);
  await assert.rejects(refgen.track({ projectId: 'other', requestId: job.id }), /Unknown request/);
  log.done = true;
  t += 8000; await tracker.tick();
  const [row] = tracker.snapshot().jobs;
  assert.equal(row.status, 'completed'); assert.equal(row.source, 'refgen'); assert.equal(row.kind, 'image'); assert.equal(row.trackCount, 2);
  assert.equal(row.results.length, 2, 'the mock backend returns two images'); assert.match(row.results[0].url, new RegExp(`^/director-refs/${project.id}/[a-f0-9-]{36}\\.png$`));
  assert.match(row.label, /Runner · Local ComfyUI/);
});

test('refgen restart distinguishes an interrupted upload from an uncertain dispatch without resubmitting', async () => {
  const { writeFile } = await import('node:fs/promises');
  const { root, director, project, refgen, log, runner } = await setup();
  const input = { projectId: project.id, entityId: runner.id, presetId: 'local-checkpoint', checkpoint: 'sd15.safetensors', prompt: 'runner', seed: 7 };
  const upload = await refgen.prepare(input), dispatch = await refgen.prepare(input);
  const file = job => join(root, 'director', project.id, 'refgen', job.id + '.json');
  await writeFile(file(upload), JSON.stringify({ ...upload, status: 'uploading' }));
  await writeFile(file(dispatch), JSON.stringify({ ...dispatch, status: 'submitting' }));
  const reopened = await openRefgen(root, director, { backend: mockBackend(log), allowPaid: false });
  assert.equal(reopened.all().find(j => j.id === upload.id).status, 'quoted');
  assert.equal(reopened.all().find(j => j.id === dispatch.id).status, 'uncertain');
  assert.equal(log.filter(x => x === 'submit').length, 0);
  const tracker = createJobTracker({ sources: [reopened.trackerSource()], tickMs: 0 });
  tracker.start(); await tracker.tick();
  assert.equal(tracker.snapshot().tracker.resumed, 1); tracker.stop();
  assert.equal(log.filter(x => x === 'submit').length, 0);
});

test('refgen refuses concurrent identical requests before a second backend submit', async () => {
  const { project, refgen, log, runner } = await setup();
  const input = { projectId: project.id, entityId: runner.id, presetId: 'local-checkpoint', checkpoint: 'sd15.safetensors', prompt: 'runner', seed: 7 };
  const a = await refgen.prepare(input), b = await refgen.prepare(input);
  const submit = j => refgen.submit({ projectId: project.id, requestId: j.id, approval: { approved: true, fingerprint: j.fingerprint, allowance: { currency: 'USD', maxAmount: 0 } } });
  await submit(a); await assert.rejects(submit(b), e => e.apiCode === 'duplicate' && e.existingId === a.id);
  assert.equal(log.filter(x => x === 'submit').length, 1);
});

test('refgen recovers partial transfers from durable outputs without history or duplicate references', async () => {
  const { root, director, project, refgen, log, runner } = await setup();
  const job = await refgen.prepare({ projectId: project.id, entityId: runner.id, presetId: 'local-checkpoint', checkpoint: 'sd15.safetensors', prompt: 'runner', seed: 7 });
  await refgen.submit({ projectId: project.id, requestId: job.id, approval: { approved: true, fingerprint: job.fingerprint, allowance: { currency: 'USD', maxAmount: 0 } } });
  log.done = true;
  let views = 0;
  const backend = input => ({ ...mockBackend(log)(input), view: async () => { if (++views === 2) throw Error('fixture transfer failure'); return PNG; } });
  let resumed = await openRefgen(root, director, { backend, allowPaid: false });
  const partial = await resumed.track({ projectId: project.id, requestId: job.id });
  assert.equal(partial.status, 'collecting'); assert.equal(partial.results.length, 1);
  const firstId = partial.referenceIds[0];
  resumed = await openRefgen(root, director, { backend: input => ({ ...backend(input), history: async () => { throw Error('History expired'); } }), allowPaid: false });
  const done = await resumed.track({ projectId: project.id, requestId: job.id });
  assert.equal(done.status, 'completed'); assert.equal(done.referenceIds.length, 2); assert.equal(done.referenceIds[0], firstId);
  assert.equal(views, 3); assert.equal(log.filter(x => x === 'submit').length, 1);
  assert.equal((await director.get(project.id)).scene.references.filter(r => r.generated?.requestId === job.id).length, 2);
});

test('refgen reuses an already imported output after attachment acknowledgement loss', async () => {
  const { root, director, project, refgen, log, runner } = await setup();
  const job = await refgen.prepare({ projectId: project.id, entityId: runner.id, presetId: 'local-checkpoint', checkpoint: 'sd15.safetensors', prompt: 'runner', seed: 8 });
  await refgen.submit({ projectId: project.id, requestId: job.id, approval: { approved: true, fingerprint: job.fingerprint, allowance: { currency: 'USD', maxAmount: 0 } } });
  log.done = true;
  const interrupted = { ...director, reference: async (...args) => { await director.reference(...args); throw Error('fixture crash after import'); } };
  let resumed = await openRefgen(root, interrupted, { backend: mockBackend(log), allowPaid: false });
  const failed = await resumed.track({ projectId: project.id, requestId: job.id });
  assert.equal(failed.status, 'collecting'); assert.equal(failed.results, undefined);
  const imported = (await director.get(project.id)).scene.references.find(r => r.generated?.requestId === job.id);
  resumed = await openRefgen(root, director, { backend: mockBackend(log), allowPaid: false });
  const done = await resumed.track({ projectId: project.id, requestId: job.id });
  assert.equal(done.status, 'completed'); assert.ok(done.referenceIds.includes(imported.id));
  assert.equal(log.filter(x => x === 'view').length, 2, 'already imported output is not downloaded again');
  assert.equal(log.filter(x => x === 'submit').length, 1);
  const refs = (await director.get(project.id)).scene.references.filter(r => r.generated?.requestId === job.id);
  assert.equal(refs.length, 2); assert.equal(new Set(refs.map(r => r.generated.outputKey)).size, 2);
  const duplicate = await director.reference(project.id, { scope: 'object', entityId: runner.id, generated: imported.generated, data: PNG.toString('base64') });
  assert.equal(duplicate.referenceId, imported.id);
});

test('legacy partial imports without output keys stop safely rather than duplicate assets', async () => {
  const { director, project, refgen, log, runner } = await setup();
  const job = await refgen.prepare({ projectId: project.id, entityId: runner.id, presetId: 'local-checkpoint', checkpoint: 'sd15.safetensors', prompt: 'runner', seed: 9 });
  await refgen.submit({ projectId: project.id, requestId: job.id, approval: { approved: true, fingerprint: job.fingerprint, allowance: { currency: 'USD', maxAmount: 0 } } });
  await director.reference(project.id, { scope: 'object', entityId: runner.id, data: PNG.toString('base64'), generated: { requestId: job.id } });
  log.done = true;
  assert.equal((await refgen.track({ projectId: project.id, requestId: job.id })).status, 'recovery-required');
  assert.equal(log.filter(x => x === 'view').length, 0); assert.equal(log.filter(x => x === 'submit').length, 1);
  assert.equal((await director.get(project.id)).scene.references.filter(r => r.generated?.requestId === job.id).length, 1);
});

test('refgen collection attempts remain bounded across restart', async () => {
  const { root, director, project, refgen, log, runner } = await setup();
  const job = await refgen.prepare({ projectId: project.id, entityId: runner.id, presetId: 'local-checkpoint', checkpoint: 'sd15.safetensors', prompt: 'runner', seed: 10 });
  await refgen.submit({ projectId: project.id, requestId: job.id, approval: { approved: true, fingerprint: job.fingerprint, allowance: { currency: 'USD', maxAmount: 0 } } });
  log.done = true; let views = 0;
  const backend = input => ({ ...mockBackend(log)(input), view: async () => { views++; throw Error('fixture transfer unavailable'); } });
  for (let i = 0; i < 5; i++) {
    const resumed = await openRefgen(root, director, { backend, allowPaid: false });
    const result = await resumed.track({ projectId: project.id, requestId: job.id });
    assert.equal(result.status, i < 2 ? 'collecting' : 'recovery-required');
  }
  assert.equal(views, 3); assert.equal(log.filter(x => x === 'submit').length, 1);
});

test('refgen: a stalled /view for one job never delays another job\'s submit; concurrent identical submits still send once', async () => {
  const { project, refgen, log, runner } = await setup({ allowPaid: true, slots: createSlots({ env: { PREVIS_LIMIT_CLOUD_IMAGES: '4' } }) });
  let release, viewing; const stalled = new Promise(r => { release = r; }), started = new Promise(r => { viewing = r; });
  const a = await refgen.prepare({ projectId: project.id, entityId: runner.id, presetId: 'local-checkpoint', checkpoint: 'sd15.safetensors', prompt: 'one', seed: 1 });
  await refgen.submit({ projectId: project.id, requestId: a.id, approval: { approved: true, fingerprint: a.fingerprint, allowance: { currency: 'USD', maxAmount: 0 } } });
  log.done = true; log.view = async () => { viewing(); await stalled; return PNG; };
  const tracking = refgen.trackerSource().track(a.id); // the tracker's path
  await started;
  const b = await refgen.prepare({ projectId: project.id, entityId: runner.id, presetId: 'flux-ultra', prompt: 'two' });
  const t0 = Date.now(), sent = await refgen.submit({ projectId: project.id, requestId: b.id, approval: consent(b) });
  assert.equal(sent.status, 'submitted'); assert.ok(Date.now() - t0 < 1000);
  assert.equal(refgen.list(project.id).find(j => j.id === a.id).status, 'collecting');
  log.view = null; release();
  assert.equal((await tracking).status, 'completed');
  // Two different request ids for identical work, submitted at the same moment: one is sent, one is refused.
  const input = { projectId: project.id, entityId: runner.id, presetId: 'flux-ultra', prompt: 'same', seed: 3 };
  const [c, d] = [await refgen.prepare(input), await refgen.prepare(input)];
  const results = await Promise.allSettled([c, d].map(j => refgen.submit({ projectId: project.id, requestId: j.id, approval: consent(j) })));
  assert.deepEqual(results.map(r => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(results.find(r => r.status === 'rejected').reason.apiCode, 'duplicate');
  assert.equal(log.filter(x => x === 'submit').length, 3);
});

test('budget: a paid image reserves before dispatch, settles on completion, and is refused over the cap with nothing sent', async () => {
  const { openBudget } = await import('../server/previs/budget.mjs');
  const root = await mkdtemp(join(tmpdir(), 'previs-refgen-budget-'));
  const budget = await openBudget(join(root, 'budget'), { env: { PREVIS_BUDGET_PROJECT_CAP_USD: '0.1' } });
  const { project, refgen, log, runner } = await setup({ allowPaid: true, budget });
  const approve = job => ({ approved: true, fingerprint: job.fingerprint, allowance: { currency: 'USD', maxAmount: 1, allowUnknownCharges: true } });
  const job = await refgen.prepare({ projectId: project.id, entityId: runner.id, presetId: 'flux-ultra', prompt: 'a runner' });
  const sent = await refgen.submit({ projectId: project.id, requestId: job.id, approval: approve(job) });
  assert.equal(sent.status, 'submitted');
  assert.equal(budget.get(job.id).state, 'reserved'); assert.equal(budget.get(job.id).estimateUsd, job.quote.estimate);
  // A second image would cross the $0.10 project cap: refused before upload or dispatch, the draft stays quoted.
  const second = await refgen.prepare({ projectId: project.id, entityId: runner.id, presetId: 'flux-ultra', prompt: 'another runner' });
  const uploads = log.filter(x => x.startsWith('upload')).length;
  await assert.rejects(refgen.submit({ projectId: project.id, requestId: second.id, approval: approve(second) }), e => e.status === 402 && e.apiCode === 'budget' && /Project budget cap reached/.test(e.message));
  assert.equal(log.filter(x => x === 'submit').length, 1); assert.equal(log.filter(x => x.startsWith('upload')).length, uploads);
  assert.equal(refgen.list(project.id).find(j => j.id === second.id).status, 'quoted');
  log.done = true; log.outputs = { 2: { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } }; // FLUX Ultra saves at node 2
  assert.equal((await refgen.track({ projectId: project.id, requestId: job.id })).status, 'completed');
  assert.equal(budget.get(job.id).state, 'settled'); assert.equal(budget.status(project.id).project.spentUsd, job.quote.estimate);
});

test('budget: a backend rejection before it ran releases the reservation; an execution failure keeps it held', async () => {
  const { openBudget } = await import('../server/previs/budget.mjs');
  const root = await mkdtemp(join(tmpdir(), 'previs-refgen-budget-'));
  const budget = await openBudget(join(root, 'budget'), { env: {} });
  const { project, refgen, log, runner } = await setup({ allowPaid: true, budget });
  const approve = job => ({ approved: true, fingerprint: job.fingerprint, allowance: { currency: 'USD', maxAmount: 1, allowUnknownCharges: true } });
  log.submitError = () => Object.assign(Error('Payment required'), { httpStatus: 402 });
  const rejected = await refgen.prepare({ projectId: project.id, entityId: runner.id, presetId: 'flux-ultra', prompt: 'a runner' });
  assert.equal((await refgen.submit({ projectId: project.id, requestId: rejected.id, approval: approve(rejected) })).status, 'failed');
  assert.equal(budget.get(rejected.id).state, 'released');
  log.submitError = null; log.historyError = { nodeType: 'FluxProUltraImageNode', message: 'Server side error' };
  const ran = await refgen.prepare({ projectId: project.id, entityId: runner.id, presetId: 'flux-ultra', prompt: 'another' });
  await refgen.submit({ projectId: project.id, requestId: ran.id, approval: approve(ran) });
  assert.equal((await refgen.track({ projectId: project.id, requestId: ran.id })).status, 'failed');
  assert.equal(budget.get(ran.id).state, 'held');
});

// ---- Budget v2: grader, references and refusals are counted (2026-10-31 regeneration overran its cap by $1.84) ----
const keyFrame = (project, presetId, extra = {}) => ({ projectId: project.id, target: 'shot', shotId: project.shots[0].id, frameAt: 'start', presetId, prompt: 'Image 1 is the blockout.', aspect: '16:9', count: 1, seed: 5, guide: PNG.toString('base64'), ...extra });
const approveAll = job => ({ approved: true, fingerprint: job.fingerprint, allowance: { currency: 'USD', maxAmount: 1, allowUnknownCharges: true } });
const saveNode = job => Object.entries(job.graph).find(([, x]) => x.class_type === 'SaveImage')[0];

test('budget v2: with the paid grader on, a key-frame quote and reservation include the grade, and it settles for the grades it asked for', async () => {
  const { openBudget } = await import('../server/previs/budget.mjs');
  const root = await mkdtemp(join(tmpdir(), 'previs-refgen-grader-'));
  const budget = await openBudget(join(root, 'budget'), { env: {} }); // 10% margin
  const log = []; log.objectInfo = liveInfo;
  const graderIds = new Set(), base = mockBackend(log);
  const backend = input => { const b = base(input); return { ...b,
    async submit(req) { const r = await b.submit(req); if (req.graph[3]?.class_type === 'GeminiNodeV3') { graderIds.add(r.promptId); log.push('grade'); } return r; },
    async history(id) { return graderIds.has(id) ? { status: { completed: true, status_str: 'success' }, outputs: { 4: { text: ['{"camera":8,"layout":8,"headings":8,"score":8,"why":"close"}'] } } } : b.history(id); } }; };
  const { project, refgen } = await (async () => { const director = await openDirector(root), project = await director.create({ template: 'street' }); return { project, refgen: await openRefgen(root, director, { backend, allowPaid: true, budget, grader: 'gemini' }) }; })();
  assert.equal(refgen.graderOn(), true);
  const job = await refgen.prepare(keyFrame(project, 'flux-2-pro'));
  // list $0.028 + the guide as one reference image ($0.017) + one grade ($0.05)
  assert.deepEqual({ ...job.quote.breakdown }, { listUsd: 0.028, refsUsd: 0.017, graderUsd: 0.05, expectedUsd: 0.095, marginPct: 10, marginUsd: 0.0095, reserveUsd: 0.1045, refs: 1, grades: 1 });
  assert.equal(job.quote.estimate, 0.095); assert.match(job.quote.label, /list \$0\.028 \+ 1 reference image \$0\.017 \+ grader \$0\.050/);
  assert.equal(job.quote.credits, Math.round(6 * 100) / 100, 'credits stay the list price');
  await refgen.submit({ projectId: project.id, requestId: job.id, approval: approveAll(job) });
  assert.equal(budget.get(job.id).reserveMicros, 104500); assert.equal(budget.get(job.id).components.graderUsd, 0.05);
  log.done = true; log.outputs = { [saveNode(job)]: { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } };
  const done = await refgen.track({ projectId: project.id, requestId: job.id });
  assert.equal(done.status, 'completed'); assert.equal(done.graderCalls, 1); assert.equal(log.filter(x => x === 'grade').length, 1);
  assert.equal(budget.list().filter(r => r.source === 'grader').length, 0, 'the grade rides on the still’s own reservation, not a second one');
  const settled = budget.get(job.id);
  assert.equal(settled.state, 'settled'); assert.equal(settled.costMicros, 95000, 'settled at list + reference + grade, without the margin');
  // Grader off: the same key frame quotes without it.
  const off = await openRefgen(root, await openDirector(root), { backend, allowPaid: true, budget, grader: 'off' });
  assert.equal((await off.prepare(keyFrame(project, 'flux-2-pro', { seed: 6 }))).quote.breakdown.graderUsd, 0);
});

test('budget v2: a key frame the grader cannot be afforded for is refused up front, and the refusal carries the breakdown', async () => {
  const { openBudget } = await import('../server/previs/budget.mjs');
  const root = await mkdtemp(join(tmpdir(), 'previs-refgen-grader-'));
  const budget = await openBudget(join(root, 'budget'), { env: { PREVIS_BUDGET_PROJECT_CAP_USD: '0.1' } }); // list + reference alone ($0.045) fits; with the grade and margin ($0.1045) it does not
  const { project, refgen, log } = await setup({ allowPaid: true, budget, grader: 'gemini' }); log.objectInfo = liveInfo;
  const job = await refgen.prepare(keyFrame(project, 'flux-2-pro'));
  await assert.rejects(refgen.submit({ projectId: project.id, requestId: job.id, approval: approveAll(job) }), e => {
    assert.equal(e.apiCode, 'budget'); assert.match(e.message, /\(list \$0\.03 \+ references \$0\.02 \+ grader \$0\.05 \+ 10% margin \$0\.01\)/);
    assert.deepEqual(e.breakdown, { listUsd: 0.028, refsUsd: 0.017, graderUsd: 0.05, expectedUsd: 0.095, marginPct: 10, marginUsd: 0.0095, reserveUsd: 0.1045 }); return true;
  });
  assert.ok(!log.includes('submit'), 'nothing was sent');
});

test('budget v2: a moderated FLUX.2 Pro request settles at its billed amount; a refusal from a model with no known bill stays a hold', async () => {
  const { openBudget } = await import('../server/previs/budget.mjs');
  const root = await mkdtemp(join(tmpdir(), 'previs-refgen-moderation-'));
  const budget = await openBudget(join(root, 'budget'), { env: {} });
  const { project, refgen, log } = await setup({ allowPaid: true, budget }); log.objectInfo = liveInfo;
  const moderated = { nodeType: 'Flux2ImageNode', message: 'Polling aborted due to error: Task failed: {"id": "x", "status": "Request Moderated", "details": {"Moderation Reasons": ["Content Policy Violation"]}}' };
  const pro = await refgen.prepare(keyFrame(project, 'flux-2-pro'));
  await refgen.submit({ projectId: project.id, requestId: pro.id, approval: approveAll(pro) });
  log.historyError = moderated;
  const failed = await refgen.track({ projectId: project.id, requestId: pro.id });
  assert.equal(failed.status, 'failed'); assert.equal(failed.failure.moderated, true); assert.equal(failed.failure.billedUsd, 0.045); // list + the guide; no grader ran
  const r = budget.get(pro.id);
  assert.equal(r.state, 'settled', 'billed, so not a hold that expires and not $0'); assert.equal(r.costMicros, 45000); assert.equal(r.costStatus, 'billed-on-refusal');
  assert.match(r.note, /FLUX\.2 Pro bills a moderated request/);
  assert.equal(budget.status(project.id).project.spentUsd, 0.045);
  // GPT Image 2.5 refused for the same reason: whether it bills is unknown, so the reservation is still held.
  log.historyError = null;
  const gpt = await refgen.prepare(keyFrame(project, 'gpt-image-25', { seed: 9 }));
  await refgen.submit({ projectId: project.id, requestId: gpt.id, approval: approveAll(gpt) });
  log.historyError = { ...moderated, nodeType: 'OpenAIGPTImageNodeV2' };
  const refused = await refgen.track({ projectId: project.id, requestId: gpt.id });
  assert.equal(refused.failure.moderated, true); assert.equal(refused.failure.billedUsd, undefined);
  assert.equal(budget.get(gpt.id).state, 'held');
});
