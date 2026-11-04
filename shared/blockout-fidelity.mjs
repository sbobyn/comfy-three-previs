// Copyright (c) 2026 Steven Bobyn. SPDX-License-Identifier: MIT
// How faithfully each video route keeps the blockout's motion and direction (which way the subject faces and travels),
// and which shots need a route that does. A heuristic from a few observed takes, not a measurement: the evidence is the
// 2026-11-01 Wingspan regens (.evidence/regen3-20261101, regen4-20261101, regen5-20261101 STATUS.md):
//   - Seedance 2.5 edit of the blockout clip kept the eagle seen from behind and flying away in 3 of 3 shots.
//   - Start-still and start → end routes (FLUX stills → LTX Fast, LTX Pro start → end) turned the eagle into the lens.
//   - Kling O1 edit with look references copied the look images' framing and turned the eagle to face the camera (0 of 2;
//     it held the Posterized dunk, 1 of 1).
// Only a person checking frames caught those direction errors; the take direction check (server/previs/take-grade.mjs)
// now flags them too. Nothing here blocks a model: it explains and recommends.
import { cameraSourceOf } from './camera-source.mjs';
import { frameLayout, subjectOf } from './still-match.mjs';
import { entitySize, entityAt, shotCameraAt } from './director.mjs';

const presetOf = def => def?.provenance?.presetId || def?.id || '';
const EVIDENCE = 'Wingspan regens, 2026-11-01';

/** Per-preset fidelity, where takes were judged by eye. direction: follows | mixed | approximate. */
export const VIDEO_FIDELITY = {
  'seedance-25-edit-v1': { route: 'edit', direction: 'follows', tested: true,
    note: 'Edits the blockout clip itself: kept the blockout’s motion and which way the subject faces in 3 of 3 Wingspan shots (glide, valley, dive).' },
  'kling-o1-edit-v1': { route: 'edit', direction: 'mixed', tested: true,
    note: 'Edits the blockout clip, but with look images it copied their framing and turned the eagle to face the camera in 2 of 2 Wingspan shots (valley, dive); it held the Posterized dunk.' },
  'wan-vace-13b-edge-v1': { route: 'control', direction: 'follows', tested: false,
    note: 'Generates from the blockout clip’s edges, so layout and motion follow it by construction. Not tested in the Wingspan regens.' },
};
// Routes without their own entry, by where their camera comes from.
const BY_SOURCE = {
  blockout: { route: 'edit', direction: 'mixed', tested: false, note: 'Takes the blockout clip, but this model was never checked for keeping direction.' },
  keyframes: { route: 'start-end', direction: 'approximate', tested: true, note: 'Interpolates between start and end stills from text: the motion in between, and which way the subject faces, are the model’s guess (LTX 2.5 Pro start → end turned the eagle into the lens on The dive).' },
  still: { route: 'start', direction: 'approximate', tested: true, note: 'Animates one still from text: motion and direction are the model’s guess (LTX 2.5 Fast turned the eagle into the lens on The dive; FLUX stills → LTX were rejected on The valley).' },
};
export const ROUTE_LABELS = { edit: 'Edits the blockout clip', control: 'Blockout clip as control frames', 'start-end': 'Start + end stills + text', start: 'Start still + text' };
export const DIRECTION_LABELS = { follows: 'Follows blockout direction', mixed: 'Direction sometimes lost', approximate: 'Direction is a guess' };
const RANK = { follows: 2, mixed: 1, approximate: 0 };

/** Blockout fidelity of a video definition: { route, routeLabel, direction, label, note, tested, heuristic, basis }. */
export function blockoutFidelity(def) {
  const own = VIDEO_FIDELITY[presetOf(def)], f = own || BY_SOURCE[cameraSourceOf(def)] || BY_SOURCE.still;
  return { route: f.route, routeLabel: ROUTE_LABELS[f.route], direction: f.direction, label: DIRECTION_LABELS[f.direction], note: f.note, tested: f.tested, heuristic: true, basis: own || f.tested ? EVIDENCE : 'route type only' };
}
export const fidelityRank = def => RANK[blockoutFidelity(def).direction];

