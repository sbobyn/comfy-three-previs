import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openBatches, planBatch } from '../server/previs/batch.mjs';
import { batchRoutes } from '../server/previs/batch-routes.mjs';
import { fakeBackend } from '../server/previs/batch-drivers.mjs';
import { builtInPresets } from '../server/previs/presets.mjs';
import { imagePresets } from '../server/previs/refgen.mjs';
import { TIERS, IMAGE_PRICES, VIDEO_PRICES, FIRST_FRAME_FALLBACK, KEY_FRAME_SECONDS, estimateFor, modelsFor, clipSecondsFor, durationValue } from '../shared/tiers.mjs';

const project = JSON.parse(await readFile(new URL('./fixtures/wingspan-project.json', import.meta.url), 'utf8'));
const [valley, dive, swoop] = project.shots;
const name = id => project.scene.entities.find(e => e.id === id)?.name;
const byId = (nodes, id) => nodes.find(n => n.id === id);

function harness(options = {}) {
  let t = Date.parse('2026-10-30T12:00:00Z');
  const clock = { now: () => t, advance: s => { t += s * 1000; } };
  const fake = fakeBackend({ now: clock.now, ...options.fake });
  return { clock, fake, open: async root => openBatches(root || await mkdtemp(join(tmpdir(), 'previs-batch-')), { drivers: fake.drivers, jobs: fake.jobs, loadProject: async () => structuredClone(project), now: clock.now, ...options.batches }) };
}
async function runUntil(batches, id, clock, done = b => ['completed', 'failed', 'cancelled', 'paused'].includes(b.status), step = 5, max = 400) {
  for (let i = 0; i < max; i++) {
    await batches.tick(id); await batches.idle();
    const b = batches.get(id); if (done(b)) return b;
    clock.advance(step);
  }
  throw Error('batch did not finish');
}

test('tiers match preset prices and the LTX Fast preset is the Pro graph with the Fast model', () => {
  for (const tier of Object.values(TIERS)) for (const step of ['looks', 'sheets', 'stills']) assert.ok(imagePresets.some(p => p.id === tier[step]), tier[step]);
  for (const p of imagePresets) if (p.id in IMAGE_PRICES) assert.equal(IMAGE_PRICES[p.id], p.pricing.usdPerImage ?? 0, p.id);
  for (const d of builtInPresets) { assert.ok(VIDEO_PRICES[d.id], `price for ${d.id}`); assert.equal(VIDEO_PRICES[d.id].ratePerSecond, d.pricing.ratePerSecond ?? 0, d.id); }
  const fast = builtInPresets.find(d => d.id === 'ltx-25-i2v-fast-v1'), pro = builtInPresets.find(d => d.id === 'ltx-25-i2v-v1');
  assert.equal(fast.graph['2'].inputs.model, 'LTX-2.5 (Fast)');
  assert.equal(fast.pricing.ratePerSecond, 0.1287);
  assert.deepEqual({ ...fast.graph['2'].inputs, model: 'x' }, { ...pro.graph['2'].inputs, model: 'x' });
  assert.deepEqual([fast.task, fast.inputs, fast.parameters, fast.outputs], [pro.task, pro.inputs, pro.parameters, pro.outputs]);
  assert.equal(estimateFor('video', 'ltx-25-i2v-fast-v1', { duration: 5 }), 0.6435);
  assert.equal(estimateFor('video', 'ltx-25-flf-v1', { duration: 7 }), 1.032); // LTX bills the snapped 6 s
  assert.equal(estimateFor('sheet', 'flux-3', { count: 4 }), 0.264);
  assert.equal(estimateFor('blockout', 'any'), 0);
  assert.equal(estimateFor('look', 'nano-banana-pro'), 0.161, 'Nano Banana Pro is priced for batches (live badge ≈ $0.1608 per 1K image)');
  assert.equal(estimateFor('look', 'not-a-model'), null);
  assert.deepEqual(modelsFor('final', { videos: 'kling-o1-edit-v1', bogus: 'x' }), { ...TIERS.final, videos: 'kling-o1-edit-v1' });
});

