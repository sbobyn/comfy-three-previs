// Copyright (c) 2026 Steven Bobyn. SPDX-License-Identifier: MIT
// Take direction check: does a generated video keep which way the blockout's subject faces and travels? A few moments are
// sampled from the blockout clip and the take; the paid grader (server/previs/take-grade.mjs, PREVIS_MATCH_GRADER=gemini)
// names the subject's facing and travel in each, and this module compares them with the blockout, measured from the 3D
// scene when it still matches the clip (shared/blockout-fidelity.mjs subjectDirection), else as the grader read it.
// Pure: no I/O, so it is tested with fixtures and no paid calls.
import { DIRECTION_ANGLES, subjectDirection } from './blockout-fidelity.mjs';

export const DIRECTION_WORDS = Object.keys(DIRECTION_ANGLES); // toward, toward-right, right, away-right, away, away-left, left, toward-left
export const DIRECTION_METHOD = 'direction-v1';
const wrap = a => ((a + 540) % 360) - 180;
const r2 = x => Math.round(x * 100) / 100;

/**
 * Sample moments (seconds) shared by the blockout clip and the take: `count` from 15% to 90% of the shorter clip, on 24 fps
 * frames. The last one is late on purpose: Kling O1 turned the Wingspan eagle toward the lens only in the last second.
 */
export function directionTimes(blockoutSeconds, takeSeconds, count = 4) {
  const d = Math.min(...[blockoutSeconds, takeSeconds].filter(x => Number.isFinite(x) && x > 0));
  if (!Number.isFinite(d)) return [];
  return Array.from({ length: count }, (_, i) => Math.round(d * (0.15 + (0.75 * i) / Math.max(1, count - 1)) * 24) / 24).map(r2);
}

/**
 * The blockout's subject at each moment, measured from the 3D scene: [{ t, facing, travel }] (words or null) and the
 * subject. `current` false (the scene changed since the clip was rendered) drops the measurement, so the grader's own
 * reading of the blockout frames is used instead.
 */
export function blockoutPlan(project, shot, times, { current = true } = {}) {
  const rows = times.map(t => subjectDirection(project, shot, t));
  const ids = new Map(); for (const r of rows) if (r.subject) ids.set(r.subject.id, (ids.get(r.subject.id) || 0) + 1);
  const id = [...ids].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const main = id ? times.map(t => subjectDirection(project, shot, t, id)) : rows;
  const subject = main.find(r => r.subject?.id === id)?.subject || null;
  const where = x => (x == null ? '' : x < 0.35 ? 'left of frame' : x > 0.65 ? 'right of frame' : 'centre of frame');
  const e = subject ? project.scene.entities.find(x => x.id === subject.id) : null;
  return {
    subject: subject ? { ...subject, kind: e?.kind || null, shape: e?.shape || null } : null, measured: !!subject && current,
    frames: main.map(r => ({ t: r2(r.t), where: r.subject?.id === id ? where(r.x) : '', facing: current && r.subject?.id === id ? r.facing ?? null : null, travel: current && r.subject?.id === id ? r.travelWord ?? null : null })),
  };
}

const NOUN = { bird: 'a bird', person: 'a person', car: 'a car' };
/**
 * The grader prompt. When the blockout was measured from the 3D scene (plan.measured) the grader sees only the take's
 * frames (one image), so it cannot anchor on the plan: in validation, with the blockout beside it, it read a clearly
 * front-on eagle as "away". Otherwise image 1 is the blockout frames and image 2 the take's, and it reads both.
 * Frames are tiled left to right, top to bottom, in time order.
 */
