// Batch generation (contract C3): plan a director project's blockouts, looks, sheets, stills and videos as a
// dependency graph, then submit nodes as backend slots and the batch budget allow. Drivers do the work (loopback HTTP
// on a real server, fakes in tests); job outcomes come from the job dashboard (contract C1, GET /api/jobs).
// Estimates are list prices; a node with an unknown price is never submitted. Nothing is resent after an uncertain outcome.
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson } from './atomic.mjs';
import { assertNoSecrets } from './workflows.mjs';
import { builtInPresets } from './presets.mjs';
import { blockoutStale, castRows, lookSource, objectLooks } from '../../shared/director.mjs';
import { cameraSourceOf, CAMERA_SOURCE_LABELS } from '../../shared/camera-source.mjs';
import { maxReferences } from '../../shared/video-refs.mjs';
import { planSlots } from '../../shared/sheet-presets.mjs';
import { TIERS, modelsFor, estimateFor, VIDEO_PRICES, FIRST_FRAME_FALLBACK } from '../../shared/tiers.mjs';

export const STEPS = ['looks', 'sheets', 'stills', 'videos'];
const uuid = /^[a-f0-9-]{36}$/;
const SATISFIED = ['done', 'skipped'], ENDED = ['done', 'skipped', 'failed', 'budget'], OPEN = ['waiting', 'ready', 'running'];
const PRIORITY = { video: 0, still: 1, blockout: 2, sheet: 3, look: 4 };
const SHEET_SET = { character: 'turn4', vehicle: 'obj-turn4', prop: 'obj-turn4', environment: 'establishing' };
const DEFAULT_LIMITS = { 'cloud:image': 4, 'cloud:video': 3, local: 1, headless: 1 };
const MAX_EVENTS = 300;
const iso = t => new Date(t).toISOString();
const usd = x => `$${(Math.round((x || 0) * 100) / 100).toFixed(2)}`;
function fail(message, status = 400) { const e = Error(message); e.status = status; throw e; }

// ---------- Planning (pure) ----------
const shotName = (p, s) => `Shot ${String(p.shots.indexOf(s) + 1).padStart(2, '0')} ${s.title}`;
const atLabel = at => (typeof at === 'number' ? `${at}s` : at);
const atKey = at => (typeof at === 'number' ? `@${at}` : at);
function hasStill(shot, at) {
  const notes = (shot.references || []).filter(r => r.role === 'frame').map(r => r.note || '');
  return at === 'start' ? notes.some(n => n === 'key frame start' || !n) : at === 'end' ? notes.includes('key frame end') : notes.includes(`key frame @${at}s`);
}
function videoNeeds(def) {
  if (!def) return null;
  return { keyFrames: def.task === 'first-frame' ? ['start', ...(def.inputs?.lastFrame ? ['end'] : [])] : [], references: def.task !== 'first-frame', local: def.id.startsWith('wan-') || VIDEO_PRICES[def.id]?.local === true, camera: cameraSourceOf(def) };
}
const ids = (v, what) => {
  if (v == null) return null;
  if (!Array.isArray(v) || v.some(x => !uuid.test(String(x)))) fail(`${what} must be a list of ids`);
  return v.length ? [...new Set(v.map(String))] : null;
};

export function normalizeInput(input = {}) {
  const steps = [...new Set(Array.isArray(input.steps) ? input.steps : [])];
  if (!steps.length || steps.some(s => !STEPS.includes(s))) fail(`Choose steps from ${STEPS.join(', ')}`);
  if (input.tier != null && !TIERS[input.tier]) fail('Tier must be draft or final');
  const maxCostUsd = Number(input.maxCostUsd);
  if (input.maxCostUsd === null || input.maxCostUsd === '' || !Number.isFinite(maxCostUsd) || maxCostUsd < 0) fail('maxCostUsd is required (USD, 0 or more)');
  const stillsAt = input.stillsAt == null ? null : (Array.isArray(input.stillsAt) ? input.stillsAt : [input.stillsAt]).map(x => (x === 'start' || x === 'end' ? x : Number.isFinite(Number(x)) && x !== '' && x !== null && Number(x) >= 0 ? Math.round(Number(x) * 100) / 100 : fail('stillsAt takes start, end or seconds')));
  const tier = input.tier || 'draft';
  return { steps: STEPS.filter(s => steps.includes(s)), tier, models: modelsFor(tier, input.models), maxCostUsd, shots: ids(input.shots, 'shots'), objects: ids(input.objects, 'objects'), stillsAt: stillsAt?.length ? [...new Set(stillsAt)] : null, dryRun: input.dryRun === true };
}

