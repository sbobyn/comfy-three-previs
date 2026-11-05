import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { createProjectDocument, applyOps } from '../server/previs/director.mjs';
import { interpret } from '../server/previs/director-parse.mjs';
import { cameraKeys, cameraAt, compilePrompt, clampDuration, MAX_DURATION } from '../shared/director.mjs';
import { validateBrowser } from '../server/previs/store.mjs';

const say = (p, text, attachments = []) => { const r = interpret(text, p, p.shots.at(-1).id, attachments); applyOps(p, r.ops); return r; };
const named = (p, name) => p.scene.entities.find(e => e.name === name);

test('built-in parser adds, places and edits blockout objects', () => {
  const p = createProjectDocument({ template: 'street' });
  say(p, 'add a red flying car called Hover on the left');
  assert.deepEqual(named(p, 'Hover').position, [-3, 3, 0]);
  assert.equal(named(p, 'Hover').color, '#d9534f');
  say(p, 'add two trees in the background');
  assert.equal(p.scene.entities.filter(e => e.shape === 'tree').length, 2);
  say(p, 'put a detective next to the car facing the runner');
  const det = named(p, 'Detective');
  assert.ok(det, 'an indefinite noun adds rather than editing an existing object');
  assert.notEqual(det.rotation, 0);
  const before = p.scene.entities.length;
  say(p, '@runner looks like this');
  assert.equal(p.scene.entities.length, before, 'mentioning an existing object never duplicates it');
  say(p, 'make the runner bigger');
  assert.ok(named(p, 'Runner').scale[1] > 1);
  say(p, 'remove the streetlamp');
  assert.equal(named(p, 'Streetlamp'), undefined);
  assert.equal(interpret('hello there', p, p.shots[0].id).understood, false);
});

test('built-in parser directs camera, duration and shots', () => {
  const p = createProjectDocument({ template: 'street' });
  say(p, 'slow dolly in on the runner, 50mm, low angle');
  const c = p.shots[0].camera;
  assert.equal(c.move, 'dolly-in'); assert.equal(c.mm, 50); assert.equal(c.height, 0.5);
  assert.equal(c.target, named(p, 'Runner').id);
  assert.equal(p.shots[0].duration, 4.5);
  const r = say(p, 'orbit around the car over 9 seconds');
  assert.equal(p.shots[0].duration, MAX_DURATION); assert.match(r.reply, /capped/);
  say(p, 'new shot: wide establishing crane up over the street');
  assert.equal(p.shots.length, 2);
  assert.equal(p.shots[1].camera.move, 'crane-up'); assert.equal(p.shots[1].camera.distance, 12);
  say(p, 'the runner sprints toward the camera as the car skids');
  assert.match(p.shots[1].description, /runner sprints toward the camera/);
});

test('attachments link to the mentioned object with a role', () => {
  const p = createProjectDocument({ template: 'interior' });
  p.shots[0].references.push({ id: 'ref-1', name: 'ava', file: 'x.png', mime: 'image/png', role: 'style', entityId: null, note: '', createdAt: '' });
  say(p, '@ava looks like this', ['ref-1']);
  assert.equal(p.shots[0].references[0].entityId, named(p, 'Ava').id);
  assert.equal(p.shots[0].references[0].role, 'character');
  assert.match(compilePrompt(p, p.shots[0]), /Ava \(character\) — match reference “ava”/);
});

test('camera keys sample within the export frame limit and end on the last key', () => {
  const p = createProjectDocument({ template: 'hero' });
  for (const move of ['static', 'dolly-in', 'dolly-out', 'truck-left', 'pan-right', 'orbit-left', 'crane-up', 'tilt-up']) {
    applyOps(p, [{ op: 'update_shot', id: p.shots[0].id, patch: { camera: { move } } }]);
    const keys = cameraKeys(p.shots[0], p.scene.entities);
    const end = cameraAt(keys, 3, 3);
    assert.deepEqual(end.p, keys.at(-1).p, move);
    assert.ok(keys.every(k => k.p.every(Number.isFinite)), move);
  }
  assert.ok(Math.round(clampDuration(99) * 24) <= 120);
  assert.equal(clampDuration('x'), 3);
  assert.throws(() => applyOps(p, [{ op: 'remove_shot', id: p.shots[0].id }]), /at least one shot/);
  assert.throws(() => applyOps(p, [{ op: 'explode' }]), /Unknown op/);
});

test('browser recordings keep a bounded director snapshot', () => {
  const camera = { t: 0, p: [0, 1, 0], q: [0, 0, 0, 1], mm: 35 };
  const id = '00000000-0000-4000-8000-000000000000';
  const director = { projectId: id, shotId: id, projectRevision: 3, sceneName: 'Night street', entities: [] };
  const saved = validateBrowser({ camera, subject: [0, 1, 0], frames: [camera, { ...camera, t: 1 }], director });
  assert.equal(saved.sceneVersion, 2); assert.equal(saved.director.sceneName, 'Night street');
  assert.throws(() => validateBrowser({ camera, subject: [0, 1, 0], frames: [camera], director: { ...director, projectId: 'x' } }));
});

