import { randomUUID } from 'node:crypto';

const validId = value => typeof value === 'string' && /^[\w-]{1,128}$/.test(value);
const validKey = row => row && ['generation', 'refgen'].includes(row.source) && validId(row.id);
const TERMINAL = new Set(['completed', 'failed', 'closed', 'cancelled', 'invalidated', 'orphaned']);
// Stream rows carry no result lists (the workspace reads results from the project), and a snapshot lists every
// active job but only the newest `recentLimit` finished ones, so a busy day no longer pushes it past the frame cap.
const lean = ({ results, ...row }) => row;

/** resolveProject(req, projectId) applies EXISTING access policy and returns null or
 * { snapshot(), subscribe(notify), ownsJob(source,id) }. snapshot/subscribe/ownsJob
 * are synchronous, side-effect-free reads of authoritative state. Notifications
 * are {type:'job'|'preview'|'remove',source,id}; never carry trusted browser rows.
 */
export function createJobProgressRoutes({ resolveProject, observe, now = Date.now,
  epoch = randomUUID(), maxBytes = 64 * 1024, maxSnapshotBytes = 512 * 1024, recentLimit = 30, stallMs = 15000, maxClients = 256 } = {}) {
  if (typeof resolveProject !== 'function') throw new TypeError('Project resolver required');
  const clients = new Set();
  let seq = 0, stopped = false;
  const envelope = projectId => ({ v: 1, epoch, seq: ++seq, projectId, at: new Date(now()).toISOString() });
  const previewMeta = (p, key) => p ? {
    version: p.version, url: `/api/jobs/${key.source}/${encodeURIComponent(key.id)}/preview?projectId=${encodeURIComponent(key.projectId)}&version=${p.version}`,
    mime: p.mime, width: p.width, height: p.height, receivedAt: p.receivedAt, nodeId: p.nodeId ?? null,
  } : null;
  function snapshot(scope, projectId) {
    const raw = scope.snapshot();
    if (!raw || typeof raw.then === 'function' || !Array.isArray(raw.jobs)) throw Error('Synchronous C1 snapshot required');
    // The resolver supplies public C1 data, never raw receipts/workflows/errors.
    let finished = 0;
    const filtered = { ...raw, jobs: raw.jobs.filter(row => validKey(row) && row.projectId === projectId && (!TERMINAL.has(row.status) || ++finished <= recentLimit)).map(lean) };
    const enriched = observe?.enrich?.(filtered) || filtered;
    return { jobs: enriched.jobs.map(row => row.live ? { ...row, live: { ...row.live,
      node: row.live.node ?? null, queue: row.live.queue ?? null, estimate: row.live.estimate ?? null,
      preview: previewMeta(row.live.preview, row) } } : row), limits: raw.limits, tracker: raw.tracker };
  }
  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const match = /^\/api\/jobs\/(generation|refgen)\/([\w-]+)\/preview$/.exec(url.pathname);
    if (url.pathname !== '/api/jobs/stream' && !match) return false;
    const reply = status => { res.writeHead(status, { 'Cache-Control': 'no-store' }); res.end(); return true; };
    if (req.method !== 'GET') return reply(405);
    const projectId = url.searchParams.get('projectId');
    if (!validId(projectId)) return reply(400);
    // Policy errors belong to the parent's existing error handler.
    const scope = await resolveProject(req, projectId);
    if (!scope) return reply(404);
    if (req.destroyed || res.destroyed) return true;
    if (match) {
      const version = Number(url.searchParams.get('version'));
      if (!Number.isSafeInteger(version) || version < 1) return reply(400);
      if (scope.ownsJob(match[1], match[2]) !== true) return reply(404);
      const p = observe?.preview({ projectId, source: match[1], id: match[2] }, version);
      if (!p || !['image/png', 'image/jpeg'].includes(p.mime) || p.bytes.length > 256 * 1024) return reply(404);
      res.writeHead(200, { 'Content-Type': p.mime, 'Content-Length': p.bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(p.bytes); return true;
    }
    if (stopped || clients.size >= maxClients) return reply(503);
    let closed = false, blocked = false, queuedBytes = 0, ready = false;
    let heartbeat, stall, unsub = () => {}, unobserve = () => {};
    const queue = [], pending = [];
    function close() {
      if (closed) return; closed = true;
      clearInterval(heartbeat); clearTimeout(stall); unsub(); unobserve();
      queue.length = 0; pending.length = 0; queuedBytes = 0;
      res.off('drain', drain); res.off('close', close); res.off('error', close); req.off('aborted', close);
      clients.delete(close); res.destroy();
    }
    function write(frame, limit = maxBytes) {
      if (closed) return;
      const bytes = Buffer.byteLength(frame);
      if (bytes + queuedBytes + (res.writableLength || 0) > limit) return close();
      if (blocked) { queue.push(frame); queuedBytes += bytes; return; }
      if (!res.write(frame)) { blocked = true; stall = setTimeout(close, stallMs); stall.unref?.(); }
    }
    function drain() {
      blocked = false; clearTimeout(stall);
      while (queue.length && !blocked && !closed) { const frame = queue.shift(); queuedBytes -= Buffer.byteLength(frame); write(frame); }
    }
    function send(type, data) {
      const event = { ...envelope(projectId), ...data };
      // The first frame (the snapshot) may be larger than later updates.
      write(`id: ${epoch}:${event.seq}\nevent: ${type}\ndata: ${JSON.stringify(event)}\n\n`, type === 'snapshot' ? maxSnapshotBytes : maxBytes);
    }
    function notify(change) {
      if (closed || !validKey(change) || !['job', 'preview', 'remove'].includes(change.type)) return;
      if (!ready) { if (pending.length >= 256) close(); else pending.push({ type: change.type, source: change.source, id: change.id }); return; }
      try {
        const row = snapshot(scope, projectId).jobs.find(j => j.source === change.source && j.id === change.id);
        if (change.type === 'remove') { if (!row) send('remove', { source: change.source, id: change.id }); }
        else if (row) send(change.type, change.type === 'preview'
          ? { source: row.source, id: row.id, preview: row.live?.preview ?? null } : { job: row });
      } catch { close(); }
    }
    clients.add(close); res.on('close', close); res.on('error', close); res.on('drain', drain); req.on('aborted', close);
    try {
      // No await between subscription and snapshot: changes during reads are queued.
      unsub = scope.subscribe(notify);
      unobserve = observe?.subscribe(projectId, notify) || (() => {});
      const initial = snapshot(scope, projectId);
      if (closed) { unsub(); unobserve(); return true; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      send('snapshot', initial); ready = true;
      for (const change of pending.splice(0)) notify(change);
      if (!closed) { heartbeat = setInterval(() => write(': heartbeat\n\n'), 15000); heartbeat.unref?.(); }
    } catch { close(); }
    return true;
  }
  return { handle, stop() { stopped = true; for (const close of [...clients]) close(); }, stats: () => ({ clients: clients.size }) };
}
