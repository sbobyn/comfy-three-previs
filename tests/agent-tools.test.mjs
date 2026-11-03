import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setsFor } from '../shared/sheet-presets.mjs';
import { frameArgs, frameRoutes, imageSize } from '../server/previs/frames.mjs';
import { builtInPresets } from '../server/previs/presets.mjs';

// The stdio MCP agent (server/previs/agent.mjs) against a fake Previs HTTP server: the C4 tools, their schemas and
// what they send. Contracts C1 (GET /api/jobs), C2 (render routes) and C3 (batch) are faked here.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x2d, 0x00, 0x50, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]); // SOF0 80×45
const VIDEO = '7e0d0a11-0000-4000-8000-000000000001', STILL2 = '7e0d0a11-0000-4000-8000-000000000002';
const LIBRARY_TOOLS = ['previs_library_list', 'previs_library_save', 'previs_library_place', 'previs_library_import', 'previs_library_export'];
const BLENDER_TOOLS = ['previs_director_import_blender', 'previs_director_blender_helper'];
const TAKE_TOOLS = ['previs_director_grade_take', 'previs_director_list_takes', 'previs_director_set_winner'];
const KEYFRAME_TOOLS = ['previs_director_keyframe']; // exact-frame key stills
const NEW_TOOLS = ['previs_director_render_blockout', 'previs_director_generate_still', 'previs_director_batch_generate', 'previs_director_batch_status', 'previs_director_view_shot', 'previs_director_jobs_dashboard'];

async function fixture() {
  const p = JSON.parse(await readFile(new URL('./fixtures/wingspan-project.json', import.meta.url), 'utf8'));
  const [s1, s2] = p.shots;
  s1.references.push({ ...s1.references.find(r => r.role === 'frame'), id: STILL2, file: `${STILL2}.png`, note: 'key frame @2.5s', createdAt: '2026-10-30T16:00:00.000Z' });
  delete s2.render;
  p.assets.push({ id: VIDEO, kind: 'workflow-result', shotId: s1.id, file: `assets/${VIDEO}.mp4`, mime: 'video/mp4', duration: 4, width: 1280, height: 720, fps: 24, createdAt: '2026-10-30T17:00:00.000Z', source: { workflow: 'LTX 2.5 Pro · first frame' } });
  return p;
}

