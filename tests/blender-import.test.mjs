// Copyright (c) 2026 Steven Bobyn. SPDX-License-Identifier: MIT
// Blender thin import (server/previs/blender-import.mjs, docs/blender-import.md) against a real export:
// tests/fixtures/blender-handoff/shot.previs-blender was written by Blender 5.3 running
// scripts/blender/build-test-scene.py (12 frames, 640×360, AUTO fit); vertical-fit.json is the same scene with a VERTICAL
// sensor fit and a 50 mm lens. The landmark pixels in their camera.checks were projected by Blender itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdtemp as mkdtempRaw, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { handoffToOps, validateHandoff, readHandoffDir, readHandoffZip, lensMm, projectionChecks, cameraQuaternion, three, frameName } from '../server/previs/blender-import.mjs';
import { createProjectDocument, applyOps } from '../server/previs/director.mjs';
import { writeZip } from '../server/previs/zip.mjs';
import { entitySize, blockoutStale, blenderBlockout, shotSignature } from '../shared/director.mjs';
import { stillPrompt } from '../shared/still-match.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/blender-handoff/shot.previs-blender', import.meta.url));
const VERTICAL = fileURLToPath(new URL('./fixtures/blender-handoff/vertical-fit.json', import.meta.url));
const mediaAvailable = ['ffmpeg', 'ffprobe'].every(name => spawnSync(process.env[name === 'ffmpeg' ? 'PREVIS_FFMPEG' : 'PREVIS_FFPROBE'] || name, ['-version'], { stdio: 'ignore' }).status === 0);
const sidecar = async () => JSON.parse(await readFile(join(FIXTURE, 'blender-previs.json'), 'utf8'));
const empty = () => createProjectDocument({ template: 'empty' });
// Real paths: the importer refuses symlinked folders, and macOS temp folders sit behind /var → /private/var.
const mkdtemp = async prefix => realpath(await mkdtempRaw(prefix));
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

// ---------- 1. Pure mapping ----------
test('mapping: a custom linear camera of at most 64 keys, proxies with Blender’s extents, cast kinds and paths', async () => {
  const m = await sidecar(), p = empty();
  const plan = handoffToOps(p, m, { shotId: p.shots[0].id });
  applyOps(p, plan.ops);
  const s = p.shots[0], cam = s.camera;
  assert.equal(cam.move, 'custom'); assert.equal(cam.timing, 'linear');
  assert.equal(cam.keys.length, 12); assert.ok(cam.keys.every((k, i) => !i || k.t > cam.keys[i - 1].t));
  // Frame i plays at i/24 s, which is t = i / (24 × duration) of the shot.
  assert.equal(s.duration, 0.5); close(cam.keys[11].t, 11 / 12, 1e-6, 'last key t');
  assert.equal(p.scene.entities.length, 4, 'the flat ground plane was left out by the exporter');
  for (const o of m.objects) {
    const e = p.scene.entities.find(x => x.name === o.name);
    entitySize(e).forEach((v, i) => close(v, o.frames[0].size[i], 1e-5, `${o.name} size ${i}`));
    assert.deepEqual(e.position, three(o.frames[0].position).map(v => Math.round(v * 1000) / 1000));
  }
  const by = n => p.scene.entities.find(e => e.name === n);
  assert.deepEqual([by('Comfy Car').kind, by('Runner').kind, by('Crate').kind, by('Grandstand').kind], ['vehicle', 'character', 'environment', 'environment']);
  assert.equal(by('Grandstand').shape, 'building'); assert.equal(by('Comfy Car').color, '#5d95ed');
  assert.equal(by('Comfy Car').path.length, 12, 'animated: one key per frame'); assert.equal(by('Crate').path, null, 'static: no path');
  assert.equal(cam.target, by('Comfy Car').id, 'the cast object filling most of the first frame is the subject');
  close(cam.mm, 35 * 35 / 36, 1e-3, 'shot lens');
});