test('start-still video presets: prices, clip lengths and start-only fallbacks stay in sync', () => {
  const frames = builtInPresets.filter(d => d.task === 'first-frame');
  assert.deepEqual(frames.map(d => d.id), ['ltx-25-flf-v1', 'ltx-25-i2v-v1', 'ltx-25-i2v-fast-v1', 'seedance-25-i2v-v1', 'seedance-25-flf-v1', 'kling-40-i2v-v1', 'kling-40-flf-v1', 'veo-31-i2v-v1', 'veo-31-flf-v1', 'hailuo-h3-i2v-v1', 'hailuo-h3-flf-v1', 'wan27-i2v-v1', 'wan27-flf-v1']);
  for (const d of frames) {
    const p = VIDEO_PRICES[d.id];
    assert.ok(p.keyFrames, d.id); assert.deepEqual(p.durations, d.constraints.durations, d.id);
    assert.ok(d.inputs.firstFrame && d.inputs.prompt && d.parameters.duration, d.id);
    const current = d.graph[d.parameters.duration.nodeId].inputs[d.parameters.duration.input];
    assert.ok(d.constraints.durations.includes(Number(current)), `${d.id} default ${current}s is a clip length it accepts`);
    for (let s = 1; s <= 12; s++) assert.ok(estimateFor('video', d.id, { duration: s }) > 0, `${d.id} priced at ${s}s`);
    if (d.inputs.lastFrame) {
      const sibling = builtInPresets.find(x => x.id === FIRST_FRAME_FALLBACK[d.id]);
      assert.ok(sibling && !sibling.inputs.lastFrame, `${d.id} falls back to a start-only preset`);
      assert.deepEqual([sibling.pricing.ratePerSecond, sibling.constraints.durations], [d.pricing.ratePerSecond, d.constraints.durations], `${d.id} fallback keeps price and lengths`);
    } else assert.ok(!(d.id in FIRST_FRAME_FALLBACK), d.id);
  }
  assert.equal(estimateFor('video', 'veo-31-flf-v1', { duration: 5 }), 0.8, 'Veo makes 4, 6 or 8 s: 5 s snaps to 4');
  assert.equal(estimateFor('video', 'kling-40-i2v-v1', { duration: 7 }), 1.3476);
  assert.equal(estimateFor('video', 'seedance-25-i2v-v1', { duration: 3 }), 1.336, 'Seedance starts at 4 s');
  assert.equal(estimateFor('video', 'hailuo-h3-flf-v1', { duration: 5 }), 0.6435);
  assert.equal(estimateFor('video', 'wan27-i2v-v1', { duration: 10 }), 1);
  assert.deepEqual([clipSecondsFor(builtInPresets.find(d => d.id === 'veo-31-i2v-v1'), 7), clipSecondsFor({ id: 'saved', provenance: { presetId: 'kling-40-flf-v1' } }, 2), clipSecondsFor(null, 12)], [6, 3, KEY_FRAME_SECONDS.at(-1)]);
  assert.deepEqual([durationValue('3', 6), durationValue(5, 6)], ['6', 6], 'LTX takes a combo string, the partner nodes an integer');
  for (const [id, usd] of Object.entries({ 'flux-2-max': 0.071, 'gpt-image-25': 0.076, 'seedream-5-pro': 0.045, 'nano-banana-pro': 0.161 })) {
    assert.equal(IMAGE_PRICES[id], usd, id); assert.equal(imagePresets.find(p => p.id === id).pricing.usdPerImage, usd, id);
  }
});

test('start → end partner model in a final plan: the end still is optional', () => {
  const kling = planBatch(project, { steps: ['stills', 'videos'], tier: 'final', models: { videos: 'kling-40-flf-v1' }, maxCostUsd: 20 }).nodes;
  const v = byId(kling, `video:${dive.id}`);
  assert.deepEqual(v.deps, [`blockout:${dive.id}`, `still:${dive.id}start`, `still:${dive.id}end`]);
  assert.deepEqual(v.optional, [`still:${dive.id}end`], 'the end still is optional: Kling 4.0 has a start-only fallback');
  assert.equal(v.estimateUsd, estimateFor('video', 'kling-40-flf-v1', { duration: dive.duration }));
});

