// Copyright (c) 2026 Steven Bobyn. SPDX-License-Identifier: MIT
// Exact-frame key stills. A blockout is captured at 24 fps: frame i is shot time i / 24 and a shot of d seconds encodes
// frames 0 … n − 1 (n = round(d · 24), 2–120; a Blender clip keeps its own count). "Start" is frame 0 and "End" is the
// last encoded frame (a 5 s shot ends on frame 119 at 4.958 s, not at 5.000 s), so a still is made from, graded against
// and handed to a video model as one real blockout frame.
//
// Roles a still can play for a video model:
//   start / end – the first and last frame inputs of a start → end model (newest take at frame 0 / the last frame, or a
//                 still from another frame chosen as the start or end: an override that remembers its frame).
//   middle      – timed in-between frames. Only models whose node really takes them get them (TIMED_KEYFRAMES); the
//                 shot pins frame numbers (shot.middleKeys) and the newest take at each pinned frame is sent.
import { blockoutStale, keyStillState, stillStale } from './director.mjs';

export const FPS = 24;
const MAX_FRAMES = 120;

/** Frames the shot's blockout encodes: a current render's own count (a Blender clip), else what a capture makes. */
export function frameCount(project, shot) {
  if (shot.render?.frameCount && !blockoutStale(project, shot)) return shot.render.frameCount;
  return Math.min(MAX_FRAMES, Math.max(2, Math.round((Number(shot.duration) || 0) * FPS)));
}
export const lastFrame = (project, shot) => frameCount(project, shot) - 1;
/** Shot time of frame i (exact seconds). */
export const frameTime = i => i / FPS;
/** Seconds as the storyboard stores a moment (two decimals; still notes are `key frame @<t>s`). Unique per frame at 24 fps. */
export const momentSeconds = i => Math.round(frameTime(i) * 100) / 100;

/**
 * One blockout frame from `{ frame }` (an index), `at` ('start', 'end' or 'last', or seconds into the shot: the nearest
 * encoded frame). Throws for a frame outside the clip. Returns { index, t, count, role, frameAt } where frameAt is what the
 * still request records ('start', 'end' or seconds) and role is 'start', 'end' or 'middle'.
 */
export function resolveFrame(project, shot, { at = null, frame = null } = {}) {
  const n = frameCount(project, shot);
  let i;
  if (frame !== null && frame !== undefined) {
    i = Number(frame);
    if (!Number.isInteger(i) || i < 0 || i >= n) throw Error(`frame must be a whole frame number from 0 to ${n - 1} (this shot's blockout has ${n} frames at ${FPS} fps)`);
  } else if (at === 'start') i = 0;
  else if (at === 'end' || at === 'last') i = n - 1;
  else {
    const t = Number(at);
    if (at === null || at === '' || !Number.isFinite(t)) throw Error('Choose a frame: "start", "end", seconds into the shot, or a frame number');
    i = Math.max(0, Math.min(n - 1, Math.round(t * FPS)));
  }
  const role = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
  return { index: i, t: frameTime(i), count: n, role, frameAt: role === 'middle' ? momentSeconds(i) : role };
}

/**
 * The blockout frame a still shows: { index, t, exact, override }. Stills made here record their frame
 * (generated.frame); older ones are read from their note. An older End still was made at the shot's full length, the
 * camera's end pose, which is not an encoded frame: it reads as the last frame with exact: false. override is true for
 * a still from another frame chosen as the start or end.
 */
export function stillFrame(project, shot, ref) {
  const n = frameCount(project, shot), g = ref?.generated?.frame, note = ref?.note || '', ov = ref?.keyOverride;
  // A still from another frame chosen as the start or end shows that frame (uploads included).
  if (ov && Number.isInteger(ov.frame)) return { index: ov.frame, t: ov.t ?? frameTime(ov.frame), exact: ov.exact !== false, override: true };
  const override = !!ov;
  if (g && Number.isInteger(g.index)) return { index: g.index, t: frameTime(g.index), exact: true, override };
  if (note === 'key frame start') return { index: 0, t: 0, exact: true, override };
  if (note === 'key frame end') return { index: n - 1, t: Number(shot.duration) || frameTime(n - 1), exact: false, override };
  const m = /^key frame @([\d.]+)s$/.exec(note);
  if (!m) return null;
  const t = Number(m[1]), i = Math.max(0, Math.min(n - 1, Math.round(t * FPS)));
  return { index: i, t, exact: momentSeconds(i) === t, override }; // exactly how that frame's moment is stored
}

/** The shot's pinned middle key frames: sorted, unique frame numbers (at most 8). */
export const middleKeys = shot => [...new Set((shot.middleKeys || []).filter(i => Number.isInteger(i) && i > 0))].sort((a, b) => a - b).slice(0, MAX_MIDDLE);
export const MAX_MIDDLE = 8;

/** The take in use at a frame (its newest still there), ignoring start/end key stills. */
export function takeAt(project, shot, index) {
  return (shot.references || []).filter(r => r.role === 'frame' && r.note !== 'key frame start' && r.note !== 'key frame end' && stillFrame(project, shot, r)?.index === index).at(-1) || null;
}

