// Live-progress composition (server side). Joins the ephemeral observer (job-progress.mjs) to the
// persisted stores and the C1 tracker. Persisted receipts + tracker own every outcome; this module
// only opens/attributes observation, feeds authoritative snapshots back, and publishes change keys.
import { randomUUID } from 'node:crypto';
import { backendSnapshot } from './backends.mjs';

const SOURCES = ['generation', 'refgen'];
const validId = value => typeof value === 'string' && /^[\w-]{1,128}$/.test(value);
// Durable acceptance: the receipt was persisted with the backend's prompt ID after a validated accept.
const ACCEPTED = {
  generation: job => ['queued', 'running'].includes(job.status) && Boolean(job.acceptedAt) && validId(job.promptId),
  refgen: job => job.status === 'submitted' && validId(job.promptId),
};

/**
 * observe: createJobProgress() instance. sources: { generation, refgen } tracker sources (get/list/projectIdOf).
 * legacyClientId(source, job): the historical shared client_id for receipts without progressClientId.
 */
export function createProgressCoordinator({ observe, sources = {}, budget = null, legacyClientId = (_, job) => job.projectId,
  cloudAccountKey = 'default-cloud-account', cloudClientId = randomUUID(), intervalMs = 1000, setTimer = setInterval, clearTimer = clearInterval } = {}) {
  const listeners = new Map();
  let tracker = null, timer = null, last = new Map();

  function keyOf(source, job) {
    const projectId = sources[source]?.projectIdOf?.(job);
    return SOURCES.includes(source) && validId(job?.id) && validId(projectId) ? { source, id: job.id, projectId } : null;
  }
  // Only the persisted, already-validated backend snapshot supplies a URL; it is re-validated here.
  function optionsOf(source, job) {
    const b = job?.backend;
    if (!b || !['local', 'cloud'].includes(b.kind)) return null;
    const backend = backendSnapshot(b.kind === 'local' ? { kind: 'local', url: b.url } : { kind: 'cloud' });
    if (backend.kind === 'cloud') return { backend: { kind: 'cloud' }, requestId: job.id, clientId: cloudClientId, accountKey: cloudAccountKey };
    const dedicated = validId(job.progressClientId);
    return { backend: { kind: 'local', url: backend.url }, requestId: job.id, clientId: dedicated ? job.progressClientId : legacyClientId(source, job), dedicated };
  }
  const guard = fn => (...args) => { try { return fn(...args); } catch { return false; } };

  /** Store hooks for one source (nonthrowing; the stores also wrap them). */
  function telemetry(source) {
    return {
      begin: guard(job => { const key = keyOf(source, job), options = key && optionsOf(source, job); return key && options ? observe.begin(key, options) : false; }),
      phase: guard((job, phase) => { const key = keyOf(source, job); return key ? observe.phase(key, phase) : false; }),
      accept: guard(job => { const key = keyOf(source, job); return key && ACCEPTED[source](job) ? observe.accept(key, { promptId: job.promptId }) : false; }),
    };
  }

  /** After a restart: observe accepted, still-running receipts. Never infers an acceptance. */
  function restore() {
    let restored = 0;
    for (const source of SOURCES) {
      let jobs = []; try { jobs = sources[source]?.list() || []; } catch {}
      for (const job of jobs) {
        if (!ACCEPTED[source](job)) continue;
        const hooks = telemetry(source);
        if (hooks.begin(job) === false) continue;
        if (hooks.accept(job)) restored++;
      }
    }
    return restored;
  }

  const signature = row => JSON.stringify([row.status, row.uncertain, row.stuck, row.label, row.results, row.failure, row.trackingError ?? null,
    row.lastAttempt ?? null, row.diagnosis ?? null, row.trackCount, ['completed', 'failed', 'closed', 'cancelled', 'invalidated'].includes(row.status) ? 0 : Math.floor(row.ageSeconds / 5)]);
  function publish(projectId, change) { for (const fn of listeners.get(projectId) || []) { try { fn(change); } catch {} } }
  /** One authoritative pass: reconcile the observer with C1, then publish changed/removed keys per project. */
  function tick() {
    if (!tracker) return;
    let snap; try { snap = tracker.snapshot(); } catch { return; }
    observe.reconcile(snap);
    const next = new Map();
    for (const row of snap.jobs) {
      if (!validId(row.projectId) || !SOURCES.includes(row.source)) continue;
      const key = `${row.source}:${row.id}`, sig = signature(row);
      next.set(key, { projectId: row.projectId, source: row.source, id: row.id, sig });
      if (last.get(key)?.sig !== sig) publish(row.projectId, { type: 'job', source: row.source, id: row.id });
    }
    for (const [key, row] of last) if (!next.has(key)) {
      observe.close({ source: row.source, id: row.id, projectId: row.projectId });
      publish(row.projectId, { type: 'remove', source: row.source, id: row.id });
    }
    last = next;
  }

  return {
    telemetry,
    restore,
    tick,
    /** Start reconciling with the tracker; call after tracker.start(). */
    start(t) { tracker = t; tick(); if (intervalMs > 0 && !timer) { timer = setTimer(tick, intervalMs); timer.unref?.(); } },
    subscribe(projectId, fn) {
      const set = listeners.get(projectId) || new Set(); listeners.set(projectId, set); set.add(fn);
      let done = false; return () => { if (done) return; done = true; set.delete(fn); if (!set.size) listeners.delete(projectId); };
    },
    /** Route scope: synchronous public C1 reads for one project; access policy is applied by the caller. */
    scope(projectId) {
      return {
        snapshot: () => { const snap = tracker.snapshot(); return { ...snap, jobs: snap.jobs.filter(row => row.projectId === projectId), ...(budget ? { budget: budget.status(projectId) } : {}) }; },
        subscribe: fn => this.subscribe(projectId, fn),
        ownsJob: (source, id) => {
          if (!SOURCES.includes(source) || !validId(id)) return false;
          try { const job = sources[source].get(id); return Boolean(job) && sources[source].projectIdOf(job) === projectId; } catch { return false; }
        },
      };
    },
    /** The budget changed (a reservation, settlement or cap): every open stream gets a 'budget' event (account caps are shared). */
    publishBudget() { for (const projectId of [...listeners.keys()]) publish(projectId, { type: 'budget' }); },
    stop() { if (timer) clearTimer(timer); timer = null; listeners.clear(); observe.stop(); },
  };
}
