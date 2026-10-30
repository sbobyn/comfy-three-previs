// Reference-image generation for director objects. Every request is quoted from
// live backend schemas, persisted before dispatch, submitted once with explicit
// approval and never retried. Paid/unknown-cost submissions also need
// PREVIS_ALLOW_PAID=1 on the server.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RECOVERY_ATTEMPTS, recoveryAttempts, beginRecovery } from './result-recovery.mjs';
import { atomicJson } from './atomic.mjs';
import { imageToPng } from './edit.mjs';
import { createBackend, errorDetail, safeMediaLocation } from './backends.mjs';
import { keyedLock } from './keyed-lock.mjs';
import { telemetryHooks } from './job-progress.mjs';
import { slotsFor } from './concurrency.mjs';
import { uploadCacheFor } from './upload-cache.mjs';
import { validateGraph, workflowCost, validateApproval, hashValue, assertNoSecrets } from './workflows.mjs';

const uuid = /^[a-f0-9-]{36}$/;
const now = () => new Date().toISOString();
function fail(message, status = 400) { const e = Error(message); e.status = status; throw e; }
// Same credit→USD ratio as the retained Kling preset (26.59 credits = $0.126).
const USD_PER_CREDIT = 0.126 / 26.59;
const SIZES = { '1:1': [512, 512], '3:4': [512, 680], '4:3': [680, 512], '16:9': [768, 432] };
const PRICING = 'https://docs.comfy.org/tutorials/partner-nodes/pricing';