/**
 * Plan nodes and deps for one project. Blockouts are planned for shots that need a video (skipped when already rendered),
 * looks for cast objects without an image, sheets per object, stills per shot at `stillsAt` (skipped when that key frame exists),
 * videos per shot (deps: blockout + key-frame stills for first-frame models, or optional looks for reference models).
 */
export function planBatch(project, raw, { definitions = builtInPresets } = {}) {
  const input = normalizeInput(raw), { steps, models } = input, want = s => steps.includes(s);
  for (const [step, type] of [['looks', 'look'], ['sheets', 'sheet'], ['stills', 'still']]) if (want(step) && estimateFor(type, models[step]) == null) fail(`Unknown or unpriced image model ${models[step]} for ${step}`);
  const shots = input.shots ? input.shots.map(id => project.shots.find(s => s.id === id) || fail(`Unknown shot ${id}`, 404)) : project.shots;
  const entity = id => project.scene.entities.find(e => e.id === id);
  const objects = input.objects ? input.objects.map(id => entity(id) || fail(`Unknown object ${id}`, 404)) : null;
  const def = want('videos') ? definitions.find(d => d.id === models.videos) : null;
  if (want('videos') && !def) fail(`Unknown video model ${models.videos}`);
  const needs = videoNeeds(def);
  // A model that follows the blockout clip takes the start and end stills as its look.
  const lookStills = needs?.camera === 'blockout' && maxReferences(def) > 0;
  const stillsAt = input.stillsAt || ['start', ...(needs?.keyFrames.includes('end') || lookStills ? ['end'] : [])];
  const nodes = [], byId = new Map();
  const add = n => { const node = { status: 'waiting', deps: [], estimateUsd: 0, ...n }; if (!node.optional?.length) delete node.optional; nodes.push(node); byId.set(node.id, node); return node; };
  const cast = s => castRows(project, s).filter(r => r.inCast).map(r => r.entity);
  const source = e => lookSource(project, e.id) || e;
  // A look family: objects sharing a look, or same-shape siblings in a group (40 pines in a forest need one look, not 40).
  const familyKey = e => { const src = source(e); return src.id !== e.id || !e.parent ? src.id : `${e.parent}|${e.kind}|${e.shape}`; };
  const families = new Map();
  for (const e of project.scene.entities) { const k = familyKey(e); if (!families.has(k)) families.set(k, []); families.get(k).push(e); }
  const imaged = k => families.get(k).some(e => objectLooks(project, e.id).length);

  // Looks: one per family without any image yet.
  const lookNode = new Map();
  if (want('looks')) {
    const pool = objects || shots.flatMap(cast);
    for (const e of pool) {
      const k = familyKey(e); if (lookNode.has(k) || imaged(k)) continue;
      const src = source(e), size = families.get(k).length;
      lookNode.set(k, add({ id: `look:${src.id}`, type: 'look', label: `Look · ${src.name}${size > 1 && src.id === e.id && e.parent ? ` (shared by ${size})` : ''}`, target: { entityId: src.id, ...(size > 1 ? { family: families.get(k).map(x => x.id) } : {}) }, model: models.looks, estimateUsd: estimateFor('look', models.looks) }));
    }
  }
  const looksFor = es => [...new Set(es.map(e => lookNode.get(familyKey(e))?.id).filter(Boolean))];
  // Sheets: one per object (look source), default set by kind; needs the object's look.
  if (want('sheets')) {
    const pool = objects || shots.flatMap(cast).filter(e => e.kind !== 'environment');
    for (const e of new Map(pool.map(x => [familyKey(x), source(x)])).values()) {
      const setId = SHEET_SET[e.kind] || 'obj-turn4', count = planSlots(setId, e.kind).length, look = lookNode.get(familyKey(e));
      const n = add({ id: `sheet:${e.id}`, type: 'sheet', label: `Sheet · ${e.name}`, target: { entityId: e.id, setId }, model: models.sheets, count, estimateUsd: estimateFor('sheet', models.sheets, { count }), deps: look ? [look.id] : [] });
      if (!look && !imaged(familyKey(e))) Object.assign(n, { status: 'failed', planError: true, error: `${e.name} needs a look first; add the looks step` });
    }
  }
  for (const s of shots) {
    const name = shotName(project, s), castLooks = looksFor(cast(s));
    // A stale blockout is made again: it is the camera the video follows.
    const blockout = want('videos') ? add({ id: `blockout:${s.id}`, type: 'blockout', label: `${name} · blockout`, target: { shotId: s.id }, ...(s.render && !blockoutStale(project, s) ? { status: 'skipped', assetId: s.render.assetId, note: 'Already rendered' } : s.render ? { note: 'Scene changed since; made again' } : {}) }) : null;
    const still = new Map();
    if (want('stills')) for (const at of stillsAt) {
      if (typeof at === 'number' && at > s.duration) continue;
      still.set(at, add({ id: `still:${s.id}${atKey(at)}`, type: 'still', label: `${name} · ${atLabel(at)} still`, target: { shotId: s.id, t: at }, model: models.stills, estimateUsd: estimateFor('still', models.stills), deps: castLooks, optional: castLooks,
        ...(hasStill(s, at) ? { status: 'skipped', note: 'Key frame already exists' } : {}) }));
    }
    if (!want('videos')) continue;
    // Where the camera comes from: the blockout clip, start → end stills (approximate) or one still (approximate).
    const cameraSource = needs.camera === 'keyframes' && !still.has('end') && !hasStill(s, 'end') && FIRST_FRAME_FALLBACK[def.id] ? 'still' : needs.camera;
    const n = add({ id: `video:${s.id}`, type: 'video', label: `${name} · video`, target: { shotId: s.id }, model: models.videos, estimateUsd: estimateFor('video', models.videos, { duration: s.duration }), deps: [blockout.id], cameraSource, camera: CAMERA_SOURCE_LABELS[cameraSource] });
    if (needs.references && castLooks.length) { n.deps.push(...castLooks); n.optional = castLooks; }
    // A model that follows the blockout clip also takes the start/end stills as its look, when this batch makes them.
    if (lookStills) for (const x of ['start', 'end'].map(at => still.get(at)).filter(Boolean)) { n.deps.push(x.id); (n.optional ||= []).push(x.id); }
    // An end still is optional when the model has a start-only fallback (the driver animates the start still alone).
    const endOptional = Boolean(FIRST_FRAME_FALLBACK[def.id]);
    for (const at of needs.keyFrames) {
      if (still.has(at)) { n.deps.push(still.get(at).id); if (at === 'end' && endOptional) (n.optional ||= []).push(still.get(at).id); }
      else if (!hasStill(s, at) && !(at === 'end' && endOptional)) Object.assign(n, { status: 'failed', planError: true, error: `Needs a ${at} key frame; add the stills step` });
    }
  }
  return { input, nodes };
}

