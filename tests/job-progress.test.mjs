import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createJobProgress, createProgressSocketFactory } from '../server/previs/job-progress.mjs';
import { parseBinaryFrame, parseProgressMessage, PROGRESS_LIMITS } from '../server/previs/comfy-progress-protocol.mjs';

const key = (id = 'a', projectId = 'project-a') => ({ source: 'generation', id, projectId });
const local = id => ({ backend: { kind: 'local', url: 'http://127.0.0.1:8000' }, clientId: `client-${id}`, requestId: id, dedicated: true });
const cloud = id => ({ backend: { kind: 'cloud' }, accountKey: 'account', clientId: `client-${id}`, requestId: id });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=', 'base64');
function frame(type, body = null, image = png) {
  const metadata = Buffer.from(JSON.stringify(body));
  const head = Buffer.alloc(8); head.writeUInt32BE(type); head.writeUInt32BE(type === 1 ? 2 : metadata.length, 4);
  return Buffer.concat(type === 1 ? [head, image] : [head, metadata, image]);
}
const preview = (id, image = png) => frame(4, { prompt_id: id, node_id: '3', image_type: 'image/png', ignored: 'https://private.invalid/?token=SECRET' }, image);
class Socket extends EventEmitter {
  readyState = 0; sent = []; terminated = false;
  open() { this.readyState = 1; this.emit('open'); }
  send(value, callback) { this.sent.push(JSON.parse(value)); callback?.(); }
  terminate() { this.terminated = true; this.readyState = 3; }
  json(type, data) { this.emit('message', Buffer.from(JSON.stringify({ type, data })), false); }
  binary(value) { this.emit('message', value, true); }
}
function fixture(options = {}) {
  let time = 1000, next = 0;
  const timers = new Map(), sockets = [], descriptors = [], reconciles = [], events = [];
  const hub = createJobProgress({ tickMs: 0, now: () => time, random: () => 1,
    setTimer(fn, ms) { const id = ++next; timers.set(id, { at: time + ms, fn }); return id; }, clearTimer: id => timers.delete(id),
    connect(descriptor) { const socket = new Socket(); sockets.push(socket); descriptors.push(descriptor); return socket; },
    trackNow: (...args) => { reconciles.push(args); }, ...options });
  hub.subscribe('project-a', event => events.push(event));
  return { hub, sockets, descriptors, reconciles, events, timers,
    advance(ms) { time += ms; for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.fn(); } hub.flush(); },
    async begin(id = 'a', opts = local(id), project = 'project-a') { const promise = hub.begin(key(id, project), opts); const socket = sockets.at(-1); if (!socket.readyState) socket.open(); await promise; return socket; },
  };
}

test('binary bounds, strict UTF-8, supported layouts and image headers', () => {
  assert.equal(parseBinaryFrame(preview('a')).width, 1);
  assert.equal(parseBinaryFrame(frame(1, null)).legacy, true);
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(7), Buffer.alloc(PROGRESS_LIMITS.frameBytes + 1), frame(2, {}), frame(4, { prompt_id: 'a', image_type: 'text/html' }), preview('a', Buffer.alloc(99))]) assert.equal(parseBinaryFrame(bytes), null);
  const invalid = preview('a'); invalid[8] = 0xff; assert.equal(parseBinaryFrame(invalid), null);
  const truncated = preview('a'); truncated.writeUInt32BE(4097, 4); assert.equal(parseBinaryFrame(truncated), null);
  const excessive = Buffer.from(png); excessive.writeUInt32BE(4097, 16); assert.equal(parseBinaryFrame(preview('a', excessive)), null);
  excessive.writeUInt32BE(769, 16); assert.equal(parseBinaryFrame(preview('a', excessive)), null);
  const text = Buffer.alloc(8); text.writeUInt32BE(3); text.writeUInt32BE(1, 4);
  assert.deepEqual(parseBinaryFrame(Buffer.concat([text, Buffer.from('3secret text')])), { kind: 'text' });
  assert.equal(parseBinaryFrame(Buffer.concat([text, Buffer.from([0xff])])), null);
  const jpeg = Buffer.from('ffd8ffc0000b080001000101011100ffd9', 'hex');
  const jpg = frame(1, null, jpeg); jpg.writeUInt32BE(1, 4);
  assert.equal(parseBinaryFrame(jpg).mime, 'image/jpeg');
  assert.equal(parseBinaryFrame(jpg.subarray(0, 15)), null);
});

