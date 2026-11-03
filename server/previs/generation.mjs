import { mkdir, readFile, readdir, writeFile, access } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RECOVERY_ATTEMPTS, recoveryAttempts, beginRecovery, recoveryId, saveResultBytes } from './result-recovery.mjs';
import { atomicJson } from './atomic.mjs';
import { cameraSourceOf } from '../../shared/camera-source.mjs';
import { createBackend, backendSnapshot, safeMediaLocation, errorDetail } from './backends.mjs';
import { telemetryHooks } from './job-progress.mjs';
import { slotsFor, downloadsFor } from './concurrency.mjs';
import { keyedLock } from './keyed-lock.mjs';
import { uploadCacheFor } from './upload-cache.mjs';
import { expandAsset } from './provenance.mjs';
import { openBudget, budgetDir, followJob, quoteEstimate } from './budget.mjs';
import { assertNoSecrets, hashBytes, hashValue, validateWorkflowDefinition, legacyWorkflowDefinition, validateGraph, workflowCost, validateApproval, isMaskedEditDefinition, MASKED_EDIT_PURPOSE } from './workflows.mjs';

/** Historical Cloud GPU calibration for the allowlisted masked VACE 14B graph (INTEGRATION.md). Not an invoice. */
export const MASKED_VACE_CALIBRATION = Object.freeze({
  definitionId: 'wan-vace-14b-masked-v1',
  unet: 'wan2.1_vace_14B_fp16.safetensors',
  steps: 20,
  basisGpuSeconds: 248.2,
  basisCropPixels: 399_360, // 832×480
  basisFrames: 81,
  creditsPerGpuSecond: 0.266,
  creditsPerUsd: 211,
  rateFetchedAt: '2026-11-03T03:55:02.423Z',
  version: 'masked-vace-14b-hist-20261103',
  providerEnforcedCap: false,
});

/**
 * Server-owned planning estimate for the recovered masked VACE 14B settings.
 * gpuSeconds = 248.2 × (cropPixels / 399360) × (frames / 81); USD = gpuSeconds × 0.266 / 211.
 */
