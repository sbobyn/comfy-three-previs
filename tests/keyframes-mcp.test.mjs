// previs_director_keyframe and Kling 4.0 in-between key frames end to end: a real server on an empty data dir with Comfy
// Cloud mocked by a preload (tests/fixtures/mock-cloud.mjs), so nothing leaves the machine and nothing is charged.
// Pins an exact blockout frame as an in-between key frame over MCP, refuses a pinned frame without a still, submits
// Kling 4.0 start → end with the in-between frame wired into its middle_frames slot, and makes a mid-shot still the end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { deflateSync, crc32 } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shotSignature } from '../shared/director.mjs';

const media = ['ffmpeg', 'ffprobe'].every(x => spawnSync(x, ['-version']).status === 0);

/** A solid-colour RGB PNG. */
function png(width, height, [r, g, b]) {
  const chunk = (type, data) => { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); data.copy(out, 8); out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length); return out; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}

test('MCP keyframe: pin an exact frame, refuse a missing one, and send Kling 4.0 its in-between frame (mocked Cloud)', { skip: !media && 'needs ffmpeg and ffprobe', timeout: 120000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'previs-mcp-keyframes-')), log = join(dir, 'cloud.jsonl');
  const port = 15000 + Math.floor(Math.random() * 3000), base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), PREVIS_DATA_DIR: join(dir, 'data'), PREVIS_BUDGET_DIR: join(dir, 'budget'), PREVIS_AGENT: 'off', PREVIS_HEADLESS: '', PREVIS_ALLOW_PAID: '1', PREVIS_ALLOW_UNKNOWN_COST: '0', PREVIS_BUDGET_CAP_USD: '20', COMFY_CLOUD_API_KEY: 'mock-key-not-real', MOCK_CLOUD_LOG: log };
  const server = spawn(process.execPath, ['--import', './tests/fixtures/mock-cloud.mjs', 'server/previs/server.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; server.stderr.on('data', d => { stderr += d; });
  await new Promise((resolve, reject) => { server.stdout.on('data', d => { if (String(d).includes('Comfy Previs:')) resolve(); }); server.once('exit', c => reject(Error(`server exited ${c}: ${stderr}`))); });
  const call = async (method, path, body) => { const r = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); const j = await r.json(); if (!r.ok) throw Error(`${path}: ${j.error}`); return j; };
  const post = (path, body) => call('POST', path, body), get = path => call('GET', path);
  const agent = spawn(process.execPath, ['server/previs/agent.mjs'], { env: { ...process.env, PREVIS_URL: base, PREVIS_MCP_LEGACY: '' }, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map(); let n = 0;
  createInterface({ input: agent.stdout }).on('line', l => { const m = JSON.parse(l); pending.get(m.id)?.(m); });
  const rpc = (name, args) => new Promise(r => { const id = ++n; pending.set(id, r); agent.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n'); });
  const tool = (name, args) => rpc(name, args).then(m => { assert.equal(m.result.isError, false, m.result.content?.[0]?.text); return JSON.parse(m.result.content[0].text); });
  const cloud = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  try {
    // A fresh project with one 4 s shot and its blockout clip, made the way the browser makes it.
    let p = (await post('/api/director/projects', { template: 'street', title: 'Key frames' })).project;
    p = (await post('/api/director/edit', { projectId: p.id, ops: [{ op: 'update_shot', id: p.shots[0].id, patch: { duration: 4 } }] })).project;
    const s = p.shots[0], frames = Array.from({ length: 96 }, (_, i) => ({ t: i / 24, p: [0, 1.6, 6 - i * 0.02], q: [0, 0, 0, 1], mm: 35 }));
    const grey = png(640, 360, [128, 128, 128]);
    const saved = await post('/api/browser-shot', { revision: (await get('/api/project')).project.revision, title: 'Key frames · Shot 1', camera: frames[0], subject: [0, 1, 0], frames, png: png(640, 360, [120, 120, 120]).toString('base64'), delivery: { width: 640, height: 360, fps: 24 },
      director: { projectId: p.id, shotId: s.id, projectRevision: p.revision, sceneName: p.scene.name, shotTitle: s.title, camera: s.camera, entities: p.scene.entities } });
    const previsShot = saved.project.shots.filter(x => x.browser?.director?.shotId === s.id).at(-1);
    const { stage } = await post('/api/video/browser/start', { revision: saved.project.revision, shotId: previsShot.id, width: 640, height: 360, fps: 24, frameCount: 96 });
    for (let i = 0; i < 96; i++) await post('/api/video/browser/frame', { stageId: stage.id, index: i, png: grey.toString('base64') });
    const { asset } = await post('/api/video/browser/finish', { stageId: stage.id });
    p = (await post('/api/director/render', { projectId: p.id, shotId: s.id, previsShotId: previsShot.id, assetId: asset.id, signature: shotSignature(p, p.shots[0]) })).project;
    // Uploaded start and end stills (uploads are never stale) and a cast image for each object in shot.
    for (const [note, rgb] of [['key frame start', [200, 40, 40]], ['key frame end', [40, 40, 200]]]) await post('/api/director/reference', { projectId: p.id, shotId: s.id, name: note, role: 'frame', note, data: png(64, 36, rgb).toString('base64') });
    for (const [i, e] of p.scene.entities.filter(x => x.kind !== 'environment').entries()) await post('/api/director/reference', { projectId: p.id, scope: 'object', entityId: e.id, name: `${e.name} look`, data: png(32, 32, [i * 30, 200, 90]).toString('base64') });
    // A still at frame 48 (2 s into the 4 s, 96-frame shot).
    const mid = (await post('/api/director/reference', { projectId: p.id, shotId: s.id, name: 'frame 48', role: 'frame', note: 'key frame @2s', data: png(64, 36, [40, 200, 40]).toString('base64') })).referenceId;

    let list = await tool('previs_director_keyframe', { projectId: p.id, shot: '1', model: 'kling-40-flf-v1' });
    assert.deepEqual([list.keyFrames.frames, list.keyFrames.lastFrame, list.keyFrames.start.state, list.keyFrames.end.state, list.keyFrames.middle.length], [96, 95, 'ready', 'ready', 0]);
    assert.match(list.forModel.takes, /start, end, up to 8 in-between frames, spaced evenly/);
    const veo = await tool('previs_director_keyframe', { projectId: p.id, shot: '1', model: 'veo-31-flf-v1' });
    assert.equal(veo.forModel.takes, 'start, end', 'Veo 3.1 takes a first and last frame only');

    // Pin frame 48 by time and frame 72 by number; 72 has no still yet.
    const pinned = await tool('previs_director_keyframe', { projectId: p.id, shot: '1', mode: 'attach', at: 2 });
    assert.deepEqual([pinned.frame, pinned.role, pinned.attached, pinned.pinned], [48, 'middle', 'middle', [48]]);
    await tool('previs_director_keyframe', { projectId: p.id, shot: '1', mode: 'attach', frame: 72 });
    list = await tool('previs_director_keyframe', { projectId: p.id, shot: '1', model: 'kling-40-flf-v1' });
    assert.deepEqual(list.keyFrames.middle.map(m => [m.frame, m.state]), [[48, 'ready'], [72, 'missing']]);
    assert.deepEqual(list.forModel.middle.map(m => [m.frame, m.slot, m.atSeconds]), [[48, 1, 1.333], [72, 2, 2.667]]);
    assert.ok(list.forModel.warnings.some(w => /frame 48 lands at 1\.33 s/.test(w)), 'evenly spaced: frame 48 lands early, and the plan says so');
    const inputs = await tool('previs_director_shot_inputs', { projectId: p.id, shot: '1', model: 'kling-40-flf-v1' });
    assert.deepEqual(inputs.keyFramePlan.middle.map(m => m.frame), [48, 72], 'shot_inputs previews the in-between frames');

    const refused = await tool('previs_director_generate_video', { projectId: p.id, shot: '1', model: 'kling-40-flf-v1', maxCostUsd: 2 });
    assert.equal(refused.submitted, false); assert.match(refused.reason, /In-between key frame 72 has no still.*nothing was sent/);
    assert.equal((await cloud()).filter(c => c.path === '/api/prompt').length, 0, 'nothing reached Cloud');

    // Unpin 72: Kling gets start, frame 48 and end.
    const unpin = await tool('previs_director_keyframe', { projectId: p.id, shot: '1', mode: 'unpin', frame: 72 });
    assert.deepEqual(unpin.keyFrames.middle.map(m => m.frame), [48]);
    const kling = await tool('previs_director_generate_video', { projectId: p.id, shot: '1', model: 'kling-40-flf-v1', maxCostUsd: 2 });
    assert.equal(kling.submitted, true, kling.reason); assert.equal(kling.cameraSource, 'keyframes');
    assert.deepEqual(kling.keyFrames.middle, [{ frame: 48, slot: 1, atSeconds: 2, driftSeconds: -0.021 }], 'one in-between frame lands at the middle of the 4 s clip');
    assert.doesNotMatch(kling.prompt, /dolly|pan |zoom|crane|orbit/i, 'the prompt names no camera move');
    const gen = await get('/api/generation'), job = gen.jobs.find(j => j.id === kling.jobId);
    assert.equal(job.definition.provenance.presetId, 'kling-40-flf-v1'); assert.equal(job.definition.provenance.middleFrames, 1);
    assert.deepEqual(Object.keys(job.binding.assetBindings).sort(), ['firstFrame', 'lastFrame', 'middleFrame1']);
    const sent = (await cloud()).filter(c => c.path === '/api/prompt');
    assert.equal(sent.length, 1);
    const node = Object.values(sent[0].graph).find(x => x.class_type === 'Kling4ImageToVideoNode');
    assert.ok(node.inputs['model.first_frame'] && node.inputs['model.last_frame'] && node.inputs['model.middle_frames.middle_frame_1'], 'first, middle and last frames are wired');
    assert.equal(sent[0].graph[node.inputs['model.middle_frames.middle_frame_1'][0]].class_type, 'LoadImage');

    // A mid-shot still as the End: an override that remembers its frame.
    const end = await tool('previs_director_keyframe', { projectId: p.id, shot: '1', mode: 'attach', frame: 48, role: 'end' });
    assert.equal(end.attached, 'end', JSON.stringify(end)); assert.match(end.override, /frame 48 is now the end key frame/);
    assert.equal(end.keyFrames.end.frame, 95); assert.match(end.keyFrames.end.from, /made at frame 48, chosen as the end/);
    const shot = (await get(`/api/director/project?id=${p.id}`)).project.shots[0];
    assert.equal(shot.references.at(-1).note, 'key frame end'); assert.equal(shot.references.at(-1).file, shot.references.find(r => r.id === mid).file);

    // Without the headless renderer there is no guide to see or generate from; nothing is prepared or sent.
    const guide = await rpc('previs_director_keyframe', { projectId: p.id, shot: '1', mode: 'guide', frame: 60 });
    assert.equal(guide.result.isError, false); assert.equal(JSON.parse(guide.result.content[0].text).available, false);
    const gen2 = await tool('previs_director_keyframe', { projectId: p.id, shot: '1', mode: 'generate', frame: 60, maxCostUsd: 0.2 });
    assert.equal(gen2.submitted, false); assert.match(gen2.reason, /needs the blockout frame as image 1; nothing was sent/);
    const bad = await rpc('previs_director_keyframe', { projectId: p.id, shot: '1', mode: 'guide', frame: 96 });
    assert.equal(bad.result.isError, true); assert.match(bad.result.content[0].text, /0 to 95/);
  } finally {
    agent.kill(); server.kill(); await new Promise(r => server.once('exit', r));
    await rm(dir, { recursive: true, force: true });
  }
});
