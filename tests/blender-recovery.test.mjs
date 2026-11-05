import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

test('simulated MCP: stale source refusal, known render failures and crash-safe reconciliation', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'previs-recovery-')), file = join(root, 'state.json'), calls = join(root, 'calls');
  const base = 'http://127.0.0.1:15192';
  const catalog = { file: 'a.blend', scenes: [{ name: 'Scene', cameras: ['Camera'], fps: 24, start: 1, end: 48 }] };
  let state = { catalog }; await writeFile(file, JSON.stringify(state));
  let server;
  async function start() {
    server = spawn(process.execPath, ['server/previs/server.mjs'], { env: { ...process.env, PORT: '15192', PREVIS_LEGACY_ROUTES: '1', PREVIS_DATA_DIR: root, PREVIS_BLENDER_MCP_COMMAND: process.execPath, PREVIS_BLENDER_MCP_ARGS: JSON.stringify([resolve('tests/fixtures/blender-mcp.mjs')]), FIXTURE_STATE: file, FIXTURE_CALLS: calls }, stdio: ['ignore','pipe','pipe'] });
    await new Promise((resolve, reject) => { server.stdout.on('data', d => { if (String(d).includes('video-lab:')) resolve(); }); server.once('exit', c => reject(Error('server exited ' + c))); });
  }
  async function stop(signal = 'SIGTERM') { const ended = once(server, 'exit'); server.kill(signal); await ended; }
  const post = async (path, body = {}) => { const response = await fetch(base + '/api/' + path, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) }); return { status: response.status, data: await response.json() }; };
  const get = async () => (await (await fetch(base + '/api/project')).json());
  await start();
  try {
    const old = (await post('blender/refresh')).data.catalog;
    const initial = (await get()).project;
    state.catalog = { ...catalog, file: 'b.blend' }; await writeFile(file, JSON.stringify(state));
    await post('blender/refresh');
    const input = { revision: initial.revision, catalogToken: old.token, binding: { scene:'Scene',camera:'Camera',start:1,end:48,frame:1 } };
    assert.equal((await post('shots', input)).status, 409);
    state.catalog = catalog; await writeFile(file, JSON.stringify(state));
    const refreshed = (await post('blender/refresh')).data.catalog;
    const saved = (await post('shots', {...input,catalogToken:refreshed.token})).data.project;
    const render = { revision:saved.revision,shotId:saved.shots[0].id };
    state.refusal = 'Camera missing or renamed'; await writeFile(file, JSON.stringify(state));
    assert.match((await post('render', render)).data.error,/Camera missing/);
    assert.equal((await get()).blender.operation.status,'failed');
    assert.equal((await post('blender/refresh')).status,200);
    delete state.refusal; state.hang = true; await writeFile(file, JSON.stringify(state));
    const pending = post('render', render).catch(()=>null);
    for(let i=0;i<60;i++){ if((await readFile(calls,'utf8')).split('\n').filter(Boolean).length===2) break; await delay(25); }
    assert.equal((await get()).blender.operation.status,'running');
    await stop('SIGKILL'); await pending;
    await start();
    const recovered = await get(); assert.equal(recovered.blender.operation.status,'uncertain');
    assert.equal((await post('render', render)).status,409);
    assert.equal((await post('blender/refresh')).status,409);
    assert.equal((await readFile(calls,'utf8')).split('\n').filter(Boolean).length,2);
    assert.equal((await post('blender/reconcile',{operationId:recovered.blender.operation.id,blenderIdle:true})).status,409);
    assert.equal((await post('blender/reconcile',{operationId:recovered.blender.operation.id,blenderIdle:true,settingsReviewed:true})).status,200);
    state.hang=false; await writeFile(file,JSON.stringify(state));
    const done = await post('render',render); assert.equal(done.status,200); assert.equal(done.data.project.renders.length,1);
    assert.equal((await get()).blender.operation.status,'completed');
    const shotId = render.shotId;
    const rebound = await post('shots', { ...input, revision:done.data.project.revision, catalogToken:refreshed.token, shotId, binding:{...input.binding,frame:20} });
    assert.equal(rebound.status,200);
    assert.equal((await fetch(base+'/api/handoff?shot='+shotId)).status,400);
    const rerendered = await post('render', {shotId,revision:rebound.data.project.revision});
    assert.equal(rerendered.status,200);
    const handoff = await (await fetch(base+'/api/handoff?shot='+shotId)).json();
    assert.equal(handoff.images.length,1); assert.equal(handoff.images[0].binding.frame,20);
    assert.equal(rerendered.data.project.renders[0].binding.frame,1);
  } finally { await stop(); }
});