const stateOf = (project, shot, r) => (!r ? 'missing' : stillStale(project, shot, r) ? 'stale' : 'ready');
/**
 * Every key frame of the shot with its readiness, frame-addressed: start and end (keyStillState: the same pick every
 * video path uses) and each pinned middle frame. 'stale' means made for an earlier camera, timing or scene; a pinned
 * frame past the end of a shortened shot is 'missing' with outOfRange.
 */
export function keyframeState(project, shot) {
  const ks = keyStillState(project, shot), n = frameCount(project, shot);
  const row = (role, ref, state, index) => ({ role, ref, state, index, t: index === null ? null : frameTime(index), frame: ref ? stillFrame(project, shot, ref) : null });
  const middle = middleKeys(shot).map(i => {
    if (i >= n - 1) return { ...row('middle', null, 'missing', i), outOfRange: true };
    const ref = takeAt(project, shot, i);
    return row('middle', ref, stateOf(project, shot, ref), i);
  });
  return { count: n, start: row('start', ks.start, ks.startState, 0), end: row('end', ks.end, ks.endState, n - 1), middle };
}

// ---------- Video models that take timed in-between frames ----------
/**
 * Video nodes in the model registry (server/previs/presets.mjs) whose live schema takes in-between key frames, checked
 * against Comfy Cloud object_info on 2026-10-31. Only Kling 4.0 does: `model.middle_frames.middle_frame_1…8` (auto-grow),
 * described by the node as "Middle frames are spaced evenly". The provider places them by count, not at chosen times,
 * so a plan shows where each one lands. Every other registry model (LTX 2.5, Seedance 2.5, Veo 3.1, MiniMax H3, Wan 2.7)
 * takes a first and an optional last frame only; the clip-edit models take the blockout clip.
 */
export const TIMED_KEYFRAMES = {
  Kling4ImageToVideoNode: { input: 'model.middle_frames.middle_frame_', max: MAX_MIDDLE, spacing: 'even', checkedAt: '2026-10-31' },
};

/** { nodeId, spec } of the definition's node that takes middle frames, only for start → end definitions; else null. */
export function middleFrameTarget(definition) {
  if (definition?.task !== 'first-frame' || !definition.inputs?.lastFrame) return null;
  for (const [nodeId, node] of Object.entries(definition.graph || {})) { const spec = TIMED_KEYFRAMES[node.class_type]; if (spec) return { nodeId, spec }; }
  return null;
}
/** How many middle frames a definition can take (0 for start-only, clip and other models). */
export const maxMiddleFrames = definition => middleFrameTarget(definition)?.spec.max ?? Object.keys(definition?.inputs || {}).filter(k => /^middleFrame[1-9]$/.test(k)).length;

/**
 * A copy of a start → end definition with `count` middle-frame inputs (middleFrame1…N, each a LoadImage) wired into the
 * node's middle-frame slots in time order. The original when count is 0 or the model takes none.
 */
export function withMiddleFrames(definition, count) {
  const target = middleFrameTarget(definition);
  const n = Math.min(Math.max(0, Math.floor(count)), target?.spec.max ?? 0);
  if (!target || !n) return definition;
  const d = structuredClone(definition), node = d.graph[target.nodeId];
  for (let i = 1; i <= n; i++) {
    d.graph[`mid${i}`] = { class_type: 'LoadImage', inputs: { image: `previs-middle-frame-${i}.png` } };
    d.inputs[`middleFrame${i}`] = { nodeId: `mid${i}`, input: 'image' };
    node.inputs[`${target.spec.input}${i}`] = [`mid${i}`, 0];
  }
  d.title = `${definition.title} · ${n} middle frame${n === 1 ? '' : 's'}`;
  d.provenance = { ...(definition.provenance || {}), presetId: definition.provenance?.presetId || definition.id, middleFrames: n };
  return d;
}

/** Frames that land exactly where an evenly spacing model puts `count` middle frames on a clip of n frames. */
export const evenFrames = (n, count) => Array.from({ length: count }, (_, k) => Math.round(((k + 1) * (n - 1)) / (count + 1)));
// More than this off its slot (in output seconds) and the plan warns: the still will appear at another moment.
const DRIFT_WARN_SECONDS = 0.25;

/**
 * Which key frames a video model gets for a shot, and when: { start, end, middle, unused, warnings, evenFrames }.
 * `seconds` is the clip length the model makes (clipSecondsFor). start/end carry their frame and readiness; middle rows
 * add `slot` (1…N), `atSeconds` (where the model puts it in the output, evenly spaced), `blockoutSeconds` (where that
 * frame is in the blockout, scaled to the output length) and `driftSeconds` (atSeconds − blockoutSeconds). Pinned middle
 * frames a model cannot take are listed in `unused` with the reason; nothing is silently dropped.
 */
