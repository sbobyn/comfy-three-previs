// Copyright (c) 2026 Steven Bobyn. SPDX-License-Identifier: MIT
// Stills that match their blockout. Image models read a grey guide frame poorly (camera height, lens and which way
// things face get lost), so every key-frame still also gets the shot camera in words: shot size, height, angle,
// the camera move, and each visible object's place and heading on screen, projected through the same camera the
// guide frame is rendered with. Also: the one still-prompt builder (workspace, batch and agent share it), which
// models follow a guide, and a free check of how well a still kept its guide's layout.
import { MOVES, entitySize, entitiesAt, shotCameraAt, videoReferences, handleOf } from './director.mjs';

const rad = d => (d * Math.PI) / 180, deg = r => (r * 180) / Math.PI;
const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = a => { const l = Math.hypot(...a) || 1; return a.map(v => v / l); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const clamp01 = v => Math.max(0, Math.min(1, v));

// ---------- Projection ----------
/**
 * The shot camera at shot time t as a projector (same pose and lens as the guide frame: three.js setFocalLength with a
 * 35 mm film gauge). project(point) → { x, y } in 0..1 frame units (0,0 top-left) and z, the depth along the view axis.
 */
export function shotProjector(shot, entities, t = 0, aspect = 16 / 9) {
  const cam = shotCameraAt(shot, entities, t);
  const f = unit(sub(cam.look, cam.p));
  let r = cross(f, [0, 1, 0]); if (Math.hypot(...r) < 1e-6) r = [1, 0, 0]; r = unit(r);
  const u = cross(r, f);
  const tanV = 35 / aspect / 2 / Math.max(1, cam.mm), tanH = tanV * aspect;
  const project = q => { const d = sub(q, cam.p), z = dot(d, f), zz = Math.max(z, 0.05); return { x: 0.5 + (0.5 * dot(d, r)) / zz / tanH, y: 0.5 - (0.5 * dot(d, u)) / zz / tanV, z }; };
  return { p: cam.p, look: cam.look, mm: cam.mm, f, r, u, tanV, tanH, aspect, pitch: deg(Math.asin(Math.max(-1, Math.min(1, f[1])))), project };
}

// Shapes whose front means something (a car's nose, a person's face).
const FRONTED = new Set(['person', 'car', 'chair', 'bird']);
const hasFront = e => FRONTED.has(e.shape) || e.kind === 'character' || e.kind === 'vehicle';

/**
 * Every object the camera sees at shot time t, largest first: screen box (0..1, may extend past the frame), centre,
 * depth, share of the frame it covers, how much of it is inside the frame, its heading on screen (0 = toward the camera,
 * +90 = screen-right, ±180 = away) and which side of it the camera sees (0 = front, +90 = its right side, −90 = its left).
 */
export function frameLayout(project, shot, t = 0, { aspect = 16 / 9 } = {}) {
  const all = project.scene.entities;
  const cam = shotProjector(shot, all, t, aspect);
  const flat = unit([cam.f[0], 0, cam.f[2]]), right = unit([cam.r[0], 0, cam.r[2]]);
  const items = [];
  for (const e of entitiesAt(all, (shot.start || 0) + t)) {
    if (e.shape === 'group') continue;
    const [w, h, d] = entitySize(e), yaw = rad(e.rotation || 0), c = Math.cos(yaw), s = Math.sin(yaw), [px, py, pz] = e.position;
    const corners = [];
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const y of [0, h]) { const lx = (sx * w) / 2, lz = (sz * d) / 2; corners.push([px + lx * c + lz * s, py + y, pz - lx * s + lz * c]); }
    const pts = corners.map(cam.project);
    if (pts.every(q => q.z <= 0.05)) continue; // behind the camera
    const x0 = Math.min(...pts.map(q => q.x)), x1 = Math.max(...pts.map(q => q.x)), y0 = Math.min(...pts.map(q => q.y)), y1 = Math.max(...pts.map(q => q.y));
    const cw = Math.max(0, Math.min(1, x1) - Math.max(0, x0)), ch = Math.max(0, Math.min(1, y1) - Math.max(0, y0));
    if (!(cw > 0 && ch > 0)) continue; // outside the frame
    const area = Math.max(1e-9, (x1 - x0) * (y1 - y0)), centre = cam.project([px, py + h / 2, pz]);
    const fwd = [s, 0, c], toCam = unit(sub([cam.p[0], 0, cam.p[2]], [px, 0, pz])), eRight = [-c, 0, s];
    items.push({
      id: e.id, name: e.name, kind: e.kind, shape: e.shape, position: e.position, size: [w, h, d],
      box: [x0, y0, x1, y1], x: centre.x, y: centre.y, depth: centre.z,
      coverage: cw * ch, inFrame: (cw * ch) / area,
      cropped: { left: x0 < -0.02, right: x1 > 1.02, top: y0 < -0.02, bottom: y1 > 1.02 },
      heading: hasFront(e) ? Math.round(deg(Math.atan2(dot(fwd, right), -dot(fwd, flat)))) : null,
      view: hasFront(e) ? Math.round(deg(Math.atan2(dot(toCam, eRight), dot(toCam, fwd)))) : null,
    });
  }
  items.sort((a, b) => b.coverage - a.coverage);
  // Partly hidden: a nearer, non-environment object covers a good share of its on-screen box.
  const clip = b => [Math.max(0, b[0]), Math.max(0, b[1]), Math.min(1, b[2]), Math.min(1, b[3])];
  for (const it of items) {
    if (it.kind === 'environment') continue;
    const a = clip(it.box);
    const by = items.filter(o => o !== it && o.kind !== 'environment' && o.depth < it.depth - 0.3).map(o => { const b = clip(o.box); return { o, share: Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1])) / Math.max(1e-9, it.coverage) }; }).sort((x, y) => y.share - x.share)[0];
    if (by && by.share > 0.3) it.hiddenBy = { id: by.o.id, name: by.o.name, share: Math.round(by.share * 100) / 100 };
  }
  return { camera: cam, items };
}

