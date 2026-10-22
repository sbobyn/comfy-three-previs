import { readFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicJson } from './atomic.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (message, status = 400) => { const error = Error(message); error.status = status; throw error; };
const terminal = job => ['completed', 'failed', 'closed'].includes(job.status);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function localComfyUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') fail('Comfy must be a local HTTP origin without credentials or a path');
  return url.origin;
}

// This first transport proof accepts only the two native, model-free image nodes.
// The authored graph is stored verbatim; the submitted clone changes one image input.
export function validateWorkflow(graph, imageNodeId, outputNodeIds) {
  if (!graph || typeof graph !== 'object' || Array.isArray(graph) || JSON.stringify(graph).length > 256000) fail('Import an API-format graph under 256 KB');
  const entries = Object.entries(graph);
  if (entries.length < 2 || entries.length > 9 || entries.some(([id]) => !/^\d{1,9}$/.test(id))) fail('Expected one LoadImage and up to eight SaveImage nodes with numeric IDs');
  if (entries.some(([, n]) => !n || !['LoadImage', 'SaveImage'].includes(n.class_type))) fail('This release supports native LoadImage → SaveImage passthrough only. Model, API and custom nodes are unavailable.');
  const loads = entries.filter(([, n]) => n.class_type === 'LoadImage');
  const saves = entries.filter(([, n]) => n.class_type === 'SaveImage');
  if (loads.length !== 1 || loads[0][0] !== imageNodeId) fail('Explicitly bind the single LoadImage node');
  if (!Array.isArray(outputNodeIds) || !outputNodeIds.length || new Set(outputNodeIds).size !== outputNodeIds.length || saves.length !== outputNodeIds.length || saves.some(([id]) => !outputNodeIds.includes(id))) fail('Declare every SaveImage output node');
  for (const [id, node] of entries) {
    if (!node.inputs || typeof node.inputs !== 'object' || Array.isArray(node.inputs)) fail(`Node ${id} has no inputs`);
    const allowed = node.class_type === 'LoadImage' ? ['image'] : ['images', 'filename_prefix'];
    if (Object.keys(node.inputs).some(key => !allowed.includes(key))) fail(`Unsupported input on node ${id}`);
    if (node.class_type === 'LoadImage' && typeof node.inputs.image !== 'string') fail('LoadImage.image must be a filename string');
    if (node.class_type === 'SaveImage') {
      if (JSON.stringify(node.inputs.images) !== JSON.stringify([imageNodeId, 0])) fail(`SaveImage ${id} must consume the bound LoadImage IMAGE output`);
      if (typeof node.inputs.filename_prefix !== 'string' || !/^[a-zA-Z0-9_/-]{1,120}$/.test(node.inputs.filename_prefix) || node.inputs.filename_prefix.startsWith('/') || node.inputs.filename_prefix.includes('//')) fail(`SaveImage ${id} needs a relative filename prefix using letters, numbers, /, - or _`);
    }
  }
  return { graph: structuredClone(graph), graphHash: digest(JSON.stringify(graph)), imageNodeId, outputNodeIds: [...outputNodeIds], kind: 'passthrough' };
}

