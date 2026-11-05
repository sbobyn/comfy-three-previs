import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = (await readFile(new URL('../src/demo-shim.ts', import.meta.url), 'utf8')).split('// No live agent stream')[0].replace('import.meta.env.BASE_URL', JSON.stringify('/video-lab/'));
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function harness() {
  const calls = [];
  const window = { fetch: async (input, init) => { calls.push({ input, init }); return new Response('{}'); } };
  runInNewContext(compiled, { window, URL, Request, Response, location: new URL('https://example.test/video-lab/director.html') });
  return { window, calls };
}

test('demo rewrites GLTFLoader Request URLs under the deployment base and preserves request headers', async () => {
  const { window, calls } = harness();
  const input = new Request('https://example.test/director-refs/project/model.glb?version=1', { headers: { 'X-Fixture': 'kept' } });
  await window.fetch(input);
  assert.ok(calls[0].input instanceof Request);
  assert.equal(calls[0].input.url, 'https://example.test/video-lab/demo-media/director-refs/project/model.glb?version=1');
  assert.equal(calls[0].input.headers.get('X-Fixture'), 'kept');
  assert.equal(input.url, 'https://example.test/director-refs/project/model.glb?version=1');
});

test('demo rewrites URL and string inputs once, leaving external requests untouched', async () => {
  const { window, calls } = harness();
  await window.fetch(new URL('https://example.test/director-refs/project/model.glb'));
  await window.fetch('/video-lab/demo-media/director-refs/project/model.glb');
  const external = new Request('https://external.test/director-refs/project/model.glb');
  await window.fetch(external);
  assert.equal(calls[0].input, 'https://example.test/video-lab/demo-media/director-refs/project/model.glb');
  assert.equal(calls[1].input, '/video-lab/demo-media/director-refs/project/model.glb');
  assert.equal(calls[2].input, external);
});

test('demo continues to refuse API writes without sending a network request', async () => {
  const { window, calls } = harness();
  assert.equal((await window.fetch('/api/director/project', { method: 'POST' })).status, 403);
  assert.equal(calls.length, 0);
});