test('JSON allowlist discards errors, URLs, provider text and identity-free reconnect state', () => {
  const raw = JSON.stringify({ type: 'execution_error', data: { prompt_id: 'a', exception_message: 'SECRET', current_inputs: { token: 'SECRET' }, traceback: ['SECRET'], node: 'https://SECRET' } });
  assert.ok(!JSON.stringify(parseProgressMessage(raw)).includes('SECRET'));
  assert.equal(parseProgressMessage('{'), null);
  assert.equal(parseProgressMessage(JSON.stringify({ type: 'executing', data: { node: '3' } })), null);
  assert.equal(parseProgressMessage(Buffer.from([0xff])), null);
});

test('dedicated local sockets isolate jobs; legacy imagery requires exact active execution', async () => {
  const f = fixture(), a = await f.begin('a'), b = await f.begin('b');
  assert.equal(f.hub.accept(key(), { promptId: 'other' }), false);
  f.hub.accept(key(), { promptId: 'a' }); f.hub.accept(key('b'), { promptId: 'b' });
  assert.equal(a.sent[0].data.supports_preview_metadata, true);
  a.binary(frame(1)); assert.equal(f.hub.live(key()).preview, null);
  a.json('executing', { node: '3' }); a.binary(frame(1)); assert.equal(f.hub.live(key()).preview, null);
  a.json('execution_start', { prompt_id: 'a' }); a.binary(frame(1));
  assert.equal(f.hub.live(key()).preview.version, 1);
  a.binary(preview('b')); b.binary(preview('a')); assert.equal(f.hub.live(key('b')).preview, null);
  assert.equal(f.hub.preview(key('a', 'another-project'), 1), null);
  const bytes = f.hub.preview(key(), 1).bytes; bytes.fill(0);
  assert.deepEqual(f.hub.preview(key(), 1).bytes, png);
  f.hub.stop(); assert.equal(f.hub.stats().connections, 0);
});

test('legacy shared project identity uses one socket and never admits type1', async () => {
  const f = fixture(), opts = { ...local('a'), clientId: 'project-a', dedicated: false };
  const a = await f.begin('a', opts); await f.begin('b', { ...opts, requestId: 'b' });
  assert.equal(f.sockets.length, 1);
  f.hub.accept(key(), { promptId: 'a' }); f.hub.accept(key('b'), { promptId: 'b' });
  a.json('execution_start', { prompt_id: 'a' }); a.binary(frame(1));
  assert.equal(f.hub.live(key()).preview, null); a.binary(preview('b'));
  assert.equal(f.hub.live(key('b')).preview.version, 1); f.hub.stop();
});

test('Cloud shares account socket across projects, buffers sanitized JSON, drops all unattributed binary', async () => {
  const f = fixture(), socket = await f.begin('a', cloud('a'));
  await f.begin('b', cloud('b'), 'project-b'); assert.equal(f.sockets.length, 1);
  socket.binary(preview('accepted-a')); socket.binary(frame(1));
  socket.json('progress', { prompt_id: 'accepted-a', node: '3', value: 2, max: 10 });
  f.hub.accept(key(), { promptId: 'accepted-a' }); f.hub.accept(key('b', 'project-b'), { promptId: 'accepted-b' });
  assert.equal(f.hub.live(key()).node.value, 2); assert.equal(f.hub.live(key()).preview, null);
  socket.binary(preview('unowned')); socket.binary(frame(1)); socket.binary(preview('accepted-b')); f.hub.flush();
  assert.equal(f.hub.live(key()).preview, null);
  assert.equal(f.hub.live(key('b', 'project-b')).preview.version, 1);
  assert.ok(f.events.every(event => event.projectId === 'project-a'));
  assert.ok(!JSON.stringify(f.events).includes('SECRET'));
  f.hub.stop();
});

test('JSON acceptance buffer expires at 2 seconds and retains at most 64 events', async () => {
  const f = fixture(), socket = await f.begin('a', cloud('a'));
  for (let i = 0; i < 100; i++) socket.json('progress', { prompt_id: 'cloud-id', node: '3', value: i, max: 100 });
  assert.equal(f.hub.stats().bufferedEvents, 64); f.advance(2001);
  f.hub.accept(key(), { promptId: 'cloud-id' }); assert.equal(f.hub.live(key()).node, null); f.hub.stop();
});

