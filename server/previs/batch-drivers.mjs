// Batch drivers. `fakeBackend()` simulates refgen/generation jobs and the job dashboard (tests, PREVIS_BATCH_FAKE=1);
// it never touches real job stores and never sends anything. `loopbackDrivers()` drives the real routes over loopback HTTP.
import { randomUUID } from 'node:crypto';
import { castCard, compilePrompt, lookPrompt, lookSource, objectLooks, objectNotes, referenceLegend, videoReferences } from '../../shared/director.mjs';
import { shotPrompt } from '../../shared/prompt.mjs';
import { cameraSourceOf, withCameraLine } from '../../shared/camera-source.mjs';
import { planSlots, setsFor, slotAspect, viewPrompt } from '../../shared/sheet-presets.mjs';
import { withReferenceImages, maxReferences } from '../../shared/video-refs.mjs';
import { snapSeconds, FIRST_FRAME_FALLBACK } from '../../shared/tiers.mjs';

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
const lookAspect = e => (e.kind === 'character' ? '3:4' : e.kind === 'environment' ? '16:9' : '4:3'); // src/director-looks.ts aspectFor, default view

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
  // Engine-project writes are revision-checked; concurrent nodes retry with a fresh revision.
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

  // Saved engine definition for a preset + reference count (src/director-videogen.ts definitionFor); one at a time so
  // concurrent shots share one saved copy.
  let defining = Promise.resolve();
  function definitionFor(base, refCount) {
    const run = defining.then(async () => {
      const presetId = base.provenance?.presetId || base.id;
      const wanted = withReferenceImages({ ...base, provenance: { ...(base.provenance || {}), presetId } }, refCount), n = wanted.provenance?.referenceImages || 0;
      const same = d => (d.provenance?.presetId === presetId || d.id === presetId) && (d.provenance?.referenceImages || 0) === n && JSON.stringify(d.graph) === JSON.stringify(wanted.graph);
      const saved = ((await get('/api/generation')).definitions || []).find(same);
      return saved || (await withRevision(revision => post('/api/generation/preset', { revision, definition: wanted }))).definition;
    });
    defining = run.catch(() => {});
    return run;
  }
  // Bind + quote one shot exactly like the browser (src/director-videogen.ts prepareShotVideo / prepareFirstFrame).
  async function prepareVideo(ctx, p, s) {
    const gen = await get('/api/generation'), r = s.render;
    const pick = id => (gen.presets || []).find(d => d.id === id) || (gen.definitions || []).find(d => d.id === id);
    let base = pick(ctx.node.model); if (!base) throw notSent(`Unknown video model ${ctx.node.model}`);
    let assetBindings, prompt, refs = [];
    const parametersOf = def => Object.fromEntries(Object.entries(def.parameters || {}).map(([k, m]) => [k, def.graph?.[m.nodeId]?.inputs?.[m.input]]));
    let def, parameters;
    if (base.task === 'first-frame') {
      let wantsLast = !!base.inputs?.lastFrame;
      const frames = (await retryChanged(() => post('/api/director/video-refs', { projectId: p.id, shotId: s.id, previsShotId: r.previsShotId, max: 2, firstFrame: true, lastFrame: wantsLast }))).references;
      let start = frames.find(x => x.label === 'start key frame')?.renderId; const end = frames.find(x => x.label === 'end key frame')?.renderId;
      if (wantsLast && !end && FIRST_FRAME_FALLBACK[base.id] && pick(FIRST_FRAME_FALLBACK[base.id])) { base = pick(FIRST_FRAME_FALLBACK[base.id]); wantsLast = false; }
      if (wantsLast && (!start || !end)) throw notSent('This model animates start → end: the shot needs both key frames');
      if (!start) start = (await get('/api/project')).project.renders?.find(x => x.shotId === r.previsShotId && x.pass === 'beauty')?.id;
      if (!start) throw notSent('No start image: generate a key frame for this shot, or render the blockout again');
      def = await definitionFor(base, 0); parameters = parametersOf(def);
      if ('duration' in parameters) parameters.duration = String(snapSeconds(s.duration));
      assetBindings = { firstFrame: { renderId: start }, ...(wantsLast ? { lastFrame: { renderId: end } } : {}) };
      const cameraSource = wantsLast ? 'keyframes' : 'still';
      prompt = withCameraLine(shotPrompt(p, s, 'video', { cameraSource }).trim() || compilePrompt(p, s, null, { cameraSource }), cameraSource);
    } else {
      const cap = maxReferences(base);
      const registered = cap ? (await retryChanged(() => post('/api/director/video-refs', { projectId: p.id, shotId: s.id, previsShotId: r.previsShotId, max: cap }))).references : [];
      const all = [...(p.scene.references || []), ...p.shots.flatMap(x => x.references)];
      refs = registered.map(x => ({ ref: all.find(y => y.id === x.referenceId), entityId: x.entityId, role: x.role, label: x.label })).filter(x => x.ref);
      def = await definitionFor(base, registered.length); parameters = parametersOf(def);
      assetBindings = { [def.inputs?.controlVideo ? 'controlVideo' : 'sourceVideo']: { assetId: r.assetId }, ...Object.fromEntries(registered.map((x, i) => [`referenceImage${i + 1}`, { renderId: x.renderId }])) };
      const cameraSource = cameraSourceOf(def), auto = compilePrompt(p, s, null, { cameraSource }), user = shotPrompt(p, s, 'video', { cameraSource });
      prompt = user?.trim() && user.trim() !== auto.trim() ? [withCameraLine(user, cameraSource), referenceLegend(refs)].filter(Boolean).join('\n') : compilePrompt(p, s, refs, { cameraSource });
    }
    const maxLen = def.constraints?.promptMaxLength; if (Number.isInteger(maxLen) && prompt.length > maxLen) prompt = prompt.slice(0, maxLen);
    const local = def.id.startsWith('wan-') || def.provenance?.presetId?.startsWith('wan-');
    // Bind and quote are both revision-checked; concurrent batches can move the revision in between, so retry them together.
    return withRevision(async revision => {
      const bind = await post('/api/generation/bind', { revision, definitionId: def.id, shotId: r.previsShotId, assetBindings, prompt, parameters, acceptTimingChange: true });
      const request = { requestId: randomUUID(), revision: bind.project.revision, workflowBindingId: bind.workflowBindingId, backend: { kind: local ? 'local' : 'cloud' } };
      const job = (await post('/api/generation/quote', request)).job;
      return { request, job, modelUsed: base.id };
    });
  }

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
      async finish(ctx) {
        const family = ctx.node.target.family; if (!family?.length) return null;
        const p = await ctx.project(), src = ctx.node.target.entityId;
        const ops = family.filter(id => id !== src && p.scene.entities.some(e => e.id === id) && lookSource(p, id)?.id !== src).map(id => ({ op: 'update_entity', id, patch: { lookFrom: src } }));
        if (ops.length) await post('/api/director/edit', { projectId: p.id, ops });
        return { linked: ops.length };
      },
    },
    still: {
      // The blockout frame at t is image 1 (composition guide); the cast's looks and the previous shot's last still follow (src/director.ts).
      async submit(ctx) {
        const p = await ctx.project(), s = shotOf(p, ctx.node.target.shotId), at = ctx.node.target.t;
        return refgen(ctx, p.id, async () => {
          const t = at === 'start' ? 0 : at === 'end' ? s.duration : Number(at);
          const cap = (await presets(p.id)).find(x => x.id === ctx.node.model)?.maxRefs || 0;
          const looks = cap ? videoReferences(p, s, cap).filter(r => r.role !== 'frame' && r.role !== 'style') : [];
          const prev = p.shots[p.shots.indexOf(s) - 1]?.references.filter(r => r.role === 'frame').at(-1);
          const refIds = [...looks.map(r => r.ref.id), ...(prev ? [prev.id] : [])].slice(0, Math.max(0, cap - 1));
          const legend = `\nImage 1 is a grey 3D blockout of this exact frame: match its camera, lens, framing and every object's position and pose, not its grey look or labels. ${looks.slice(0, refIds.length).map((r, i) => `The ${r.label} looks exactly like image ${i + 2}.`).join(' ')}${prev && refIds.includes(prev.id) ? ` Image ${refIds.indexOf(prev.id) + 2} is the previous shot: keep lighting and style continuous.` : ''} No text, captions or labels.`;
          const guide = (await post('/api/director/frame', { projectId: p.id, shotId: s.id, t })).data;
          return { projectId: p.id, target: 'shot', shotId: s.id, frameAt: at, presetId: ctx.node.model, prompt: (shotPrompt(p, s, 'image').trim() + legend).slice(0, 2500), aspect: '16:9', count: 1, seed: randomSeed(), referenceIds: refIds, guide };
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
          catch (err) { if (!err.notDispatched) throw err; unsent.push({ requestId, error: err.message }); }
        }
        if (!sent.length) throw notSent(`No view was sent: ${unsent[0]?.error || 'refused'}`);
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
            const { request, job, modelUsed } = await prepareVideo(ctx, p, s);
            checkQuote(ctx, job.quote);
            await ctx.record({ jobId: request.requestId, submitRequest: { ...request, fingerprint: job.fingerprint }, modelUsed });
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
