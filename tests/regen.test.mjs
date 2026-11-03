// Per-node regeneration keys (shared/regen.mjs, docs/regeneration.md): what each output was made from, what a change
// invalidates and why, and the batch planning only what changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEntity, makeShot, blockoutObjects, blockoutManifest, blockoutStale, stillStale, videoStale, shotSignature, starterMediaStatus, lookPrompt } from '../shared/director.mjs';
import { stillKey, videoKey, videoUses, lookKey, explainStale, staleText, dependentsOf, cleanManifest, lookPromptView } from '../shared/regen.mjs';
import { cameraSourceOf } from '../shared/camera-source.mjs';
import { planBatch, openBatches } from '../server/previs/batch.mjs';
import { builtInPresets } from '../server/previs/presets.mjs';
import { openDirector } from '../server/previs/director.mjs';
import { starterSnapshot } from '../server/previs/starters.mjs';
import { shotRegen } from '../server/previs/agent-regen.mjs';
import { TIERS } from '../shared/tiers.mjs';

const T = '2026-11-02T10:00:00.000Z';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const def = mid => builtInPresets.find(d => d.id === mid);
const KLING = def('kling-o1-edit-v1'), LTX = def('ltx-25-i2v-fast-v1');

/**
 * Two shots of one stage: A looks at the Hero from the front (+z); B looks at the Eagle far off to the left (-x).
 * The Eagle and the Rock behind it are only in B; the Hero is only in A. Each shot has a blockout clip, a start still and a
 * video, all recorded with manifests for the draft tier (made exactly as the batch would make them now).
 */
function stage() {
  const entities = [
    makeEntity({ name: 'Hero', shape: 'person', position: [0, 0, 0], notes: 'A tall runner in a red jacket' }, id(1)),
    makeEntity({ name: 'Eagle', shape: 'bird', kind: 'character', position: [-60, 3, 0], notes: 'A bald eagle' }, id(2)),
    makeEntity({ name: 'Rock', shape: 'rock', position: [-66, 0, 2] }, id(3)),
    makeEntity({ name: 'Crate', shape: 'box', position: [0, 0, 400] }, id(4)), // far behind A's camera, nowhere near B
  ];
  const a = makeShot({ title: 'Front', camera: { move: 'static', target: id(1), distance: 6, height: 1.6, angle: 0, mm: 35 }, duration: 2 }, id(10), 1, entities);
  const b = makeShot({ title: 'Eagle', camera: { move: 'static', target: id(2), distance: 8, height: 3, angle: 90, mm: 50 }, duration: 2 }, id(11), 2, entities);
  const p = { version: 1, id: id(99), title: 'Stage', template: 'empty', createdAt: T, updatedAt: T, revision: 1, scene: { name: 'Stage', environment: { preset: 'stage', description: 'an open field' }, entities, references: [] }, shots: [a, b], messages: [], assets: [] };
  for (const [i, e] of entities.entries()) { const ref = { id: id(200 + i), name: `${e.name} look`, file: `l${i}.png`, mime: 'image/png', role: 'character', entityId: e.id, note: '', createdAt: T, generated: { presetId: TIERS.draft.looks, model: 'FLUX', seed: 1, prompt: 'x' } }; p.scene.references.push(ref); e.look = ref.id; }
  for (const [i, e] of entities.entries()) p.scene.references[i].generated.regen = lookKey(p, e.id, { model: TIERS.draft.looks });
  for (const [i, s] of p.shots.entries()) {
    const clip = id(300 + i);
    p.assets.push({ id: clip, kind: 'camera-render', shotId: s.id, file: `assets/${clip}.mp4`, mime: 'video/mp4', createdAt: T, source: { signature: shotSignature(p, s), regen: blockoutManifest(p, s) } });
    s.render = { previsShotId: id(310 + i), assetId: clip, prompt: '', frameCount: 48, duration: 2, width: 1280, height: 720, signature: shotSignature(p, s), regen: blockoutManifest(p, s), createdAt: T };
    s.references.push({ id: id(400 + i), name: 'start', file: `s${i}.png`, mime: 'image/png', role: 'frame', entityId: null, note: 'key frame start', createdAt: T, generated: { presetId: TIERS.draft.stills, model: 'FLUX', seed: 7, prompt: 'x', signature: shotSignature(p, s), regen: stillKey(p, s, 'start', { model: TIERS.draft.stills }) } });
  }
  for (const [i, s] of p.shots.entries()) {
    const v = id(500 + i);
    p.assets.push({ id: v, kind: 'workflow-result', shotId: s.id, file: `assets/${v}.mp4`, mime: 'video/mp4', createdAt: T, source: { sourceAssetId: s.render.assetId, definitionId: LTX.id, regen: videoKey(p, s, { def: LTX, model: LTX.id, cameraSource: cameraSourceOf(LTX), uses: videoUses(LTX) }) } });
  }
  return p;
}
const [A, B] = [0, 1];
const verdicts = (p, i, opts = {}) => {
  const s = p.shots[i];
  return { blockout: explainStale(p, { type: 'blockout', shotId: s.id }), still: explainStale(p, { type: 'still', shotId: s.id, at: 'start' }, { model: TIERS.draft.stills, ...opts.still }), video: explainStale(p, { type: 'video', shotId: s.id }, { def: LTX, model: LTX.id, cameraSource: cameraSourceOf(LTX), uses: videoUses(LTX), ...opts.video }) };
};
const states = v => [v.blockout.state, v.still.state, v.video.state];
const codes = x => x.reasons.map(r => r.code);
const draft = { steps: ['looks', 'stills', 'videos'], tier: 'draft', maxCostUsd: 20 };
const planned = nodes => nodes.filter(n => !['skipped', 'failed'].includes(n.status)).map(n => n.id).sort();

