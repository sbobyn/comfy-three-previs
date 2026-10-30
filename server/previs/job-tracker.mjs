// Server-side job tracker (contract C1). Polls every active generation/refgen job with backoff
// until it is terminal, so outcomes land without a client calling track. It only ever calls
// the stores' own track(); it never submits, retries or resubmits anything.
import { classifyFailure } from './failures.mjs';
import { errorDetail } from './backends.mjs';
import { uncertainHoldMs, uncertainSince } from './concurrency.mjs';

const DRAFT = new Set(['prepared', 'quoted', 'invalidated', 'expired']);
const time = value => { const ms = Date.parse(value); return Number.isFinite(ms) ? ms : null; };
const iso = ms => ms == null ? null : new Date(ms).toISOString();
const startOf = job => time(job.dispatchStartedAt) ?? time(job.submittedAt) ?? time(job.acceptedAt) ?? time(job.createdAt);
const endOf = job => time(job.completedAt) ?? time(job.finishedAt) ?? time(job.closedAt) ?? time(job.tracking?.lastTrackedAt);

/**
 * sources: [{ name, list(), isActive(job), track(id, tracking), expectedSeconds(job), label(job), projectIdOf(job), costOf(job), onTerminal(job),
 *             get?(id), kindOf?(job), resultsOf?(job) }]
 * Extra options: limits() → snapshot `limits`; holdMs (uncertain hold); recentMs (terminal jobs listed); tickMs (0 = no timer; call tick()).
 */
