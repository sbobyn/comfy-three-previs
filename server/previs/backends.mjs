import { localComfyUrl } from './comfy.mjs';
import { assertNoSecrets } from './workflows.mjs';

// Official Cloud v1 (deprecated) contract, checked 2026-10-22:
// https://docs.comfy.org/development/cloud/api-reference
// https://docs.comfy.org/openapi-cloud.yaml
// /api/jobs/{id} replaces deprecated history_v2; workflow contains prompt/extra_data.
// /api/view redirects must never forward X-API-Key to the storage host.
export function backendSnapshot(input = {}) {
  assertNoSecrets(input);
  if (Object.keys(input).some(key => !['kind', 'url', 'id', 'apiVersion', 'deprecated'].includes(key))) throw Error('Backend selection accepts kind, url and id only; credentials are environment-only');
  const kind = input.kind || 'local';
  if (!['local', 'cloud'].includes(kind)) throw Error('Choose local ComfyUI or official Comfy Cloud');
  const url = kind === 'local' ? localComfyUrl(input.url || process.env.PREVIS_COMFY_URL || 'http://127.0.0.1:8000') : 'https://cloud.comfy.org';
  if (kind === 'cloud' && input.url && input.url !== url) throw Error('Cloud backend must use the official https://cloud.comfy.org origin');
  const id = input.id || `${kind}:${url}`;
  if (typeof id !== 'string' || !id || id.length > 200) throw Error('Invalid backend identity');
  return Object.freeze({ id, kind, url, apiVersion: kind === 'cloud' ? 'cloud-v1' : 'comfyui', deprecated: kind === 'cloud' });
}

// Display labels must never split the unresolved-operation lock for one service.
export function backendTransportKey(input) {
  const backend = backendSnapshot(input), url = new URL(backend.url);
  if (backend.kind === 'local') url.hostname = '127.0.0.1';
  return `${backend.kind}:${url.origin}`;
}

