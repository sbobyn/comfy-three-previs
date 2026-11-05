import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { resolveExecutable, opQuery, openHeadless, CHROMIUM_ARGS } from '../server/previs/headless.mjs';
import { renderRoutes } from '../server/previs/render-routes.mjs';

// Unit tests drive headless.mjs and render-routes.mjs with fake browsers and a fake director store.
// The integration test (PREVIS_HEADLESS_TEST=1, after pnpm build) launches real Chromium on the GPU.
const cache = '/home/u/Library/Caches/ms-playwright';
const testing = d => join(cache, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('executable: PREVIS_CHROMIUM, then the newest playwright chromium, then Chrome stable', () => {
  const files = new Set([testing('chromium-1100'), testing('chromium-1248'), testing('chromium_headless_shell-1300'), CHROME, '/opt/chromium']);
  const fs = { home: '/home/u', exists: f => files.has(f), list: () => ['chromium-1100', 'chromium_headless_shell-1300', 'chromium-1248', 'ffmpeg-1013'] };
  assert.equal(resolveExecutable({ ...fs, env: { PREVIS_CHROMIUM: '/opt/chromium' } }), '/opt/chromium');
  assert.equal(resolveExecutable({ ...fs, env: { PREVIS_CHROMIUM: '/missing' } }), null, 'an explicit path that does not exist is not silently replaced');
  assert.equal(resolveExecutable({ ...fs, env: {} }), testing('chromium-1248'));
  const legacy = join(cache, 'chromium-1200/chrome-mac/Chromium.app/Contents/MacOS/Chromium');
  assert.equal(resolveExecutable({ home: '/home/u', env: {}, exists: f => f === legacy || f === CHROME, list: () => ['chromium-1200'] }), legacy);
  assert.equal(resolveExecutable({ home: '/home/u', env: {}, exists: f => f === CHROME, list: () => { throw Error('ENOENT'); } }), CHROME);
  assert.equal(resolveExecutable({ home: '/home/u', env: {}, exists: () => false, list: () => [] }), null);
});

test('op query builder keeps only the op’s parameters and JSON-encodes objects', () => {
  assert.equal(opQuery('blockout', { project: 'p1', shot: 's1', width: 1280, height: 720, t: 3 }), 'render.html?op=blockout&project=p1&shot=s1&width=1280&height=720');
  assert.equal(opQuery('frame', { project: 'p', shot: 's', t: 1.5, width: 640, height: 360, type: 'image/png' }), 'render.html?op=frame&project=p&shot=s&t=1.5&width=640&height=360&type=image%2Fpng');
  const q = new URLSearchParams(opQuery('sheet', { project: 'p', entity: 'e', sheet: 'sh', options: { layout: 'full', name: false } }).split('?')[1]);
  assert.deepEqual(JSON.parse(q.get('options')), { layout: 'full', name: false });
  assert.equal(new URLSearchParams(opQuery('sheet', { project: 'p', entity: 'e&x=1', sheet: 's' }).split('?')[1]).get('entity'), 'e&x=1');
  assert.throws(() => opQuery('shell', {}), /Unknown render op/);
});

function fakeChromium({ renderer = 'ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version)', result = q => ({ ok: true, query: q }), delay = 0 } = {}) {
  const state = { launches: [], open: 0, maxOpen: 0, gotos: [], closed: false };
  const browser = {
    isConnected: () => !state.closed, on() {}, async close() { state.closed = true; },
    async newPage() {
      state.open++; state.maxOpen = Math.max(state.maxOpen, state.open); let url = '';
      return {
        on() {}, evaluate: async () => renderer,
        async goto(u) { url = u; state.gotos.push(u); },
        async waitForFunction() { await new Promise(r => setTimeout(r, delay)); return { jsonValue: async () => result(url.split('/').pop()) }; },
        async close() { state.open--; },
      };
    },
  };
  return { state, launcher: async () => ({ async launch(options) { state.launches.push(options); return browser; } }) };
}

test('launch uses exactly the Metal GPU args, drops the swiftshader default and reports the renderer', async () => {
  const fake = fakeChromium();
  const h = openHeadless({ port: 5999, enabled: true, executable: '/x/Chromium', launcher: fake.launcher, log: null });
  const status = await h.status();
  assert.deepEqual(fake.state.launches[0].args, ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']);
  assert.deepEqual(fake.state.launches[0].args, [...CHROMIUM_ARGS]);
  assert.deepEqual(fake.state.launches[0].ignoreDefaultArgs, ['--enable-unsafe-swiftshader']);
  assert.equal(fake.state.launches[0].executablePath, '/x/Chromium'); assert.equal(fake.state.launches[0].headless, true);
  assert.deepEqual(status, { enabled: true, executable: '/x/Chromium', pool: { size: 2, busy: 0, queued: 0 }, renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version)' });
  assert.deepEqual(await h.run(opQuery('frame', { project: 'p', shot: 's', t: 0 })), { query: 'render.html?op=frame&project=p&shot=s&t=0' });
  assert.equal(fake.state.gotos[0], 'http://127.0.0.1:5999/render.html?op=frame&project=p&shot=s&t=0');
  await h.close(); assert.equal(fake.state.closed, true); assert.equal(h.enabled, false);
});

test('software rendering is refused and disables the renderer', async () => {
  for (const renderer of ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)', null]) {
    const fake = fakeChromium({ renderer });
    const h = openHeadless({ port: 1, enabled: true, executable: '/x', launcher: fake.launcher, log: null });
    await assert.rejects(h.run('render.html?op=frame'), e => e.status === 409 && e.apiCode === 'headless-unavailable' && /software rendering/.test(e.message));
    assert.equal(fake.state.closed, true);
    const status = await h.status(); assert.equal(status.enabled, false); assert.match(status.reason, /software/);
  }
});

test('disabled, missing Chromium or missing playwright-core answer headless-unavailable', async () => {
  const off = openHeadless({ port: 1, enabled: false, executable: '/x', launcher: async () => assert.fail('must not launch'), log: null });
  await assert.rejects(off.run('render.html?op=frame'), e => e.status === 409 && e.apiCode === 'headless-unavailable' && /PREVIS_HEADLESS=1/.test(e.message));
  assert.deepEqual(await off.status(), { enabled: false, executable: '/x', pool: { size: 2, busy: 0, queued: 0 }, renderer: null, reason: 'Headless rendering is off; start the server with PREVIS_HEADLESS=1' });
  const none = openHeadless({ port: 1, enabled: true, executable: null, launcher: async () => assert.fail('must not launch'), log: null });
  assert.match((await none.status()).reason, /PREVIS_CHROMIUM/);
  const noPw = openHeadless({ port: 1, enabled: true, executable: '/x', launcher: async () => null, log: null });
  await assert.rejects(noPw.run('render.html?op=frame'), e => e.apiCode === 'headless-unavailable' && /playwright-core/.test(e.message));
  const broken = openHeadless({ port: 1, enabled: true, executable: '/x', launcher: async () => ({ launch: async () => { throw Error('spawn EACCES\nlong log'); } }), log: null });
  await assert.rejects(broken.run('render.html?op=frame'), e => e.apiCode === 'headless-unavailable' && e.message === 'Chromium failed to start: spawn EACCES');
  assert.equal(broken.enabled, true, 'a failed launch is retried on the next request');
});

test('the page pool never exceeds its size and page errors surface', async () => {
  const fake = fakeChromium({ delay: 15, result: q => (q.includes('shot=bad') ? { ok: false, error: 'Unknown shot' } : { ok: true, q }) });
  const h = openHeadless({ port: 1, enabled: true, executable: '/x', poolSize: 2, launcher: fake.launcher, log: null });
  const runs = Array.from({ length: 7 }, (_, i) => h.run(`render.html?op=frame&shot=${i}`));
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual((await h.status({ probe: false })).pool, { size: 2, busy: 2, queued: 5 });
  assert.deepEqual((await Promise.all(runs)).map(r => r.q), runs.map((_, i) => `render.html?op=frame&shot=${i}`));
  assert.equal(fake.state.maxOpen, 2, 'one probe page, then at most two render pages at a time');
  assert.equal(fake.state.launches.length, 1, 'one browser for the whole pool');
  await assert.rejects(h.run('render.html?op=frame&shot=bad'), e => e.status === 400 && e.message === 'Unknown shot');
  assert.deepEqual((await h.status()).pool, { size: 2, busy: 0, queued: 0 });
});

function fakeDirector() {
  const asset = { id: 'a1', kind: 'camera-render', file: 'assets/a1.mp4', width: 1280, height: 720, fps: 24, frameCount: 120, duration: 5, sha256: 'abc' };
  const p = { id: 'p1', revision: 3, assets: [asset], shots: [{ id: 's1', duration: 5, render: { previsShotId: 'e1', assetId: 'a1', frameCount: 120, duration: 5, width: 1280, height: 720 } }, { id: 's2', duration: 2, render: null }],
    scene: { entities: [{ id: 'o1', sheets: [{ id: 'sh1', slots: [] }] }] } };
  return { get: async id => { if (id !== 'p1') { const e = Error('Unknown project'); e.status = 404; throw e; } return structuredClone(p); } };
}
function fakeHeadless(run, enabled = true) { const calls = []; return { calls, enabled, reason: enabled ? null : 'off', status: async () => ({ enabled }), run: async q => { calls.push(q); if (!enabled) { const e = Error('off'); e.status = 409; e.apiCode = 'headless-unavailable'; throw e; } return run(q); } }; }
const call = (r, path, input, method = 'POST') => r.route(method, path, input);

test('render-blockout skips rendered shots unless forced, and needs the renderer otherwise', async () => {
  const off = fakeHeadless(() => assert.fail('no render'), false), r = renderRoutes({ director: fakeDirector(), headless: off });
  assert.deepEqual(await call(r, '/api/director/render-blockout', { projectId: 'p1', shotId: 's1' }), { skipped: true, previsShotId: 'e1', asset: { id: 'a1', width: 1280, height: 720, fps: 24, frameCount: 120, duration: 5, sha256: 'abc' } });
  assert.equal(off.calls.length, 0);
  // Over HTTP the disabled renderer answers 409 with a code; unknown shots go to the server's error handler.
  const sent = [];
  const req = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body });
  await r.serve(req(), new URL('http://h/api/director/render-blockout'), (v, s = 200) => sent.push([s, v]), async () => ({ projectId: 'p1', shotId: 's1', force: true }));
  assert.deepEqual(sent.pop(), [409, { error: 'off', code: 'headless-unavailable' }]);
  await assert.rejects(r.serve(req(), new URL('http://h/api/director/render-blockout'), () => {}, async () => ({ projectId: 'p1', shotId: 'nope' })), e => e.status === 404);
  // A blockout older than its shot is made again (it is the camera every video follows), so the renderer is needed.
  const wing = JSON.parse(await readFile(new URL('./fixtures/wingspan-project.json', import.meta.url), 'utf8'));
  const fresh = renderRoutes({ director: { get: async () => structuredClone(wing) }, headless: off });
  assert.equal((await call(fresh, '/api/director/render-blockout', { projectId: wing.id, shotId: wing.shots[0].id })).skipped, true, 'an up-to-date blockout is kept');
  wing.shots[0].duration += 1;
  await assert.rejects(call(fresh, '/api/director/render-blockout', { projectId: wing.id, shotId: wing.shots[0].id }), e => e.apiCode === 'headless-unavailable');
  await assert.rejects(r.serve({ method: 'POST', headers: {} }, new URL('http://h/api/director/frame'), () => {}, async () => ({})), e => e.status === 415);
  await r.serve({ method: 'GET', headers: {} }, new URL('http://h/api/director/headless'), (v, s = 200) => sent.push([s, v]));
  assert.deepEqual(sent.pop(), [200, { enabled: false }]);
  assert.equal(r.handles('/api/director/render-blockout') && r.handles('/api/director/sheet/compose') && !r.handles('/api/director/render'), true);
});