export function keyframePlan(project, shot, definition, { seconds = null } = {}) {
  const st = keyframeState(project, shot), n = st.count, out = Number(seconds) || frameTime(n - 1);
  const usesFrames = definition?.task === 'first-frame', twoFrames = usesFrames && !!definition.inputs?.lastFrame;
  const target = middleFrameTarget(definition), max = target?.spec.max ?? 0;
  const title = String(definition?.title || 'This model').split(' ·')[0];
  const plan = { frames: n, fps: FPS, outputSeconds: out, start: usesFrames ? st.start : null, end: twoFrames ? st.end : null, middle: [], unused: [], warnings: [], evenFrames: [], spacing: target?.spec.spacing || null };
  const pinned = st.middle;
  if (!pinned.length) return plan;
  if (!target) {
    plan.unused = pinned.map(m => ({ ...m, why: !usesFrames ? `${title} follows the blockout clip; it takes no key frames` : !twoFrames ? `${title} animates one start still; it takes no in-between frames` : `${title} takes only a start and an end frame` }));
    return plan;
  }
  const used = pinned.slice(0, max), m = used.length;
  plan.unused = pinned.slice(max).map(x => ({ ...x, why: `${title} takes at most ${max} in-between frames` }));
  plan.evenFrames = evenFrames(n, m);
  plan.middle = used.map((x, k) => {
    const atSeconds = ((k + 1) / (m + 1)) * out, blockoutSeconds = (x.index / (n - 1)) * out, drift = atSeconds - blockoutSeconds;
    return { ...x, slot: k + 1, atSeconds: round3(atSeconds), blockoutSeconds: round3(blockoutSeconds), driftSeconds: round3(drift) };
  });
  for (const x of plan.middle) if (Math.abs(x.driftSeconds) > DRIFT_WARN_SECONDS)
    plan.warnings.push(`${title} spaces in-between frames evenly: frame ${x.index} lands at ${x.atSeconds.toFixed(2)} s of the ${out} s clip, ${Math.abs(x.driftSeconds).toFixed(2)} s ${x.driftSeconds > 0 ? 'later' : 'earlier'} than in the blockout. Frame${m > 1 ? 's' : ''} ${plan.evenFrames.join(', ')} land${m > 1 ? '' : 's'} exactly.`);
  return plan;
}
const round3 = x => Math.round(x * 1000) / 1000;

/** Short label for a frame: "frame 60 · 2.50 s". */
export const frameLabel = i => `frame ${i} · ${frameTime(i).toFixed(2)} s`;

// ---------- Edits ----------
/**
 * Key-frame edit ops (applied by server/previs/director.mjs applyOps):
 *   { op: 'set_middle_keys', shotId, frames: [i…] }   pin in-between key frames (frame numbers; [] clears)
 *   { op: 'use_as_key_still', shotId, referenceId, role: 'start' | 'end', id? }
 *       a still from another frame becomes the start or end key frame. The new reference shares the image file and keeps
 *       its provenance (generated.signature, so it goes stale with the shot) and records the frame it shows (keyOverride).
 * Returns the op result, or null when the op is not one of these.
 */
export function applyKeyframeOp(p, op, { resolveShot, newId, now }) {
  if (op.op === 'set_middle_keys') {
    const s = resolveShot(p, op.shotId); if (!s) throw Object.assign(Error('Unknown shot'), { status: 400 });
    if (!Array.isArray(op.frames) || op.frames.length > MAX_MIDDLE || op.frames.some(i => !Number.isInteger(i) || i <= 0 || i >= MAX_FRAMES - 1)) throw Object.assign(Error(`frames must be up to ${MAX_MIDDLE} whole frame numbers between the first and last frame`), { status: 400 });
    const frames = [...new Set(op.frames)].sort((a, b) => a - b);
    if (frames.length) s.middleKeys = frames; else delete s.middleKeys;
    return { op: op.op, id: s.id, frames };
  }
  if (op.op === 'use_as_key_still') {
    const s = resolveShot(p, op.shotId); if (!s) throw Object.assign(Error('Unknown shot'), { status: 400 });
    if (!['start', 'end'].includes(op.role)) throw Object.assign(Error('role must be start or end'), { status: 400 });
    const src = s.references.find(r => r.id === op.referenceId && r.role === 'frame'); if (!src) throw Object.assign(Error('Unknown still'), { status: 400 });
    if (s.references.length >= 24) throw Object.assign(Error('A shot supports at most 24 references'), { status: 400 });
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const id = uuid.test(op.id || '') && !s.references.some(r => r.id === op.id) ? op.id : newId();
    const from = stillFrame(p, s, src);
    // No requestId/outputKey: result collection matches those, and this is not a new output.
    const { requestId, outputKey, promptId, ...gen } = src.generated || {};
    const keyOverride = { role: op.role, from: src.id, frame: from?.index ?? null, ...(from ? { t: from.t, exact: from.exact } : {}) };
    s.references.push({ id, name: `${src.name.slice(0, 50)} · ${op.role} (from ${from ? `frame ${from.index}` : 'unpinned'})`, file: src.file, mime: src.mime, role: 'frame', entityId: null, note: `key frame ${op.role}`, createdAt: now(), keyOverride, ...(src.generated ? { generated: { ...gen, copyOf: src.id } } : {}) });
    return { op: op.op, id, role: op.role, from: from?.index ?? null };
  }
  return null;
}