test('latest work coalesces to 4Hz; progress_state only supersedes same-node scalar; no job percent', async () => {
  const f = fixture(), socket = await f.begin(); f.hub.accept(key(), { promptId: 'a' }); f.hub.flush(); f.events.length = 0;
  for (let i = 0; i < 100; i++) socket.json('progress', { prompt_id: 'a', node: '3', value: i, max: 100 });
  f.advance(249); assert.equal(f.events.length, 0); f.advance(1); assert.equal(f.events.length, 1);
  assert.equal(f.events[0].live.node.value, 99); assert.equal(f.events[0].live.node.unit, 'work');
  socket.json('progress_state', { prompt_id: 'a', nodes: { '3': { state: 'running', value: 8, max: 10 } } });
  socket.json('progress', { prompt_id: 'a', node: '3', value: 1, max: 10 }); assert.equal(f.hub.live(key()).node.value, 8);
  socket.json('progress', { prompt_id: 'a', node: '4', value: 1, max: 10 }); assert.equal(f.hub.live(key()).node.id, '4'); f.hub.stop();
});

test('preview throttle, exact versions, two-version retention, global LRU, terminal grace', async () => {
  const f = fixture({ cacheBytes: png.length * 2 }), a = await f.begin(); f.hub.accept(key(), { promptId: 'a' });
  a.binary(preview('a'));
  for (let i = 0; i < 1000; i++) a.binary(preview('a'));
  assert.equal(f.hub.stats().versions, 1); assert.equal(f.hub.stats().pendingBytes, png.length);
  f.advance(999); assert.equal(f.hub.live(key()).preview.version, 1); f.advance(1);
  assert.equal(f.hub.live(key()).preview.version, 2);
  a.binary(preview('a')); f.advance(1000); assert.equal(f.hub.preview(key(), 1), null);
  assert.ok(f.hub.preview(key(), 2)); assert.ok(f.hub.preview(key(), 3));
  const b = await f.begin('b'); f.hub.accept(key('b'), { promptId: 'b' }); b.binary(preview('b'));
  assert.ok(f.hub.stats().cacheBytes <= png.length * 2); assert.equal(f.hub.preview(key(), 2), null);
  f.hub.reconcile({ jobs: [{ ...key(), status: 'completed' }] }); f.advance(60000);
  assert.equal(f.hub.preview(key(), 3), null); assert.equal(f.hub.live(key()), null); f.hub.stop();
});

test('socket success means collecting only; tracker owns final state and uncertain overlay', async () => {
  const f = fixture(), socket = await f.begin(); f.hub.accept(key(), { promptId: 'a' });
  f.hub.reconcile({ jobs: [{ ...key(), status: 'uncertain' }] });
  socket.json('execution_success', { prompt_id: 'a' }); socket.json('execution_success', { prompt_id: 'a' });
  assert.equal(f.hub.live(key()).phase, 'uncertain'); assert.deepEqual(f.reconciles, [['generation', 'a']]);
  const snapshot = { jobs: [{ ...key(), status: 'collecting', results: [] }], limits: { max: 1 } };
  f.hub.reconcile(snapshot); assert.equal(f.hub.enrich(snapshot).jobs[0].status, 'collecting'); assert.equal(f.hub.live(key()).phase, 'collecting');
  f.hub.reconcile({ jobs: [{ ...key(), status: 'completed', results: ['imported'] }] });
  socket.json('progress', { prompt_id: 'a', node: '3', value: 1, max: 10 });
  f.hub.reconcile({ jobs: [{ ...key(), status: 'uncertain' }] });
  assert.equal(f.hub.live(key()).phase, 'done'); assert.ok(socket.terminated); f.hub.stop();
});

test('errors reconcile once without raw error payload; callbacks cannot throw into dispatch', async () => {
  const f = fixture({ trackNow: async () => { throw Error('SECRET'); } });
  f.hub.subscribe('project-a', () => { throw Error('consumer'); });
  f.hub.subscribe('project-a', async () => { throw Error('consumer'); });
  const socket = await f.begin(); f.hub.accept(key(), { promptId: 'a' });
  socket.json('execution_error', { prompt_id: 'a', exception_message: 'SECRET', traceback: ['SECRET'], current_inputs: { token: 'SECRET' } });
  f.hub.flush(); await Promise.resolve(); assert.ok(!JSON.stringify(f.events).includes('SECRET'));
  assert.notEqual(f.hub.live(key()).phase, 'failed'); assert.equal(f.hub.accept(null, null), false); f.hub.stop();
});

