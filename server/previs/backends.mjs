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

// Transient-error policy. Reads (object_info, queue, history, view) and content-addressed Cloud uploads are idempotent,
// so they retry on transport errors, truncated/non-JSON bodies and HTTP 408/425/429/5xx. A prompt submit retries only
// when the request provably never reached the backend (connection refused / DNS / connect timeout); anything else after the request left this process stays "uncertain" and is never resent.
const TRANSIENT_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);
const NOT_CONNECTED = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);
const causeCode = error => error?.cause?.code || error?.cause?.cause?.code || error?.code || null;
export const BACKEND_RETRY = Object.freeze({ attempts: 3, delaysMs: [600, 2500], submitAttempts: 3 });
const sleepFor = ms => new Promise(resolve => setTimeout(resolve, ms));
// Optional schema cache, disabled by default so dispatch revalidates against a fresh schema.
// Keyed by fetcher so injected test fetches never share.
const inspections = new WeakMap();

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
  const retry = { ...BACKEND_RETRY, ...options.retry }, sleep = options.sleep || sleepFor;
  const inspectTtlMs = options.inspectTtlMs ?? (env.PREVIS_INSPECT_CACHE_MS !== undefined ? Number(env.PREVIS_INSPECT_CACHE_MS) : 0);
  async function request(path, init = {}, redirect = 'error', ms = timeouts.queue) {
    if (cloud && !credential()) throw Error('Set COMFY_CLOUD_API_KEY in the server environment');
    let response;
    try {
      response = await fetcher(snapshot.url + prefix + path, { ...init, headers: { ...init.headers, ...(cloud ? { 'X-API-Key': credential() } : {}) }, redirect, signal: AbortSignal.timeout(ms) });
    } catch (cause) {
      const error = Error('Backend transport failed'); error.detail = `${path.split('?')[0]}: ${causeText(cause, ms)}`;
      error.transient = true; error.notConnected = NOT_CONNECTED.has(causeCode(cause)); throw error;
    }
    if (!response.ok && !(redirect === 'manual' && response.status === 302)) {
      const error = Error(`Backend ${path.split('?')[0]} returned HTTP ${response.status}`);
      error.httpStatus = response.status; error.detail = await bodyText(response); error.transient = TRANSIENT_HTTP.has(response.status);
      const after = Number(response.headers?.get?.('retry-after')); if (Number.isFinite(after) && after > 0) error.retryAfterMs = Math.min(after, 30) * 1000;
      throw error;
    }
    return response;
  }
  async function json(path, init, ms) {
    const response = await request(path, init, 'error', ms);
    let text = '';
    try { if (typeof response.text !== 'function') return await response.json(); text = await response.text(); return JSON.parse(text); }
    catch (cause) {
      // A body cut off by the timeout or a gateway's HTML error page: keep what kind of body it was, never the body.
      const error = Error('Backend returned an invalid JSON response'); error.transient = true;
      error.detail = `${path.split('?')[0]}: ${cause?.name === 'TimeoutError' || cause?.name === 'AbortError' ? `body read ${causeText(cause, ms)}` : `HTTP ${response.status}, ${response.headers?.get?.('content-type') || 'no content-type'}, ${text.length} bytes${/^\s*</.test(text) ? ', HTML' : ''}`}`;
      throw error;
    }
  }
  /** Retry an idempotent call on transient errors; `canRetry(error)` narrows it (submit). The last error carries `attempts`. */
  async function withRetry(fn, { attempts = retry.attempts, canRetry = error => error.transient === true } = {}) {
    for (let attempt = 1; ; attempt++) {
      try { return await fn(); } catch (error) {
        error.attempts = attempt;
        if (attempt >= attempts || !canRetry(error)) throw error;
        await sleep(error.retryAfterMs ?? retry.delaysMs[Math.min(attempt - 1, retry.delaysMs.length - 1)] * (0.75 + Math.random() * 0.5));
      }
    }
  }
  async function inspectNow() {
    const objectInfo = await withRetry(() => json('/object_info', undefined, timeouts.inspect));
    if (!objectInfo || typeof objectInfo !== 'object' || Array.isArray(objectInfo)) throw Error('Backend /object_info is incompatible');
    return objectInfo;
  }
  return {
    snapshot,
    async inspect() {
      let cache = inspections.get(fetcher); if (!cache) inspections.set(fetcher, cache = new Map());
      const key = `${snapshot.url}|${cloud ? 'cloud' : 'local'}`, hit = cache.get(key);
      let task = hit && Date.now() - hit.at < inspectTtlMs ? hit.task : null;
      if (!task) { task = inspectNow(); if (inspectTtlMs > 0) { cache.set(key, { at: Date.now(), task }); task.catch(() => { if (cache.get(key)?.task === task) cache.delete(key); }); } }
      const objectInfo = await task;
      return { backend: snapshot, objectInfo, checkedAt: new Date().toISOString(), deprecated: snapshot.deprecated, message: cloud ? 'Official Comfy Cloud v1 API (deprecated); schema inspection does not authorize charges.' : 'Ordinary loopback ComfyUI; custom/API nodes can still incur charges.' };
    },
    async queue() {
      const result = await withRetry(() => json('/queue', undefined, timeouts.queue));
      if (!Array.isArray(result.queue_running) || !Array.isArray(result.queue_pending)) throw Error('Backend queue response is incompatible');
      return result;
    },
    async upload(bytes, { filename, mime, subfolder }) {
      safeMediaLocation({ filename, subfolder, type: 'output' });
      const form = new FormData();
      form.append('image', new Blob([bytes], { type: mime }), filename);
      form.append('type', 'input'); form.append('overwrite', 'false');
      form.append('subfolder', subfolder);
      // Cloud stores uploads by content hash, so a repeat is idempotent; a local repeat could rename the file, so it is not retried.
      const upload = await withRetry(() => json('/upload/image', { method: 'POST', body: form }, timeouts.upload), { attempts: cloud ? retry.attempts : 1 });
      safeMediaLocation({ filename: upload.name, subfolder: upload.subfolder || '', type: 'output' });
      if (!cloud && (upload.type !== 'input' || upload.name !== filename || upload.subfolder !== subfolder)) throw Error('Local upload identity differs from the isolated input');
      if (cloud && upload.type && upload.type !== 'input') throw Error('Cloud upload did not return an input asset');
      // Cloud stores by content hash; the requested filename/subfolder need not survive.
      return { name: upload.name, subfolder: upload.subfolder || '', type: 'input', value: [upload.subfolder, upload.name].filter(Boolean).join('/') };
    },
    // clientId (local only): the stable per-request live-progress identity saved in the receipt before dispatch.
    async submit({ graph, requestId, projectId, partnerNodes = false, clientId = projectId }) {
      assertNoSecrets(graph);
      if (!cloud && !/^[\w-]{1,128}$/.test(String(clientId))) throw Object.assign(Error('Invalid local client identity; nothing was sent'), { notSent: true });
      if (partnerNodes && !credential()) throw Error(`Set ${cloud ? 'COMFY_CLOUD_API_KEY' : 'COMFY_API_KEY'} in the server environment for Partner Nodes`);
      const extra_data = { previs: { requestId, projectId } };
      // Credential injection happens only in this transient wire payload, never in a receipt.
      if (partnerNodes) extra_data.api_key_comfy_org = credential();
      const body = { prompt: graph, extra_data, ...(!cloud ? { prompt_id: requestId, client_id: clientId } : {}) };
      let result;
      try {
        result = await withRetry(() => json('/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, timeouts.submit),
          { attempts: retry.submitAttempts, canRetry: error => error.notConnected === true });
      } catch (error) {
        // Never reached the backend, or refused before queuing: the caller may record "not sent" instead of "uncertain".
        if (error.notConnected === true || [400, 401, 402, 403, 413, 422, 429].includes(error.httpStatus)) error.notSent = true;
        throw error;
      }
      if (result.error || typeof result.prompt_id !== 'string' || !/^[\w-]{1,128}$/.test(result.prompt_id) || (!cloud && result.prompt_id !== requestId)) throw Error('Backend acceptance receipt is missing or inconsistent');
      return { promptId: result.prompt_id };
    },
    async history(promptId) {
      if (typeof promptId !== 'string' || !/^[\w-]{1,128}$/.test(promptId)) throw Error('A known backend prompt ID is required');
      let history;
      try { history = await withRetry(() => json(`${cloud ? '/jobs/' : '/history/'}${encodeURIComponent(promptId)}`, undefined, timeouts.history), { canRetry: error => error.transient === true && error.httpStatus !== 404 }); }
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
      return withRetry(() => viewOnce(query));
    },
  };
  async function viewOnce(query) {
      let response = await request('/view?' + query, {}, cloud ? 'manual' : 'error', timeouts.view);
      if (cloud && response.status === 302) {
        let target;
        try { target = new URL(response.headers.get('location')); } catch { throw Error('Invalid Cloud storage redirect'); }
        if (target.protocol !== 'https:' || target.username || target.password || /^(?:localhost|127\.|10\.|192\.168\.|169\.254\.|\[)/i.test(target.hostname)) throw Error('Unsafe Cloud storage redirect');
        try { response = await fetcher(target.href, { redirect: 'error', signal: AbortSignal.timeout(timeouts.view) }); }
        catch (cause) { const error = Error('Cloud output transfer failed'); error.detail = causeText(cause, timeouts.view); error.transient = true; throw error; }
        if (!response.ok) { const error = Error(`Cloud output transfer returned HTTP ${response.status}`); error.httpStatus = response.status; error.transient = TRANSIENT_HTTP.has(response.status); throw error; }
      }
      try { return await responseBytes(response, options.maxMediaBytes); }
      catch (error) { if (!/size limit/.test(error.message)) error.transient = true; throw error; }
  }
}
