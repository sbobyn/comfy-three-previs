import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../package.json', import.meta.url));
const { resolveExecutable } = await import('../server/previs/headless.mjs');
const chrome = (() => { try { require.resolve('playwright-core'); return resolveExecutable(); } catch { return null; } })();
const ts = require('typescript');
const source = readFileSync(new URL('../src/director-progress.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { createProgressClient, acquireProgress, progressText, previewURL, mountProgressView, progressSlot } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
class Doc extends EventTarget { hidden = false; setHidden(value) { this.hidden = value; this.dispatchEvent(new Event('visibilitychange')); } }
class Source extends EventTarget { closed = false; close() { this.closed = true; } send(type, value) { this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(value) })); } }
const job = (id = 'j', projectId = 'p') => ({ source: 'generation', id, projectId, label: 'Shot', status: 'running', live: { phase: 'running', node: null, preview: null } });
const envelope = (seq, extra = {}) => ({ v: 1, epoch: 'e', seq, projectId: 'p', at: '2026-10-30', ...extra });
const snap = (seq, jobs = [job()]) => envelope(seq, { jobs, limits: { local: {} }, tracker: { running: true } });
function fixture() { const doc = new Doc(), sources = []; let polls = 0;
  const options = { document: doc, eventSource: () => { const s = new Source(); sources.push(s); return s; }, poll: async () => { polls++; return { jobs: [job()], limits: {}, tracker: {} }; } };
  const client = createProgressClient('p', options); client.subscribe(() => {});
  return { doc, sources, client, options, polls: () => polls };
}
test('snapshot replaces map; full row replaces; duplicate/foreign/version events ignored', () => {
  const f = fixture(), s = f.sources[0]; s.send('snapshot', snap(1, [job(), job('foreign', 'q')])); assert.equal(f.client.snapshot().jobs.length, 1);
  s.send('job', envelope(2, { job: { ...job(), status: 'completed' } }));
  s.send('job', envelope(1, { job: job() })); s.send('job', envelope(3, { projectId: 'q', job: job() })); s.send('job', envelope(3, { v: 2, job: job() }));
  assert.equal(f.client.snapshot().jobs[0].status, 'completed');
  s.send('snapshot', snap(4, [job('new')])); assert.deepEqual(f.client.snapshot().jobs.map(j => j.id), ['new']);
  s.send('remove', envelope(5, { source: 'generation', id: 'new' })); assert.equal(f.client.snapshot().jobs.length, 0); f.client.dispose();
});
test('epoch mismatch resnapshots and discards stale source callbacks', () => {
  const f = fixture(), s = f.sources[0]; s.send('snapshot', snap(9)); s.send('job', envelope(1, { epoch: 'restart', job: job() }));
  assert.equal(s.closed, true); assert.equal(f.sources.length, 2);
  s.send('snapshot', snap(100, [])); assert.equal(f.client.snapshot().jobs.length, 1);
  f.sources[1].send('snapshot', { ...snap(1, []), epoch: 'restart' }); assert.equal(f.client.snapshot().jobs.length, 0); f.client.dispose();
});
test('one shared per-project client, keyed subscription and independent project teardown', () => {
  const f = fixture(); f.client.dispose();
  const a = acquireProgress('p', f.options), b = acquireProgress('p', f.options), other = acquireProgress('q', f.options);
  assert.equal(a.client, b.client); assert.notEqual(a.client, other.client);
  let seen; const off = a.client.subscribeJob('generation', 'j', row => { seen = row; }); b.client.subscribe(() => {});
  assert.equal(f.sources.length, 2); f.sources[1].send('snapshot', snap(1)); assert.equal(seen.id, 'j');
  off(); a.release(); assert.equal(f.sources[1].closed, false); b.release(); assert.equal(f.sources[1].closed, true); other.release();
});
test('hidden closes SSE, visible resnapshots, failed stream polls without another SSE', async () => {
  const f = fixture(); f.doc.setHidden(true); assert.equal(f.sources[0].closed, true); assert.equal(f.polls(), 0);
  f.doc.setHidden(false); assert.equal(f.sources.length, 2); f.sources[1].onerror(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.sources[1].closed, true); assert.equal(f.polls(), 1); assert.equal(f.client.connection(), 'polling'); f.client.dispose();
});
test('hidden aborts in-flight fallback; late polling cannot overwrite resumed snapshot', async () => {
  const doc = new Doc(); let resolve, signal;
  const client = createProgressClient('p', { document: doc, eventSource: null, poll: (_, s) => { signal = s; return new Promise(r => { resolve = r; }); } });
  client.subscribe(() => {}); doc.setHidden(true); assert.equal(signal.aborted, true);
  resolve({ jobs: [job()], limits: {}, tracker: {} }); await Promise.resolve(); assert.equal(client.snapshot().jobs.length, 0); client.dispose();
});
test('telemetry never claims final success; unknown and terminal states remain authoritative', () => {
  assert.equal(progressText({ ...job(), live: { phase: 'done' } }), 'Saving results');
  assert.equal(progressText({ ...job(), status: 'uncertain', live: { phase: 'done' } }), 'Outcome unknown. Checking this request');
  assert.equal(progressText({ ...job(), status: 'completed' }), 'Ready');
  assert.equal(progressText({ ...job(), status: 'failed' }), 'Generation failed');
  assert.equal(previewURL('p', job(), { version: 2, url: 'https://upstream.invalid' }), null);
});
// Minimal DOM fixture verifies stable identities, attributes and keyboard focus.
class Element {
  children = []; attrs = {}; hidden = false; textContent = ''; parentElement = null;
  constructor(doc, tag) { this.ownerDocument = doc; this.tagName = tag; }
  setAttribute(k, v) { this.attrs[k] = v; }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(n => n !== this); }
  focus() { this.ownerDocument.activeElement = this; }
}
test('keyed view preserves focused sibling and root identity; numeric rail only for measured running work', () => {
  const f = fixture(); f.doc.createElement = tag => new Element(f.doc, tag);
  const host = new Element(f.doc, 'host'), button = new Element(f.doc, 'button'); host.append(button); button.focus();
  const dispose = mountProgressView(host, f.client, 'generation', 'j', 'Shot'); const root = host.children[1], rail = root.children[4];
  f.sources[0].send('snapshot', snap(1)); assert.equal(rail.hidden, true);
  f.sources[0].send('job', envelope(2, { job: { ...job(), live: { phase: 'running', node: { label: 'Sampler', value: 3, max: 10, unit: 'step' } } } }));
  assert.equal(rail.hidden, false); assert.equal(rail.value, 3); assert.equal(rail.max, 10); assert.equal(f.doc.activeElement, button); assert.equal(host.children[1], root);
  f.sources[0].send('job', envelope(3, { job: { ...job(), status: 'uncertain' } })); assert.equal(rail.hidden, true); dispose(); assert.equal(host.children.length, 1); f.client.dispose();
});
test('stylesheet supplies reduced-motion override and bounded responsive media', () => {
  const css = readFileSync(new URL('../src/director-progress.css', import.meta.url), 'utf8');
  assert.match(css, /prefers-reduced-motion: reduce/); assert.match(css, /animation: none !important/); assert.match(css, /aspect-ratio:/); assert.match(css, /min-width: 0/);
});

