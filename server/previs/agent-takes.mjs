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
  const { post } = deps;
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
  return [
    { name: 'previs_director_list_takes', description: 'List every take of a shot so you can compare them and pick a winner: its generated videos (Take 1 = oldest) and its stills grouped by moment (start, end, at t). Each take carries model, settings (resolution, duration, …) and seed, inputs (blockout clip version, start/end stills, reference images), the prompt it was sent, cost (billed from the budget ledger, else an estimate, free, or unknown), when it was made and how long it ran, whether its blockout is out of date, and grades: layout (only when the paid still grader judged it; videos have no grader yet), identity (never assessed — say so rather than guessing) and timing (a video’s frame count vs its blockout clip). winner says which video take the cut plays and which still is in use at each moment; differences lists the settings that differ between the video takes. See a video take’s frame with previs_director_view_shot (what: "video", assetId: its id). Free; read-only. kind: "video", "still" or "all" (default).', inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, shot: { type: 'string', description: 'Shot id, title or 1-based number' }, kind: { type: 'string', enum: ['video', 'still', 'all'] } }, required: ['projectId', 'shot'], additionalProperties: false },
      run: listTakes },
    { name: 'previs_director_set_winner', description: 'Pick the winning take of a shot (ids from previs_director_list_takes). A video take becomes the shot’s winner: the Cut and film export play it, and a later generation does not replace it (losing takes stay in the project). takeId null clears the video winner so the cut follows the newest take again. A still take becomes the one in use at its moment (start/end stills are what video models receive). The workspace updates live. Free; nothing is generated or deleted.', inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, shot: { type: 'string', description: 'Shot id, title or 1-based number' }, takeId: { type: ['string', 'null'] } }, required: ['projectId', 'shot', 'takeId'], additionalProperties: false },
      run: setWinner },
  ];
}