test('blockouts run one at a time, retry once on an engine revision race and return the C2 shape', async () => {
  let active = 0, max = 0, raced = false;
  const h = fakeHeadless(async q => {
    active++; max = Math.max(max, active); await new Promise(r => setTimeout(r, 10)); active--;
    if (q.includes('shot=s2') && !raced) { raced = true; const e = Error('Project changed. Reopen the saved browser shot.'); e.status = 400; throw e; }
    return { asset: { id: 'n1', width: 640, height: 360, fps: 24, frameCount: 48, duration: 2, sha256: 'def', provenance: { big: true } }, previsShotId: 'e9' };
  });
  const r = renderRoutes({ director: fakeDirector(), headless: h });
  const [a, b] = await Promise.all([call(r, '/api/director/render-blockout', { projectId: 'p1', shotId: 's2', width: 640, height: 360 }), call(r, '/api/director/render-blockout', { projectId: 'p1', shotId: 's1', force: true })]);
  assert.equal(max, 1);
  assert.deepEqual(a.asset, { id: 'n1', width: 640, height: 360, fps: 24, frameCount: 48, duration: 2, sha256: 'def' });
  assert.equal(a.previsShotId, 'e9'); assert.equal(a.project.id, 'p1'); assert.equal(b.asset.id, 'n1');
  assert.deepEqual(h.calls, ['render.html?op=blockout&project=p1&shot=s2&width=640&height=360', 'render.html?op=blockout&project=p1&shot=s2&width=640&height=360', 'render.html?op=blockout&project=p1&shot=s1&width=1280&height=720']);
  await assert.rejects(call(r, '/api/director/render-blockout', { projectId: 'p1', shotId: 's2', width: 99999 }), /between 16 and 3840/);
});

