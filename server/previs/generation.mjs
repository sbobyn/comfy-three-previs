import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson } from './atomic.mjs';
import { createBackend, backendSnapshot, safeMediaLocation } from './backends.mjs';
import { assertNoSecrets, hashBytes, hashValue, validateWorkflowDefinition, legacyWorkflowDefinition, validateGraph, workflowCost, validateApproval } from './workflows.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const draft = job => ['prepared', 'quoted', 'invalidated'].includes(job.status);
const active = job => ['uploading', 'submitting', 'queued', 'running', 'uncertain', 'collecting'].includes(job.status);
const fail = (message, status = 400) => { const error = Error(message); error.status = status; throw error; };
const now = () => new Date().toISOString();
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
  const writer = options.persist || atomicJson;
  const persist = async job => {
    assertNoSecrets(job);
    await writer(join(dir, job.id + '.json'), job);
    jobs.set(job.id, structuredClone(job));
    return structuredClone(job);
  };
  for (const file of await readdir(dir)) if (/^[a-f0-9-]{36}\.json$/i.test(file)) {
    const job = JSON.parse(await readFile(join(dir, file), 'utf8'));
    if (!uuid.test(job.id) || file.toLowerCase() !== job.id.toLowerCase() + '.json') fail('Invalid generation receipt identity');
    if (job.status === 'submitting') { job.status = 'uncertain'; job.message = 'Stopped during dispatch. Backend execution may continue; never resubmit this request.'; }
    if (job.status === 'uploading') { job.status = 'failed'; job.message = 'Stopped before dispatch; uploaded inputs may remain. This request will not be retried.'; }
    await persist(job);
  }
  // Serialize journal operations, including duplicate simultaneous submits.
  let chain = Promise.resolve();
  const serial = fn => (...args) => { const task = chain.then(() => fn(...args)); chain = task.catch(() => {}); return task; };
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
      bytes = await readFile(join(root, 'assets', asset.filename));
    }
    bytes = Buffer.from(bytes);
    if (!bytes.length || bytes.length > (options.maxMediaBytes || 512 * 1024 * 1024)) fail('Source asset has an unsupported size');
    if (asset.sha256 && asset.sha256 !== hashBytes(bytes)) fail(`Source asset ${asset.id} hash changed; import and rebind the asset`);
    return bytes;
  }
  async function resolve(input) {
    const p = project.get();
    if (input.revision !== p.revision) fail('Project changed; prepare and quote again', 409);
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
          graph[mapping.nodeId].inputs[mapping.input] = binding.prompt;
        }
        continue;
      }
      const source = assetBindings[name];
      if (!source || (!!source.assetId === !!source.renderId)) fail(`Explicitly bind ${name} to one project asset or saved render`);
      const render = source.renderId ? p.renders?.find(item => item.id === source.renderId) : null;
      const original = render ? { ...render, kind: 'image', mime: 'image/png', filename: render.id + '.png' } : p.assets?.find(item => item.id === source.assetId);
      const asset = original ? { ...original, mime: original.mime || original.mimeType } : null;
      if (asset && !asset.filename && uuid.test(asset.id) && asset.url === `/assets/${asset.id}${extensions[asset.mime]}`) asset.filename = asset.id + extensions[asset.mime];
      if (!asset || !asset.binding || !extensions[asset.mime]) fail(`Source ${name} is missing or lacks media/provenance metadata`);
      const expected = ['sourceVideo', 'controlVideo'].includes(name) ? 'video' : name === 'audio' ? 'audio' : 'image';
      if (asset.kind !== expected || !asset.mime.startsWith(expected + '/')) fail(`${name} requires ${expected} media`);
      if (expected !== 'audio' && (!Number.isInteger(asset.width) || !Number.isInteger(asset.height) || asset.width < 1 || asset.height < 1)) fail(`Source ${name} requires width and height`);
      if (expected === 'video' && (!Number.isFinite(asset.fps) || asset.fps <= 0 || !Number.isInteger(asset.frameCount) || asset.frameCount <= 0 || !Number.isFinite(asset.duration) || asset.duration <= 0 || !/^[a-f0-9]{64}$/.test(asset.sha256 || ''))) fail(`Source ${name} requires fps, frameCount, duration and sha256`);
      if (name === 'controlVideo' && asset.pass !== mapping.pass) fail(`Control pass must be ${mapping.pass}`);
      validateAssetConstraints(asset, definition.constraints[name]);
      bytes[name] = await readSource(asset, render);
      sources[name] = { ...asset, sha256: hashBytes(bytes[name]), sourceType: render ? 'render' : 'asset' };
      deferredInputs.push({ ...mapping, kind: expected, mime: asset.mime, filename: asset.filename });
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
    validation.compatible = !validation.issues.length;
    const quote = workflowCost(graph, inspected.objectInfo, selection);
    const context = { requestId: identity(input), projectId: p.id, requestRevision: p.revision, shotId: shot.id, shot, workflowBindingId: binding.id, binding, definition, definitionHash: definition.definitionHash, graphHash: definition.graphHash, preparedGraph: graph, sources, references: p.references || [], backend: selection, schemaHash: validation.schemaHash, quote };
    assertNoSecrets(context);
    return { context, fingerprint: hashValue(context), validation, adapter, bytes, deferredInputs };
  }
  async function prepare(input, quoted = false) {
    const id = identity(input), previous = jobs.get(id);
    if (previous && previous.workflowBindingId !== input.workflowBindingId) fail('Request UUID belongs to another binding', 409);
    if (previous && !draft(previous)) return get(id);
    const resolved = await resolve(input);
    return persist({ id, ...resolved.context, validation: resolved.validation, fingerprint: resolved.fingerprint, status: quoted ? 'quoted' : 'prepared', verification: { status: resolved.validation.compatible ? 'schema-compatible' : 'imported' }, createdAt: previous?.createdAt || now(), preparedAt: now(), ...(quoted ? { quotedAt: now() } : {}), results: [] });
  }
  async function submit(input) {
    const id = identity(input), saved = get(id);
    if (saved.workflowBindingId !== input.workflowBindingId) fail('Request UUID belongs to another binding', 409);
    if (!draft(saved)) return saved;
    if (saved.status !== 'quoted') fail('Prepare and quote this request before submission', 409);
    if ([...jobs.values()].some(job => job.id !== id && active(job) && hashValue(job.backend) === hashValue(saved.backend))) fail('Resolve the existing backend request before another submission; uncertainty must never cause a retry', 409);
    const current = await resolve(input);
    if (saved.fingerprint !== current.fingerprint) {
      await persist({ ...saved, status: 'invalidated', validation: current.validation, message: 'Graph, inputs, project, backend, pricing or live schema changed. Prepare and approve a new quote.' });
      fail('Approval invalidated; prepare and quote again', 409);
    }
    if (!current.validation.compatible) fail('Workflow is not schema-compatible; inspect validation issues');
    validateApproval(input.approval, saved.fingerprint, saved.quote);
    if ((saved.quote.status !== 'known' || saved.quote.amount > 0) && options.allowPaid !== true) fail('Paid and unknown-charge submissions are disabled at this checkpoint');
    const adapter = current.adapter;
    async function requireIdle() {
      if (saved.backend.kind !== 'local') return;
      const queue = await adapter.queue();
      if (queue.queue_running.length || queue.queue_pending.length) fail('Local Comfy queue is busy; Previs will not interrupt it', 409);
    }
    await requireIdle();
    let job = await persist({ ...saved, approval: structuredClone(input.approval), status: 'uploading', message: 'Request UUID saved before uploads and dispatch.', promptId: saved.backend.kind === 'local' ? id : null });
    let dispatchStarted = false;
    try {
      const graph = structuredClone(saved.preparedGraph), uploads = {};
      for (const [name, source] of Object.entries(saved.sources)) {
        const mapping = saved.definition.inputs[name];
        const upload = await adapter.upload(current.bytes[name], { filename: `${id}-${name}${extensions[source.mime]}`, mime: source.mime, subfolder: `previs/${id}` });
        uploads[name] = upload; graph[mapping.nodeId].inputs[mapping.input] = upload.value;
      }
      // Revalidate after uploads, immediately before the durable dispatch boundary.
      const fresh = await resolve(input);
      if (fresh.fingerprint !== saved.fingerprint || !fresh.validation.compatible) fail('Request changed during preparation; no prompt was submitted');
      await requireIdle();
      job = await persist({ ...job, status: 'submitting', submittedGraph: graph, submittedGraphHash: hashValue(graph), uploads, dispatchStartedAt: now(), message: 'Dispatch started. Never repeat this request.' });
      dispatchStarted = true;
      const accepted = await adapter.submit({ graph, requestId: id, projectId: saved.projectId, partnerNodes: saved.quote.nodes.some(node => node.apiNode) });
      return await persist({ ...job, promptId: accepted.promptId, status: 'queued', message: 'Backend accepted the request. Track the saved prompt ID.', acceptedAt: now() });
    } catch (error) {
      // Do not persist backend response bodies or arbitrary exception strings: they can contain credentials.
      const definitelyRejected = [400, 401, 402, 403, 422, 429].includes(error.httpStatus);
      const status = dispatchStarted && !definitelyRejected ? 'uncertain' : 'failed';
      return persist({ ...job, status, message: status === 'uncertain' ? 'Dispatch outcome is unknown. Preserve this receipt and inspect backend history; never resubmit.' : 'Preparation failed or backend rejected the request. No automatic retry.', failure: { phase: dispatchStarted ? 'dispatch' : 'preparation', httpStatus: error.httpStatus || null } });
    }
  }
  async function track(id) {
    let job = get(id);
    if (draft(job) || ['failed', 'closed', 'completed'].includes(job.status)) return job;
    if (!job.promptId) return persist({ ...job, status: 'uncertain', message: 'Cloud acceptance ID was not received. Inspect the account history using this request UUID. No retry or guessed prompt ID.' });
    const adapter = backendFor(job.backend);
    if (hashValue(adapter.snapshot) !== hashValue(job.backend)) fail('This request belongs to another backend', 409);
    let phase = 'history';
    try {
      const entry = await adapter.history(job.promptId);
      if (!entry) {
        const queue = await adapter.queue();
        const running = queue.queue_running.some(row => row[1] === job.promptId), pending = queue.queue_pending.some(row => row[1] === job.promptId);
        return persist({ ...job, status: running ? 'running' : pending ? 'queued' : 'uncertain', message: running || pending ? 'Exact prompt ID is in the backend queue.' : 'Prompt absent from queue/history; outcome remains unknown. Never retry this request.' });
      }
      phase = 'identity';
      if (entry.promptId !== job.promptId || entry.requestId !== job.id || hashValue(entry.graph) !== job.submittedGraphHash) fail('Backend history does not match this saved request');
      if (['error', 'non_retryable_error', 'cancelled', 'lost'].includes(entry.status?.status_str)) return persist({ ...job, status: 'failed', message: 'Backend reports failure; execution may have incurred charges. No retry.' });
      if (entry.status?.completed !== true) return persist({ ...job, status: 'running', message: 'Backend has not marked execution complete.' });
      phase = 'declared-outputs';
      const declared = declaredOutputs(job.definition, entry.outputs);
      job = await persist({ ...job, status: 'collecting', verification: { status: 'executed' } });
      for (const output of declared) {
        if (job.results.some(result => result.key === output.key)) continue;
        phase = 'media-transfer';
        const bytes = await adapter.view(output.location);
        phase = 'media-probe';
        let media;
        if (output.mediaType === 'image/png') media = probePng(bytes);
        else {
          if (!options.probeVideo) fail('Video probe helper is required before saving video outputs');
          media = await options.probeVideo(bytes, { mime: output.mediaType, filename: output.location.filename });
          if (!media || !Number.isInteger(media.width) || !Number.isInteger(media.height) || media.width < 1 || media.height < 1 || !Number.isFinite(media.fps) || media.fps <= 0 || !Number.isInteger(media.frameCount) || media.frameCount < 1 || !Number.isFinite(media.duration) || media.duration <= 0 || ((media.mime || media.mimeType) && (media.mime || media.mimeType) !== output.mediaType)) fail('Video probe returned incompatible media metadata');
        }
        assertNoSecrets(media);
        const resultId = randomUUID(), filename = resultId + extensions[output.mediaType];
        const folder = output.mediaType === 'image/png' ? 'renders' : 'assets';
        phase = 'media-save';
        await mkdir(join(root, folder), { recursive: true });
        await writeFile(join(root, folder, filename), bytes, { flag: 'wx', mode: 0o600 });
        const result = { ...media, id: resultId, filename, url: `/${folder}/${filename}`, kind: output.mediaType === 'image/png' ? 'image' : 'video', mime: output.mediaType, mimeType: output.mediaType, sha256: hashBytes(bytes), nodeId: output.nodeId, key: output.key, backend: output.location, shotId: job.shotId, requestRevision: job.requestRevision, generationJobId: job.id, createdAt: now() };
        job = await persist({ ...job, results: [...job.results, result] });
      }
      return persist({ ...job, status: 'completed', completedAt: now(), message: 'Only declared outputs were probed and saved. Timing and visual quality require review; no timing fit was performed.' });
    } catch {
      return persist({ ...job, failure: { phase }, message: `Tracking failed at ${phase}. Preserve the receipt; no resubmission or undeclared output collection occurred.` });
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
  return { prepare: serial(input => prepare(input)), quote: serial(input => prepare(input, true)), submit: serial(submit), track: serial(track), reconcile: serial(reconcile), get, list: () => [...jobs.values()].map(job => structuredClone(job)), inspect: selection => backendFor(backendSnapshot(selection || options.backend || {})).inspect() };
}