// ---------- Words ----------
const hpos = x => (x < 0.2 ? 'far left' : x < 0.4 ? 'left' : x <= 0.6 ? 'centre' : x <= 0.8 ? 'right' : 'far right');
const vpos = y => (y < 0.3 ? 'upper ' : y > 0.7 ? 'lower ' : '');
const share = f => (f >= 0.95 ? 'the full' : f > 0.7 ? 'about three-quarters of the' : f > 0.55 ? 'over half the' : f > 0.4 ? 'about half the' : f > 0.27 ? 'about a third of the' : f > 0.18 ? 'about a quarter of the' : f > 0.08 ? 'a small part of the' : 'a tiny part of the');
const lensWord = mm => (mm <= 18 ? 'ultra-wide' : mm <= 28 ? 'wide' : mm < 60 ? 'normal' : mm < 90 ? 'portrait' : 'telephoto');
const isPerson = it => it.kind === 'character' || it.shape === 'person';
const noun = it => (isPerson(it) ? 'facing' : it.kind === 'vehicle' || it.shape === 'car' ? 'nose pointing' : 'front facing');

/** Which way an object points on screen, in words (null for objects without a front). */
export function headingWords(it) {
  if (it.heading == null) return null;
  const a = it.heading, abs = Math.abs(a), dir = a > 0 ? 'screen-right' : 'screen-left', person = isPerson(it);
  if (abs < 25) return person ? 'facing the camera' : `${noun(it)} toward the camera`;
  if (abs < 65) return `${noun(it)} toward the camera and ${dir} (three-quarter front view)`;
  if (abs < 115) {
    if (person) return `facing ${dir} (profile)`;
    const front = a > 0 ? 'right' : 'left', rear = a > 0 ? 'left' : 'right', vehicle = it.kind === 'vehicle' || it.shape === 'car';
    const cut = it.cropped?.[front] ? `, its front end cut off by the ${front} edge` : '';
    return `${noun(it)} ${dir}: a flat side profile${vehicle ? ' with its wheels in a level row' : ''}, ${vehicle ? 'tail lights and rear' : 'back'} at the ${rear} end${vehicle ? ', headlights and front' : ', front'} at the ${front} end${cut}`;
  }
  if (abs < 155) return `${noun(it)} away from the camera and ${dir} (three-quarter rear view)`;
  return person ? 'back to the camera' : `${noun(it)} away from the camera`;
}
/** Which side of the subject the camera sees. */
export function viewWords(it) {
  if (it.view == null) return null;
  const a = Math.abs(it.view), side = it.view > 0 ? 'right' : 'left';
  return a < 25 ? 'from straight in front' : a < 65 ? `from the front three-quarter, its ${side} side` : a < 115 ? `side-on, from its ${side} side (a side profile, not a three-quarter or chase view)` : a < 155 ? `from the rear three-quarter, its ${side} side` : 'from directly behind';
}
/** Shot size for the subject: classic names for people (from how much of the body is in frame), coverage otherwise. */
export function shotSize(it) {
  if (!it) return 'wide shot';
  const [x0, y0, x1, y1] = it.box;
  if (isPerson(it)) {
    const visible = (Math.min(1, y1) - Math.max(0, y0)) / Math.max(1e-6, y1 - y0);
    if (visible >= 0.95) return y1 - y0 < 0.3 ? `wide shot, ${it.name} small in frame` : `full shot, ${it.name} head to toe`;
    return visible < 0.22 ? `close-up on ${it.name}'s face` : visible < 0.38 ? `medium close-up, ${it.name} head and shoulders` : visible < 0.62 ? `medium shot, ${it.name} from the waist up` : `medium long shot, ${it.name} from the knees up`;
  }
  // What is inside the frame, so it agrees with the layout line.
  const big = Math.max(Math.min(1, x1) - Math.max(0, x0), Math.min(1, y1) - Math.max(0, y0));
  return big >= 0.9 ? `close shot, ${it.name} fills the frame` : big > 0.45 ? `close shot, ${it.name} fills ${it.x > 0.6 ? 'the right half of' : it.x < 0.4 ? 'the left half of' : 'most of'} the frame` : big > 0.25 ? `medium shot of ${it.name}` : big > 0.08 ? `wide shot, ${it.name} small in frame` : `extreme wide shot, ${it.name} tiny in frame`;
}
function heightWords(cam, subj) {
  const y = cam.p[1], m = `${Math.round(y * 10) / 10} m`;
  if (y < 0.5) return `camera at ground level (${m})`;
  if (!subj) return `camera ${m} above the ground`;
  const base = subj.position[1], top = base + subj.size[1];
  if (isPerson(subj)) {
    const eye = base + subj.size[1] * 0.93, dy = y - eye;
    return `camera ${m} high, ${Math.abs(dy) < 0.25 ? 'at eye level' : dy < 0 ? (dy < -0.8 ? `well below ${subj.name}'s eye line` : `just below ${subj.name}'s eye line`) : dy > 1.5 ? `well above ${subj.name}'s head` : `just above ${subj.name}'s eye line`}`;
  }
  return `camera ${m} high, ${y < base + subj.size[1] * 0.6 ? `low, below ${subj.name}'s top` : y < top + 0.6 ? `about level with ${subj.name}'s top` : y < top + 3 ? `above ${subj.name}` : `high above ${subj.name}`}`;
}
const pitchWords = p => (p > 10 ? 'tilted up' : p < -60 ? 'looking straight down' : p < -25 ? 'looking steeply down' : p < -5 ? 'looking slightly down' : 'level');
function horizonWords(cam, indoor) {
  if (indoor || Math.abs(cam.pitch) > 50) return null;
  const y = 0.5 + (0.5 * Math.tan(rad(cam.pitch))) / cam.tanV;
  return y < 0 ? 'the horizon is above the top edge (only ground in frame)' : y > 1 ? 'the horizon is below the bottom edge' : `horizon ${y < 0.15 ? 'near the top edge' : y < 0.4 ? 'in the upper third' : y <= 0.6 ? 'across the middle' : y <= 0.85 ? 'in the lower third' : 'near the bottom edge'}`;
}
function momentWords(shot, t) {
  const move = shot.camera.move, name = move === 'static' ? 'locked-off shot' : move === 'custom' ? 'hand-operated camera move' : `${MOVES[move].toLowerCase()} move`;
  // The last encoded blockout frame (t = (n − 1) / 24, shared/keyframes.mjs) is the last frame too, not only t = duration.
  const when = t <= 0.01 ? 'First frame' : t >= shot.duration - 1 / 24 - 1e-6 ? 'Last frame' : `Frame ${Math.round(t * 10) / 10}s into`;
  return `${when} of a ${name}`;
}
/** The shot's subject at t: the camera target when it is in frame, else the largest non-environment object. */
export function subjectOf(layout, shot) {
  return layout.items.find(i => i.id === shot.camera.target) || layout.items.find(i => i.kind !== 'environment') || null;
}