// ---------- How much the shot's subject moves and turns ----------
const deg = r => (r * 180) / Math.PI;
const wrap = a => ((a + 540) % 360) - 180;
const FACING = [[0, 'toward'], [45, 'toward-right'], [90, 'right'], [135, 'away-right'], [180, 'away'], [-135, 'away-left'], [-90, 'left'], [-45, 'toward-left']];
/** Nearest of 8 directions for an angle (0 = toward the camera, +90 = screen-right, ±180 = away). */
export const directionWord = a => (a == null ? null : FACING.reduce((b, x) => (Math.abs(wrap(a - x[0])) < Math.abs(wrap(a - b[0])) ? x : b))[1]);
export const DIRECTION_ANGLES = Object.fromEntries(FACING.map(([a, w]) => [w, a]));
const PHRASE = { toward: 'toward the camera', 'toward-right': 'toward the camera and screen-right', right: 'screen-right', 'away-right': 'away and screen-right', away: 'away from the camera', 'away-left': 'away and screen-left', left: 'screen-left', 'toward-left': 'toward the camera and screen-left' };
export const directionPhrase = w => PHRASE[w] || w || 'unclear';

/**
 * Where the shot's subject faces and travels at shot time t, relative to the camera (same angles as frameLayout's
 * heading: 0 = toward the camera, ±180 = away). travel is null when the subject barely moves (under a quarter of its
 * size per second). Measured from the 3D scene, so it also holds for a camera that follows the subject.
 */
export function subjectDirection(project, shot, t, subjectId = null) {
  const layout = frameLayout(project, shot, t), subj = (subjectId && layout.items.find(i => i.id === subjectId)) || subjectOf(layout, shot);
  if (!subj) return { t, subject: null };
  const cam = shotCameraAt(shot, project.scene.entities, t), f = [cam.look[0] - cam.p[0], cam.look[2] - cam.p[2]], fl = Math.hypot(...f) || 1;
  const flat = [f[0] / fl, f[1] / fl], right = [-flat[1], flat[0]];
  const ent = project.scene.entities.find(e => e.id === subj.id), dt = Math.min(0.1, shot.duration / 4), at = x => (ent ? entityAt(ent, (shot.start || 0) + x).position : null);
  const a = at(Math.max(0, t - dt)), b = at(Math.min(shot.duration, t + dt)), span = Math.min(shot.duration, t + dt) - Math.max(0, t - dt);
  const v = a && b && span > 0 ? [(b[0] - a[0]) / span, (b[2] - a[2]) / span] : [0, 0], speed = Math.hypot(...v), size = Math.max(...subj.size);
  // Same convention as frameLayout's heading: camera right is (-fz, fx) on the ground; screen-right positive, away ±180.
  const travel = speed > size / 4 ? Math.round(deg(Math.atan2(v[0] * right[0] + v[1] * right[1], -(v[0] * flat[0] + v[1] * flat[1])))) : null;
  return { t, subject: { id: subj.id, name: subj.name }, heading: subj.heading, facing: directionWord(subj.heading), travel, travelWord: directionWord(travel), speed: Math.round(speed * 100) / 100, size, x: subj.x, coverage: subj.coverage };
}

/**
 * How demanding the shot is for motion and direction: { subject, samples, facesAway, turn, distance, level, reasons }.
 * level 'high' when the subject faces away from the camera for most of the shot (the case every start-frame route got
 * wrong), turns by 60° or more, or travels four or more of its own lengths. Heuristic.
 */
export function shotMotion(project, shot, { samples = 7 } = {}) {
  const ts = Array.from({ length: samples }, (_, i) => (shot.duration * (i + 0.5)) / samples);
  const first = ts.map(t => subjectDirection(project, shot, t)).filter(x => x.subject);
  const counts = new Map(); for (const x of first) counts.set(x.subject.id, (counts.get(x.subject.id) || 0) + 1);
  const id = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!id) return { subject: null, samples: [], facesAway: 0, turn: 0, distance: 0, lengths: 0, level: 'normal', reasons: [] };
  const rows = ts.map(t => subjectDirection(project, shot, t, id)).filter(x => x.subject?.id === id);
  const subject = rows[0].subject, fronted = rows.filter(x => x.heading != null);
  const facesAway = fronted.length ? fronted.filter(x => Math.abs(x.heading) >= 115).length / fronted.length : 0;
  // Turning is the subject's own rotation in the world (a camera that moves around a still subject is not a turn).
  const ent = project.scene.entities.find(e => e.id === id), pos = x => entityAt(ent, (shot.start || 0) + x).position, yaw = x => entityAt(ent, (shot.start || 0) + x).rotation || 0;
  let turn = 0; for (let i = 1; i <= 20; i++) turn += Math.abs(wrap(yaw((shot.duration * i) / 20) - yaw((shot.duration * (i - 1)) / 20)));
  let distance = 0; for (let i = 0, prev = pos(0); i < 20; i++) { const p = pos((shot.duration * (i + 1)) / 20); distance += Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]); prev = p; }
  const size = Math.max(...entitySize(ent)), lengths = distance / Math.max(0.01, size);
  const reasons = [];
  if (facesAway >= 0.5) reasons.push(`${subject.name} faces away from the camera${facesAway === 1 ? ' for the whole shot' : ' for most of the shot'}; start-frame routes turned a subject like this toward the lens`);
  if (turn >= 60) reasons.push(`${subject.name} turns about ${Math.round(turn)}° during the shot`);
  if (lengths >= 4) reasons.push(`${subject.name} travels ${Math.round(distance * 10) / 10} m (${Math.round(lengths)} of its lengths)`);
  return { subject, samples: rows.map(x => ({ t: Math.round(x.t * 100) / 100, facing: x.facing, heading: x.heading, travel: x.travelWord })), facesAway: Math.round(facesAway * 100) / 100, turn: Math.round(turn), distance: Math.round(distance * 100) / 100, lengths: Math.round(lengths * 10) / 10, level: reasons.length ? 'high' : 'normal', reasons };
}