test('plan: design sheets wait for the batch stills (optional deps)', () => {
  const eagle = project.scene.entities.find(e => e.name === 'Bald eagle').id;
  const plan = planBatch(project, { steps: ['sheets', 'stills'], objects: [eagle], maxCostUsd: 5 }).nodes;
  const stills = plan.filter(n => n.type === 'still' && n.status === 'waiting').map(n => n.id), sheet = plan.find(n => n.type === 'sheet');
  assert.ok(stills.length >= 2);
  assert.deepEqual(sheet.optional, stills); assert.ok(stills.every(id => sheet.deps.includes(id)));
});

test('stills and videos go ahead of design sheets in the image slots', async () => {
  const h = harness({ fake: { seconds: { still: 20, video: 60, sheet: 30 } } });
  const batches = await h.open();
  const eagle = project.scene.entities.find(e => e.name === 'Bald eagle').id;
  const b = await batches.create({ projectId: project.id, steps: ['sheets', 'stills', 'videos'], objects: [eagle], maxCostUsd: 10 });
  const done = await runUntil(batches, b.id, h.clock);
  assert.equal(done.status, 'completed');
  const order = h.fake.submits.map(x => x.type), firstSheet = order.indexOf('sheet');
  assert.ok(firstSheet > order.lastIndexOf('still'), `every still is sent before the sheet: ${order.join(' ')}`);
  const sheet = done.nodes.find(n => n.type === 'sheet'), lastStill = Math.max(...done.nodes.filter(n => n.type === 'still' && n.finishedAt).map(n => Date.parse(n.finishedAt)));
  assert.ok(Date.parse(sheet.startedAt) >= lastStill, 'the sheet starts once the stills have landed');
  assert.ok(done.nodes.filter(n => n.type === 'video').every(n => Date.parse(n.startedAt) <= Date.parse(sheet.startedAt)), 'videos start no later than the sheet');
});

test('draft plan: blockouts skipped, one look per family, start stills before videos', () => {
  const { nodes } = planBatch(project, { steps: ['looks', 'stills', 'videos'], tier: 'draft', maxCostUsd: 5 });
  const looks = nodes.filter(n => n.type === 'look');
  assert.deepEqual(looks.map(n => name(n.target.entityId)).sort(), ['Alpine lake', 'Alpine terrain', 'River 1']);
  assert.equal(looks.find(n => name(n.target.entityId) === 'River 1').target.family.length, 6);
  assert.ok(!looks.some(n => /Pine|Elk|eagle/.test(n.label)), 'objects whose family already has an image get no look');
  for (const s of project.shots) {
    assert.equal(byId(nodes, `blockout:${s.id}`).status, 'skipped');
    const video = byId(nodes, `video:${s.id}`), still = byId(nodes, `still:${s.id}start`);
    assert.deepEqual(video.deps, [`blockout:${s.id}`, still.id]);
    assert.equal(video.model, 'ltx-25-i2v-fast-v1');
    assert.equal(video.estimateUsd, 0.6435);
    assert.ok(still.deps.length && still.deps.every(d => d.startsWith('look:')) && still.optional.length === still.deps.length, 'still deps on looks are optional');
    assert.ok(!byId(nodes, `still:${s.id}end`), 'Fast i2v takes no end frame');
  }
  assert.equal(byId(nodes, `still:${valley.id}start`).status, 'skipped', 'existing start key frame is reused');
  assert.equal(byId(nodes, `still:${dive.id}start`).status, 'waiting');
});

