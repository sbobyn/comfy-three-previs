// previs_director_generate_video from clean storage: a real server on an empty data dir, Comfy Cloud mocked by a
// preload (tests/fixtures/mock-cloud.mjs) so nothing leaves the machine and nothing is charged. A built-in preset has
// never been saved here, so the agent must register it (like the workspace and batch) before binding. Covers the
// start → end key-frame path and the source-video path with cast references, and checks that shot_inputs previews
// the exact references and prompt that are submitted.
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

test('MCP generate_video registers the preset and submits from clean storage (mocked Cloud), matching shot_inputs', { skip: !media && 'needs ffmpeg and ffprobe', timeout: 120000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'previs-mcp-clean-')), log = join(dir, 'cloud.jsonl');
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
    let p = (await post('/api/director/projects', { template: 'street', title: 'Clean storage' })).project;
    p = (await post('/api/director/edit', { projectId: p.id, ops: [{ op: 'update_shot', id: p.shots[0].id, patch: { duration: 4 } }] })).project;
    const s = p.shots[0], frames = Array.from({ length: 96 }, (_, i) => ({ t: i / 24, p: [0, 1.6, 6 - i * 0.02], q: [0, 0, 0, 1], mm: 35 }));
    const grey = png(640, 360, [128, 128, 128]);
    const saved = await post('/api/browser-shot', { revision: (await get('/api/project')).project.revision, title: 'Clean storage · Shot 1', camera: frames[0], subject: [0, 1, 0], frames, png: png(640, 360, [120, 120, 120]).toString('base64'), delivery: { width: 640, height: 360, fps: 24 },
      director: { projectId: p.id, shotId: s.id, projectRevision: p.revision, sceneName: p.scene.name, shotTitle: s.title, camera: s.camera, entities: p.scene.entities } });
    const previsShot = saved.project.shots.filter(x => x.browser?.director?.shotId === s.id).at(-1);
    const { stage } = await post('/api/video/browser/start', { revision: saved.project.revision, shotId: previsShot.id, width: 640, height: 360, fps: 24, frameCount: 96 });
    for (let i = 0; i < 96; i++) await post('/api/video/browser/frame', { stageId: stage.id, index: i, png: grey.toString('base64') });
    const { asset } = await post('/api/video/browser/finish', { stageId: stage.id });
    p = (await post('/api/director/render', { projectId: p.id, shotId: s.id, previsShotId: previsShot.id, assetId: asset.id, signature: shotSignature(p, p.shots[0]) })).project;
    // Uploaded start and end stills (uploads are never stale) and a cast image for each object in shot.
    for (const [note, rgb] of [['key frame start', [200, 40, 40]], ['key frame end', [40, 40, 200]]]) await post('/api/director/reference', { projectId: p.id, shotId: s.id, name: note, role: 'frame', note, data: png(64, 36, rgb).toString('base64') });
    for (const [i, e] of p.scene.entities.filter(x => x.kind !== 'environment').entries()) await post('/api/director/reference', { projectId: p.id, scope: 'object', entityId: e.id, name: `${e.name} look`, data: png(32, 32, [i * 30, 200, 90]).toString('base64') });
    assert.equal((await get('/api/generation')).definitions.length, 0, 'clean storage: no saved definitions');

    // Start → end key frames (LTX 2.5 Pro): the review's failing call ("Save the mapped workflow preset first").
    const flf = await tool('previs_director_generate_video', { projectId: p.id, shot: '1', model: 'ltx-25-flf-v1', maxCostUsd: 2 });
    assert.equal(flf.submitted, true, flf.reason); assert.equal(flf.cameraSource, 'keyframes'); assert.equal(flf.clipSeconds, 4);
    assert.equal(flf.estimateUsd, 0.688, '4 s × $0.172/s, the seconds the model is asked for');
    let gen = await get('/api/generation');
    const ltx = gen.definitions.find(d => d.provenance?.presetId === 'ltx-25-flf-v1');
    assert.ok(ltx, 'the preset was registered before binding');
    let job = gen.jobs.find(j => j.id === flf.jobId);
    assert.equal(job.definition.id, ltx.id); assert.ok(['queued', 'submitted', 'running'].includes(job.status), job.status);
    assert.ok(job.binding.assetBindings.firstFrame && job.binding.assetBindings.lastFrame);
    assert.match(job.binding.prompt, /Move from the start still’s framing to the end still’s framing/);
    let sent = (await cloud()).filter(c => c.path === '/api/prompt');
    assert.equal(sent.length, 1);
    assert.ok(Object.values(sent[0].graph).some(x => x.class_type === 'LtxApi25ImageToVideo' && x.inputs.prompt === job.binding.prompt && x.inputs['model.duration'] === '4'), 'the bound prompt and the 4 s clip length reach Cloud');

    // The blockout clip itself (Seedance 2.5 edit) with references: shot_inputs previews exactly what is submitted.
    const preview = await tool('previs_director_shot_inputs', { projectId: p.id, shot: '1', model: 'seedance-25-edit-v1' });
    const clip = await tool('previs_director_generate_video', { projectId: p.id, shot: '1', model: 'seedance-25-edit-v1', maxCostUsd: 3 });
    assert.equal(clip.submitted, true, clip.reason); assert.equal(clip.cameraSource, 'blockout');
    assert.deepEqual(clip.references.slice(0, 2), ['Image 1: start still', 'Image 2: end still'], 'the start and end stills lead as the look');
    assert.deepEqual(clip.references, preview.referenceSlots.map(r => `${r.slot}: ${r.object}`), 'shot_inputs lists the submitted references in order');
    assert.equal(clip.prompt, preview.prompt, 'shot_inputs shows the submitted prompt');
    gen = await get('/api/generation'); job = gen.jobs.find(j => j.id === clip.jobId);
    assert.equal(job.definition.provenance.presetId, 'seedance-25-edit-v1'); assert.equal(job.definition.provenance.referenceImages, clip.references.length);
    assert.equal(job.binding.prompt, clip.prompt);
    assert.match(job.binding.prompt, /Reference images: 1 = start still; 2 = end still; 3 = /, 'the cast is numbered after the stills');
    sent = (await cloud()).filter(c => c.path === '/api/prompt');
    assert.equal(sent.length, 2);
    const seedance = Object.values(sent[1].graph).find(x => x.class_type === 'ByteDance2ReferenceNodeV2');
    assert.equal(Object.keys(seedance.inputs).filter(k => k.startsWith('model.reference_images.image_')).length, clip.references.length);
    assert.ok(Object.values(sent[1].graph).some(x => x.class_type === 'LoadVideo'), 'the blockout clip is the source video');

    // Calling again reuses the saved definition (no second copy); the identical request is refused as a duplicate.
    const again = await rpc('previs_director_generate_video', { projectId: p.id, shot: '1', model: 'ltx-25-flf-v1', maxCostUsd: 2 });
    assert.equal(again.result.isError, true); assert.match(again.result.content[0].text, /identical request is already queued.*nothing was sent/);
    assert.equal((await get('/api/generation')).definitions.filter(d => d.provenance?.presetId === 'ltx-25-flf-v1').length, 1);
    assert.equal((await cloud()).filter(c => c.path === '/api/prompt').length, 2, 'the duplicate never reached Cloud');
    assert.ok((await cloud()).every(c => c.path.startsWith('/api/')), 'only the mocked Cloud was called');
  } finally {
    agent.kill(); server.kill(); await new Promise(r => server.once('exit', r));
    await rm(dir, { recursive: true, force: true });
  }
});