export function safeMediaLocation(value) {
  if (!value || value.type !== 'output' || typeof value.filename !== 'string' || !/^[^/\\\x00-\x1f:?#%]{1,240}$/.test(value.filename) || ['.', '..'].includes(value.filename) || typeof value.subfolder !== 'string' || /[\\\x00-\x1f:?#%]/.test(value.subfolder) || value.subfolder.startsWith('/') || value.subfolder.split('/').some(part => ['.', '..'].includes(part))) throw Error('Invalid backend media location');
  return { filename: value.filename, subfolder: value.subfolder, type: 'output' };
}

// Persistable error text: credential-looking pairs redacted, ≤500 chars, else '[redacted]'.
const CREDENTIAL_PAIR = /((?:api[_-]?key|token|secret|authorization|x-api-key)[\w-]*)["']?\s*[:=]\s*\S+/gi;
export function errorDetail(error) {
  const text = [error?.message ?? String(error ?? ''), error?.detail].filter(Boolean).join(' — ').replace(CREDENTIAL_PAIR, '$1=[redacted]').replace(/\s+/g, ' ').trim().slice(0, 500);
  try { assertNoSecrets(text); return text; } catch { return '[redacted]'; }
}

// Provider error from ComfyUI messages or a Cloud execution_error, never the raw body.
function providerError(source) {
  const err = source?.execution_error || (Array.isArray(source?.messages) ? source.messages.find(m => m?.[0] === 'execution_error')?.[1] : null);
  if (!err || typeof err !== 'object') return null;
  return { nodeId: err.node_id == null ? null : String(err.node_id).slice(0, 64), nodeType: err.node_type == null ? null : String(err.node_type).slice(0, 120), message: String(err.exception_message || err.exception_type || 'Execution error').replace(/\s+/g, ' ').slice(0, 500) };
}

async function bodyText(response, maxBytes = 2048) {
  try {
    const reader = response.body?.getReader(); if (!reader) return '';
    const parts = []; let size = 0;
    while (size < maxBytes) { const { done, value } = await reader.read(); if (done) break; parts.push(Buffer.from(value)); size += value.length; }
    reader.cancel().catch(() => {});
    return Buffer.concat(parts).subarray(0, maxBytes).toString('utf8');
  } catch { return ''; }
}
const causeText = (error, ms) => error?.name === 'TimeoutError' ? `timed out after ${Math.round(ms / 1000)} s` : String(error?.cause?.message || error?.cause?.code || error?.message || 'unknown transport error').slice(0, 300);

export const BACKEND_TIMEOUTS = Object.freeze({ inspect: 15000, queue: 15000, history: 15000, upload: 120000, submit: 30000, view: 300000 });

export async function responseBytes(response, maxBytes = 512 * 1024 * 1024) {
  if (Number(response.headers.get('content-length')) > maxBytes) throw Error('Media exceeds the size limit');
  const parts = []; let size = 0;
  for await (const part of response.body) {
    size += part.length;
    if (size > maxBytes) throw Error('Media exceeds the size limit');
    parts.push(part);
  }
  return Buffer.concat(parts);
}

export function createBackend(input, options = {}) {
  const snapshot = backendSnapshot(input), cloud = snapshot.kind === 'cloud';
  const fetcher = options.fetch || fetch;
  // A single legacy `timeout` still applies to every call; otherwise each operation has its own budget.
  const timeouts = options.timeout ? Object.fromEntries(Object.keys(BACKEND_TIMEOUTS).map(k => [k, options.timeout])) : { ...BACKEND_TIMEOUTS, ...options.timeouts };
  const env = options.env || process.env;
  const credential = () => env[cloud ? 'COMFY_CLOUD_API_KEY' : 'COMFY_API_KEY'];
  const prefix = cloud ? '/api' : '';
  async function request(path, init = {}, redirect = 'error', ms = timeouts.queue) {
    if (cloud && !credential()) throw Error('Set COMFY_CLOUD_API_KEY in the server environment');
    let response;
    try {
      response = await fetcher(snapshot.url + prefix + path, { ...init, headers: { ...init.headers, ...(cloud ? { 'X-API-Key': credential() } : {}) }, redirect, signal: AbortSignal.timeout(ms) });
    } catch (cause) { const error = Error('Backend transport failed; no automatic retry'); error.detail = `${path.split('?')[0]}: ${causeText(cause, ms)}`; throw error; }
    if (!response.ok && !(redirect === 'manual' && response.status === 302)) {
      const error = Error(`Backend ${path.split('?')[0]} returned HTTP ${response.status}`);
      error.httpStatus = response.status; error.detail = await bodyText(response); throw error;
    }
    return response;
  }
  async function json(path, init, ms) {
    const response = await request(path, init, 'error', ms);
    try { return await response.json(); } catch { throw Error('Backend returned an invalid JSON response'); }
  }
  return {
    snapshot,
    async inspect() {
      const objectInfo = await json('/object_info', undefined, timeouts.inspect);
      if (!objectInfo || typeof objectInfo !== 'object' || Array.isArray(objectInfo)) throw Error('Backend /object_info is incompatible');
      return { backend: snapshot, objectInfo, checkedAt: new Date().toISOString(), deprecated: snapshot.deprecated, message: cloud ? 'Official Comfy Cloud v1 API (deprecated); schema inspection does not authorize charges.' : 'Ordinary loopback ComfyUI; custom/API nodes can still incur charges.' };
    },
    async queue() {
      const result = await json('/queue', undefined, timeouts.queue);
      if (!Array.isArray(result.queue_running) || !Array.isArray(result.queue_pending)) throw Error('Backend queue response is incompatible');
      return result;
    },
    async upload(bytes, { filename, mime, subfolder }) {
      safeMediaLocation({ filename, subfolder, type: 'output' });
      const form = new FormData();
      form.append('image', new Blob([bytes], { type: mime }), filename);
      form.append('type', 'input'); form.append('overwrite', 'false');
      form.append('subfolder', subfolder);
      const upload = await json('/upload/image', { method: 'POST', body: form }, timeouts.upload);
      safeMediaLocation({ filename: upload.name, subfolder: upload.subfolder || '', type: 'output' });
      if (!cloud && (upload.type !== 'input' || upload.name !== filename || upload.subfolder !== subfolder)) throw Error('Local upload identity differs from the isolated input');
      if (cloud && upload.type && upload.type !== 'input') throw Error('Cloud upload did not return an input asset');
      // Cloud stores by content hash; the requested filename/subfolder need not survive.
      return { name: upload.name, subfolder: upload.subfolder || '', type: 'input', value: [upload.subfolder, upload.name].filter(Boolean).join('/') };
    },
    async submit({ graph, requestId, projectId, partnerNodes = false }) {
      assertNoSecrets(graph);
      if (partnerNodes && !credential()) throw Error(`Set ${cloud ? 'COMFY_CLOUD_API_KEY' : 'COMFY_API_KEY'} in the server environment for Partner Nodes`);
      const extra_data = { previs: { requestId, projectId } };
      // Credential injection happens only in this transient wire payload, never in a receipt.
      if (partnerNodes) extra_data.api_key_comfy_org = credential();
      const body = { prompt: graph, extra_data, ...(!cloud ? { prompt_id: requestId, client_id: projectId } : {}) };
      const result = await json('/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, timeouts.submit);
      if (result.error || typeof result.prompt_id !== 'string' || !/^[\w-]{1,128}$/.test(result.prompt_id) || (!cloud && result.prompt_id !== requestId)) throw Error('Backend acceptance receipt is missing or inconsistent');
      return { promptId: result.prompt_id };
    },
    async history(promptId) {
      if (typeof promptId !== 'string' || !/^[\w-]{1,128}$/.test(promptId)) throw Error('A known backend prompt ID is required');
      let history;
      try { history = await json(`${cloud ? '/jobs/' : '/history/'}${encodeURIComponent(promptId)}`, undefined, timeouts.history); }
      catch (error) { if (error.httpStatus === 404) return null; throw error; }
      if (cloud) {
        if (!history.workflow) return null;
        // Never return/persist the raw workflow wrapper: extra_data can carry auth.
        const status = history.status;
        if (!['pending','in_progress','completed','failed','cancelled'].includes(status)) throw Error('Unknown Cloud job status');
        const error = status === 'failed' ? providerError(history) || providerError(history.execution_status) : null;
        return { promptId: history.id, graph: history.workflow.prompt, requestId: history.workflow.extra_data?.previs?.requestId,
          status: { completed: status === 'completed' && history.execution_status?.completed !== false, status_str: status === 'failed' ? 'error' : status === 'cancelled' ? 'cancelled' : status === 'completed' ? 'success' : status }, outputs: history.outputs, ...(error ? { error } : {}) };
      }
      const entry = history[promptId];
      if (!entry) return null;
      const prompt = entry.prompt;
      const error = entry.status?.status_str === 'error' ? providerError(entry.status) : null;
      return { promptId: prompt?.[1], graph: prompt?.[2], requestId: prompt?.[3]?.previs?.requestId, status: entry.status, outputs: entry.outputs, ...(error ? { error } : {}) };
    },
    async view(location) {
      const query = new URLSearchParams(safeMediaLocation(location));
      let response = await request('/view?' + query, {}, cloud ? 'manual' : 'error', timeouts.view);
      if (cloud && response.status === 302) {
        let target;
        try { target = new URL(response.headers.get('location')); } catch { throw Error('Invalid Cloud storage redirect'); }
        if (target.protocol !== 'https:' || target.username || target.password || /^(?:localhost|127\.|10\.|192\.168\.|169\.254\.|\[)/i.test(target.hostname)) throw Error('Unsafe Cloud storage redirect');
        try { response = await fetcher(target.href, { redirect: 'error', signal: AbortSignal.timeout(timeouts.view) }); }
        catch (cause) { const error = Error('Cloud output transfer failed'); error.detail = causeText(cause, timeouts.view); throw error; }
        if (!response.ok) { const error = Error(`Cloud output transfer returned HTTP ${response.status}`); error.httpStatus = response.status; throw error; }
      }
      return responseBytes(response, options.maxMediaBytes);
    },
  };
}