test('final plan adds end stills; reference models depend on looks instead; missing key frames fail the plan node', () => {
  const final = planBatch(project, { steps: ['stills', 'videos'], tier: 'final', maxCostUsd: 5 }).nodes;
  assert.deepEqual(byId(final, `video:${dive.id}`).deps, [`blockout:${dive.id}`, `still:${dive.id}start`, `still:${dive.id}end`]);
  assert.equal(byId(final, `still:${dive.id}end`).model, TIERS.final.stills);
  const kling = planBatch(project, { steps: ['looks', 'videos'], models: { videos: 'kling-o1-edit-v1' }, maxCostUsd: 5 }).nodes;
  const v = byId(kling, `video:${dive.id}`);
  assert.equal(v.deps[0], `blockout:${dive.id}`);
  assert.ok(v.deps.slice(1).every(d => d.startsWith('look:')) && v.optional.length === v.deps.length - 1);
  const videosOnly = planBatch(project, { steps: ['videos'], maxCostUsd: 5 }).nodes;
  assert.equal(byId(videosOnly, `video:${valley.id}`).status, 'waiting');
  assert.match(byId(videosOnly, `video:${dive.id}`).error, /start key frame/);
  const sheets = planBatch(project, { steps: ['sheets'], maxCostUsd: 5, objects: [project.scene.entities.find(e => e.name === 'Bald eagle').id] }).nodes;
  assert.deepEqual([sheets.length, sheets[0].target.setId, sheets[0].count, sheets[0].estimateUsd], [1, 'turn4', 4, 0.112]);
  assert.throws(() => planBatch(project, { steps: ['videos'], maxCostUsd: 1, models: { videos: 'nope' } }), /Unknown video model/);
  assert.throws(() => planBatch(project, { steps: ['stills'] }), /maxCostUsd/);
  assert.throws(() => planBatch(project, { steps: ['looks'], maxCostUsd: 1, models: { looks: 'not-a-model' } }), /unpriced/);
});

test('a blockout-editing model refuses a clip length its provider rejects, at plan time', () => {
  const short = structuredClone(project); short.shots[1].duration = 3.2;
  const plan = model => byId(planBatch(short, { steps: ['videos'], models: { videos: model }, maxCostUsd: 5, shots: [short.shots[1].id] }).nodes, `video:${short.shots[1].id}`);
  assert.equal(builtInPresets.find(d => d.id === 'seedance-25-edit-v1').constraints.sourceVideo.duration.min, 4, 'Seedance edit: 4–30 s input clips');
  const sd = plan('seedance-25-edit-v1');
  assert.equal(sd.status, 'failed'); assert.match(sd.error, /Seedance 2\.5 needs a 4–30 s blockout clip; this shot is 3\.2 s/);
  assert.equal(plan('kling-o1-edit-v1').status, 'waiting', 'Kling O1 edit takes 3 s and up');
});

test('a key frame made for an earlier blocking is made again; uploads and current stills are kept', async () => {
  const { shotSignature, stillStale } = await import('../shared/director.mjs');
  const plan = p => byId(planBatch(p, { steps: ['stills', 'videos'], tier: 'final', maxCostUsd: 5, shots: [p.shots[0].id] }).nodes, `still:${p.shots[0].id}start`);
  const fresh = structuredClone(project), shot = fresh.shots[0], still = shot.references.find(r => r.note === 'key frame start');
  assert.equal(plan(fresh).status, 'skipped', 'a legacy still newer than the blockout clip is current');
  // Legacy still (no signature) older than the shot's blockout clip: the blocking changed after it was made.
  const legacy = structuredClone(fresh); legacy.shots[0].render.createdAt = '2026-10-30T16:00:00.000Z';
  assert.ok(stillStale(legacy, legacy.shots[0], legacy.shots[0].references.find(r => r.note === 'key frame start')));
  assert.deepEqual([plan(legacy).status, plan(legacy).note], ['waiting', 'Blocking changed since its key frame; made again']);
  // Signed stills: stale exactly when the blocking differs.
  const signed = structuredClone(fresh), ref = signed.shots[0].references.find(r => r.note === 'key frame start');
  ref.generated.signature = shotSignature(signed, signed.shots[0]); signed.shots[0].render.createdAt = '2026-10-30T16:00:00.000Z';
  assert.equal(plan(signed).status, 'skipped', 'signature matches: kept even though the clip was made again later');
  signed.shots[0].start = (signed.shots[0].start || 0) + 1;
  assert.equal(plan(signed).status, 'waiting', 'timing changed: made again');
  // An uploaded frame (no generation record) is the director's choice and never stale.
  const uploaded = structuredClone(legacy); delete uploaded.shots[0].references.find(r => r.note === 'key frame start').generated;
  assert.equal(plan(uploaded).status, 'skipped');
  assert.ok(still, 'fixture has a start still');
});