const FLUX2_SIZE = { '1:1': [1024, 1024], '3:4': [768, 1024], '4:3': [1024, 768], '16:9': [1344, 768], '9:16': [768, 1344] };
const save = (images, index) => ({ class_type: 'SaveImage', inputs: { images, filename_prefix: `previs/look-${index}` } });
// Shot key frames use the shot camera's blockout frame as a composition guide (uploaded at submit).
const GUIDE = '100';
const guideNode = () => ({ class_type: 'LoadImage', inputs: { image: 'previs-guide.png' } });
export const GUIDE_INPUT = { nodeId: GUIDE, input: 'image', kind: 'image', mime: 'image/png', filename: 'previs-guide.png' };
// Extra reference images (object looks, the previous key frame) for models that take several images.
const refNode = k => `${200 + k}`;
const refNodes = n => Object.fromEntries(Array.from({ length: n }, (_, i) => [refNode(i + 1), { class_type: 'LoadImage', inputs: { image: `previs-ref-${i + 1}.png` } }]));
const refInputs = n => Array.from({ length: n }, (_, i) => ({ nodeId: refNode(i + 1), input: 'image', kind: 'image', mime: 'image/png', filename: `previs-ref-${i + 1}.png` }));
/** Wire guide + refs into numbered auto-grow slots: `${prefix}1`, `${prefix}2`… (guide first). */
const slots = (prefix, guide, refs) => { const out = {}; let k = 1; if (guide) out[`${prefix}${k++}`] = [GUIDE, 0]; for (let i = 1; i <= refs; i++) out[`${prefix}${k++}`] = [refNode(i), 0]; return out; };
export const imagePresets = [
  {
    id: 'flux-ultra', title: 'Flux 1.1 [pro] Ultra', backend: 'cloud', node: 'FluxProUltraImageNode',
    note: 'Photoreal stills. 12.66 credits per image on Comfy Cloud.',
    pricing: { status: 'estimate', creditsPerImage: 12.66, usdPerImage: Math.round(12.66 * USD_PER_CREDIT * 1000) / 1000, source: PRICING, checkedAt: '2026-10-28' },
    build: ({ prompt, aspect, count, seed, guide }) => {
      const g = guide ? { [GUIDE]: guideNode() } : {};
      for (let i = 0; i < count; i++) { g[`${i * 2 + 1}`] = { class_type: 'FluxProUltraImageNode', inputs: { prompt, prompt_upsampling: false, seed: seed + i, aspect_ratio: aspect, raw: false, ...(guide ? { image_prompt: [GUIDE, 0], image_prompt_strength: 0.35 } : {}) } }; g[`${i * 2 + 2}`] = save([`${i * 2 + 1}`, 0], i); }
      return g;
    },
  },
  {
    id: 'flux-3', title: 'FLUX 3 Image (BFL)', backend: 'cloud', node: 'Flux3ImageNode',
    note: 'BFL’s newest model: strong photoreal detail and prompt following. About 14 credits per 1K image (≈ $0.07).',
    pricing: { status: 'estimate', creditsPerImage: 14, usdPerImage: Math.round(14 * USD_PER_CREDIT * 1000) / 1000, source: 'Comfy Cloud estimate_credits', checkedAt: '2026-10-29' },
    maxRefs: 9,
    build: ({ prompt, aspect, count, seed, guide, refs = 0 }) => {
      const g = { ...(guide ? { [GUIDE]: guideNode() } : {}), ...refNodes(refs) };
      for (let i = 0; i < count; i++) { g[`${i * 2 + 1}`] = { class_type: 'Flux3ImageNode', inputs: { prompt, aspect_ratio: aspect, resolution: '1K', grounding: false, safety_tolerance: 2, seed: seed + i, ...slots('images.image_', guide, refs) } }; g[`${i * 2 + 2}`] = save([`${i * 2 + 1}`, 0], i); }
      return g;
    },
  },
  {
    id: 'flux-2-pro', title: 'Flux.2 [pro] (BFL)', backend: 'cloud', node: 'Flux2ImageNode',
    note: 'Fast, inexpensive BFL model with reference-image support. About 6 credits per image (≈ $0.03).',
    pricing: { status: 'estimate', creditsPerImage: 6, usdPerImage: Math.round(6 * USD_PER_CREDIT * 1000) / 1000, source: 'Comfy Cloud estimate_credits', checkedAt: '2026-10-29' },
    maxRefs: 7,
    build: ({ prompt, aspect, count, seed, guide, refs = 0 }) => {
      const [w, h] = FLUX2_SIZE[aspect] || FLUX2_SIZE['1:1'];
      const g = { ...(guide ? { [GUIDE]: guideNode() } : {}), ...refNodes(refs) };
      for (let i = 0; i < count; i++) { g[`${i * 2 + 1}`] = { class_type: 'Flux2ImageNode', inputs: { prompt, model: 'Flux.2 [pro]', 'model.width': w, 'model.height': h, seed: seed + i, ...slots('model.images.image_', guide, refs) } }; g[`${i * 2 + 2}`] = save([`${i * 2 + 1}`, 0], i); }
      return g;
    },
  },
  {
    id: 'nano-banana-pro', title: 'Nano Banana Pro (Gemini 3 Pro Image)', backend: 'cloud', node: 'GeminiImage2Node',
    note: 'Strong prompt following. Billed per output token, so there is no fixed per-image price.',
    pricing: { status: 'token-based', creditsPerImage: null, usdPerImage: null, rate: '30.38 credits per 1K output tokens', source: PRICING, checkedAt: '2026-10-28' },
    build: ({ prompt, aspect, count, seed, guide }) => {
      const g = guide ? { [GUIDE]: guideNode() } : {};
      for (let i = 0; i < count; i++) { g[`${i * 2 + 1}`] = { class_type: 'GeminiImage2Node', inputs: { prompt, model: 'gemini-3-pro-image-preview', seed: seed + i, aspect_ratio: aspect, resolution: '1K', response_modalities: 'IMAGE', ...(guide ? { images: [GUIDE, 0] } : {}) } }; g[`${i * 2 + 2}`] = save([`${i * 2 + 1}`, 0], i); }
      return g;
    },
  },
  {
    id: 'nano-banana-2-1', title: 'Nano Banana 2.1 (Gemini)', backend: 'cloud', node: 'GeminiNanoBanana2V2',
    note: 'Fast, inexpensive and good at following a guide image. Token-billed: about 10 credits per 1K image (≈ $0.05).',
    pricing: { status: 'estimate', creditsPerImage: 10.6, usdPerImage: Math.round(10.6 * USD_PER_CREDIT * 1000) / 1000, derived: true, rate: '9.05 credits per 1K output image tokens', source: PRICING, checkedAt: '2026-10-29' },
    build: ({ prompt, aspect, count, seed, guide }) => {
      const g = guide ? { [GUIDE]: guideNode() } : {};
      for (let i = 0; i < count; i++) { g[`${i * 2 + 1}`] = { class_type: 'GeminiNanoBanana2V2', inputs: { prompt, model: 'Gemini Nano Banana 2.1', 'model.aspect_ratio': aspect, 'model.resolution': '1K', 'model.thinking_level': 'MEDIUM', seed: seed + i, response_modalities: 'IMAGE', ...(guide ? { 'model.images.image_1': [GUIDE, 0] } : {}) } }; g[`${i * 2 + 2}`] = save([`${i * 2 + 1}`, 0], i); }
      return g;
    },
  },
  {
    id: 'nano-banana-2', title: 'Nano Banana 2 (Gemini 3.1 Flash Image)', backend: 'cloud', node: 'GeminiNanoBanana2V2',
    note: 'Gemini 3.1 Flash Image. Token-billed: about 17 credits per 1K image (≈ $0.08).',
    pricing: { status: 'estimate', creditsPerImage: 17.0, usdPerImage: Math.round(17.0 * USD_PER_CREDIT * 1000) / 1000, derived: true, rate: '15.19 credits per 1K output image tokens', source: PRICING, checkedAt: '2026-10-29' },
    build: ({ prompt, aspect, count, seed, guide }) => {
      const g = guide ? { [GUIDE]: guideNode() } : {};
      for (let i = 0; i < count; i++) { g[`${i * 2 + 1}`] = { class_type: 'GeminiNanoBanana2V2', inputs: { prompt, model: 'Nano Banana 2 (Gemini 3.1 Flash Image)', 'model.aspect_ratio': aspect, 'model.resolution': '1K', 'model.thinking_level': 'MINIMAL', seed: seed + i, response_modalities: 'IMAGE', ...(guide ? { 'model.images.image_1': [GUIDE, 0] } : {}) } }; g[`${i * 2 + 2}`] = save([`${i * 2 + 1}`, 0], i); }
      return g;
    },
  },
  {
    id: 'local-checkpoint', title: 'Local ComfyUI · installed checkpoint', backend: 'local', node: 'CheckpointLoaderSimple',
    note: 'Text-to-image with a checkpoint already installed in your local ComfyUI. Nothing is downloaded. Uses your GPU.',
    pricing: { status: 'local', creditsPerImage: 0, usdPerImage: 0, source: null, checkedAt: null },
    build: ({ prompt, aspect, count, seed, checkpoint, guide }) => {
      const [width, height] = SIZES[aspect] || SIZES['1:1'];
      if (guide) return { // image-to-image from the blockout frame
        [GUIDE]: guideNode(),
        1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: checkpoint } },
        2: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['1', 1] } },
        3: { class_type: 'CLIPTextEncode', inputs: { text: 'blurry, low quality, deformed, text, watermark', clip: ['1', 1] } },
        8: { class_type: 'ImageScale', inputs: { image: [GUIDE, 0], upscale_method: 'bilinear', width, height, crop: 'disabled' } },
        4: { class_type: 'VAEEncode', inputs: { pixels: ['8', 0], vae: ['1', 2] } },
        5: { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0], seed, steps: 24, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 0.6 } },
        6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
        7: save(['6', 0], 0),
      };
      return {
        1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: checkpoint } },
        2: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['1', 1] } },
        3: { class_type: 'CLIPTextEncode', inputs: { text: 'blurry, low quality, deformed, text, watermark', clip: ['1', 1] } },
        4: { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: count } },
        5: { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0], seed, steps: 24, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1 } },
        6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
        7: save(['6', 0], 0),
      };
    },
  },
];
export const publicPresets = () => imagePresets.map(({ build, ...p }) => p);