test('visibility: a blockout counts only the objects its frames can show, plus the camera target', () => {
  const p = stage();
  assert.deepEqual([...blockoutObjects(p, p.shots[A])].sort(), [id(1)], 'shot A sees the Hero only');
  assert.deepEqual([...blockoutObjects(p, p.shots[B])].sort(), [id(2), id(3)], 'shot B sees the Eagle and the Rock behind it');
  assert.ok(!blockoutObjects(p, p.shots[A]).has(id(4)) && !blockoutObjects(p, p.shots[B]).has(id(4)), 'an object behind the camera is not seen');
  // Tiny is still seen (no minimum size), and the hierarchy rides along: a child of a seen object counts.
  const q = stage(); q.scene.entities.push(makeEntity({ name: 'Pebble', shape: 'box', position: [0.6, 0, 1], scale: [0.05, 0.05, 0.05] }, id(5)), makeEntity({ name: 'Badge', shape: 'box', position: [0, 0, 300], parent: id(1) }, id(6)));
  assert.ok(blockoutObjects(q, q.shots[A]).has(id(5)), 'a pebble in frame counts at any size');
  assert.ok(blockoutObjects(q, q.shots[A]).has(id(6)), 'what is parented to a seen object counts (a rig may carry it)');
});

test('an off-screen object move stales nothing; an on-screen one stales that shot’s blockout, still and video', () => {
  const p = stage();
  assert.deepEqual([states(verdicts(p, A)), states(verdicts(p, B))], [['fresh', 'fresh', 'fresh'], ['fresh', 'fresh', 'fresh']]);
  // The real case: editing the eagle (only in B) used to make every shot stale, though A's re-render was pixel-identical.
  p.scene.entities[1].position = [-58, 4, 1]; p.scene.entities[1].color = '#112233';
  assert.notEqual(shotSignature(p, p.shots[A]), p.shots[A].render.signature, 'the old whole-scene signature calls A stale');
  assert.deepEqual(states(verdicts(p, A)), ['fresh', 'fresh', 'fresh'], 'A does not show the eagle: nothing to remake');
  assert.equal(blockoutStale(p, p.shots[A]), false); assert.equal(stillStale(p, p.shots[A], p.shots[A].references[0]), false); assert.equal(videoStale(p, p.shots[A], p.assets.find(a => a.id === id(500))), false);
  const b = verdicts(p, B);
  assert.deepEqual(states(b), ['stale', 'stale', 'stale']);
  assert.deepEqual(b.blockout.reasons.map(r => r.text), ['camera changed', 'Eagle moved', 'Eagle changed (shape, size, colour or model)'], 'B’s camera is aimed at the eagle, so it moves too');
  assert.ok(b.still.blocking && b.video.blocking, 'a blocking reason: video models are not sent the old still');
  assert.equal(stillStale(p, p.shots[B], p.shots[B].references[0]), true);
  // Animation outside the shot's time window changes no frame.
  const q = stage(); q.scene.entities[1].path = [{ t: 0, p: [-60, 3, 0] }, { t: 2, p: [-60, 3, 0] }, { t: 30, p: [10, 3, 0] }];
  assert.equal(explainStale(q, { type: 'blockout', shotId: q.shots[B].id }).state, 'stale', 'path keys near the shot change its frames (Catmull-Rom neighbours)');
  const r = stage(); r.scene.entities[3].position = [0, 0, 410];
  assert.deepEqual([states(verdicts(r, A)), states(verdicts(r, B))].flat(), Array(6).fill('fresh'), 'the crate behind the camera moves freely');
  // An object moving into frame is named.
  const t = stage(); t.scene.entities[3].position = [0, 0.5, 1.5];
  assert.deepEqual(codes(explainStale(t, { type: 'blockout', shotId: t.shots[A].id })), ['object-entered']);
});

