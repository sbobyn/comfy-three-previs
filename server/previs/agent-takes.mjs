// MCP tools for takes (the Take lab's parity): list every video and still take of a shot with what made it, and pick
// the winner. Same rules as the workspace (shared/takes.mjs); picking a winner is a normal project edit, so the
// workspace updates live and the cut and film export play it. Free: nothing is generated, nothing is deleted.
import { shotTakes, videoResults, winnerOps } from '../../shared/takes.mjs';

const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/** What the MCP agent sees of a take: everything the Take lab labels, with long prompts shortened. */
function takeCard(t) {
  const { shotId, file, ...rest } = t;
  return { ...rest, prompt: clip(t.prompt || '', 400) };
}

/** Takes of one shot with receipts, budget ledger and image prices folded in (each optional: a missing one only drops detail). */
export async function loadShotTakes({ get, project, shotOf }, projectId, shotRef) {
  const p = await project(projectId), s = shotOf(p, shotRef);
  const [gen, budget, refgen] = await Promise.all([
    get('/api/generation').catch(() => ({ jobs: [] })),
    get(`/api/budget?projectId=${encodeURIComponent(p.id)}`).catch(() => ({ reservations: [] })),
    get(`/api/director/refgen?projectId=${encodeURIComponent(p.id)}`).catch(() => ({ jobs: [], presets: [] })),
  ]);
  const ledger = Object.fromEntries((budget.reservations || []).map(r => [r.id, r]));
  const prices = Object.fromEntries((refgen.presets || []).map(x => [x.id, x.pricing?.usdPerImage ?? null]));
  return { p, s, takes: shotTakes(p, s, { jobs: gen.jobs || [], stillJobs: refgen.jobs || [], ledger, prices }) };
}