// ---------- Scheduler ----------
const isBusy = e => e?.apiCode === 'busy' || e?.code === 'busy';
const jobState = j => (j.status === 'completed' ? 'done' : ['failed', 'closed', 'invalidated'].includes(j.status) ? 'failed' : j.status === 'uncertain' ? 'uncertain' : 'running');
const jobIdsOf = n => n.requestIds?.length ? n.requestIds : [n.jobId || n.requestId].filter(Boolean);
// Everything a driver records about its saved requests; cleared only when nothing was dispatched or a failed node is redone.
const NO_IDS = { jobId: undefined, requestId: undefined, requestIds: undefined, fingerprint: undefined, fingerprints: undefined, submitRequest: undefined, sheetId: undefined, unsent: undefined, modelUsed: undefined };

/**
 * openBatches(root, { drivers, jobs, loadProject, definitions?, intervalMs?, missingTicks?, limits?, now?, log?, autoStart? })
 * drivers: { blockout|look|sheet|still|video: { submit(ctx), finish?(ctx, jobs) } }. ctx = { batch, node, project(), record(patch) }.
 *   A paid driver must call ctx.record({ requestId | jobId | requestIds }) before it dispatches, so a restart can find the job,
 *   and must resubmit a recorded request idempotently (the stores return the saved job for anything already dispatched).
 *   submit resolves { jobId? | requestId? | requestIds?, done?, assetId?, referenceId?, ... }; it throws with apiCode 'busy' on 409
 *   (recorded ids are kept and resubmitted) and with notDispatched: true when the server refused before anything was sent.
 * jobs: { snapshot() } → the GET /api/jobs body (C1).
 */