export function directionPrompt(plan) {
  const n = plan.frames.length, ts = plan.frames.map(f => `${f.t.toFixed(2)} s`).join(', ');
  const subj = plan.subject ? `${plan.subject.name}${NOUN[plan.subject.shape] ? ` (${NOUN[plan.subject.shape]})` : ''}` : 'the main moving subject';
  const both = !plan.measured;
  const side = '"seen": which side of the subject faces the camera — "front" (you can see its face, eyes or beak, or its chest, legs or talons), "back" (the back of its head, its back or tail toward you), "left side", "right side", "unclear", or "absent" when it is not in the frame.';
  const dir = `"facing": which way its front points relative to the camera, and "travel": which way it moves through the scene relative to the camera (not where it is on screen: a camera that follows it can keep it centred while it flies or drives away). One word each: ${DIRECTION_WORDS.join(', ')} (left and right are screen-left and screen-right; toward = toward the camera, front visible; away = away from the camera, seen from behind), or "unclear", or "absent". travel can also be "still".`;
  const frame = '{"t":seconds,"seen":"…","facing":"…","travel":"…"}';
  return [
    both
      ? `Image 1 shows ${n} frames of a grey 3D blockout of one film shot at ${ts} (the plan), tiled left to right, top to bottom. Image 2 shows the same ${n} moments of a generated video of that shot, tiled the same way.`
      : `The image shows ${n} frames of a generated video at ${ts}, tiled left to right, top to bottom in time order.`,
    `The subject is ${subj}.`,
    `For each moment${both ? ' and each image' : ''}, report ${side}`,
    `Then ${dir}`,
    'Look at each frame on its own; the subject may turn during the shot.',
    both
      ? `Reply with JSON only: {"frames":[{"t":seconds,"blockout":${frame.replace('{"t":seconds,', '{')},"take":${frame.replace('{"t":seconds,', '{')}}],"why":"one short sentence about the generated video"}.`
      : `Reply with JSON only: {"frames":[${frame}],"why":"one short sentence"}.`,
  ].join('\n');
}

const word = v => { const w = String(v ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/^towards/, 'toward').replace(/^facing-/, ''); return DIRECTION_WORDS.includes(w) || ['unclear', 'absent', 'still'].includes(w) ? w : 'unclear'; };
/** The grader's reply → { frames: [{ t, blockout: { facing, travel }, take: { facing, travel } }], why }, or null. */
export function parseDirection(text, count = Infinity) {
  const m = /\{[\s\S]*\}/.exec(String(text || '')); if (!m) return null;
  let j; try { j = JSON.parse(m[0]); } catch { return null; }
  if (!Array.isArray(j.frames) || !j.frames.length) return null;
  // "seen" is the concrete observation: when it contradicts the facing word (front visible but "away"), it wins.
  const SEEN = { front: 'toward', back: 'away' };
  const side = x => {
    const seen = String(x?.seen ?? '').trim().toLowerCase(), facing = word(x?.facing), want = SEEN[seen];
    const fix = want && DIRECTION_ANGLES[facing] != null && Math.abs(wrap(DIRECTION_ANGLES[facing] - DIRECTION_ANGLES[want])) > 90 ? want : facing;
    return { facing: seen === 'absent' ? 'absent' : fix, travel: word(x?.travel), ...(seen ? { seen } : {}) };
  };
  // A take-only reply has the take's fields on the frame itself.
  return { frames: j.frames.slice(0, count).map(f => ({ t: Number.isFinite(Number(f?.t)) ? r2(Number(f.t)) : null, blockout: side(f?.blockout), take: side(f?.take ?? f) })), why: String(j.why || '').slice(0, 200) };
}

/** match (within 50°), off (within 100°: a quarter turn), opposite, or unknown. */
export function compareDirection(planWord, takeWord) {
  const a = DIRECTION_ANGLES[planWord], b = DIRECTION_ANGLES[takeWord];
  if (a == null || b == null) return 'unknown';
  const d = Math.abs(wrap(a - b));
  return d <= 50 ? 'match' : d <= 100 ? 'off' : 'opposite';
}

