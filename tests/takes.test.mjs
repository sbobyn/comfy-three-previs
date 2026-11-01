// Takes (shared/takes.mjs), the set_winner edit, the Take lab's pure helpers and the MCP list/set-winner tools.
// No generation: the fixture copies a starter's bundled clips in as extra takes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { shotTakes, videoTakes, stillTakes, winnerOf, winnerOps, cutAsset, takeDifferences } from '../shared/takes.mjs';
import { applyOps, clipAsset, summarizeOps } from '../server/previs/director.mjs';
import * as stillMatch from '../shared/still-match.mjs';
import { takeFixture } from './fixtures/take-fixture.mjs';

const ids = n => Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`);
const [S1, S2, B1, B2, V1, V2, V3, R1, R2, R3] = ids(10);
function project() {
  const shot = id => ({ id, title: id === S1 ? 'One' : 'Two', description: '', duration: 5, start: 0, camera: { move: 'static', target: null, distance: 5, height: 1.6, angle: 0, mm: 35, keys: null }, references: [], render: null, cast: { include: [], exclude: [] } });
  const video = (id, at, extra = {}) => ({ id, kind: 'workflow-result', shotId: S1, file: `assets/${id}.mp4`, mime: 'video/mp4', sha256: '', width: 1280, height: 720, fps: 24, frameCount: 120, duration: 5, createdAt: at, source: { sourceAssetId: B1, workflow: 'Seedance 2.5 · edit', backend: 'cloud', cameraSource: 'blockout', prompt: 'A news anchor.', parameters: { seed: 1, resolution: '720p' }, inputs: ['sourceVideo'], quote: { status: 'unknown', amount: 0.5, currency: 'USD' }, ...extra } });
  const p = { version: 1, id: 'p', title: 'T', template: 'empty', createdAt: '', updatedAt: '', revision: 1, scene: { name: 's', environment: { preset: 'stage', description: '' }, entities: [], references: [] }, shots: [shot(S1), shot(S2)], messages: [],
    assets: [
      { id: B1, kind: 'camera-render', shotId: S1, file: `assets/${B1}.mp4`, mime: 'video/mp4', sha256: '', width: 1280, height: 720, fps: 24, frameCount: 120, duration: 5, version: 1, createdAt: '2026-10-31T08:00:00Z', source: {} },
      video(V1, '2026-10-31T09:00:00Z'),
      video(V2, '2026-10-31T10:00:00Z', { workflow: 'LTX 2.5 Fast', cameraSource: 'still', parameters: { seed: 2, resolution: '720p' }, inputs: ['firstFrame'] }),
      { ...video(V3, '2026-10-31T11:00:00Z', { parameters: { seed: 3, resolution: '1080p' } }), frameCount: 121, duration: 121 / 24 },
      { id: B2, kind: 'camera-render', shotId: S2, file: `assets/${B2}.mp4`, mime: 'video/mp4', sha256: '', width: 1280, height: 720, fps: 24, frameCount: 96, duration: 4, version: 1, createdAt: '2026-10-31T08:00:00Z', source: {} },
    ] };
  p.shots[0].references = [
    { id: R1, name: 'a', file: `${R1}.png`, mime: 'image/png', role: 'frame', entityId: null, note: 'key frame start', createdAt: '1', generated: { requestId: 'q1', presetId: 'flux-3', model: 'FLUX 3 Image (BFL)', prompt: 'x', seed: 5, backend: 'cloud', promptId: '', guideMatch: { score: 8, layout: 7, camera: 9, headings: 8, why: 'Close.', method: 'gemini-grader:Gemini 3.5 Flash' } } },
    { id: R2, name: 'b', file: `${R2}.png`, mime: 'image/png', role: 'frame', entityId: null, note: 'key frame start', createdAt: '2', generated: { requestId: 'q2', presetId: 'gpt', model: 'GPT Image 2.5 (OpenAI)', prompt: 'x', seed: 6, backend: 'cloud', promptId: '', guideMatch: { score: 6, method: 'edges-32x18-v1', rough: true } } },
    { id: R3, name: 'c', file: `${R3}.png`, mime: 'image/png', role: 'frame', entityId: null, note: 'key frame end', createdAt: '3' },
  ];
  return p;
}

test('video takes: oldest is Take 1, labelled with model, settings, seed, inputs, cost and grades; losing takes stay', () => {
  const p = project(), [t1, t2, t3] = videoTakes(p, p.shots[0]);
  assert.deepEqual([t1.label, t2.label, t3.label], ['Take 1', 'Take 2', 'Take 3']);
  assert.equal(t2.model, 'LTX 2.5 Fast'); assert.equal(t3.seed, 3); assert.deepEqual(t3.settings, { resolution: '1080p' });
  assert.deepEqual(t1.inputs.map(x => x.label), ['Blockout clip v1']); assert.deepEqual(t2.inputs.map(x => x.label), ['Start still']);
  assert.deepEqual(t1.cost, { usd: 0.5, status: 'estimate' });
  assert.equal(t1.grades.layout.status, 'not-graded', 'no video grader: never a made-up layout score');
  assert.equal(t1.grades.identity.status, 'not-assessed');
  assert.equal(t1.grades.timing.status, 'match');
  assert.equal(t3.grades.timing.status, 'differs'); assert.equal(t3.grades.timing.frames, 1);
  // Nothing chosen: the cut plays the newest take, and there is no winner.
  assert.equal(winnerOf(p, p.shots[0]), null); assert.equal(cutAsset(p, p.shots[0]).id, V3);
  assert.ok(t3.inCut && !t3.winner);
  assert.deepEqual(takeDifferences([t1, t3]), ['seed', 'settings.resolution']);
  assert.deepEqual(takeDifferences([t1, t2]).sort(), ['cameraSource', 'inputs', 'model', 'seed'].sort());
});

test('cost: billed from the budget ledger, estimate while held, free for a local run, unknown without a price', () => {
  const p = project(), jobs = [{ id: 'j1', binding: { parameters: { seed: 9 }, assetBindings: { sourceVideo: {} }, prompt: 'P' }, definition: { id: 'd', title: 'Kling O1 · edit', pricing: { ratePerSecond: 0.1 } }, backend: { kind: 'cloud' }, quote: { amount: null }, acceptedAt: '2026-10-31T09:00:00Z', completedAt: '2026-10-31T09:03:52Z' }];
  p.assets[1].source.jobId = 'j1'; p.assets[1].source.quote = null;
  let [t1] = videoTakes(p, p.shots[0], { jobs });
  assert.deepEqual(t1.cost, { usd: 0.5, status: 'estimate' }, 'rate × seconds from the receipt'); assert.equal(t1.seed, 9); assert.equal(t1.elapsedSeconds, 232);
  [t1] = videoTakes(p, p.shots[0], { jobs, ledger: { j1: { state: 'settled', costUsd: 0.61, expectedUsd: 0.5, costStatus: 'billed' } } });
  assert.deepEqual(t1.cost, { usd: 0.61, status: 'billed' });
  [t1] = videoTakes(p, p.shots[0], { jobs, ledger: { j1: { state: 'held', costUsd: null, expectedUsd: 0.55, costStatus: 'estimated' } } });
  assert.deepEqual(t1.cost, { usd: 0.55, status: 'estimate' });
  jobs[0].backend.kind = 'local'; jobs[0].quote.nodes = [{ apiNode: false }];
  [t1] = videoTakes(p, p.shots[0], { jobs });
  assert.deepEqual(t1.cost, { usd: 0, status: 'free' });
  const [start] = stillTakes(p, p.shots[0], { ledger: { q1: { state: 'settled', costUsd: 0.04, costStatus: 'billed' }, 'q1-grade': { state: 'settled', costUsd: 0.01, costStatus: 'billed' } } });
  assert.deepEqual(start.takes[0].cost, { usd: 0.05, status: 'billed' }, 'the still and its grade');
  assert.deepEqual(start.takes[1].cost, { usd: null, status: 'unknown' });
  assert.deepEqual(stillTakes(p, p.shots[0], { prices: { gpt: 0.07 } })[0].takes[1].cost, { usd: 0.07, status: 'estimate' });
});

test('still takes: grouped by moment, the last take in use; layout only from the paid grader, identity never claimed', () => {
  const p = project(), [start, end] = stillTakes(p, p.shots[0]);
  assert.equal(start.label, 'Start'); assert.equal(end.label, 'End');
  assert.equal(start.inUse, R2); assert.ok(start.takes[1].winner);
  assert.deepEqual([start.takes[0].grades.layout.status, start.takes[0].grades.layout.score], ['graded', 7]);
  assert.equal(start.takes[1].grades.layout.status, 'not-graded', 'the rough local check is not a verdict');
  assert.equal(end.takes[0].model, 'Uploaded');
  for (const t of [...start.takes, ...end.takes]) assert.equal(t.grades.identity.status, 'not-assessed');
});

test('set_winner: the winner wins over newest, a later take does not replace it, and the cut and export follow it', () => {
  const p = project(), s = p.shots[0];
  const { redo, undo } = winnerOps(p, s, V1);
  assert.deepEqual(redo, [{ op: 'set_winner', shotId: S1, assetId: V1 }]); assert.deepEqual(undo, [{ op: 'set_winner', shotId: S1, assetId: null }]);
  applyOps(p, redo);
  assert.equal(s.winner, V1); assert.deepEqual(winnerOf(p, s), { assetId: V1, from: 'winner' });
  assert.equal(clipAsset(p, { shotId: S1, assetId: null }).id, V1, 'film export plays the winner');
  p.assets.push({ ...structuredClone(p.assets[1]), id: '00000000-0000-4000-8000-0000000000aa', createdAt: '2026-11-01T00:00:00Z' });
  assert.equal(cutAsset(p, s).id, V1, 'a newer take never replaces the winner');
  assert.equal(videoTakes(p, s).length, 4, 'every take kept');
  assert.equal(clipAsset(p, { shotId: S1, assetId: B1 }).id, B1, 'a blockout chosen on the clip still wins in the cut');
  applyOps(p, undo); assert.equal(s.winner, undefined);
  assert.throws(() => applyOps(p, [{ op: 'set_winner', shotId: S1, assetId: B1 }]), /not a generated video of this shot/);
  assert.throws(() => applyOps(p, [{ op: 'set_winner', shotId: S2, assetId: V1 }]), /not a generated video of this shot/);
  assert.throws(() => winnerOps(p, s, B1), /not a generated video/);
  assert.match(summarizeOps([{ op: 'set_winner', shotId: S1, assetId: V1 }], p), /Picked the winning take of shot “One”/);
});

test('set_winner clears a version chosen on the cut clip (and its trims), keeps a left-out shot out, and undoes both', () => {
  const p = project(), s = p.shots[0];
  p.edit = { clips: [{ id: 'c1', shotId: S1, assetId: V2, in: 1, out: 3 }, { id: 'c2', shotId: S2, assetId: null, in: 0, out: null }], updatedAt: '' };
  assert.deepEqual(winnerOf(p, s), { assetId: V2, from: 'cut' }, 'a project from before winners: the cut’s chosen video is the winner');
  const ops = winnerOps(p, s, V3);
  applyOps(p, ops.redo);
  assert.equal(s.winner, V3); const { id: _, ...clip } = p.edit.clips[0]; assert.deepEqual(clip, { shotId: S1, assetId: null, in: 0, out: null });
  assert.equal(cutAsset(p, s).id, V3);
  applyOps(p, ops.undo);
  assert.equal(s.winner, undefined); assert.equal(p.edit.clips[0].assetId, V2); assert.equal(p.edit.clips[0].in, 1);
  p.edit.clips = p.edit.clips.filter(c => c.shotId !== S1);
  const out = winnerOps(p, s, V1);
  assert.equal(out.inCut, false); assert.equal(out.redo.length, 1, 'a left-out shot stays out');
});

test('shotTakes: the MCP answer names the winner, what the cut plays and why', () => {
  const p = project(); p.shots[0].winner = V2;
  const t = shotTakes(p, p.shots[0]);
  assert.deepEqual(t.winner.video, { takeId: V2, label: 'Take 2', from: 'winner' });
  assert.deepEqual(t.cut, { inCut: true, takeId: V2, kind: 'video', follows: 'winner' });
  assert.deepEqual(t.winner.stills.map(x => [x.moment, x.label]), [['Start', 'Take 2'], ['End', 'Take 1']]);
});

// ---------- The Take lab's pure helpers (src/director-takes-core.ts) ----------
const core = (() => {
  const out = ts.transpileModule(readFileSync(new URL('../src/director-takes-core.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {}; runInNewContext(out, { exports, require: m => (m.endsWith('still-match.mjs') ? stillMatch : {}) }); return exports;
})();

test('take lab: the winner opens first, at most four lanes, and an extra tick is refused', () => {
  const takes = [{ id: 'a', createdAt: '1', winner: true }, { id: 'b', createdAt: '2' }, { id: 'c', createdAt: '3' }, { id: 'd', createdAt: '4' }, { id: 'e', createdAt: '5' }];
  assert.deepEqual([...core.defaultPicks(takes)], ['a', 'e', 'd', 'c']);
  assert.deepEqual([...core.togglePick(['a', 'b', 'c', 'd'], 'e')], ['a', 'b', 'c', 'd']);
  assert.deepEqual([...core.togglePick(['a', 'b'], 'a')], ['b']);
  assert.deepEqual([1, 2, 3, 4, 5].map(core.gridColumns), [1, 2, 3, 2, 3]);
});

test('take lab clock: frame steps land inside a frame, stay in range, and a shorter lane holds its last frame', () => {
  assert.equal(core.frameAt(core.timeOfFrame(60)), 60);
  assert.equal(core.frameAt(core.stepFrame(core.timeOfFrame(60), 1, 5)), 61);
  assert.equal(core.frameAt(core.stepFrame(0, -1, 5)), 0);
  assert.equal(core.frameAt(core.stepFrame(core.timeOfFrame(119), 1, 5)), 119, '120 frames: the last is 119');
  assert.equal(core.frameAt(core.stepFrame(core.timeOfFrame(119), 1, 121 / 24)), 120);
  assert.deepEqual({ ...core.laneTime(2, 4) }, { t: 2, ended: false });
  const held = core.laneTime(4.5, 4);
  assert.ok(held.ended && held.t < 4 && held.t > 3.97, 'frozen on its last frame, never stretched');
  assert.equal(core.timecode(core.timeOfFrame(60)), 'Frame 60 · 2.510 s');
});

test('take lab labels: cost words and grade words say what was measured', () => {
  assert.equal(core.costText({ usd: 0.61, status: 'billed' }), '$0.610 billed');
  assert.equal(core.costText({ usd: 0.5, status: 'estimate' }), '≈ $0.500 estimate');
  assert.equal(core.costText({ usd: 0, status: 'free' }), 'Free (local)');
  assert.equal(core.costText({ usd: null, status: 'unknown' }), 'Cost unknown');
  assert.equal(core.gradeText({ status: 'graded', score: 5, overall: 5, camera: 6, headings: 3, why: 'Faces left.', method: 'Gemini' }).tone, 'warn', `below WEAK_MATCH ${stillMatch.WEAK_MATCH} is weak`);
  assert.equal(core.gradeText({ status: 'not-assessed', note: 'n' }).value, 'Not assessed');
  assert.equal(core.gradeText({ status: 'differs', frames: 1, seconds: 0.04, note: 'n' }).value, '+1 frames');
  assert.deepEqual([...core.settingParts({ seed: 3, settings: { resolution: '1080p', duration: 5 } }, new Set(['settings.resolution']))].map(x => x.text), ['resolution 1080p']);
});

// ---------- MCP: a real server on the fixture, the stdio agent ----------
const freePort = () => new Promise((resolve, reject) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }).on('error', reject); });

test('MCP: list_takes shows every take with its labels; set_winner picks videos and stills, and clearing follows newest', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'previs-takes-'));
  const f = await takeFixture(join(dir, 'data'));
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['server/previs/server.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port), PREVIS_DATA_DIR: join(dir, 'data'), PREVIS_BUDGET_DIR: join(dir, 'budget'), PREVIS_COMFY_URL: 'http://127.0.0.1:9', PREVIS_ALLOW_PAID: '0', COMFY_CLOUD_API_KEY: '', COMFY_API_KEY: '', PREVIS_HEADLESS: '', PREVIS_AGENT: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { server.stdout.on('data', d => { if (String(d).includes('Comfy Previs:')) resolve(); }); server.once('exit', c => reject(Error('server exited ' + c))); });
  const agent = spawn(process.execPath, ['server/previs/agent.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PREVIS_URL: base, PREVIS_MCP_LEGACY: '' }, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map(); let n = 0;
  createInterface({ input: agent.stdout }).on('line', l => { const m = JSON.parse(l); pending.get(m.id)?.(m); });
  const tool = (name, args) => new Promise(r => { const id = ++n; pending.set(id, r); agent.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n'); })
    .then(m => { assert.equal(m.result.isError, false, m.result.content?.[0]?.text); return JSON.parse(m.result.content[0].text); });
  const read = async () => (await (await fetch(`${base}/api/director/project?id=${f.id}`)).json()).project;
  try {
    const list = await tool('previs_director_list_takes', { projectId: f.id, shot: '2' });
    assert.equal(list.videos.length, 4);
    assert.deepEqual(list.videos.map(v => v.label), ['Take 1', 'Take 2', 'Take 3', 'Take 4']);
    assert.deepEqual(list.videos.map(v => v.seed), [42, 11, 1234, 7]);
    assert.equal(list.videos[3].settings.resolution, '1080p');
    assert.ok(list.videos.every(v => v.grades.identity.status === 'not-assessed' && v.cost.status === 'estimate' && v.inputs.length));
    assert.deepEqual(list.winner.video.from, 'cut', 'the starter’s chosen video is the winner until another is picked');
    assert.ok(list.differences.includes('seed') && list.differences.includes('model'));
    const start = list.stills.find(m => m.label === 'Start');
    assert.equal(start.takes.length, 2); assert.equal(start.takes[0].grades.layout.score, 4); assert.equal(start.inUse, f.stills[1]);

    const won = await tool('previs_director_set_winner', { projectId: f.id, shot: '2', takeId: f.takes[2] });
    assert.match(won.text, /Take 3 is the winner of shot 2\. The cut and film export play it/);
    let p = await read(), s = p.shots[1];
    assert.equal(s.winner, f.takes[2]);
    assert.equal(p.edit.clips.find(c => c.shotId === s.id).assetId, null, 'the cut follows the winner');
    assert.equal(clipAsset(p, p.edit.clips.find(c => c.shotId === s.id)).id, f.takes[2]);
    assert.equal(p.assets.filter(a => a.shotId === s.id && a.kind === 'workflow-result').length, 4, 'no take removed');

    const still = await tool('previs_director_set_winner', { projectId: f.id, shot: '2', takeId: f.stills[0] });
    assert.match(still.text, /now Take 1/);
    p = await read(); assert.equal(p.shots[1].references.filter(r => r.note === 'key frame start').at(-1).id, f.stills[0]);

    const cleared = await tool('previs_director_set_winner', { projectId: f.id, shot: '2', takeId: null });
    assert.match(cleared.text, /no winner; the cut plays its newest take/);
    p = await read(); assert.equal(p.shots[1].winner, undefined); assert.equal(clipAsset(p, { shotId: p.shots[1].id, assetId: null }).id, f.takes[3]);

    const bad = await new Promise(r => { const id = ++n; pending.set(id, r); agent.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'previs_director_set_winner', arguments: { projectId: f.id, shot: '1', takeId: f.takes[2] } } }) + '\n'); });
    assert.equal(bad.result.isError, true); assert.match(bad.result.content[0].text, /not a take of shot 1/);
  } finally {
    agent.kill(); const ended = once(server, 'exit'); server.kill('SIGTERM'); await ended;
    await rm(dir, { recursive: true, force: true });
  }
});