test('HTTP director routes and the stdio MCP agent loop', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'previs-director-'));
  const port = 15291, base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['server/previs/server.mjs'], { env: { ...process.env, PORT: String(port), PREVIS_DATA_DIR: dir, PREVIS_AGENT: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] }); // [agent] test the parser/MCP paths, not the built-in runner
  await new Promise((resolve, reject) => { server.stdout.on('data', d => { if (String(d).includes('video-lab:')) resolve(); }); server.once('exit', c => reject(Error('server exited ' + c))); });
  const post = async (path, body) => { const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, data: await r.json() }; };
  const agent = spawn(process.execPath, ['server/previs/agent.mjs'], { env: { ...process.env, PREVIS_URL: base }, stdio: ['pipe', 'pipe', 'ignore'] });
  try {
    const { data: created } = await post('/api/director/projects', { template: 'street', title: 'Test chase' });
    const p = created.project;
    assert.equal(p.title, 'Test chase'); assert.equal(p.shots.length, 1);
    const list = await (await fetch(base + '/api/director/projects')).json();
    assert.equal(list.projects[0].id, p.id); assert.match(list.connect.args[0], /agent\.mjs$/);
    assert.equal((await fetch(base + '/api/director/projects', { headers: { Origin: 'https://foreign.example' } })).status, 403);
    // No agent: the built-in parser answers immediately.
    const { data: m1 } = await post('/api/director/message', { projectId: p.id, shotId: p.shots[0].id, text: 'add a blue box on the right' });
    assert.equal(m1.routed, 'builtin');
    assert.ok(m1.project.scene.entities.some(e => e.name === 'Box' && e.color === '#3f7fd6'));
    // References: magic bytes decide the type; files are served back.
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==';
    assert.equal((await post('/api/director/reference', { projectId: p.id, shotId: p.shots[0].id, name: 'evil.png', data: Buffer.from('<svg/>').toString('base64') })).status, 400);
    const { data: ref } = await post('/api/director/reference', { projectId: p.id, shotId: p.shots[0].id, name: 'runner.png', data: png, entityId: 'Runner' });
    const stored = ref.project.shots[0].references[0];
    assert.equal(stored.role, 'character'); assert.equal(stored.entityId, ref.project.scene.entities.find(e => e.name === 'Runner').id);
    const { data: look } = await post('/api/director/reference', { projectId: p.id, scope: 'object', entityId: 'Car', name: 'car.png', data: png, generated: { requestId: 'forged', model: 'x' } });
    const carLook = look.project.scene.references[0];
    assert.equal(carLook.generated, undefined, 'clients cannot mark uploads as generated');
    assert.equal(look.project.scene.entities.find(e => e.name === 'Car').look, carLook.id, 'first look becomes primary');
    const refgenState = await (await fetch(`${base}/api/director/refgen?projectId=${p.id}`)).json();
    assert.deepEqual(refgenState.presets.map(x => x.id), ['flux-ultra', 'flux-3', 'flux-2-pro', 'flux-2-max', 'gpt-image-25', 'seedream-5-pro', 'nano-banana-pro', 'nano-banana-2-1', 'nano-banana-2', 'local-checkpoint']);
    assert.equal(refgenState.paidExecutionEnabled, false);
    const served = await fetch(`${base}/director-refs/${p.id}/${stored.file}`);
    assert.equal(served.status, 200); assert.equal(served.headers.get('content-type'), 'image/png');
    assert.ok((await fetch(`${base}/director-refs/${p.id}/..%2Fproject.json`)).status >= 400, "traversal refused");
    // Agent over stdio MCP: wait, receive, edit, reply.
    const pending = new Map(); let n = 0;
    createInterface({ input: agent.stdout }).on('line', l => { const m = JSON.parse(l); pending.get(m.id)?.(m); });
    const rpc = (method, params) => new Promise(r => { const id = ++n; pending.set(id, r); agent.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
    const call = async (name, args) => { const m = await rpc('tools/call', { name, arguments: args }); assert.equal(m.result.isError, false, m.result.content[0].text); return JSON.parse(m.result.content[0].text); };
    await rpc('initialize', {});
    const listed = (await rpc('tools/list', {})).result.tools;
    const names = listed.map(t => t.name);
    assert.deepEqual(listed.find(t => t.name === 'previs_director_generate_quote').inputSchema.properties.presetId.enum, refgenState.presets.map(p => p.id), 'MCP quotes expose the same image presets as the app');
    for (const t of ['previs_director_wait_for_direction', 'previs_director_edit', 'previs_director_reply', 'previs_director_get']) assert.ok(names.includes(t), t);
    const waiting = call('previs_director_wait_for_direction', { projectId: p.id, timeoutSeconds: 10, agentName: 'test' });
    await new Promise(r => setTimeout(r, 300));
    const { data: m2 } = await post('/api/director/message', { projectId: p.id, shotId: p.shots[0].id, text: 'a tense standoff', attachments: [stored.id] });
    assert.equal(m2.routed, 'agent');
    const got = await waiting;
    assert.equal(got.messages[0].message.text, 'a tense standoff');
    assert.equal(got.messages[0].attachments[0].id, stored.id);
    const edited = await call('previs_director_edit', { projectId: p.id, ops: [{ op: 'add_shot', shot: { title: 'Standoff', camera: { move: 'orbit-right', target: 'Runner' } } }] });
    assert.equal(edited.project.shots[1].camera.target, edited.project.scene.entities.find(e => e.name === 'Runner').id);
    const replied = await call('previs_director_reply', { projectId: p.id, messageId: got.messages[0].message.id, text: 'Added a standoff shot.' });
    assert.equal(replied.project.messages.find(m => m.id === got.messages[0].message.id).status, 'handled');
    assert.equal(replied.project.messages.at(-1).role, 'agent');
    // Polling returns unchanged when nothing moved.
    const same = await (await fetch(`${base}/api/director/project?id=${p.id}&since=${replied.project.revision}`)).json();
    assert.equal(same.unchanged, true);
    // A render record must point at an exported video in the project.
    assert.equal((await post('/api/director/render', { projectId: p.id, shotId: p.shots[0].id, previsShotId: p.id, assetId: p.id })).status, 400);
  } finally {
    agent.kill();
    const ended = once(server, 'exit'); server.kill('SIGTERM'); await ended;
  }
});
