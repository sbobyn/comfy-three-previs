import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { validateBrowser } from '../server/previs/store.mjs';
const camera = { t: 0, p: [0, 1, 0], q: [0, 0, 0, 1], mm: 35 };
test('browser recordings reject nonfinite, nonmonotonic and excessive samples', () => {
  const good = { camera, subject: [0, 2, -11], frames: [camera, { ...camera, t: 1 }] };
  assert.equal(validateBrowser(good).sceneVersion, 1);
  for (const bad of [{ camera: { ...camera, mm: NaN } }, { frames: [camera, camera] }, { subject: [1, 2] }, { frames: Array(1501).fill(camera) }]) assert.throws(() => validateBrowser({ ...good, ...bad }));
});
test('HTTP boundary, shared stdio MCP and restart recovery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'previs-http-'));
  const port = 15190, base = `http://127.0.0.1:${port}`;
  let server;
  async function start() {
    server = spawn(process.execPath, ['server/previs/server.mjs'], { env: { ...process.env, PORT: String(port), PREVIS_DATA_DIR: dir, PREVIS_LEGACY_ROUTES: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => { server.stdout.on('data', d => { if (String(d).includes('Comfy Previs:')) resolve(); }); server.once('exit', c => reject(Error('server exited ' + c))); });
  }
  async function stop() { const ended = once(server, 'exit'); server.kill('SIGTERM'); await ended; }
  await start();
  try {
    const initial = (await (await fetch(base + '/api/project')).json()).project;
    assert.equal((await fetch(base + '/api/project', { headers: { Origin: 'https://foreign.example' } })).status, 403);
    const payload = { revision: initial.revision, title: 'Browser test', camera, subject: [0,2,-11], frames: [camera,{...camera,t:2.99}], png: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==' };
    const post = () => fetch(base + '/api/browser-shot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const saved = await (await post()).json(); assert.equal(saved.project.shots.length, 1);
    assert.equal(saved.project.shots[0].binding.end,71,'off-grid source binding matches final delivery-grid sample');
    assert.equal(saved.project.shots[0].createdRevision,saved.project.revision);
    assert.equal((await post()).status, 409);
    const shotId = saved.project.shots[0].id;
    assert.equal((await fetch(base + '/api/handoff?shot=' + shotId + '&pass=depth')).status, 400);
    const handoff = await (await fetch(base + '/api/handoff?shot=' + shotId)).json();
    assert.equal(handoff.images[0].pass, 'beauty'); assert.equal(handoff.execution, 'not-submitted');
    const mcp = spawn(process.execPath, ['server/previs/agent.mjs'], { env: { ...process.env, PREVIS_URL: base, PREVIS_MCP_LEGACY: '1' }, stdio: ['pipe','pipe','pipe'] }); // legacy engine tools
    const line = once(createInterface({ input: mcp.stdout }), 'line');
    mcp.stdin.write(JSON.stringify({ jsonrpc:'2.0', id:1, method:'tools/call', params:{ name:'previs_project', arguments:{} } }) + '\n');
    const reply = JSON.parse((await line)[0]); assert.equal(JSON.parse(reply.result.content[0].text).project.revision, saved.project.revision); mcp.kill();
    await stop(); await start();
    const restored = (await (await fetch(base + '/api/project')).json()).project;
    assert.deepEqual(restored, saved.project);
    assert.equal((await fetch(base + '/renders/' + restored.renders[0].id + '.png')).status, 200);
  } finally { await stop(); }
});

test('retired Blender/workbench routes answer 404 by default; the director\'s routes still work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'previs-retired-'));
  const port = 15194, base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['server/previs/server.mjs'], { env: { ...process.env, PORT: String(port), PREVIS_DATA_DIR: dir, PREVIS_LEGACY_ROUTES: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { server.stdout.on('data', d => { if (String(d).includes('Comfy Previs:')) resolve(); }); server.once('exit', c => reject(Error('server exited ' + c))); });
  const post = (path, body = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    for (const path of ['/api/transfer', '/api/comfy/inspect', '/api/comfy/submit', '/api/blender/refresh', '/api/render', '/api/shots', '/api/video/blender']) {
      const r = await post(path); assert.equal(r.status, 404, path); assert.match((await r.json()).error, /PREVIS_LEGACY_ROUTES=1/);
    }
    for (const path of ['/api/handoff?shot=x', '/api/readiness', '/api/comfy/jobs']) assert.equal((await fetch(base + path)).status, 404, path);
    // Used by the director: the engine project (revision), browser capture, video capture and generation.
    const project = (await (await fetch(base + '/api/project')).json()).project;
    const saved = await post('/api/browser-shot', { revision: project.revision, title: 'Capture', camera, subject: [0, 2, -11], frames: [camera, { ...camera, t: 1 }], png: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==' });
    assert.equal(saved.status, 200);
    assert.equal((await post('/api/video/readiness')).status, 200);
    assert.equal((await fetch(base + '/api/generation')).status, 200);
  } finally { const ended = once(server, 'exit'); server.kill('SIGTERM'); await ended; }
});
