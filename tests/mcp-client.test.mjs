import test from 'node:test';
import assert from 'node:assert/strict';
import { BlenderMcp } from '../server/previs/mcp-client.mjs';
test('upstream socket timeout text poisons the session and prevents overlapping retries', async () => {
  const client = new BlenderMcp(); let calls = 0;
  client.connect = async () => ({});
  client.request = async () => { calls++; return { content: [{ type: 'text', text: 'Error executing code: Timeout waiting for Blender response' }] }; };
  await assert.rejects(client.execute('pass'), /complete result/ );
  await assert.rejects(client.execute('pass'), /reconciliation/ );
  assert.equal(calls, 1);
});
test('successful upstream output decodes JSON and retains healthy session', async () => {
  const client = new BlenderMcp(); client.connect = async () => ({});
  client.request = async () => ({ content: [{ type: 'text', text: 'Code executed successfully: PREVIS_JSON:{"scenes":[]}\n' }] });
  assert.deepEqual(await client.execute('pass'), { scenes: [] });
  assert.equal(client.uncertain, false);
});
