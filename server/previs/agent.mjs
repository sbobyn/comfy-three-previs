import { createInterface } from 'node:readline';
const base = process.env.PREVIS_URL || 'http://127.0.0.1:5190';
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base)) throw Error('PREVIS_URL must be loopback');
const tools = [
  { name: 'previs_project', description: 'Read the project revision, shots and renders. Read again before every edit.', path: '/api/project', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'previs_refresh_blender', description: 'Connect through actual Blender MCP and refresh authoritative scene and camera state after external edits.', path: '/api/blender/refresh', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'previs_add_shot', description: 'Save a shot bound to an inspected Blender scene/camera. Blender owns the source file; this does not save or edit it.', path: '/api/shots', inputSchema: { type: 'object', properties: { revision: { type: 'integer' }, title: { type: 'string' }, binding: { type: 'object', properties: { scene: { type: 'string' }, camera: { type: 'string' }, frame: { type: 'integer' }, start: { type: 'integer' }, end: { type: 'integer' } }, required: ['scene','camera','frame','start','end'], additionalProperties: false } }, required: ['revision','binding'], additionalProperties: false } },
  { name: 'previs_render_preview', description: 'Render a local 640×360 beauty PNG using the shot binding and retain it in the project. Restores Blender camera/frame/render settings; no paid generation. Do not concurrently edit Blender during rendering.', path: '/api/render', inputSchema: { type: 'object', properties: { revision: { type: 'integer' }, shotId: { type: 'string' } }, required: ['revision','shotId'], additionalProperties: false } },
];
async function handle(message) {
  if (message.method === 'initialize') return { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'comfy-previs', version: '0.1.0' }, instructions: 'Blender owns Blender-authored content. Refresh after external edits, use exact scene/camera names, and serialize Blender operations. Previs stores shot bindings and explicit render assets. No Otter required.' };
  if (message.method === 'ping') return {};
  if (message.method === 'tools/list') return { tools: tools.map(({ path, ...tool }) => tool) };
  if (message.method === 'tools/call') {
    const tool = tools.find(t => t.name === message.params?.name); if (!tool) throw Error('Unknown tool');
    try {
      const response = await fetch(base + tool.path, tool.path === '/api/project' ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(message.params.arguments || {}) });
      const result = await response.json(); return { isError: !response.ok, content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch { return { isError: true, content: [{ type: 'text', text: 'Previs server unavailable. Start the standalone app first.' }] }; }
  }
  throw Error('Unknown method');
}
for await (const line of createInterface({ input: process.stdin })) {
  let msg; try { msg = JSON.parse(line); if (msg.id === undefined) continue; const result = await handle(msg); process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n'); }
  catch (e) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32603, message: e.message } }) + '\n'); }
}
