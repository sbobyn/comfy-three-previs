// Batch drivers. `fakeBackend()` simulates refgen/generation jobs and the job dashboard (tests, PREVIS_BATCH_FAKE=1);
// it never touches real job stores and never sends anything. `loopbackDrivers()` drives the real routes over loopback HTTP.
import { randomUUID } from 'node:crypto';
import { blockoutStale, castCard, keyStillState, lookPrompt, lookSource, objectLooks, objectNotes, videoReferences } from '../../shared/director.mjs';
import { stillReferences } from '../../shared/still-match.mjs';
import { cameraSourceOf, motionInput } from '../../shared/camera-source.mjs';
import { stillPromptPlan, videoPromptPlan } from '../../shared/prompt-plan.mjs';
import { autoPromptCap, resolveVideoParams } from '../../shared/model-params.mjs';
import { planSlots, setsFor, slotAspect, viewPrompt } from '../../shared/sheet-presets.mjs';
import { withReferenceImages, maxReferences } from '../../shared/video-refs.mjs';
import { clipSecondsFor, FIRST_FRAME_FALLBACK } from '../../shared/tiers.mjs';
import { keyframePlan, maxMiddleFrames, middleKeys, resolveFrame, withMiddleFrames } from '../../shared/keyframes.mjs';
import { lookAspect, videoKey, videoUses } from '../../shared/regen.mjs';
import { resolveImageParams } from '../../shared/model-params.mjs';

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
  // Like the real stores, a recorded id is resubmitted idempotently: a job that already exists is never sent again.
  const single = (type, key) => ({ async submit(ctx) { const had = ctx.node[key]; if (had && jobs.has(had)) return { [key]: had }; admit(ctx, type); const id = had || randomUUID(); if (!had) await ctx.record({ [key]: id }); job(ctx, type, id); return { [key]: id }; } });
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

const DRAFT = ['prepared', 'quoted', 'invalidated'];
const notSent = message => Object.assign(Error(message), { notDispatched: true });
const round = x => Math.round(x * 10000) / 10000;
const rid = () => Math.random().toString(36).slice(2, 10);
const randomSeed = () => Math.floor(Math.random() * 1e6);
const shotOf = (p, id) => p.shots.find(s => s.id === id) || fail(`Unknown shot ${id}`);
const entityOf = (p, id) => p.scene.entities.find(e => e.id === id) || fail(`Unknown object ${id}`);
function fail(message) { throw notSent(message); }

/**
 * A shot's final video prompt for a model, as the browser builds it (src/director-videogen.ts shotVideoPlan): the one
 * assembly in shared/prompt-plan.mjs (composed prompt with section overrides and locks, or the whole-prompt edit, plus the
 * camera line and, for a clip model, the reference legend), fitted to `maxLength`. `refs` are planner rows.
 */
export function videoPrompt(p, s, cameraSource, refs = [], maxLength) {
  return videoPromptPlan(p, s, { cameraSource, refs, maxLength }).text;
}

/**
 * Server-side video preparation shared by the batch and the MCP agent (server/previs/agent.mjs): registers the preset's
 * saved definition, registers the shot's references in the planner's order and builds the prompt exactly like the browser
 * (src/director-videogen.ts), then binds and quotes. Nothing is submitted. `get`/`post` call the loopback routes.
 * A start → end model whose shot has no end still is refused unless `startOnly` chooses its start-only sibling.
 */
