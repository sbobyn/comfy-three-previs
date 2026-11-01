// Real batch drivers (loopbackDrivers) against a mocked Previs HTTP server: request shapes, ids recorded before submit,
// busy/refusal handling, budget allowance, the LTX start→end fallback and the sheet partial-slot policy. Nothing is sent anywhere.
import test from 'node:test';
import { frameCount } from '../shared/keyframes.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { loopbackDrivers, loopbackJobs } from '../server/previs/batch-drivers.mjs';
import { openBatches } from '../server/previs/batch.mjs';
import { builtInPresets } from '../server/previs/presets.mjs';

const fixture = JSON.parse(await readFile(new URL('./fixtures/wingspan-project.json', import.meta.url), 'utf8'));
const [valley, dive] = fixture.shots;
const named = (p, name) => p.scene.entities.find(e => e.name === name);
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64');

/** A mock of the routes the drivers call. `on[path]` overrides a POST handler; `log` keeps every call in order. */
async function mockServer({ on = {}, project = structuredClone(fixture) } = {}) {
  const log = [], refgen = new Map(), gen = new Map(), definitions = [];
  let revision = 10, staleBinds = 1;
  const quote = { status: 'known', amount: 0.028, currency: 'USD' };
  const routes = {
    'GET /api/director/project': () => ({ project }),
    'GET /api/director/refgen': () => ({ presets: [{ id: 'flux-2-pro', maxRefs: 7, pricing: { usdPerImage: 0.028 } }, { id: 'flux-3', maxRefs: 9 }], jobs: [...refgen.values()] }),
    'POST /api/director/refgen/prepare': b => { const job = { id: randomUUID(), fingerprint: 'fp-' + refgen.size, quote: b.quote || quote, status: 'quoted', body: b }; refgen.set(job.id, job); return { job }; },
    'POST /api/director/refgen/submit': b => { const j = refgen.get(b.requestId); if (!j) throw [404, { error: 'Unknown request' }]; if (j.status === 'quoted') Object.assign(j, { status: 'submitted', approval: b.approval }); return { job: j }; },
    'POST /api/director/frame': b => ({ data: PNG, mime: 'image/png', width: 1280, height: 720, t: b.t }),
    'POST /api/director/render-blockout': b => ({ asset: { id: 'asset-' + b.shotId.slice(0, 4) }, previsShotId: 'ps-' + b.shotId.slice(0, 4) }),
    'POST /api/director/edit': b => { for (const op of b.ops) Object.assign(project.scene.entities.find(e => e.id === op.id), op.patch); return { project }; },
    'POST /api/director/sheet/compose': () => ({ referenceId: 'composed-ref' }),
    'POST /api/director/video-refs': b => ({ references: [{ label: 'start key frame', renderId: 'r-start' }, ...(b.lastFrame && on.endFrame ? [{ label: 'end key frame', renderId: 'r-end' }] : [])] }),
    'GET /api/generation': () => ({ presets: builtInPresets, definitions, jobs: [...gen.values()] }),
    'GET /api/project': () => ({ project: { revision, renders: [] } }),
    'POST /api/generation/preset': b => { if (b.revision !== revision) throw [409, { error: 'Project changed. Refresh before editing.' }]; revision++; const d = { ...b.definition, id: randomUUID() }; definitions.push(d); return { definition: d, project: { revision } }; },
    'POST /api/generation/bind': b => { if (staleBinds-- > 0) { revision++; throw [409, { error: 'Project changed. Refresh before editing.' }]; } if (b.revision !== revision) throw [409, { error: 'Project changed. Refresh before editing.' }]; revision++; return { project: { revision }, workflowBindingId: 'wb-' + revision, body: b }; },
    'POST /api/generation/quote': b => { const job = { id: b.requestId, fingerprint: 'gfp', quote: { status: 'unknown', estimate: 0.64, currency: 'USD' }, status: 'quoted' }; gen.set(job.id, job); return { job }; },
    'POST /api/generation/submit': b => { const j = gen.get(b.requestId); if (j.status === 'quoted') Object.assign(j, { status: 'queued', approval: b.approval }); return { job: j }; },
    'GET /api/jobs': () => ({ jobs: [...refgen.values(), ...gen.values()].filter(j => j.status !== 'quoted').map(j => ({ id: j.id, status: j.status, results: j.results || [] })), limits: {} }),
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x'), key = `${req.method} ${url.pathname}`;
    let text = ''; for await (const c of req) text += c;
    const body = text ? JSON.parse(text) : {};
    log.push({ key, body });
    const answer = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    try {
      const custom = on[key];
      if (custom) { const r = await custom(body, { refgen, gen }); if (r === 'drop') return req.socket.destroy(); if (r !== undefined) return answer(200, r); }
      if (!routes[key]) return answer(404, { error: `no mock for ${key}` });
      answer(200, await routes[key](body));
    } catch (e) { if (Array.isArray(e)) answer(e[0], e[1]); else answer(500, { error: e.message }); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, log, refgen, gen, definitions, project, close: () => new Promise(r => server.close(r)), calls: key => log.filter(x => x.key === key) };
}

/** ctx like the scheduler's: record() patches the node (undefined deletes) and remembers the order relative to HTTP calls. */
function ctxFor(m, node, { maxCostUsd = 5, spent = node.estimateUsd || 0 } = {}) {
  const records = [];
  return {
    records,
    batch: { projectId: m.project.id, maxCostUsd, spentEstimateUsd: spent },
    node: { reserved: node.estimateUsd, ...node },
    project: async () => structuredClone(m.project),
    async record(patch) { records.push({ at: m.log.length, patch }); for (const [k, v] of Object.entries(patch)) if (v === undefined) delete this.node[k]; else this.node[k] = v; },
  };
}

test('look: quote → record id and fingerprint → submit with an allowance capped at the remaining budget; family members share it', async () => {
  const m = await mockServer(), d = loopbackDrivers(m.base);
  try {
    const river = named(m.project, 'River 1'), family = m.project.scene.entities.filter(e => e.parent === river.parent && e.shape === river.shape).map(e => e.id);
    const ctx = ctxFor(m, { id: `look:${river.id}`, type: 'look', model: 'flux-2-pro', estimateUsd: 0.028, target: { entityId: river.id, family } }, { maxCostUsd: 1, spent: 0.5 });
    const r = await d.look.submit(ctx);
    const prep = m.calls('POST /api/director/refgen/prepare')[0].body, sub = m.calls('POST /api/director/refgen/submit')[0].body;
    assert.deepEqual([prep.entityId, prep.presetId, prep.aspect, prep.count], [river.id, 'flux-2-pro', '16:9', 1]);
    assert.match(prep.prompt, /River 1/);
    assert.equal(r.requestId, ctx.node.requestId);
    const submitAt = m.log.findIndex(x => x.key === 'POST /api/director/refgen/submit');
    assert.ok(ctx.records[0].at <= submitAt && ctx.records[0].patch.requestId === sub.requestId, 'id recorded before the submit call');
    assert.deepEqual(sub.approval, { approved: true, fingerprint: ctx.node.fingerprint, allowance: { currency: 'USD', maxAmount: 0.528, allowUnknownCharges: true } });
    const out = await d.look.finish(ctx, []);
    assert.equal(out.linked, family.length - 1);
    assert.ok(family.filter(id => id !== river.id).every(id => m.project.scene.entities.find(e => e.id === id).lookFrom === river.id));
    assert.equal((await d.look.finish(ctx, [])).linked, 0, 'linking is idempotent');
  } finally { await m.close(); }
});

test('still: blockout frame at t as the guide, cast looks as references, end at the blockout’s last encoded frame', async () => {
  const m = await mockServer(), d = loopbackDrivers(m.base);
  try {
    const ctx = ctxFor(m, { id: `still:${dive.id}end`, type: 'still', model: 'flux-2-pro', estimateUsd: 0.028, target: { shotId: dive.id, t: 'end' } });
    await d.still.submit(ctx);
    // "End" is the last frame the blockout encodes ((n − 1) / 24), not the shot length: the guide, the still and its grade agree.
    const last = frameCount(fixture, dive) - 1;
    assert.equal(m.calls('POST /api/director/frame')[0].body.t, last / 24);
    const prep = m.calls('POST /api/director/refgen/prepare')[0].body;
    assert.deepEqual([prep.target, prep.shotId, prep.frameAt, prep.frame, prep.aspect, prep.guide], ['shot', dive.id, 'end', last, '16:9', PNG]);
    assert.ok(prep.referenceIds.length <= 6, 'guide takes one of the 7 image slots');
    assert.match(prep.prompt, /Image 1 is a grey 3D blockout/);
    if (prep.referenceIds.length) assert.match(prep.prompt, /looks exactly like image 2/);
  } finally { await m.close(); }
});

test('busy keeps the recorded request; the retry resubmits it without a new quote; refusals and dropped connections differ', async () => {
  let busy = 1;
  const m = await mockServer({ on: { 'POST /api/director/refgen/submit': () => (busy-- > 0 ? Promise.reject([409, { error: 'Backend busy', code: 'busy', retryAfterSeconds: 7 }]) : undefined) } });
  const d = loopbackDrivers(m.base);
  try {
    const ctx = ctxFor(m, { id: 'still:x', type: 'still', model: 'flux-2-pro', estimateUsd: 0.028, target: { shotId: dive.id, t: 'start' } });
    const e = await d.still.submit(ctx).catch(x => x);
    assert.deepEqual([e.apiCode, e.retryAfterSeconds, e.notDispatched], ['busy', 7, undefined]);
    const id = ctx.node.requestId; assert.ok(id);
    await d.still.submit(ctx);
    assert.equal(m.calls('POST /api/director/refgen/prepare').length, 1, 'no second quote');
    assert.equal(m.refgen.get(id).status, 'submitted');
    await d.still.submit(ctx);
    assert.equal(m.calls('POST /api/director/refgen/submit').length, 3, 'a resubmit of a sent request returns the saved job');
  } finally { await m.close(); }

  const refused = await mockServer({ on: { 'POST /api/director/refgen/submit': () => Promise.reject([403, { error: 'Paid and unknown-cost generation is disabled on this server' }]) } });
  try {
    const ctx = ctxFor(refused, { id: 'look:x', type: 'look', model: 'flux-2-pro', estimateUsd: 0.028, target: { entityId: named(refused.project, 'Bald eagle').id } });
    const e = await loopbackDrivers(refused.base).look.submit(ctx).catch(x => x);
    assert.equal(e.notDispatched, true, 'the request is still a draft: nothing was sent');
    assert.match(e.message, /disabled/);
  } finally { await refused.close(); }

  const dropped = await mockServer({ on: { 'POST /api/director/refgen/submit': () => 'drop' } });
  try {
    const ctx = ctxFor(dropped, { id: 'look:x', type: 'look', model: 'flux-2-pro', estimateUsd: 0.028, target: { entityId: named(dropped.project, 'Bald eagle').id } });
    const e = await loopbackDrivers(dropped.base).look.submit(ctx).catch(x => x);
    assert.ok(!e.notDispatched && ctx.node.requestId, 'outcome unknown: keep the id, the dashboard decides');
  } finally { await dropped.close(); }
});

test('a resumed request the server invalidated is re-quoted once; a known quote above the remaining budget is never submitted', async () => {
  const m = await mockServer({ on: { 'POST /api/director/refgen/submit': (b, { refgen }) => { const j = refgen.get(b.requestId); if (j.fingerprint === 'stale') { j.status = 'invalidated'; return Promise.reject([409, { error: 'Quote changed; get a new quote and approve again' }]); } } } });
  const d = loopbackDrivers(m.base);
  try {
    const old = m.refgen.set('old', { id: 'old', fingerprint: 'stale', status: 'quoted', quote: {} }).get('old');
    const ctx = ctxFor(m, { id: 'still:x', type: 'still', model: 'flux-2-pro', estimateUsd: 0.028, target: { shotId: dive.id, t: 'start' }, requestId: old.id, fingerprint: 'stale' });
    const r = await d.still.submit(ctx);
    assert.notEqual(r.requestId, 'old');
    assert.equal(m.calls('POST /api/director/refgen/prepare').length, 1);

    const pricey = ctxFor(m, { id: 'look:y', type: 'look', model: 'flux-2-pro', estimateUsd: 0.028, target: { entityId: named(m.project, 'Bald eagle').id } }, { maxCostUsd: 0.03, spent: 0.028 });
    const before = m.calls('POST /api/director/refgen/submit').length;
    const e = await d.look.submit({ ...pricey, batch: { ...pricey.batch, maxCostUsd: 0.02 } }).catch(x => x);
    assert.equal(e.notDispatched, true); assert.match(e.message, /remaining budget/);
    assert.equal(m.calls('POST /api/director/refgen/submit').length, before);
  } finally { await m.close(); }
});

test('video: LTX start→end falls back to start-only without an end still; preset saved once; bind retries a moved revision', async () => {
  const m = await mockServer(), d = loopbackDrivers(m.base);
  try {
    const ctx = ctxFor(m, { id: `video:${dive.id}`, type: 'video', model: 'ltx-25-flf-v1', estimateUsd: 0.86, target: { shotId: dive.id } }, { maxCostUsd: 4, spent: 1 });
    const r = await d.video.submit(ctx);
    assert.equal(ctx.node.modelUsed, 'ltx-25-i2v-v1');
    assert.equal(m.definitions.length, 1); assert.equal(m.definitions[0].provenance.presetId, 'ltx-25-i2v-v1');
    const bind = m.log.filter(x => x.key === 'POST /api/generation/bind');
    assert.equal(bind.length, 2, 'one stale revision, then bound');
    assert.deepEqual(bind[1].body.assetBindings, { firstFrame: { renderId: 'r-start' } });
    assert.equal(bind[1].body.shotId, dive.render.previsShotId);
    assert.equal(bind[1].body.parameters.duration, '5');
    assert.ok(bind[1].body.prompt.length > 20 && !/Preserve the supplied camera motion/.test(bind[1].body.prompt));
    const sub = m.calls('POST /api/generation/submit')[0].body;
    assert.equal(r.jobId, sub.requestId);
    assert.ok(ctx.records.find(x => x.patch.jobId).at <= m.log.indexOf(m.calls('POST /api/generation/submit')[0]), 'job id recorded before submit');
    assert.deepEqual(sub.approval.allowance, { currency: 'USD', maxAmount: 3.86, allowUnknownCharges: true });
    assert.equal(sub.backend.kind, 'cloud');

    // A second shot reuses the saved definition; with both stills the start→end model is used as planned.
    // (The driver reads the stills from the project, the same state the batch plan used, so the project has the end still.)
    const withEnd = structuredClone(fixture), v = withEnd.shots[0];
    v.references.push({ ...v.references.find(r => r.note === 'key frame start'), id: randomUUID(), note: 'key frame end' });
    const both = await mockServer({ on: { endFrame: true }, project: withEnd });
    try {
      const c2 = ctxFor(both, { id: `video:${valley.id}`, type: 'video', model: 'ltx-25-flf-v1', estimateUsd: 0.86, target: { shotId: valley.id } });
      await loopbackDrivers(both.base).video.submit(c2);
      assert.equal(c2.node.modelUsed, 'ltx-25-flf-v1');
      assert.deepEqual(both.calls('POST /api/generation/bind').at(-1).body.assetBindings, { firstFrame: { renderId: 'r-start' }, lastFrame: { renderId: 'r-end' } });
    } finally { await both.close(); }

    // Resuming the recorded job resubmits it (the store returns the saved job) without binding again.
    const binds = m.calls('POST /api/generation/bind').length;
    assert.equal((await d.video.submit(ctx)).jobId, r.jobId);
    assert.equal(m.calls('POST /api/generation/bind').length, binds);
  } finally { await m.close(); }
});

test('video: a blockout-driven model binds the blockout clip, leads the references with the stills and names no move', async () => {
  const refs = [{ label: 'start still', role: 'frame', renderId: 'r-start', referenceId: 'x1' }, { label: 'Bald eagle', role: 'character', renderId: 'r-eagle', referenceId: 'x2' }];
  const m = await mockServer({ on: { 'POST /api/director/video-refs': () => ({ references: refs }) } }), d = loopbackDrivers(m.base);
  try {
    const ctx = ctxFor(m, { id: `video:${dive.id}`, type: 'video', model: 'kling-o1-edit-v1', estimateUsd: 0.63, target: { shotId: dive.id } });
    await d.video.submit(ctx);
    assert.equal(m.calls('POST /api/director/video-refs')[0].body.stills, true, 'start/end stills requested as the look');
    const bind = m.calls('POST /api/generation/bind').at(-1).body;
    assert.deepEqual(bind.assetBindings, { sourceVideo: { assetId: dive.render.assetId }, referenceImage1: { renderId: 'r-start' }, referenceImage2: { renderId: 'r-eagle' } });
    assert.match(bind.prompt, /Follow the camera motion and framing of the blockout video exactly; it is the camera\./);
    assert.ok(!/Custom keys|eye level|FPV drone chase/.test(bind.prompt), 'no camera move in the prompt');
    assert.equal(ctx.node.cameraSource, 'blockout');

    // A blockout older than the shot is never sent: nothing is bound.
    const stale = await mockServer(), before = stale.project.shots.find(s => s.id === dive.id);
    before.render = { ...before.render, signature: 'not-this-shot' };
    try {
      const c2 = ctxFor(stale, { id: `video:${dive.id}`, type: 'video', model: 'kling-o1-edit-v1', estimateUsd: 0.63, target: { shotId: dive.id } });
      await assert.rejects(loopbackDrivers(stale.base).video.submit(c2), e => e.notDispatched && /make the blockout again/.test(e.message));
      assert.equal(stale.calls('POST /api/generation/bind').length, 0);
    } finally { await stale.close(); }
  } finally { await m.close(); }
});

test('sheet: every view quoted and listed on the object first; refused views are marked; compose only when every view landed', async () => {
  let refuse = 1;
  const m = await mockServer({ on: { 'POST /api/director/refgen/submit': (b, { refgen }) => { if (refgen.get(b.requestId).body.sheet.slotId && refuse-- > 0) return Promise.reject([400, { error: 'Explicit approval must match the current quote fingerprint' }]); } } });
  const d = loopbackDrivers(m.base);
  try {
    const eagle = named(m.project, 'Bald eagle');
    const ctx = ctxFor(m, { id: `sheet:${eagle.id}`, type: 'sheet', model: 'flux-2-pro', count: 4, estimateUsd: 0.112, target: { entityId: eagle.id, setId: 'turn4' } });
    const r = await d.sheet.submit(ctx);
    assert.equal(m.calls('POST /api/director/refgen/prepare').length, 4);
    assert.equal(r.requestIds.length, 3); assert.equal(r.unsent.length, 1); assert.match(r.error, /1 of 4 views not sent/);
    const sheet = m.project.scene.entities.find(e => e.id === eagle.id).sheets.find(s => s.id === ctx.node.sheetId);
    assert.equal(sheet.slots.length, 4);
    assert.match(sheet.slots.flatMap(s => s.attempts).find(a => a.requestId === r.unsent[0]).error, /Not sent/);
    const editsBeforeSubmit = m.log.findIndex(x => x.key === 'POST /api/director/edit') < m.log.findIndex(x => x.key === 'POST /api/director/refgen/submit');
    assert.ok(editsBeforeSubmit, 'the sheet is on the object before any view is sent');
    Object.assign(ctx.node, r);
    const done = r.requestIds.map(id => ({ id, status: 'completed', results: [{ id: 'ref-' + id.slice(0, 6) }] }));
    const partial = await d.sheet.finish(ctx, done);
    assert.equal(partial.partial, true); assert.match(partial.note, /1 of 4 views/);
    assert.equal(m.calls('POST /api/director/sheet/compose').length, 0);
    const kept = m.project.scene.entities.find(e => e.id === eagle.id).sheets.find(s => s.id === ctx.node.sheetId).slots.flatMap(s => s.attempts).filter(a => a.referenceId);
    assert.equal(kept.length, 3);

    // All four views land → composed.
    const c2 = ctxFor(m, { id: `sheet:${eagle.id}`, type: 'sheet', model: 'flux-2-pro', count: 4, estimateUsd: 0.112, target: { entityId: eagle.id, setId: 'turn4' } });
    const r2 = await d.sheet.submit(c2); Object.assign(c2.node, r2);
    assert.deepEqual(await d.sheet.finish(c2, r2.requestIds.map(id => ({ id, status: 'completed', results: [{ id: 'ref-' + id }] }))), { referenceId: 'composed-ref', composed: true });
  } finally { await m.close(); }
});

test('blockout renders through C2; end to end, the scheduler drives real drivers and reads completion from /api/jobs', async () => {
  const m = await mockServer({ on: { 'POST /api/director/refgen/submit': (b, { refgen }) => { const j = refgen.get(b.requestId); if (j.status === 'quoted') Object.assign(j, { status: 'completed', results: [{ id: 'still-ref', kind: 'image' }] }); return { job: j }; } } });
  const project = m.project;
  project.shots[1] = { ...project.shots[1], render: undefined };
  const real = loopbackDrivers(m.base);
  // Once the blockout lands, the director project has the render the video binds to.
  const drivers = { ...real, blockout: { async submit(ctx) { const r = await real.blockout.submit(ctx); project.shots[1].render = { ...dive.render, previsShotId: r.previsShotId }; return r; } } };
  const batches = await openBatches(await mkdtemp(join(tmpdir(), 'previs-batch-real-')), { drivers, jobs: loopbackJobs(m.base), loadProject: async () => structuredClone(project), intervalMs: 5 });
  try {
    const b = await batches.create({ projectId: project.id, steps: ['stills', 'videos'], shots: [dive.id], maxCostUsd: 2 });
    batches.start();
    for (let i = 0; i < 400; i++) {
      await new Promise(r => setTimeout(r, 10));
      for (const j of m.gen.values()) if (j.status === 'queued') Object.assign(j, { status: 'completed', results: [{ id: 'video-asset', kind: 'video' }] });
      if (batches.get(b.id).status !== 'running') break;
    }
    await batches.idle();
    const done = batches.get(b.id);
    assert.equal(done.status, 'completed', JSON.stringify(done.events.slice(-4)));
    const node = id => done.nodes.find(n => n.id === id);
    assert.deepEqual([node(`blockout:${dive.id}`).status, node(`still:${dive.id}start`).referenceId, node(`video:${dive.id}`).assetId], ['done', 'still-ref', 'video-asset']);
    assert.equal(m.calls('POST /api/director/render-blockout')[0].body.shotId, dive.id);
    assert.ok(done.spentEstimateUsd > 0 && done.spentEstimateUsd <= 2);
  } finally { batches.close(); await m.close(); }
});