test('a shot’s video starts as soon as its still lands while other stills still run', async () => {
  const h = harness({ fake: { limits: { 'cloud:image': 1, 'cloud:video': 3 }, seconds: { still: 20, video: 60 } } });
  const batches = await h.open();
  const b = await batches.create({ projectId: project.id, steps: ['stills', 'videos'], tier: 'draft', maxCostUsd: 5 });
  assert.equal(b.status, 'running');
  await batches.tick(b.id); await batches.idle();
  assert.deepEqual(h.fake.submits.map(x => x.nodeId), [`video:${valley.id}`, `still:${dive.id}start`], 'valley already has its start still; one image slot');
  const done = await runUntil(batches, b.id, h.clock);
  const diveVideo = byId(done.nodes, `video:${dive.id}`), swoopStill = byId(done.nodes, `still:${swoop.id}start`);
  assert.ok(Date.parse(diveVideo.startedAt) < Date.parse(swoopStill.finishedAt), 'dive video was running while the swoop still was still generating');
  assert.equal(done.status, 'completed');
  assert.ok(done.nodes.filter(n => n.type === 'video').every(n => n.status === 'done' && n.assetId));
  assert.equal(done.spentEstimateUsd, 1.9865);
});

test('busy 409 puts the node back to ready and retries after retryAfterSeconds', async () => {
  let busy = 2;
  const h = harness({ fake: { busyOn: n => n.type === 'still' && busy-- > 0 } });
  const batches = await h.open();
  const b = await batches.create({ projectId: project.id, steps: ['stills'], shots: [dive.id], maxCostUsd: 1 });
  await batches.tick(b.id); await batches.idle();
  let node = byId(batches.get(b.id).nodes, `still:${dive.id}start`);
  assert.equal(node.status, 'ready'); assert.ok(node.retryAt); assert.equal(node.requestId, undefined);
  assert.equal(batches.get(b.id).spentEstimateUsd, 0, 'busy refunds the reservation');
  await batches.tick(b.id); await batches.idle();
  assert.equal(h.fake.submits.length, 0, 'waits for retryAfterSeconds');
  const done = await runUntil(batches, b.id, h.clock);
  assert.equal(done.status, 'completed');
  assert.equal(done.events.filter(e => /busy/.test(e.text)).length, 2);
  assert.equal(h.fake.submits.length, 1);
});

test('budget: maxCostUsd 0 submits nothing paid; a small cap stops at the line', async () => {
  const h = harness();
  const batches = await h.open();
  const zero = await runUntil(batches, (await batches.create({ projectId: project.id, steps: ['looks', 'stills', 'videos'], maxCostUsd: 0 })).id, h.clock);
  assert.equal(h.fake.submits.length, 0);
  assert.equal(zero.status, 'completed');
  assert.ok(zero.nodes.filter(n => n.estimateUsd > 0 && n.status !== 'skipped').every(n => n.status === 'budget'));
  assert.equal(zero.budgetSkipped, zero.nodes.filter(n => n.status === 'budget').length);
  assert.ok(zero.estimateUsd > 0);

  const capped = await runUntil(batches, (await batches.create({ projectId: project.id, steps: ['stills', 'videos'], maxCostUsd: 0.7 })).id, h.clock);
  const status = id => byId(capped.nodes, id).status;
  assert.deepEqual([status(`video:${valley.id}`), status(`still:${dive.id}start`), status(`still:${swoop.id}start`), status(`video:${dive.id}`), status(`video:${swoop.id}`)], ['done', 'done', 'done', 'budget', 'budget']);
  assert.ok(capped.spentEstimateUsd <= 0.7);
});

