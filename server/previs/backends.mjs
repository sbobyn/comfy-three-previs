import { localComfyUrl } from './comfy.mjs';
import { assertNoSecrets } from './workflows.mjs';

// Official Cloud v1 (deprecated) contract, checked 2026-10-22:
// https://docs.comfy.org/development/cloud/api-reference
// https://docs.comfy.org/openapi-cloud.yaml
// /api/history_v2/{id} returns object prompts, unlike local tuple history.
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

export function safeMediaLocation(value) {
  if (!value || value.type !== 'output' || typeof value.filename !== 'string' || !/^[^/\\\x00-\x1f:?#%]{1,240}$/.test(value.filename) || ['.', '..'].includes(value.filename) || typeof value.subfolder !== 'string' || /[\\\x00-\x1f:?#%]/.test(value.subfolder) || value.subfolder.startsWith('/') || value.subfolder.split('/').some(part => ['.', '..'].includes(part))) throw Error('Invalid backend media location');
  return { filename: value.filename, subfolder: value.subfolder, type: 'output' };
}

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
  const fetcher = options.fetch || fetch, timeout = options.timeout || 15000;
  const env = options.env || process.env;
  const credential = () => env[cloud ? 'COMFY_CLOUD_API_KEY' : 'COMFY_API_KEY'];
  const prefix = cloud ? '/api' : '';
  async function request(path, init = {}, redirect = 'error') {
    if (cloud && !credential()) throw Error('Set COMFY_CLOUD_API_KEY in the server environment');
    let response;
    try {
      response = await fetcher(snapshot.url + prefix + path, { ...init, headers: { ...init.headers, ...(cloud ? { 'X-API-Key': credential() } : {}) }, redirect, signal: AbortSignal.timeout(timeout) });
    } catch { throw Error('Backend transport failed; no automatic retry'); }
    if (!response.ok && !(redirect === 'manual' && response.status === 302)) {
      const error = Error(`Backend ${path.split('?')[0]} returned HTTP ${response.status}`);
      error.httpStatus = response.status; throw error;
    }
    return response;
  }
  async function json(path, init) {
    const response = await request(path, init);
    try { return await response.json(); } catch { throw Error('Backend returned an invalid JSON response'); }
  }
  return {
    snapshot,
    async inspect() {
      const objectInfo = await json('/object_info');
      if (!objectInfo || typeof objectInfo !== 'object' || Array.isArray(objectInfo)) throw Error('Backend /object_info is incompatible');
      return { backend: snapshot, objectInfo, checkedAt: new Date().toISOString(), deprecated: snapshot.deprecated, message: cloud ? 'Official Comfy Cloud v1 API (deprecated); schema inspection does not authorize charges.' : 'Ordinary loopback ComfyUI; custom/API nodes can still incur charges.' };
    },
    async queue() {
      const result = await json('/queue');
      if (!Array.isArray(result.queue_running) || !Array.isArray(result.queue_pending)) throw Error('Backend queue response is incompatible');
      return result;
    },
    async upload(bytes, { filename, mime, subfolder }) {
      safeMediaLocation({ filename, subfolder, type: 'output' });
      const form = new FormData();
      form.append('image', new Blob([bytes], { type: mime }), filename);
      form.append('type', 'input'); form.append('overwrite', 'false');
      form.append('subfolder', subfolder);
      const upload = await json('/upload/image', { method: 'POST', body: form });
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
      const result = await json('/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (result.error || typeof result.prompt_id !== 'string' || !/^[\w-]{1,128}$/.test(result.prompt_id) || (!cloud && result.prompt_id !== requestId)) throw Error('Backend acceptance receipt is missing or inconsistent');
      return { promptId: result.prompt_id };
    },
    async history(promptId) {
      if (typeof promptId !== 'string' || !/^[\w-]{1,128}$/.test(promptId)) throw Error('A known backend prompt ID is required');
      let history;
      try { history = await json(`${cloud ? '/history_v2/' : '/history/'}${encodeURIComponent(promptId)}`); }
      catch (error) { if (error.httpStatus === 404) return null; throw error; }
      const entry = history[promptId];
      if (!entry) return null;
      const prompt = entry.prompt;
      return { promptId: cloud ? prompt?.prompt_id : prompt?.[1], graph: cloud ? prompt?.prompt : prompt?.[2], requestId: (cloud ? prompt?.extra_data : prompt?.[3])?.previs?.requestId, status: entry.status, outputs: entry.outputs };
    },
    async view(location) {
      const query = new URLSearchParams(safeMediaLocation(location));
      let response = await request('/view?' + query, {}, cloud ? 'manual' : 'error');
      if (cloud && response.status === 302) {
        let target;
        try { target = new URL(response.headers.get('location')); } catch { throw Error('Invalid Cloud storage redirect'); }
        if (target.protocol !== 'https:' || target.username || target.password || /^(?:localhost|127\.|10\.|192\.168\.|169\.254\.|\[)/i.test(target.hostname)) throw Error('Unsafe Cloud storage redirect');
        try { response = await fetcher(target.href, { redirect: 'error', signal: AbortSignal.timeout(timeout) }); }
        catch { throw Error('Cloud output transfer failed'); }
        if (!response.ok) throw Error(`Cloud output transfer returned HTTP ${response.status}`);
      }
      return responseBytes(response, options.maxMediaBytes);
    },
  };
}