test('mapping: yaw keeps its sign, so the car’s nose points where Blender drives it', async () => {
  const p = empty(), m = await sidecar();
  applyOps(p, handoffToOps(p, m).ops);
  const car = p.scene.entities.find(e => e.name === 'Comfy Car'), r = (car.rotation * Math.PI) / 180;
  const nose = [Math.sin(r), 0, Math.cos(r)]; // Previs front (+z at yaw 0)
  const travel = three([10, 6, 0]), len = Math.hypot(...travel); // Blender: (-6,-2) → (4,4)
  close(nose[0], travel[0] / len, 1e-4, 'x'); close(nose[2], travel[2] / len, 1e-4, 'z');
  const [a, b] = [car.path[0].p, car.path.at(-1).p];
  close(Math.atan2(b[0] - a[0], b[2] - a[2]), r > Math.PI ? r - 2 * Math.PI : r, 1e-3, 'path heading = facing');
});

test('mapping: lens gauge (35 mm Previs vs Blender sensor) and the engine camera quaternion', () => {
  close(lensMm(50, { sensorFit: 'AUTO', sensorWidth: 36, sensorHeight: 24 }), 48.611, 1e-3, 'AUTO 36 mm');
  close(lensMm(50, { sensorFit: 'VERTICAL', sensorWidth: 36, sensorHeight: 24 }), 50 * (35 / (16 / 9)) / 24, 1e-9, 'VERTICAL');
  // A level camera looking down three −Z is the identity; looking along +X is a −90° yaw.
  assert.deepEqual(cameraQuaternion([0, 0, -1], [0, 1, 0]).map(v => Math.round(v * 1e6) / 1e6 + 0), [0, 0, 0, 1]);
  const q = cameraQuaternion([1, 0, 0], [0, 1, 0]); close(q[1], -Math.SQRT1_2, 1e-9, 'yaw quaternion'); close(q[3], Math.SQRT1_2, 1e-9, 'w');
});

test('mapping: re-import updates matched objects but never their names, looks, notes or a looked shape', async () => {
  const p = empty(), m = await sidecar();
  applyOps(p, handoffToOps(p, m, { shotId: p.shots[0].id }).ops);
  const car = p.scene.entities.find(e => e.name === 'Comfy Car');
  Object.assign(car, { notes: 'a battered blue rally car', look: 'look-1', name: 'comfy car', shape: 'box' });
  const moved = structuredClone(m); moved.objects.find(o => o.name === 'Comfy Car').frames.forEach(f => { f.position[0] += 1; });
  const plan = handoffToOps(p, moved, { shotId: p.shots[0].id });
  assert.deepEqual(plan.mapping.map(x => x.action), ['updated', 'updated', 'updated', 'updated']);
  applyOps(p, plan.ops);
  const after = p.scene.entities.find(e => e.id === car.id);
  assert.deepEqual([after.name, after.notes, after.look, after.shape], ['comfy car', 'a battered blue rally car', 'look-1', 'box']);
  close(after.position[0], -5, 1e-6, 'moved'); assert.equal(p.scene.entities.length, 4);
  entitySize(after).forEach((v, i) => close(v, m.objects[2].frames[0].size[i], 1e-5, 'a box keeps the car’s extents'));
});

test('mapping: long shots sample at most 64 camera and path keys; too many objects fail before any op', async () => {
  const m = await sidecar(), long = structuredClone(m);
  long.frameCount = 120; long.source.frameEnd = 120;
  long.camera.keys = Array.from({ length: 120 }, (_, i) => ({ ...m.camera.keys[i % 12], frame: i + 1 })); long.camera.checks = [];
  long.objects[2].frames = Array.from({ length: 120 }, (_, i) => m.objects[2].frames[i % 12]);
  const p = empty(), plan = handoffToOps(p, long, { shotId: p.shots[0].id });
  applyOps(p, plan.ops);
  assert.equal(p.shots[0].duration, 5); assert.ok(p.shots[0].camera.keys.length <= 64); assert.equal(p.shots[0].camera.keys.at(-1).t, Math.round(119 / 120 * 1e6) / 1e6);
  assert.ok(p.scene.entities.find(e => e.name === 'Comfy Car').path.length <= 64);
  assert.equal(plan.motion.length, 120, 'the engine keeps every frame');
  const full = empty();
  for (let i = 0; i < 190; i++) full.scene.entities.push({ ...p.scene.entities[0], id: `e${i}`, name: `Thing ${i}` });
  const many = structuredClone(m); many.objects = Array.from({ length: 11 }, (_, i) => ({ ...m.objects[0], name: `Box ${i}` }));
  assert.throws(() => handoffToOps(full, many), /would hold 201 objects; Previs holds 200/);
});