test('disconnect before acceptance, capped reconnect, stable client identity, restart never guesses acceptance', async () => {
  const f = fixture(); const opened = f.hub.begin(key(), local('a'));
  f.sockets[0].emit('error', Error('wss://secret')); assert.equal(await opened, false);
  f.advance(500); assert.equal(f.sockets.length, 2); f.sockets[1].open();
  assert.equal(f.descriptors[0].clientId, f.descriptors[1].clientId);
  assert.equal(f.hub.live(key()).phase, 'submitting');
  f.sockets[1].binary(preview('a')); assert.equal(f.hub.live(key()).preview, null);
  f.hub.reconcile({ jobs: [{ ...key(), status: 'uncertain' }] }); assert.equal(f.hub.live(key()).phase, 'uncertain');
  assert.deepEqual(f.reconciles, []);
  for (let i = 0; i < 12; i++) { f.sockets.at(-1).emit('close'); const delay = [...f.timers.values()][0]; assert.ok(delay); f.advance(30000); f.sockets.at(-1).open(); }
  f.hub.stop(); assert.equal(f.timers.size, 0);
});

test('reconnect invalidates legacy active execution; disposal removes listeners and cancels timers', async () => {
  const f = fixture(), socket = await f.begin(); f.hub.accept(key(), { promptId: 'a' });
  socket.json('execution_start', { prompt_id: 'a' }); socket.emit('close');
  assert.equal(f.hub.live(key()).connection, 'stale'); f.advance(500);
  const next = f.sockets[1]; next.open(); next.binary(frame(1)); assert.equal(f.hub.live(key()).preview, null);
  assert.equal(socket.listenerCount('message'), 0); f.hub.close(key()); assert.ok(next.terminated);
  f.advance(30000); assert.equal(f.sockets.length, 2); f.hub.stop();
});

test('unsupported WS and throwing send resolve fallback within observer deadline', async () => {
  const f = fixture({ connect() { throw Error('SECRET'); } });
  assert.equal(await f.hub.begin(key(), local('a')), false); assert.equal(f.hub.live(key()).connection, 'stale'); f.hub.stop();
  const g = fixture(); const promise = g.hub.begin(key(), local('a'));
  g.sockets[0].send = () => { throw Error('send'); }; g.sockets[0].open(); assert.equal(await promise, false); g.hub.stop();
  const h = fixture(); const timeout = h.hub.begin(key(), local('a')); h.advance(2000); assert.equal(await timeout, false); h.hub.stop();
});

test('loopback fake HTTP/WS proves observation opens before POST with stable client and request IDs', async t => {
  const require = createRequire(new URL('../package.json', import.meta.url));
  const { WebSocket, WebSocketServer } = require('ws');
  const order = [], clients = new Map(); let posts = 0;
  const server = createServer(async (req, res) => {
    assert.equal(req.url, '/prompt'); assert.equal(req.method, 'POST'); posts++;
    const parts = []; for await (const part of req) parts.push(part);
    const input = JSON.parse(Buffer.concat(parts)); order.push('post');
    assert.ok(['a', 'lost'].includes(input.prompt_id)); assert.equal(input.client_id, `client-${input.prompt_id}`);
    clients.get(input.client_id).send(JSON.stringify({ type: 'progress', data: { prompt_id: input.prompt_id, node: '3', value: 2, max: 5 } }));
    if (input.prompt_id === 'lost') { req.socket.destroy(); return; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ prompt_id: input.prompt_id }));
  });
  const wss = new WebSocketServer({ server, maxPayload: 2 * 1024 * 1024 });
  wss.on('connection', (socket, req) => { order.push('open'); clients.set(new URL(req.url, 'http://local').searchParams.get('clientId'), socket); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const hub = createJobProgress({ connect: createProgressSocketFactory({ WebSocket }) });
  t.after(async () => { hub.stop(); for (const socket of wss.clients) socket.terminate(); await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve)); });
  const opts = { ...local('a'), backend: { kind: 'local', url } };
  assert.equal(await hub.begin(key(), opts), true);
  // The fake dispatcher belongs to this test, never the telemetry module.
  const response = await fetch(`${url}/prompt`, { method: 'POST', body: JSON.stringify({ prompt_id: opts.requestId, client_id: opts.clientId, prompt: {} }) });
  const accepted = await response.json(); hub.accept(key(), { promptId: accepted.prompt_id });
  assert.deepEqual(order, ['open', 'post']); assert.equal(posts, 1);
  hub.reconcile({ jobs: [{ ...key(), status: 'uncertain' }] });
  assert.equal(hub.live(key()).phase, 'uncertain'); assert.equal(posts, 1);
  await hub.begin(key('lost'), { ...local('lost'), backend: { kind: 'local', url } });
  await assert.rejects(fetch(`${url}/prompt`, { method: 'POST', body: JSON.stringify({ prompt_id: 'lost', client_id: 'client-lost', prompt: {} }) }));
  hub.reconcile({ jobs: [{ ...key('lost'), status: 'uncertain' }] });
  assert.equal(hub.live(key('lost')).phase, 'uncertain'); assert.equal(hub.live(key('lost')).node, null);
  assert.equal(posts, 2, 'one POST per explicit test dispatch; observer never resubmits lost acceptance');
});