/**
 * The camera and blocking of one key frame in words: { camera, layout, text }. camera covers move, lens, shot size,
 * height, angle and horizon; layout gives each visible object (up to `max`, environment pieces excluded) its place,
 * size, crop, heading and relation to the subject.
 */
export function describeFrame(project, shot, t = 0, { max = 5 } = {}) {
  const layout = frameLayout(project, shot, t);
  const cam = layout.camera, subj = subjectOf(layout, shot);
  const dist = subj ? Math.round(Math.hypot(subj.position[0] - cam.p[0], subj.position[2] - cam.p[2]) * 10) / 10 : null;
  const view = subj ? viewWords(subj) : null;
  const camera = [
    `${momentWords(shot, t)}, ${Math.round(cam.mm)}mm ${lensWord(cam.mm)} lens`,
    shotSize(subj),
    `${heightWords(cam, subj)}${dist != null ? ` and ${dist} m from ${subj.name}` : ''}, ${pitchWords(cam.pitch)}`,
    view ? `we see ${subj.name} ${view}` : null,
    horizonWords(cam, project.scene.environment?.preset === 'interior'),
  ].filter(Boolean).join('; ') + '.';
  const shown = layout.items.filter(i => i.kind !== 'environment' && i.inFrame > 0.08 && i.coverage > 0.003).slice(0, max);
  const lines = shown.map(it => {
    const [x0, y0, x1, y1] = it.box, edges = Object.entries(it.cropped).filter(([, v]) => v).map(([k]) => k);
    const w = Math.min(1, x1) - Math.max(0, x0), h = Math.min(1, y1) - Math.max(0, y0), cx = (Math.max(0, x0) + Math.min(1, x1)) / 2, cy = (Math.max(0, y0) + Math.min(1, y1)) / 2;
    const parts = [];
    if (edges.length === 4) return `${it.name}: fills the whole background.`;
    {
      parts.push(`${vpos(cy)}${hpos(cx)} of frame`, w >= h * 1.2 ? `${share(w)} frame width wide` : `${share(h)} frame height tall`);
      if (edges.length) parts.push(`cut off by the ${edges.join(' and ')} edge${edges.length > 1 ? 's' : ''}`);
    }
    if (subj && it !== subj) {
      const sx = (Math.max(0, subj.box[0]) + Math.min(1, subj.box[2])) / 2;
      const dz = it.depth - subj.depth, side = cx < sx - 0.05 ? ' to the left' : cx > sx + 0.05 ? ' to the right' : '';
      if (dz > 0.75) parts.push(`behind ${subj.name}${side}`); else if (dz < -0.75) parts.push(`in front of ${subj.name}${side}`); else if (side) parts.push(`beside ${subj.name}${side}`);
    }
    if (it.hiddenBy) parts.push(`partly hidden by ${it.hiddenBy.name}`);
    const hw = headingWords(it); if (hw) parts.push(hw + (subj && it !== subj && subj.heading != null && it.heading != null && Math.abs(((it.heading - subj.heading + 540) % 360) - 180) < 20 ? `, same direction as ${subj.name}` : ''));
    return `${it.name}: ${parts.join(', ')}.`;
  });
  const lay = lines.length ? `In frame: ${lines.join(' ')}` : '';
  return { camera: `Camera: ${camera}`, layout: lay, text: [`Camera: ${camera}`, lay].filter(Boolean).join('\n'), subject: subj?.name || null };
}

