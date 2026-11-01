// Storyboard key frames on the shot timeline: which blockout frames are the start, end and timed in-between key
// frames, whether each still is current for the shot's blocking, and what the chosen video model does with them.
// Frame model and readiness: shared/keyframes.mjs (the same rules the server, batch and MCP use).
import './director-keyframes.css';
import { h } from './director-common';
import { FPS, frameTime, keyframePlan, keyframeState, maxMiddleFrames, middleKeys, resolveFrame, stillFrame, MAX_MIDDLE } from '../shared/keyframes.mjs';
import type { KeyRow, KeyframePlan } from '../shared/keyframes.mjs';
import type { DirectorProject, Shot, Reference } from '../shared/director.mjs';
import { stillStale } from '../shared/director.mjs';

type Def = { id?: string; title?: string; task?: string; inputs?: Record<string, unknown>; graph?: any } | null;
const STATE_WORD = { ready: 'ready', stale: 'out of date', missing: 'no still' } as const;
const name = (d: Def) => String(d?.title || 'This model').split(' ·')[0];
const secs = (i: number) => `${frameTime(i).toFixed(2)} s`;

/** "Frame 60 · 2.50 s" for a frame number. */
export const frameText = (i: number) => `Frame ${i} · ${secs(i)}`;
/** The encoded blockout frame nearest a shot time (the storyboard snaps the playhead to it). */
export const snapFrame = (project: DirectorProject, s: Shot, t: number) => resolveFrame(project, s, { at: t });

/** Markers for the storyboard track: one per key frame (start, end, pinned in-between), coloured by readiness. */
export function keyMarks(project: DirectorProject, s: Shot, def: Def, onSeek: (t: number) => void): HTMLElement[] {
  const st = keyframeState(project, s), n = st.count, takes = maxMiddleFrames(def) > 0;
  // Same scale as the storyboard pins (shot time / length); the last frame sits at the end of the track.
  const at = (i: number) => `left:${i >= n - 1 ? 100 : Math.min(100, (frameTime(i) / Math.max(0.01, s.duration)) * 100)}%`;
  const used = (r: KeyRow) => r.role !== 'middle' || takes;
  const mark = (r: KeyRow, label: string) => h('button', {
    type: 'button', class: `kf-mark ${r.role} ${r.state}${used(r) ? '' : ' unused'}`, style: at(Math.min(r.index ?? 0, n - 1)),
    title: `${label} key frame · ${frameText(r.index ?? 0)} · ${STATE_WORD[r.state]}${r.outOfRange ? ' (past the end of the shot)' : ''}${r.frame?.override ? ` · a still from frame ${r.frame.index}` : ''}${used(r) ? '' : ` · not used by ${name(def)}`}`,
    'aria-label': `${label} key frame, frame ${r.index}, ${STATE_WORD[r.state]}`,
    onclick: (ev: MouseEvent) => { ev.stopPropagation(); onSeek(frameTime(Math.min(r.index ?? 0, n - 1))); },
  }, h('span', { 'aria-hidden': 'true' }, r.role === 'start' ? 'S' : r.role === 'end' ? 'E' : '◆'));
  return [mark(st.start, 'Start'), ...st.middle.map(r => mark(r, 'In-between')), mark(st.end, 'End')];
}

/** One line under the track: the key frames, their frame numbers and readiness, and the plan's timing warnings. */
export function keyStatus(project: DirectorProject, s: Shot, def: Def, seconds: number | null): HTMLElement {
  const plan = keyframePlan(project, s, def, { seconds });
  const st = keyframeState(project, s);
  const chip = (r: KeyRow, label: string, extra = '') => h('span', { class: `kf-chip ${r.state}`, title: r.frame && !r.frame.exact && r.role === 'end' ? 'Made at the shot’s full length (the camera’s end pose), not on the last encoded frame. Make it again for the exact last frame.' : r.frame?.override ? `A still made at frame ${r.frame.index}, chosen as the ${r.role}` : '' },
    h('b', {}, label), ` ${r.index === null ? '' : `frame ${r.index}`}${r.frame?.override ? ` (from ${r.frame.index})` : ''} · ${STATE_WORD[r.state]}${extra}`);
  const mids = plan.middle.length ? plan.middle.map(m => chip(m, `In-between ${m.slot}`, ` · lands at ${m.atSeconds.toFixed(2)} s`)) : st.middle.map(r => chip(r, 'In-between', ''));
  const lines: (Node | null)[] = [
    h('div', { class: 'kf-row' }, chip(st.start, 'Start'), ...mids, chip(st.end, 'End')),
    plan.unused.length ? h('p', { class: 'note kf-note' }, `Not sent: ${plan.unused.map(u => `frame ${u.index}`).join(', ')} · ${plan.unused[0].why}.`) : null,
    ...plan.warnings.map(w => h('p', { class: 'note kf-note warn' }, w)),
  ];
  return h('div', { class: 'kf-status', role: 'group', 'aria-label': `Key frames · ${st.count} blockout frames at ${FPS} fps` }, ...lines);
}

/**
 * Key-frame actions for one storyboard moment (its take in use): make it the start or end (a still from another
 * frame: an override that keeps its frame), and pin or unpin it as a timed in-between frame for models that take them.
 * `run` applies an undoable edit (redo/undo ops).
 */
