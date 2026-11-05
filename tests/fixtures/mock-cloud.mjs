// Preload (node --import) for a real video-lab server in tests: Comfy Cloud is mocked and nothing leaves the machine.
// fetch to https://cloud.comfy.org answers from the captured partner schemas (plus LoadVideo) and records every call
// as a JSON line in MOCK_CLOUD_LOG; submissions are accepted with a fake prompt id and never finish. The `ws` package
// (the server's live-progress sockets; the phone relay keeps the real one) is swapped for a socket that fails at once. Loopback calls use the real fetch.
import { appendFileSync, readFileSync } from 'node:fs';
import { register } from 'node:module';

const info = JSON.parse(readFileSync(new URL('./partner-object-info.json', import.meta.url), 'utf8'));
info.LoadVideo = { python_module: 'comfy_extras.nodes_video', output: ['VIDEO'], input: { required: { file: ['COMBO', { options: [], video_upload: true }] } } };
const real = globalThis.fetch, log = process.env.MOCK_CLOUD_LOG;
let n = 0;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.origin !== 'https://cloud.comfy.org') return real(input, init);
  const method = init.method || 'GET', path = url.pathname;
  const body = path === '/api/prompt' ? JSON.parse(init.body) : undefined;
  if (log) appendFileSync(log, JSON.stringify({ method, path, ...(body ? { graph: body.prompt } : {}) }) + '\n');
  if (path === '/api/object_info') return json(info);
  if (path === '/api/queue') return json({ queue_running: [], queue_pending: [] });
  if (path === '/api/upload/image') return json({ name: `mock-${++n}`, subfolder: '', type: 'input' });
  if (path === '/api/prompt') return json({ prompt_id: `mock-prompt-${++n}` });
  return json({ error: 'not mocked' }, 404);
};
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if (spec === 'ws' && ctx.parentURL?.endsWith('/server/previs/server.mjs')) return { url: 'mock-ws:ws', shortCircuit: true };
  return next(spec, ctx);
}
export async function load(url, ctx, next) {
  if (url !== 'mock-ws:ws') return next(url, ctx);
  return { format: 'module', shortCircuit: true, source: "import { EventEmitter } from 'node:events'; export class WebSocket extends EventEmitter { constructor() { super(); setTimeout(() => { this.emit('error', new Error('mock: no live progress')); this.emit('close'); }, 0); } close() {} terminate() {} } export default WebSocket;" };
}`));