// ---------- Models and the still prompt ----------
/**
 * How well each image model keeps a blockout guide's camera and layout (from the stillmatch comparison,
 * .evidence/stillmatch-20261030/RESULTS.md). 'strong' models are recommended for "match the blockout".
 */
// With camera words, FLUX 3 matched 3 of 3 proof shots and Nano Banana 2.1 2 of 3 (it turns side profiles into chase
// angles). Local img2img keeps the guide's layout by construction. Untested with camera words: Flux.2, NB 2, Ultra, NB Pro.
export const FOLLOWS_GUIDE = { 'flux-3': 'strong', 'nano-banana-2-1': 'strong', 'local-checkpoint': 'strong', 'nano-banana-2': 'weak', 'flux-2-pro': 'weak', 'flux-ultra': 'weak', 'nano-banana-pro': 'weak' };
export const followsGuide = id => FOLLOWS_GUIDE[id] || 'weak';
/** The storyboard default for "match the blockout", and the model a weakly matching still is retried with. */
export const STRONG_GUIDE_MODEL = 'flux-3';
/** Retry model for a still that missed its blockout: the strong-guide model, or the other strong one if that was it. */
export const retryModelFor = model => (model === STRONG_GUIDE_MODEL ? 'nano-banana-2-1' : STRONG_GUIDE_MODEL);
// Gemini image models take the guide best as an edit of image 1.
const EDIT_STYLE = new Set(['nano-banana-2-1', 'nano-banana-2', 'nano-banana-pro']);
export const editsGuide = id => EDIT_STYLE.has(id);
/** Reference images each still model takes besides the guide (mirrors server/previs/refgen.mjs maxRefs). */
export const STILL_MAX_REFS = { 'flux-3': 9, 'flux-2-pro': 7, 'nano-banana-2-1': 9, 'nano-banana-2': 9 };