export function videoPreparer({ get, post }) {
  // Engine-project writes are revision-checked; concurrent callers retry with a fresh revision.
  async function withRevision(fn) {
    for (let i = 0; ; i++) {
      try { return await fn((await get('/api/project')).project.revision); } catch (e) { if (e.status !== 409 || e.apiCode || !/Project changed/i.test(e.message) || i >= 9) throw e; await new Promise(r => setTimeout(r, 150 + Math.random() * 600)); }
    }
  }
  // Engine writes inside a route (video-refs registering renders) can lose a race with the job tracker attaching
  // results; the route is idempotent, so retry it on "Project changed".
  async function retryChanged(fn) {
    for (let i = 0; ; i++) {
      try { return await fn(); } catch (e) { if (!/Project changed/i.test(e.message) || i >= 9) throw e; await new Promise(r => setTimeout(r, 200 + Math.random() * 800)); }
    }
  }
  // Saved engine definition for a preset + reference count (src/director-videogen.ts definitionFor); one at a time so
  // concurrent shots share one saved copy. A built-in preset is saved (registered) here before its first bind.
  let defining = Promise.resolve();
  function definitionFor(base, refCount, middleCount = 0) {
    const run = defining.then(async () => {
      const presetId = base.provenance?.presetId || base.id;
      // Timed in-between key frames (shared/keyframes.mjs) are extra image inputs on a start → end model; the graph comparison tells variants apart.
      const wanted = withMiddleFrames(withReferenceImages({ ...base, provenance: { ...(base.provenance || {}), presetId } }, refCount), middleCount), n = wanted.provenance?.referenceImages || 0;
      const same = d => (d.provenance?.presetId === presetId || d.id === presetId) && (d.provenance?.referenceImages || 0) === n && JSON.stringify(d.graph) === JSON.stringify(wanted.graph);
      const saved = ((await get('/api/generation')).definitions || []).find(same);
      return saved || (await withRevision(revision => post('/api/generation/preset', { revision, definition: wanted }))).definition;
    });
    defining = run.catch(() => {});
    return run;
  }
  // Bind + quote one shot exactly like the browser (src/director-videogen.ts prepareShotVideo / prepareFirstFrame).
  async function prepare(p, s, { model, useReferences = true, startOnly = false }) {
    const gen = await get('/api/generation'), r = s.render;
    const pick = id => (gen.presets || []).find(d => d.id === id) || (gen.definitions || []).find(d => d.id === id);
    let base = pick(model); if (!base) throw notSent(`Unknown video model ${model}`);
    let assetBindings, prompt, refs = [];
    let def, parameters, registered = [], seconds = r.duration ?? s.duration, cameraFor, planRefs = [], keyframes = null;
    if (base.task === 'first-frame') {
      let wantsLast = !!base.inputs?.lastFrame;
      // No current end still: only an explicit choice (startOnly) animates the start still alone with the start-only sibling.
      const sibling = wantsLast && FIRST_FRAME_FALLBACK[base.id] && keyStillState(p, s).endState !== 'ready' ? pick(FIRST_FRAME_FALLBACK[base.id]) : null;
      if (sibling && startOnly) { base = sibling; wantsLast = false; }
      // Pinned in-between frames go to models that take them (Kling 4.0); keyframePlan says where each lands.
      const middleCount = wantsLast ? Math.min(maxMiddleFrames(base), middleKeys(s).length) : 0;
      const frames = (await retryChanged(() => post('/api/director/video-refs', { projectId: p.id, shotId: s.id, previsShotId: r.previsShotId, max: 2, firstFrame: true, lastFrame: wantsLast, ...(middleCount ? { middleFrames: middleCount } : {}) }))).references;
      let start = frames.find(x => x.label === 'start key frame')?.renderId; const end = frames.find(x => x.label === 'end key frame')?.renderId;
      if (wantsLast && (!start || !end)) throw Object.assign(notSent(`This model animates start → end: the shot needs ${!start && !end ? 'start and end key frames' : !start ? 'a start key frame' : 'an end key frame'}${sibling && start ? `, or choose to animate the start still alone with ${sibling.title.split(' · ')[0]} (camera from one still, approximate)` : ''}`), { startOnly: sibling && start ? sibling.id : null });
      if (!start) start = (await get('/api/project')).project.renders?.find(x => x.shotId === r.previsShotId && x.pass === 'beauty')?.id;
      if (!start) throw notSent('No start image: generate a key frame for this shot, or render the blockout again');
      const mids = frames.filter(x => /^middle key frame \d+$/.test(x.label));
      def = await definitionFor(base, 0, mids.length);
      // Graph defaults, the clip length nearest the shot (or the shot's saved one) and its saved seed, as the browser binds them.
      const resolved = resolveVideoParams(def, s); parameters = resolved.parameters; seconds = resolved.seconds ?? clipSecondsFor(base, s.duration);
      assetBindings = { firstFrame: { renderId: start }, ...(wantsLast ? { lastFrame: { renderId: end } } : {}), ...Object.fromEntries(mids.map((x, i) => [`middleFrame${i + 1}`, { renderId: x.renderId }])) };
      keyframes = keyframePlan(p, s, base, { seconds });
      cameraFor = wantsLast ? 'keyframes' : 'still';
    } else {
      const cap = useReferences === false ? 0 : maxReferences(base);
      // The blockout clip is the camera; the start (and end) still lead the reference images as the look, then the cast.
      registered = cap ? (await retryChanged(() => post('/api/director/video-refs', { projectId: p.id, shotId: s.id, previsShotId: r.previsShotId, max: cap, stills: cameraSourceOf(base) === 'blockout' }))).references : [];
      const all = [...(p.scene.references || []), ...p.shots.flatMap(x => x.references)];
      refs = registered.map(x => ({ ref: all.find(y => y.id === x.referenceId), entityId: x.entityId, role: x.role, label: x.label })).filter(x => x.ref);
      def = await definitionFor(base, registered.length); parameters = resolveVideoParams(def, s).parameters;
      assetBindings = { [motionInput(def) || 'sourceVideo']: { assetId: r.assetId }, ...Object.fromEntries(registered.map((x, i) => [`referenceImage${i + 1}`, { renderId: x.renderId }])) };
      cameraFor = cameraSourceOf(def); planRefs = refs;
    }
    // The shared assembly, fitted to the model's limit: keeps the camera line and the reference legend.
    const plan = videoPromptPlan(p, s, { cameraSource: cameraFor, refs: planRefs, maxLength: def.constraints?.promptMaxLength, cap: autoPromptCap(def), model: base.title?.split(' · ')[0] || base.id });
    prompt = plan.text;
    const local = def.id.startsWith('wan-') || def.provenance?.presetId?.startsWith('wan-');
    // What this take is made from (shared/regen.mjs), recorded on the result so a later change says what it invalidates.
    const regen = videoKey(p, s, { def: base, model: base.provenance?.presetId || base.id, cameraSource: cameraFor, uses: videoUses(base) });
    // Bind and quote are both revision-checked; concurrent batches can move the revision in between, so retry them together.
    return withRevision(async revision => {
      const bind = await post('/api/generation/bind', { revision, definitionId: def.id, shotId: r.previsShotId, assetBindings, prompt, parameters, acceptTimingChange: true, regen });
      const request = { requestId: randomUUID(), revision: bind.project.revision, workflowBindingId: bind.workflowBindingId, backend: { kind: local ? 'local' : 'cloud' } };
      const job = (await post('/api/generation/quote', request)).job;
      const cameraSource = job.cameraSource || cameraSourceOf(def, assetBindings);
      return { request, job, def, modelUsed: base.id, cameraSource, prompt, plan, refs: registered, seconds, regen, ...(keyframes ? { keyframes } : {}), promptWarning: plan.cameraWarning };
    });
  }
  return { definitionFor, prepare };
}