export function estimateMaskedVaceCost({ width, height, frames, steps = 20, unet = MASKED_VACE_CALIBRATION.unet, marginPct = 10 } = {}) {
  const cal = MASKED_VACE_CALIBRATION;
  if (unet !== cal.unet || steps !== cal.steps) return null;
  if (![81, 89, 113].includes(frames) || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return null;
  const cropPixels = width * height;
  const gpuSeconds = cal.basisGpuSeconds * (cropPixels / cal.basisCropPixels) * (frames / cal.basisFrames);
  if (!Number.isFinite(gpuSeconds) || gpuSeconds <= 0) return null;
  const estimate = Math.round((gpuSeconds * cal.creditsPerGpuSecond / cal.creditsPerUsd) * 10000) / 10000;
  const reservationRequiredUsd = Math.round(estimate * (1 + (Number.isFinite(marginPct) ? marginPct : 10) / 100) * 10000) / 10000;
  return {
    currency: 'USD', status: 'unknown', amount: null, estimate, reservationRequiredUsd,
    runtime: { gpuSeconds: Math.round(gpuSeconds * 1000) / 1000, hardware: 'historical-rtx_pro_6000-scale', uncertainty: 'planning-envelope' },
    crop: { width, height, pixels: cropPixels, frames, steps },
    lineItems: { sam3Usd: 0, graderUsd: 0, retryUsd: 0, uploadStorageKnownUsd: null },
    marginPct: Number.isFinite(marginPct) ? marginPct : 10,
    providerEnforcedCap: false,
    rate: { creditsPerGpuSecond: cal.creditsPerGpuSecond, creditsPerUsd: cal.creditsPerUsd, fetchedAt: cal.rateFetchedAt, version: cal.version },
  };
}

export function applyTrustedMaskedEstimate(quote, definition, sources, { marginPct = 10 } = {}) {
  const allowlisted = definition?.id === MASKED_VACE_CALIBRATION.definitionId
    || definition?.provenance?.presetId === MASKED_VACE_CALIBRATION.definitionId;
  if (!isMaskedEditDefinition(definition) || !allowlisted) return quote;
  // Prefer the bound crop media (actual submit dimensions) over the preset's placeholder graph values.
  const w = Number(sources?.sourceVideo?.width) || Number(definition.graph?.['13']?.inputs?.width);
  const h = Number(sources?.sourceVideo?.height) || Number(definition.graph?.['13']?.inputs?.height);
  const frames = Number(sources?.sourceVideo?.frameCount) || Number(definition.graph?.['13']?.inputs?.length);
  const steps = Number(definition.graph?.['15']?.inputs?.steps) || 20;
  const unet = definition.graph?.['8']?.inputs?.unet_name || MASKED_VACE_CALIBRATION.unet;
  const trusted = estimateMaskedVaceCost({ width: w, height: h, frames, steps, unet, marginPct });
  if (!trusted) return { ...quote, estimate: null, estimateRefused: 'No reliable estimate is available for these settings. Nothing submitted.', providerEnforcedCap: false };
  return {
    ...quote,
    currency: 'USD',
    estimate: trusted.estimate,
    reservationRequiredUsd: trusted.reservationRequiredUsd,
    providerEnforcedCap: false,
    estimateBasis: trusted,
    rateVersion: trusted.rate.version,
  };
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const draft = job => ['prepared', 'quoted', 'invalidated'].includes(job.status);
const active = job => ['uploading', 'submitting', 'queued', 'running', 'uncertain', 'collecting', 'attaching'].includes(job.status);
const fail = (message, status = 400) => { const error = Error(message); error.status = status; throw error; };
const now = () => new Date().toISOString();
export const generationKind = job => job.definition?.outputs?.length && job.definition.outputs.every(output => output.mediaType?.startsWith('image/')) ? 'image' : 'video';
function clipSeconds(job) {
  const value = Number(job.binding?.parameters?.duration);
  if (Number.isFinite(value) && value > 0) return value;
  const b = job.shot?.binding, frames = Number(b?.end) - Number(b?.start) + 1;
  return b && Number(b.fps) > 0 && frames > 0 ? frames / Number(b.fps) : 5;
}
/** Typical wall time before the tracker calls a job stuck (at 2×). */
export function expectedSeconds(job) {
  if (job.backend?.kind === 'local') return 600;
  if (generationKind(job) === 'image') return 90;
  const model = `${job.definition?.title || ''} ${Object.values(job.preparedGraph || {}).map(node => node?.class_type).join(' ')}`;
  // Partner video models (Kling, Seedance/ByteDance, Veo, MiniMax Hailuo, Wan API) queue and render for minutes.
  if (/kling|seedance|bytedance|veo|minimax|hailuo|wan\d?(?:ImageToVideo|TextToVideo)Api/i.test(model)) return 420;
  return Math.round(120 + 30 * clipSeconds(job));
}
/** What a request asks the backend to do, independent of its request id and binding id (duplicate detection). */
export const contentKey = job => hashValue({ inputs: job.definition?.inputs || {}, outputs: job.definition?.outputs || [], graph: job.preparedGraph, sources: Object.fromEntries(Object.entries(job.sources || {}).map(([name, source]) => [name, source?.sha256 ?? null])), backend: job.backend?.id ?? null });
/** Completed identical requests within this window are refused as duplicates unless the caller passes allowDuplicate. */
export const duplicateWindowMs = (env = process.env) => { const m = Number(env.PREVIS_DUPLICATE_WINDOW_MINUTES); return (env.PREVIS_DUPLICATE_WINDOW_MINUTES !== undefined && env.PREVIS_DUPLICATE_WINDOW_MINUTES !== '' && Number.isFinite(m) && m >= 0 ? m : 120) * 60000; };
export const generationLabel = job => `${job.shot?.title || 'Shot'} · ${job.definition?.title || 'Workflow'}`;
/** List-price USD for a request: its quote, else the preset's per-second rate × the seconds it asks for; null when unknown. */
export function generationEstimate(job) {
  const quoted = quoteEstimate(job.quote, job.backend);
  if (quoted !== null) return quoted;
  const rate = job.definition?.pricing?.ratePerSecond;
  if (!(Number.isFinite(rate) && rate >= 0)) return null;
  const seconds = Number(job.binding?.parameters?.duration) || job.sources?.sourceVideo?.duration || clipSeconds(job);
  return Math.round(rate * seconds * 10000) / 10000;
}
const extensions = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'video/x-matroska': '.mkv', 'audio/wav': '.wav', 'audio/mpeg': '.mp3' };

export function probePng(bytes) {
  if (bytes.length < 33 || bytes.length > 32 * 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString('ascii', 12, 16) !== 'IHDR') fail('Expected a PNG under 32 MB');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width * height > 16000000) fail('Unsupported PNG dimensions');
  return { width, height, mime: 'image/png' };
}

export function validateAssetConstraints(asset, constraints = {}) {
  const issues = [];
  if (constraints.mime && (!Array.isArray(constraints.mime) || !constraints.mime.includes(asset.mime))) issues.push('mime');
  for (const key of ['width', 'height', 'fps', 'frameCount', 'duration']) {
    const rule = constraints[key];
    if (rule === undefined) continue;
    const value = asset[key];
    if (!Number.isFinite(value) || (typeof rule === 'number' && value !== rule) || (typeof rule === 'object' && (('min' in rule && value < rule.min) || ('max' in rule && value > rule.max) || ('multipleOf' in rule && value % rule.multipleOf !== 0)))) issues.push(key);
  }
  if (issues.length) fail(`Asset ${asset.id} violates constraints: ${issues.join(', ')}. No resize, retime or timing fit is performed.`);
}

export function declaredOutputs(definition, outputs) {
  const results = [];
  for (const declared of definition.outputs) {
    const node = outputs?.[declared.nodeId];
    const keys = declared.mediaType === 'image/png' ? ['images'] : ['video', 'videos', 'gifs', 'images'];
    const files = keys.flatMap(key => Array.isArray(node?.[key]) ? node[key] : []);
    if (!files.length || files.length > 128) fail(`Declared output ${declared.nodeId} did not return 1–128 media files`);
    const seen = new Set();
    for (const file of files) {
      const location = safeMediaLocation(file);
      if (extname(location.filename).toLowerCase() !== extensions[declared.mediaType]) fail(`Declared output ${declared.nodeId} has an unsupported or mismatched media format`);
      const key = hashValue(location);
      if (!seen.has(key)) results.push({ nodeId: declared.nodeId, mediaType: declared.mediaType, location, key: `${declared.nodeId}:${key}` });
      seen.add(key);
    }
  }
  return results;
}

