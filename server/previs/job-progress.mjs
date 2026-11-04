import { parseBinaryFrame, parseProgressMessage, promptId, PROGRESS_LIMITS } from './comfy-progress-protocol.mjs';

const keyOf = key => `${key.source}:${key.id}`;
const validKey = key => key && ['generation', 'refgen'].includes(key.source) && promptId(key.id) && promptId(key.projectId);
const terminal = new Set(['completed', 'failed', 'closed', 'cancelled', 'orphaned']);
const ignore = () => {};
function safely(fn, fallback = false) {
  return (...args) => { try { const result = fn(...args); if (result?.then) return Promise.resolve(result).catch(() => fallback); return result; } catch { return fallback; } };
}

/** Only the server coordinator supplies these descriptors, never an HTTP request body.
 * Inject the already-installed ws constructor. No credentials leave this closure.
 * Cloud accountKey must identify the actual credential/account, not a project/backend label.
 */
export function createProgressSocketFactory({ WebSocket, cloudCredential = () => process.env.COMFY_CLOUD_API_KEY }) {
  return descriptor => {
    let url;
    if (descriptor.kind === 'cloud') {
      const credential = cloudCredential(descriptor.accountKey);
      if (!credential) throw Error('Live telemetry unavailable');
      url = new URL('wss://cloud.comfy.org/ws');
      url.searchParams.set('clientId', descriptor.clientId);
      url.searchParams.set('token', credential);
    } else {
      url = new URL(descriptor.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('Live telemetry unavailable');
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.pathname = '/ws'; url.searchParams.set('clientId', descriptor.clientId);
    }
    return new WebSocket(url, { maxPayload: PROGRESS_LIMITS.frameBytes, handshakeTimeout: 2000, followRedirects: false });
  };
}

/** Ephemeral, bounded observer. No submit, HTTP poll, import, persistence or logging capability.
 * connect(descriptor) returns a Node ws-compatible EventEmitter synchronously.
 * begin() resolves true on open, false after failure/2s; dispatch must proceed either way.
 * All public methods and injected callbacks are nonthrowing, including async rejections.
 */
export function createJobProgress({ connect, trackNow = ignore, now = Date.now, random = Math.random,
  setTimer = setTimeout, clearTimer = clearTimeout, cacheBytes = 16 * 1024 * 1024,
  maxJobs = 256, maxListeners = 256, tickMs = 50 } = {}) {
  const jobs = new Map(), connections = new Map(), listeners = new Map(), cache = new Map();
  let stopped = false, timer = null, usedBytes = 0, previewVersion = 0;
  const iso = () => new Date(now()).toISOString();
  const lookup = key => validKey(key) && jobs.get(keyOf(key))?.key.projectId === key.projectId ? jobs.get(keyOf(key)) : null;
  const safeTrack = safely(trackNow);
  const schedule = (fn, ms) => { const t = setTimer(safely(fn), ms); t?.unref?.(); return t; };
  function emit(job, type) {
    const value = { type, ...job.key, live: liveOf(job) };
    for (const listener of listeners.get(job.key.projectId) || []) safely(listener)(structuredClone(value));
  }
  function liveOf(job) {
    return structuredClone({ ...job.live, phase: job.authority === 'uncertain' || job.authority === 'closed' ? 'uncertain' : job.live.phase });
  }
  function dirty(job) { job.dirty = true; job.live.observedAt = iso(); }
  function removeCache(id) {
    const entry = cache.get(id); if (!entry) return;
    usedBytes -= entry.bytes.length; cache.delete(id);
    if (entry.job.live.preview?.version === entry.version) { entry.job.live.preview = null; dirty(entry.job); }
  }
  function pendingBytes() { return [...jobs.values()].reduce((n, job) => n + (job.pending?.bytes.length || 0), 0); }
  function trimPreviews() {
    while (usedBytes + pendingBytes() > cacheBytes && cache.size) removeCache(cache.keys().next().value);
    for (const job of jobs.values()) {
      if (usedBytes + pendingBytes() <= cacheBytes) break;
      job.pending = null;
    }
  }
  function cacheId(job, version) { return `${keyOf(job.key)}:${version}`; }
  function publishPreview(job, preview) {
    const version = ++previewVersion; job.versions.push(version);
    const id = cacheId(job, version);
    const metadata = { version, url: `/api/jobs/${job.key.source}/${encodeURIComponent(job.key.id)}/preview?projectId=${encodeURIComponent(job.key.projectId)}&version=${version}`,
      mime: preview.mime, width: preview.width, height: preview.height, receivedAt: preview.receivedAt, nodeId: preview.nodeId };
    // Copy only bounded encoded bytes. Never store the original frame or metadata.
    cache.set(id, { job, version, bytes: preview.bytes, mime: preview.mime }); usedBytes += preview.bytes.length;
    while (job.versions.length > 2) removeCache(cacheId(job, job.versions.shift()));
    trimPreviews();
    job.live.preview = cache.has(id) ? metadata : null;
    job.lastPreview = now(); job.live.observedAt = iso(); emit(job, 'preview');
  }
  function flush() {
    const at = now();
    for (const job of jobs.values()) {
      if (job.terminalAt !== null && at - job.terminalAt >= 60000) { close(job.key); continue; }
      if (job.buffer.length) job.buffer = job.buffer.filter(event => at - event.at <= 2000);
      if (job.pending && at - job.lastPreview >= 1000 && job.terminalAt === null) {
        const preview = job.pending; job.pending = null; publishPreview(job, preview);
      }
      if (job.dirty && at - job.lastEmit >= 250) { job.dirty = false; job.lastEmit = at; emit(job, 'job'); }
    }
  }
  function loop() { if (stopped) return; flush(); timer = schedule(loop, tickMs); }
  function updateConnection(connection, state) {
    for (const job of connection.jobs) {
      job.active = false; // Fresh exact execution evidence required after every reconnect.
      job.live.connection = state; dirty(job);
    }
  }
  function finishSocket(connection) {
    const socket = connection.socket; connection.socket = null;
    if (!socket) return;
    for (const [event, fn] of connection.handlers || []) socket.off(event, fn);
    // ws may emit an asynchronous error when terminated during handshake.
    socket.on('error', ignore);
    try { socket.terminate ? socket.terminate() : socket.close(); } catch {}
  }
  function disposeConnection(connection) {
    clearTimer(connection.retry); clearTimer(connection.deadline);
    connection.ready?.(false); connection.ready = null;
    finishSocket(connection); connections.delete(connection.id);
  }
  function detach(job) {
    const connection = job.connection; job.connection = null;
    if (!connection) return;
    connection.jobs.delete(job);
    if (!connection.jobs.size) disposeConnection(connection);
  }
  function lost(connection) {
    if (stopped || connections.get(connection.id) !== connection) return;
    clearTimer(connection.deadline); connection.ready?.(false); connection.ready = null;
    finishSocket(connection); updateConnection(connection, 'stale');
    if (connection.retry) return;
    const base = Math.min(30000, 500 * 2 ** Math.min(connection.attempt++, 6));
    connection.retry = schedule(() => { connection.retry = null; open(connection); }, Math.min(30000, base * (0.5 + random() * 0.5)));
  }
  function open(connection) {
    if (stopped || !connection.jobs.size) return;
    try {
      const socket = connect(connection.descriptor); connection.socket = socket;
      const current = fn => safely((...args) => { if (connection.socket === socket) fn(...args); });
      connection.handlers = [
        ['open', current(() => {
          clearTimer(connection.deadline);
          connection.openedAt = now();
          updateConnection(connection, 'live');
          if (connection.descriptor.kind === 'local') {
            try { socket.send(JSON.stringify({ type: 'feature_flags', data: { supports_preview_metadata: true } }), error => { if (error) lost(connection); }); }
            catch { lost(connection); return; }
          }
          connection.ready?.(true); connection.ready = null;
        })],
        ['message', current((data, binary) => {
          if (now() - connection.openedAt > 10000) connection.attempt = 0;
          receive(connection, data, binary === true);
        })],
        ['error', current(() => lost(connection))], ['close', current(() => lost(connection))],
      ];
      for (const [event, fn] of connection.handlers) socket.on(event, fn);
      connection.deadline = schedule(() => lost(connection), 2000);
    } catch { lost(connection); }
  }
  function reconcileOnce(job) {
    if (job.signalled) return;
    job.signalled = true;
    safeTrack(job.key.source, job.key.id); // Existing trackNow coalesces; never forward socket outputs.
  }
  function apply(job, event) {
    if (job.terminalAt !== null) return;
    const type = event.type;
    if (job.signalled) return; // Terminal telemetry cannot be followed by a late running event.
    if (['execution_success', 'execution_error', 'execution_interrupted'].includes(type) || (type === 'executing' && event.ended)) {
      job.active = false; job.pending = null;
      if (type === 'execution_success' || event.ended) job.live.phase = 'collecting';
      reconcileOnce(job); dirty(job); return;
    }
    if (['execution_start', 'executing', 'progress', 'progress_state'].includes(type)) {
      job.active = true; job.live.phase = 'running';
    }
    if (type === 'executing' && event.nodeId) {
      job.live.node = { id: event.nodeId, label: 'Executing node', value: null, max: null, unit: null };
    }
    if (type === 'progress' && event.nodeId && !job.stateNodes.has(event.nodeId)) {
      job.live.node = { id: event.nodeId, label: 'Node work', value: event.value, max: event.max, unit: 'work' };
    }
    if (type === 'progress_state') {
      for (const node of event.nodes) {
        if (job.stateNodes.size < 256) job.stateNodes.add(node.id);
        if (node.state === 'running') job.live.node = { id: node.id, label: 'Node work', value: node.value, max: node.max, unit: 'work' };
      }
    }
    dirty(job);
  }
  function receive(connection, data, binary) {
    if (binary) {
      const preview = parseBinaryFrame(data);
      if (preview?.kind !== 'preview') return;
      const candidates = [...connection.jobs].filter(job => job.terminalAt === null && !job.signalled && job.promptId &&
        (preview.legacy ? connection.descriptor.kind === 'local' && job.dedicated && connection.jobs.size === 1 && job.active : job.promptId === preview.promptId));
      if (candidates.length !== 1) return;
      const job = candidates[0]; preview.receivedAt = iso();
      if (now() - job.lastPreview >= 1000) publishPreview(job, preview);
      else { job.pending = preview; trimPreviews(); } // Latest wins, shares the global byte budget.
      return;
    }
    const event = parseProgressMessage(data); if (!event) return;
    const matches = [...connection.jobs].filter(job => job.promptId === event.promptId);
    if (matches.length === 1) apply(matches[0], event);
    // Sanitized JSON only; binary is never buffered before acceptance.
    for (const job of connection.jobs) if (!job.promptId) {
      job.buffer = job.buffer.filter(item => now() - item.at <= 2000);
      if (job.buffer.length === 64) job.buffer.shift();
      const size = Buffer.byteLength(JSON.stringify(event));
      if (size <= 64 * 1024) job.buffer.push({ at: now(), event, size });
      while (job.buffer.reduce((n, item) => n + item.size, 0) > 64 * 1024) job.buffer.shift();
    }
  }
  function begin(key, options) {
    if (stopped || !validKey(key) || !options || !['local', 'cloud'].includes(options.backend?.kind)) return Promise.resolve(false);
    const existing = lookup(key); if (existing) return existing.ready;
    if (jobs.has(keyOf(key)) || jobs.size >= maxJobs) return Promise.resolve(false);
    const cloud = options.backend.kind === 'cloud';
    if (!promptId(options.requestId) || !promptId(options.clientId) || (!cloud && !options.backend.url) || (cloud && !promptId(options.accountKey))) return Promise.resolve(false);
    // Transport grouping deliberately ignores display backend.id. Existing local URL validation
    // and backendTransportKey must be applied by the coordinator before this call.
    const descriptor = cloud ? { kind: 'cloud', accountKey: options.accountKey, clientId: options.clientId } : { kind: 'local', url: options.backend.url, clientId: options.clientId };
    const transportId = cloud ? `cloud:${options.accountKey}` : `local:${new URL(descriptor.url).origin}:${descriptor.clientId}`;
    const job = { key: { source: key.source, id: key.id, projectId: key.projectId }, dedicated: !cloud && options.dedicated === true,
      requestId: options.requestId, promptId: null, beganAt: now(), buffer: [], stateNodes: new Set(), active: false, signalled: false, terminalAt: null,
      versions: [], pending: null, lastPreview: -Infinity, lastEmit: -Infinity, dirty: true, authority: null,
      live: { phase: 'submitting', observedAt: iso(), connection: 'polling', node: null, queue: null, estimate: null, preview: null } };
    jobs.set(keyOf(key), job);
    let connection = connections.get(transportId);
    if (!connection) {
      connection = { id: transportId, descriptor, jobs: new Set(), socket: null, retry: null, attempt: 0, openedAt: Infinity };
      connections.set(transportId, connection);
      connection.promise = new Promise(resolve => { connection.ready = resolve; });
    }
    connection.jobs.add(job); job.connection = connection;
    if (connection.jobs.size > 1) for (const peer of connection.jobs) peer.dedicated = false;
    job.ready = connection.socket?.readyState === 1 ? Promise.resolve(true) : connection.promise;
    if (connection.socket?.readyState === 1) job.live.connection = 'live';
    if (!connection.socket && !connection.retry) open(connection);
    return job.ready;
  }
  function accept(key, { promptId: id }) {
    const job = lookup(key);
    if (!job || job.terminalAt !== null || (job.connection?.descriptor.kind === 'local' && id !== job.requestId) || !promptId(id) || (job.promptId && job.promptId !== id)) return false;
    // Duplicate receipt mappings are ambiguous. Do not steal another project's prompt.
    if ([...job.connection.jobs].some(peer => peer !== job && peer.promptId === id)) return false;
    job.promptId = id;
    if (job.live.phase === 'submitting') job.live.phase = 'queued';
    const buffered = job.buffer; job.buffer = [];
    for (const item of buffered) if (now() - item.at <= 2000 && item.event.promptId === id) apply(job, item.event);
    dirty(job); return true;
  }
  function reconcile(snapshot) {
    for (const row of snapshot.jobs || []) {
      const job = lookup(row); if (!job) continue;
      if (job.terminalAt !== null) continue;
      job.authority = row.status;
      if (terminal.has(row.status)) {
        job.terminalAt = now(); job.active = false; job.pending = null; job.buffer = [];
        job.live.phase = row.status === 'completed' || row.status === 'orphaned' ? 'done' : row.status === 'closed' ? 'uncertain' : 'failed';
        job.live.connection = 'polling'; detach(job);
      } else if (['collecting', 'uploading', 'submitting'].includes(row.status)) job.live.phase = row.status;
      dirty(job);
    }
  }
  function close(key) {
    const job = lookup(key); if (!job) return false;
    detach(job); job.pending = null; job.buffer = [];
    for (const [id, entry] of cache) if (entry.job === job) removeCache(id);
    jobs.delete(keyOf(key)); return true;
  }
  const api = {
    begin, accept, reconcile,
    phase(key, phase) { const job = lookup(key); if (!job || job.terminalAt !== null || !['uploading', 'submitting', 'collecting'].includes(phase)) return false; job.live.phase = phase; dirty(job); return true; },
    live(key) { const job = lookup(key); return job ? liveOf(job) : null; },
    enrich(snapshot) { return { ...snapshot, jobs: snapshot.jobs.map(row => { const job = lookup(row); return job ? { ...row, live: liveOf(job) } : row; }) }; },
    preview(key, version) {
      const job = lookup(key); if (!job || !Number.isSafeInteger(version)) return null;
      if (job.terminalAt !== null && now() - job.terminalAt >= 60000) return null;
      const id = cacheId(job, version), entry = cache.get(id); if (!entry) return null;
      cache.delete(id); cache.set(id, entry); // LRU on access; return a copy, never mutable cache memory.
      return { mime: entry.mime, bytes: Buffer.from(entry.bytes) };
    },
    subscribe(projectId, callback) {
      if (stopped || !promptId(projectId) || typeof callback !== 'function' || [...listeners.values()].reduce((n, set) => n + set.size, 0) >= maxListeners) return ignore;
      const set = listeners.get(projectId) || new Set(); listeners.set(projectId, set); set.add(callback);
      return safely(() => { set.delete(callback); if (!set.size) listeners.delete(projectId); });
    },
    flush, close,
    stats() { return { jobs: jobs.size, connections: connections.size, listeners: [...listeners.values()].reduce((n, set) => n + set.size, 0), cacheBytes: usedBytes, versions: cache.size, pendingBytes: [...jobs.values()].reduce((n, job) => n + (job.pending?.bytes.length || 0), 0), bufferedEvents: [...jobs.values()].reduce((n, job) => n + job.buffer.length, 0) }; },
    stop() { stopped = true; clearTimer(timer); for (const job of [...jobs.values()]) close(job.key); listeners.clear(); },
  };
  if (tickMs > 0) timer = schedule(loop, tickMs);
  return Object.fromEntries(Object.entries(api).map(([name, fn]) => [name, safely(fn, ['live', 'preview'].includes(name) ? null : false)]));
}

/** Store-side guard for the optional live-progress hooks. Every call is nonthrowing; begin()
 * resolves within boundMs whatever the hook does, so telemetry can never block, fail or
 * change a dispatch. Hooks receive the persisted job record only.
 */
export function telemetryHooks(telemetry, { boundMs = 2500 } = {}) {
  const call = (name, ...args) => { try { const result = telemetry?.[name]?.(...args); return result?.then ? Promise.resolve(result).catch(() => false) : result; } catch { return false; } };
  return {
    begin(job) {
      const opened = Promise.resolve(call('begin', job));
      // The bound timer must keep the loop alive: a hanging telemetry begin would otherwise let the process exit mid-dispatch.
      let timer; const bound = new Promise(resolve => { timer = setTimeout(() => resolve(false), boundMs); });
      return Promise.race([opened, bound]).finally(() => clearTimeout(timer));
    },
    phase: (job, phase) => { call('phase', job, phase); },
    accept: job => { call('accept', job); },
  };
}