test('cancel stops new submits, keeps following running jobs; resume finishes the rest', async () => {
  const h = harness({ fake: { limits: { 'cloud:image': 1, 'cloud:video': 3 } } });
  const batches = await h.open();
  const b = await batches.create({ projectId: project.id, steps: ['stills', 'videos'], maxCostUsd: 5 });
  await batches.tick(b.id); await batches.idle();
  const cancelled = await batches.cancel(b.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(cancelled.nodes.filter(n => n.cancelled).length >= 3);
  await runUntil(batches, b.id, h.clock, x => !x.nodes.some(n => n.status === 'running'));
  assert.equal(h.fake.submits.length, 2, 'nothing new after cancel');
  assert.ok(batches.get(b.id).nodes.filter(n => h.fake.submits.some(s => s.nodeId === n.id)).every(n => n.status === 'done'));
  const resumed = await batches.resume(b.id);
  assert.equal(resumed.status, 'running');
  const done = await runUntil(batches, b.id, h.clock);
  assert.equal(done.status, 'completed');
  assert.equal(h.fake.submits.length, 5);
});

test('uncertain pauses the batch and is never resent; failures block dependents', async () => {
  const h = harness({ fake: { uncertainOn: n => n.id === `still:${dive.id}start`, failOn: n => n.id === `still:${swoop.id}start` } });
  const batches = await h.open();
  const b = await batches.create({ projectId: project.id, steps: ['stills', 'videos'], maxCostUsd: 5 });
  const paused = await runUntil(batches, b.id, h.clock, x => x.status === 'paused' && !x.nodes.some(n => n.status === 'running'));
  assert.equal(byId(paused.nodes, `still:${dive.id}start`).uncertain, true);
  assert.match(byId(paused.nodes, `video:${dive.id}`).error, /Blocked/);
  assert.equal(byId(paused.nodes, `video:${swoop.id}`).status, 'failed');
  await batches.resume(b.id);
  const done = await runUntil(batches, b.id, h.clock);
  assert.equal(done.status, 'failed');
  assert.equal(h.fake.submits.filter(s => s.nodeId === `still:${dive.id}start`).length, 1, 'uncertain never resent');
  assert.equal(h.fake.submits.filter(s => s.nodeId === `still:${swoop.id}start`).length, 2, 'a plain failure is retried on resume');
});

test('persistence round-trip; a running batch resumes on open and a cut-off submit without an id is safe to redo', async () => {
  const root = await mkdtemp(join(tmpdir(), 'previs-batch-'));
  const h = harness({ fake: { seconds: { still: 0, video: 0 } } });
  const first = await h.open(root);
  const planned = await first.create({ projectId: project.id, steps: ['stills', 'videos'], maxCostUsd: 5, dryRun: true });
  assert.equal(planned.status, 'planned');
  const b = await first.create({ projectId: project.id, steps: ['stills', 'videos'], maxCostUsd: 5 });
  first.close();
  const file = join(root, 'batches', `${b.id}.json`), saved = JSON.parse(await readFile(file, 'utf8'));
  const n = byId(saved.nodes, `still:${dive.id}start`);
  Object.assign(n, { status: 'running', submitting: true, reserved: 0.028 }); saved.spentEstimateUsd = 0.028;
  await writeFile(file, JSON.stringify(saved));
  const second = await openBatches(root, { drivers: h.fake.drivers, jobs: h.fake.jobs, loadProject: async () => project, intervalMs: 5 });
  assert.throws(() => second.get(planned.id), /Unknown batch/, 'a dry run is never written to disk');
  const reopened = second.get(b.id);
  assert.equal(byId(reopened.nodes, `still:${dive.id}start`).status, 'ready');
  assert.equal(reopened.spentEstimateUsd, 0);
  second.start();
  for (let i = 0; i < 200 && second.get(b.id).status === 'running'; i++) await new Promise(r => setTimeout(r, 10));
  await second.idle(); second.close();
  const finished = second.get(b.id);
  assert.equal(finished.status, 'completed');
  assert.ok(finished.events.some(e => /Resumed after server start/.test(e.text)));
  assert.equal(second.list(project.id).length, 1);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).status, 'completed');
});