// The parent attaches completed results to its project. This module owns only
// generation-jobs receipts and collected media; it never mutates project state.
export async function openGeneration(root, project, options = {}) {
  const dir = join(root, 'generation-jobs');
  await mkdir(dir, { recursive: true });
  const jobs = new Map();
  let attachResults = options.onTerminal;
  const requiresAttachment = options.requireAttachment || Boolean(attachResults);
  const writer = options.persist || atomicJson;
  // Every paid dispatch reserves its estimate here first (server.mjs passes the shared authority).
  const budget = options.budget || await openBudget(budgetDir(root));
  // Optional live-progress observer: display only, never part of the dispatch outcome.
  const telemetry = telemetryHooks(options.telemetry);
  const persist = async job => {
    if (job.status === 'uncertain' && !job.uncertainAt) job = { ...job, uncertainAt: now() };
    assertNoSecrets(job);
    await writer(join(dir, job.id + '.json'), job);
    jobs.set(job.id, structuredClone(job));
    await followJob(budget, job, options.log);
    return structuredClone(job);
  };
  for (const file of await readdir(dir)) if (/^[a-f0-9-]{36}\.json$/i.test(file)) {
    const job = JSON.parse(await readFile(join(dir, file), 'utf8'));
    if (!uuid.test(job.id) || file.toLowerCase() !== job.id.toLowerCase() + '.json') fail('Invalid generation receipt identity');
    if (job.status === 'submitting') { job.status = 'uncertain'; job.message = 'Stopped during dispatch. Backend execution may continue; never resubmit this request.'; }
    // Interrupted while uploading inputs: no prompt was sent, so the request returns to its quote and can be resubmitted as is.
    if (job.status === 'uploading') { job.status = 'quoted'; job.promptId = null; job.lastAttempt = { at: now(), error: 'Server stopped while uploading inputs; nothing was sent', httpStatus: null, code: 'interrupted' }; job.message = 'Interrupted before dispatch; nothing was sent. Submit again to resume.'; }
    // Receipts written before attachment was recorded: re-attach only when the legacy library lacks a result
    // (the director copies results lazily on its own sync, so an archived project never blocks this).
    if (requiresAttachment && job.status === 'completed' && !job.attachment?.completedAt) {
      if (options.attached?.(job)) job.attachment = { completedAt: job.completedAt || job.finishedAt || now(), migrated: true };
      else job.status = 'attaching';
    }
    // Stopped earlier because its project was archived or deleted: retry once more, so it can become orphaned (terminal) or complete.
    if (requiresAttachment && job.status === 'recovery-required' && job.failure?.phase === 'attachment' && /Unknown project/.test(job.failure.detail || '')) { job.status = 'attaching'; job.recovery = { ...job.recovery, attachment: 0 }; }
    await persist(job);
  }
  const slots = options.slots || slotsFor(root), uploadCache = options.uploadCache || uploadCacheFor(root), downloads = options.downloads || downloadsFor(root);
  slots.register('generation', () => [...jobs.values()].filter(active).map(job => ({ id: job.id, backend: job.backend, kind: generationKind(job), status: job.status, uncertainAt: job.uncertainAt, dispatchStartedAt: job.dispatchStartedAt, createdAt: job.createdAt })));
  // Journal operations are serialized per request id (a slow download for one job never delays another job).
  // Submits of identical content also share a lock, so duplicate simultaneous submits are still refused.
  const lock = keyedLock();
  const serial = (fn, keyOf) => (input, ...rest) => lock(String(keyOf(input) ?? '').toLowerCase(), () => fn(input, ...rest));
  const byRequest = fn => serial(fn, input => input?.requestId), byJob = fn => serial(fn, id => id), byJobId = fn => serial(fn, input => input?.jobId);
  const get = id => {
    const job = jobs.get(String(id).toLowerCase());
    if (!job) fail('Generation request not found', 404);
    return structuredClone(job);
  };
  const backendFor = selection => options.backendFactory ? options.backendFactory(selection) : createBackend(selection, options);
  function identity(input) {
    if (!uuid.test(input.requestId || '')) fail('A request UUID is required');
    return input.requestId.toLowerCase();
  }
  async function readSource(asset, render) {
    let bytes;
    if (render) {
      if (!uuid.test(render.id)) fail('Invalid source render identity');
      bytes = await readFile(join(root, 'renders', render.id + '.png'));
    } else if (options.readAsset) bytes = await options.readAsset(structuredClone(asset));
    else {
      safeMediaLocation({ filename: asset.filename, subfolder: '', type: 'output' });
      const collection=asset.mime==='image/png'&&uuid.test(asset.id)&&asset.url===`/renders/${asset.id}.png`?'renders':'assets';
      bytes = await readFile(join(root, collection, asset.filename));
    }
    bytes = Buffer.from(bytes);
    if (!bytes.length || bytes.length > (options.maxMediaBytes || 512 * 1024 * 1024)) fail('Source asset has an unsupported size');
    if (asset.sha256 && asset.sha256 !== hashBytes(bytes)) fail(`Source asset ${asset.id} hash changed; import and rebind the asset`);
    return bytes;
  }
  async function resolve(input) {
    // Revalidation is scoped to this binding: its definition, shot, source bytes, backend, schema and
    // quote are fingerprinted below. Unrelated project edits (other bindings, other shots) do not invalidate.
    const p = project.get();
    if (input.revision !== undefined && (!Number.isInteger(input.revision) || input.revision > p.revision)) fail('Unknown project revision; refresh and prepare again', 409);
    const binding = p.workflowBindings?.find(item => item.id === input.workflowBindingId);
    if (!binding) fail('Save an explicit workflow binding first');
    const definition = binding.definition ? validateWorkflowDefinition(binding.definition) : binding.definitionId ? validateWorkflowDefinition(p.workflowDefinitions?.find(item => item.id === binding.definitionId)) : legacyWorkflowDefinition(binding);
    const shot = p.shots?.find(item => item.id === binding.shotId);
    if (!shot) fail('Originating shot is missing');
    const selection = backendSnapshot(input.backend || options.backend || {});
    if (definition.backendRequirements.kinds && !definition.backendRequirements.kinds.includes(selection.kind)) fail('Workflow backend requirements exclude this backend');
    const graph = structuredClone(definition.graph), sources = {}, bytes = {}, deferredInputs = [];
    const assetBindings = binding.assetBindings || (binding.renderId ? { image: { renderId: binding.renderId } } : {});
    if (Object.keys(assetBindings).some(name => !definition.inputs[name] || name === 'prompt')) fail('Asset binding has no matching semantic workflow input');
    for (const [name, mapping] of Object.entries(definition.inputs)) {
      if (name === 'prompt') {
        if (binding.prompt !== undefined) {
          if (typeof binding.prompt !== 'string') fail('Prompt must be a string');
          if (Number.isInteger(definition.constraints.promptMaxLength) && binding.prompt.length > definition.constraints.promptMaxLength) fail('Prompt exceeds workflow maximum length');
          graph[mapping.nodeId].inputs[mapping.input] = binding.prompt;
        }
        continue;
      }
      const source = assetBindings[name];
      if (!source || (!!source.assetId === !!source.renderId)) fail(`Explicitly bind ${name} to one project asset or saved render`);
      const render = source.renderId ? p.renders?.find(item => item.id === source.renderId) : null;
      // A generated source asset is read with its full provenance, as it was before references (B23), so quotes keep their fingerprint.
      const original = render ? { ...render, kind: 'image', mime: 'image/png', filename: render.id + '.png' } : expandAsset(p.assets?.find(item => item.id === source.assetId), id => jobs.get(String(id).toLowerCase()));
      const asset = original ? { ...original, mime: original.mime || original.mimeType } : null;
      if (asset && !asset.filename && uuid.test(asset.id) && asset.url === `/assets/${asset.id}${extensions[asset.mime]}`) asset.filename = asset.id + extensions[asset.mime];
      if (!asset || !asset.binding || !extensions[asset.mime]) fail(`Source ${name} is missing or lacks media/provenance metadata`);
      const expected = ['sourceVideo', 'controlVideo', 'maskVideo'].includes(name) ? 'video' : name === 'audio' ? 'audio' : 'image';
      if (asset.kind !== expected || !asset.mime.startsWith(expected + '/')) fail(`${name} requires ${expected} media`);
      if (expected !== 'audio' && (!Number.isInteger(asset.width) || !Number.isInteger(asset.height) || asset.width < 1 || asset.height < 1)) fail(`Source ${name} requires width and height`);
      if (expected === 'video' && (!Number.isFinite(asset.fps) || asset.fps <= 0 || !Number.isInteger(asset.frameCount) || asset.frameCount <= 0 || !Number.isFinite(asset.duration) || asset.duration <= 0 || !/^[a-f0-9]{64}$/.test(asset.sha256 || ''))) fail(`Source ${name} requires fps, frameCount, duration and sha256`);
      if (name === 'controlVideo' && asset.pass !== mapping.pass) fail(`Control pass must be ${mapping.pass}`);
      validateAssetConstraints(asset, definition.constraints[name]);
      bytes[name] = await readSource(asset, render);
      sources[name] = { ...asset, sha256: hashBytes(bytes[name]), sourceType: render ? 'render' : 'asset' };
      deferredInputs.push({ ...mapping, kind: expected, mime: asset.mime, filename: asset.filename });
    }
    if (isMaskedEditDefinition(definition)) {
      const src = sources.sourceVideo, mask = sources.maskVideo;
      if (src && mask && (src.frameCount !== mask.frameCount || src.fps !== mask.fps || src.width !== mask.width || src.height !== mask.height)) {
        fail('maskVideo must match sourceVideo width, height, fps and frameCount');
      }
    }
    for (const [name, value] of Object.entries(binding.parameters || {})) {
      const mapping = definition.parameters[name];
      if (!mapping) fail(`Parameter ${name} has no explicit workflow mapping`);
      graph[mapping.nodeId].inputs[mapping.input] = structuredClone(value);
    }
    assertNoSecrets({ binding, definition, graph, sources });
    const adapter = backendFor(selection), inspected = await adapter.inspect();
    if (hashValue(adapter.snapshot) !== hashValue(selection)) fail('Backend adapter identity mismatch');
    const validation = validateGraph(graph, inspected.objectInfo, { deferredInputs });
    for (const output of definition.outputs) if (inspected.objectInfo[graph[output.nodeId].class_type]?.output_node !== true) validation.issues.push({ code: 'unsupported-output', nodeId: output.nodeId, message: 'Declared output is not an output node in the live schema' });
    for (const classType of definition.backendRequirements.nodes || []) if (!inspected.objectInfo[classType]) validation.issues.push({ code: 'missing-node', classType, message: `Backend requirement ${classType} is unavailable` });
    if (definition.constraints.timingChange && binding.acceptTimingChange !== true) validation.issues.push({code:'timing-review',message:'Explicit timing/framing acknowledgment required: '+definition.constraints.timingChange});
    validation.compatible = !validation.issues.length;
    let quote = workflowCost(graph, inspected.objectInfo, selection);
    quote = applyTrustedMaskedEstimate(quote, definition, sources, { marginPct: budget.marginPct?.() ?? 10 });
    const purpose = isMaskedEditDefinition(definition) ? MASKED_EDIT_PURPOSE : 'ordinary';
    // Fingerprint includes source/mask hashes (via sources), trusted estimate and rate version (via quote).
    const context = { requestId: identity(input), projectId: p.id, shotId: shot.id, shot, workflowBindingId: binding.id, binding, cameraSource: cameraSourceOf(definition, assetBindings), definition, definitionHash: definition.definitionHash, graphHash: definition.graphHash, preparedGraph: graph, sources, references: p.references || [], backend: selection, schemaHash: validation.schemaHash, quote, purpose };
    assertNoSecrets(context);
    // requestRevision is provenance only; it stays out of the fingerprint.
    return { context: { ...context, requestRevision: Number.isInteger(input.revision) ? input.revision : p.revision }, fingerprint: hashValue(context), validation, adapter, bytes, deferredInputs };
  }
  async function prepare(input, quoted = false) {
    const id = identity(input), previous = jobs.get(id);
    if (previous && previous.workflowBindingId !== input.workflowBindingId) fail('Request UUID belongs to another binding', 409);
    if (previous && !draft(previous)) return get(id);
    const resolved = await resolve(input);
    return persist({ id, ...resolved.context, validation: resolved.validation, fingerprint: resolved.fingerprint, status: quoted ? 'quoted' : 'prepared', verification: { status: resolved.validation.compatible ? 'schema-compatible' : 'imported' }, createdAt: previous?.createdAt || now(), preparedAt: now(), ...(quoted ? { quotedAt: now() } : {}), results: [] });
  }
  // An identical request (same definition, graph, source bytes and backend) that is running, or finished within the window.
  function duplicateOf(saved) {
    if (generationKind(saved) !== 'video') return null;
    const key = contentKey(saved), window = options.duplicateWindowMs ?? duplicateWindowMs(), at = Date.now();
    return [...jobs.values()].find(job => job.id !== saved.id && job.shotId === saved.shotId && (active(job) || job.status === 'recovery-required' || (job.status === 'completed' && at - Date.parse(job.completedAt || job.createdAt) < window)) && contentKey(job) === key) || null;
  }
  // A submit refused before dispatch leaves the draft as it was; record why, so /api/jobs shows it (busy is routine, not recorded).
  async function noteRefusal(id, error) {
    const latest = jobs.get(id);
    if (!latest || !draft(latest) || error.apiCode === 'busy') return;
    await persist({ ...latest, lastAttempt: { at: now(), error: errorDetail(error), httpStatus: error.httpStatus || null, code: error.apiCode || null, ...(error.existingId ? { existingId: error.existingId } : {}) } }).catch(() => {});
  }
  async function submit(input) {
    const id = identity(input), saved = get(id);
    if (saved.workflowBindingId !== input.workflowBindingId) fail('Request UUID belongs to another binding', 409);
    if (!draft(saved)) return saved;
    try {
      if (saved.status !== 'quoted') fail('Prepare and quote this request before submission', 409);
      const release = slots.acquire({ id, backend: saved.backend, kind: generationKind(saved) });
      try { return await lock(`content:${contentKey(saved)}`, () => dispatch(input, id, saved)); } finally { release(); }
    } catch (error) { await noteRefusal(id, error); throw error; }
  }
  async function dispatch(input, id, saved) {
    const current = await resolve(input);
    if (saved.fingerprint !== current.fingerprint) {
      await persist({ ...saved, status: 'invalidated', validation: current.validation, message: 'Graph, inputs, project, backend, pricing or live schema changed. Prepare and approve a new quote.' });
      fail('Approval invalidated; prepare and quote again', 409);
    }
    if (!current.validation.compatible) fail('Workflow is not schema-compatible; inspect validation issues');
    validateApproval(input.approval, saved.fingerprint, saved.quote);
    if (saved.purpose === MASKED_EDIT_PURPOSE || isMaskedEditDefinition(saved.definition)) {
      if (!Number.isFinite(saved.quote?.estimate) || saved.quote.estimate < 0) fail('No reliable estimate is available. Nothing submitted.');
      if (saved.quote?.providerEnforcedCap === true) fail('A provider-enforced spending limit is unavailable for this route. Nothing submitted.');
      // Client-forged cheaper estimates are ignored: only the server fingerprint (with trusted estimate) is authoritative.
    }
    const twin = input.allowDuplicate === true ? null : duplicateOf(saved);
    if (twin) throw Object.assign(Error(`An identical request is already ${active(twin) ? twin.status : 'completed'} (${twin.id}); nothing was sent. Use it, or pass allowDuplicate to generate again.`), { status: 409, apiCode: 'duplicate', existingId: twin.id });

    if ((saved.quote.status !== 'known' || saved.quote.amount > 0) && options.allowPaid !== true) fail('Paid and unknown-charge submissions are disabled at this checkpoint');
    const adapter = current.adapter;
    async function requireIdle() {
      if (saved.backend.kind !== 'local') return;
      const queue = await adapter.queue();
      if (queue.queue_running.length || queue.queue_pending.length) fail('Local Comfy queue is busy; Previs will not interrupt it', 409);
    }
    await requireIdle();
    // Durable reservation before any upload or dispatch; refused (402, code 'budget') over a cap or at an unknown price.
    const estimateUsd = generationEstimate(saved);
    if (estimateUsd !== 0) await budget.reserve({ id, source: 'generation', projectId: saved.shot?.browser?.director?.projectId || null, kind: generationKind(saved), model: saved.definition?.title || null, label: generationLabel(saved), estimateUsd });
    // A local request gets its own live-progress client ID, saved before any upload and reused for dispatch.
    let job = await persist({ ...saved, approval: structuredClone(input.approval), status: 'uploading', message: 'Request UUID saved before uploads and dispatch.', promptId: saved.backend.kind === 'local' ? id : null,
      ...(saved.backend.kind === 'local' ? { progressClientId: saved.progressClientId || randomUUID() } : {}) });
    let dispatchStarted = false;
    const observing = telemetry.begin(job); telemetry.phase(job, 'uploading');
    try {
      const graph = structuredClone(saved.preparedGraph), uploads = {};
      for (const [name, source] of Object.entries(saved.sources)) {
        const mapping = saved.definition.inputs[name];
        const upload = await uploadCache.upload(adapter, current.bytes[name], { filename: `${id}-${name}${extensions[source.mime]}`, mime: source.mime, subfolder: `previs/${id}` });
        uploads[name] = upload; graph[mapping.nodeId].inputs[mapping.input] = upload.value;
      }
      // Revalidate after uploads, immediately before the durable dispatch boundary.
      const fresh = await resolve(input);
      if (fresh.fingerprint !== saved.fingerprint || !fresh.validation.compatible) fail('Request changed during preparation; no prompt was submitted');
      await observing; // Bounded: an unavailable observer only means polling.
      await requireIdle();
      job = await persist({ ...job, status: 'submitting', submittedGraph: graph, submittedGraphHash: hashValue(graph), uploads, dispatchStartedAt: now(), message: 'Dispatch started. Never repeat this request.' });
      dispatchStarted = true; telemetry.phase(job, 'submitting');
      const accepted = await adapter.submit({ graph, requestId: id, projectId: saved.projectId, partnerNodes: saved.quote.nodes.some(node => node.apiNode), ...(job.progressClientId ? { clientId: job.progressClientId } : {}) });
      job = await persist({ ...job, promptId: accepted.promptId, status: 'queued', message: 'Backend accepted the request. Track the saved prompt ID.', acceptedAt: now() });
      telemetry.accept(job); // Only after the acceptance receipt is durable.
      return job;
    } catch (error) {
      // Never persist raw response bodies or exception strings (they can carry credentials): only errorDetail's redacted ≤500 chars.
      // notSent: the adapter proved the prompt never reached the backend (connection refused, or refused before queuing).
      const definitelyRejected = error.notSent === true || [400, 401, 402, 403, 422, 429].includes(error.httpStatus);
      const status = dispatchStarted && !definitelyRejected ? 'uncertain' : 'failed';
      return persist({ ...job, status, message: status === 'uncertain' ? 'Dispatch outcome is unknown. Preserve this receipt and inspect backend history; never resubmit.' : 'Preparation failed or backend rejected the request. No automatic retry.', failure: { phase: dispatchStarted ? 'dispatch' : 'preparation', httpStatus: error.httpStatus || null, detail: errorDetail(error), ...(error.attempts > 1 ? { attempts: error.attempts } : {}), ...(dispatchStarted && definitelyRejected ? { notSent: true } : {}) } });
    }
  }
  // `tracking` ({ lastTrackedAt, trackCount, nextTrackAt }) comes from the job tracker and is saved with the result.
  async function track(id, tracking) {
    let job = get(id);
    if (draft(job) || ['failed', 'closed', 'completed', 'recovery-required'].includes(job.status)) return job;
    if (tracking) job = { ...job, tracking: { lastTrackedAt: tracking.lastTrackedAt ?? null, trackCount: tracking.trackCount ?? 0, nextTrackAt: tracking.nextTrackAt ?? null } };
    if (job.status === 'attaching') return finishAttachment(job);
    if (!job.promptId) return persist({ ...job, status: 'uncertain', message: 'Cloud acceptance ID was not received. Inspect the account history using this request UUID. No retry or guessed prompt ID.' });
    const adapter = backendFor(job.backend);
    if (hashValue(adapter.snapshot) !== hashValue(job.backend)) fail('This request belongs to another backend', 409);
    let phase = 'history';
    try {
      if (!job.collection) {
        const entry = await adapter.history(job.promptId);
        if (!entry) {
          const queue = await adapter.queue();
          const running = queue.queue_running.some(row => row[1] === job.promptId), pending = queue.queue_pending.some(row => row[1] === job.promptId);
          return persist({ ...job, status: running ? 'running' : pending ? 'queued' : 'uncertain', message: running || pending ? 'Exact prompt ID is in the backend queue.' : 'Prompt absent from queue/history; outcome remains unknown. Never retry this request.' });
        }
        phase = 'identity';
        if (entry.promptId !== job.promptId || entry.requestId !== job.id || hashValue(entry.graph) !== job.submittedGraphHash) fail('Backend history does not match this saved request');
        if (['error', 'non_retryable_error', 'cancelled', 'lost'].includes(entry.status?.status_str)) {
          const provider = { status: entry.status.status_str, ...(entry.error ? { error: entry.error } : {}) };
          const detail = entry.error ? errorDetail({ message: `${entry.error.nodeType || 'Node'}${entry.error.nodeId ? ` #${entry.error.nodeId}` : ''}: ${entry.error.message}` }) : null;
          return persist({ ...job, status: 'failed', provider, failure: { phase: 'execution', httpStatus: null, detail }, finishedAt: now(), message: `Backend reports failure${detail ? ` (${detail.slice(0, 240)})` : ''}; execution may have incurred charges. No retry.` });
        }
        if (entry.status?.completed !== true) return persist({ ...job, status: 'running', message: 'Backend has not marked execution complete.' });
        phase = 'declared-outputs';
        const declared = declaredOutputs(job.definition, entry.outputs);
        job = await persist({ ...job, status: 'collecting', collection: declared, verification: { status: 'executed' } });
      }
      if (recoveryAttempts(job, 'collection') >= RECOVERY_ATTEMPTS) return recoveryStopped(job);
      job = await persist(beginRecovery(job, 'collection'));
      for (const output of job.collection) {
        if (job.results.some(result => result.key === output.key)) continue;
        phase = 'media-transfer';
        const bytes = await downloads(() => adapter.view(output.location));
        phase = 'media-probe';
        let media;
        if (output.mediaType === 'image/png') media = probePng(bytes);
        else {
          if (!options.probeVideo) fail('Video probe helper is required before saving video outputs');
          media = await options.probeVideo(bytes, { mime: output.mediaType, filename: output.location.filename });
          if (!media || !Number.isInteger(media.width) || !Number.isInteger(media.height) || media.width < 1 || media.height < 1 || !Number.isFinite(media.fps) || media.fps <= 0 || !Number.isInteger(media.frameCount) || media.frameCount < 1 || !Number.isFinite(media.duration) || media.duration <= 0 || ((media.mime || media.mimeType) && (media.mime || media.mimeType) !== output.mediaType)) fail('Video probe returned incompatible media metadata');
        }
        assertNoSecrets(media);
        const resultId = recoveryId(job.id, output.key), filename = resultId + extensions[output.mediaType];
        const folder = output.mediaType === 'image/png' ? 'renders' : 'assets';
        phase = 'media-save';
        await mkdir(join(root, folder), { recursive: true });
        await saveResultBytes(join(root, folder, filename), bytes);
        const result = { ...media, id: resultId, filename, url: `/${folder}/${filename}`, kind: output.mediaType === 'image/png' ? 'image' : 'video', mime: output.mediaType, mimeType: output.mediaType, sha256: hashBytes(bytes), nodeId: output.nodeId, key: output.key, backend: output.location, shotId: job.shotId, requestRevision: job.requestRevision, generationJobId: job.id, createdAt: now() };
        job = await persist({ ...job, results: [...job.results, result] });
      }
      const masked = job.purpose === MASKED_EDIT_PURPOSE || isMaskedEditDefinition(job.definition);
      if (masked && job.results.length) {
        const candDir = join(root, 'masked-edits', job.id);
        await mkdir(candDir, { recursive: true });
        await atomicJson(join(candDir, 'candidate.json'), {
          v: 1, jobId: job.id, purpose: MASKED_EDIT_PURPOSE, quarantined: true, verified: true,
          resultIds: job.results.map(r => r.id), resultSha256: job.results.map(r => r.sha256),
          sourceSha256: job.sources?.sourceVideo?.sha256 || null, maskSha256: job.sources?.maskVideo?.sha256 || null,
          fingerprint: job.fingerprint, at: now(),
        });
        job = { ...job, purpose: MASKED_EDIT_PURPOSE, quarantine: true, maskedEdit: { candidatePath: `masked-edits/${job.id}/candidate.json`, durable: true } };
      }
      job = await persist({ ...job, failure: null, tracking: { ...job.tracking, error: null }, status: requiresAttachment ? 'attaching' : 'completed', ...(requiresAttachment ? {} : { completedAt: now() }), message: masked ? 'Masked patch collected and quarantined. Local composite/accept is required before it can become a take.' : 'Only declared outputs were probed and saved. Timing and visual quality require review; no timing fit was performed.' });
      return requiresAttachment ? finishAttachment(job) : job;
    } catch (error) {
      return persist({ ...job, ...(job.collection && recoveryAttempts(job, 'collection') >= RECOVERY_ATTEMPTS ? { status: 'recovery-required' } : {}), failure: { phase, detail: errorDetail(error) }, tracking: { ...job.tracking, error: errorDetail(error) }, message: `Tracking failed at ${phase}. Preserve the receipt; no resubmission or undeclared output collection occurred.` });
    }
  }
  const recoveryStopped = job => persist({ ...job, status: 'recovery-required', message: 'Recovery attempt limit reached. Preserve this receipt and recover existing output; never resubmit.' });
  async function finishAttachment(job) {
    if (recoveryAttempts(job, 'attachment') >= RECOVERY_ATTEMPTS) return recoveryStopped(job);
    job = await persist(beginRecovery(job, 'attachment'));
    try {
      if (!attachResults) throw Error('Result attachment handler is unavailable');
      await attachResults(structuredClone(job));
      return persist({ ...job, status: 'completed', completedAt: now(), attachment: { completedAt: now() }, failure: null, tracking: { ...job.tracking, error: null }, message: 'Outputs collected and attached. Visual quality still requires review.' });
    } catch (error) {
      // Its project was archived or deleted: terminal, not stuck. Outputs stay in the library; the user can dismiss the row.
      if (error.orphaned) return persist({ ...job, status: 'orphaned', orphanedAt: now(), ...(job.completedAt ? {} : { finishedAt: now() }), failure: null, tracking: { ...job.tracking, error: null }, message: 'Its project was archived or deleted. Outputs are kept in the library; nothing was resubmitted.' });
      return persist({ ...job, status: recoveryAttempts(job, 'attachment') >= RECOVERY_ATTEMPTS ? 'recovery-required' : 'attaching', failure: { phase: 'attachment', detail: errorDetail(error) }, tracking: { ...job.tracking, error: errorDetail(error) }, message: 'Output attachment failed. Only attachment of existing results may be retried; no resubmission.' });
    }
  }
  async function reconcile(input) {
    const job = get(input.jobId);
    if (job.status !== 'uncertain' || input.backendIdle !== true || input.historyReviewed !== true) fail('Confirm the exact uncertain request, backend idle and reviewed history; this does not cancel or retry it', 409);
    const checked = await track(job.id);
    if (checked.status !== 'uncertain') return checked;
    const queue = await backendFor(job.backend).queue();
    if (queue.queue_running.length || queue.queue_pending.length) fail('Backend queue must be empty before closing an uncertain receipt', 409);
    return persist({ ...checked, status: 'closed', closedAt: now(), message: 'Operator reviewed backend history and confirmed idle. Outcome remains unknown; no cancellation or retry.' });
  }
  // Hides an orphaned receipt from the jobs list; the receipt and its outputs stay on disk.
  async function dismiss(input) {
    const job = get(input.jobId);
    if (job.status !== 'orphaned') fail('Only a job whose project was archived or deleted can be dismissed', 409);
    return job.dismissedAt ? job : persist({ ...job, dismissedAt: now() });
  }
  /** Jobs that syncResults must skip (quarantined masked patches). Sol’s director.syncResults should honor purpose. */
  const listForSync = () => [...jobs.values()].filter(job => job.purpose !== MASKED_EDIT_PURPOSE && !isMaskedEditDefinition(job.definition)).map(job => structuredClone(job));
  async function durableMaskedCandidate(job) {
    if (!(job.purpose === MASKED_EDIT_PURPOSE || isMaskedEditDefinition(job.definition))) return false;
    if (!job.results?.length) return false;
    try {
      await access(join(root, 'masked-edits', job.id, 'candidate.json'));
      return true;
    } catch { return Boolean(job.maskedEdit?.durable); }
  }
  return { setAttachment: fn => { attachResults = fn; }, dismiss: byJobId(dismiss), prepare: byRequest(input => prepare(input)), quote: byRequest(input => prepare(input, true)), submit: byRequest(submit), track: byJob(track), reconcile: byJobId(reconcile), get, list: () => [...jobs.values()].map(job => structuredClone(job)), listForSync, durableMaskedCandidate, inspect: selection => backendFor(backendSnapshot(selection || options.backend || {})).inspect(), isActive: active, kindOf: generationKind, expectedSeconds, label: generationLabel, estimate: generationEstimate, duplicateOf: job => duplicateOf(job) };
}
