// Comfy Cloud stores uploads by content hash, so identical bytes need one upload per backend.
// Memo: sha256(bytes) + transport key → upload result, persisted at <data>/upload-cache.json.
// Local ComfyUI keeps per-request isolated input files, so local uploads are never memoised.
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { atomicJson } from './atomic.mjs';
import { backendTransportKey } from './backends.mjs';
import { assertNoSecrets, hashBytes } from './workflows.mjs';

export function createUploadCache(file, { maxAgeMs = 7 * 24 * 3600e3, now = Date.now } = {}) {
  let entries = null, writing = Promise.resolve();
  const inflight = new Map();
  async function load() {
    if (entries) return entries;
    try { entries = JSON.parse(await readFile(file, 'utf8')).entries || {}; } catch { entries = {}; }
    return entries;
  }
  function save() {
    const task = writing.then(() => { const value = { version: 1, entries }; assertNoSecrets(value); return atomicJson(file, value); });
    writing = task.catch(() => {});
    return task;
  }
  async function upload(adapter, bytes, options) {
    if (adapter.snapshot?.kind !== 'cloud') return adapter.upload(bytes, options);
    const key = `${hashBytes(bytes)}:${backendTransportKey(adapter.snapshot)}`, all = await load(), hit = all[key];
    if (hit && now() - Date.parse(hit.at) < maxAgeMs) return { ...hit.result, cached: true };
    if (inflight.has(key)) return inflight.get(key);
    const task = (async () => {
      const result = await adapter.upload(bytes, options);
      all[key] = { result, mime: options.mime, at: new Date(now()).toISOString() };
      await save().catch(() => {}); // a lost memo only costs a repeat upload
      return result;
    })();
    inflight.set(key, task);
    try { return await task; } finally { inflight.delete(key); }
  }
  return { upload, entries: async () => structuredClone(await load()) };
}

const caches = new Map();
export function uploadCacheFor(root) {
  const key = resolve(root);
  if (!caches.has(key)) caches.set(key, createUploadCache(join(key, 'upload-cache.json')));
  return caches.get(key);
}