test('real browser fixture: 390/768/1440 widths, focus, reduced motion, decoded preview and expired version', { skip: !chrome && 'no local Chromium/Chrome or playwright-core' }, async () => {
  const { chromium } = require('playwright-core');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'previs-progress-'));
  const browser = await chromium.launchPersistentContext(`${root}/profile`, { executablePath: chrome, headless: true,
    env: { ...process.env, TMPDIR: root }, args: ['--disable-background-networking'] });
  try {
    const page = await browser.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => route.abort());
    await page.setContent('<main><button id="selected">Selected cut</button><div id="host"></div></main>');
    await page.addStyleTag({ content: readFileSync(new URL('../src/director-progress.css', import.meta.url), 'utf8') });
    await page.evaluate(async code => {
      const mod = await import(`data:text/javascript;base64,${code}`);
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 2;
      const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      window.fetch = async url => String(url).endsWith('version=2') ? new Response(null, { status: 404 }) : new Response(png, { headers: { 'Content-Type': 'image/png' } });
      window.send = null;
      const client = { connection: () => 'live', subscribeJob: (_, __, fn) => { window.send = fn; return () => {}; } };
      window.disposeView = mod.mountProgressView(document.querySelector('#host'), client, 'generation', 'j', 'Shot');
      window.makeJob = version => ({ source: 'generation', id: 'j', projectId: 'p', status: 'running', label: 'Shot', live: { phase: 'running', node: null,
        preview: { version, url: `/api/jobs/generation/j/preview?projectId=p&version=${version}` } } });
      document.querySelector('#selected').focus(); window.send(window.makeJob(1));
    }, Buffer.from(code).toString('base64'));
    await page.waitForSelector('.dp-media img');
    assert.equal(await page.locator('.dp-caption').textContent(), 'Intermediate preview');
    const before = await page.locator('.dp-media img').getAttribute('src');
    await page.evaluate(() => window.send(window.makeJob(2)));
    assert.equal(await page.locator('.dp-media img').getAttribute('src'), before);
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.equal(await page.evaluate(() => document.activeElement.id), 'selected');
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('.dp-media img').evaluate(el => getComputedStyle(el).animationName), 'none');
    await page.evaluate(() => window.disposeView()); assert.equal(await page.locator('.director-progress').count(), 0); assert.deepEqual(errors, []);
  } finally { await browser.close(); await rm(root, { recursive: true, force: true }); }
});