test('HTTP routes and the SSE stream (batch first, then node events)', async () => {
  const h = harness();
  const batches = await h.open(), route = batchRoutes(batches);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (url.pathname === '/api/director/batch/stream') return batches.stream(req, res, url.searchParams.get('id'));
      let text = ''; for await (const c of req) text += c;
      const out = await route(req.method, url, text ? JSON.parse(text) : {});
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out));
    } catch (e) { res.writeHead(e.status || 400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));
  try {
    const dry = await post('/api/director/batch', { projectId: project.id, steps: ['stills', 'videos'], tier: 'draft', maxCostUsd: 0, dryRun: true });
    assert.equal(dry.status, 200); assert.equal(dry.body.batch.status, 'planned'); assert.ok(dry.body.batch.estimateUsd > 0);
    assert.equal(h.fake.submits.length, 0);
    assert.equal((await post('/api/director/batch', { projectId: project.id, steps: ['nope'], maxCostUsd: 1 })).status, 400);
    const { body: { batch } } = await post('/api/director/batch', { projectId: project.id, steps: ['stills'], shots: [dive.id], maxCostUsd: 1 });
    const res = await fetch(`${base}/api/director/batch/stream?id=${batch.id}`), reader = res.body.getReader();
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    let text = '';
    const read = async until => { while (!until(text)) text += new TextDecoder().decode((await reader.read()).value); };
    await read(x => x.includes('\n\n'));
    assert.equal(JSON.parse(text.split('\n')[0].slice(6)).type, 'batch');
    await batches.tick(batch.id); await batches.idle();
    await read(x => x.includes('"type":"node"'));
    reader.cancel();
    assert.equal((await fetch(`${base}/api/director/batch?id=${batch.id}`).then(r => r.json())).batch.id, batch.id);
    assert.equal((await fetch(`${base}/api/director/batches?projectId=${project.id}`).then(r => r.json())).batches.length, 2);
    assert.equal((await post('/api/director/batch/cancel', { id: batch.id })).body.batch.status, 'cancelled');
    assert.equal((await fetch(`${base}/api/director/batch?id=00000000-0000-0000-0000-000000000000`)).status, 404);
  } finally { batches.close(); server.close(); }
});