test('prompt, Cast Card, look, model and seed changes stale the still and video but never the blockout; the camera stales all three', () => {
  const prompt = stage(); prompt.shots[A].description = 'The hero sprints toward camera.';
  let v = verdicts(prompt, A);
  assert.deepEqual(states(v), ['fresh', 'stale', 'stale']); assert.deepEqual([codes(v.still), codes(v.video)], [['prompt'], ['prompt']]);
  assert.equal(v.still.blocking, false); assert.equal(stillStale(prompt, prompt.shots[A], prompt.shots[A].references[0]), false, 'video models are still sent it');
  assert.equal(staleText(v.still), 'Out of date: prompt changed.');

  const card = stage(); card.scene.entities[0].notes = 'A tall runner in a blue jacket';
  v = verdicts(card, A);
  assert.deepEqual(states(v), ['fresh', 'stale', 'stale']); assert.deepEqual(codes(v.still).sort(), ['cast-card-changed', 'prompt']);
  assert.match(staleText(v.still), /description of Hero changed/);
  assert.deepEqual(explainStale(card, { type: 'look', entityId: id(1) }).reasons.map(r => r.code).sort(), ['card', 'prompt'], 'and the Hero’s look is out of date');

  const look = stage(); look.scene.references.push({ id: id(250), name: 'new look', file: 'n.png', mime: 'image/png', role: 'character', entityId: id(1), note: '', createdAt: T }); look.scene.entities[0].look = id(250);
  v = verdicts(look, A);
  assert.deepEqual(states(v), ['fresh', 'stale', 'fresh'], 'LTX animates the still: it is not sent looks');
  assert.deepEqual(v.still.reasons.map(r => r.text), ['cast image of Hero changed']);
  const kling = verdicts(look, A, { video: { def: KLING, model: KLING.id, cameraSource: 'blockout', uses: videoUses(KLING) } }).video;
  assert.ok(codes(kling).includes('look-changed'), 'a reference-image model is sent the look');

  v = verdicts(stage(), A, { still: { model: 'flux-3' }, video: { def: def('ltx-25-i2v-v1'), model: 'ltx-25-i2v-v1' } });
  assert.deepEqual(states(v), ['fresh', 'stale', 'stale']);
  assert.equal(v.still.reasons.find(r => r.code === 'model').text, `model changed (${TIERS.draft.stills} → flux-3)`);

  const seed = stage(); seed.shots[A].settings = { image: { model: TIERS.draft.stills, params: { seed: 42 } }, video: { model: LTX.id, params: { seed: 9 } } };
  v = verdicts(seed, A);
  assert.deepEqual([codes(v.still), codes(v.video)], [['seed'], ['seed']]);
  assert.equal(explainStale(seed, { type: 'still', shotId: seed.shots[A].id, at: 'start' }).reasons[0].code, 'seed', 'the browser compares the shot’s own model and seed');

  const cam = stage(); cam.shots[A].camera.angle = 25;
  v = verdicts(cam, A);
  assert.deepEqual(states(v), ['stale', 'stale', 'stale']); assert.ok([v.blockout, v.still, v.video].every(x => codes(x).includes('camera')));
  assert.deepEqual(states(verdicts(cam, B)), ['fresh', 'fresh', 'fresh'], 'another shot’s camera is not an input');
  const time = stage(); time.shots[A].duration = 3;
  assert.ok(codes(verdicts(time, A).blockout).includes('timing'));
});