test('fallback schedules 4s active / 20s idle, never overlaps, and pauses while hidden', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const doc = new Doc(); let polls = 0, active = true;
  const client = createProgressClient('p', { document: doc, eventSource: null, poll: async () => {
    polls++; return { jobs: active ? [job()] : [], limits: {}, tracker: {} };
  } });
  client.subscribe(() => {}); await Promise.resolve();
  t.mock.timers.tick(3999); assert.equal(polls, 1);
  active = false; t.mock.timers.tick(1); await Promise.resolve(); assert.equal(polls, 2);
  t.mock.timers.tick(19999); assert.equal(polls, 2); t.mock.timers.tick(1); await Promise.resolve(); assert.equal(polls, 3);
  doc.setHidden(true); t.mock.timers.tick(60000); assert.equal(polls, 3); client.dispose();
});

test('observed sampling wins over a stored queued status the tracker has not refreshed', () => {
  // A video job is persisted as 'queued' at acceptance; the per-job socket already reports running node work.
  assert.equal(progressText({ ...job(), status: 'queued', live: { phase: 'running', node: { label: 'KSampler', value: 3, max: 20 } } }), 'Generating');
  assert.equal(progressText({ ...job(), status: 'queued', live: { phase: 'submitting' } }), 'Waiting for a worker');
  assert.equal(progressText({ ...job(), status: 'queued', live: null }), 'Waiting for a worker');
  assert.equal(progressText({ ...job(), status: 'running', live: { phase: 'queued' } }), 'Waiting for a worker');
});

test('a keyed slot closed within its first tick is disposed on that tick, not after the 10 s grace', async t => {
  const saved = { document: globalThis.document, EventSource: globalThis.EventSource, fetch: globalThis.fetch };
  const doc = new Doc(); doc.createElement = tag => { const el = new Element(doc, tag); el.style = { setProperty() {} }; return el; };
  let polls = 0;
  Object.assign(globalThis, { document: doc, EventSource: undefined, fetch: async () => { polls++; return { ok: true, json: async () => ({ jobs: [], limits: {}, tracker: {} }) }; } });
  t.after(() => Object.assign(globalThis, saved));
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const host = new Element(doc, 'dialog'); host.isConnected = true;
  const connected = el => Object.defineProperty(el, 'isConnected', { configurable: true, get: () => host.children.includes(el) });
  const a = progressSlot('p', 'generation', 'v3', 'Shot 01 video', 'quote'); connected(a); host.append(a);
  await Promise.resolve(); // the host inserted it synchronously
  assert.equal(progressSlot('p', 'generation', 'v3', 'Shot 01 video', 'quote'), a, 'reused while mounted');
  a.remove(); // the dialog closed before the first 2 s check
  t.mock.timers.tick(2000);
  assert.equal(a.children.length, 0, 'view detached on the first tick');
  const b = progressSlot('p', 'generation', 'v3', 'Shot 01 video', 'quote'); connected(b);
  assert.notEqual(b, a, 'a reopened surface gets a fresh view');
  // A slot built for a host that is not inserted yet keeps the grace period.
  await Promise.resolve(); t.mock.timers.tick(4000); assert.equal(b.children.length, 1);
  t.mock.timers.tick(8000); assert.equal(b.children.length, 0);
  assert.ok(polls >= 1);
});

test('Cut batch reloads jobs right after submit so the row shows the running version', async () => {
  const { runInNewContext } = await import('node:vm');
  const seq = readFileSync(new URL('../src/director-sequence.ts', import.meta.url), 'utf8');
  const a = seq.indexOf('  async function runBatch('), b = seq.indexOf('\n  function drawBoard()', a);
  const events = [], shot = { id: 's1', title: 'Run', render: {} };
  const ctx = {
    P: () => ({ id: 'p', shots: [shot] }), fresh: () => true, no: () => '01', DONE: ['completed', 'failed', 'uncertain', 'closed', 'invalidated', 'error'],
    modelSel: { value: 'wan' }, busy: false, quoted: [], batch: { replaceChildren() {} }, ctx: { apply() {} },
    h: (tag, attrs = {}, ...c) => ({ tag, ...attrs, textContent: c.join(''), className: attrs.class || '', append() {} }),
    bindAndQuote: async () => ({ job: { validation: { compatible: true }, fingerprint: 'f' }, request: { requestId: 'r' }, est: 0 }),
    api: async path => { events.push(path.startsWith('generation/') ? path : 'project'); return path === 'generation/submit' ? { job: { id: 'r', status: 'queued' } } : path === 'generation/track' ? { job: { id: 'r', status: 'completed' } } : {}; },
    loadGen: async () => { events.push('loadGen'); }, draw: () => { events.push('draw'); }, sleep: async () => {}, Date, Math, Number, Error,
  };
  runInNewContext(ts.transpileModule(seq.slice(a, b) + '\nrun = runBatch;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, ctx);
  await ctx.run({ title: 'Wan' }, 'wan', [{ shot, est: 0, ok: true }], 1);
  const submitted = events.indexOf('generation/submit'), tracked = events.indexOf('generation/track');
  assert.ok(submitted >= 0 && tracked > submitted);
  assert.deepEqual(events.slice(submitted + 1, submitted + 3), ['loadGen', 'draw'], events.join(' '));
  assert.equal(events.filter(e => e === 'generation/submit').length, 1, 'dispatches once');
});

