// Takes: every generated version of a shot — its videos, and its stills at each moment — with what made each one
// (model, settings, seed, inputs, cost), what can honestly be said about it (layout, identity and timing grades) and
// which one is the winner. Shared by the Take lab (src/director-takes.ts), the Cut, film export and the MCP tools, so
// all of them agree on what a take is and which one the cut plays. Nothing here deletes a take: losing takes stay.
import { videoStale, stillStale } from './director.mjs';
import { GRADER_PRICES } from './tiers.mjs';

const byCreated = (a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
const round = (v, d = 3) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const isVideoResult = a => a?.kind === 'workflow-result' && String(a.mime || '').startsWith('video/');
// Inline check (do not import shared/masked-edit.mjs here — it pulls node:crypto into the browser Take lab).
const isMaskedEditTake = a => !!(a?.source?.maskedEdit && a.source.maskedEdit.v === 1);

/**
 * Whether a generated video may be chosen by the implicit “newest take” cut fallback.
 * Accepted masked edits stay out of that path; explicit Mark winner / clip picks still work.
 */
export function automaticCutEligible(asset) {
  return isVideoResult(asset) && !isMaskedEditTake(asset);
}

/** Newest automatic-cut-eligible generated video of the shot, or null. */
export function newestAutomaticVideo(project, shot) {
  return videoResults(project, shot).filter(automaticCutEligible).at(-1) || null;
}

/** The shot's generated videos, oldest first (Take 1 is the first one made). */
export function videoResults(project, shot) {
  return (project.assets || []).filter(a => a.shotId === shot.id && isVideoResult(a)).sort(byCreated);
}
/** The shot's blockout clips, newest first. */
export function blockoutClips(project, shot) {
  return (project.assets || []).filter(a => a.shotId === shot.id && a.kind === 'camera-render' && String(a.mime || '').startsWith('video/')).sort(byCreated).reverse();
}

// ---------- Winner and the cut ----------
/** The cut clip of a shot: its own clip, the default (whole cut follows shot order) or null when it is left out. */
export function cutClip(project, shot) {
  const clips = project.edit?.clips;
  if (!clips?.length) return { id: shot.id, shotId: shot.id, assetId: null, in: 0, out: null };
  return clips.find(c => c.shotId === shot.id) || null;
}
/**
 * The shot's winning video take: the one picked with set_winner, else (projects from before winners) a generated
 * video the cut was pointed at. null = no winner yet, so the cut plays the newest take.
 */
export function winnerOf(project, shot) {
  const results = videoResults(project, shot);
  if (shot.winner) { const a = results.find(x => x.id === shot.winner); if (a) return { assetId: a.id, from: 'winner' }; }
  const c = cutClip(project, shot), a = c?.assetId ? results.find(x => x.id === c.assetId) : null;
  return a ? { assetId: a.id, from: 'cut' } : null;
}
/** Which video a cut clip plays: a version chosen on the clip, else the shot's winner, else its newest generated video, else its newest blockout. */
export function cutAsset(project, shot, clip = cutClip(project, shot)) {
  const all = (project.assets || []).filter(a => a.shotId === shot.id && String(a.mime || '').startsWith('video/'));
  if (clip?.assetId) return all.find(a => a.id === clip.assetId) || null;
  const w = shot.winner && all.find(a => a.id === shot.winner && isVideoResult(a));
  if (w) return w;
  const newestResult = newestAutomaticVideo(project, shot);
  if (newestResult) return newestResult;
  const newestBlockout = all.filter(a => a.kind === 'camera-render').sort(byCreated).at(-1) || null;
  return newestBlockout;
}
/**
 * Edit ops (redo and undo) that make `assetId` the shot's winner, or clear it (null: the cut follows the newest take).
 * A version chosen on the shot's cut clip is cleared too, so the cut plays the winner, and its trims reset when the
 * video it plays changes (they were set for the other one); a shot left out of the cut stays out.
 */
export function winnerOps(project, shot, assetId) {
  const results = videoResults(project, shot);
  if (assetId !== null && !results.some(a => a.id === assetId)) throw Error('That take is not a generated video of this shot');
  const redo = [{ op: 'set_winner', shotId: shot.id, assetId }], undo = [{ op: 'set_winner', shotId: shot.id, assetId: shot.winner ?? null }];
  const clips = project.edit?.clips || [], own = clips.find(c => c.shotId === shot.id);
  // Post-clear fallback must match cutAsset (skip masked-edit descendants), not results.at(-1).
  const before = cutAsset(project, shot), after = assetId ?? newestAutomaticVideo(project, shot)?.id ?? before?.id;
  if (own && (own.assetId || ((own.in || own.out != null) && before?.id !== after))) {
    redo.push({ op: 'set_edit', clips: clips.map(c => (c.shotId === shot.id ? { ...c, assetId: null, in: 0, out: null } : c)) });
    undo.push({ op: 'set_edit', clips: structuredClone(clips) });
  }
  return { redo, undo, inCut: !clips.length || !!own };
}

// ---------- Stills: one group per moment ----------
/** When in the shot a still belongs (seconds), from its note: start, end or @t; null when unpinned. */
export function stillTime(shot, ref) {
  const n = ref.note || '';
  if (n === 'key frame start') return 0;
  if (n === 'key frame end') return shot.duration;
  const m = /^key frame @([\d.]+)s$/.exec(n); return m ? Math.min(shot.duration, Number(m[1])) : null;
}
const momentLabel = (shot, t) => (t === null ? 'Unpinned' : t === 0 ? 'Start' : Math.abs(t - shot.duration) < 0.01 ? 'End' : `At ${t.toFixed(2)} s`);
/** Stills grouped by moment, earliest first; within a moment in the shot's order, whose last take is the one in use. */
export function stillMoments(shot) {
  const map = new Map();
  for (const r of (shot.references || []).filter(x => x.role === 'frame')) {
    const t = stillTime(shot, r), key = t === null ? 'x' : t.toFixed(2);
    (map.get(key) || map.set(key, { key, t, label: momentLabel(shot, t), takes: [] }).get(key)).takes.push(r);
  }
  return [...map.values()].sort((a, b) => (a.t ?? 1e9) - (b.t ?? 1e9));
}

// ---------- Cost ----------
/**
 * What a take cost: billed when the budget ledger settled it with a provider charge, otherwise an estimate (the
 * ledger's expected cost, the quote, or list price), 0 for a local run without partner nodes, or unknown.
 * `ledger` maps request/job id → budget reservation ({ state, costUsd, expectedUsd, costStatus }).
 */
function costFrom(ledger, ids, fallback) {
  const rs = ids.map(id => ledger?.[id]).filter(Boolean);
  if (rs.length) {
    const usd = rs.reduce((t, r) => t + (r.state === 'settled' ? r.costUsd ?? 0 : r.state === 'released' ? 0 : r.expectedUsd ?? 0), 0);
    const billed = rs.every(r => r.state === 'released' || (r.state === 'settled' && /^billed/.test(r.costStatus || '')));
    return { usd: round(usd, 4), status: billed ? 'billed' : 'estimate' };
  }
  return fallback;
}

// ---------- Grades ----------
const IDENTITY = { status: 'not-assessed', note: 'No grader judges identity yet (the still grader ignores it): compare with the cast images by eye.' };
/** Layout/identity/timing for a still: layout only when a paid grader judged it; the free local check is too rough to call. */
function stillGrades(ref) {
  const g = ref.generated?.guideMatch;
  const layout = !g ? { status: 'not-graded', note: ref.generated ? 'Not graded against its blockout frame.' : 'Uploaded, not generated.' }
    : g.rough ? { status: 'not-graded', note: 'Only the free rough check ran; it is not a match verdict.' }
    : { status: 'graded', score: g.layout ?? g.score, overall: g.score, camera: g.camera ?? null, headings: g.headings ?? null, why: g.why || '', method: String(g.method || '').split(':').at(-1) || g.method };
  return { layout, identity: IDENTITY, timing: { status: 'not-applicable', note: 'A still has no timing.' } };
}
/**
 * The take's direction check (server/previs/take-grade.mjs): pass / warn / fail with a reason, per-moment readings, and
 * its cost as the budget ledger books it (the same amount the Jobs panel counts).
 */
function directionGrade(take, ledger) {
  const c = take.checks?.direction;
  if (!c) return { status: 'not-checked', note: `Not checked against the blockout. Direction check: Check direction in the Take lab or previs_director_grade_take ($${GRADER_PRICES.gemini.toFixed(2)}; needs PREVIS_MATCH_GRADER=gemini).` };
  return { status: 'checked', verdict: c.verdict, why: c.why, subject: c.subject ?? null, measured: !!c.measured, frames: c.frames || [], grader: c.grader || '', method: String(c.method || '').split(':')[0], gradedAt: c.gradedAt || null, blockoutAssetId: c.blockoutAssetId || null,
    cost: costFrom(ledger, [c.reservationId], { usd: GRADER_PRICES.gemini, status: 'estimate' }) };
}
/** Timing of a video take against the blockout clip it was made from (frames, fps and seconds). */
function videoTiming(take, source) {
  if (!source) return { status: 'unknown', note: 'The blockout this take was made from is no longer in the project.' };
  if (take.frameCount == null || source.frameCount == null) return { status: 'unknown', note: 'Frame counts were not recorded.' };
  const frames = take.frameCount - source.frameCount, seconds = round((take.duration ?? 0) - (source.duration ?? 0), 3);
  const same = frames === 0 && (take.fps == null || source.fps == null || Math.abs(take.fps - source.fps) < 1e-6);
  return { status: same ? 'match' : 'differs', frames, seconds, take: { frames: take.frameCount, fps: take.fps, duration: take.duration }, blockout: { frames: source.frameCount, fps: source.fps, duration: source.duration },
    note: same ? `Same length as the blockout: ${source.frameCount} frames.` : `${take.frameCount} frames vs the blockout’s ${source.frameCount} (${frames > 0 ? '+' : ''}${frames}, ${seconds > 0 ? '+' : ''}${seconds} s); events may land at different times.` };
}

// ---------- Inputs ----------
const INPUT_LABELS = { sourceVideo: 'Blockout clip', controlVideo: 'Control clip', firstFrame: 'Start still', lastFrame: 'End still', image: 'Still', referenceImage: 'Reference image' };
const inputLabel = name => INPUT_LABELS[name] || name.replace(/^referenceImage(\d+)$/, 'Reference image $1').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());

