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
import { followsGuide, describeFrame } from '../../shared/still-match.mjs';
import { shotSignature } from '../../shared/director.mjs';
import { stillGuideMatch, gradeStillPaid } from './still-match.mjs';

const uuid = /^[a-f0-9-]{36}$/;
const now = () => new Date().toISOString();
function fail(message, status = 400) { const e = Error(message); e.status = status; throw e; }
// Same credit→USD ratio as the retained Kling preset (26.59 credits = $0.126).
const USD_PER_CREDIT = 0.126 / 26.59;
const SIZES = { '1:1': [512, 512], '3:4': [512, 680], '4:3': [680, 512], '16:9': [768, 432] };
const PRICING = 'https://docs.comfy.org/tutorials/partner-nodes/pricing';

const FLUX2_SIZE = { '1:1': [1024, 1024], '3:4': [768, 1024], '4:3': [1024, 768], '16:9': [1344, 768], '9:16': [768, 1344] };
// Nearest preset sizes (no Custom): GPT Image has no 3:4/4:3 preset, so those use 2:3/3:2.
const GPT_SIZE = { '1:1': '1024x1024', '3:4': '1024x1536', '4:3': '1536x1024', '16:9': '2048x1152' };
const SEEDREAM_SIZE = { '1:1': '(1K) 1024x1024 (1:1)', '3:4': '(1K) 864x1152 (3:4)', '4:3': '(1K) 1152x864 (4:3)', '16:9': '(1K) 1312x736 (16:9)' };
const save = (images, index) => ({ class_type: 'SaveImage', inputs: { images, filename_prefix: `previs/look-${index}` } });
// Shot key frames use the shot camera's blockout frame as a composition guide (uploaded at submit).
const GUIDE = '100';
const guideNode = () => ({ class_type: 'LoadImage', inputs: { image: 'previs-guide.png' } });
// Flux Ultra's image-prompt blend for key frames (a guide means a key frame): high enough to keep the blockout's layout.
const GUIDE_STRENGTH = 0.55;
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
      for (let i = 0; i < count; i++) { g[`${i * 2 + 1}`] = { class_type: 'FluxProUltraImageNode', inputs: { prompt, prompt_upsampling: false, seed: seed + i, aspect_ratio: aspect, raw: false, ...(guide ? { image_prompt: [GUIDE, 0], image_prompt_strength: GUIDE_STRENGTH } : {}) } }; g[`${i * 2 + 2}`] = save([`${i * 2 + 1}`, 0], i); }
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
    id: 'flux-2-max', title: 'Flux.2 [max] (BFL)', backend: 'cloud', node: 'Flux2ImageNode',
    note: 'BFL’s top Flux.2 tier: more detail and better prompt and reference following than [pro]. $0.07 per 1 MP image plus $0.03–0.24 for reference images.',
    pricing: { status: 'estimate', creditsPerImage: 15, usdPerImage: Math.round(15 * USD_PER_CREDIT * 1000) / 1000, source: 'Live Flux2ImageNode price_badge (Flux.2 [max]: $0.07 per output MP; reference surcharge $0.03–0.24 not included)', checkedAt: '2026-10-30' },
    maxRefs: 7,
    build: ({ prompt, aspect, count, seed, guide, refs = 0 }) => {
      const [w, h] = FLUX2_SIZE[aspect] || FLUX2_SIZE['1:1'];
      const g = { ...(guide ? { [GUIDE]: guideNode() } : {}), ...refNodes(refs) };
      for (let i = 0; i < count; i++) { g[`${i * 2 + 1}`] = { class_type: 'Flux2ImageNode', inputs: { prompt, model: 'Flux.2 [max]', 'model.width': w, 'model.height': h, seed: seed + i, ...slots('model.images.image_', guide, refs) } }; g[`${i * 2 + 2}`] = save([`${i * 2 + 1}`, 0], i); }
      return g;
    },
  },
  {
    id: 'gpt-image-25', title: 'GPT Image 2.5 (OpenAI)', backend: 'cloud', node: 'OpenAIGPTImageNodeV2',
    note: 'OpenAI’s newest image model (2.5 Sunburst, high quality): strong text, logos and multi-reference edits. About $0.06–0.08 per image plus about $0.015 per reference image.',
    pricing: { status: 'estimate', creditsPerImage: 16, usdPerImage: Math.round(16 * USD_PER_CREDIT * 1000) / 1000, source: 'Live OpenAIGPTImageNodeV2 price_badge (gpt-image-2.5 high: $0.0589–0.0753 by size; $0.0117–0.0176 per reference image not included)', checkedAt: '2026-10-30' },
    maxRefs: 9,
    build: ({ prompt, aspect, count, seed, guide, refs = 0 }) => {
      const g = { ...(guide ? { [GUIDE]: guideNode() } : {}), ...refNodes(refs) };
      for (let i = 0; i < count; i++) { g[`${i * 2 + 1}`] = { class_type: 'OpenAIGPTImageNodeV2', inputs: { prompt, model: 'gpt-image-2.5-sunburst', 'model.size': GPT_SIZE[aspect] || GPT_SIZE['1:1'], 'model.custom_width': 1024, 'model.custom_height': 1024, 'model.background': 'opaque', 'model.quality': 'high', n: 1, seed: seed + i, ...slots('model.images.image_', guide, refs) } }; g[`${i * 2 + 2}`] = save([`${i * 2 + 1}`, 0], i); }
      return g;
    },
  },
  {
    id: 'seedream-5-pro', title: 'Seedream 5.0 Pro (ByteDance)', backend: 'cloud', node: 'ByteDanceSeedreamNodeV3',
    note: 'ByteDance Seedream 5.0 Pro at 1K: photoreal, consistent multi-reference generation. $0.045 per image plus $0.003 per extra reference image.',
    pricing: { status: 'estimate', creditsPerImage: 9.5, usdPerImage: Math.round(9.5 * USD_PER_CREDIT * 1000) / 1000, source: 'Live ByteDanceSeedreamNodeV3 price_badge (seedream 5.0 pro 1K: $0.045 per image; $0.003 per reference after the first not included)', checkedAt: '2026-10-30' },
    maxRefs: 9,
    build: ({ prompt, aspect, count, seed, guide, refs = 0 }) => {
      const g = { ...(guide ? { [GUIDE]: guideNode() } : {}), ...refNodes(refs) };
      // width/height only apply to the Custom size preset, but the schema requires them.
      for (let i = 0; i < count; i++) { g[`${i * 2 + 1}`] = { class_type: 'ByteDanceSeedreamNodeV3', inputs: { prompt, model: 'seedream 5.0 pro', 'model.size_preset': SEEDREAM_SIZE[aspect] || SEEDREAM_SIZE['1:1'], 'model.width': 2048, 'model.height': 2048, 'model.prompt_optimization': 'standard', 'model.seed': seed + i, 'model.watermark': false, 'model.thinking': true, ...slots('model.images.image_', guide, refs) } }; g[`${i * 2 + 2}`] = save([`${i * 2 + 1}`, 0], i); }
      return g;
    },
  },
  {
    id: 'nano-banana-pro', title: 'Nano Banana Pro (Gemini 3 Pro Image)', backend: 'cloud', node: 'GeminiImage2Node',
    note: 'Strong prompt following and reference consistency. About $0.16 per 1K image (token-billed estimate). Reference images are letterboxed onto one canvas size for the model.',
    pricing: { status: 'estimate', creditsPerImage: 34, usdPerImage: Math.round(34 * USD_PER_CREDIT * 1000) / 1000, derived: true, rate: '30.38 credits per 1K output tokens', source: 'Live GeminiImage2Node price_badge (gemini-3-pro-image 1K: ≈ $0.1608 per image)', checkedAt: '2026-10-30' },
    maxRefs: 9,
    build: ({ prompt, aspect, count, seed, guide, refs = 0 }) => {
      // This node takes one IMAGE input: with references, every image is padded to one size and batched (guide first).
      const g = { ...(guide ? { [GUIDE]: guideNode() } : {}), ...refNodes(refs) };
      let images = guide ? [GUIDE, 0] : null;
      if (refs) {
        const [w, h] = FLUX2_SIZE[aspect] || FLUX2_SIZE['1:1'], batch = {};
        Object.entries(slots('', guide, refs)).forEach(([k, src]) => { g[`${300 + Number(k)}`] = { class_type: 'ResizeAndPadImage', inputs: { image: src, target_width: w, target_height: h, padding_color: 'white', interpolation: 'lanczos' } }; batch[`images.image${Number(k) - 1}`] = [`${300 + Number(k)}`, 0]; });
        g['399'] = { class_type: 'BatchImagesNode', inputs: batch }; images = ['399', 0];
      }
      for (let i = 0; i < count; i++) { g[`${i * 2 + 1}`] = { class_type: 'GeminiImage2Node', inputs: { prompt, model: 'gemini-3-pro-image-preview', seed: seed + i, aspect_ratio: aspect, resolution: '1K', response_modalities: 'IMAGE', ...(images ? { images } : {}) } }; g[`${i * 2 + 2}`] = save([`${i * 2 + 1}`, 0], i); }
      return g;
    },
  },
  {
    id: 'nano-banana-2-1', title: 'Nano Banana 2.1 (Gemini)', backend: 'cloud', node: 'GeminiNanoBanana2V2',
    note: 'Fast, inexpensive and good at following a guide and reference images. Token-billed: about 10 credits per 1K image (≈ $0.05).',
    pricing: { status: 'estimate', creditsPerImage: 10.6, usdPerImage: Math.round(10.6 * USD_PER_CREDIT * 1000) / 1000, derived: true, rate: '9.05 credits per 1K output image tokens', source: PRICING, checkedAt: '2026-10-29' },
    maxRefs: 9, // the node takes 14 images; cast images add input tokens (a still with 4 references billed ≈ 17 credits)
    build: ({ prompt, aspect, count, seed, guide, refs = 0 }) => {
      const g = { ...(guide ? { [GUIDE]: guideNode() } : {}), ...refNodes(refs) };
      for (let i = 0; i < count; i++) { g[`${i * 2 + 1}`] = { class_type: 'GeminiNanoBanana2V2', inputs: { prompt, model: 'Gemini Nano Banana 2.1', 'model.aspect_ratio': aspect, 'model.resolution': '1K', 'model.thinking_level': 'MEDIUM', seed: seed + i, response_modalities: 'IMAGE', ...slots('model.images.image_', guide, refs) } }; g[`${i * 2 + 2}`] = save([`${i * 2 + 1}`, 0], i); }
      return g;
    },
  },
  {
    id: 'nano-banana-2', title: 'Nano Banana 2 (Gemini 3.1 Flash Image)', backend: 'cloud', node: 'GeminiNanoBanana2V2',
    note: 'Gemini 3.1 Flash Image. Token-billed: about 17 credits per 1K image (≈ $0.08).',
    pricing: { status: 'estimate', creditsPerImage: 17.0, usdPerImage: Math.round(17.0 * USD_PER_CREDIT * 1000) / 1000, derived: true, rate: '15.19 credits per 1K output image tokens', source: PRICING, checkedAt: '2026-10-29' },
    maxRefs: 9,
    build: ({ prompt, aspect, count, seed, guide, refs = 0 }) => {
      const g = { ...(guide ? { [GUIDE]: guideNode() } : {}), ...refNodes(refs) };
      for (let i = 0; i < count; i++) { g[`${i * 2 + 1}`] = { class_type: 'GeminiNanoBanana2V2', inputs: { prompt, model: 'Nano Banana 2 (Gemini 3.1 Flash Image)', 'model.aspect_ratio': aspect, 'model.resolution': '1K', 'model.thinking_level': 'MINIMAL', seed: seed + i, response_modalities: 'IMAGE', ...slots('model.images.image_', guide, refs) } }; g[`${i * 2 + 2}`] = save([`${i * 2 + 1}`, 0], i); }
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
// followsGuide: how well the model keeps a blockout guide's camera and layout ('strong' is recommended for key frames).
for (const p of imagePresets) p.followsGuide = followsGuide(p.id);
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
        const guideMatch = bytes && job.target === 'shot' && job.guide ? await matchGuide(job, adapter, bytes, output.key) : null;
        const r = existing ? { referenceId: existing.id, project: current } : await director.reference(job.projectId, { ...(job.target === 'shot' ? { shotId: job.shotId, role: 'frame', note: typeof job.frameAt === 'number' ? `key frame @${job.frameAt}s` : job.frameAt ? `key frame ${job.frameAt}` : '' } : { scope: 'object', entityId: job.entityId, ...(job.sheet ? { note: `sheet:${job.sheet.sheetId}:${job.sheet.slotId}` } : {}) }), name: job.sheet?.label ? `${job.entityName} · ${job.sheet.label}` : `${job.entityName} · ${job.model.split(' (')[0]} · ${job.seed}`, data: bytes.toString('base64'), generated: { requestId: job.id, outputKey: output.key, presetId: job.presetId, model: job.model, prompt: job.prompt, seed: job.seed, backend: job.backend.id, promptId: job.promptId, ...(job.signature ? { signature: job.signature } : {}), ...(guideMatch ? { guideMatch } : {}) } });
        if (!referenceIds.includes(r.referenceId)) referenceIds.push(r.referenceId);
        const ref = [...(r.project?.scene?.references || []), ...(r.project?.shots || []).flatMap(x => x.references || [])].find(x => x.id === r.referenceId);
        const match = ref?.generated?.guideMatch; // graded scores only (the rough local one is not a match verdict)
        results.push({ id: r.referenceId, key: output.key, kind: 'image', url: ref?.file ? `/director-refs/${job.projectId}/${ref.file}` : null, ...(match && !match.rough ? { guideMatch: match.score } : {}) });
        job = await persist({ ...job, referenceIds, results });
      }
      return persist({ ...job, status: 'completed', referenceIds, results, failure: null, tracking: { ...job.tracking, error: null }, message: `Attached ${referenceIds.length} ${job.target === 'shot' ? 'key frame' : 'look'}${referenceIds.length === 1 ? '' : 's'} to ${job.entityName}.`, finishedAt: now() });
    } catch (error) {
      return persist({ ...job, status: recoveryAttempts(job, 'collection') >= RECOVERY_ATTEMPTS ? 'recovery-required' : 'collecting', failure: { phase: 'collection', detail: errorDetail(error) }, tracking: { ...job.tracking, error: errorDetail(error) }, message: 'Existing output collection failed; no resubmission. Recovery is bounded across restarts.' });
    }
  }

  /**
   * Key frames: how well the still kept its blockout guide. With PREVIS_MATCH_GRADER=gemini (and paid generation on)
   * Gemini grades camera and blocking 0–10 on Comfy Cloud (token-billed, a few cents; adds ~20 s before the still
   * attaches). Otherwise a free local edge/light score, stored with rough: true — it does not track camera match
   * reliably (see docs/director.md), so the UI never shows it as a match score and batches never retry on it.
   */
  async function matchGuide(job, adapter, bytes, key) {
    const guideBytes = await readFile(join(dirFor(job.projectId), job.guide.file)).catch(() => null);
    if (!guideBytes) return null;
    if ((options.grader ?? process.env.PREVIS_MATCH_GRADER) === 'gemini' && allowPaid() && job.backend.kind === 'cloud') {
      const project = await director.get(job.projectId).catch(() => null), shot = project?.shots.find(s => s.id === job.shotId);
      const t = !shot ? 0 : job.frameAt === 'end' ? shot.duration : typeof job.frameAt === 'number' ? job.frameAt : 0;
      const plan = shot ? describeFrame(project, shot, t).text : '';
      const graded = await gradeStillPaid({ adapter, upload: (b, o) => uploadCache.upload(adapter, b, o), guideBytes, stillBytes: bytes, requestId: `${job.id}-${hashValue(key).slice(0, 8)}`, projectId: job.projectId, plan });
      if (graded) return graded;
    }
    const local = await stillGuideMatch(guideBytes, bytes);
    return local ? { ...local, rough: true } : null;
  }

  async function resolve(input) {
    const preset = imagePresets.find(p => p.id === input.presetId); if (!preset) fail('Choose a generation preset');
    const project = await director.get(input.projectId);
    const shot = input.target === 'shot' ? project.shots.find(s => s.id === input.shotId) : null;
    if (input.target === 'shot' && !shot) fail('Choose a shot in this scene');
    const entity = shot ? null : project.scene.entities.find(e => e.id === input.entityId); if (!shot && !entity) fail('Choose an object in this scene');
    const guide = shot && input.guideBytes ? input.guideBytes : null;
    const refBytes = Array.isArray(input.refBytes) ? input.refBytes : [];
    if (refBytes.length > (preset.maxRefs ?? 0)) fail(preset.maxRefs ? `${preset.title} takes at most ${preset.maxRefs} reference images here` : `${preset.title} can’t take reference images; choose a model that does (FLUX 3, Flux.2, GPT Image, Seedream or Nano Banana)`);
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
      // A key frame records the blocking it was made from (the blockout signature), so a later change marks it stale.
      const target = r.shot ? { target: 'shot', shotId: r.shot.id, ...(frameAt !== null ? { frameAt } : {}), signature: shotSignature(r.project, r.shot), shotNumber: r.project.shots.indexOf(r.shot) + 1, entityName: `Shot ${String(r.project.shots.indexOf(r.shot) + 1).padStart(2, '0')} ${r.shot.title}` } : { target: 'object', entityId: r.entity.id, entityName: r.entity.name };
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