// ---------- 2. Projection proof ----------
test('projection: every Blender landmark lands on Blender’s pixel through the imported camera (AUTO and VERTICAL fit)', async () => {
  for (const m of [await sidecar(), JSON.parse(await readFile(VERTICAL, 'utf8'))]) {
    const plan = handoffToOps(empty(), m);
    assert.equal(plan.checks.length, 9, 'three landmarks at the first, middle and last frame');
    for (const c of plan.checks) assert.ok(c.error < 0.001, `${m.camera.sensorFit} frame ${c.frame}: ${(c.error * 100).toFixed(3)}% of the width`);
    assert.ok(!plan.warnings.some(w => /landmarks/.test(w)));
    // The test has teeth: Blender's lens copied unscaled against a 36 mm sensor (transfer.mjs's convention) misses.
    const wrong = plan.ops.at(-1).shot.camera.keys.map(k => ({ ...k, mm: m.camera.keys[0].lens }));
    if (m.camera.sensorFit === 'AUTO') assert.ok(projectionChecks(m, wrong, plan.duration).some(c => c.error > 0.001));
  }
});

// ---------- 5. Rejections ----------
test('rejections: each a clear message', async () => {
  const m = await sidecar(), frames = (await readHandoffDir(FIXTURE)).frames;
  const bad = (change, re) => { const x = structuredClone(m); change(x); assert.throws(() => validateHandoff(x, frames), re); };
  bad(x => { x.fps = 25; }, /set the scene to 24 fps/);
  bad(x => { x.frameCount = 121; }, /121 frames; Previs shots are 12–120 frames/);
  bad(x => { x.frameCount = 6; x.source.frameEnd = 6; }, /6 frames/);
  bad(x => { x.width = 1281; }, /1281×360; Previs plays 1280×720 or 640×360/);
  bad(x => { x.width = 641; x.height = 361; }, /641×361/);
  bad(x => { x.format = 'gltf'; }, /Not a Blender export for Previs/);
  bad(x => { x.camera.keys.pop(); }, /one \{p, fwd, up, lens\} per frame \(12\)/);
  bad(x => { x.objects[1].name = 'crate'; }, /both become “crate”/);
  const missing = new Map(frames); missing.delete(7);
  assert.throws(() => validateHandoff(m, missing), /frames\/frame-000007\.png is missing/);
  const wide = new Map(frames), png = Buffer.from(frames.get(3)); png.writeUInt32BE(1280, 16); png.writeUInt32BE(720, 20); wide.set(3, png);
  assert.throws(() => validateHandoff(m, wide), /frame-000003\.png is 1280×720; the export says 640×360/);
  await assert.rejects(readHandoffDir('tests/fixtures/blender-handoff/shot.previs-blender'), /absolute path/);
  const dir = await mkdtemp(join(tmpdir(), 'previs-blender-link-')), link = join(dir, 'link');
  await symlink(FIXTURE, link);
  await assert.rejects(readHandoffDir(link), /real path, without symlinks/);
  const copy = join(dir, 'copy'); await cp(FIXTURE, copy, { recursive: true });
  await rm(join(copy, 'frames', 'frame-000004.png')); await symlink(join(FIXTURE, 'frames', 'frame-000004.png'), join(copy, 'frames', 'frame-000004.png'));
  await assert.rejects(readHandoffDir(copy), /frame-000004\.png must be a regular file \(not a link\)/);
  const entries = async prefix => [{ name: `${prefix}blender-previs.json`, data: Buffer.from(JSON.stringify(m)) }, ...(await readdir(join(FIXTURE, 'frames'))).map(n => ({ name: `${prefix}frames/${n}`, data: frames.get(Number(n.slice(6, 12))) }))];
  const zipped = readHandoffZip(writeZip([...await entries('shot.previs-blender/'), { name: '__MACOSX/shot.previs-blender/._x', data: Buffer.from('x') }]));
  assert.equal(zipped.frames.size, 12); validateHandoff(zipped.manifest, zipped.frames);
  const top = await entries('');
  assert.throws(() => readHandoffZip(writeZip([...top, { name: 'run-me.sh', data: Buffer.from('echo') }])), /Unexpected file in the Blender export: run-me\.sh/);
  assert.throws(() => readHandoffZip(writeZip([...top, { name: 'frames/frame-000012.png.bak', data: Buffer.from('x') }])), /Unexpected file/);
  await rm(dir, { recursive: true, force: true });
});