/** Settings worth comparing (seed shown on its own), from the request's mapped parameters. */
function settingsOf(params) {
  const out = {};
  for (const [k, v] of Object.entries(params || {})) if (k !== 'seed' && k !== 'prompt' && (v === null || ['string', 'number', 'boolean'].includes(typeof v))) out[k] = v;
  return out;
}
const seconds = (a, b) => { const t = Date.parse(b) - Date.parse(a); return Number.isFinite(t) && t >= 0 ? Math.round(t / 1000) : null; };

/**
 * Every video take of a shot, oldest first, labelled "Take 1…n". `jobs` are generation receipts (GET /api/generation)
 * and `ledger` the budget reservations by id (GET /api/budget); both are optional, the asset alone still labels a take.
 */
export function videoTakes(project, shot, { jobs = [], ledger = {} } = {}) {
  const winner = winnerOf(project, shot), inCut = cutAsset(project, shot);
  const renders = (project.assets || []).filter(a => a.kind === 'camera-render');
  return videoResults(project, shot).map((a, i) => {
    const job = jobs.find(j => j.id === a.source?.jobId) || null, src = a.source || {};
    const params = job?.binding?.parameters || src.parameters || {};
    const source = renders.find(r => r.id === src.sourceAssetId) || null;
    const local = (job?.backend?.kind || src.backend) === 'local' && !(job?.quote?.nodes || []).some(n => n.apiNode);
    const rate = job?.definition?.pricing?.ratePerSecond;
    const quoted = src.quote?.amount ?? job?.quote?.amount ?? job?.quote?.estimate ?? null;
    const fallback = local ? { usd: 0, status: 'free' } : quoted != null ? { usd: round(quoted, 4), status: 'estimate' } : rate && a.duration ? { usd: round(rate * a.duration, 4), status: 'estimate' } : { usd: null, status: 'unknown' };
    const names = job ? Object.keys(job.binding?.assetBindings || {}) : src.inputs || (source ? ['sourceVideo'] : []);
    const inputs = names.map(n => ({ role: n, label: n === 'sourceVideo' && source ? `Blockout clip v${source.version ?? 1}` : inputLabel(n) }));
    const prompt = job?.binding?.prompt ?? src.prompt ?? '';
    return {
      id: a.id, kind: 'video', shotId: shot.id, number: i + 1, label: `Take ${i + 1}`,
      model: String(src.workflow || job?.definition?.title || 'Generated').split(' ·')[0], modelId: job?.definition?.id || src.definitionId || null,
      backend: job?.backend?.kind || src.backend || null, cameraSource: src.cameraSource || job?.cameraSource || null,
      settings: settingsOf(params), seed: Number.isFinite(params.seed) ? params.seed : null,
      cost: costFrom(ledger, job ? [job.id] : [], fallback),
      inputs, prompt, promptLength: prompt.length,
      source: source ? { assetId: source.id, version: source.version ?? 1 } : null, stale: videoStale(project, shot, a),
      media: { width: a.width ?? null, height: a.height ?? null, fps: a.fps ?? null, frames: a.frameCount ?? null, duration: a.duration ?? null },
      grades: { layout: { status: 'not-graded', note: 'No video layout grader yet; the direction check covers which way the subject faces and travels.' }, direction: directionGrade(a, ledger), identity: IDENTITY, timing: videoTiming(a, source) },
      createdAt: a.createdAt, elapsedSeconds: job ? seconds(job.acceptedAt || job.dispatchStartedAt, job.completedAt) : null,
      winner: winner?.assetId === a.id, inCut: inCut?.id === a.id,
    };
  });
}