// ---------- Advice ----------
const isLocal = d => presetOf(d).startsWith('wan-');
const clipFits = (d, secs) => { const c = d.constraints?.sourceVideo?.duration; return !c || (secs >= c.min && secs <= c.max); };
/**
 * Whether a shot needs a route that keeps blockout direction, and which model to use. A shot is critical when the user
 * flagged it (shot.motionCritical) or shotMotion rates it high. `defs` are the available video definitions; the
 * recommendation is the tested 'follows' route that accepts this clip length (cloud before local, then cheapest).
 * Returns { critical, flagged, auto, reasons, subject, model, ok, recommend, message }. Advice only: nothing is blocked.
 */
export function fidelityAdvice(project, shot, def, defs = [], motion = shotMotion(project, shot)) {
  const flagged = shot.motionCritical === true, auto = motion.level === 'high', critical = flagged || auto;
  const model = def ? { id: def.id, title: def.title, ...blockoutFidelity(def) } : null;
  const ok = !critical || model?.direction === 'follows';
  const secs = shot.render?.duration ?? shot.duration;
  const follow = defs.filter(d => blockoutFidelity(d).direction === 'follows');
  const fitting = follow.filter(d => clipFits(d, secs))
    .sort((a, b) => Number(blockoutFidelity(b).tested) - Number(blockoutFidelity(a).tested) || Number(isLocal(a)) - Number(isLocal(b)) || (a.pricing?.ratePerSecond ?? 0) - (b.pricing?.ratePerSecond ?? 0));
  const best = fitting[0] || null;
  const why = [flagged ? 'flagged motion/direction-critical' : null, ...motion.reasons].filter(Boolean);
  const reasons = why.length ? why.join('; ') : '';
  const recommend = !ok && best && best.id !== def?.id ? { id: best.id, title: best.title, ...blockoutFidelity(best) } : null;
  let message = '';
  if (critical && !ok) {
    const name = model ? model.title.split(' · ')[0] : 'This model';
    message = `Direction-critical shot (${reasons}). ${name}: ${model?.label.toLowerCase() || 'unknown'} (${model?.routeLabel.toLowerCase() || 'unknown route'}). `
      + (recommend ? `Recommended: ${recommend.title}. ${recommend.note}` : follow.length ? `No route that kept direction accepts a ${secs} s clip (${follow.map(d => `${d.title.split(' · ')[0]} needs ${d.constraints?.sourceVideo?.duration?.min ?? '?'}–${d.constraints?.sourceVideo?.duration?.max ?? '?'} s`).join('; ')}); change the shot length, or check each take’s direction.` : 'No route that kept direction is set up; check each take’s direction.')
      + ' Heuristic from a few judged takes; not blocked.';
  } else if (critical) message = `Direction-critical shot (${reasons}). ${model.title.split(' · ')[0]}: ${model.label.toLowerCase()} (${model.routeLabel.toLowerCase()}). Heuristic; still check the take’s direction.`;
  return { critical, flagged, auto, reasons: why, subject: motion.subject, motion: { level: motion.level, facesAway: motion.facesAway, turn: motion.turn, distance: motion.distance, lengths: motion.lengths, samples: motion.samples }, model, ok, recommend, message, heuristic: true };
}
/** The model to start a critical shot on when nothing is saved: the recommendation, else null (keep the usual default). */
export function defaultForShot(project, shot, defs) {
  const motion = shotMotion(project, shot);
  if (shot.motionCritical !== true && motion.level !== 'high') return null;
  const a = fidelityAdvice(project, shot, null, defs, motion);
  return a.recommend ? defs.find(d => d.id === a.recommend.id) || null : null;
}