// ---------- 3, 4, 6, 7. Server round trip ----------
async function startServer(port) {
  const dir = await mkdtemp(join(tmpdir(), 'previs-blender-import-'));
  const server = spawn(process.execPath, ['server/previs/server.mjs'], { env: { ...process.env, PORT: String(port), PREVIS_DATA_DIR: dir, PREVIS_HEADLESS: '', PREVIS_BATCH_FAKE: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { server.stdout.on('data', d => { if (String(d).includes('Comfy Previs:')) resolve(); }); server.once('exit', c => reject(Error('server exited ' + c))); });
  const base = `http://127.0.0.1:${port}`;
  const call = async (path, body, headers = { 'Content-Type': 'application/json' }) => { const r = await fetch(base + path, body === undefined ? {} : { method: 'POST', headers, body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
  return { dir, call, stop: async () => { const ended = once(server, 'exit'); server.kill('SIGTERM'); await ended; await rm(dir, { recursive: true, force: true }); } };
}

test('server round trip: import, downstream consumers, refresh, stale hand-over and the Blender still guide', { skip: !mediaAvailable && 'needs ffmpeg and ffprobe', timeout: 120000 }, async () => {
  const srv = await startServer(15296), { call } = srv;
  try {
    // A bad export into an existing project changes nothing (validation precedes the edit).
    const made = (await call('/api/director/projects', { title: 'Lap', template: 'empty' })).json.project;
    const work = await mkdtemp(join(tmpdir(), 'previs-blender-bad-')); await cp(FIXTURE, work, { recursive: true });
    const bad = JSON.parse(await readFile(join(work, 'blender-previs.json'))); bad.fps = 30; await writeFile(join(work, 'blender-previs.json'), JSON.stringify(bad));
    const refused = await call('/api/director/import-blender', { projectId: made.id, path: work });
    assert.equal(refused.status, 400); assert.match(refused.json.error, /24 fps/);
    assert.equal((await call(`/api/director/project?id=${made.id}`)).json.project.revision, made.revision);

    // 3. Import into the existing project: a new shot whose blockout clip is Blender's frames.
    const r = (await call('/api/director/import-blender', { projectId: made.id, path: FIXTURE })).json;
    assert.ok(r.project, JSON.stringify(r));
    let p = r.project, s = p.shots.find(x => x.id === r.shotId);
    assert.equal(p.shots.length, 2); assert.equal(s.title, 'ShotCam');
    assert.equal(s.render.origin, 'blender'); assert.equal(s.render.frameCount, 12); assert.equal(s.render.width, 640);
    const renders = p.assets.filter(a => a.kind === 'camera-render');
    assert.equal(renders.length, 1); assert.equal(renders[0].frameCount, 12); assert.equal(renders[0].source.origin, 'blender');
    assert.equal(blockoutStale(p, s), false); assert.equal(blenderBlockout(p, s), true);
    assert.ok(r.checks.every(c => c.error < 0.001));
    const skipped = (await call('/api/director/render-blockout', { projectId: p.id, shotId: s.id })).json;
    assert.equal(skipped.skipped, true); assert.equal(skipped.previsShotId, r.previsShotId); assert.equal(skipped.asset.id, r.assetId);
    const refs = await call('/api/director/video-refs', { projectId: p.id, shotId: s.id, previsShotId: r.previsShotId, max: 4 });
    assert.equal(refs.status, 200, refs.json.error); assert.deepEqual(refs.json.references, []);
    const plan = (await call('/api/director/batch', { projectId: p.id, steps: ['videos'], tier: 'final', maxCostUsd: 5, dryRun: true, shots: [s.id] })).json.batch;
    const node = id => plan.nodes.find(n => n.id === `${id}:${s.id}`);
    assert.equal(plan.status, 'planned'); assert.equal(node('blockout').status, 'skipped'); assert.equal(node('blockout').assetId, r.assetId);
    assert.equal(node('video').model, 'seedance-25-edit-v1'); assert.equal(node('video').cameraSource, 'blockout');
    const engine = (await call('/api/project')).json.project, engineShot = engine.shots.find(x => x.id === r.previsShotId);
    assert.equal(engineShot.browser.director.shotId, s.id); assert.equal(engineShot.browser.frames.length, 12);
    assert.equal(engine.assets.find(a => a.id === r.assetId).provenance.renderer, 'Blender render, imported');

    // 7. The still guide is Blender's own frame, not the proxies (and needs no headless renderer).
    const frameAt = async t => (await call('/api/director/frame', { projectId: p.id, shotId: s.id, t, guide: true })).json;
    const g0 = await frameAt(0), g6 = await frameAt(0.25);
    assert.equal(g0.source, 'blender'); assert.equal(g0.frame, 0); assert.equal(g6.frame, 6); assert.equal(g0.width, 640);
    const mp4 = join(srv.dir, 'director', p.id, 'assets', `${r.assetId}.mp4`);
    const direct = i => spawnSync(process.env.PREVIS_FFMPEG || 'ffmpeg', ['-v', 'error', '-i', mp4, '-vf', `select=eq(n\\,${i})`, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1']).stdout;
    assert.ok(Buffer.from(g6.data, 'base64').equals(direct(6)), 'frame 6 of the clip'); assert.ok(!Buffer.from(g6.data, 'base64').equals(direct(5)));
    assert.ok(Buffer.from(g0.data, 'base64').equals(direct(0)), 'frame 0 of the clip');
    const prompt = o => stillPrompt({ project: p, shot: s, t: 0, ...o });
    assert.match(prompt({}), /headlights/); assert.doesNotMatch(prompt({ markers: false }), /headlights|ground wedges/);

    // 4. Refresh: re-import with a moved object into the same shot; references and earlier clips stay.
    const look = await call('/api/director/reference', { projectId: p.id, scope: 'object', entityId: r.mapping.find(x => x.name === 'Crate').entityId, name: 'crate look', data: (await readFile(join(FIXTURE, 'frames', 'frame-000000.png'))).toString('base64') });
    assert.equal(look.status, 200, look.json.error);
    const moved = await mkdtemp(join(tmpdir(), 'previs-blender-moved-')); await cp(FIXTURE, moved, { recursive: true });
    const m2 = JSON.parse(await readFile(join(moved, 'blender-previs.json'))); m2.objects.find(o => o.name === 'Crate').frames[0].position[0] += 2;
    await writeFile(join(moved, 'blender-previs.json'), JSON.stringify(m2));
    const again = (await call('/api/director/import-blender', { projectId: p.id, shotId: s.id, path: moved })).json;
    assert.ok(again.project, JSON.stringify(again));
    p = again.project; s = p.shots.find(x => x.id === s.id);
    const crates = p.scene.entities.filter(e => e.name === 'Crate');
    assert.equal(crates.length, 1); assert.deepEqual(crates[0].position, [5, 0, -2]); assert.equal(crates[0].look, look.json.referenceId);
    assert.deepEqual(again.mapping.map(x => x.action), ['updated', 'updated', 'updated', 'updated']);
    const versions = p.assets.filter(a => a.kind === 'camera-render' && a.shotId === s.id).map(a => a.version);
    assert.deepEqual(versions, [1, 2]); assert.equal(s.render.assetId, again.assetId); assert.equal(p.shots.length, 2);
    assert.equal(p.scene.references.length, 1);

    // 6. A Previs edit hands the shot back to the proxies: stale, so render-blockout renders again, and a proxy capture clears origin.
    p = (await call('/api/director/edit', { projectId: p.id, ops: [{ op: 'update_entity', id: 'Crate', patch: { position: [6, 0, -2] } }] })).json.project;
    s = p.shots.find(x => x.id === s.id);
    assert.equal(blockoutStale(p, s), true); assert.equal(blenderBlockout(p, s), false);
    const again2 = await call('/api/director/render-blockout', { projectId: p.id, shotId: s.id });
    assert.equal(again2.json.code, 'headless-unavailable', 'not skipped: it would render the proxies');
    assert.notEqual((await frameAt(0)).source, 'blender', 'a stale import is no longer the still guide');
    const proxy = (await call('/api/director/render', { projectId: p.id, shotId: s.id, previsShotId: again.previsShotId, assetId: again.assetId, signature: shotSignature(p, s) })).json.project;
    assert.equal(proxy.shots.find(x => x.id === s.id).render.origin, undefined);

    // Zip drop on the home screen: no projectId makes a new project whose first shot takes the import.
    const all = await readHandoffDir(FIXTURE);
    const zip = writeZip([{ name: 'lap.previs-blender/blender-previs.json', data: await readFile(join(FIXTURE, 'blender-previs.json')) }, ...[...all.frames].map(([i, data]) => ({ name: `lap.previs-blender/${frameName(i)}`, data }))]);
    const z = (await call('/api/director/import-blender-zip?title=Final%20lap', zip, { 'Content-Type': 'application/zip' })).json;
    assert.ok(z.project, JSON.stringify(z));
    assert.equal(z.project.title, 'Final lap'); assert.equal(z.project.shots.length, 1); assert.equal(z.project.shots[0].title, 'ShotCam'); assert.equal(z.project.shots[0].render.origin, 'blender');
    const junk = writeZip([{ name: 'blender-previs.json', data: await readFile(join(FIXTURE, 'blender-previs.json')) }, { name: 'notes.txt', data: Buffer.from('x') }]);
    assert.match((await call('/api/director/import-blender-zip', junk, { 'Content-Type': 'application/zip' })).json.error, /Unexpected file in the Blender export: notes\.txt/);
    assert.equal((await call('/api/director/import-blender-zip', Buffer.from('{}'), { 'Content-Type': 'application/json' })).status, 415);
    await rm(work, { recursive: true, force: true }); await rm(moved, { recursive: true, force: true });
  } finally { await srv.stop(); }
});

test('MCP: previs_director_blender_helper and previs_director_import_blender against a live server', { skip: !mediaAvailable && 'needs ffmpeg and ffprobe', timeout: 120000 }, async () => {
  const srv = await startServer(15297);
  const agent = spawn(process.execPath, ['server/previs/agent.mjs'], { env: { ...process.env, PREVIS_MCP_LEGACY: '', PREVIS_URL: 'http://127.0.0.1:15297' }, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map(); let n = 0, buffer = '';
  agent.stdout.on('data', d => { buffer += d; let i; while ((i = buffer.indexOf('\n')) >= 0) { const m = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1); pending.get(m.id)?.(m); } });
  const rpc = (method, params) => new Promise(r => { const id = ++n; pending.set(id, r); agent.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const tool = async (name, args) => { const m = await rpc('tools/call', { name, arguments: args }); assert.equal(m.result.isError, false, m.result.content[0].text); return JSON.parse(m.result.content[0].text); };
  try {
    const listed = (await rpc('tools/list', {})).result.tools.map(t => t.name);
    for (const t of ['previs_director_import_blender', 'previs_director_blender_helper']) assert.ok(listed.includes(t), t);
    const helper = await tool('previs_director_blender_helper', {});
    assert.equal(helper.script, fileURLToPath(new URL('../scripts/blender/previs_export.py', import.meta.url)));
    assert.match(helper.headless, /-P .*previs_export\.py -- --out/); assert.match(helper.blenderMcp, /PREVIS_EXPORT = /);
    const first = await tool('previs_director_import_blender', { path: FIXTURE, title: 'From Claude' });
    assert.equal(first.shot.number, 1); assert.equal(first.frames, 12); assert.equal(first.objects.length, 4);
    assert.ok(first.landmarks.checked === 9 && first.landmarks.worstErrorPctOfWidth < 0.1);
    assert.match(first.open, /director\.html\?project=/);
    const again = await tool('previs_director_import_blender', { projectId: first.projectId, shot: '1', path: FIXTURE });
    assert.equal(again.shot.id, first.shot.id); assert.ok(again.objects.every(o => o.action === 'updated'));
    const refused = await rpc('tools/call', { name: 'previs_director_import_blender', arguments: { path: 'relative/folder' } });
    assert.equal(refused.result.isError, true); assert.match(refused.result.content[0].text, /absolute path/);
  } finally { agent.kill(); await srv.stop(); }
});

// The helper itself needs Blender, so this runs only when PREVIS_BLENDER names the binary
// (e.g. /Applications/Blender.app/Contents/MacOS/Blender); it was run with Blender 5.3.0 Alpha.
test('helper: Blender re-exports the fixture scene to the same sidecar and refuses bad scenes and folders', { skip: !process.env.PREVIS_BLENDER && 'set PREVIS_BLENDER to a Blender binary to run scripts/blender/previs_export.py', timeout: 180000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'previs-blender-helper-')), out = join(dir, 'shot');
  const blender = args => spawnSync(process.env.PREVIS_BLENDER, ['-b', '--factory-startup', ...args], { encoding: 'utf8' });
  const made = blender(['-P', 'scripts/blender/build-test-scene.py', '--', '--out', out]);
  assert.equal(made.status, 0, made.stderr); assert.match(made.stdout, new RegExp(`wrote 12 frames and 4 objects to ${out}`));
  const want = await sidecar(), got = JSON.parse(await readFile(join(out, 'blender-previs.json'), 'utf8'));
  const same = (a, b, at) => {
    if (typeof a === 'number' && typeof b === 'number') return close(a, b, 1e-3, at);
    if (a && typeof a === 'object') { assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), at); for (const k of Object.keys(a)) if (at !== 'exporter') same(a[k], b[k], `${at}.${k}`); return; }
    assert.equal(a, b, at);
  };
  same(got, want, 'sidecar');
  assert.equal((await readdir(join(out, 'frames'))).length, 12);
  validateHandoff(got, (await readHandoffDir(out)).frames);
  const refused = blender(['--python-expr', 'import bpy; bpy.context.scene.render.fps = 25', '-P', 'scripts/blender/previs_export.py', '--', '--out', join(dir, 'x')]);
  assert.equal(refused.status, 1); assert.match(refused.stderr, /set the scene to 24 fps \(or pass --fps24\)/);
  await writeFile(join(dir, 'notes.txt'), 'mine');
  const occupied = blender(['-P', 'scripts/blender/build-test-scene.py', '--', '--out', dir]);
  assert.notEqual(occupied.status, 0); assert.match(occupied.stderr + occupied.stdout, /holds other files; choose an empty or new folder/);
  assert.equal(await readFile(join(dir, 'notes.txt'), 'utf8'), 'mine');
  await rm(dir, { recursive: true, force: true });
});
