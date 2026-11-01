// previs_director_keyframe: exact-frame key stills over MCP, the same model as the workspace storyboard's frame rail
// (shared/keyframes.mjs). See a frame's blockout guide (free), make a still there (paid, through generate_still) and
// attach it as the start, end or a timed in-between key frame; list what each video model takes and when.
import { FPS, frameLabel, frameTime, keyframePlan, keyframeState, middleKeys, resolveFrame, stillFrame, takeAt } from '../../shared/keyframes.mjs';
import { describeFrame } from '../../shared/still-match.mjs';
import { clipSecondsFor } from '../../shared/tiers.mjs';
import { resolveVideoParams } from '../../shared/model-params.mjs';

const r3 = x => Math.round(x * 1000) / 1000;
/** One key frame row for the agent: frame, seconds, readiness, the still in use and where it came from. */
function rowOut(p, s, r) {
  const f = r.frame;
  return { frame: r.index, seconds: r.index === null ? null : r3(frameTime(r.index)), state: r.state, referenceId: r.ref?.id ?? null,
    ...(r.outOfRange ? { why: 'past the end of the shot now; unpin it or make the shot longer' } : {}),
    ...(f?.override ? { from: `a still made at frame ${f.index}, chosen as the ${r.role}` } : {}),
    ...(f && !f.exact ? { note: f.index === r.index && r.role === 'end' ? 'made at the shot’s full length (the camera’s end pose), not on an encoded frame; make it again for the exact last frame' : `made at ${f.t}s, about frame ${f.index}` } : {}),
    ...(r.ref?.generated?.guideMatch && !r.ref.generated.guideMatch.rough ? { guideMatch: { score: r.ref.generated.guideMatch.score, frame: r.ref.generated.guideMatch.frame ?? null } } : {}) };
}
export function keyframeSummary(p, s) {
  const st = keyframeState(p, s);
  return { frames: st.count, fps: FPS, lastFrame: st.count - 1, start: rowOut(p, s, st.start), end: rowOut(p, s, st.end), middle: st.middle.map(r => rowOut(p, s, r)) };
}
/** Which of the shot's key frames a video model takes, and where each in-between frame lands in its output. */
export function planOut(p, s, def) {
  // The clip length generation binds: the shot's saved one for this model (shared/model-params.mjs), else the nearest.
  const seconds = def.task === 'first-frame' ? resolveVideoParams(def, s).seconds ?? clipSecondsFor(def, s.duration) : s.render?.duration ?? s.duration;
  const plan = keyframePlan(p, s, def, { seconds });
  return { model: def.id, outputSeconds: plan.outputSeconds,
    takes: def.task !== 'first-frame' ? 'the blockout clip (no key frames as frame inputs)' : [plan.start && 'start', plan.end && 'end', plan.spacing && `up to ${8} in-between frames, spaced evenly by the provider`].filter(Boolean).join(', '),
    ...(plan.start ? { start: rowOut(p, s, plan.start) } : {}), ...(plan.end ? { end: rowOut(p, s, plan.end) } : {}),
    middle: plan.middle.map(m => ({ ...rowOut(p, s, m), slot: m.slot, atSeconds: m.atSeconds, blockoutSeconds: m.blockoutSeconds, driftSeconds: m.driftSeconds })),
    unused: plan.unused.map(m => ({ frame: m.index, why: m.why })), ...(plan.evenFrames.length ? { evenFrames: plan.evenFrames } : {}), warnings: plan.warnings };
}