export function createJobTracker({ sources, intervalMs = 5000, maxIntervalMs = 30000, factor = 1.5, giveUpMs = 2 * 3600e3, now = Date.now, log = () => {},
  limits = () => ({}), holdMs = uncertainHoldMs(), recentMs = 24 * 3600e3, tickMs = 1000 } = {}) {
  const byName = new Map(sources.map(source => [source.name, source]));
  const entries = new Map(), finished = new Set();
  let timer = null, startedAt = null, resumed = 0, lastScan = -Infinity, ticking = null;
  const sourceOf = name => { const source = byName.get(name); if (!source) throw Error(`Unknown job source ${name}`); return source; };
  const keyOf = (name, id) => `${name}:${String(id).toLowerCase()}`;
  const find = (source, id) => { try { return source.get ? source.get(id) : source.list().find(job => job.id === id) || null; } catch { return null; } };

  function watch(name, id, { immediate = false } = {}) {
    const source = sourceOf(name), job = find(source, id);
    if (!job || !source.isActive(job)) return false;
    const key = keyOf(name, job.id);
    if (entries.has(key)) return true;
    finished.delete(key);
    entries.set(key, { key, name, id: job.id, delay: intervalMs, nextAt: now() + (immediate ? 0 : intervalMs), trackCount: job.tracking?.trackCount || 0,
      lastTrackedAt: time(job.tracking?.lastTrackedAt), error: job.tracking?.error || null, status: job.status, gaveUp: false, inflight: null, attempts: 0 });
    return true;
  }

  async function finish(entry, job) {
    entries.delete(entry.key);
    if (finished.has(entry.key)) return;
    finished.add(entry.key);
    log(`${entry.name} ${entry.id.slice(0, 8)} ${job?.status || 'gone'}`);
    if (!job) return;
    try { await sourceOf(entry.name).onTerminal?.(job); }
    catch (error) { log(`${entry.name} ${entry.id.slice(0, 8)} onTerminal failed: ${errorDetail(error)}`); }
  }

  function run(entry) {
    if (entry.inflight) return entry.inflight;
    const source = sourceOf(entry.name), at = now(), next = Math.min(entry.delay * factor, maxIntervalMs);
    entry.trackCount++; entry.lastTrackedAt = at; entry.attempts++;
    const tracking = { lastTrackedAt: iso(at), trackCount: entry.trackCount, nextTrackAt: iso(at + next) };
    entry.inflight = (async () => {
      try {
        const job = await source.track(entry.id, tracking);
        entry.error = job?.tracking?.error || null;
        if (entry.attempts === 1 || job?.status !== entry.status) log(`${entry.name} ${entry.id.slice(0, 8)} tracked #${entry.trackCount} → ${job?.status}`);
        entry.status = job?.status;
        if (!job || !source.isActive(job)) { await finish(entry, job); return job; }
        if (['collecting', 'attaching'].includes(job.status)) entry.gaveUp = false;
        if (!['collecting', 'attaching'].includes(job.status) && at - (startOf(job) ?? at) > giveUpMs && !entry.gaveUp) { entry.gaveUp = true; log(`${entry.name} ${entry.id.slice(0, 8)} still ${job.status} after ${Math.round(giveUpMs / 60000)} min; automatic tracking stopped`); }
        return job;
      } catch (error) {
        const detail = errorDetail(error);
        if (detail !== entry.error || entry.attempts === 1) log(`${entry.name} ${entry.id.slice(0, 8)} tracking error: ${detail}`);
        entry.error = detail;
        throw error;
      } finally {
        entry.delay = next; entry.nextAt = Math.max(at + next, now()); entry.inflight = null;
      }
    })();
    return entry.inflight;
  }

  function scan() {
    lastScan = now();
    let found = 0;
    for (const source of sources) {
      const seen = new Set();
      for (const job of source.list()) {
        seen.add(keyOf(source.name, job.id));
        if (source.isActive(job)) { if (!entries.has(keyOf(source.name, job.id)) && watch(source.name, job.id)) found++; }
        else { const entry = entries.get(keyOf(source.name, job.id)); if (entry && !entry.inflight) finish(entry, job); }
      }
      for (const entry of entries.values()) if (entry.name === source.name && !seen.has(entry.key) && !entry.inflight) finish(entry, null);
    }
    return found;
  }

  async function tick() {
    if (now() - lastScan >= intervalMs) scan();
    const due = [...entries.values()].filter(entry => !entry.gaveUp && !entry.inflight && entry.nextAt <= now());
    await Promise.allSettled(due.map(run));
  }

  return {
    start() {
      if (startedAt) return;
      startedAt = now(); resumed = 0;
      // Resume after a restart: every non-terminal receipt is tracked again (never resubmitted).
      for (const source of sources) for (const job of source.list()) if (source.isActive(job) && watch(source.name, job.id, { immediate: true })) resumed++;
      lastScan = now();
      log(`job tracker started; resumed ${resumed} active job${resumed === 1 ? '' : 's'}`);
      if (tickMs > 0) { timer = setInterval(() => { if (!ticking) ticking = tick().finally(() => { ticking = null; }); }, tickMs); timer.unref?.(); }
    },
    stop() { if (timer) clearInterval(timer); timer = null; startedAt = null; },
    watch: (name, id) => watch(name, id),
    /** Track one job immediately (the HTTP track routes). Inactive jobs go straight to the source. */
    async trackNow(name, id) {
      const source = sourceOf(name);
      if (!entries.has(keyOf(name, id)) && !watch(name, id)) return source.track(id);
      return run(entries.get(keyOf(name, id)));
    },
    tick,
    snapshot() {
      const at = now(), jobs = [];
      for (const source of sources) for (const job of source.list()) {
        if ((DRAFT.has(job.status) && !job.lastAttempt) || job.dismissedAt) continue;
        const active = source.isActive(job), entry = entries.get(keyOf(source.name, job.id));
        const start = startOf(job) ?? at, end = active ? at : endOf(job) ?? at;
        if (!active && at - end > recentMs) continue;
        const ageSeconds = Math.max(0, Math.round((end - start) / 1000)), expectedSeconds = source.expectedSeconds(job), uncertain = job.status === 'uncertain';
        const stuck = job.status === 'recovery-required' || active && (ageSeconds > 2 * expectedSeconds || Boolean(entry?.gaveUp) || (uncertain && at - (uncertainSince(job) ?? start) > holdMs));
        jobs.push({
          id: job.id, kind: source.kindOf?.(job) || 'image', source: source.name, projectId: source.projectIdOf(job) ?? null, label: source.label(job), status: job.status,
          createdAt: job.createdAt || null, submittedAt: job.dispatchStartedAt || job.submittedAt || job.acceptedAt || null,
          lastTrackedAt: iso(entry?.lastTrackedAt) ?? job.tracking?.lastTrackedAt ?? null, trackCount: entry?.trackCount ?? job.tracking?.trackCount ?? 0,
          nextTrackAt: active && entry && !entry.gaveUp ? iso(entry.nextAt) : null, ageSeconds, expectedSeconds, stuck, uncertain,
          costUsd: source.costOf(job) ?? null, backend: { kind: job.backend?.kind ?? null, id: job.backend?.id ?? null },
          diagnosis: classifyFailure(job),
          ...(job.lastAttempt ? { lastAttempt: job.lastAttempt } : {}),
          failure: job.failure ? { phase: job.failure.phase ?? null, httpStatus: job.failure.httpStatus ?? null, detail: job.failure.detail ?? null } : null,
          ...(entry?.error || job.tracking?.error ? { trackingError: entry?.error || job.tracking.error } : {}),
          results: source.resultsOf?.(job) || [],
        });
      }
      jobs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      return { jobs, limits: limits(), tracker: { running: Boolean(startedAt), startedAt: iso(startedAt), resumed } };
    },
  };
}
