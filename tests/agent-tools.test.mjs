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

// The stdio MCP agent (server/previs/agent.mjs) against a fake Previs HTTP server: the C4 tools, their schemas and
// what they send. Contracts C1 (GET /api/jobs), C2 (render routes) and C3 (batch) are faked here.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x2d, 0x00, 0x50, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]); // SOF0 80×45
const VIDEO = '7e0d0a11-0000-4000-8000-000000000001', STILL2 = '7e0d0a11-0000-4000-8000-000000000002';
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
  const calls = [];
  let submits = 0, batchPolls = 0;
  const batch = status => ({ id: 'b0000000-0000-4000-8000-000000000001', projectId: p.id, status, tier: 'draft', steps: ['stills'], estimateUsd: 0.09, spentEstimateUsd: status === 'completed' ? 0.09 : 0, maxCostUsd: 1, budgetSkipped: 0,
    nodes: [{ id: 'still:a', type: 'still', label: 'Shot 1 · start still', status: status === 'completed' ? 'done' : 'running', deps: [], estimateUsd: 0.03 }, { id: 'still:b', type: 'still', label: 'Shot 2 · start still', status: status === 'completed' ? 'failed' : 'ready', error: 'Fake failure', deps: [], estimateUsd: 0.03 }, { id: 'still:c', type: 'still', label: 'Shot 3', status: 'budget', deps: [], estimateUsd: 0.03 }],
    events: Array.from({ length: 14 }, (_, i) => ({ at: '2026-10-30T10:00:00Z', text: `event ${i}` })) });
  const routes = {
    'GET /api/director/project': () => ({ project: p }),
    'GET /api/generation': () => ({ presets: [{ id: 'unpriced-edit', title: 'Unpriced edit', task: 'transform-video', inputs: { sourceVideo: {} }, parameters: {}, pricing: null }], definitions: [] }),
    'GET /api/director/refgen': () => ({ presets: [{ id: 'flux-2-pro', title: 'FLUX 2 Pro', maxRefs: 7, pricing: { usdPerImage: 0.03 } }] }),
    'POST /api/director/render-blockout': b => (!headless ? [409, { error: 'Headless rendering is off', code: 'headless-unavailable' }] : b.force || !p.shots.find(s => s.id === b.shotId).render ? { asset: { id: 'a1', width: 1280, height: 720, fps: 24, frameCount: 120, duration: 5 }, previsShotId: 'ps1', project: p } : { skipped: true, previsShotId: 'ps0', asset: { id: 'a0' } }),
    'POST /api/director/frame': b => (headless ? { data: PNG.toString('base64'), mime: b.type || 'image/png', width: b.width, height: b.height } : [409, { error: 'Headless rendering is off', code: 'headless-unavailable' }]),
    'GET /api/director/asset-frame': (_, q) => (!(Number(q.get('cols')) >= 1 && Number(q.get('cols')) <= 6) ? [400, { error: 'cols must be a whole number from 1 to 6' }] : { data: JPEG.toString('base64'), mime: q.get('type'), width: 80, height: 45 }),
    'POST /api/director/refgen/prepare': b => ({ job: { id: 'r' + calls.length, fingerprint: 'fp', quote: { estimate: unpriced ? null : 0.03 * (b.count || 1) } } }),
    'POST /api/director/refgen/submit': () => (++submits === 1 ? [409, { error: 'Backend busy: 4 of 4 cloud image slots in use; retry when a job finishes', code: 'busy', retryAfterSeconds: 0 }] : { job: { status: 'submitted' } }),
    'POST /api/director/refgen/track': () => ({ job: { status: 'completed', referenceIds: ['ref-' + calls.length] } }),
    'POST /api/director/edit': b => { for (const op of b.ops) if (op.op === 'update_entity' && op.patch.sheets) p.scene.entities.find(e => e.id === op.id).sheets = op.patch.sheets; return { project: p }; },
    'POST /api/director/sheet/compose': () => ({ referenceId: 'composed-1', project: p }),
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

async function withAgent(fake, fn) {
  const base = await fake.listen();
  const agent = spawn(process.execPath, ['server/previs/agent.mjs'], { env: { ...process.env, PREVIS_URL: base, PREVIS_AGENT_POLL_MS: '20' }, stdio: ['pipe', 'pipe', 'inherit'] });
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
    assert.deepEqual(frame.body, { projectId: p.id, shotId: p.shots[1].id, t: 0, width: 1280, height: 720 });
    const prep = fake.calls.find(c => c.path === '/api/director/refgen/prepare').body;
    assert.equal(prep.target, 'shot'); assert.equal(prep.frameAt, 'start'); assert.equal(prep.aspect, '16:9'); assert.equal(prep.presetId, 'flux-2-pro');
    assert.equal(prep.guide, PNG.toString('base64'));
    const prev = p.shots[0].references.filter(x => x.role === 'frame').at(-1);
    assert.equal(prep.referenceIds.at(-1), prev.id, 'previous shot’s last still for continuity');
    assert.match(prep.prompt, /Image 1 is a grey 3D blockout of this exact frame/); assert.match(prep.prompt, /At this moment: the eagle folds its wings\./);
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
  });
});

test('batch_generate (dry run and wait) and batch_status summarise counts, spend and the last 10 events', async () => {
  const p = await fixture();
  const fake = fakePrevis(p);
  await withAgent(fake, async ({ call }) => {
    const dry = await call('previs_director_batch_generate', { projectId: p.id, steps: ['stills'], tier: 'draft', maxCostUsd: 1, dryRun: true });
    assert.equal(dry.status, 'planned'); assert.equal(dry.plan.length, 3); assert.match(dry.next, /Nothing was sent/);
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
    assert.match(text, /STUCK/); assert.match(text, /Never retry or resubmit/); assert.match(text, /previs_reconcile_generation/);
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