test('batch: an unchanged project plans zero paid nodes; one change plans exactly what it invalidates', async () => {
  const p = stage();
  let nodes = planBatch(p, draft).nodes;
  assert.deepEqual(planned(nodes), [], 'nothing to make');
  assert.ok(nodes.filter(n => n.type === 'video').every(n => n.status === 'skipped' && n.keptId), 'videos are skipped too (they never were before)');
  // The dry run says so.
  const batches = await openBatches(await mkdtemp(join(tmpdir(), 'previs-regen-')), { loadProject: async () => structuredClone(p), costs: { marginPct: 0, graderOn: false } });
  const dry = await batches.create({ projectId: p.id, ...draft, dryRun: true });
  assert.deepEqual([dry.regen.remake, dry.regen.total, dry.estimateUsd], [0, 6, 0]); assert.match(dry.events[0].text, /0 of 6 need regenerating/);

  // Off-screen for A: only B's blockout, still and video.
  const eagle = stage(); eagle.scene.entities[1].position = [-59, 3, 0];
  nodes = planBatch(eagle, draft).nodes;
  assert.deepEqual(planned(nodes), [`blockout:${id(11)}`, `still:${id(11)}start`, `video:${id(11)}`].sort());
  assert.ok(nodes.find(n => n.id === `video:${id(11)}`).reasons.some(r => r.text === 'Eagle moved'));
  const dry2 = await batches.create({ projectId: p.id, ...draft, dryRun: true });
  assert.equal(dry2.regen.remake, 0, 'each plan reads the project as it is');

  // A shot's prompt: its still and video (the blockout is free and current).
  const words = stage(); words.shots[B].description = 'The eagle banks hard.';
  assert.deepEqual(planned(planBatch(words, draft).nodes), [`still:${id(11)}start`, `video:${id(11)}`].sort());

  // A Cast Card: the look, then every still and video downstream of it (the look is a new input to them).
  const card = stage(); card.scene.entities[1].notes = 'A golden eagle';
  nodes = planBatch(card, draft).nodes;
  assert.deepEqual(planned(nodes), [`look:${id(2)}`, `still:${id(11)}start`, `video:${id(11)}`].sort());
  assert.deepEqual(nodes.find(n => n.id === `look:${id(2)}`).reasons.map(r => r.code).sort(), ['card', 'prompt']);
  // Without the looks step the stale look is not remade; the still is out of date on its own (its prompt has the Cast Card).
  assert.deepEqual(planned(planBatch(card, { ...draft, steps: ['stills', 'videos'] }).nodes), [`still:${id(11)}start`, `video:${id(11)}`].sort());

  // The batch's model is an input: the final tier remakes stills and videos made with the draft models.
  assert.ok(planned(planBatch(p, { ...draft, steps: ['stills', 'videos'], tier: 'final' }).nodes).length >= 4);
});

