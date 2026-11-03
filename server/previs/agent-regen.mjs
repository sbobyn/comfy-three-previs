// MCP tools for "only what changed" (docs/regeneration.md): which outputs of a project are out of date and exactly why,
// what an object or its look feeds, and pinning an output to accept it as it is. Same rules as the batch planner and the
// workspace badges (shared/regen.mjs). Free: nothing is generated.
import { explainStale, staleText, dependentsOf, momentOf } from '../../shared/regen.mjs';

/** One shot's outputs with their verdicts: blockout, every still moment's take in use, and the video take in use. */
export function shotRegen(p, s) {
  const row = (node, label) => { const x = explainStale(p, node); return { label, state: x.state, ...(x.output ? { outputId: x.output.id } : {}), ...(x.legacy ? { legacy: true } : {}), why: staleText(x), reasons: x.reasons.map(({ code, text, entityId }) => ({ code, text, ...(entityId ? { entityId } : {}) })) }; };
  const moments = [...new Set((s.references || []).filter(r => r.role === 'frame').map(r => JSON.stringify(momentOf(r))))].map(x => JSON.parse(x));
  return {
    blockout: row({ type: 'blockout', shotId: s.id }, 'blockout'),
    stills: moments.map(at => row({ type: 'still', shotId: s.id, at }, `${typeof at === 'number' ? `${at}s` : at} still`)),
    video: row({ type: 'video', shotId: s.id }, 'video'),
  };
}

export function regenTools({ post, project, shotOf, entityOf }) {
  async function regenStatus(a) {
    const p = await project(a.projectId);
    const shots = (a.shot ? [shotOf(p, a.shot)] : p.shots).map(s => ({ shot: { id: s.id, number: p.shots.indexOf(s) + 1, title: s.title }, ...shotRegen(p, s) }));
    const e = a.object ? entityOf(p, a.object) : null, deps = e ? dependentsOf(p, e.id) : null;
    const stale = shots.flatMap(x => [x.blockout, ...x.stills, x.video].filter(r => r.state === 'stale').map(r => `${x.shot.number} ${r.label}`));
    return { shots, ...(e ? { object: { id: e.id, name: e.name, movingItAffects: { shots: deps.object.shots.length, stills: deps.object.stills, videos: deps.object.videos }, itsLookFeeds: { shots: deps.look.shots.length, stills: deps.look.stills, videos: deps.look.videos } } } : {}),
      text: stale.length ? `${stale.length} out of date: ${stale.slice(0, 12).join(', ')}${stale.length > 12 ? ', …' : ''}. previs_director_batch_generate makes only these again (dryRun first shows each node's reasons and the cost); pin an output with previs_director_pin_output to keep it.` : 'Everything made is up to date.' };
  }
  async function pinOutput(a) {
    const p = await project(a.projectId), pinned = a.pinned !== false;
    await post('/api/director/edit', { projectId: p.id, ops: [{ op: 'pin_output', id: a.id, pinned }] });
    return { id: a.id, pinned, text: pinned ? 'Pinned: it counts as current and batches keep it, even when its inputs change.' : 'Unpinned: it is judged by its inputs again.' };
  }
  return [
    { name: 'previs_director_regen_status', description: 'What is out of date in a project and exactly why, without generating anything: per shot the blockout, each still moment’s take in use and the video in use, each with state (fresh, stale, pinned, uploaded, missing) and machine-readable reasons (camera changed, timing changed, “Eagle moved”, “Eagle is now in frame”, “cast image of Eagle changed”, “description of Eagle changed”, prompt changed, model changed, seed changed, start still changed). Only objects a shot’s blockout frames can show count for it: moving something off-screen stales nothing. With object: how many shots, stills and videos moving it, or changing its cast image or description, would make out of date. Free.', inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, shot: { type: 'string', description: 'Shot id, number or title (default: all)' }, object: { type: 'string', description: 'Object name or id: also report what depends on it' } }, required: ['projectId'], additionalProperties: false },
      run: regenStatus },
    { name: 'previs_director_pin_output', description: 'Pin (or unpin) a generated still, look or video take (ids from previs_director_regen_status, previs_director_list_takes) to accept it as it is: a pinned output is never out of date, video models are still sent a pinned still, and previs_director_batch_generate keeps it instead of making it again. Only with the user’s agreement. Free.', inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, id: { type: 'string', description: 'Still or look reference id, or video asset id' }, pinned: { type: 'boolean', description: 'false unpins (default true)' } }, required: ['projectId', 'id'], additionalProperties: false },
      run: pinOutput },
  ];
}