/**
 * Real drivers over loopback HTTP (the routes the browser and agent use). Paid drivers record { requestId | jobId | requestIds }
 * and the approved fingerprint before the submit call that dispatches, so a restart resubmits the same saved request; both
 * stores answer a resubmit of a non-draft request with the saved job, so nothing is ever sent twice. Completion comes from the
 * job dashboard (C1). An HTTP refusal of a submit whose request is still a draft is `notDispatched` (safe to fail and redo);
 * a dropped connection is not, and the dashboard decides. Busy 409s ({ apiCode: 'busy', retryAfterSeconds }) go to the scheduler.
 * Every submit carries an allowance capped at the batch's remaining budget, and a known quote above it is refused here first.
 * Sheets (partial-slot policy): every view of the set is quoted and listed on the object's new sheet, then sent; a view the
 * server refuses is marked "Not sent" and the rest go ahead. The sheet is composed (C2) only when every view has an image;
 * otherwise the node ends done with `partial`, and the views that landed stay on the sheet to retry or compose in Design sheet.
 * A done paid node is never redone by resume, so finishing steps (family links, compose) never fail a node.
 */
export function loopbackDrivers(base) {
  const get = path => call(base, 'GET', path), post = (path, body) => call(base, 'POST', path, body);
  const headroom = ctx => Math.max(0, round(ctx.batch.maxCostUsd - ctx.batch.spentEstimateUsd + (ctx.node.reserved || 0)));
  const approval = (ctx, fingerprint) => ({ approved: true, fingerprint, allowance: { currency: 'USD', maxAmount: headroom(ctx), allowUnknownCharges: true } });
  function checkQuote(ctx, quote, what = 'Quote') {
    if (quote?.status === 'known' && quote.amount > headroom(ctx) + 1e-9) throw notSent(`${what} $${quote.amount} is above the batch’s remaining budget $${headroom(ctx).toFixed(2)}; nothing was sent`);
  }
  const refgenJob = async (projectId, id) => (await get(`/api/director/refgen?projectId=${projectId}`)).jobs.find(j => j.id === id);
  const generationJob = async id => (await get('/api/generation')).jobs.find(j => j.id === id);
  // One submit. When the server answers with an error and the saved request is still a draft (or never saved), nothing was sent.
  async function send(submit, lookup) {
    try { return await submit(); } catch (e) {
      if (e.apiCode === 'busy' || !e.status) throw e;
      const job = await lookup().catch(() => null);
      if (job === undefined || (job && (DRAFT.includes(job.status) || (job.status === 'failed' && job.failure?.phase === 'preparation')))) e.notDispatched = true;
      throw e;
    }
  }
  async function patchSheets(projectId, entityId, fn) {
    const p = (await get(`/api/director/project?id=${projectId}`)).project, e = entityOf(p, entityId), sheets = structuredClone(e.sheets || []);
    fn(sheets);
    await post('/api/director/edit', { projectId, ops: [{ op: 'update_entity', id: entityId, patch: { sheets } }] });
  }
  // One refgen image request: prepare (quote only) → record → submit; a recorded request is resubmitted, re-quoted once if refused.
  async function refgen(ctx, projectId, body) {
    for (let fresh = !ctx.node.requestId; ; fresh = true) {
      if (fresh) {
        const job = (await post('/api/director/refgen/prepare', await body())).job;
        checkQuote(ctx, job.quote);
        await ctx.record({ requestId: job.id, fingerprint: job.fingerprint });
      }
      const { requestId, fingerprint } = ctx.node;
      try {
        const job = (await send(() => post('/api/director/refgen/submit', { projectId, requestId, approval: approval(ctx, fingerprint) }), () => refgenJob(projectId, requestId))).job;
        return { requestId: job.id };
      } catch (e) { if (fresh || !e.notDispatched) throw e; await ctx.record({ requestId: undefined, fingerprint: undefined }); }
    }
  }
  const presets = async projectId => (await get(`/api/director/refgen?projectId=${projectId}`)).presets || [];

  const videos = videoPreparer({ get, post });
  const prepareVideo = (ctx, p, s) => videos.prepare(p, s, { model: ctx.node.model, startOnly: true });

  return {
    blockout: {
      async submit(ctx) {
        const r = await post('/api/director/render-blockout', { projectId: ctx.batch.projectId, shotId: ctx.node.target.shotId });
        return { done: true, assetId: r.asset?.id, previsShotId: r.previsShotId, ...(r.skipped ? { note: 'Already rendered' } : {}) };
      },
    },
    look: {
      async submit(ctx) {
        const p = await ctx.project(), e = entityOf(p, ctx.node.target.entityId);
        return refgen(ctx, p.id, async () => ({ projectId: p.id, entityId: e.id, presetId: ctx.node.model, prompt: lookPrompt(p, e), aspect: lookAspect(e), count: 1, seed: randomSeed() }));
      },
      // Family members (same-shape siblings) share the new look instead of each getting their own.
      async finish(ctx, list) {
        const p = await ctx.project(), src = ctx.node.target.entityId, family = ctx.node.target.family || [];
        // A look made again (its Cast Card, prompt or model changed) becomes the primary image; the older one stays as a version.
        const made = list?.flatMap(j => j.results || []).find(r => r.id)?.id, e = p.scene.entities.find(x => x.id === src);
        const primary = made && e && objectLooks(p, src)[0]?.id !== made && (p.scene.references || []).some(r => r.id === made && r.entityId === src) ? [{ op: 'set_look', entityId: src, referenceId: made }] : [];
        const ops = [...primary, ...family.filter(id => id !== src && p.scene.entities.some(e => e.id === id) && lookSource(p, id)?.id !== src).map(id => ({ op: 'update_entity', id, patch: { lookFrom: src } }))];
        if (ops.length) await post('/api/director/edit', { projectId: p.id, ops });
        return family.length || primary.length ? { linked: ops.length - primary.length, ...(primary.length ? { primary: made } : {}) } : null;
      },
    },
    still: {
      // The blockout frame at t is image 1 (composition guide); the cast's looks and the previous shot's last still follow (src/director.ts).
      async submit(ctx) {
        const p = await ctx.project(), s = shotOf(p, ctx.node.target.shotId), at = ctx.node.target.t;
        return refgen(ctx, p.id, async () => {
          // One encoded blockout frame (shared/keyframes.mjs): "end" is the clip's last frame; the guide, words and grade use it.
          const f = resolveFrame(p, s, { at }), t = f.t;
          const cap = (await presets(p.id)).find(x => x.id === ctx.node.model)?.maxRefs || 0;
          const looks = stillReferences(p, s, t, cap).looks; // objects in frame, one environment image
          const prev = p.shots[p.shots.indexOf(s) - 1]?.references.filter(r => r.role === 'frame').at(-1);
          const refIds = [...looks.map(r => r.ref.id), ...(prev ? [prev.id] : [])].slice(0, Math.max(0, cap - 1));
          const frame = await post('/api/director/frame', { projectId: p.id, shotId: s.id, t, guide: true });
          // A Blender guide (blender-import) has no proxy markers, so the prompt does not explain them.
          const prompt = stillPromptPlan({ project: p, shot: s, t, presetId: ctx.node.model, looks: looks.slice(0, refIds.length), prevImage: prev && refIds.includes(prev.id) ? refIds.indexOf(prev.id) + 2 : null, markers: frame.source !== 'blender' }).text;
          return { projectId: p.id, target: 'shot', shotId: s.id, frameAt: f.frameAt, frame: f.index, presetId: ctx.node.model, prompt, aspect: '16:9', count: 1, seed: resolveImageParams(ctx.node.model, s).seed ?? randomSeed(), referenceIds: refIds, guide: frame.data };
        });
      },
    },
    sheet: {
      async submit(ctx) {
        const p = await ctx.project(), e = entityOf(p, ctx.node.target.entityId), model = ctx.node.model;
        if (!ctx.node.requestIds?.length) {
          const identity = objectLooks(p, e.id)[0]; if (!identity) throw notSent(`${e.name} has no image yet; nothing was sent`);
          const set = setsFor(e.kind).find(x => x.id === ctx.node.target.setId); if (!set) throw notSent(`Set ${ctx.node.target.setId} is not offered for a ${e.kind}`);
          if ((e.sheets || []).length >= 8) throw notSent(`${e.name} already has 8 sheets; nothing was sent`);
          const slots = planSlots(set.id, e.kind), card = castCard(p, e.id), sheetId = 's' + rid(), at = new Date().toISOString(), jobs = [];
          for (const s of slots) {
            const seed = randomSeed(), prompt = viewPrompt({ kind: e.kind, spec: s.spec, description: objectNotes(p, e), styleNotes: card?.styleNotes, projectStyle: p.scene.environment?.style, note: '' });
            jobs.push({ seed, job: (await post('/api/director/refgen/prepare', { projectId: p.id, entityId: e.id, presetId: model, prompt, aspect: slotAspect(s.spec, e.kind), count: 1, seed, referenceIds: [identity.id], sheet: { sheetId, slotId: s.id, label: s.label } })).job });
          }
          const quotes = jobs.map(x => x.job.quote);
          checkQuote(ctx, quotes.every(q => q?.status === 'known') ? { status: 'known', amount: round(quotes.reduce((t, q) => t + q.amount, 0)) } : null, `${slots.length} views quoted`);
          await patchSheets(p.id, e.id, sheets => sheets.push({ id: sheetId, setId: set.id, label: set.label, options: {}, presetId: model, createdAt: at,
            slots: slots.map((s, i) => { const id = rid(); return { ...s, attempts: [{ id, requestId: jobs[i].job.id, referenceId: null, mode: 'generate', note: '', from: null, presetId: model, seed: jobs[i].seed, error: '', createdAt: at }], selected: id, accepted: null }; }) }));
          await ctx.record({ sheetId, requestIds: jobs.map(x => x.job.id), fingerprints: jobs.map(x => x.job.fingerprint) });
        }
        const { requestIds, fingerprints } = ctx.node, sent = [], unsent = [];
        for (const [i, requestId] of requestIds.entries()) {
          try { await send(() => post('/api/director/refgen/submit', { projectId: p.id, requestId, approval: approval(ctx, fingerprints[i]) }), () => refgenJob(p.id, requestId)); sent.push(requestId); }
          catch (err) { if (!err.notDispatched) throw err; unsent.push({ requestId, error: err.message, code: err.apiCode }); }
        }
        if (!sent.length) throw Object.assign(notSent(`No view was sent: ${unsent[0]?.error || 'refused'}`), unsent.every(u => u.code === 'budget') ? { apiCode: 'budget' } : {});
        if (!unsent.length) return { requestIds };
        await patchSheets(p.id, e.id, sheets => { for (const slot of sheets.find(x => x.id === ctx.node.sheetId)?.slots || []) for (const a of slot.attempts) { const u = unsent.find(x => x.requestId === a.requestId); if (u) a.error = `Not sent: ${u.error}`.slice(0, 300); } });
        return { requestIds: sent, unsent: unsent.map(x => x.requestId), error: `${unsent.length} of ${requestIds.length} views not sent: ${unsent[0].error}`.slice(0, 500) };
      },
      async finish(ctx, list) {
        const byId = new Map(list.map(j => [j.id, j])), { batch: { projectId }, node } = ctx;
        let missing = 0, total = 0;
        await patchSheets(projectId, node.target.entityId, sheets => {
          for (const slot of sheets.find(x => x.id === node.sheetId)?.slots || []) {
            total++;
            for (const a of slot.attempts) { const j = byId.get(a.requestId); if (!j) continue; if (j.status === 'completed' && j.results?.[0]?.id) a.referenceId = j.results[0].id; else a.error = String(j.failure?.detail || `Image ${j.status}`).slice(0, 300); }
            if (!slot.attempts.some(a => a.referenceId)) missing++;
          }
        });
        if (missing) return { partial: true, note: `Not composed: ${missing} of ${total} views have no image. Retry them in Design sheet, then Compose.` };
        try { return { referenceId: (await post('/api/director/sheet/compose', { projectId, entityId: node.target.entityId, sheetId: node.sheetId })).referenceId, composed: true }; }
        catch (e) { return { composed: false, note: `Views saved; compose in Design sheet (${String(e.message).slice(0, 200)})` }; }
      },
    },
    video: {
      async submit(ctx) {
        const p = await ctx.project(), s = shotOf(p, ctx.node.target.shotId);
        for (let fresh = !(ctx.node.jobId && ctx.node.submitRequest); ; fresh = true) {
          if (fresh) {
            if (!s.render) throw notSent('The shot’s blockout is not rendered; nothing was sent');
            if (blockoutStale(p, s)) throw notSent('The shot changed since its blockout was made; make the blockout again (nothing was sent)');
            const { request, job, modelUsed, cameraSource } = await prepareVideo(ctx, p, s);
            checkQuote(ctx, job.quote);
            await ctx.record({ jobId: request.requestId, submitRequest: { ...request, fingerprint: job.fingerprint }, modelUsed, cameraSource });
          }
          const { fingerprint, ...request } = ctx.node.submitRequest;
          try {
            const job = (await send(() => post('/api/generation/submit', { ...request, approval: approval(ctx, fingerprint) }), () => generationJob(request.requestId))).job;
            return { jobId: job.id };
          } catch (e) { if (fresh || !e.notDispatched) throw e; await ctx.record({ jobId: undefined, submitRequest: undefined }); }
        }
      },
    },
  };
}
