// Batch drivers. `fakeBackend()` simulates refgen/generation jobs and the job dashboard (tests, PREVIS_BATCH_FAKE=1);
// it never touches real job stores and never sends anything. `loopbackDrivers()` will drive the real routes over HTTP.
import { randomUUID } from 'node:crypto';

const SECONDS = { look: 20, sheet: 30, still: 20, video: 90 };
const busyError = (pool, retryAfterSeconds) => Object.assign(Error(`Backend busy: fake ${pool} slots in use; retry when a job finishes`), { status: 409, apiCode: 'busy', retryAfterSeconds });

/**
 * A fake job dashboard plus drivers. Jobs finish `seconds[type]` (or `seconds(node, type)`) after submit on the injected clock.
 * failOn(node) → true fails the job; uncertainOn(node) → true leaves it uncertain; busyOn(node) → true throws a 409 busy once per call.
 */
export function fakeBackend({ now = Date.now, seconds = SECONDS, limits = { 'cloud:image': 4, 'cloud:video': 3, local: 1 }, failOn = () => false, uncertainOn = () => false, busyOn = () => false, log = () => {} } = {}) {
  const jobs = new Map(), submits = [];
  const pool = type => (type === 'video' ? 'cloud:video' : 'cloud:image');
  const active = p => [...jobs.values()].filter(j => j.pool === p && !['completed', 'failed', 'uncertain'].includes(j.status)).length;
  const advance = () => { for (const j of jobs.values()) if (['queued', 'running', 'submitted'].includes(j.status) && now() >= j.finishAt) Object.assign(j, j.outcome); };
  // Throws busy before anything is recorded as dispatched; the job id is the refgen requestId / generation jobId.
  function admit(ctx, type, n = 1) { const p = pool(type); if (busyOn(ctx.node) || (type !== 'sheet' && active(p) + n > (limits[p] ?? 1))) throw busyError(p, 1); }
  function job(ctx, type, id) {
    const p = pool(type), kind = type === 'video' ? 'video' : 'image';
    const outcome = uncertainOn(ctx.node) ? { status: 'uncertain' } : failOn(ctx.node) ? { status: 'failed', failure: { phase: 'execution', httpStatus: null, detail: 'Fake failure' } } : { status: 'completed', results: [{ id: randomUUID(), kind, url: `/fake/${id}` }] };
    jobs.set(id, { id, kind, source: type === 'video' ? 'generation' : 'refgen', pool: p, projectId: ctx.batch.projectId, label: ctx.node.label, status: 'queued', createdAt: new Date(now()).toISOString(), finishAt: now() + ((typeof seconds === 'function' ? seconds(ctx.node, type) : seconds[type]) ?? 10) * 1000, costUsd: ctx.node.estimateUsd, outcome });
    submits.push({ type, nodeId: ctx.node.id, jobId: id });
    log(`fake ${type} ${ctx.node.label} → ${id}`);
  }
  const single = (type, key) => ({ async submit(ctx) { admit(ctx, type); const id = randomUUID(); await ctx.record({ [key]: id }); job(ctx, type, id); return { [key]: id }; } });
  const drivers = {
    blockout: { async submit(ctx) { submits.push({ type: 'blockout', nodeId: ctx.node.id }); return { done: true, assetId: randomUUID(), previsShotId: randomUUID() }; } },
    look: single('look', 'requestId'),
    still: single('still', 'requestId'),
    video: single('video', 'jobId'),
    sheet: {
      async submit(ctx) {
        admit(ctx, 'sheet');
        const requestIds = Array.from({ length: ctx.node.count || 1 }, () => randomUUID());
        await ctx.record({ requestIds, sheetId: 's' + randomUUID().slice(0, 8) });
        for (const id of requestIds) job(ctx, 'sheet', id);
        return { requestIds };
      },
      async finish() { return { referenceId: randomUUID() }; }, // the composed sheet
    },
  };
  return {
    drivers, submits,
    jobs: { async snapshot() { advance(); return { jobs: [...jobs.values()].map(({ outcome, finishAt, pool, ...j }) => structuredClone(j)), limits: Object.fromEntries(Object.entries(limits).map(([k, limit]) => [k, { limit, active: active(k) }])), tracker: { running: true, fake: true } }; } },
    all: () => [...jobs.values()],
  };
}

async function call(base, method, path, body) {
  const r = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(Error(j.error || `HTTP ${r.status}`), { status: r.status, apiCode: j.code, retryAfterSeconds: j.retryAfterSeconds });
  return j;
}

/** The job dashboard (contract C1) over loopback HTTP. */
export const loopbackJobs = base => ({ snapshot: () => call(base, 'GET', '/api/jobs') });

/**
 * TODO(S3 wave 2, after S1 + S2 merge): real drivers over loopback HTTP, in the style of server/previs/agent.mjs get/post.
 * Each paid driver must `await ctx.record({ requestId | jobId })` before the submit call that dispatches.
 * - blockout: POST /api/director/render-blockout { projectId, shotId } (C2) → { done: true, assetId, previsShotId }; 409 headless-unavailable → throw.
 * - look: refgen/prepare { projectId, entityId, presetId: node.model, prompt: lookPrompt(project, entity), aspect: '3:4', count: 1, seed }
 *   → record { requestId: job.id } → refgen/submit { approval: { approved, fingerprint, allowance: { currency: 'USD', maxAmount: node.estimateUsd, allowUnknownCharges: true } } };
 *   when node.target.family lists siblings, finish() sets their lookFrom to target.entityId (POST /api/director/edit update_entity).
 * - still: guide = POST /api/director/frame { projectId, shotId, t } (C2); refs/legend exactly as src/director.ts L906–935
 *   (videoReferences looks + previous shot's last frame); refgen/prepare { target: 'shot', frameAt: t, aspect: '16:9', referenceIds, guide } → submit.
 * - sheet: planSlots(setId) slots like agent.mjs generateSheet (patchSheets + one refgen job per slot, requestIds);
 *   finish() → POST /api/director/sheet/compose (C2) → { referenceId }.
 * - video: exactly agent.mjs generateVideo (video-refs → generation/bind → quote → submit), allowance node.estimateUsd.
 * Busy 409s surface as { apiCode: 'busy', retryAfterSeconds } from call() above and the scheduler retries them.
 */
export function loopbackDrivers(base) {
  void base;
  const todo = type => ({ async submit() { throw Error(`The ${type} batch driver is not wired yet (S3 wave 2). Use dryRun, or PREVIS_BATCH_FAKE=1 for a simulated run; nothing was sent.`); } });
  return { blockout: todo('blockout'), look: todo('look'), still: todo('still'), sheet: todo('sheet'), video: todo('video') };
}
