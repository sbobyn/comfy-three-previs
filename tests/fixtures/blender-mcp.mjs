// Simulated MCP transport for refusal, interruption and restart tests. No Blender.
import { createInterface } from 'node:readline';
import { readFile, appendFile } from 'node:fs/promises';
const input = createInterface({ input: process.stdin });
input.on('close', () => process.exit(0));
for await (const line of input) {
  const msg = JSON.parse(line); if (msg.id === undefined) continue;
  let result;
  if (msg.method === 'initialize') result = { serverInfo: { name: 'SIMULATED Blender MCP', version: 'test' }, capabilities: {}, protocolVersion: '2024-11-05' };
  else if (msg.method === 'tools/list') result = { tools: [{ name: 'execute_blender_code' }] };
  else {
    const state = JSON.parse(await readFile(process.env.FIXTURE_STATE, 'utf8'));
    if (msg.params.arguments.code.includes('def previs_render')) {
      await appendFile(process.env.FIXTURE_CALLS, 'render\n');
      if (state.hang) await new Promise(() => {});
      const value = state.refusal ? { ok: false, error: state.refusal } : { ok: true, png: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==' };
      result = { content: [{ type: 'text', text: 'PREVIS_JSON:' + JSON.stringify(value) }] };
    } else result = { content: [{ type: 'text', text: 'PREVIS_JSON:' + JSON.stringify(state.catalog) }] };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
}