const FACES = { toward: 'faces the camera', 'toward-left': 'faces the camera, turned screen-left', 'toward-right': 'faces the camera, turned screen-right', left: 'faces screen-left', right: 'faces screen-right', 'away-left': 'faces away, turned screen-left', 'away-right': 'faces away, turned screen-right', away: 'faces away from the camera' };
const FACING = { toward: 'facing the camera', 'toward-left': 'facing the camera, turned screen-left', 'toward-right': 'facing the camera, turned screen-right', left: 'facing screen-left', right: 'facing screen-right', 'away-left': 'facing away, turned screen-left', 'away-right': 'facing away, turned screen-right', away: 'facing away' };
const MOVES = { toward: 'comes toward the camera', 'toward-left': 'comes toward the camera and screen-left', 'toward-right': 'comes toward the camera and screen-right', left: 'moves screen-left', right: 'moves screen-right', 'away-left': 'goes away and screen-left', 'away-right': 'goes away and screen-right', away: 'goes away from the camera' };
const MOVING = { toward: 'coming toward the camera', 'toward-left': 'coming toward the camera and screen-left', 'toward-right': 'coming toward the camera and screen-right', left: 'moving screen-left', right: 'moving screen-right', 'away-left': 'going away and screen-left', 'away-right': 'going away and screen-right', away: 'going away' };

/**
 * Pass, warn or fail with a reason. fail: at any moment the take's subject faces or travels the opposite way to the
 * blockout. warn: a quarter turn off, or the subject could not be read in most moments. pass: every readable moment agrees.
 * The blockout side is the 3D measurement when there is one (plan.frames[i].facing/travel), else the grader's reading.
 */
export function judgeDirection(plan, parsed) {
  if (!parsed) return null;
  const name = plan.subject?.name || 'subject';
  const frames = plan.frames.map((p, i) => {
    const g = parsed.frames[i] || { blockout: { facing: 'unclear', travel: 'unclear' }, take: { facing: 'absent', travel: 'absent' } };
    const bf = p.facing ?? (DIRECTION_ANGLES[g.blockout.facing] != null ? g.blockout.facing : null), bt = p.travel ?? (DIRECTION_ANGLES[g.blockout.travel] != null ? g.blockout.travel : null);
    return { t: p.t, blockout: { facing: bf, travel: bt, from: p.facing || p.travel ? 'scene' : 'grader' }, take: g.take, facing: compareDirection(bf, g.take.facing), travel: compareDirection(bt, g.take.travel), absent: g.take.facing === 'absent' };
  });
  const worst = (k, r) => frames.find(f => f[k] === r);
  const readable = frames.filter(f => f.facing !== 'unknown' || f.travel !== 'unknown');
  const opp = worst('facing', 'opposite') || worst('travel', 'opposite'), off = worst('facing', 'off') || worst('travel', 'off');
  const at = f => `At ${f.t.toFixed(1)} s the ${name}`;
  const say = f => (f.facing === 'opposite' || (f.facing === 'off' && f.travel !== 'opposite')
    ? `${at(f)} ${FACES[f.take.facing]}; the blockout has it ${FACING[f.blockout.facing]}.`
    : `${at(f)} ${MOVES[f.take.travel]}; the blockout has it ${MOVING[f.blockout.travel]}.`);
  let verdict, why;
  if (opp) { verdict = 'fail'; why = say(opp); }
  else if (readable.length * 2 < frames.length || frames.filter(f => f.absent).length * 2 > frames.length) { verdict = 'warn'; why = `The ${name}’s direction could not be read in ${frames.length - readable.length} of ${frames.length} moments${frames.some(f => f.absent) ? ' (not in frame)' : ''}; check it by eye.`; }
  else if (off) { verdict = 'warn'; why = say(off); }
  else {
    verdict = 'pass';
    const fw = [...new Set(frames.map(f => f.blockout.facing).filter(Boolean))], tw = [...new Set(frames.map(f => f.blockout.travel).filter(Boolean))];
    why = `The ${name} faces${fw.length ? ` ${fw.map(w => FACING[w].replace(/^facing /, '')).join(' then ')}` : ' as planned'}${tw.length ? ` and travels ${tw.map(w => MOVING[w].replace(/^(going|coming|moving) /, '')).join(' then ')}` : ''} as in the blockout at ${readable.length} of ${frames.length} moments.`;
  }
  return { verdict, why, frames: frames.map(f => ({ t: f.t, blockout: f.blockout, take: f.take, facing: f.facing, travel: f.travel })), grader: parsed.why };
}
