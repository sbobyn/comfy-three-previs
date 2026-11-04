// Per-backend, per-kind submission slots shared by every job store on one data dir.
// An `uncertain` job keeps its slot for PREVIS_UNCERTAIN_HOLD_MINUTES, then stops counting
// (the tracker flags it stuck). Nothing here retries or resubmits anything.
import { resolve } from 'node:path';
import { backendTransportKey } from './backends.mjs';

const count = (value, fallback) => { const n = Number(value); return value !== undefined && value !== '' && Number.isInteger(n) && n >= 1 ? n : fallback; };
const time = value => { const ms = Date.parse(value); return Number.isFinite(ms) ? ms : null; };
export const RETRY_AFTER_SECONDS = 15;

export function limitsFor(backend, kind, env = process.env) {
  if (backend.kind === 'local') return { key: 'local', label: 'local', limit: count(env.PREVIS_LIMIT_LOCAL, 1) };
  return kind === 'video'
    ? { key: 'cloud:video', label: 'cloud video', limit: count(env.PREVIS_LIMIT_CLOUD_VIDEOS, 3) }
    : { key: 'cloud:image', label: 'cloud image', limit: count(env.PREVIS_LIMIT_CLOUD_IMAGES, 4) };
}

export function uncertainHoldMs(env = process.env) {
  const minutes = Number(env.PREVIS_UNCERTAIN_HOLD_MINUTES);
  return (env.PREVIS_UNCERTAIN_HOLD_MINUTES !== undefined && env.PREVIS_UNCERTAIN_HOLD_MINUTES !== '' && Number.isFinite(minutes) && minutes >= 0 ? minutes : 15) * 60000;
}

/** When an uncertain receipt became uncertain (or the closest earlier timestamp). */
export const uncertainSince = job => time(job.uncertainAt) ?? time(job.dispatchStartedAt) ?? time(job.submittedAt) ?? time(job.createdAt);

export function createSlots({ env = process.env, now = Date.now } = {}) {
  const sources = new Map(), reserved = new Map();
  // One slot pool per transport (two local ComfyUI URLs are two machines) and, on Cloud, per media kind.
  const pool = (backend, kind) => `${backendTransportKey(backend)}|${backend.kind === 'local' ? 'local' : kind === 'video' ? 'video' : 'image'}`;
  function holders() {
    const hold = uncertainHoldMs(env), at = now();
    return [...sources.values()].flatMap(list => list()).filter(job => job.status !== 'uncertain' || at - (uncertainSince(job) ?? at) <= hold);
  }
  function inUse(target, exceptId) {
    const ids = new Set();
    for (const job of holders()) if (job.id !== exceptId && pool(job.backend, job.kind) === target) ids.add(job.id);
    for (const [id, slot] of reserved) if (id !== exceptId && slot === target) ids.add(id);
    return ids.size;
  }
  return {
    /** list() → [{ id, backend, kind:'image'|'video', status, uncertainAt?, dispatchStartedAt?, createdAt? }] of active jobs. */
    register(name, list) { sources.set(name, list); },
    /** Reserve a slot synchronously; returns release(). Throws 409 `busy` when the pool is full. */
    acquire({ id, backend, kind }) {
      const target = pool(backend, kind), { label, limit } = limitsFor(backend, kind, env), used = inUse(target, id);
      if (used >= limit) {
        const error = Error(`Backend busy: ${used} of ${limit} ${label} slot${limit === 1 ? '' : 's'} in use; retry when a job finishes`);
        error.status = 409; error.apiCode = 'busy'; error.retryAfterSeconds = RETRY_AFTER_SECONDS;
        throw error;
      }
      reserved.set(id, target);
      return () => { if (reserved.get(id) === target) reserved.delete(id); };
    },
    snapshot() {
      const out = {};
      for (const [backend, kind] of [[{ kind: 'cloud' }, 'image'], [{ kind: 'cloud' }, 'video'], [{ kind: 'local' }, 'image']]) out[limitsFor(backend, kind, env).key] = { limit: limitsFor(backend, kind, env).limit, active: 0 };
      const ids = new Map();
      for (const job of holders()) ids.set(job.id, limitsFor(job.backend, job.kind, env).key);
      for (const [id, slot] of reserved) if (!ids.has(id)) ids.set(id, slot.endsWith('|local') ? 'local' : slot.endsWith('|video') ? 'cloud:video' : 'cloud:image');
      for (const key of ids.values()) out[key].active++;
      return out;
    },
  };
}

// Generation and refgen open separately but must share one pool per data directory.
const registries = new Map();
export function slotsFor(root) {
  const key = resolve(root);
  if (!registries.has(key)) registries.set(key, createSlots());
  return registries.get(key);
}

/** Media downloads (/view) allowed at once per data dir: PREVIS_DOWNLOAD_CONCURRENCY, default 4. */
export const downloadLimit = (env = process.env) => count(env.PREVIS_DOWNLOAD_CONCURRENCY, 4);

// FIFO: at most `limit` calls run at once; the rest wait in arrival order. A stalled download holds one place,
// never the whole queue (per-request journal locks stay in generation/refgen; this only bounds parallel transfers).
export function createLimiter(limit) {
  let running = 0;
  const waiting = [];
  const next = () => { while (running < limit && waiting.length) { running++; waiting.shift()(); } };
  const run = async fn => {
    await new Promise(resolve => { waiting.push(resolve); next(); });
    try { return await fn(); } finally { running--; next(); }
  };
  run.stats = () => ({ limit, running, waiting: waiting.length });
  return run;
}

// Generation and refgen share one download limit per data directory.
const downloadRegistries = new Map();
export function downloadsFor(root, env = process.env) {
  const key = resolve(root);
  if (!downloadRegistries.has(key)) downloadRegistries.set(key, createLimiter(downloadLimit(env)));
  return downloadRegistries.get(key);
}