/**
 * Cast images for a key frame at shot time t, in image order from image 2: looks of the objects actually in frame
 * (largest first, at least 1% of the frame), then one environment image, then the previous shot's last still for
 * continuity. The shot's lead (camera target) and the cast its description names (@handle) are always included when
 * in frame, however small: a hero car far down the track is still the hero, and without its look the still invents a
 * livery. Fewer, relevant images keep the guide (image 1) in charge. Returns { looks, refIds, prevImage }.
 */
export function stillReferences(project, shot, t, cap) {
  if (!(cap > 0)) return { looks: [], refIds: [], prevImage: null };
  const named = new Set([shot.camera?.target, ...[...String(shot.description || '').matchAll(/@([a-z0-9-]+)/gi)].map(m => project.scene.entities.find(e => handleOf(e.name) === m[1].toLowerCase())?.id)].filter(Boolean));
  const seen = new Map(frameLayout(project, shot, t).items.filter(i => i.kind !== 'environment' && i.inFrame > 0.08 && (i.coverage >= 0.01 || named.has(i.id))).map((i, k) => [i.id, k]));
  const all = videoReferences(project, shot, 16).filter(r => r.role !== 'frame' && r.role !== 'style');
  const subjects = all.filter(r => r.role !== 'environment' && seen.has(r.entityId)).sort((a, b) => seen.get(a.entityId) - seen.get(b.entityId));
  const prev = project.shots[project.shots.indexOf(shot) - 1]?.references.filter(r => r.role === 'frame').at(-1) || null;
  const looks = [...subjects, ...all.filter(r => r.role === 'environment').slice(0, 1)].slice(0, Math.max(0, cap - (prev ? 1 : 0)));
  const refIds = [...looks.map(r => r.ref.id), ...(prev ? [prev.id] : [])];
  return { looks, refIds, prevImage: prev ? refIds.length + 1 : null };
}