/**
 * Every still take of a shot, grouped by moment. `stillJobs` are image requests (GET /api/director/refgen) and
 * `prices` maps an image preset id → list USD per image; both optional.
 */
export function stillTakes(project, shot, { stillJobs = [], ledger = {}, prices = {} } = {}) {
  const looks = new Map([...(project.scene?.references || []), ...project.shots.flatMap(s => s.references || [])].map(r => [r.id, r]));
  return stillMoments(shot).map(m => ({
    key: m.key, t: m.t, label: m.label, inUse: m.takes.at(-1)?.id ?? null,
    // Numbered by when each was made, so picking an earlier take (which moves it last) never renumbers them.
    takes: [...m.takes].sort(byCreated).map((r, i) => {
      const g = r.generated || null, job = g ? stillJobs.find(j => j.id === g.requestId) : null;
      const local = g && /^local/.test(String(g.backend || '')), list = g ? prices[g.presetId] : null;
      const fallback = !g ? { usd: 0, status: 'free' } : local ? { usd: 0, status: 'free' } : list != null ? { usd: round(list, 4), status: 'estimate' } : { usd: null, status: 'unknown' };
      const inputs = !g ? [{ role: 'upload', label: 'Uploaded image' }] : [
        ...(job ? (job.guide ? [{ role: 'guide', label: `Blockout frame at ${(m.t ?? 0).toFixed(2)} s` }] : []) : []), // no request receipt: inputs not recorded
        ...(job?.refs || []).map((x, k) => ({ role: 'reference', label: `Image ${k + 1}: ${looks.get(x.referenceId)?.name || 'reference image'}` })),
      ];
      return {
        id: r.id, kind: 'still', shotId: shot.id, moment: m.key, number: i + 1, label: `Take ${i + 1}`, name: r.name, file: r.file,
        model: g ? String(g.model || g.presetId || 'Generated').split(' (')[0] : 'Uploaded', modelId: g?.presetId || null, backend: g?.backend || null,
        settings: job ? settingsOf({ aspect: job.aspect, count: job.count }) : {}, seed: Number.isFinite(g?.seed) ? g.seed : null,
        cost: g ? costFrom(ledger, [g.requestId, `${g.requestId}-grade`], fallback) : fallback,
        inputs, prompt: g?.prompt || '', promptLength: (g?.prompt || '').length, stale: stillStale(project, shot, r),
        grades: stillGrades(r), createdAt: r.createdAt, elapsedSeconds: job ? seconds(job.submittedAt || job.createdAt, job.completedAt) : null,
        winner: m.takes.at(-1)?.id === r.id,
      };
    }),
  }));
}