export function quoteFor(preset, count, cost) {
  if (preset.backend === 'local') return { ...cost, label: cost.status === 'known' ? 'No charge (local hardware)' : 'Unknown — unqualified local nodes' };
  const usd = preset.pricing.usdPerImage == null ? null : Math.round(preset.pricing.usdPerImage * count * 1000) / 1000;
  return { status: 'unknown', amount: null, currency: 'USD', estimate: usd, credits: preset.pricing.creditsPerImage == null ? null : Math.round(preset.pricing.creditsPerImage * count * 100) / 100, nodes: cost.nodes,
    label: usd == null ? `Unknown — ${preset.pricing.rate}` : `≈ $${usd.toFixed(3)} estimate (${Math.round(preset.pricing.creditsPerImage * count * 10) / 10} credits${preset.pricing.derived ? ', from the per-token rate' : ''}); Cloud total unknown`,
    reason: 'Comfy Cloud partner-node charges are estimates; the backend does not return a binding price.' };
}

export async function openRefgen(root, director, options = {}) {
  const jobs = new Map();
  const dirFor = pid => join(root, 'director', pid, 'refgen');
  const backendFor = options.backend || (input => createBackend(input, options.backendOptions));
  const telemetry = telemetryHooks(options.telemetry); // optional live progress; never part of the outcome
  const allowPaid = () => (options.allowPaid ?? process.env.PREVIS_ALLOW_PAID === '1') === true;
  async function persist(job) { if (job.status === 'uncertain' && !job.uncertainAt) job = { ...job, uncertainAt: now() }; assertNoSecrets(job); await mkdir(dirFor(job.projectId), { recursive: true }); await atomicJson(join(dirFor(job.projectId), job.id + '.json'), job); jobs.set(job.id, structuredClone(job)); return structuredClone(job); }
  // Recover receipts: an interrupted dispatch is uncertain and is never resent.
  async function load(id) {
    let files = []; try { files = await readdir(dirFor(id)); } catch {}
    for (const f of files) if (/^[a-f0-9-]{36}\.json$/.test(f)) {
      const job = JSON.parse(await readFile(join(dirFor(id), f), 'utf8'));
      if (job.projectId !== id) continue;
      if (job.status === 'submitting') { job.status = 'uncertain'; job.message = 'Stopped during dispatch. The backend may still run it; this request is never resent.'; await persist(job); }
      else if (job.status === 'uploading') { job.status = 'quoted'; job.lastAttempt = { at: now(), code: 'interrupted', error: 'Stopped while uploading; nothing was sent' }; await persist(job); }
      else jobs.set(job.id, job);
    }
  }
  for (const { id } of await director.list()) await load(id);
  // Per request id (and per identical request on submit), so one slow download never blocks another job.
  const lock = keyedLock();
  const active = j => ['uploading', 'submitting', 'submitted', 'uncertain', 'collecting'].includes(j.status);
  const slots = options.slots || slotsFor(root), uploadCache = options.uploadCache || uploadCacheFor(root);
  slots.register('refgen', () => [...jobs.values()].filter(active).map(j => ({ id: j.id, backend: j.backend, kind: 'image', status: j.status, uncertainAt: j.uncertainAt, dispatchStartedAt: j.dispatchStartedAt, createdAt: j.createdAt })));
  let tracker = null;
  const label = j => `${j.entityName || 'Image'}${j.sheet?.label ? ` · ${j.sheet.label}` : ''} · ${String(j.model || j.presetId || '').split(' (')[0]}`;
  async function trackJob(id, tracking) {
    let job = jobs.get(id); if (!job) fail('Unknown request', 404);
    if (!['submitted', 'uncertain', 'collecting'].includes(job.status) || !job.promptId) return structuredClone(job);
    if (tracking) job = { ...job, tracking: { lastTrackedAt: tracking.lastTrackedAt ?? null, trackCount: tracking.trackCount ?? 0, nextTrackAt: tracking.nextTrackAt ?? null } };
    const unchanged = () => tracking ? persist(job) : structuredClone(job);
    const adapter = backendFor(job.backend.kind === 'local' ? { kind: 'local', url: job.backend.url } : { kind: 'cloud' });
    if (!job.collection) {
      let history;
      try { history = await adapter.history(job.promptId); }
      catch (e) { if (tracking) await persist({ ...job, tracking: { ...job.tracking, error: errorDetail(e) } }); throw e; }
      if (!history) return unchanged();
      const status = history.status?.status_str;
      if (status === 'error' || status === 'cancelled') {
        // Surface the provider's own reason (e.g. a partner API "Server side error").
        const legacy = (history.status?.messages || []).find(m => m?.[0] === 'execution_error')?.[1];
        const err = history.error || (legacy ? { nodeId: legacy.node_id ?? null, nodeType: legacy.node_type || null, message: String(legacy.exception_message || '') } : null);
        const why = err ? ` ${err.nodeType || 'Node'}: ${String(err.message || '').replace(/\s+/g, ' ').slice(0, 240)}` : '';
        return persist({ ...job, status: 'failed', provider: { status, ...(err ? { error: err } : {}) }, failure: { phase: 'execution', httpStatus: null, detail: err ? errorDetail({ message: why.trim() }) : null }, message: `Backend reported ${status}.${why} Nothing is retried.`, finishedAt: now() });
      }
      if (!history.status?.completed) return unchanged();
      const collection = [];
      const expected = Object.entries(job.graph).filter(([, n]) => n.class_type === 'SaveImage').map(([id]) => id);
      for (const nodeId of expected) for (const image of history.outputs?.[nodeId]?.images || []) {
        const location = safeMediaLocation(image), key = `${nodeId}:${hashValue(location)}`;
        if (!collection.some(x => x.key === key)) collection.push({ key, location });
      }
      if (!collection.length || collection.length > 128) return persist({ ...job, status: 'failed', failure: { phase: 'declared-outputs', detail: 'Completed without 1–128 saved image outputs' }, message: 'Completed without valid saved image outputs.', finishedAt: now() });
      const project = await director.get(job.projectId);
      const existing = [...(project.scene.references || []), ...project.shots.flatMap(s => s.references || [])];
      if (existing.some(r => r.generated?.requestId === job.id && !r.generated.outputKey)) return persist({ ...job, status: 'recovery-required', collection, failure: { phase: 'collection', detail: 'Legacy imported output lacks an output key; reconcile existing references before recovery to avoid duplicates.' }, message: 'Existing output identity needs operator reconciliation. Nothing was downloaded or resubmitted.' });
      job = await persist({ ...job, status: 'collecting', collection });
    }
    if (recoveryAttempts(job, 'collection') >= RECOVERY_ATTEMPTS) return persist({ ...job, status: 'recovery-required', message: 'Recovery limit reached. Recover existing output only; never resubmit.' });
    job = await persist(beginRecovery(job, 'collection'));
    try {
      const referenceIds = [...(job.referenceIds || [])], results = [...(job.results || [])];
      for (const output of job.collection) {
        if (results.some(r => r.key === output.key)) continue;
        const current = await director.get(job.projectId);
        const refs = job.target === 'shot' ? current.shots.find(s => s.id === job.shotId)?.references || [] : current.scene.references || [];
        const existing = refs.find(r => r.generated?.requestId === job.id && r.generated?.outputKey === output.key);
        const bytes = existing ? null : await adapter.view(output.location);
        const r = existing ? { referenceId: existing.id, project: current } : await director.reference(job.projectId, { ...(job.target === 'shot' ? { shotId: job.shotId, role: 'frame', note: typeof job.frameAt === 'number' ? `key frame @${job.frameAt}s` : job.frameAt ? `key frame ${job.frameAt}` : '' } : { scope: 'object', entityId: job.entityId, ...(job.sheet ? { note: `sheet:${job.sheet.sheetId}:${job.sheet.slotId}` } : {}) }), name: job.sheet?.label ? `${job.entityName} · ${job.sheet.label}` : `${job.entityName} · ${job.model.split(' (')[0]} · ${job.seed}`, data: bytes.toString('base64'), generated: { requestId: job.id, outputKey: output.key, presetId: job.presetId, model: job.model, prompt: job.prompt, seed: job.seed, backend: job.backend.id, promptId: job.promptId } });
        if (!referenceIds.includes(r.referenceId)) referenceIds.push(r.referenceId);
        const ref = [...(r.project?.scene?.references || []), ...(r.project?.shots || []).flatMap(x => x.references || [])].find(x => x.id === r.referenceId);
        results.push({ id: r.referenceId, key: output.key, kind: 'image', url: ref?.file ? `/director-refs/${job.projectId}/${ref.file}` : null });
        job = await persist({ ...job, referenceIds, results });
      }
      return persist({ ...job, status: 'completed', referenceIds, results, failure: null, tracking: { ...job.tracking, error: null }, message: `Attached ${referenceIds.length} ${job.target === 'shot' ? 'key frame' : 'look'}${referenceIds.length === 1 ? '' : 's'} to ${job.entityName}.`, finishedAt: now() });
    } catch (error) {
      return persist({ ...job, status: recoveryAttempts(job, 'collection') >= RECOVERY_ATTEMPTS ? 'recovery-required' : 'collecting', failure: { phase: 'collection', detail: errorDetail(error) }, tracking: { ...job.tracking, error: errorDetail(error) }, message: 'Existing output collection failed; no resubmission. Recovery is bounded across restarts.' });
    }
  }

  async function resolve(input) {
    const preset = imagePresets.find(p => p.id === input.presetId); if (!preset) fail('Choose a generation preset');
    const project = await director.get(input.projectId);
    const shot = input.target === 'shot' ? project.shots.find(s => s.id === input.shotId) : null;
    if (input.target === 'shot' && !shot) fail('Choose a shot in this scene');
    const entity = shot ? null : project.scene.entities.find(e => e.id === input.entityId); if (!shot && !entity) fail('Choose an object in this scene');
    const guide = shot && input.guideBytes ? input.guideBytes : null;
    const refBytes = Array.isArray(input.refBytes) ? input.refBytes : [];
    if (refBytes.length > (preset.maxRefs ?? 0)) fail(preset.maxRefs ? `${preset.title} takes at most ${preset.maxRefs} reference images here` : `${preset.title} can’t take reference images; choose FLUX 3 or Flux.2`);
    if (guide && !guide.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail('The composition guide must be a PNG');
    const prompt = String(input.prompt || '').trim(); if (!prompt || prompt.length > 2500) fail('Prompt must be 1–2500 characters');
    const count = guide && preset.backend === 'local' ? 1 : Number(input.count ?? 1); if (!Number.isInteger(count) || count < 1 || count > 4) fail('Generate 1–4 images per request');
    const aspect = ['1:1', '3:4', '4:3', '16:9'].includes(input.aspect) ? input.aspect : '3:4';
    const seed = Number.isInteger(input.seed) && input.seed >= 0 && input.seed < 2 ** 31 ? input.seed : 0;
    const backendInput = preset.backend === 'local' ? { kind: 'local', ...(input.localUrl ? { url: input.localUrl } : {}) } : { kind: 'cloud' };
    const adapter = backendFor(backendInput);
    let inspection;
    try { inspection = await adapter.inspect(); } catch (e) { fail(`Backend inspection failed: ${e.message}. Nothing was sent.`); }
    const { objectInfo } = inspection;
    let checkpoint = null;
    if (preset.backend === 'local') {
      const options = objectInfo.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
      const list = Array.isArray(options) ? options : [];
      checkpoint = input.checkpoint && list.includes(input.checkpoint) ? input.checkpoint : null;
      if (!checkpoint) fail(list.length ? `Choose an installed checkpoint: ${list.slice(0, 12).join(', ')}` : 'No checkpoints are installed in local ComfyUI. Nothing will be downloaded.');
    }
    const graph = preset.build({ prompt, aspect, count, seed, checkpoint, guide: Boolean(guide), refs: refBytes.length });
    const deferredInputs = [...(guide ? [GUIDE_INPUT] : []), ...refInputs(refBytes.length)];
    const validation = validateGraph(graph, objectInfo, deferredInputs.length ? { deferredInputs } : {});
    const cost = quoteFor(preset, count, workflowCost(graph, objectInfo, adapter.snapshot));
    const partnerNodes = Object.values(graph).some(n => objectInfo[n.class_type]?.api_node === true);
    const settings = { presetId: preset.id, model: preset.title, prompt, aspect, count, seed, checkpoint };
    const guideSha = guide ? createHash('sha256').update(guide).digest('hex') : null;
    const refsSha = refBytes.map(b => createHash('sha256').update(b).digest('hex'));
    const fingerprint = hashValue({ graph, backend: adapter.snapshot, schemaHash: validation.schemaHash, guideSha, ...(refsSha.length ? { refsSha } : {}), quote: { status: cost.status, estimate: cost.estimate ?? null, amount: cost.amount } });
    return { preset, adapter, graph, validation, quote: cost, partnerNodes, settings, fingerprint, entity, shot, guide, guideSha, project };
  }

  const api = {
    load,
    presets: publicPresets,
    all: () => [...jobs.values()].map(j => structuredClone(j)),
    useTracker(t) { tracker = t; },
    // Job-tracker source (contract C1); images attach inside track, so onTerminal has nothing extra to do.
    trackerSource: () => ({
      name: 'refgen', list: () => [...jobs.values()].map(j => structuredClone(j)), get: id => { const j = jobs.get(id); if (!j) fail('Unknown request', 404); return structuredClone(j); },
      isActive: active, track: (id, tracking) => lock(id, () => trackJob(id, tracking)), kindOf: () => 'image', label, projectIdOf: j => j.projectId,
      expectedSeconds: j => j.backend?.kind === 'local' ? 600 : 90, costOf: j => j.quote?.amount ?? j.quote?.estimate ?? null,
      resultsOf: j => j.results || (j.referenceIds || []).map(id => ({ id, kind: 'image', url: null })), onTerminal() {},
    }),
    list(projectId) { return [...jobs.values()].filter(j => j.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(j => structuredClone(j)); },
    paidEnabled: allowPaid,
    async checkpoints(localUrl) {
      const { objectInfo } = await backendFor({ kind: 'local', ...(localUrl ? { url: localUrl } : {}) }).inspect();
      const list = objectInfo.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
      return Array.isArray(list) ? list.filter(x => typeof x === 'string') : [];
    },
    prepare: async input => { // a fresh request id: no lock needed
      const guideBytes = input.target === 'shot' && input.guide ? Buffer.from(String(input.guide), 'base64') : null;
      if (guideBytes && guideBytes.length > 12 * 1024 * 1024) fail('The composition guide is too large');
      // Reference images: director references (object looks, earlier key frames), normalised to PNG.
      if (Array.isArray(input.referenceIds) && input.referenceIds.length > 9) fail('At most 9 reference images are supported');
      const refIds = Array.isArray(input.referenceIds) ? input.referenceIds : [];
      const project0 = refIds.length ? await director.get(input.projectId) : null;
      const allRefs = project0 ? [...(project0.scene.references || []), ...project0.shots.flatMap(s => s.references)] : [];
      const refBytes = [];
      for (const rid of refIds) { const ref = allRefs.find(x => x.id === rid); if (!ref) fail('Unknown reference image'); refBytes.push(await imageToPng(await director.refFile(input.projectId, ref.file))); }
      const r = await resolve({ ...input, guideBytes, refBytes });
      if (!r.validation.compatible) fail(`Workflow is not compatible with this backend: ${r.validation.issues.slice(0, 3).map(i => i.message || JSON.stringify(i)).join('; ')}`);
      const id = randomUUID();
      let guide = null;
      if (r.guide) { await mkdir(dirFor(input.projectId), { recursive: true }); const file = `${id}-guide.png`; await writeFile(join(dirFor(input.projectId), file), r.guide, { mode: 0o600 }); guide = { file, sha256: r.guideSha }; }
      const refs = [];
      for (const [k, b] of refBytes.entries()) { const file = `${id}-ref${k + 1}.png`; await mkdir(dirFor(input.projectId), { recursive: true }); await writeFile(join(dirFor(input.projectId), file), b, { mode: 0o600 }); refs.push({ file, referenceId: refIds[k], sha256: createHash('sha256').update(b).digest('hex') }); }
      const frameAt = !r.shot ? null : ['start', 'end'].includes(input.frameAt) ? input.frameAt : Number.isFinite(Number(input.frameAt)) && input.frameAt !== null && input.frameAt !== '' ? Math.round(Math.max(0, Number(input.frameAt)) * 100) / 100 : null;
      const target = r.shot ? { target: 'shot', shotId: r.shot.id, ...(frameAt !== null ? { frameAt } : {}), shotNumber: r.project.shots.indexOf(r.shot) + 1, entityName: `Shot ${String(r.project.shots.indexOf(r.shot) + 1).padStart(2, '0')} ${r.shot.title}` } : { target: 'object', entityId: r.entity.id, entityName: r.entity.name };
      // Design-sheet views name their image after the view and note which sheet slot it fills.
      const sheet = !r.shot && input.sheet && typeof input.sheet === 'object' ? { sheetId: String(input.sheet.sheetId || '').slice(0, 48), slotId: String(input.sheet.slotId || '').slice(0, 48), label: String(input.sheet.label || '').slice(0, 60) } : null;
      return persist({ id, projectId: input.projectId, ...target, ...(sheet ? { sheet } : {}), ...r.settings, guide, refs, backend: r.adapter.snapshot, graph: r.graph, graphHash: hashValue(r.graph), quote: r.quote, partnerNodes: r.partnerNodes, fingerprint: r.fingerprint, status: 'quoted', message: 'Quoted. Nothing was sent.', createdAt: now() });
    },
    submit: input => lock(String(input.requestId), () => lock(`content:${jobs.get(input.requestId)?.fingerprint}`, async () => {
      const saved = jobs.get(input.requestId); if (!saved || saved.projectId !== input.projectId) fail('Unknown request', 404);
      if (saved.status !== 'quoted') return structuredClone(saved);
      const twin = input.allowDuplicate === true ? null : [...jobs.values()].find(j => j.id !== saved.id && j.projectId === saved.projectId && j.entityId === saved.entityId && j.shotId === saved.shotId && j.fingerprint === saved.fingerprint && (active(j) || j.status === 'recovery-required'));
      if (twin) {
        const error = `An identical request is already active (${twin.id}); nothing was sent.`;
        await persist({ ...saved, lastAttempt: { at: now(), code: 'duplicate', error, existingId: twin.id } });
        throw Object.assign(Error(error), { status: 409, apiCode: 'duplicate', existingId: twin.id });
      }
      const free = saved.quote.status === 'known' && saved.quote.amount === 0;
      if (!free && !allowPaid()) fail('Paid and unknown-cost generation is disabled on this server (PREVIS_ALLOW_PAID is not 1). Nothing was sent.', 403);
      const release = slots.acquire({ id: saved.id, backend: saved.backend, kind: 'image' });
      try { return await dispatch(saved, input); } finally { release(); }
    })),
    // Without a tracker (tests, tools) this tracks directly; with one, the tracker records the attempt.
    track: (input, tracking) => {
      const job = jobs.get(input.requestId); if (!job || job.projectId !== input.projectId) return Promise.reject(Object.assign(Error('Unknown request'), { status: 404 }));
      return tracker && !tracking ? tracker.trackNow('refgen', job.id) : lock(job.id, () => trackJob(job.id, tracking));
    },
  };
  async function dispatch(saved, input) {
    const guideBytes = saved.guide ? await readFile(join(dirFor(saved.projectId), saved.guide.file)) : null;
    const refBytes = await Promise.all((saved.refs || []).map(x => readFile(join(dirFor(saved.projectId), x.file))));
    const current = await resolve({ ...saved, projectId: saved.projectId, entityId: saved.entityId, guideBytes, refBytes, localUrl: saved.backend.kind === 'local' ? saved.backend.url : undefined });
    if (current.fingerprint !== saved.fingerprint) { await persist({ ...saved, status: 'invalidated', message: 'Backend schema, settings or price changed. Get a new quote.' }); fail('Quote changed; get a new quote and approve again', 409); }
    validateApproval(input.approval, saved.fingerprint, saved.quote);
    let job = await persist({ ...saved, approval: structuredClone(input.approval), status: 'uploading', message: 'Uploading inputs; nothing dispatched yet.',
      ...(saved.backend.kind === 'local' ? { progressClientId: saved.progressClientId || randomUUID() } : {}) });
    let dispatchStarted = false;
    const observing = telemetry.begin(job); telemetry.phase(job, 'uploading');
    try {
      const graph = structuredClone(saved.graph);
      if (guideBytes) { const up = await uploadCache.upload(current.adapter, guideBytes, { filename: `${saved.id}-guide.png`, mime: 'image/png', subfolder: `previs/${saved.id}` }); graph[GUIDE].inputs.image = up.value; }
      for (const [k, b] of refBytes.entries()) { const up = await uploadCache.upload(current.adapter, b, { filename: `${saved.id}-ref${k + 1}.png`, mime: 'image/png', subfolder: `previs/${saved.id}` }); graph[refNode(k + 1)].inputs.image = up.value; }
      await observing; // Bounded: an unavailable observer only means polling.
      job = await persist({ ...job, status: 'submitting', message: 'Dispatch started. This request is never resent.', dispatchStartedAt: now() });
      dispatchStarted = true; telemetry.phase(job, 'submitting');
      const { promptId } = await current.adapter.submit({ graph, requestId: saved.id, projectId: saved.projectId, partnerNodes: saved.partnerNodes, ...(job.progressClientId ? { clientId: job.progressClientId } : {}) });
      job = await persist({ ...job, submittedGraph: graph, status: 'submitted', promptId, message: 'Accepted by the backend. Generating…', submittedAt: now() });
      telemetry.accept(job); // Only after the acceptance receipt is durable.
    } catch (e) {
      // Upload failures happen before any prompt is sent; a rejected prompt never ran. Both free the slot.
      const failure = { phase: dispatchStarted ? 'dispatch' : 'preparation', httpStatus: e.httpStatus || null, detail: errorDetail(e) };
      const rejected = !dispatchStarted || e.notSent === true || [400, 401, 402, 403, 413, 422, 429].includes(e.httpStatus);
      if (dispatchStarted && rejected) failure.notSent = true;
      job = await persist({ ...job, status: rejected ? 'failed' : 'uncertain', failure, message: rejected ? `${dispatchStarted ? 'Backend rejected the request' : 'Upload failed before dispatch'} (${failure.detail.slice(0, 240)}). Nothing is retried.` : `Dispatch outcome unknown (${e.message}). Check the backend; this request is never resent.`, ...(rejected ? { finishedAt: now() } : {}) });
    }
    if (tracker && active(job)) tracker.watch('refgen', job.id);
    return job;
  }
  return api;
}

export function refgenRoutes(refgen) {
  return async function route(method, url, input) {
    const path = url.pathname;
    if (method === 'GET' && path === '/api/director/refgen') {
      const projectId = url.searchParams.get('projectId');
      if (!uuid.test(projectId || '')) fail('Unknown project', 404);
      return { presets: refgen.presets(), jobs: refgen.list(projectId), paidExecutionEnabled: refgen.paidEnabled(), cloudCredential: Boolean(process.env.COMFY_CLOUD_API_KEY) };
    }
    if (method === 'GET' && path === '/api/director/refgen/checkpoints') {
      try { return { checkpoints: await refgen.checkpoints(url.searchParams.get('url') || undefined) }; }
      catch (e) { return { checkpoints: [], error: `Local ComfyUI unavailable: ${e.message}` }; }
    }
    if (method !== 'POST') return undefined;
    if (path === '/api/director/refgen/prepare') return { job: await refgen.prepare(input) };
    if (path === '/api/director/refgen/submit') return { job: await refgen.submit(input) };
    if (path === '/api/director/refgen/track') return { job: await refgen.track(input) };
    return undefined;
  };
}