test('batch: pinned outputs are kept and stop the cascade; force remakes; reasons ride on every planned node', () => {
  const p = stage(); p.scene.entities[0].notes = 'A runner in green';
  p.shots[A].references[0].pinned = true;
  let nodes = planBatch(p, draft).nodes;
  const still = nodes.find(n => n.id === `still:${id(10)}start`), video = nodes.find(n => n.id === `video:${id(10)}`);
  assert.deepEqual([still.status, still.pinned, still.note], ['skipped', true, 'Pinned: kept as is']);
  assert.ok(still.reasons.some(r => r.code === 'cast-card-changed'), 'a pinned output still says what changed');
  assert.equal(video.status, 'waiting', 'the video has its own changed input (its prompt)');
  p.assets.find(a => a.id === id(500)).pinned = true;
  nodes = planBatch(p, draft).nodes;
  assert.equal(nodes.find(n => n.id === `video:${id(10)}`).status, 'skipped');
  assert.deepEqual(planned(nodes), [`look:${id(1)}`], 'only the look is made; pinned outputs downstream are kept');
  // force: one node, or everything.
  nodes = planBatch(stage(), { ...draft, force: [`video:${id(11)}`] }).nodes;
  assert.deepEqual(planned(nodes), [`video:${id(11)}`]); assert.equal(nodes.find(n => n.id === `video:${id(11)}`).reasons[0].code, 'forced');
  assert.deepEqual(planned(planBatch(stage(), { ...draft, force: true }).nodes), [`look:${id(1)}`, `look:${id(2)}`, `look:${id(3)}`, `still:${id(10)}start`, `still:${id(11)}start`, `video:${id(10)}`, `video:${id(11)}`].sort(), 'the cast’s looks, stills and videos (the crate is in no cast; blockouts stay: the render route keeps a current one)');
  assert.throws(() => planBatch(stage(), { ...draft, force: ['rm -rf'] }), /force takes true or node ids/);
});

test('legacy outputs (signature only) are judged by the signature rules; a manifest takes precedence', () => {
  const p = stage();
  for (const s of p.shots) { delete s.render.regen; delete s.references[0].generated.regen; }
  for (const a of p.assets) delete a.source.regen;
  p.scene.entities[1].position = [-59, 3, 0]; // the eagle, off-screen for A
  const a = verdicts(p, A);
  assert.deepEqual(states(a), ['stale', 'stale', 'stale'], 'the whole-scene signature: everything is stale, as before');
  assert.ok(a.still.legacy && a.still.blocking && /older output: no per-input record/.test(a.still.reasons[0].text));
  assert.equal(blockoutStale(p, p.shots[A]), true);
  // A legacy video is kept only when its blocking and its model still match; an unknown model is made again.
  const fresh = stage(); for (const x of fresh.assets) delete x.source.regen;
  let nodes = planBatch(fresh, draft).nodes;
  assert.equal(nodes.find(n => n.id === `video:${id(10)}`).status, 'skipped', 'same blocking, same model');
  delete fresh.assets.find(x => x.id === id(500)).source.definitionId;
  nodes = planBatch(fresh, draft).nodes;
  assert.deepEqual(nodes.find(n => n.id === `video:${id(10)}`).reasons.map(r => r.code), ['unrecorded']);
  // Mixed: a manifest on the clip wins over a stale signature on it.
  const mixed = stage(); mixed.shots[A].render.signature = 'older';
  assert.equal(blockoutStale(mixed, mixed.shots[A]), false);
});

test('the director records a blockout manifest only when the capture saw the saved blocking, and pin_output pins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'previs-regen-dir-'));
  const director = await openDirector(root);
  let p = await director.create({ template: 'hero' });
  const s = p.shots[0];
  const { writeFile, mkdir } = await import('node:fs/promises'), { createHash } = await import('node:crypto');
  const bytes = Buffer.from('not really an mp4'), sha = createHash('sha256').update(bytes).digest('hex');
  await mkdir(join(root, 'assets'), { recursive: true });
  const asset = n => ({ id: id(700 + n), shotId: 'ps1', kind: 'video', sha256: sha, width: 1280, height: 720, fps: 24, frameCount: 72, duration: 3 });
  for (const n of [1, 2]) await writeFile(join(root, 'assets', `${id(700 + n)}.mp4`), bytes);
  const previs = { get: () => ({ assets: [asset(1), asset(2)] }) };
  p = (await director.recordRender(p.id, { shotId: s.id, previsShotId: 'ps1', assetId: id(701), signature: shotSignature(p, s) }, previs)).project;
  assert.equal(p.shots[0].render.regen.key, blockoutManifest(p, p.shots[0]).key);
  assert.equal(p.assets.at(-1).source.regen.key, p.shots[0].render.regen.key, 'the clip asset carries it too');
  p = (await director.recordRender(p.id, { shotId: s.id, previsShotId: 'ps1', assetId: id(702), signature: 'captured-another-blocking' }, previs)).project;
  assert.equal(p.shots[0].render.regen, undefined, 'a capture of another blocking keeps only its signature');
  assert.equal(blockoutStale(p, p.shots[0]), true);

  p = (await director.reference(p.id, { shotId: s.id, role: 'frame', note: 'key frame start', data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]).toString('base64'), generated: { requestId: 'r1', outputKey: 'o1', model: 'FLUX', signature: 'older' } })).project;
  const ref = p.shots[0].references.at(-1);
  assert.equal(stillStale(p, p.shots[0], ref), true);
  p = (await director.edit(p.id, [{ op: 'pin_output', id: ref.id }])).project;
  assert.equal(p.shots[0].references.at(-1).pinned, true); assert.equal(stillStale(p, p.shots[0], p.shots[0].references.at(-1)), false, 'pinned: accepted, video models get it');
  assert.equal(explainStale(p, { type: 'still', shotId: s.id, refId: ref.id }).state, 'pinned');
  p = (await director.edit(p.id, [{ op: 'pin_output', id: ref.id, pinned: false }])).project;
  assert.equal(p.shots[0].references.at(-1).pinned, undefined);
  await assert.rejects(director.edit(p.id, [{ op: 'pin_output', id: 'nope' }]), /Pin a still, a look or a generated video/);
});