/** Setting names (model, seed, settings, inputs, prompt) whose values differ across these takes: the "Only differences" view. */
export function takeDifferences(takes) {
  if (takes.length < 2) return [];
  const facets = t => ({ model: t.model, seed: t.seed, ...Object.fromEntries(Object.entries(t.settings || {}).map(([k, v]) => [`settings.${k}`, v])), inputs: (t.inputs || []).map(x => x.label).join(' · '), prompt: t.prompt, ...(t.kind === 'video' ? { source: t.source?.version ?? null, cameraSource: t.cameraSource } : {}) });
  const all = takes.map(facets), keys = [...new Set(all.flatMap(Object.keys))];
  return keys.filter(k => new Set(all.map(f => JSON.stringify(f[k] ?? null))).size > 1);
}

/** Everything about a shot's takes in one object (the MCP previs_director_list_takes answer and the Take lab's data). */
export function shotTakes(project, shot, opts = {}) {
  const videos = videoTakes(project, shot, opts), stills = stillTakes(project, shot, opts), winner = winnerOf(project, shot), cut = cutAsset(project, shot), clip = cutClip(project, shot);
  return {
    shot: { id: shot.id, number: project.shots.indexOf(shot) + 1, title: shot.title, duration: shot.duration },
    winner: { video: winner ? { takeId: winner.assetId, label: videos.find(v => v.id === winner.assetId)?.label, from: winner.from } : null, stills: stills.map(m => ({ moment: m.label, takeId: m.inUse, label: m.takes.find(x => x.id === m.inUse)?.label })) },
    cut: { inCut: !!clip, takeId: cut?.id ?? null, kind: cut ? (cut.kind === 'camera-render' ? 'blockout' : 'video') : null, follows: clip?.assetId ? 'chosen version' : winner ? 'winner' : 'newest' },
    blockouts: blockoutClips(project, shot).map(a => ({ assetId: a.id, version: a.version ?? 1, frames: a.frameCount, duration: a.duration })),
    videos, stills, differences: takeDifferences(videos),
  };
}