test('acceptance buffering uses a rolling window even after long uploads', async () => {
  const f = fixture(), socket = await f.begin('a', cloud('a'));
  f.hub.phase(key(), 'uploading'); f.advance(120000); f.hub.phase(key(), 'submitting');
  socket.json('progress', { prompt_id: 'accepted', node: '3', value: 4, max: 10 });
  f.hub.accept(key(), { promptId: 'accepted' }); assert.equal(f.hub.live(key()).node.value, 4); f.hub.stop();
});

test('resource caps and project unsubscribe bound consumers; unknown rows do not gain telemetry', async () => {
  const f = fixture({ maxJobs: 2, maxListeners: 2 }), socket = await f.begin();
  const unsubscribe = f.hub.subscribe('project-b', () => {});
  f.hub.subscribe('project-c', () => {}); assert.equal(f.hub.stats().listeners, 2);
  unsubscribe(); assert.equal(f.hub.stats().listeners, 1);
  await f.begin('b'); assert.equal(await f.hub.begin(key('c'), local('c')), false);
  assert.equal(f.hub.stats().jobs, 2);
  const row = { ...key('unknown'), status: 'running' };
  assert.deepEqual(f.hub.enrich({ jobs: [row] }), { jobs: [row] });
  f.hub.accept(key(), { promptId: 'a' }); socket.binary(preview('a'));
  f.hub.stop(); assert.deepEqual(f.hub.stats(), { jobs: 0, connections: 0, listeners: 0, cacheBytes: 0, versions: 0, pendingBytes: 0, bufferedEvents: 0 });
});

test('Cloud socket factory is server-only, fixed-host, credential scoped and bounded', () => {
  const captured = [];
  class FakeWebSocket { constructor(url, options) { captured.push({ url: String(url), options }); } }
  const connect = createProgressSocketFactory({ WebSocket: FakeWebSocket, cloudCredential: account => account === 'account' ? 'test-credential' : null });
  connect({ kind: 'cloud', accountKey: 'account', clientId: 'client', url: 'https://attacker.invalid' });
  const url = new URL(captured[0].url);
  assert.equal(url.origin, 'wss://cloud.comfy.org'); assert.equal(url.searchParams.get('token'), 'test-credential');
  assert.equal(captured[0].options.followRedirects, false); assert.equal(captured[0].options.maxPayload, PROGRESS_LIMITS.frameBytes);
  assert.throws(() => connect({ kind: 'cloud', accountKey: 'missing' }), /unavailable/);
});

test('many jobs and frames share the global budget including throttled pending frames', async () => {
  const budget = png.length * 4, f = fixture({ cacheBytes: budget });
  for (let i = 0; i < 12; i++) {
    const id = `job-${i}`, socket = await f.begin(id); f.hub.accept(key(id), { promptId: id });
    for (let n = 0; n < 20; n++) {
      socket.binary(preview(id)); const stats = f.hub.stats();
      assert.ok(stats.cacheBytes + stats.pendingBytes <= budget);
    }
  }
  f.advance(1000); assert.ok(f.hub.stats().cacheBytes + f.hub.stats().pendingBytes <= budget); f.hub.stop();
});

test('exact retained versions are not reused when a job is closed and reattached', async () => {
  const f = fixture(), first = await f.begin(); f.hub.accept(key(), { promptId: 'a' }); first.binary(preview('a'));
  const old = f.hub.live(key()).preview.version; f.hub.close(key());
  const second = await f.begin(); f.hub.accept(key(), { promptId: 'a' }); second.binary(preview('a'));
  assert.ok(f.hub.live(key()).preview.version > old); assert.equal(f.hub.preview(key(), old), null); f.hub.stop();
});