test('frame and sheet routes validate input and pass the op to the page', async () => {
  const h = fakeHeadless(async q => (q.includes('op=sheet') ? { referenceId: 'r1', width: 2400, height: 1100 } : { data: 'AAA', mime: 'image/png', width: 1280, height: 720 }));
  const r = renderRoutes({ director: fakeDirector(), headless: h });
  assert.deepEqual(await call(r, '/api/director/frame', { projectId: 'p1', shotId: 's1', t: 1 }), { data: 'AAA', mime: 'image/png', width: 1280, height: 720 });
  assert.equal(h.calls.pop(), 'render.html?op=frame&project=p1&shot=s1&t=1&width=1280&height=720&type=image%2Fpng');
  await assert.rejects(call(r, '/api/director/frame', { projectId: 'p1', shotId: 's1' }), /t \(seconds/);
  await assert.rejects(call(r, '/api/director/frame', { projectId: 'p1', shotId: 's1', t: 0, type: 'image/gif' }), /image\/png or image\/jpeg/);
  await assert.rejects(call(r, '/api/director/frame', { projectId: 'nope', shotId: 's1', t: 0 }), e => e.status === 404);
  const sheet = await call(r, '/api/director/sheet/compose', { projectId: 'p1', entityId: 'o1', sheetId: 'sh1', options: { layout: 'full' } });
  assert.equal(sheet.referenceId, 'r1'); assert.equal(sheet.project.id, 'p1');
  assert.equal(h.calls.pop(), 'render.html?op=sheet&project=p1&entity=o1&sheet=sh1&options=%7B%22layout%22%3A%22full%22%7D');
  await assert.rejects(call(r, '/api/director/sheet/compose', { projectId: 'p1', entityId: 'o1', sheetId: 'zz' }), e => e.status === 404 && /Unknown sheet/.test(e.message));
  await assert.rejects(call(r, '/api/director/sheet/compose', { projectId: 'p1', entityId: 'o1', sheetId: 'sh1', options: [1] }), /options must be an object/);
  await assert.rejects(call(r, '/api/director/headless', {}, 'POST'), e => e.status === 405);
});

test('the headless capture uses the workspace’s exact shot signature and the workspace delegates capture', async () => {
  const workspace = await readFile(new URL('../src/director.ts', import.meta.url), 'utf8');
  const capture = await readFile(new URL('../src/director-capture.ts', import.meta.url), 'utf8');
  const body = (src, head) => { const i = src.indexOf(head); assert.ok(i >= 0, head); return src.slice(i + head.length, src.indexOf('\n', i)); };
  assert.equal(body(capture, 'export const shotSignature = (p: DirectorProject, s: Shot) =>'), body(workspace, 'const signature = (p: DirectorProject, s: Shot) =>'));
  // The server checks staleness with the shared copy (shared/director.mjs).
  const shared = await readFile(new URL('../shared/director.mjs', import.meta.url), 'utf8');
  assert.equal(body(shared, 'export const shotSignature = (p, s) =>'), body(workspace, 'const signature = (p: DirectorProject, s: Shot) =>'));
  assert.match(workspace, /async function captureShotVideo\(s: Shot, o: CaptureOptions\) \{\n  return captureVideo\(/);
});

// ---------- Integration (real Chromium on the GPU) ----------
function decodePng(buf) {
  assert.equal(buf.subarray(1, 4).toString(), 'PNG');
  let i = 8, w = 0, hgt = 0, ch = 4; const idat = [];
  while (i < buf.length) {
    const len = buf.readUInt32BE(i), type = buf.subarray(i + 4, i + 8).toString(), data = buf.subarray(i + 8, i + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); hgt = data.readUInt32BE(4); assert.equal(data[8], 8); ch = { 2: 3, 6: 4 }[data[9]]; assert.ok(ch && data[12] === 0, 'RGB(A) 8-bit, not interlaced'); }
    if (type === 'IDAT') idat.push(data);
    i += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat)), stride = w * ch, out = Buffer.alloc(hgt * stride);
  for (let y = 0; y < hgt; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? out[y * stride + x - ch] : 0, b = y ? out[(y - 1) * stride + x] : 0, c = x >= ch && y ? out[(y - 1) * stride + x - ch] : 0;
      const p = a + b - c, pr = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      out[y * stride + x] = (row[x] + [0, a, b, (a + b) >> 1, pr][f]) & 255;
    }
  }
  return { width: w, height: hgt, ch, pixels: out };
}
function lumaVariance({ pixels, ch }) {
  let n = 0, sum = 0, sq = 0;
  for (let i = 0; i < pixels.length; i += ch * 7) { const l = 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2]; n++; sum += l; sq += l * l; }
  return sq / n - (sum / n) ** 2;
}