function fakePrevis(p, { jobs = 'ok', headless = true, unpriced = false } = {}) {
  const calls = [], definitions = [];
  let bound = {}; // the engine reports the camera source of what was bound (shared/camera-source.mjs cameraSourceOf)
  const boundCamera = () => (bound.sourceVideo ? 'blockout' : bound.firstFrame && bound.lastFrame ? 'keyframes' : 'still');
  let submits = 0, batchPolls = 0;
  const batch = status => ({ id: 'b0000000-0000-4000-8000-000000000001', projectId: p.id, status, tier: 'draft', steps: ['stills'], estimateUsd: 0.09, reserveUsd: 0.099, breakdown: { listUsd: 0.056, refsUsd: 0.034, graderUsd: 0, expectedUsd: 0.09, marginUsd: 0.009, reserveUsd: 0.099, marginPct: 10 }, spentEstimateUsd: status === 'completed' ? 0.09 : 0, maxCostUsd: 1, budgetSkipped: 0,
    nodes: [{ id: 'still:a', type: 'still', label: 'Shot 1 · start still', status: status === 'completed' ? 'done' : 'running', deps: [], estimateUsd: 0.03 }, { id: 'still:b', type: 'still', label: 'Shot 2 · start still', status: status === 'completed' ? 'failed' : 'ready', error: 'Fake failure', deps: [], estimateUsd: 0.03 }, { id: 'still:c', type: 'still', label: 'Shot 3', status: 'budget', deps: [], estimateUsd: 0.03 }],
    events: Array.from({ length: 14 }, (_, i) => ({ at: '2026-10-30T10:00:00Z', text: `event ${i}` })) });
  const routes = {
    'GET /api/director/project': () => ({ project: p }),
    'GET /api/director/refgen': () => ({ presets: [{ id: 'flux-2-pro', title: 'FLUX 2 Pro', maxRefs: 7, pricing: { usdPerImage: 0.03 } }] }),
    'POST /api/director/render-blockout': b => (!headless ? [409, { error: 'Headless rendering is off', code: 'headless-unavailable' }] : b.force || !p.shots.find(s => s.id === b.shotId).render ? { asset: { id: 'a1', width: 1280, height: 720, fps: 24, frameCount: 120, duration: 5 }, previsShotId: 'ps1', project: p } : { skipped: true, previsShotId: 'ps0', asset: { id: 'a0' } }),
    'POST /api/director/frame': b => (headless ? { data: PNG.toString('base64'), mime: b.type || 'image/png', width: b.width, height: b.height } : [409, { error: 'Headless rendering is off', code: 'headless-unavailable' }]),
    'GET /api/director/asset-frame': (_, q) => (!(Number(q.get('cols')) >= 1 && Number(q.get('cols')) <= 6) ? [400, { error: 'cols must be a whole number from 1 to 6' }] : { data: JPEG.toString('base64'), mime: q.get('type'), width: 80, height: 45 }),
    'POST /api/director/refgen/prepare': b => ({ job: { id: 'r' + calls.length, fingerprint: 'fp', quote: { estimate: unpriced ? null : 0.03 * (b.count || 1) } } }),
    'POST /api/director/refgen/submit': () => (++submits === 1 ? [409, { error: 'Backend busy: 4 of 4 cloud image slots in use; retry when a job finishes', code: 'busy', retryAfterSeconds: 0 }] : { job: { status: 'submitted' } }),
    'POST /api/director/refgen/track': () => ({ job: { status: 'completed', referenceIds: ['ref-' + calls.length] } }),
    'POST /api/director/edit': b => { for (const op of b.ops) if (op.op === 'update_entity' && op.patch.sheets) p.scene.entities.find(e => e.id === op.id).sheets = op.patch.sheets; return { project: p }; },
    'POST /api/director/sheet/compose': () => ({ referenceId: 'composed-1', project: p }),
    'GET /api/generation': () => ({ presets: [...builtInPresets, ...(unpriced ? [{ id: 'unpriced-edit', title: 'Unpriced edit', task: 'transform-video', inputs: { sourceVideo: {} }, parameters: {}, pricing: null }] : [])], definitions, jobs: [] }),
    // Like the real route: a built-in preset is saved under a new id before it can be bound.
    'POST /api/generation/preset': b => { const definition = { ...b.definition, id: `saved-${definitions.length + 1}` }; definitions.push(definition); return { project: { revision: 2 }, definition }; },
    'GET /api/project': () => ({ project: { revision: 1, renders: [] } }),
    'POST /api/director/video-refs': b => ({ references: [{ label: b.firstFrame ? 'start key frame' : 'start still', role: 'frame', renderId: 'r-start' }] }),
    'POST /api/generation/bind': b => { bound = b.assetBindings; return { project: { revision: 2 }, workflowBindingId: 'wb1' }; },
    'POST /api/generation/quote': b => ({ job: { id: b.requestId, fingerprint: 'gfp', cameraSource: boundCamera() } }),
    'POST /api/generation/submit': b => ({ job: { id: b.requestId, status: 'queued', cameraSource: boundCamera() } }),
    'POST /api/director/batch': b => ({ batch: { ...batch(b.dryRun ? 'planned' : 'running'), ...(b.dryRun ? { status: 'planned' } : {}) } }),
    'GET /api/director/batch': () => ({ batch: batch(++batchPolls >= 2 ? 'completed' : 'running') }),
    'GET /api/jobs': () => (jobs === 'missing' ? [404, { error: 'File not found; run pnpm build first.' }] : { jobs: [
      { id: 'aaaaaaaa-1', kind: 'image', source: 'refgen', label: 'Look · Bald eagle · FLUX 2 Pro', status: 'completed', createdAt: '2026-10-30T10:00:00Z', ageSeconds: 50, expectedSeconds: 90, costUsd: 0.03, stuck: false, uncertain: false },
      { id: 'bbbbbbbb-2', kind: 'video', source: 'generation', label: 'Shot 02 The dive · LTX 2.5 Pro', status: 'running', createdAt: '2026-10-30T10:01:00Z', ageSeconds: 1200, expectedSeconds: 270, costUsd: 0.86, stuck: true, uncertain: false },
      { id: 'cccccccc-3', kind: 'video', source: 'generation', label: 'Shot 03 The swoop · LTX 2.5 Pro', status: 'uncertain', createdAt: '2026-10-30T10:02:00Z', ageSeconds: 300, expectedSeconds: 270, costUsd: 0.86, stuck: false, uncertain: true },
      { id: 'dddddddd-4', kind: 'image', source: 'refgen', label: 'Still · Shot 1', status: 'queued', createdAt: '2026-10-30T10:03:00Z', ageSeconds: 10, expectedSeconds: 90, costUsd: 0.03, stuck: false, uncertain: false },
      { id: 'eeeeeeee-5', kind: 'video', source: 'generation', label: 'Shot 01 · Kling', status: 'failed', createdAt: '2026-10-30T09:00:00Z', ageSeconds: 4000, expectedSeconds: 420, costUsd: 1.2, stuck: false, uncertain: false, failure: { phase: 'dispatch', httpStatus: 400, detail: 'prompt too long' } },
    ], limits: { 'cloud:image': { limit: 4, active: 1 }, 'cloud:video': { limit: 3, active: 2 }, local: { limit: 1, active: 0 } }, tracker: { running: true, startedAt: '2026-10-30T09:00:00Z', resumed: 1 } }),
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x'); let text = ''; for await (const c of req) text += c;
    const body = text ? JSON.parse(text) : {};
    calls.push({ method: req.method, path: url.pathname, body, query: url.searchParams });
    const fn = routes[`${req.method} ${url.pathname}`];
    const out = fn ? fn(body, url.searchParams) : [404, { error: 'not found' }];
    const [status, json] = Array.isArray(out) ? out : [200, out];
    res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json));
  });
  return { server, calls, listen: () => new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`))) };
}

async function withAgent(fake, fn, env = {}) {
  const base = await fake.listen();
  const agent = spawn(process.execPath, ['server/previs/agent.mjs'], { env: { ...process.env, PREVIS_MCP_LEGACY: '', PREVIS_URL: base, PREVIS_AGENT_POLL_MS: '20', ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map(); let n = 0;
  createInterface({ input: agent.stdout }).on('line', l => { const m = JSON.parse(l); pending.get(m.id)?.(m); });
  const rpc = (method, params) => new Promise(r => { const id = ++n; pending.set(id, r); agent.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const raw = async (name, args) => { const m = await rpc('tools/call', { name, arguments: args }); assert.equal(m.result.isError, false, m.result.content[0].text); return m.result.content; };
  const call = async (name, args) => JSON.parse((await raw(name, args))[0].text);
  try { await fn({ rpc, raw, call }); } finally { agent.kill(); fake.server.close(); }
}

test('tools/list exposes the C4 tools with schemas; instructions mention rendering and seeing frames', async () => {
  const p = await fixture();
  await withAgent(fakePrevis(p), async ({ rpc }) => {
    const init = (await rpc('initialize', {})).result;
    assert.match(init.instructions, /previs_director_render_blockout/); assert.match(init.instructions, /previs_director_view_shot/); assert.match(init.instructions, /previs_director_batch_generate/);
    const tools = (await rpc('tools/list', {})).result.tools, by = Object.fromEntries(tools.map(t => [t.name, t]));
    for (const name of NEW_TOOLS) { assert.ok(by[name], name); assert.equal(by[name].inputSchema.type, 'object'); assert.equal(by[name].inputSchema.additionalProperties, false); assert.ok(by[name].description.length > 40); assert.equal('run' in by[name] || 'content' in by[name], false); }
    assert.deepEqual(by.previs_director_render_blockout.inputSchema.required, ['projectId', 'shot']);
    assert.deepEqual(by.previs_director_generate_still.inputSchema.required, ['projectId', 'shot', 'at', 'maxCostUsd']);
    assert.deepEqual(by.previs_director_batch_generate.inputSchema.required, ['projectId', 'steps', 'maxCostUsd']);
    assert.deepEqual(by.previs_director_batch_status.inputSchema.required, ['batchId']);
    assert.deepEqual(by.previs_director_view_shot.inputSchema.properties.what.enum, ['blockout', 'still', 'video']);
    assert.deepEqual(by.previs_director_jobs_dashboard.inputSchema.properties, {});
    assert.equal(by.previs_director_generate_sheet.inputSchema.properties.compose.type, 'boolean');
  });
});

test('render_blockout renders, skips a rendered shot and explains a disabled renderer', async () => {
  const p = await fixture();
  const fake = fakePrevis(p);
  await withAgent(fake, async ({ call }) => {
    const r = await call('previs_director_render_blockout', { projectId: p.id, shot: '2' });
    assert.equal(r.rendered, true); assert.equal(r.asset.frameCount, 120);
    assert.deepEqual(fake.calls.find(c => c.path === '/api/director/render-blockout').body, { projectId: p.id, shotId: p.shots[1].id, force: false });
    const skipped = await call('previs_director_render_blockout', { projectId: p.id, shot: 'The valley' });
    assert.equal(skipped.skipped, true); assert.equal(skipped.rendered, false);
  });
  await withAgent(fakePrevis(p, { headless: false }), async ({ call }) => {
    const r = await call('previs_director_render_blockout', { projectId: p.id, shot: '2' });
    assert.equal(r.rendered, false); assert.match(r.reason, /PREVIS_HEADLESS=1/);
  });
});

test('view_shot returns MCP image content for blockout, still and video, plus contact sheets', async () => {
  const p = await fixture();
  const fake = fakePrevis(p);
  await withAgent(fake, async ({ raw }) => {
    const blockout = await raw('previs_director_view_shot', { projectId: p.id, shot: '1', what: 'blockout', t: 1.5 });
    assert.equal(blockout[0].type, 'image'); assert.equal(blockout[0].mimeType, 'image/png');
    assert.deepEqual(Buffer.from(blockout[0].data, 'base64').subarray(0, 8), PNG.subarray(0, 8));
    const info = JSON.parse(blockout[1].text); assert.equal(info.t, 1.5); assert.equal(info.what, 'blockout'); assert.equal(info.image.mimeType, 'image/png');
    assert.deepEqual(fake.calls.at(-1).body, { projectId: p.id, shotId: p.shots[0].id, t: 1.5, width: 1280, height: 720, type: 'image/png' });

    const still = await raw('previs_director_view_shot', { projectId: p.id, shot: '1', what: 'still' });
    assert.equal(still[0].type, 'image'); assert.equal(still[0].mimeType, 'image/jpeg');
    assert.deepEqual(fake.calls.at(-1).query.getAll('referenceId'), [STILL2], 'newest still');
    const nearStart = await raw('previs_director_view_shot', { projectId: p.id, shot: '1', what: 'still', t: 0.4 });
    assert.equal(JSON.parse(nearStart[1].text).stills[0].at, 'start');
    assert.notEqual(fake.calls.at(-1).query.get('referenceId'), STILL2);

    const video = await raw('previs_director_view_shot', { projectId: p.id, shot: '1', what: 'video', t: 3 });
    assert.equal(video[0].type, 'image');
    let q = fake.calls.at(-1).query; assert.equal(q.get('assetId'), VIDEO); assert.equal(q.get('t'), '3'); assert.equal(q.get('cols'), '1');
    assert.equal(JSON.parse(video[1].text).video.model, 'LTX 2.5 Pro');

    const sheet = await raw('previs_director_view_shot', { projectId: p.id, shot: '1', what: 'video', contactSheet: 4 });
    q = fake.calls.at(-1).query; assert.deepEqual(q.getAll('t'), ['0', '1.33', '2.67', '4']); assert.equal(q.get('cols'), '4');
    assert.equal(sheet[0].type, 'image');
    await raw('previs_director_view_shot', { projectId: p.id, shot: '2', what: 'blockout', contactSheet: 6 });
    q = fake.calls.at(-1).query; assert.equal(fake.calls.at(-1).path, '/api/director/asset-frame'); assert.equal(q.get('shotId'), p.shots[1].id); assert.equal(q.getAll('t').length, 6); assert.equal(q.get('cols'), '3');

    const none = await raw('previs_director_view_shot', { projectId: p.id, shot: '2', what: 'video' });
    assert.equal(none.length, 1); assert.equal(JSON.parse(none[0].text).available, false);
  });
});

test('generate_still mirrors the storyboard composer, retries a busy backend and waits for the result', async () => {
  const p = await fixture();
  const fake = fakePrevis(p);
  await withAgent(fake, async ({ call }) => {
    const r = await call('previs_director_generate_still', { projectId: p.id, shot: '2', at: 'start', maxCostUsd: 0.1, moment: 'the eagle folds its wings' });
    assert.equal(r.status, 'completed'); assert.equal(r.at, 'start'); assert.ok(r.referenceIds.length);
    const frame = fake.calls.find(c => c.path === '/api/director/frame');
    assert.deepEqual(frame.body, { projectId: p.id, shotId: p.shots[1].id, t: 0, width: 1280, height: 720, guide: true }, 'still guides use the guide look');
    const prep = fake.calls.find(c => c.path === '/api/director/refgen/prepare').body;
    assert.equal(prep.target, 'shot'); assert.equal(prep.frameAt, 'start'); assert.equal(prep.aspect, '16:9'); assert.equal(prep.presetId, 'flux-2-pro');
    assert.equal(prep.guide, PNG.toString('base64'));
    const prev = p.shots[0].references.filter(x => x.role === 'frame').at(-1);
    assert.equal(prep.referenceIds.at(-1), prev.id, 'previous shot’s last still for continuity');
    assert.match(prep.prompt, /Image 1 is a grey 3D blockout of this exact frame/); assert.match(prep.prompt, /At this moment: the eagle folds its wings\./);
    assert.match(prep.prompt, /^Image 1[^\n]*\nCamera: First frame of /, 'camera words come right after the guide line, before the shot text');
    assert.match(prep.prompt, new RegExp(`Image ${prep.referenceIds.length + 1} is the previous shot`));
    assert.equal(fake.calls.filter(c => c.path === '/api/director/refgen/submit').length, 2, 'one busy 409, then one submit');
    const over = await call('previs_director_generate_still', { projectId: p.id, shot: '2', at: 2, count: 4, maxCostUsd: 0.05 });
    assert.equal(over.submitted, false); assert.match(over.reason, /above maxCostUsd/);
    assert.equal(fake.calls.filter(c => c.path === '/api/director/refgen/prepare').at(-1).body.frameAt, 2);
  });
});

test('generate_sheet compose:true composes once every view lands', async () => {
  const p = await fixture();
  const fake = fakePrevis(p);
  await withAgent(fake, async ({ call }) => {
    const setId = setsFor('character')[0].id;
    const r = await call('previs_director_generate_sheet', { projectId: p.id, object: 'Bald eagle', setId, slots: [], maxCostUsd: 1, compose: true });
    assert.ok(r.results.length > 0 && r.results.every(x => x.status === 'completed'));
    assert.deepEqual(r.compose, { composed: true, referenceId: 'composed-1' });
    assert.deepEqual(fake.calls.find(c => c.path === '/api/director/sheet/compose').body, { projectId: p.id, entityId: p.scene.entities.find(e => e.name === 'Bald eagle').id, sheetId: r.sheetId });
    // maxCostUsd bounds the whole set: each view's allowance is what is left after the views before it ($0.03 each here).
    const allowances = [...new Map(fake.calls.filter(c => c.path === '/api/director/refgen/submit').map(c => [c.body.requestId, c.body.approval.allowance.maxAmount])).values()];
    assert.deepEqual(allowances, allowances.map((_, i) => Math.round((1 - 0.03 * i) * 10000) / 10000));
  });
  // A set whose expected total (list + the identity image per view) passes maxCostUsd is refused before anything is prepared.
  const p2 = await fixture(), fake2 = fakePrevis(p2);
  await withAgent(fake2, async ({ call }) => {
    const r = await call('previs_director_generate_sheet', { projectId: p2.id, object: 'Bald eagle', setId: setsFor('character')[0].id, maxCostUsd: 0.05 });
    assert.equal(r.submitted, false); assert.match(r.reason, /above maxCostUsd \$0\.05/);
    assert.equal(fake2.calls.filter(c => c.path === '/api/director/refgen/prepare' || c.path === '/api/director/refgen/submit').length, 0, 'nothing prepared or sent');
  });
});

test('batch_generate (dry run and wait) and batch_status summarise counts, spend and the last 10 events', async () => {
  const p = await fixture();
  const fake = fakePrevis(p);
  await withAgent(fake, async ({ call }) => {
    const dry = await call('previs_director_batch_generate', { projectId: p.id, steps: ['stills'], tier: 'draft', maxCostUsd: 1, dryRun: true });
    assert.equal(dry.status, 'planned'); assert.equal(dry.plan.length, 3); assert.match(dry.next, /Nothing was sent/);
    // The dry run itemizes what the estimate is made of and what the cap is checked against.
    assert.equal(dry.reserveUsd, 0.099); assert.deepEqual([dry.breakdown.listUsd, dry.breakdown.refsUsd, dry.breakdown.marginUsd, dry.breakdown.marginPct], [0.056, 0.034, 0.009, 10]);
    assert.match(dry.next, /\$0\.09: list \$0\.056 \+ reference images \$0\.034/); assert.match(dry.next, /reserve \(\$0\.099, 10% margin\)/);
    assert.deepEqual(fake.calls.find(c => c.path === '/api/director/batch').body, { projectId: p.id, steps: ['stills'], tier: 'draft', maxCostUsd: 1, dryRun: true });
    const run = await call('previs_director_batch_generate', { projectId: p.id, steps: ['stills'], maxCostUsd: 1, wait: true });
    assert.equal(run.status, 'completed'); assert.deepEqual(run.counts, { done: 1, failed: 1, budget: 1 }); assert.equal(run.failed[0].error, 'Fake failure');
    assert.equal('wait' in fake.calls.filter(c => c.path === '/api/director/batch' && c.method === 'POST').at(-1).body, false);
    const status = await call('previs_director_batch_status', { batchId: run.batchId });
    assert.equal(status.events.length, 10); assert.equal(status.events.at(-1).text, 'event 13'); assert.equal(status.spentEstimateUsd, 0.09);
  });
});

test('jobs_dashboard lists stuck and uncertain jobs first with advice, and copes without a tracker', async () => {
  const p = await fixture();
  await withAgent(fakePrevis(p), async ({ raw }) => {
    const [block] = await raw('previs_director_jobs_dashboard', {});
    assert.equal(block.type, 'text');
    const text = block.text, at = s => text.indexOf(s);
    assert.match(text, /cloud:video 2\/3/); assert.match(text, /tracker running/);
    assert.ok(at('Needs attention') < at('Active:') && at('Active:') < at('Recent:'));
    assert.ok(at('bbbbbbbb') < at('Active:') && at('cccccccc') < at('Active:'), 'stuck and uncertain first');
    assert.match(text, /STUCK/); assert.match(text, /Never retry or resubmit/); assert.match(text, /Reconcile… in the Jobs panel/);
    assert.match(text, /dispatch 400: prompt too long/);
  });
  await withAgent(fakePrevis(p, { jobs: 'missing' }), async ({ raw }) => {
    const [block] = await raw('previs_director_jobs_dashboard', {});
    assert.match(block.text, /not available on this Previs server yet/);
  });
});

const ffmpeg = spawnSync(process.env.PREVIS_FFMPEG || 'ffmpeg', ['-version']).status === 0;
test('asset-frame: one downscaled frame at t, still references and tiled contact sheets (ffmpeg)', { skip: !ffmpeg && 'ffmpeg not installed' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'previs-frames-'));
  try {
    const pid = 'f158baf1-2cac-4311-859a-e5c590d381d4', vid = VIDEO, rid = STILL2;
    await mkdir(join(dir, 'assets')); await mkdir(join(dir, 'refs'));
    const make = (args, out) => assert.equal(spawnSync('ffmpeg', ['-v', 'error', ...args, out]).status, 0);
    make(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=2', '-pix_fmt', 'yuv420p'], join(dir, 'assets', `${vid}.mp4`));
    make(['-f', 'lavfi', '-i', 'color=c=red:size=320x180', '-frames:v', '1'], join(dir, 'refs', `${rid}.png`));
    const p = { id: pid, scene: { references: [] }, shots: [{ id: 's1', duration: 2, references: [{ id: rid, file: `${rid}.png`, role: 'frame' }] }], assets: [{ id: vid, file: `assets/${vid}.mp4`, mime: 'video/mp4', duration: 2, fps: 24 }] };
    const headlessCalls = [];
    const route = frameRoutes({ director: { get: async () => p, assetFile: async (_, f) => join(dir, 'assets', f), refFile: async (_, f) => join(dir, 'refs', f) },
      headless: { run: async q => { headlessCalls.push(q); return { data: (await readFile(join(dir, 'refs', `${rid}.png`))).toString('base64') }; } } });
    const call = qs => route(new URL(`http://x/api/director/asset-frame?projectId=${pid}&${qs}`));
    const one = await call(`assetId=${vid}&t=1&width=320&type=image/png`);
    assert.deepEqual([one.width, one.height, one.mime], [320, 180, 'image/png']);
    assert.deepEqual(imageSize(Buffer.from(one.data, 'base64')), { width: 320, height: 180 });
    const late = await call(`assetId=${vid}&t=99&type=image/jpeg`);
    assert.equal(late.width, 640, 'never upscales'); assert.ok(late.frames[0] < 2, 't clamps to the last frame');
    const grid = await call(`assetId=${vid}&t=0&t=0.5&t=1&t=1.5&t=2&width=640&cols=3&type=image/jpeg`);
    assert.equal(grid.width, 640); assert.ok(grid.height > 200 && grid.height < 300, `two rows of 16:9 cells (${grid.height})`);
    const still = await call(`referenceId=${rid}&width=160`);
    assert.deepEqual([still.width, still.height], [160, 90]);
    const sheet = await call(`shotId=s1&t=0&t=1&width=400&cols=2&type=image/jpeg`);
    assert.equal(sheet.width, 400); assert.equal(headlessCalls.length, 2); assert.match(headlessCalls[0], /op=frame/);
    await assert.rejects(call(`assetId=nope`), /Unknown asset/);
    await assert.rejects(call(`width=5`), /width must be/);
    assert.ok(frameArgs([{ file: 'a', t: 0 }], { width: 100, cols: 1, type: 'image/png' }).includes('png'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('generate_video takes its camera from the blockout by preference, reports cameraSource and refuses a mismatched model', async () => {
  const p = await fixture();
  const fake = fakePrevis(p);
  await withAgent(fake, async ({ call }) => {
    const r = await call('previs_director_generate_video', { projectId: p.id, shot: '1', cameraSource: 'blockout', maxCostUsd: 3 });
    assert.equal(r.submitted, true); assert.equal(r.cameraSource, 'blockout'); assert.equal(r.camera, 'Camera: from blockout');
    const bind = fake.calls.find(c => c.path === '/api/generation/bind').body;
    const saved = fake.calls.find(c => c.path === '/api/generation/preset').body.definition;
    // The fixture's eagle travels about 120 m: a direction-critical shot starts on the route that kept direction (shared/blockout-fidelity.mjs).
    assert.equal(saved.provenance.presetId, 'seedance-25-edit-v1', 'direction-critical shot: the edit route that kept the blockout’s direction');
    assert.match(r.modelChosen, /motion\/direction-critical \(Bald eagle travels/);
    assert.equal(r.directionAdvice, undefined, 'no warning when the chosen route keeps direction');
    assert.equal(saved.provenance.referenceImages, 1, 'saved with the reference slots it binds');
    assert.equal(bind.definitionId, 'saved-1', 'binds the saved definition, never the bare preset id');
    assert.deepEqual(bind.assetBindings, { sourceVideo: { assetId: p.shots[0].render.assetId }, referenceImage1: { renderId: 'r-start' } });
    assert.match(bind.prompt, /blockout video exactly; it is the camera/);
    assert.equal(fake.calls.find(c => c.path === '/api/director/video-refs').body.stills, true);
    const binds = fake.calls.filter(c => c.path === '/api/generation/bind').length;
    const no = await call('previs_director_generate_video', { projectId: p.id, shot: '1', model: 'ltx-25-i2v-fast-v1', cameraSource: 'blockout', maxCostUsd: 3 });
    assert.equal(no.submitted, false); assert.equal(no.cameraSource, 'still'); assert.match(no.reason, /kling-o1-edit-v1/);
    assert.equal(fake.calls.filter(c => c.path === '/api/generation/bind').length, binds, 'nothing bound for a refused model');
    const inputs = await call('previs_director_shot_inputs', { projectId: p.id, shot: '1', model: 'seedance-25-edit-v1' });
    assert.equal(inputs.cameraSource, 'blockout'); assert.equal(inputs.blockout.current, true);
  });
});

test('generate_video: a shot that is not direction-critical keeps the cheapest blockout model; a critical one on Kling gets advice', async () => {
  const p = await fixture(), eagle = p.scene.entities.find(e => e.name === 'Bald eagle');
  const still = structuredClone(p); const e = still.scene.entities.find(x => x.id === eagle.id); delete e.path; e.rotation = 0; // perched
  const fake = fakePrevis(still);
  await withAgent(fake, async ({ call }) => {
    // Shot 3 sees the perched eagle side-on and nothing moves: not direction-critical.
    const r = await call('previs_director_generate_video', { projectId: still.id, shot: '3', cameraSource: 'blockout', maxCostUsd: 3 });
    assert.equal(fake.calls.find(c => c.path === '/api/generation/preset').body.definition.provenance.presetId, 'kling-o1-edit-v1', 'cheapest cloud model that follows the blockout');
    assert.equal(r.modelChosen, undefined);
  });
  const fake2 = fakePrevis(p);
  await withAgent(fake2, async ({ call }) => {
    const r = await call('previs_director_generate_video', { projectId: p.id, shot: '1', model: 'kling-o1-edit-v1', maxCostUsd: 3 });
    assert.equal(r.submitted, true, 'advice never blocks');
    assert.match(r.directionAdvice, /Recommended: Seedance 2\.5 · edit the complete video/);
    const inputs = await call('previs_director_shot_inputs', { projectId: p.id, shot: '1', model: 'kling-o1-edit-v1' });
    assert.deepEqual([inputs.directionAdvice.critical, inputs.directionAdvice.ok, inputs.directionAdvice.recommend.model], [true, false, 'seedance-25-edit-v1']);
    const models = await call('previs_director_models', { projectId: p.id });
    assert.equal(models.videoModels.find(m => m.id === 'seedance-25-edit-v1').blockoutFidelity.direction, 'follows');
    assert.equal(models.videoModels.find(m => m.id === 'ltx-25-i2v-fast-v1').blockoutFidelity.route, 'start');
  });
});

test('generate_video: a missing end still is an explicit choice, a stale start is refused, and the reply shows the effective camera, length and prompt', async () => {
  const p = await fixture(), fake = fakePrevis(p);
  await withAgent(fake, async ({ call }) => {
    const binds = () => fake.calls.filter(c => c.path === '/api/generation/bind').map(c => c.body);
    // Shot 1 has a start still and no end still: a start → end model is refused, naming the start-only choice.
    const no = await call('previs_director_generate_video', { projectId: p.id, shot: '1', model: 'ltx-25-flf-v1', maxCostUsd: 3 });
    assert.equal(no.submitted, false); assert.match(no.reason, /needs an end key frame, or choose to animate the start still alone with LTX 2\.5 Pro.*allowStartOnly: true/);
    assert.equal(no.startOnlyModel, 'ltx-25-i2v-v1'); assert.equal(binds().length, 0, 'nothing bound');
    const yes = await call('previs_director_generate_video', { projectId: p.id, shot: '1', model: 'ltx-25-flf-v1', maxCostUsd: 3, allowStartOnly: true });
    assert.equal(yes.submitted, true); assert.equal(yes.modelId, 'ltx-25-i2v-v1'); assert.equal(yes.cameraSource, 'still'); assert.equal(yes.clipSeconds, 5);
    assert.equal(yes.estimateUsd, 0.86, '5 s × $0.172/s');
    assert.match(yes.prompt, /Hold the still’s framing/);
    assert.deepEqual(Object.keys(binds()[0].assetBindings), ['firstFrame']);
    assert.equal(fake.calls.find(c => c.path === '/api/generation/preset').body.definition.provenance.presetId, 'ltx-25-i2v-v1');
  });
  // The same start still, made for an earlier blocking: refused before anything is registered or bound.
  const old = await fixture(); old.shots[0].references.find(r => r.note === 'key frame start').generated.signature = 'earlier-blocking';
  old.shots[0].prompts = { video: { text: 'Slow dolly left, whip pan to the eagle.', edited: true } };
  const fake2 = fakePrevis(old);
  await withAgent(fake2, async ({ call }) => {
    const r = await call('previs_director_generate_video', { projectId: old.id, shot: '1', model: 'ltx-25-i2v-v1', maxCostUsd: 3 });
    assert.equal(r.submitted, false); assert.match(r.reason, /start still was made before the shot’s camera, timing or scene changed.*nothing was sent/);
    assert.equal(fake2.calls.filter(c => c.path === '/api/director/video-refs' || c.path.startsWith('/api/generation/')).length, 0);
    const inputs = await call('previs_director_shot_inputs', { projectId: old.id, shot: '1', model: 'ltx-25-flf-v1' });
    assert.equal(inputs.keyFrames.start, 'stale'); assert.equal(inputs.keyFrames.end, 'missing'); assert.match(inputs.keyFrames.withoutEnd, /allowStartOnly/);
    assert.match(inputs.promptWarning, /“dolly left”, “whip pan”.*camera comes from the start and end stills/, 'free text that directs the camera is surfaced');
    const models = await call('previs_director_models', { projectId: old.id });
    assert.equal(models.imageModels[0].usdPerImage, 0.03, 'image prices come from the preset pricing');
  });
});

test('generate_image and generate_video refuse a model without a price estimate unless allowUnknownCost is true', async () => {
  const p = await fixture(), fake = fakePrevis(p, { unpriced: true });
  await withAgent(fake, async ({ rpc, call }) => {
    const tools = (await rpc('tools/list', {})).result.tools;
    for (const name of ['previs_director_generate_image', 'previs_director_generate_video']) {
      const t = tools.find(x => x.name === name);
      assert.equal(t.inputSchema.properties.allowUnknownCost.type, 'boolean', name); assert.match(t.description, /allowUnknownCost/);
    }
    const shot = p.shots.find(x => x.render);
    const video = await call('previs_director_generate_video', { projectId: p.id, shot: shot.id, model: 'unpriced-edit', maxCostUsd: 1 });
    assert.equal(video.submitted, false); assert.match(video.reason, /Cost unknown/);
    assert.equal(fake.calls.filter(c => c.path.startsWith('/api/generation/') || c.path === '/api/director/video-refs').length, 0, 'nothing is bound or quoted');
    const object = p.scene.entities.find(e => e.kind !== 'environment').name;
    const refused = await call('previs_director_generate_image', { projectId: p.id, object, maxCostUsd: 1 });
    assert.equal(refused.submitted, false); assert.match(refused.reason, /Cost unknown.*nothing was sent/);
    assert.equal(fake.calls.filter(c => c.path === '/api/director/refgen/submit').length, 0);
    const sent = await call('previs_director_generate_image', { projectId: p.id, object, maxCostUsd: 1, allowUnknownCost: true, makePrimary: false });
    assert.equal(sent.status, 'completed');
    assert.ok(fake.calls.some(c => c.path === '/api/director/refgen/submit' && c.body.approval.allowance.allowUnknownCharges === true));
  });
});

test('tools/list: the director and library tools by default; legacy engine, Blender and passthrough tools only with PREVIS_MCP_LEGACY=1', async () => {
  const p = await fixture();
  let names;
  await withAgent(fakePrevis(p), async ({ rpc }) => {
    const tools = (await rpc('tools/list', {})).result.tools; names = tools.map(t => t.name);
    const director = names.filter(n => n.startsWith('previs_director_')), library = names.filter(n => n.startsWith('previs_library_'));
    const PROMPT_TOOLS = ['previs_director_prompt_sections', 'previs_director_set_prompt_section', 'previs_director_prompt_history', 'previs_director_model_settings'];
    const PERFORM_TOOLS = ['previs_director_perform'];
    const REGEN_TOOLS = ['previs_director_regen_status', 'previs_director_pin_output'];
    const LOOK_TOOLS = ['previs_director_look_presets', 'previs_director_set_look', 'previs_director_add_variants'];
    const GROUPS = [...BLENDER_TOOLS, ...KEYFRAME_TOOLS, ...TAKE_TOOLS, ...PROMPT_TOOLS, ...PERFORM_TOOLS, ...REGEN_TOOLS, ...LOOK_TOOLS];
    assert.equal(director.length, 27 + GROUPS.length, `${director.length} director tools: 27 plus the ${BLENDER_TOOLS.length} Blender import, ${KEYFRAME_TOOLS.length} keyframe, ${TAKE_TOOLS.length} take, ${PROMPT_TOOLS.length} prompt, ${PERFORM_TOOLS.length} perform, ${REGEN_TOOLS.length} regeneration and ${LOOK_TOOLS.length} look tools`);
    for (const name of GROUPS) assert.ok(director.includes(name), name);
    assert.deepEqual(library, LIBRARY_TOOLS, 'the asset library tools, as one group');
    assert.equal(names.length, 27 + GROUPS.length + LIBRARY_TOOLS.length + 1, 'director (with Blender import, keyframe, take, prompt, perform, regeneration and look tools), library tools and previs_import_asset');
    assert.deepEqual(names.filter(n => !director.includes(n) && !library.includes(n)), ['previs_import_asset']);
    assert.match(tools.find(t => t.name === 'previs_director_edit').description, /\{op:"use_take",shotId,referenceId\}/);
    const refused = await rpc('tools/call', { name: 'previs_render_animation', arguments: {} });
    assert.match(refused.error.message, /Unknown tool/);
  });
  await withAgent(fakePrevis(p), async ({ rpc }) => {
    const all = (await rpc('tools/list', {})).result.tools.map(t => t.name);
    for (const legacy of ['previs_render_animation', 'previs_refresh_blender', 'previs_submit_passthrough', 'previs_project']) assert.ok(all.includes(legacy), legacy);
    assert.ok(all.length > names.length);
  }, { PREVIS_MCP_LEGACY: '1' });
});