/**
 * Which instant of the action a key frame shows. The shot text describes the whole action, and on its own pulls a still
 * to the climax (a start still of a dunk showed the dunk); the blockout's first frame is the run-up.
 */
export function momentLine(shot, t) {
  const d = Number(shot?.duration) || 0;
  if (!(d > 0)) return '';
  if (t <= 0.05) return 'Moment: the first instant of the shot. The action described below is only beginning; show the poses in image 1, not the climax.';
  if (t >= d - 0.05) return 'Moment: the last instant of the shot. The action described below has just happened; show the poses in image 1.';
  return `Moment: ${Math.round(t * 10) / 10} s into the ${d} s shot; show the poses in image 1.`;
}

/**
 * The full prompt for a key-frame still. Order: how to use image 1 (an edit for Gemini models), the camera and layout
 * in words, the moment (momentLine), the shot text, then which image each cast member looks like. Only the shot text is shortened to fit `max`.
 * looks: [{ label }] in image order from image 2; prevImage: image number of the previous shot's still, if sent.
 */
// markers: false when image 1 is a Blender frame (blenderBlockout), which has no headlight, face or ground-wedge markers.
export function stillPrompt(o) {
  const parts = stillPromptParts(o);
  return parts.map(x => x.text).filter(Boolean).join('\n').slice(0, o.max ?? 2500);
}
/**
 * The still prompt's parts in order, as stillPrompt joins them (one per line): guide (how to use image 1, worded for the
 * model), frame (camera and layout measured from the blockout), moment, body (the shot text, shortened to fit `max`),
 * refs (which image each cast member looks like) and rules (what not to copy). Each part: { key, text, full? } where
 * `full` is the body before it was shortened. The prompt inspector shows these same parts.
 */
export function stillPromptParts({ project, shot, t = 0, text = '', presetId = '', looks = [], prevImage = null, frame = null, max = 2500, markers = true }) {
  const f = frame || describeFrame(project, shot, t);
  const head = editsGuide(presetId)
    ? "Edit image 1: repaint this grey 3D blockout as one photoreal film frame. Keep image 1's camera position, lens, framing, horizon and every object's position, size, heading and pose exactly; only replace the grey shapes, ground and sky with the real things described below."
    : "Image 1 is a grey 3D blockout of this exact frame. Match its camera position, lens, framing, horizon and every object's position, size, heading and pose exactly.";
  const last = looks.length + 1 + (prevImage ? 1 : 0);
  const ids = [...looks.map((l, i) => `The ${l.label} looks exactly like image ${i + 2}.`), prevImage ? `Image ${prevImage} is the previous shot: keep lighting, colour grade and designs continuous.` : '',
    last > 1 ? `Image${last > 2 ? `s 2–${last}` : ' 2'} show only what things look like: take their design, livery and colours, never their pose, angle, direction or framing; those come from image 1.` : ''].filter(Boolean).join(' ');
  const tail = (markers ? "Reading image 1: bright yellow-white marks are headlights (a vehicle's front), red marks are tail lights (its rear), a pale oval is a face, and pale ground wedges point the way things face. Do not copy those markers, the flat grey colours, the grid lines or the plain sky. " : "Do not copy image 1's flat untextured colours or plain sky. ") + "One single photographic frame; no text, captions, labels, split panels or watermarks.";
  const moment = momentLine(shot, t);
  const fixed = [head, f.text, moment, ids, tail].filter(Boolean);
  const room = max - fixed.join('\n').length - 2;
  const full = String(text || '').trim();
  let body = full;
  if (body.length > room) body = room > 40 ? body.slice(0, room - 1).replace(/\s+\S*$/, '') + '…' : '';
  return [{ key: 'guide', text: head }, { key: 'frame', text: f.text }, { key: 'moment', text: moment }, { key: 'body', text: body, full }, { key: 'refs', text: ids }, { key: 'rules', text: tail }];
}

