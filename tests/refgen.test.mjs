import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDirector } from '../server/previs/director.mjs';
import { openRefgen, imagePresets } from '../server/previs/refgen.mjs';
import { backendSnapshot } from '../server/previs/backends.mjs';
import { lookPrompt, compilePrompt, objectLooks } from '../shared/director.mjs';

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
    async submit(req) { log.push('submit'); log.graph = req.graph; if (log.failSubmit) throw Error('socket hang up'); return { promptId: 'p-' + req.requestId.slice(0, 8) }; },
    async history() { log.push('history'); return log.done ? { status: { completed: true, status_str: 'success' }, outputs: { 7: { images: [{ filename: 'a.png', subfolder: '', type: 'output' }, { filename: 'b.png', subfolder: '', type: 'output' }] } } } : null; },
    async view() { log.push('view'); return PNG; },
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
  const { project, refgen, log, runner } = await setup({ allowPaid: true });
  const job = await refgen.prepare({ projectId: project.id, entityId: runner.id, presetId: 'flux-ultra', prompt: 'a runner' });
  await assert.rejects(refgen.submit({ projectId: project.id, requestId: job.id, approval: { approved: true, fingerprint: job.fingerprint, allowance: { currency: 'USD', maxAmount: 1 } } }), /allowUnknownCharges/);
  log.failSubmit = true;
  const uncertain = await refgen.submit({ projectId: project.id, requestId: job.id, approval: { approved: true, fingerprint: job.fingerprint, allowance: { currency: 'USD', maxAmount: 1, allowUnknownCharges: true } } });
  assert.equal(uncertain.status, 'uncertain');
  const second = await refgen.prepare({ projectId: project.id, entityId: runner.id, presetId: 'flux-ultra', prompt: 'another' });
  await assert.rejects(refgen.submit({ projectId: project.id, requestId: second.id, approval: { approved: true, fingerprint: second.fingerprint, allowance: { currency: 'USD', maxAmount: 1, allowUnknownCharges: true } } }), /still running or uncertain/);
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
  const { compilePrompt } = await import('../shared/director.mjs');
  assert.match(compilePrompt(p, p.shots[0]), /Look: match key frame/);
});