export function keyframeTools({ get, post, project, shotOf, generateStill, videoDefs, headlessOff }) {
  const text = out => [{ type: 'text', text: JSON.stringify(out) }];
  async function modelDef(id) { const def = videoDefs(await get('/api/generation')).find(d => d.id === id); if (!def) throw Error(`Unknown video model ${id}`); return def; }

  /** Make the frame a key frame in `role`. Returns what changed, or { pending } when the still is not made yet. */
  async function attach(p, s, f, role, referenceId = null) {
    if (role === 'none') return { attached: null };
    if (role === 'middle') {
      if (f.role !== 'middle') throw Error(`Frame ${f.index} is the shot’s ${f.role}; attach it with role "${f.role}"`);
      const frames = [...new Set([...middleKeys(s), f.index])].sort((a, b) => a - b);
      if (frames.length > 8) throw Error('A shot pins at most 8 in-between key frames (Kling 4.0 takes 8)');
      await post('/api/director/edit', { projectId: p.id, ops: [{ op: 'set_middle_keys', shotId: s.id, frames }] });
      return { attached: 'middle', frame: f.index, pinned: frames };
    }
    // The shot's own start (frame 0) or end (last frame): its newest take there is the key frame; referenceId picks an older take.
    if (f.role === role) {
      if (referenceId) {
        const r = s.references.find(x => x.id === referenceId && x.role === 'frame' && x.note === `key frame ${role}`);
        if (!r) throw Error(`Still ${referenceId} is not a ${role} take of this shot`);
        await post('/api/director/edit', { projectId: p.id, ops: [{ op: 'use_take', shotId: s.id, referenceId: r.id }] });
        return { attached: role, frame: f.index, referenceId: r.id };
      }
      const k = keyframeState(p, s)[role];
      return k.ref ? { attached: role, frame: f.index, referenceId: k.ref.id, state: k.state } : { pending: true, why: `No ${role} still yet` };
    }
    // A still from another frame becomes the start or end: an override that keeps its frame and goes stale with the shot.
    const src = referenceId ? s.references.find(r => r.id === referenceId && r.role === 'frame') : takeAt(p, s, f.index);
    if (referenceId && !src) throw Error(`Unknown still ${referenceId} on this shot`);
    if (!src) return { pending: true, why: `No still at ${frameLabel(f.index)} yet` };
    const r = await post('/api/director/edit', { projectId: p.id, ops: [{ op: 'use_as_key_still', shotId: s.id, referenceId: src.id, role }] });
    return { attached: role, frame: f.index, referenceId: r.results?.[0]?.id ?? null, override: `a still from frame ${f.index} is now the ${role} key frame` };
  }

  async function run(a) {
    let p = await project(a.projectId), s = shotOf(p, a.shot);
    const mode = a.mode || 'list';
    if (mode === 'list') return text({ shot: s.title, keyFrames: keyframeSummary(p, s), ...(a.model ? { forModel: planOut(p, s, await modelDef(a.model)) } : {}) });
    if (mode === 'unpin') {
      const f = resolveFrame(p, s, { at: a.at ?? null, frame: a.frame ?? null });
      const frames = middleKeys(s).filter(i => i !== f.index);
      await post('/api/director/edit', { projectId: p.id, ops: [{ op: 'set_middle_keys', shotId: s.id, frames }] });
      p = await project(p.id); s = shotOf(p, s.id);
      return text({ unpinned: f.index, keyFrames: keyframeSummary(p, s) });
    }
    const f = resolveFrame(p, s, { at: a.at ?? null, frame: a.frame ?? null });
    const role = a.role || f.role;
    const where = { frame: f.index, seconds: r3(f.t), frames: f.count, role: f.role };
    if (mode === 'guide') {
      // Exactly image 1 of a still made at this frame: the guide look (front markers, ground grid), or a Blender clip's own frame.
      let g;
      try { g = await post('/api/director/frame', { projectId: p.id, shotId: s.id, t: f.t, width: a.width || 1280, height: Math.round(((a.width || 1280) * 9) / 32) * 2, guide: true }); }
      catch (err) { if (err.code === 'headless-unavailable') return text({ available: false, reason: headlessOff(err), ...where }); throw err; }
      return [{ type: 'image', data: g.data, mimeType: g.mime || 'image/png' }, ...text({ ...where, source: g.source || 'blockout', ...(g.frame !== undefined ? { clipFrame: g.frame } : {}), camera: describeFrame(p, s, f.t).text, next: 'Make the still here with mode "generate" (paid), or see the key frames with mode "list".' })];
    }
    if (mode === 'attach') {
      const out = await attach(p, s, f, role, a.referenceId || null);
      p = await project(p.id); s = shotOf(p, s.id);
      return text({ ...where, ...out, keyFrames: keyframeSummary(p, s) });
    }
    if (mode === 'generate') {
      if (!(Number(a.maxCostUsd) > 0)) throw Error('generate is paid: set maxCostUsd');
      // An in-between frame is pinned before the still lands: the newest take at a pinned frame is always the one used.
      if (role === 'middle') await attach(p, s, f, 'middle');
      const r = await generateStill({ ...a, frame: f.index, at: undefined });
      if (r.submitted === false) return text({ ...where, ...r });
      p = await project(p.id); s = shotOf(p, s.id);
      const made = r.status === 'completed' ? (r.referenceIds || []).at(-1) : null;
      const att = role === 'middle' ? { attached: 'middle', frame: f.index } : made ? await attach(p, s, f, role, f.role === role ? null : made) : role === 'none' ? { attached: null } : { pending: true, next: `When the still lands, call previs_director_keyframe mode:"attach" frame:${f.index} role:"${role}"` };
      p = await project(p.id); s = shotOf(p, s.id);
      return text({ ...where, still: { status: r.status, requestId: r.requestId, referenceIds: r.referenceIds, estimateUsd: r.estimateUsd, inputs: r.inputs }, ...att, keyFrames: keyframeSummary(p, s), ...(a.model ? { forModel: planOut(p, s, await modelDef(a.model)) } : {}) });
    }
    throw Error('mode must be list, guide, generate, attach or unpin');
  }

  const tool = { name: 'previs_director_keyframe',
    description: 'Exact-frame key stills for a shot. The blockout is 24 fps: frame 0 is the start and the last encoded frame (frames − 1) is the end (a 5 s shot ends on frame 119, 4.958 s). Pick a frame by number (frame) or at ("start", "end", or seconds: the nearest frame). mode "list" (free, default): every key frame — start, end and pinned in-between frames — with ready / stale (made before a camera, timing or scene change) / missing; with model, which of them that model takes and where each lands in its output. mode "guide" (free): the blockout guide image at that frame, exactly image 1 of a still made there, with its camera in words. mode "generate" (paid: maxCostUsd): makes the still at that frame like previs_director_generate_still (the cast’s looks and sheets as references, graded against that frame) and attaches it as role. mode "attach" (free): makes the newest take at that frame (or referenceId) a key frame. mode "unpin": removes an in-between frame. role: "start", "end", "middle" or "none"; default from the frame (0 → start, last → end, else middle). A still from another frame can be the start or end (it is marked as an override). In-between frames are taken only by Kling 4.0 · start → end stills (up to 8; the provider spaces them evenly, so the plan shows each one’s timing drift and the evenly spaced frames); other models ignore them and say so. Video prompts never describe the camera: the blockout, or the stills made from it, is the camera.',
    inputSchema: { type: 'object', properties: {
      projectId: { type: 'string' }, shot: { type: 'string' },
      mode: { type: 'string', enum: ['list', 'guide', 'generate', 'attach', 'unpin'] },
      frame: { type: 'integer', minimum: 0, description: 'Blockout frame number at 24 fps' },
      at: { type: ['string', 'number'], description: '"start", "end" or seconds into the shot (nearest frame); instead of frame' },
      role: { type: 'string', enum: ['start', 'end', 'middle', 'none'] },
      referenceId: { type: 'string', description: 'attach: a specific still (default: the newest take at the frame)' },
      model: { type: 'string', description: 'Video model id: report which key frames it takes and when' },
      presetId: { type: 'string', description: 'generate: image model (default flux-2-pro; flux-3 keeps the blockout best)' },
      prompt: { type: 'string' }, moment: { type: 'string' }, count: { type: 'integer', minimum: 1, maximum: 4 }, seed: { type: 'integer' },
      maxCostUsd: { type: 'number', minimum: 0.01, maximum: 5 }, width: { type: 'integer', minimum: 160, maximum: 1280 },
    }, required: ['projectId', 'shot'], additionalProperties: false } };
  return { tool, run };
}
