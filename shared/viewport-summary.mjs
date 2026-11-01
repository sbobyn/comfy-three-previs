// Copyright (c) 2026 Steven Bobyn. SPDX-License-Identifier: MIT
// A text alternative for the 3D viewport: what is in the scene and where the shot camera is, in a few plain sentences a
// screen reader can read. The canvas is the only way to see the blockout; the Scene list names every object, this says
// how they sit around the camera. Pure: same project, shot and time give the same words.
import { MOVES, entitiesAt } from './director.mjs';
import { shotProjector } from './still-match.mjs';

const MAX_LISTED = 6;
const place = x => (x < 0 ? 'out of frame, left' : x > 1 ? 'out of frame, right' : x < 0.2 ? 'far left of frame' : x < 0.4 ? 'left of frame' : x <= 0.6 ? 'centre of frame' : x <= 0.8 ? 'right of frame' : 'far right of frame');
const lens = mm => (mm <= 18 ? 'ultra-wide' : mm <= 28 ? 'wide' : mm < 60 ? 'normal' : mm < 90 ? 'portrait' : 'telephoto');
const pitch = p => (p > 10 ? 'tilted up' : p < -60 ? 'looking straight down' : p < -25 ? 'looking steeply down' : p < -5 ? 'looking slightly down' : 'level');
const m1 = v => `${Math.round(v * 10) / 10} m`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/**
 * @param project the director project
 * @param shot the shot whose camera is described
 * @param o.t seconds into the shot (default 0)
 * @param o.selected ids of the selected objects
 * @param o.view 'set' (free Director view) or 'camera' (looking through the shot camera)
 * @returns one paragraph: the view, the objects nearest the camera with where each sits in the shot frame, the camera, the selection
 */
export function viewportSummary(project, shot, { t = 0, selected = [], view = 'set' } = {}) {
  const all = entitiesAt(project.scene.entities, (shot.start || 0) + t);
  const cam = shotProjector(shot, all, t);
  const pieces = all.filter(e => e.shape !== 'group');
  const cast = pieces.filter(e => e.kind !== 'environment');
  const set = pieces.length - cast.length;
  const listed = cast.map(e => {
    const q = cam.project(e.position), dist = Math.hypot(e.position[0] - cam.p[0], e.position[2] - cam.p[2]);
    return { e, dist, where: q.z <= 0.05 ? 'behind the camera' : place(q.x) };
  }).sort((a, b) => a.dist - b.dist);
  const head = `${view === 'camera' ? 'Looking through the shot camera.' : 'Director view of the whole set.'} ${plural(cast.length, 'object')}${set ? ` and ${plural(set, 'set piece')}` : ''}${cast.length ? ':' : '.'}`;
  const objects = listed.slice(0, MAX_LISTED).map(({ e, dist, where }) => `${e.name} (${e.kind}): ${where}, ${m1(dist)} from the camera`);
  const more = listed.length > MAX_LISTED ? `; ${listed.length - MAX_LISTED} more are in the Scene list` : '';
  const target = all.find(e => e.id === shot.camera.target);
  const camera = `Shot camera: ${MOVES[shot.camera.move] || shot.camera.move}${target && shot.camera.move !== 'custom' ? ` on ${target.name}` : ''}, ${Math.round(cam.mm)} mm ${lens(cam.mm)} lens, ${m1(cam.p[1])} high, ${pitch(cam.pitch)}, ${shot.duration} s.`;
  const names = selected.map(id => all.find(e => e.id === id)?.name).filter(Boolean);
  return [head + (objects.length ? ` ${objects.join('; ')}${more}.` : ''), camera, names.length ? `Selected: ${names.join(', ')}.` : ''].filter(Boolean).join(' ');
}