export function takeTools(deps) {
  const { post, get } = deps;
  async function listTakes(a) {
    const { takes } = await loadShotTakes(deps, a.projectId, a.shot);
    const kind = a.kind || 'all';
    return {
      shot: takes.shot, winner: takes.winner, cut: takes.cut, blockouts: takes.blockouts,
      ...(kind !== 'still' ? { videos: takes.videos.map(takeCard), differences: takes.differences } : {}),
      ...(kind !== 'video' ? { stills: takes.stills.map(m => ({ ...m, takes: m.takes.map(takeCard) })) } : {}),
    };
  }
  async function setWinner(a) {
    const { p, s } = await loadShotTakes(deps, a.projectId, a.shot);
    const id = a.takeId ?? null;
    const still = id && s.references.find(r => r.id === id && r.role === 'frame');
    if (still) {
      await post('/api/director/edit', { projectId: p.id, ops: [{ op: 'use_take', shotId: s.id, referenceId: still.id }] });
    } else {
      if (id && !videoResults(p, s).some(x => x.id === id)) throw Error(`${id} is not a take of shot ${p.shots.indexOf(s) + 1}. List them with previs_director_list_takes.`);
      const { redo } = winnerOps(p, s, id);
      await post('/api/director/edit', { projectId: p.id, ops: redo });
    }
    const after = await loadShotTakes(deps, p.id, s.id), w = after.takes;
    const text = still ? `The ${w.stills.find(m => m.inUse === still.id)?.label.toLowerCase() || 'chosen'} still is now ${w.stills.find(m => m.inUse === still.id)?.takes.find(x => x.id === still.id)?.label}; video models get it.`
      : id ? `${w.winner.video?.label} is the winner of shot ${w.shot.number}.${w.cut.inCut ? ' The cut and film export play it.' : ' The shot is left out of the cut; include it in Cut to use it.'}`
      : `Shot ${w.shot.number} has no winner; the cut plays its newest take.`;
    return { text, winner: w.winner, cut: w.cut };
  }
  /** Paid direction check of one video take (server/previs/take-grade.mjs); dryRun shows what would be compared. */
  async function gradeTake(a) {
    const { p, s, takes } = await loadShotTakes(deps, a.projectId, a.shot);
    const ids = a.takeId ? [a.takeId] : takes.videos.filter(v => v.grades.direction?.status !== 'checked' || a.recheck === true).map(v => v.id);
    const unknown = ids.find(id => !takes.videos.some(v => v.id === id));
    if (unknown) throw Error(`${unknown} is not a video take of shot ${takes.shot.number}. List them with previs_director_list_takes.`);
    const price = (await get(`/api/director/grade-take?projectId=${encodeURIComponent(p.id)}&assetId=${encodeURIComponent(ids[0] || takes.videos[0]?.id || '')}`).catch(() => null));
    const each = price?.priceUsd ?? 0.01, total = Math.round(each * ids.length * 10000) / 10000;
    if (!ids.length) return { shot: takes.shot, checked: [], text: 'Every video take of this shot is already checked; pass recheck: true to check again.' };
    if (a.dryRun) return { shot: takes.shot, dryRun: true, takes: ids, estimateUsd: total, graderOn: price?.graderOn ?? null, moments: price?.times ?? null, blockout: price?.plan ?? null, text: `Would check ${ids.length} take${ids.length > 1 ? 's' : ''} at $${each.toFixed(2)} each ($${total.toFixed(2)}). Nothing was sent.` };
    if (total > a.maxCostUsd + 1e-9) return { shot: takes.shot, submitted: false, reason: `Checking ${ids.length} take${ids.length > 1 ? 's' : ''} costs $${total.toFixed(2)}, above maxCostUsd $${a.maxCostUsd}. Nothing was sent.` };
    const checked = [];
    for (const id of ids) {
      const v = takes.videos.find(x => x.id === id);
      try { const r = await post('/api/director/grade-take', { projectId: p.id, assetId: id, maxCostUsd: each }); checked.push({ takeId: id, label: v.label, model: v.model, verdict: r.check.verdict, why: r.check.why, frames: r.check.frames, cost: r.cost }); }
      catch (err) { checked.push({ takeId: id, label: v.label, model: v.model, error: err.message }); if (/PREVIS_MATCH_GRADER|budget|cap/i.test(err.message)) break; }
    }
    const spent = Math.round(checked.reduce((t, c) => t + (c.cost?.usd || 0), 0) * 10000) / 10000;
    return { shot: { ...takes.shot, id: s.id }, checked, costUsd: spent, text: checked.map(c => `${c.label} (${c.model}): ${c.verdict ? `${c.verdict.toUpperCase()} — ${c.why}` : `not checked: ${c.error}`}`).join('\n') };
  }
  return [
    { name: 'previs_director_grade_take', description: 'Check a generated video take against its blockout for direction: which way the shot’s subject faces and travels (toward or away from the camera, screen-left or right) at three moments, read by the paid match grader (Gemini on Comfy Cloud; the server needs PREVIS_MATCH_GRADER=gemini and PREVIS_ALLOW_PAID=1) and compared with the blockout as measured from the 3D scene. Returns pass, warn or fail with a reason (e.g. “At 2.5 s the Bald eagle faces the camera; the blockout has it facing away.”) and saves it on the take (previs_director_list_takes grades.direction; the Take lab shows it). $0.01 per take, booked in the budget ledger as one grader charge; the cost returned is what the ledger booked. Without takeId, checks every unchecked video take of the shot (recheck: true includes checked ones). dryRun: true shows the moments, the blockout’s measured facing and travel, and the estimate without sending anything. Use it after every video generation where direction matters, and before picking a winner; a fail means look at the frames (previs_director_view_shot) and do not pick it.', inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, shot: { type: 'string', description: 'Shot id, title or 1-based number' }, takeId: { type: 'string', description: 'Video take id from previs_director_list_takes (default: every unchecked take)' }, recheck: { type: 'boolean' }, maxCostUsd: { type: 'number', minimum: 0.01, maximum: 1 }, dryRun: { type: 'boolean' } }, required: ['projectId', 'shot', 'maxCostUsd'], additionalProperties: false },
      run: gradeTake },
    { name: 'previs_director_list_takes', description: 'List every take of a shot so you can compare them and pick a winner: its generated videos (Take 1 = oldest) and its stills grouped by moment (start, end, at t). Each take carries model, settings (resolution, duration, …) and seed, inputs (blockout clip version, start/end stills, reference images), the prompt it was sent, cost (billed from the budget ledger, else an estimate, free, or unknown), when it was made and how long it ran, whether its blockout is out of date, and grades: layout (only when the paid still grader judged it), direction (videos: pass, warn or fail with a reason and per-moment facing and travel, when previs_director_grade_take checked it, with the cost the ledger booked; else not-checked), identity (never assessed — say so rather than guessing) and timing (a video’s frame count vs its blockout clip). winner says which video take the cut plays and which still is in use at each moment; differences lists the settings that differ between the video takes. See a video take’s frame with previs_director_view_shot (what: "video", assetId: its id). Free; read-only. kind: "video", "still" or "all" (default).', inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, shot: { type: 'string', description: 'Shot id, title or 1-based number' }, kind: { type: 'string', enum: ['video', 'still', 'all'] } }, required: ['projectId', 'shot'], additionalProperties: false },
      run: listTakes },
    { name: 'previs_director_set_winner', description: 'Pick the winning take of a shot (ids from previs_director_list_takes). A video take becomes the shot’s winner: the Cut and film export play it, and a later generation does not replace it (losing takes stay in the project). takeId null clears the video winner so the cut follows the newest take again. A still take becomes the one in use at its moment (start/end stills are what video models receive). The workspace updates live. Free; nothing is generated or deleted.', inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, shot: { type: 'string', description: 'Shot id, title or 1-based number' }, takeId: { type: ['string', 'null'] } }, required: ['projectId', 'shot', 'takeId'], additionalProperties: false },
      run: setWinner },
  ];
}