export function momentKeyActions(project: DirectorProject, s: Shot, used: Reference, def: Def, slots: ('start' | 'end')[], run: (entry: { label: string; redo: unknown[]; undo: unknown[] }) => void): HTMLElement | null {
  const f = stillFrame(project, s, used); if (!f) return null;
  const n = keyframeState(project, s).count, role = f.index === 0 ? 'start' : f.index === n - 1 ? 'end' : 'middle';
  const pinned = middleKeys(s), isPinned = pinned.includes(f.index), takes = maxMiddleFrames(def) > 0;
  const buttons: Node[] = [];
  for (const w of slots) if (w !== role) {
    const id = crypto.randomUUID();
    buttons.push(h('button', { class: 'linklike', type: 'button', title: `This still (frame ${f.index}) becomes the ${w} key frame; ${name(def)} animates ${slots.length > 1 ? 'start → end' : 'from the start'}. It is marked as made at frame ${f.index}.`, onclick: () => run({ label: `Use frame ${f.index} as ${w}`, redo: [{ op: 'use_as_key_still', shotId: s.id, referenceId: used.id, role: w, id }], undo: [{ op: 'remove_reference', shotId: s.id, referenceId: id }] }) }, `Use as ${w}`));
  }
  if (role === 'middle' && (takes || isPinned)) {
    const next = isPinned ? pinned.filter(i => i !== f.index) : [...pinned, f.index].sort((a, b) => a - b);
    const full = !isPinned && pinned.length >= MAX_MIDDLE;
    buttons.push(h('button', { class: 'linklike', type: 'button', disabled: full, title: isPinned ? 'Stop sending this frame as an in-between key frame' : `Send this still as a timed in-between key frame. ${name(def)} spaces in-between frames evenly between the start and end.`, onclick: () => run({ label: `${isPinned ? 'Unpin' : 'Pin'} frame ${f.index}`, redo: [{ op: 'set_middle_keys', shotId: s.id, frames: next }], undo: [{ op: 'set_middle_keys', shotId: s.id, frames: pinned }] }) }, isPinned ? 'Unpin in-between' : 'Pin as in-between'));
  }
  return buttons.length ? h('div', { class: 'sb-key' }, h('span', {}, 'Key frame'), ...buttons) : null;
}

/** Frame tag for a moment card: "frame 60", and "out of date" when its take was made for an earlier blocking. */
export function momentTags(project: DirectorProject, s: Shot, used: Reference): Node[] {
  const f = stillFrame(project, s, used), stale = stillStale(project, s, used), pinned = f ? middleKeys(s).includes(f.index) : false;
  return [
    f ? h('span', { class: 'kf-frame', title: f.exact ? `Blockout frame ${f.index} of the shot (${FPS} fps)` : `Made at ${f.t}s, not on an encoded frame; the nearest is frame ${f.index}` }, `${f.exact ? '' : '≈'}frame ${f.index}`) : null,
    pinned ? h('span', { class: 'kf-pin' }, 'In-between key') : null,
    stale ? h('span', { class: 'kf-stale', title: 'Made before the shot’s camera, timing or scene changed. Video models are never sent it; make a new take.' }, 'out of date') : null,
  ].filter(Boolean) as Node[];
}

/** The model-input card's row for in-between frames: what this model does with the pinned ones. null when neither applies. */
export function middleSlotText(project: DirectorProject, s: Shot, def: Def, seconds: number | null): { ok: boolean | null; text: string } | null {
  const plan: KeyframePlan = keyframePlan(project, s, def, { seconds }), max = maxMiddleFrames(def);
  if (!max && !plan.unused.length) return null;
  if (!max) return { ok: null, text: `${plan.unused.length} pinned · not sent: ${plan.unused[0].why}` };
  if (!plan.middle.length) return { ok: null, text: `None pinned · ${name(def)} takes up to ${max}, spaced evenly; pin a storyboard still as an in-between key` };
  const bad = plan.middle.filter(m => m.state !== 'ready');
  return { ok: !bad.length, text: `${plan.middle.map(m => `frame ${m.index} → ${m.atSeconds.toFixed(2)} s`).join(', ')}${bad.length ? ` · ${bad.length} ${bad.every(m => m.state === 'stale') ? 'out of date' : 'without a still'} (refused until made again)` : ''}${plan.warnings.length ? ` · evenly spaced, so ${plan.evenFrames.length > 1 ? `frames ${plan.evenFrames.join(', ')} land` : `frame ${plan.evenFrames[0]} lands`} exactly` : ''}` };
}

/** Quote card line: the key frames bound to the request and where each in-between one lands. */
export function planFacts(plan: KeyframePlan | undefined): HTMLElement | null {
  if (!plan || (!plan.start && !plan.middle.length)) return null;
  const parts = [plan.start ? `start frame ${plan.start.index}` : '', ...plan.middle.map(m => `in-between ${m.slot}: frame ${m.index} at ${m.atSeconds.toFixed(2)} s${Math.abs(m.driftSeconds) > 0.04 ? ` (blockout ${m.blockoutSeconds.toFixed(2)} s)` : ''}`), plan.end ? `end frame ${plan.end.index}` : ''].filter(Boolean);
  return h('div', { class: 'kf-plan' }, h('span', { class: 'eyebrow' }, `Key frames · ${plan.frames} blockout frames → ${plan.outputSeconds} s`), h('p', { class: 'note', style: 'margin:2px 0 0' }, parts.join(' · ')),
    ...plan.warnings.map(w => h('p', { class: 'note kf-note warn' }, w)));
}