export async function openComfy(root, project, options = {}) {
  const origin = localComfyUrl(options.url || process.env.PREVIS_COMFY_URL || 'http://127.0.0.1:8000');
  const timeout = options.timeout || 15000;
  const dir = join(root, 'comfy-jobs'); await mkdir(dir, { recursive: true });
  const jobs = new Map();
  let readiness = { origin, available: false, checkedAt: null, message: 'Not checked. Start local Comfy and inspect compatibility. Native passthrough only.' };
  const persist = async job => { await atomicJson(join(dir, job.id + '.json'), job); jobs.set(job.id.toLowerCase(), job); return structuredClone(job); };
  for (const file of await readdir(dir)) if (/^[a-f0-9-]{36}\.json$/i.test(file)) {
    const job = JSON.parse(await readFile(join(dir, file), 'utf8'));
    if (job.status === 'preparing') { job.status = 'failed'; job.message = 'Previs stopped before prompt submission. No prompt was dispatched.'; }
    if (job.status === 'submitting') { job.status = 'uncertain'; job.message = 'Previs stopped during submission. Check this exact prompt ID; no automatic retry.'; }
    await persist(job);
  }
  async function request(path, init = {}) {
    const response = await fetch(origin + path, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeout) });
    if (!response.ok) { const error = Error(`Local Comfy ${path.split('?')[0]} returned HTTP ${response.status}`); error.httpStatus = response.status; throw error; }
    return response;
  }
  const json = async (path, init) => (await request(path, init)).json();
  async function inspect() {
    try {
      const [system, load, save, queue] = await Promise.all([json('/system_stats'), json('/object_info/LoadImage'), json('/object_info/SaveImage'), json('/queue')]);
      const a = load.LoadImage, b = save.SaveImage;
      const issues = [];
      if (a?.python_module !== 'nodes' || a.output?.[0] !== 'IMAGE' || !Array.isArray(a.input?.required?.image?.[0])) issues.push('Native LoadImage with IMAGE output and image file input is missing or incompatible');
      if (b?.python_module !== 'nodes' || b.output_node !== true || b.input?.required?.images?.[0] !== 'IMAGE' || b.input?.required?.filename_prefix?.[0] !== 'STRING') issues.push('Native SaveImage output with IMAGE input and filename_prefix is missing or incompatible');
      if (!Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending)) issues.push('Queue API response is incompatible');
      readiness = { origin, available: true, compatible: !issues.length, checkedAt: new Date().toISOString(), version: system.system?.comfyui_version || 'unknown', queue: { running: queue.queue_running?.length, pending: queue.queue_pending?.length }, issues, message: issues.length ? issues.join('; ') : 'Native passthrough compatible. This copies an image; it does not generate one.' };
    } catch (e) { readiness = { origin, available: false, compatible: false, checkedAt: new Date().toISOString(), message: `${e.message}. Start local Comfy, or set PREVIS_COMFY_URL to its loopback HTTP port.` }; }
    return structuredClone(readiness);
  }
  const get = id => { const job = jobs.get(String(id).toLowerCase()); if (!job) fail('Comfy job not found', 404); return structuredClone(job); };
  async function submit(input) {
    if (!uuid.test(input.requestId || '')) fail('A unique request UUID is required');
    input = { ...input, requestId: input.requestId.toLowerCase() };
    // Replaying the same HTTP request can only read its receipt, never submit again.
    if (jobs.has(input.requestId)) {
      const prior = get(input.requestId); if (prior.workflowBindingId !== input.workflowBindingId) fail('Request ID already belongs to another binding', 409);
      return prior;
    }
    const p = project.get();
    if (input.revision !== p.revision) fail('Project changed. Reload before submitting.', 409);
    const binding = p.workflowBindings.find(b => b.id === input.workflowBindingId);
    if (!binding) fail('Save an explicit workflow binding first');
    if ([...jobs.values()].some(j => !terminal(j))) fail('Resolve the existing local Comfy job before starting another. An uncertain submission must never be blindly repeated.', 409);
    validateWorkflow(binding.graph, binding.imageNodeId, binding.outputNodeIds);
    const render = p.renders.find(r => r.id === binding.renderId), shot = p.shots.find(s => s.id === render?.shotId);
    if (!render || !shot || !render.binding) fail('Source render provenance is unavailable');
    const checked = await inspect();
    if (!checked.compatible) fail(checked.message);
    if (checked.queue.running || checked.queue.pending) fail('Local Comfy queue is busy. Wait for its owner; Previs will not interrupt or clear it.', 409);
    const bytes = await readFile(join(root, 'renders', render.id + '.png'));
    let job = await persist({ id: input.requestId, promptId: input.requestId, projectId: p.id, shotId: shot.id, workflowBindingId: binding.id, renderId: render.id, sourceBinding: render.binding, sourceHash: digest(bytes), graphHash: binding.graphHash, requestRevision: p.revision, origin, kind: 'passthrough', status: 'preparing', createdAt: new Date().toISOString(), outputNodeIds: binding.outputNodeIds, results: [] });
    try {
      const form = new FormData(); form.append('image', new Blob([bytes], { type: 'image/png' }), job.id + '.png'); form.append('type', 'input'); form.append('subfolder', 'previs/' + p.id); form.append('overwrite', 'false');
      const upload = await json('/upload/image', { method: 'POST', body: form });
      if (upload.type !== 'input' || upload.name !== job.id + '.png' || upload.subfolder !== 'previs/' + p.id) fail('Comfy upload identity did not match the isolated input');
      const prompt = structuredClone(binding.graph); prompt[binding.imageNodeId].inputs.image = upload.subfolder + '/' + upload.name;
      const queue = await json('/queue');
      if (!Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending) || queue.queue_running.length || queue.queue_pending.length) fail('Local Comfy queue changed or is busy. No prompt submitted.');
      job = await persist({ ...job, status: 'submitting', submittedGraph: prompt, input: upload, message: 'Submission started. Do not repeat this operation.' });
      const response = await json('/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, prompt_id: job.promptId, client_id: p.id, extra_data: { previs: { projectId: p.id, jobId: job.id, renderId: render.id, requestRevision: p.revision } } }) });
      if (response.prompt_id !== job.promptId) fail('Comfy returned a different prompt ID; inspect backend history before any further execution');
      return await persist({ ...job, status: 'queued', message: 'Accepted by local Comfy. Track this prompt ID to collect declared outputs.' });
    } catch (error) {
      const uncertain = job.status === 'submitting' && error.httpStatus !== 400;
      return persist({ ...job, status: uncertain ? 'uncertain' : 'failed', message: `${error.message}${uncertain ? '. Submission may have succeeded. Tracking is safe; automatic resubmission is disabled.' : '. No accepted prompt is known.'}` });
    }
  }
  async function attach(job) {
    const current = project.get();
    if (current.renders.some(r => r.comfyJobId === job.id)) return;
    await project.mutate(current.revision, async next => {
      const shot = next.shots.find(s => s.id === job.shotId); if (!shot) fail('Originating shot is unavailable; outputs remain in the job receipt');
      for (const result of job.results) {
        next.renders.push({ id: result.id, width: result.width, height: result.height, shotId: job.shotId, source: 'comfy', pass: 'passthrough', binding: job.sourceBinding, requestRevision: job.requestRevision, sourceRenderId: job.renderId, comfyJobId: job.id, outputNodeId: result.nodeId, createdAt: new Date().toISOString() });
        shot.renders.push(result.id);
      }
    });
  }
  async function track(id) {
    let job = get(id);
    if (job.origin !== origin) fail('This job belongs to a different Comfy origin. Restore PREVIS_COMFY_URL to track it.', 409);
    if (job.status === 'completed') { await attach(job); return job; }
    if (job.status === 'failed' || job.status === 'closed') return job;
    try {
      const history = await json('/history/' + encodeURIComponent(job.promptId));
      const entry = history[job.promptId];
      if (entry) {
        if (entry.prompt?.[1] !== job.promptId || entry.prompt?.[3]?.previs?.jobId !== job.id || digest(JSON.stringify(entry.prompt?.[2])) !== digest(JSON.stringify(job.submittedGraph))) fail('Comfy history does not match this saved request. No outputs were collected.');
        if (entry.status?.status_str === 'error') return persist({ ...job, status: 'failed', message: 'Comfy reports execution failure. No output was attached; inspect its history for the error.' });
        if (entry.status?.completed !== true) return persist({ ...job, status: 'running', message: 'Comfy has not marked this request complete.' });
        const results = [];
        for (const nodeId of job.outputNodeIds) {
          const images = entry.outputs?.[nodeId]?.images;
          if (!Array.isArray(images) || images.length !== 1) fail(`Declared output ${nodeId} did not return exactly one passthrough image`);
          const output = images[0];
          if (output.type !== 'output' || typeof output.filename !== 'string' || !/^[^/\\]+\.png$/i.test(output.filename) || typeof output.subfolder !== 'string' || output.subfolder.startsWith('/') || output.subfolder.split(/[\\/]/).includes('..')) fail('Invalid Comfy output location');
          const query = new URLSearchParams({ filename: output.filename, subfolder: output.subfolder, type: 'output' });
          const response = await request('/view?' + query);
          const bytes = Buffer.from(await response.arrayBuffer());
          const image = await project.image(bytes);
          results.push({ ...image, nodeId, backend: output, hash: digest(bytes) });
        }
        job = await persist({ ...job, status: 'completed', results, completedAt: new Date().toISOString(), message: 'Native passthrough complete. Declared outputs saved against the originating shot and request revision; no AI generation.' });
        await attach(job); return job;
      }
      const queue = await json('/queue');
      const running = queue.queue_running?.some(row => row[1] === job.promptId), pending = queue.queue_pending?.some(row => row[1] === job.promptId);
      return persist({ ...job, status: running ? 'running' : pending ? 'queued' : 'uncertain', message: running || pending ? 'Exact prompt ID found in the local queue.' : 'Prompt is absent from queue and history. It may have completed, history may have been cleared, or submission may not have arrived. No cancellation or retry is claimed. Preserve this receipt and inspect the backend.' });
    } catch (error) {
      return persist({ ...job, message: `Tracking failed: ${error.message}. Keep this prompt ID; tracking never resubmits.` });
    }
  }
  async function reconcile(input) {
    const job = get(input.jobId);
    if (job.status !== 'uncertain' || input.backendIdle !== true || input.historyReviewed !== true) fail('Confirm the exact unresolved job, backend idle, and reviewed history/output files. This does not cancel or retry it.', 409);
    const checked = await track(job.id);
    if (checked.status !== 'uncertain') return checked;
    const queue = await json('/queue');
    if (!Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending) || queue.queue_running.length || queue.queue_pending.length) fail('Backend queue must be confirmed empty before closing this receipt', 409);
    return persist({ ...checked, status: 'closed', closedAt: new Date().toISOString(), message: 'Operator reviewed backend history and outputs and confirmed an idle queue. Outcome remains unknown. Receipt closed without cancellation or retry; any later submission is a separate deliberate request.' });
  }
  return { inspect, submit, track, reconcile, get, list: () => [...jobs.values()].map(j => structuredClone(j)), readiness: () => structuredClone(readiness) };
}