test('headless Chromium renders a frame and a blockout on the GPU (PREVIS_HEADLESS_TEST=1)', { skip: process.env.PREVIS_HEADLESS_TEST !== '1' && 'set PREVIS_HEADLESS_TEST=1 (after pnpm build) to launch Chromium' }, async () => {
  assert.ok(existsSync(new URL('../dist/render.html', import.meta.url)), 'run pnpm build first');
  const dir = await mkdtemp(join(tmpdir(), 'previs-headless-'));
  const port = Number(process.env.PREVIS_HEADLESS_TEST_PORT || 15362), base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), PREVIS_DATA_DIR: dir, PREVIS_AGENT: 'off', PREVIS_HEADLESS: '1' }; delete env.PREVIS_ALLOW_PAID;
  const server = spawn(process.execPath, ['server/previs/server.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { server.stdout.on('data', d => { if (String(d).includes('video-lab:')) resolve(); }); server.once('exit', c => reject(Error('server exited ' + c))); });
  const post = async (path, body) => { const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, data: await r.json() }; };
  try {
    const health = await (await fetch(base + '/api/director/headless')).json();
    assert.equal(health.enabled, true, health.reason); assert.match(health.renderer, /ANGLE/); assert.doesNotMatch(health.renderer, /SwiftShader|software/i);
    const { data: { project: p } } = await post('/api/director/projects', { template: 'street', title: 'Headless test' });
    const s = p.shots[0];
    const { status, data: frame } = await post('/api/director/frame', { projectId: p.id, shotId: s.id, t: 1 });
    assert.equal(status, 200, frame.error);
    const img = decodePng(Buffer.from(frame.data, 'base64'));
    assert.deepEqual([frame.mime, frame.width, frame.height, img.width, img.height], ['image/png', 1280, 720, 1280, 720]);
    assert.ok(lumaVariance(img) > 20, 'the frame is not blank');
    const { status: bs, data: blockout } = await post('/api/director/render-blockout', { projectId: p.id, shotId: s.id, width: 640, height: 360 });
    assert.equal(bs, 200, blockout.error);
    assert.equal(blockout.asset.frameCount, Math.min(120, Math.round(s.duration * 24)));
    assert.equal(blockout.project.shots[0].render.assetId, blockout.asset.id);
    assert.deepEqual((await post('/api/director/render-blockout', { projectId: p.id, shotId: s.id })).data.skipped, true);
  } finally { server.kill('SIGTERM'); await new Promise(r => server.once('exit', r)); }
});