export async function openBatches(root, options = {}) {
  const { drivers = {}, jobs = { snapshot: async () => ({ jobs: [] }) }, loadProject, intervalMs = 5000, missingTicks = 24, now = Date.now, log = () => {} } = options;
  const definitions = typeof options.definitions === 'function' ? options.definitions : () => options.definitions || builtInPresets;
  const round = x => Math.round(x * 10000) / 10000;
  const dir = join(root, 'batches'); await mkdir(dir, { recursive: true });
  const batches = new Map(), listeners = new Map(), timers = new Map(), ticking = new Map(), inflight = new Set();
  let started = false, closed = false;

  for (const f of await readdir(dir)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(f)) continue;
    try { const b = JSON.parse(await readFile(join(dir, f), 'utf8')); batches.set(b.id, b); } catch (e) { log(`batch ${f} unreadable: ${e.message}`); }
  }
  // A submit cut off by a restart goes back to ready: without an id nothing was dispatched; with one the driver resubmits the
  // same saved request, which the store answers with the saved job when it was already sent (never a second dispatch).
  for (const b of batches.values()) for (const n of b.nodes) if (n.submitting) {
    delete n.submitting; n.status = 'ready'; if (jobIdsOf(n).length) n.resubmit = true;
    if (n.reserved) { b.spentEstimateUsd = round(b.spentEstimateUsd - n.reserved); delete n.reserved; }
  }

  // One write at a time per batch (atomicJson shares one .tmp path); each write serializes the latest state.
  const writes = new Map();
  const persist = b => {
    const next = (writes.get(b.id) || Promise.resolve()).then(() => { b.updatedAt = iso(now()); assertNoSecrets(b); return atomicJson(join(dir, `${b.id}.json`), b); });
    writes.set(b.id, next.catch(e => log(`batch ${b.id} not saved: ${e.message}`)));
    return next;
  };
  const emit = (b, message) => { for (const res of listeners.get(b.id) || []) { try { res.write(`data: ${JSON.stringify(message)}\n\n`); } catch {} } };
  const event = (b, text, nodeId) => { b.events.push({ at: iso(now()), ...(nodeId ? { nodeId } : {}), text }); if (b.events.length > MAX_EVENTS) b.events.splice(0, b.events.length - MAX_EVENTS); };
  const setNode = (b, n, patch, text) => { Object.assign(n, patch); for (const k of Object.keys(patch)) if (patch[k] === undefined) delete n[k]; if (text) event(b, text, n.id); emit(b, { type: 'node', batchId: b.id, node: n, ...(text ? { text } : {}) }); };
  const setBatch = (b, patch, text) => { Object.assign(b, patch); if (text) event(b, text); emit(b, { type: 'batch', batch: summary(b) }); };
  const counts = b => b.nodes.reduce((m, n) => ({ ...m, [n.status]: (m[n.status] || 0) + 1 }), {});
  const summary = b => { const { nodes, events, ...rest } = b; return { ...rest, counts: counts(b), lastEvent: events.at(-1) || null }; };
  const poolOf = n => (n.type === 'blockout' ? 'headless' : n.type === 'video' ? (videoNeeds(definitions().find(d => d.id === n.model))?.local ? 'local' : 'cloud:video') : n.model === 'local-checkpoint' ? 'local' : 'cloud:image');
  const watching = b => b.nodes.some(n => n.status === 'running') || (b.status === 'running' && b.nodes.some(n => OPEN.includes(n.status)));

  function schedule(id, delay = intervalMs) {
    if (!started || closed || timers.has(id)) return;
    timers.set(id, setTimeout(async () => {
      timers.delete(id);
      try { await tick(id); } catch (e) { log(`batch ${id} tick: ${e.message}`); }
      const b = batches.get(id); if (b && watching(b)) schedule(id);
    }, delay));
  }

  // Dependency resolution: block on failed/over-budget required deps; ready when required deps are satisfied and optional ones ended.
  function resolve(b) {
    const byId = new Map(b.nodes.map(n => [n.id, n]));
    for (let again = true; again;) {
      again = false;
      for (const n of b.nodes) {
        if (n.status !== 'waiting' && n.status !== 'ready') continue;
        const required = n.deps.filter(d => !n.optional?.includes(d)).map(d => byId.get(d)).filter(Boolean);
        const blocker = required.find(d => d.status === 'failed' || d.status === 'budget');
        if (blocker) { setNode(b, n, { status: blocker.status === 'budget' ? 'budget' : 'failed', blockedBy: blocker.id, error: `Blocked: ${blocker.label} ${blocker.status === 'budget' ? 'is over budget' : 'failed'}` }, `${n.label}: blocked by ${blocker.label}`); again = true; continue; }
        if (n.status === 'waiting' && required.every(d => SATISFIED.includes(d.status)) && (n.optional || []).every(d => ENDED.includes(byId.get(d)?.status ?? 'done'))) { setNode(b, n, { status: 'ready' }); again = true; }
      }
    }
  }

  async function observe(b, snapshot) {
    const found = new Map((snapshot?.jobs || []).map(j => [j.id, j]));
    for (const n of b.nodes.filter(x => x.status === 'running' && !x.submitting)) {
      const ids = jobIdsOf(n); if (!ids.length) continue;
      const list = ids.map(id => found.get(id));
      if (list.some(j => !j)) {
        if (!snapshot) continue;
        n.missing = (n.missing || 0) + 1;
        if (n.missing >= missingTicks) { setNode(b, n, { status: 'failed', uncertain: true, error: 'Job never appeared on the job dashboard; outcome unknown, never resent' }, `${n.label}: job not found, marked uncertain`); pause(b); }
        continue;
      }
      delete n.missing;
      const states = list.map(jobState);
      if (list.some(j => j.stuck) && !n.stuck) setNode(b, n, { stuck: true }, `${n.label}: job is taking far longer than expected`);
      if (list.some(j => j.status === 'recovery-required')) { setNode(b, n, { status: 'failed', recoveryRequired: true, finishedAt: iso(now()), error: 'Output recovery exhausted; recover existing media only, never resend this node.' }, `${n.label}: output recovery required`); pause(b); continue; }
      if (states.includes('uncertain')) { setNode(b, n, { status: 'failed', uncertain: true, finishedAt: iso(now()), error: 'Dispatch outcome unknown (uncertain); never resent. Check the jobs panel.' }, `${n.label}: uncertain`); pause(b); continue; }
      if (states.includes('running')) continue;
      const ok = list.filter((j, i) => states[i] === 'done'), results = ok.flatMap(j => j.results || []);
      if (!ok.length) { const f = list.find(j => j.failure)?.failure; setNode(b, n, { status: 'failed', finishedAt: iso(now()), error: String(f?.detail || f?.phase || 'Job failed').slice(0, 500) }, `${n.label}: failed`); continue; }
      const patch = n.type === 'video' ? { assetId: results.find(r => r.kind === 'video')?.id || results[0]?.id } : n.type === 'sheet' ? { referenceIds: results.map(r => r.id) } : { referenceId: results[0]?.id };
      try {
        const extra = drivers[n.type]?.finish ? await drivers[n.type].finish(context(b, n), list) : null;
        setNode(b, n, { ...patch, ...(extra || {}), status: 'done', finishedAt: iso(now()), ...(ok.length < list.length ? { error: `${list.length - ok.length} of ${list.length} images failed` } : {}) }, `${n.label}: done`);
      } catch (e) { setNode(b, n, { ...patch, status: 'done', finishedAt: iso(now()), error: `Generated, but finishing failed: ${String(e.message).slice(0, 400)}` }, `${n.label}: done; finishing step failed`); } // never redo paid work
    }
  }

  function pause(b) { if (b.status === 'running') setBatch(b, { status: 'paused' }, 'Paused: a job outcome is unknown. Check the jobs panel, then resume.'); }

  const context = (b, n) => ({ batch: b, node: n, project: () => loadProject(b.projectId), record: patch => { setNode(b, n, patch); return persist(b); } });

  function submit(b, n) {
    if (n.estimateUsd == null) return setNode(b, n, { status: 'budget', error: 'Unknown cost; batches never submit unknown-cost work' }, `${n.label}: unknown cost, not submitted`), false;
    if (b.spentEstimateUsd + n.estimateUsd > b.maxCostUsd + 1e-9) return setNode(b, n, { status: 'budget', error: `Over budget: ${usd(b.spentEstimateUsd)} committed + ${usd(n.estimateUsd)} > ${usd(b.maxCostUsd)}` }, `${n.label}: over budget, not submitted`), false;
    const driver = drivers[n.type];
    b.spentEstimateUsd = round(b.spentEstimateUsd + n.estimateUsd);
    setNode(b, n, { status: 'running', submitting: true, reserved: n.estimateUsd || undefined, startedAt: iso(now()), error: undefined, retryAt: undefined, resubmit: undefined }, `${n.label}: ${n.resubmit ? 'resubmitting its saved request' : 'submitting'}${n.estimateUsd ? ` (≈ ${usd(n.estimateUsd)})` : ''}`);
    const refund = () => { b.spentEstimateUsd = round(b.spentEstimateUsd - (n.reserved || 0)); };
    const work = (async () => {
      try {
        if (!driver?.submit) fail(`No ${n.type} driver on this server`);
        const r = (await driver.submit(context(b, n))) || {};
        const { done, ...rest } = r;
        setNode(b, n, { ...rest, submitting: undefined, reserved: undefined, ...(done ? { status: 'done', finishedAt: iso(now()) } : {}) }, done ? `${n.label}: done` : null);
      } catch (e) {
        if (isBusy(e)) { refund(); setNode(b, n, { status: 'ready', submitting: undefined, reserved: undefined, retryAt: iso(now() + (Number(e.retryAfterSeconds) || 15) * 1000), ...(jobIdsOf(n).length ? { resubmit: true } : {}) }, `${n.label}: backend busy, retrying in ${Number(e.retryAfterSeconds) || 15}s`); }
        else if (e.notDispatched) { refund(); setNode(b, n, { ...NO_IDS, status: 'failed', submitting: undefined, reserved: undefined, finishedAt: iso(now()), error: String(e.message).slice(0, 500) }, `${n.label}: refused, nothing was sent`); }
        else if (jobIdsOf(n).length) setNode(b, n, { submitting: undefined, reserved: undefined, error: String(e.message).slice(0, 500) }, `${n.label}: submit error after dispatch began; following the job`);
        else { refund(); setNode(b, n, { status: 'failed', submitting: undefined, reserved: undefined, finishedAt: iso(now()), error: String(e.message).slice(0, 500) }, `${n.label}: failed before dispatch`); }
      }
      await persist(b);
      schedule(b.id, 0);
    })();
    inflight.add(work); work.finally(() => inflight.delete(work));
    return true;
  }

  function dispatch(b, snapshot) {
    if (b.status !== 'running') return;
    const t = now(), active = {};
    for (const x of batches.values()) for (const n of x.nodes) if (n.status === 'running' && (n.submitting || n.type === 'blockout')) active[poolOf(n)] = (active[poolOf(n)] || 0) + 1;
    const ready = b.nodes.filter(n => n.status === 'ready' && !(n.retryAt && Date.parse(n.retryAt) > t)).sort((x, y) => PRIORITY[x.type] - PRIORITY[y.type]);
    for (const n of ready) {
      const pool = poolOf(n), lim = snapshot?.limits?.[pool], limit = lim?.limit ?? options.limits?.[pool] ?? DEFAULT_LIMITS[pool] ?? 1;
      if ((lim?.active || 0) + (active[pool] || 0) >= limit) continue;
      if (submit(b, n)) active[pool] = (active[pool] || 0) + 1;
    }
  }

  function settle(b) {
    if (b.status !== 'running' || b.nodes.some(n => OPEN.includes(n.status))) return;
    const failed = b.nodes.filter(n => n.status === 'failed').length;
    setBatch(b, { status: failed ? 'failed' : 'completed', budgetSkipped: b.nodes.filter(n => n.status === 'budget').length },
      `${failed ? 'Finished with failures' : 'Completed'}: ${b.nodes.filter(n => n.status === 'done').length} done, ${failed} failed, ${b.nodes.filter(n => n.status === 'budget').length} over budget, ≈ ${usd(b.spentEstimateUsd)} of ${usd(b.maxCostUsd)}`);
  }

  async function tick(id) {
    if (ticking.has(id)) return ticking.get(id);
    const run = (async () => {
      const b = batches.get(id); if (!b) return;
      const needJobs = b.nodes.some(n => (n.status === 'running' && !n.submitting) || (b.status === 'running' && n.status === 'ready'));
      let snapshot = null;
      if (needJobs) { try { snapshot = await jobs.snapshot(); } catch (e) { if (!b.dashboardDown) { b.dashboardDown = true; event(b, `Job dashboard unavailable: ${String(e.message).slice(0, 200)}`); } } }
      if (snapshot && b.dashboardDown) delete b.dashboardDown;
      await observe(b, snapshot);
      // Budget refusals settle synchronously, so cascade until nothing changes (a zero-budget batch settles in one tick).
      for (let i = 0, before = ''; i < 20; i++) { const seen = b.nodes.map(n => n.status).join(); if (seen === before) break; before = seen; resolve(b); dispatch(b, snapshot); }
      resolve(b);
      settle(b);
      b.budgetSkipped = b.nodes.filter(n => n.status === 'budget').length;
      await persist(b);
    })();
    ticking.set(id, run);
    try { return await run; } finally { ticking.delete(id); }
  }

  const get = id => { const b = batches.get(id); if (!b) fail('Unknown batch', 404); return b; };
  return {
    /** Begin ticking (after the HTTP server listens, so loopback drivers can reach it). Resumes running batches. */
    start() { started = true; for (const b of batches.values()) if (watching(b)) { if (b.status === 'running') event(b, 'Resumed after server start'); schedule(b.id, 0); } },
    async create(raw) {
      if (!uuid.test(raw?.projectId || '')) fail('Unknown project', 404);
      const project = await loadProject(raw.projectId);
      const { input, nodes } = planBatch(project, raw, { definitions: definitions(project) });
      const estimateUsd = round(nodes.filter(n => !['skipped', 'failed'].includes(n.status)).reduce((s, n) => s + (n.estimateUsd || 0), 0));
      const t = iso(now()), b = { id: randomUUID(), projectId: project.id, status: input.dryRun ? 'planned' : 'running', createdAt: t, updatedAt: t, steps: input.steps, tier: input.tier, models: input.models,
        maxCostUsd: input.maxCostUsd, estimateUsd, spentEstimateUsd: 0, budgetSkipped: 0, dryRun: input.dryRun, ...(input.shots ? { shots: input.shots } : {}), ...(input.objects ? { objects: input.objects } : {}), nodes, events: [] };
      event(b, `Planned ${nodes.length} nodes for “${project.title}”: ≈ ${usd(estimateUsd)} (${input.tier}), cap ${usd(input.maxCostUsd)}${input.dryRun ? '; dry run, nothing submitted' : ''}`);
      if (!input.dryRun) resolve(b);
      batches.set(b.id, b); await persist(b);
      if (!input.dryRun) schedule(b.id, 0);
      return structuredClone(b);
    },
    get: id => structuredClone(get(id)),
    list(projectId) { return [...batches.values()].filter(b => !projectId || b.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(summary); },
    async cancel(id) {
      const b = get(id);
      if (!['running', 'paused', 'planned'].includes(b.status)) return structuredClone(b);
      for (const n of b.nodes) if (n.status === 'waiting' || n.status === 'ready') setNode(b, n, { status: 'skipped', cancelled: true, error: 'Cancelled' });
      setBatch(b, { status: 'cancelled' }, `Cancelled; ${b.nodes.filter(n => n.status === 'running').length} running job(s) keep going and are still followed`);
      await persist(b); return structuredClone(b);
    },
    /** Resume a planned, paused, cancelled or finished batch: retry cancelled, blocked, over-budget and failed nodes — never uncertain ones. */
    async resume(id, { maxCostUsd } = {}) {
      const b = get(id);
      if (b.status === 'running') return structuredClone(b);
      if (maxCostUsd != null) { const cap = Number(maxCostUsd); if (!Number.isFinite(cap) || cap < b.spentEstimateUsd) fail(`maxCostUsd must be at least the ${usd(b.spentEstimateUsd)} already committed`); b.maxCostUsd = cap; }
      for (const n of b.nodes) if (n.cancelled || n.status === 'budget' || (n.status === 'failed' && !n.uncertain && !n.recoveryRequired && !n.planError))
        setNode(b, n, { status: 'waiting', cancelled: undefined, blockedBy: undefined, error: undefined, retryAt: undefined, stuck: undefined, startedAt: undefined, finishedAt: undefined, ...(n.status === 'failed' && !n.blockedBy ? NO_IDS : {}) });
      setBatch(b, { status: 'running', dryRun: false }, `Resumed (cap ${usd(b.maxCostUsd)})`);
      resolve(b); await persist(b); schedule(b.id, 0);
      return structuredClone(b);
    },
    /** SSE: a batch snapshot first, then node and batch changes; `: ping` every 15 s. */
    stream(req, res, id) {
      const b = get(id);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`data: ${JSON.stringify({ type: 'batch', batch: b })}\n\n`);
      if (!listeners.has(id)) listeners.set(id, new Set());
      listeners.get(id).add(res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
      req.on('close', () => { clearInterval(ping); listeners.get(id)?.delete(res); });
    },
    tick,
    /** Wait until in-flight driver calls have settled (tests). */
    async idle() { while (inflight.size || ticking.size) await Promise.all([...inflight, ...ticking.values()]); await Promise.all(writes.values()); },
    close() { closed = true; for (const t of timers.values()) clearTimeout(t); timers.clear(); for (const set of listeners.values()) for (const res of set) { try { res.end(); } catch {} } },
  };
}
