import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson } from './atomic.mjs';

// This receipt is independent of project revision: a failed render must not erase
// evidence that Blender may still be working, even if the app never receives a reply.
export async function openOperations(root, persist = atomicJson) {
  const file = join(root, 'blender-operation.json');
  let state = null;
  try { state = JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (state?.status === 'running') {
    state = { ...state, status: 'uncertain', reason: 'video-lab stopped before this operation was resolved. Blender may have continued.' };
    await persist(file, state);
  }
  const blocked = () => state && ['running', 'uncertain'].includes(state.status);
  return {
    get: () => structuredClone(state),
    assertIdle() {
      if (blocked()) { const e = Error('Blender operation requires reconciliation. Check Blender is idle and review its camera, frame and render settings. This is not a cancellation.'); e.status = 409; throw e; }
    },
    async begin(kind, details) {
      this.assertIdle();
      const next = { id: randomUUID(), kind, details, status: 'running', startedAt: new Date().toISOString() };
      await persist(file, next); state = next; return state.id;
    },
    async finish(id, status, details = {}) {
      if (state?.id !== id || state.status !== 'running') throw Error('Operation receipt changed');
      const next = { ...state, ...details, status, finishedAt: new Date().toISOString() };
      await persist(file, next); state = next;
    },
    async reconcile(input) {
      if (!state || state.id !== input.operationId || state.status !== 'uncertain' || input.blenderIdle !== true || input.settingsReviewed !== true) {
        const e = Error('Confirm the exact uncertain operation, Blender is idle, and its settings have been reviewed.'); e.status = 409; throw e;
      }
      const next = { ...state, status: 'reconciled', reconciledAt: new Date().toISOString(), outcome: 'Operator confirmed idle/settings. No retry was submitted; an uncollected output may remain in Blender.' };
      await persist(file, next); state = next; return structuredClone(state);
    },
  };
}