// ---------- Match check (free) ----------
/**
 * How well a still keeps its guide frame's layout, 0–10, from two small grey images (row-major, same w×h, any range).
 * Compares edge orientation fields (doubled-angle gradients, so light-on-dark and dark-on-light edges agree), edge
 * density and coarse light layout after contrast normalisation. A cheap heuristic: it reads camera and layout, not
 * identity or style. Returns { score, orientation, edges, light }.
 */
export function guideMatchScore(a, b, w, h) {
  if (a.length !== w * h || b.length !== w * h) throw Error('Images must be w×h grey pixels');
  const norm = img => { const n = img.length; let m = 0; for (const v of img) m += v; m /= n; let s = 0; for (const v of img) s += (v - m) ** 2; s = Math.sqrt(s / n) || 1; return Float64Array.from(img, v => (v - m) / s); };
  const A = norm(a), B = norm(b);
  const grad = I => {
    const gx = new Float64Array(w * h), gy = new Float64Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, p = k => I[k];
      gx[i] = (p(i - w + 1) + 2 * p(i + 1) + p(i + w + 1)) - (p(i - w - 1) + 2 * p(i - 1) + p(i + w - 1));
      gy[i] = (p(i + w - 1) + 2 * p(i + w) + p(i + w + 1)) - (p(i - w - 1) + 2 * p(i - w) + p(i - w + 1));
    }
    return { gx, gy };
  };
  const ga = grad(A), gb = grad(B);
  // Doubled-angle vectors: (gx² − gy², 2·gx·gy) has the edge's magnitude² and twice its angle.
  let num = 0, da = 0, db = 0;
  const ma = new Float64Array(w * h), mb = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const ax = ga.gx[i] ** 2 - ga.gy[i] ** 2, ay = 2 * ga.gx[i] * ga.gy[i], bx = gb.gx[i] ** 2 - gb.gy[i] ** 2, by = 2 * gb.gx[i] * gb.gy[i];
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    // sqrt-compress so a few strong edges don't dominate
    const ka = la ? 1 / Math.sqrt(la) : 0, kb = lb ? 1 / Math.sqrt(lb) : 0;
    num += ax * ka * bx * kb + ay * ka * by * kb; da += (la * ka) ** 2; db += (lb * kb) ** 2;
    ma[i] = Math.sqrt(la); mb[i] = Math.sqrt(lb);
  }
  const orientation = da && db ? num / Math.sqrt(da * db) : 0;
  const pearson = (x, y) => { const n = x.length; let mx = 0, my = 0; for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; } mx /= n; my /= n; let sxy = 0, sx = 0, sy = 0; for (let i = 0; i < n; i++) { const p = x[i] - mx, q = y[i] - my; sxy += p * q; sx += p * p; sy += q * q; } return sx && sy ? sxy / Math.sqrt(sx * sy) : 0; };
  const edges = pearson(ma, mb), light = pearson(A, B);
  const raw = 0.5 * orientation + 0.3 * edges + 0.2 * light;
  // Calibrated on blockout/still pairs (see tests/still-match.test.mjs): unrelated frames sit near 0.05, close matches above 0.45.
  const score = Math.round(clamp01((raw - MATCH_FLOOR) / (MATCH_CEIL - MATCH_FLOOR)) * 100) / 10;
  const r3 = v => Math.round(v * 1000) / 1000;
  return { score, orientation: r3(orientation), edges: r3(edges), light: r3(light), raw: r3(raw) };
}
export const MATCH_FLOOR = 0.05, MATCH_CEIL = 0.5;
/** Grey size the match check renders both images at. */
export const MATCH_SIZE = { width: 32, height: 18 };
/**
 * Below this the batch may retry once with the strong-guide model. 6, not 5: on the 2026-10-30 hero shots both FLUX 3
 * stills that were plainly wrong (a reversed car, a wall splitting the field) were graded exactly 5; the retry scored 9.
 */
export const WEAK_MATCH = 6;