test('what depends on an object, the MCP shot readout, request manifests and look views', () => {
  const p = stage();
  assert.deepEqual(dependentsOf(p, id(2)), { object: { shots: [id(11)], stills: 1, videos: 1 }, look: { shots: [id(11)], stills: 1, videos: 1 } });
  assert.deepEqual(dependentsOf(p, id(4)).object, { shots: [], stills: 0, videos: 0 }, 'the crate is in no frame');
  p.shots[B].description = 'Changed.';
  const r = shotRegen(p, p.shots[B]);
  assert.deepEqual([r.blockout.state, r.stills[0].state, r.video.state], ['fresh', 'stale', 'stale']);
  assert.deepEqual(r.stills[0].reasons, [{ code: 'prompt', text: 'prompt changed' }]);
  // Untrusted manifests (a bind body) are bounded; junk is dropped.
  assert.equal(cleanManifest({ v: 1, type: 'video', key: 'k', parts: { prompt: 'a', 'bad key!': 'x', big: 'y'.repeat(500) } }).parts.prompt, 'a');
  assert.deepEqual(Object.keys(cleanManifest({ v: 1, type: 'video', key: 'k', parts: { prompt: 'a', 'bad key!': 'x', big: 'y'.repeat(500) } }).parts), ['prompt']);
  assert.equal(cleanManifest({ v: 2, type: 'video', key: 'k', parts: {} }), null);
  assert.equal(cleanManifest({ v: 1, type: 'other', key: 'k', parts: {} }), null);
  // A look request's prompt is matched to its auto view; a typed one is recorded as custom (its prompt is not compared).
  const hero = p.scene.entities[0];
  assert.deepEqual(lookPromptView(p, hero, lookPrompt(p, hero, 'face')), { view: 'face' });
  assert.deepEqual(lookPromptView(p, hero, 'my own words'), { custom: true });
  const custom = lookKey(p, hero.id, { model: 'flux-3', custom: true });
  assert.ok(!('prompt' in custom.parts) && custom.ctx.custom);
});

test('starters stay judged by their signatures: bundles carry no manifests and an export drops them', async () => {
  const dir = new URL('../examples/starters/', import.meta.url);
  for (const slug of (await readdir(dir, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name)) {
    const text = await readFile(new URL(`${slug}/starter.json`, dir), 'utf8');
    assert.ok(!text.includes('"regen"'), `${slug} carries no regeneration manifest`);
  }
  const p = stage();
  const snap = starterSnapshot(p, { slug: 'x', title: 'X', description: 'd' });
  assert.ok(!JSON.stringify(snap).includes('"regen"'), 'an export keeps signatures only, so a copy is judged as before');
  assert.equal(starterMediaStatus({ ...p, starterFiles: { listed: 0, missing: 0 } }), null, 'a current project reports nothing out of date');
});