test('restart resubmits a recorded request (never a new one); a refusal refunds and clears ids; a failing finish never fails paid work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'previs-batch-'));
  const h = harness({ fake: { seconds: { still: 0, video: 0 } } });
  const first = await h.open(root);
  const b = await first.create({ projectId: project.id, steps: ['stills'], shots: [dive.id], maxCostUsd: 1 });
  first.close();
  const file = join(root, 'batches', `${b.id}.json`), saved = JSON.parse(await readFile(file, 'utf8'));
  const recorded = '11111111-2222-3333-4444-555555555555';
  Object.assign(byId(saved.nodes, `still:${dive.id}start`), { status: 'running', submitting: true, reserved: 0.028, requestId: recorded, fingerprint: 'fp' }); saved.spentEstimateUsd = 0.028;
  await writeFile(file, JSON.stringify(saved));
  const second = await h.open(root);
  const node = byId(second.get(b.id).nodes, `still:${dive.id}start`);
  assert.deepEqual([node.status, node.resubmit, node.requestId, second.get(b.id).spentEstimateUsd], ['ready', true, recorded, 0]);
  const done = await runUntil(second, b.id, h.clock);
  assert.equal(done.status, 'completed');
  assert.deepEqual(h.fake.submits.map(s => s.jobId), [recorded], 'the saved request id is the one dispatched');
  assert.ok(done.events.some(e => /resubmitting its saved request/.test(e.text)));
  second.close();

  let refuse = true;
  const drivers = { ...h.fake.drivers,
    still: { async submit(ctx) { if (refuse) { await ctx.record({ requestId: 'draft-1', fingerprint: 'x' }); throw Object.assign(Error('Paid generation is disabled'), { status: 403, notDispatched: true }); } return h.fake.drivers.still.submit(ctx); } },
    look: { ...h.fake.drivers.look, async finish() { throw Error('link failed'); } } };
  const third = await openBatches(await mkdtemp(join(tmpdir(), 'previs-batch-')), { drivers, jobs: h.fake.jobs, loadProject: async () => structuredClone(project), now: h.clock.now });
  const c = await third.create({ projectId: project.id, steps: ['looks', 'stills'], shots: [dive.id], maxCostUsd: 1 });
  const ended = await runUntil(third, c.id, h.clock);
  const still = byId(ended.nodes, `still:${dive.id}start`);
  assert.deepEqual([still.status, still.requestId, still.fingerprint], ['failed', undefined, undefined]);
  assert.ok(ended.events.some(e => /refused, nothing was sent/.test(e.text)));
  const looks = ended.nodes.filter(n => n.type === 'look');
  assert.ok(looks.length && looks.every(n => n.status === 'done' && /finishing failed: link failed/.test(n.error)));
  assert.equal(ended.spentEstimateUsd, round4(looks.reduce((t, n) => t + n.estimateUsd, 0)), 'the refused still was refunded');
  refuse = false;
  await third.resume(c.id);
  const again = await runUntil(third, c.id, h.clock);
  assert.equal(again.status, 'completed');
  assert.equal(h.fake.submits.filter(s => s.type === 'look').length, looks.length, 'done looks are not redone');
  third.close();
});
const round4 = x => Math.round(x * 10000) / 10000;

test('exhausted output recovery pauses a batch and resume never resubmits the paid node', async () => {
  const h = harness();
  const batches = await h.open();
  const b = await batches.create({ projectId: project.id, steps: ['stills'], shots: [dive.id], maxCostUsd: 5 });
  await batches.tick(b.id); await batches.idle();
  const jobs = h.fake.all(); assert.ok(jobs.length);
  for (const j of jobs) j.status = 'recovery-required';
  await batches.tick(b.id); await batches.idle();
  const paused = batches.get(b.id);
  assert.equal(paused.status, 'paused');
  assert.ok(paused.nodes.some(n => n.recoveryRequired && n.status === 'failed'));
  const submissions = h.fake.submits.length;
  await batches.resume(b.id); await batches.tick(b.id); await batches.idle();
  assert.equal(h.fake.submits.length, submissions);
  batches.close();
});

test('dry runs live in memory for an hour and are never persisted; old saved dry runs are not loaded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'previs-batch-')), h = harness();
  const batches = await h.open(root);
  const dry = await batches.create({ projectId: project.id, steps: ['stills'], maxCostUsd: 1, dryRun: true });
  assert.deepEqual(await readdir(join(root, 'batches')), []);
  assert.equal(batches.get(dry.id).status, 'planned'); assert.equal(batches.list(project.id).length, 1);
  h.clock.advance(3601);
  assert.equal(batches.list(project.id).length, 0); assert.throws(() => batches.get(dry.id), /Unknown batch/);
  batches.close();
  // A dry run saved by an older server: loaded while fresh, skipped once it is an hour old (the file stays).
  const legacy = { ...dry, id: '0d0d0d0d-0000-4000-8000-000000000001', createdAt: new Date(h.clock.now() - 2 * 3600e3).toISOString() };
  const fresh = { ...dry, id: '0d0d0d0d-0000-4000-8000-000000000002', createdAt: new Date(h.clock.now() - 60e3).toISOString() };
  for (const b of [legacy, fresh]) await writeFile(join(root, 'batches', `${b.id}.json`), JSON.stringify(b));
  const reopened = await h.open(root);
  assert.deepEqual(reopened.list(project.id).map(b => b.id), [fresh.id]);
  assert.equal((await readdir(join(root, 'batches'))).length, 2);
  reopened.close();
});
