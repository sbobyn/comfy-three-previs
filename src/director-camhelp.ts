// Camera help: what each camera move / style term means, shown as a small animated 3D preview card.
// One shared, lazily created WebGL renderer draws a "set" view (subject, camera gizmo, its path) and a
// "camera sees" view into 2D canvases in the card. The loop runs only while a card is showing; the
// renderer is disposed after a short idle. Moves reuse cameraKeys/cameraAt so the preview matches the
// real preset. Cuts, lens and filter terms are illustrated with small scripted sequences.
import './director-camhelp.css';
import * as THREE from 'three';
import { MOVES, cameraKeys, cameraAt, makeEntity } from '../shared/director.mjs';
import type { Shot, Vec3 } from '../shared/director.mjs';
import { CAMERA_GROUPS, FIELD_COLORS, KIND_COLORS } from '../shared/prompt.mjs';
import { h } from './director-common';

export type HelpGroup = 'move' | 'movement' | 'cuts' | 'lens' | 'filter';
type Pose = { p: Vec3; look: Vec3; mm: number; roll?: number };
type Tint = { stops: string[]; op: GlobalCompositeOperation; alpha?: number; dir?: 'v' | 'h' | 'r' };
type Fx = { filter?: string; tints?: Tint[]; grain?: number; scan?: boolean; chroma?: number; glow?: number; flare?: boolean; bars?: boolean };
type Frame = {
  cam: Pose;
  person?: Vec3; personYaw?: number; car?: Vec3; carYaw?: number;
  mix?: { cam: Pose; a: number }; // cross-dissolve: second camera blended on top
  blur?: Partial<Record<'person' | 'props' | 'env' | 'macro', number>>; // fake depth of field, px
  motion?: number; // horizontal motion blur, px
  grade?: string; // canvas filter for the whole "sees" frame
  wipe?: number; // filters: graded portion starts at this x (0..1)
  tag?: string; flash?: number;
};
type Spec = { title: string; group: HelpGroup; line: string; use: string; frame(u: number): Frame; dur?: number; loop?: boolean; still?: number; layout?: 'set' | 'sees'; inset?: boolean; path?: boolean; marks?: Pose[]; fx?: Fx };

// ---------- Scene layout (metres; the stage faces +z) ----------
const PERSON: Vec3 = [0, 0, 0];
const FOCUS: Vec3 = [0, 1.53, 0];
const CAR: Vec3 = [3.2, 0, -3];
const BALL: Vec3 = [-1.4, 0.22, 0.9];
const FLOWER: Vec3 = [-0.7, 0, 1.7];
const rad = (d: number) => (d * Math.PI) / 180;
const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const ease = (u: number) => u * u * (3 - 2 * u);
const sm = (a: number, b: number, u: number) => ease(clamp((u - a) / (b - a)));
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const mix3 = (a: Vec3, b: Vec3, u: number): Vec3 => [lerp(a[0], b[0], u), lerp(a[1], b[1], u), lerp(a[2], b[2], u)];
const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const place = (deg: number, d: number, ht: number, look: Vec3 = FOCUS): Vec3 => [look[0] + d * Math.sin(rad(deg)), ht, look[2] + d * Math.cos(rad(deg))];
const shake = (u: number, k: number) => [Math.sin(u * 37.1) * 0.6 + Math.sin(u * 83.7) * 0.4, Math.sin(u * 29.3 + 1) * 0.6 + Math.sin(u * 71.9) * 0.4, Math.sin(u * 53.3 + 2)].map(v => v * k) as Vec3;
const carFocus = (c: Vec3 = CAR): Vec3 => [c[0], 0.8, c[2]];

// Moves run through the real preset maths on a synthetic shot aimed at the person.
const HELP_PERSON = makeEntity({ shape: 'person', name: 'Subject', position: PERSON }, 'help-person');
const CUSTOM_KEYS = [{ t: 0, p: place(-40, 6, 1.2), look: FOCUS, mm: 35 }, { t: 0.5, p: place(10, 3.5, 2.6), look: FOCUS, mm: 35 }, { t: 1, p: place(55, 5, 0.9), look: [0.6, 1.3, -0.4] as Vec3, mm: 35 }];
function preset(move: string): (u: number) => Frame {
  const shot = { id: 'help', title: '', description: '', duration: 1, start: 0, camera: { move, target: HELP_PERSON.id, distance: 5, height: 1.6, angle: 18, mm: 35, keys: move === 'custom' ? CUSTOM_KEYS : null }, references: [], render: null } as unknown as Shot;
  const keys = cameraKeys(shot, [HELP_PERSON]);
  return u => ({ cam: cameraAt(keys, 1, u) });
}

// Shared poses for the cut illustrations.
const WIDE: Pose = { p: place(14, 7.5, 1.9), look: [0.8, 1.1, -0.8], mm: 30 };
const CLOSE_CAR: Pose = { p: [CAR[0] - 2.4, 1.1, CAR[2] + 5.6], look: [CAR[0] + 0.6, 0.75, CAR[2]], mm: 35 };
const BALL_CLOSE: Pose = { p: [BALL[0], BALL[1] + 0.06, BALL[2] + 1.9], look: BALL, mm: 50 };
const WHEEL: Vec3 = [CAR[0] + 1.4, 0.35, CAR[2] + 0.95];
const WHEEL_CLOSE: Pose = { p: [WHEEL[0], WHEEL[1] + 0.1, WHEEL[2] + 3.0], look: WHEEL, mm: 50 };
// Speed ramp: car position from an integrated speed curve (fast → slow-mo → fast).
const RAMP = (() => { const n = 200, xs = [0]; let x = 0; for (let i = 1; i <= n; i++) { const u = i / n, v = 1 - 0.82 * (sm(0.25, 0.4, u) - sm(0.68, 0.82, u)); x += v; xs.push(x); } return xs.map(v => v / x); })();
const rampAt = (u: number) => RAMP[Math.round(clamp(u) * (RAMP.length - 1))];
const rampSpeed = (u: number) => 1 - 0.82 * (sm(0.25, 0.4, u) - sm(0.68, 0.82, u));
const curve = new THREE.CatmullRomCurve3([[-3, 1.5, 5], [-1.8, 1.4, 2.6], [0.6, 1.6, 2.2], [2.2, 1.3, 0.2], [2.6, 1.0, -0.6]].map(p => new THREE.Vector3(...p)));
const lensFrame = (mm: number) => (u: number): Frame => { const m = lerp(mm <= 35 ? 50 : 35, mm, sm(0.05, 0.6, u)); return { cam: { p: place(12, 5.2, 1.6), look: [0.3, 1.25, -0.4], mm: m }, tag: `${Math.round(m)}mm` }; };
const filterFrame = (u: number): Frame => ({ cam: { p: place(10 + 14 * Math.sin(u * Math.PI * 2) * 0.5, 6.5, 1.9), look: [0.9, 1.0, -0.9], mm: 32 }, wipe: 0.5 - 0.3 * Math.cos(u * Math.PI * 2) }); // graded right of the wipe

const SPECS: Record<string, Spec> = {};
const def = (group: HelpGroup, title: string, line: string, use: string, frame: (u: number) => Frame, more: Partial<Spec> = {}) => {
  SPECS[`${group}:${title}`] = { title, group, line, use, frame, ...more };
};

// ---------- Move presets (Camera ▸ Move) ----------
const MOVE_TEXT: Record<string, [string, string]> = {
  static: ['The camera doesn’t move; only the action moves inside a fixed frame.', 'Dialogue, comedy beats, letting a performance play out.'],
  'dolly-in': ['The camera physically travels toward the subject.', 'Building intensity, a realisation, drawing the viewer in.'],
  'dolly-out': ['The camera travels away from the subject, revealing more of the scene.', 'Endings, isolation, revealing context.'],
  'truck-left': ['The whole camera slides sideways to the left, parallel to the scene.', 'Following action across frame; showing depth with parallax.'],
  'truck-right': ['The whole camera slides sideways to the right, parallel to the scene.', 'Following action across frame; showing depth with parallax.'],
  'pan-left': ['The camera stays put and swivels to the left on its head.', 'Following action, or revealing what is beside the subject.'],
  'pan-right': ['The camera stays put and swivels to the right on its head.', 'Following action, or revealing what is beside the subject.'],
  'orbit-left': ['The camera circles left around the subject, always aimed at it.', 'Hero moments; showing a subject from more than one side.'],
  'orbit-right': ['The camera circles right around the subject, always aimed at it.', 'Hero moments; showing a subject from more than one side.'],
  'crane-up': ['The camera rises straight up while keeping the subject in view.', 'Openings and endings; revealing scale.'],
  'crane-down': ['The camera descends from high up to the subject’s level.', 'Arriving in a scene; settling into the action.'],
  'tilt-up': ['The camera stays put and tips upward.', 'Revealing height: a building, a tall character, the sky.'],
  custom: ['Your own camera path, from the set view or a flown take.', 'Anything the presets can’t do.'],
};
for (const [k, title] of Object.entries(MOVES)) {
  const [line, use] = MOVE_TEXT[k] || ['', ''];
  const walk = k === 'static' ? (u: number): Frame => ({ ...preset('static')(u), person: [lerp(-1.4, 1.4, u), 0, 0], personYaw: 90 }) : preset(k);
  def('move', k, line, use, walk, { dur: k.startsWith('orbit') ? 3 : 2.6, ...(k === 'static' ? { path: false } : {}) });
  SPECS[`move:${k}`].title = title;
}

// ---------- Style vocabulary: movement ----------
def('movement', 'FPV drone chase', 'A small racing drone chases the subject low and fast, banking through turns.', 'Car chases, sport, high-energy action.', u => {
  const c: Vec3 = [lerp(-7, 8, u), 0, -3];
  const sway = Math.sin(u * Math.PI * 2.2);
  return { car: c, carYaw: 90, cam: { p: [c[0] - 4.2, 1.1 + 0.5 * Math.sin(u * Math.PI * 3), c[2] + 1.4 * sway], look: [c[0] + 1.5, 0.7, c[2]], mm: 20, roll: -sway * 14 }, motion: 1.5 };
}, { dur: 2.4 });
def('movement', 'dolly zoom', 'The camera dollies back while zooming in: the subject stays the same size but the world stretches behind it.', 'Vertigo, shock, a sudden realisation.', u => { const d = lerp(3, 8, ease(u)); return { cam: { p: place(18, d, 1.6), look: FOCUS, mm: (35 * d) / 3 }, tag: `${Math.round((35 * d) / 3)}mm` }; }, { dur: 3 });
def('movement', 'crane up into an orbit', 'The camera rises on a crane, then swings around the subject at the top.', 'Grand reveals, finales, establishing a hero.', u => {
  const up = sm(0, 0.45, u), around = sm(0.45, 1, u);
  return { cam: { p: place(18 + 120 * around, 5, lerp(0.8, 4.4, up)), look: FOCUS, mm: 30 } };
}, { dur: 3.4 });
def('movement', 'static locked-off shot', 'A tripod shot: the frame never moves; the action happens inside it.', 'Dialogue, comedy, observational moments.', u => ({ ...preset('static')(u), person: [lerp(-1.4, 1.4, u), 0, 0], personYaw: 90 }), { path: false });
def('movement', 'slow push-in', 'The camera creeps toward the subject.', 'Tension, emotion, a character realising something.', preset('dolly-in'), { dur: 3.4 });
def('movement', 'slow pull-out', 'The camera slowly backs away, widening the frame.', 'Endings, loneliness, revealing the bigger picture.', preset('dolly-out'), { dur: 3.4 });
def('movement', 'tracking shot', 'The camera travels with a moving subject, keeping pace beside it.', 'Walk-and-talks, following action through a space.', u => {
  const x = lerp(-3, 3, u);
  return { person: [x, 0, 0], personYaw: 90, cam: { p: place(0, 5, 1.6, [x, 1.5, 0]), look: [x + 0.3, 1.4, 0], mm: 35 } };
}, { dur: 2.8 });
def('movement', 'dolly alongside', 'The camera runs parallel to a moving vehicle, matching its speed.', 'Car commercials, races, showing speed without losing the subject.', u => {
  const c: Vec3 = [lerp(-6, 6, u), 0, -3];
  return { car: c, carYaw: 90, cam: { p: [c[0] + 0.8, 1.1, c[2] + 5], look: carFocus(c), mm: 32 }, motion: 0.8 };
}, { dur: 2.6 });
def('movement', 'crane up', 'The camera rises straight up while keeping the subject in view.', 'Openings and endings; revealing scale.', preset('crane-up'));
def('movement', 'crane down', 'The camera descends to the subject’s level.', 'Arriving in a scene; settling into the action.', preset('crane-down'));
def('movement', 'orbit around the subject', 'The camera circles the subject, always aimed at it.', 'Hero moments, product shots, a character at a turning point.', preset('orbit-right'), { dur: 3 });
def('movement', 'handheld', 'The camera is held by an operator: small, organic wobble and drift.', 'Documentary feel, urgency, chaos, intimacy.', u => {
  const s = shake(u * 3, 0.05);
  return { cam: { p: add3(place(18, 4, 1.6), s), look: add3(FOCUS, shake(u * 3 + 5, 0.09)), mm: 32, roll: s[2] * 30 } };
}, { dur: 3, path: false, still: 0.5 });
def('movement', 'steadicam follow', 'A stabilised rig glides behind the subject as they walk.', 'Following a character into a space; long, smooth takes.', u => {
  const z = lerp(1, -6, u);
  return { person: [0, 0, z], personYaw: 180, cam: { p: [0.4, 1.7 + 0.03 * Math.sin(u * 30), z + 3], look: [0, 1.4, z - 2], mm: 28 } };
}, { dur: 3 });
def('movement', 'drone flyover', 'A high aerial pass over the scene, looking forward and down.', 'Establishing shots, scale, geography of a location.', u => {
  const p: Vec3 = [lerp(-1, 1, u), 9, lerp(14, -6, u)];
  return { cam: { p, look: [p[0], 0, p[2] - 7], mm: 24 } };
}, { dur: 3.2 });
def('movement', 'whip pan', 'An extremely fast pan that blurs into the next subject.', 'Energetic transitions, comedy reveals, linking two places.', u => {
  const w = sm(0.42, 0.56, u), from = FOCUS, to: Vec3 = [6, 0.8, 2];
  const speed = Math.sin(clamp((u - 0.42) / 0.14) * Math.PI);
  return { car: [6, 0, 2], carYaw: 0, cam: { p: [0, 1.6, 6], look: mix3(from, to, w), mm: 35 }, motion: speed * 14 };
}, { dur: 2.4 });
def('movement', 'slow pan', 'The camera swivels slowly on its head from a fixed spot.', 'Surveying a location, revealing what’s next to the subject.', preset('pan-right'), { dur: 3.4 });
def('movement', 'tilt up', 'The camera stays put and tips upward.', 'Revealing height: a building, a tall character, the sky.', preset('tilt-up'));

// ---------- Cuts ----------
const cutFrame = (a: Pose, b: Pose, at = 0.5) => (u: number): Frame => (u < at ? { cam: a, tag: 'A' } : { cam: b, tag: 'B' });
def('cuts', 'speed ramp', 'Playback speed changes inside the shot: full speed, then slow motion, then back.', 'Action beats, impacts, a moment you want to savour.', u => {
  const c: Vec3 = [lerp(-8, 8, rampAt(u)), 0, -3];
  return { car: c, carYaw: 90, cam: { p: [0, 1.2, 4.5], look: carFocus(c), mm: 30 }, tag: `${Math.round(rampSpeed(u) * 100)}% speed`, motion: rampSpeed(u) * 2 };
}, { dur: 3.2, path: false, layout: 'sees' });
def('cuts', 'hard cut', 'One shot ends and the next begins instantly, with no transition.', 'The default edit; keeps scenes moving.', cutFrame(WIDE, CLOSE_CAR), { path: false, marks: [WIDE, CLOSE_CAR], layout: 'sees', still: 0.4 });
def('cuts', 'match cut', 'Cut between two shots whose shapes line up: a round ball becomes a round wheel.', 'Linking two ideas, places or times visually.', cutFrame(BALL_CLOSE, WHEEL_CLOSE), { path: false, marks: [BALL_CLOSE, WHEEL_CLOSE], layout: 'sees', still: 0.4 });
def('cuts', 'smash cut', 'A sudden cut from a quiet moment to a loud, intense one.', 'Shock, comedy, jolting the audience awake.', u => u < 0.55
  ? { cam: { ...WIDE, p: place(14, 8, 1.8), mm: 28 }, grade: 'saturate(.45) brightness(.85)', tag: 'quiet' }
  : { car: [lerp(1, 5.5, (u - 0.55) / 0.45), 0, -3], carYaw: 90, cam: { p: add3([CAR[0] - 2, 0.5, CAR[2] + 2.6], shake(u * 9, 0.06)), look: [CAR[0] + 1.5, 0.9, CAR[2]], mm: 22, roll: -6 }, grade: 'contrast(1.35) saturate(1.7)', tag: 'LOUD', flash: clamp(1 - (u - 0.55) / 0.12), motion: 3 },
{ path: false, marks: [WIDE, CLOSE_CAR], layout: 'sees', still: 0.62 });
def('cuts', 'jump cut', 'The same framing, with a jump forward in time: the subject skips position.', 'Passing time, restlessness, vlog-style energy.', u => {
  const i = Math.min(2, Math.floor(u * 3)), spots: [Vec3, number][] = [[[-0.7, 0, 0.2], 20], [[0.6, 0, -0.4], -35], [[0.1, 0, 0.5], 60]];
  return { person: spots[i][0], personYaw: spots[i][1], cam: { p: place(8, 4.6, 1.6, [0, 1.4, 0]), look: [0, 1.25, 0], mm: 35 }, tag: `jump ${i + 1}` };
}, { path: false, layout: 'sees', dur: 2.4 });
def('cuts', 'cross-dissolve', 'The first shot fades out while the next fades in, overlapping briefly.', 'Passing time, dreamy or gentle transitions.', u => ({ cam: WIDE, mix: { cam: CLOSE_CAR, a: sm(0.3, 0.7, u) }, tag: u < 0.3 ? 'A' : u > 0.7 ? 'B' : 'A → B' }), { path: false, marks: [WIDE, CLOSE_CAR], layout: 'sees', still: 0.5 });
def('cuts', 'continuous take, no cuts', 'One unbroken shot: the camera travels through the scene without cutting.', 'Immersion, tension, showing off choreography.', u => {
  const p = curve.getPoint(ease(u)), look = mix3(FOCUS, carFocus(), sm(0.35, 0.95, u));
  const tc = Math.floor(u * 3.4 * 24);
  return { cam: { p: [p.x, p.y, p.z], look, mm: 28 }, tag: `● 00:0${Math.floor(tc / 24)}:${String(tc % 24).padStart(2, '0')}` };
}, { dur: 3.4 });

// ---------- Lens ----------
def('lens', 'long lens compression', 'A long lens from far away flattens depth: the background looks bigger and closer.', 'Crowds, heat haze, making distances feel stacked and tense.', u => {
  const k = sm(0.15, 0.55, u), d = lerp(2.4, 13, k), mm = (24 * d) / 2.4;
  return { cam: { p: place(18, d, 1.6), look: FOCUS, mm }, tag: k < 0.5 ? `wide · ${Math.round(mm)}mm` : `long · ${Math.round(mm)}mm` };
}, { dur: 3, still: 1 });
for (const [t, mm, line, use] of [
  ['14mm ultra-wide', 14, 'A very wide view: lots of space, strong perspective and some distortion at the edges.', 'Tight interiors, action POV, exaggerated scale.'],
  ['24mm wide', 24, 'A wide view that shows the subject in their surroundings.', 'Establishing shots, movement through a space.'],
  ['35mm natural', 35, 'A natural, versatile view close to how a person notices a scene.', 'Everyday coverage, walk-and-talks.'],
  ['50mm normal', 50, 'A “normal” view with little distortion.', 'Medium shots and honest, neutral framing.'],
  ['85mm portrait', 85, 'A tighter, flattering view that isolates the subject.', 'Close-ups and portraits.'],
  ['135mm telephoto', 135, 'A narrow, magnified view that flattens and isolates.', 'Tight close-ups from a distance; surveillance feel.'],
] as [string, number, string, string][]) def('lens', t, line, use, lensFrame(mm), { layout: 'sees', path: false, still: 1 });
def('lens', 'anamorphic', 'A wide 2.39:1 cinema frame with horizontal streak flares and oval bokeh.', 'A big-screen, cinematic feel.', u => ({ cam: { p: place(18, lerp(6, 5, ease(u)), 1.6), look: [0.6, 1.25, -0.6], mm: 40 } }), { layout: 'sees', path: false, fx: { bars: true, flare: true } });
def('lens', 'macro', 'Extreme close focus on something tiny; everything else melts away.', 'Details, textures, insects, inserts.', u => ({ cam: { p: [FLOWER[0] + 0.05, 0.3, FLOWER[2] + lerp(0.6, 0.45, ease(u))], look: [FLOWER[0], 0.27, FLOWER[2]], mm: 100 }, blur: { person: 6, props: 6, env: 7 } }), { layout: 'sees', path: false });
def('lens', 'shallow depth of field', 'Only the subject is sharp; the background is a soft blur.', 'Isolating a character, romance, interviews.', u => ({ cam: { p: place(16, lerp(6.5, 6, ease(u)), 1.6), look: FOCUS, mm: 85 }, blur: { props: 5, env: 6, macro: 6 }, tag: 'f/1.4' }), { layout: 'sees', path: false });
def('lens', 'deep focus', 'Everything from foreground to background stays sharp.', 'Ensemble staging, showing cause and effect in one frame.', u => ({ cam: { p: [-1.6, 1.3, lerp(3.6, 3.2, ease(u))], look: [1.6, 1.0, -2.2], mm: 24 }, tag: 'f/11' }), { layout: 'sees', path: false });
def('lens', 'rack focus', 'Focus shifts from one subject to another during the shot.', 'Redirecting attention; a reveal in the background.', u => {
  const k = sm(0.38, 0.62, u);
  return { cam: { p: [-1.2, 1.5, 3], look: [1.6, 1.1, -1.6], mm: 45 }, blur: { person: 5 * k, props: 5 * (1 - k), env: 4, macro: 5 }, tag: k < 0.5 ? 'focus: near' : 'focus: far' };
}, { layout: 'sees', path: false });

// ---------- Filters (graded on the right of a moving wipe) ----------
const FILTERS: [string, string, string, Fx][] = [
  ['VHS tracking lines', 'Worn videotape: rolling tracking bands, scanlines and colour bleed.', 'Nostalgia, found footage, retro music videos.', { filter: 'saturate(1.35) contrast(1.1) brightness(1.05)', scan: true, chroma: 3 }],
  ['chroma smear', 'Colour channels slide apart, leaving red and blue fringes.', 'Glitchy, dreamlike or lo-fi looks.', { filter: 'saturate(1.3)', chroma: 5 }],
  ['Eastmancolor', 'Rich, warm 1950s–70s film stock colour.', 'Period pieces, warm nostalgic stories.', { filter: 'sepia(.28) saturate(1.45) contrast(1.06) hue-rotate(-6deg)', grain: 0.18 }],
  ['deep blue dusk', 'Cool, dim blue light just after sunset.', 'Melancholy, quiet evenings, night exteriors.', { filter: 'brightness(.78) saturate(.85) contrast(1.06)', tints: [{ stops: ['#1b2f74', '#3a5fb8'], op: 'color', alpha: 0.55, dir: 'v' }, { stops: ['#0d1430', '#0d143000'], op: 'multiply', alpha: 0.5, dir: 'v' }] }],
  ['saturated primaries', 'Bold, punchy reds, blues and yellows.', 'Comic-book energy, pop, kids’ and sports spots.', { filter: 'saturate(2.1) contrast(1.12)' }],
  ['35mm film grain', 'The fine, living texture of real film.', 'An organic, filmic feel instead of clean digital.', { filter: 'contrast(1.06) saturate(.92) sepia(.08)', grain: 0.5 }],
  ['teal and orange grade', 'Warm skin and highlights against cool teal shadows.', 'Blockbuster action, travel, commercials.', { filter: 'contrast(1.12) saturate(1.2)', tints: [{ stops: ['#f5a04a', '#0f7f86'], op: 'soft-light', alpha: 0.85, dir: 'r' }] }],
  ['black and white', 'No colour: just light, shadow and shape.', 'Timeless, noir, flashbacks, graphic style.', { filter: 'grayscale(1) contrast(1.2)' }],
  ['golden hour light', 'Low, warm sunlight with glowing highlights.', 'Romance, hope, endings, beauty shots.', { filter: 'sepia(.3) saturate(1.5) brightness(1.04)', tints: [{ stops: ['#ffcf70', '#ff8a3d00'], op: 'screen', alpha: 0.6, dir: 'r' }] }],
  ['neon noir', 'Dark, contrasty night lit by pink and cyan neon.', 'Cyberpunk, crime, night-city moods.', { filter: 'brightness(.62) contrast(1.35) saturate(1.7)', tints: [{ stops: ['#ff2e88', '#20d5ff'], op: 'color', alpha: 0.5, dir: 'h' }], glow: 0.3 }],
  ['bleach bypass', 'Desaturated, harsh, high-contrast look.', 'War, gritty thrillers, bleak worlds.', { filter: 'saturate(.35) contrast(1.45) brightness(1.04)' }],
  ['soft diffusion (ProMist)', 'Highlights bloom softly and contrast relaxes.', 'Dreamy, romantic, flattering skin.', { filter: 'contrast(.92) brightness(1.04)', glow: 0.6 }],
  ['anamorphic lens flare', 'Long horizontal streaks of light across the frame.', 'Sci-fi, night driving, glossy cinematic shine.', { filter: 'contrast(1.05)', flare: true, bars: true }],
  ['high contrast', 'Deep blacks and bright whites, little in between.', 'Drama, graphic style, harsh daylight.', { filter: 'contrast(1.65) saturate(1.1)' }],
  ['muted pastel palette', 'Soft, low-saturation, airy colours.', 'Whimsical, gentle, indie-film moods.', { filter: 'saturate(.5) brightness(1.12) contrast(.84)', tints: [{ stops: ['#f3c6d3', '#c7dcf2'], op: 'soft-light', alpha: 0.6, dir: 'h' }] }],
];
for (const [t, line, use, fx] of FILTERS) def('filter', t, line, use, filterFrame, { layout: 'sees', inset: false, path: false, loop: true, dur: 4, still: 0.25, fx });

/** Help for a term, if there is one. group 'move' takes a MOVES key. */
export function cameraHelp(group: HelpGroup, term: string): { title: string; line: string; use: string } | null {
  const s = SPECS[`${group}:${term}`];
  return s ? { title: s.title, line: s.line, use: s.use } : null;
}

// ---------- Shared renderer + scene (lazy, disposed after idle) ----------
const W = 288, H = 162; // CSS px of the main view (16:9)
const L = { person: 1, props: 2, env: 3, gizmo: 4, macro: 5 } as const;
type Rig = ReturnType<typeof buildRig>;
let rig: Rig | null = null;
let disposeTimer = 0;

function buildRig() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(1);
  renderer.setSize(Math.round(W * dpr), Math.round(H * dpr), false);
  const scene = new THREE.Scene();
  const owned: { dispose(): void }[] = [];
  const mat = (color: string, extra: THREE.MeshStandardMaterialParameters = {}) => { const m = new THREE.MeshStandardMaterial({ color, roughness: 0.82, metalness: 0, ...extra }); owned.push(m); return m; };
  const geo = <T extends THREE.BufferGeometry>(g: T) => { owned.push(g); return g; };
  const onLayer = (o: THREE.Object3D, layer: number) => { o.traverse(c => c.layers.set(layer)); return o; };
  scene.add(new THREE.HemisphereLight(0xfffaf0, 0xb3a893, 1.9));
  const sun = new THREE.DirectionalLight(0xffffff, 1.7); sun.position.set(5, 10, 7); scene.add(sun);
  scene.traverse(o => o.layers.enableAll());

  // Soft contact shadow texture.
  const sc = document.createElement('canvas'); sc.width = sc.height = 64;
  const sg = sc.getContext('2d')!, grad = sg.createRadialGradient(32, 32, 2, 32, 32, 31);
  grad.addColorStop(0, 'rgba(40,30,20,.45)'); grad.addColorStop(1, 'rgba(40,30,20,0)'); sg.fillStyle = grad; sg.fillRect(0, 0, 64, 64);
  const shadowTex = new THREE.CanvasTexture(sc); owned.push(shadowTex);
  const shadowMat = new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }); owned.push(shadowMat);
  const blob = (w: number, d: number) => { const m = new THREE.Mesh(geo(new THREE.PlaneGeometry(w, d)), shadowMat); m.rotation.x = -Math.PI / 2; m.position.y = 0.01; return m; };

  // Environment: ground, grid, a receding row of posts, trees.
  const env = new THREE.Group();
  const ground = new THREE.Mesh(geo(new THREE.PlaneGeometry(80, 80)), mat('#E4DDD0')); ground.rotation.x = -Math.PI / 2; env.add(ground);
  const grid = new THREE.GridHelper(40, 40, 0xc4baa9, 0xd3cbbd); grid.position.y = 0.005; owned.push(grid.geometry, grid.material as THREE.Material); env.add(grid);
  const postGeo = geo(new THREE.CylinderGeometry(0.09, 0.11, 3, 10)), lampGeo = geo(new THREE.SphereGeometry(0.2, 12, 8));
  const postMat = mat('#59606E'), lampMat = mat('#E9DFA8', { emissive: '#8a7a30', emissiveIntensity: 0.6 });
  for (const z of [-2, -6, -10, -14, -18]) {
    const post = new THREE.Mesh(postGeo, postMat); post.position.set(-2.8, 1.5, z); env.add(post);
    const lamp = new THREE.Mesh(lampGeo, lampMat); lamp.position.set(-2.8, 3.1, z); env.add(lamp);
  }
  const trunk = geo(new THREE.CylinderGeometry(0.14, 0.18, 1.4, 8)), crown = geo(new THREE.ConeGeometry(1.2, 3, 10));
  const trunkMat = mat('#7D6650'), leafMat = mat(KIND_COLORS.environment);
  for (const [x, z, s] of [[-6.5, -8, 1.1], [6.5, -10, 1.3], [1.2, -15, 1.5], [-9, -3, 1], [9, -4, 1.1], [-3, -20, 1.6]]) {
    const t = new THREE.Group(); const a = new THREE.Mesh(trunk, trunkMat); a.position.y = 0.7; const b = new THREE.Mesh(crown, leafMat); b.position.y = 2.6; t.add(a, b); t.position.set(x, 0, z); t.scale.setScalar(s); env.add(t);
  }
  const wall = new THREE.Mesh(geo(new THREE.BoxGeometry(14, 2.4, 0.3)), mat('#C9B9A0')); wall.position.set(1, 1.2, -24); env.add(wall);
  scene.add(onLayer(env, L.env));

  // Person: a capsule with a head and a visor showing which way they face.
  const person = new THREE.Group();
  const body = new THREE.Mesh(geo(new THREE.CapsuleGeometry(0.22, 0.95, 6, 14)), mat(KIND_COLORS.character)); body.position.y = 0.7;
  const head = new THREE.Mesh(geo(new THREE.SphereGeometry(0.15, 16, 12)), mat('#E8C9A8')); head.position.y = 1.62;
  const visor = new THREE.Mesh(geo(new THREE.BoxGeometry(0.2, 0.06, 0.08)), mat('#2B2622')); visor.position.set(0, 1.65, 0.13);
  person.add(body, head, visor, blob(0.9, 0.9));
  scene.add(onLayer(person, L.person));

  // Car: body, cabin, wheels. Local length along +z; yaw 90° points it along +x.
  const car = new THREE.Group();
  const carBody = new THREE.Mesh(geo(new THREE.BoxGeometry(1.9, 0.62, 4.5)), mat(KIND_COLORS.vehicle, { roughness: 0.45 })); carBody.position.y = 0.62;
  const cabin = new THREE.Mesh(geo(new THREE.BoxGeometry(1.62, 0.55, 2.2)), mat('#2B3442', { roughness: 0.3 })); cabin.position.set(0, 1.18, -0.25);
  const wheelGeo = geo(new THREE.CylinderGeometry(0.35, 0.35, 0.28, 20)), wheelMat = mat('#1E1C1A'), hubMat = mat('#C9C4BA');
  const hubGeo = geo(new THREE.CylinderGeometry(0.16, 0.16, 0.3, 16));
  car.add(carBody, cabin, blob(2.6, 5.4));
  for (const [x, z] of [[0.95, 1.4], [-0.95, 1.4], [0.95, -1.4], [-0.95, -1.4]]) {
    const w = new THREE.Mesh(wheelGeo, wheelMat); w.rotation.z = Math.PI / 2; w.position.set(x, 0.35, z);
    const hub = new THREE.Mesh(hubGeo, hubMat); hub.rotation.z = Math.PI / 2; hub.position.set(x, 0.35, z);
    car.add(w, hub);
  }
  scene.add(onLayer(car, L.props));
  const ball = new THREE.Mesh(geo(new THREE.SphereGeometry(0.22, 24, 16)), mat(KIND_COLORS.prop)); ball.position.set(...BALL);
  const ballShadow = blob(0.6, 0.6); ballShadow.position.set(BALL[0], 0.012, BALL[2]);
  scene.add(onLayer(ball, L.props), onLayer(ballShadow, L.props));
  // A tiny flower for macro.
  const flower = new THREE.Group();
  const stem = new THREE.Mesh(geo(new THREE.CylinderGeometry(0.006, 0.008, 0.26, 6)), mat('#4E8A2B')); stem.position.y = 0.13;
  const bloom = new THREE.Mesh(geo(new THREE.SphereGeometry(0.035, 14, 10)), mat('#F2C230', { emissive: '#6b4a00', emissiveIntensity: 0.3 })); bloom.position.y = 0.27;
  const petalGeo = geo(new THREE.SphereGeometry(0.03, 10, 8)), petalMat = mat('#F4F0E8');
  for (let i = 0; i < 6; i++) { const p = new THREE.Mesh(petalGeo, petalMat); const a = (i / 6) * Math.PI * 2; p.position.set(Math.cos(a) * 0.05, 0.27, Math.sin(a) * 0.05); p.scale.set(1, 0.4, 1); flower.add(p); }
  flower.add(stem, bloom); flower.position.set(...FLOWER);
  scene.add(onLayer(flower, L.macro));

  // Camera gizmo: body + lens + frustum (built along +z, which Object3D.lookAt aims at the target).
  const accent = new THREE.Color('#C8401F');
  const makeGizmo = (opacity: number) => {
    const g = new THREE.Group();
    const bodyM = new THREE.MeshBasicMaterial({ color: '#15130F', transparent: opacity < 1, opacity }); owned.push(bodyM);
    const lensM = new THREE.MeshBasicMaterial({ color: accent, transparent: opacity < 1, opacity }); owned.push(lensM);
    const camBody = new THREE.Mesh(geo(new THREE.BoxGeometry(0.34, 0.26, 0.42)), bodyM); camBody.position.z = -0.12;
    const lensMesh = new THREE.Mesh(geo(new THREE.CylinderGeometry(0.09, 0.11, 0.16, 14)), lensM); lensMesh.rotation.x = Math.PI / 2; lensMesh.position.z = 0.15;
    const lines = new THREE.BufferGeometry(); lines.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(16 * 3), 3)); owned.push(lines);
    const lineM = new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.9 * opacity }); owned.push(lineM);
    const frustum = new THREE.LineSegments(lines, lineM);
    const faces = new THREE.BufferGeometry(); faces.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(12 * 3), 3)); owned.push(faces);
    const faceM = new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.1 * opacity, side: THREE.DoubleSide, depthWrite: false }); owned.push(faceM);
    g.add(camBody, lensMesh, frustum, new THREE.Mesh(faces, faceM));
    const setFov = (mm: number, len: number) => {
      const hw = len * (18 / mm), hh = hw / (16 / 9), c = [[hw, hh], [-hw, hh], [-hw, -hh], [hw, -hh]];
      const a = lines.attributes.position as THREE.BufferAttribute, f = faces.attributes.position as THREE.BufferAttribute;
      let i = 0, j = 0;
      for (let k = 0; k < 4; k++) {
        const [x, y] = c[k], [nx, ny] = c[(k + 1) % 4];
        a.setXYZ(i++, 0, 0, 0.2); a.setXYZ(i++, x, y, len);
        a.setXYZ(i++, x, y, len); a.setXYZ(i++, nx, ny, len);
        f.setXYZ(j++, 0, 0, 0.2); f.setXYZ(j++, x, y, len); f.setXYZ(j++, nx, ny, len);
      }
      a.needsUpdate = true; f.needsUpdate = true; lines.computeBoundingSphere(); faces.computeBoundingSphere();
    };
    return { g: onLayer(g, L.gizmo) as THREE.Group, setFov };
  };
  const gizmo = makeGizmo(1), ghosts = [makeGizmo(0.32), makeGizmo(0.32)];
  scene.add(gizmo.g, ...ghosts.map(x => x.g));
  const sightGeo = new THREE.BufferGeometry(); sightGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3)); owned.push(sightGeo);
  const sightMat = new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.35 }); owned.push(sightMat);
  const sight = new THREE.Line(sightGeo, sightMat); sight.layers.set(L.gizmo); scene.add(sight);
  const pathMat = new THREE.LineBasicMaterial({ color: accent }); owned.push(pathMat);
  const path = new THREE.Line(new THREE.BufferGeometry(), pathMat); path.layers.set(L.gizmo); scene.add(path);

  const over = new THREE.PerspectiveCamera(30, 16 / 9, 0.1, 400); over.layers.enableAll();
  const eye = new THREE.PerspectiveCamera(40, 16 / 9, 0.02, 400); eye.filmGauge = 36;
  const buf = document.createElement('canvas'); buf.width = renderer.domElement.width; buf.height = renderer.domElement.height;
  const noise = document.createElement('canvas'); noise.width = noise.height = 128;
  { const n = noise.getContext('2d')!, img = n.createImageData(128, 128); for (let i = 0; i < img.data.length; i += 4) { const v = Math.random() * 255; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; } n.putImageData(img, 0, 0); }
  return { renderer, scene, person, car, gizmo, ghosts, sight, path, over, eye, buf, noise, dpr, owned };
}

function getRig() {
  clearTimeout(disposeTimer);
  return (rig ||= buildRig());
}
function scheduleDispose() {
  clearTimeout(disposeTimer);
  disposeTimer = window.setTimeout(() => {
    if (!rig || card?.isConnected && !card.hidden) return;
    rig.path.geometry.dispose();
    for (const o of rig.owned) o.dispose();
    rig.renderer.dispose(); rig.renderer.forceContextLoss();
    rig = null;
  }, 8000);
}

// ---------- Drawing ----------
const BG_SET = '#F1EDE5', BG_SEES = '#E8E0D2';
function setPose(cam: THREE.PerspectiveCamera, pose: Pose) {
  cam.position.set(...pose.p); cam.up.set(0, 1, 0); cam.lookAt(...pose.look);
  if (pose.roll) cam.rotateZ(rad(pose.roll));
  cam.setFocalLength(pose.mm); cam.updateProjectionMatrix(); cam.updateMatrixWorld();
}
function placeGizmo(gz: { g: THREE.Group; setFov(mm: number, len: number): void }, pose: Pose, size: number) {
  gz.g.visible = true; gz.g.position.set(...pose.p); gz.g.up.set(0, 1, 0); gz.g.lookAt(...pose.look);
  if (pose.roll) gz.g.rotateZ(-rad(pose.roll));
  gz.g.scale.setScalar(size); gz.setFov(pose.mm, 1.6);
}

type View = { spec: Spec; fitCenter: THREE.Vector3; fitDist: number; gizmoSize: number };
function prepare(r: Rig, spec: Spec): View {
  const pts: THREE.Vector3[] = [new THREE.Vector3(...FOCUS), new THREE.Vector3(0, 0, 0)];
  const camPts: THREE.Vector3[] = [];
  for (let i = 0; i <= 72; i++) {
    const f = spec.frame(i / 72), p = new THREE.Vector3(...f.cam.p);
    camPts.push(p); pts.push(p, new THREE.Vector3(...f.cam.look).lerp(p, 0.5));
    if (f.person) pts.push(new THREE.Vector3(...f.person));
    if (f.car) pts.push(new THREE.Vector3(...f.car));
  }
  for (const m of spec.marks || []) pts.push(new THREE.Vector3(...m.p));
  const box = new THREE.Box3().setFromPoints(pts), sphere = box.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(3.2, sphere.radius);
  const fitDist = (radius / Math.sin(rad(15))) * 0.92;
  r.path.geometry.dispose();
  r.path.geometry = new THREE.BufferGeometry().setFromPoints(camPts);
  r.path.visible = spec.path !== false;
  return { spec, fitCenter: sphere.center, fitDist, gizmoSize: Math.max(0.7, fitDist / 13) };
}

function applyObjects(r: Rig, f: Frame) {
  r.person.position.set(...(f.person || PERSON)); r.person.rotation.y = rad(f.personYaw ?? 0);
  r.car.position.set(...(f.car || CAR)); r.car.rotation.y = rad(f.carYaw ?? 90);
}

function renderLayers(r: Rig, cam: THREE.PerspectiveCamera, layers: number[], clear: string | null) {
  cam.layers.disableAll(); for (const l of layers) cam.layers.enable(l);
  r.scene.background = clear ? new THREE.Color(clear) : null;
  r.scene.fog = clear === BG_SEES ? new THREE.Fog(BG_SEES, 24, 60) : null;
  r.renderer.setClearColor(0x000000, 0);
  r.renderer.render(r.scene, cam);
}

/** Composes what the camera sees into r.buf (fake depth of field per layer, dissolves). */
function drawSees(r: Rig, f: Frame) {
  const b = r.buf.getContext('2d')!, w = r.buf.width, ht = r.buf.height;
  b.save(); b.filter = 'none'; b.globalAlpha = 1; b.fillStyle = BG_SEES; b.fillRect(0, 0, w, ht);
  const pass = (pose: Pose, alpha: number) => {
    setPose(r.eye, pose);
    b.globalAlpha = alpha;
    if (!f.blur) { renderLayers(r, r.eye, [L.env, L.person, L.props, L.macro], BG_SEES); b.drawImage(r.renderer.domElement, 0, 0); return; }
    // Back-to-front layers, each blurred by its own amount.
    const dist = (p: Vec3) => r.eye.position.distanceTo(new THREE.Vector3(...p));
    const order: ('person' | 'props' | 'macro')[] = (['person', 'props', 'macro'] as const).slice().sort((a, c) => dist(a === 'person' ? (f.person || PERSON) : a === 'props' ? (f.car || CAR) : FLOWER) < dist(c === 'person' ? (f.person || PERSON) : c === 'props' ? (f.car || CAR) : FLOWER) ? 1 : -1);
    const scale = w / W;
    renderLayers(r, r.eye, [L.env], BG_SEES); b.filter = `blur(${(f.blur.env || 0) * scale}px)`; b.drawImage(r.renderer.domElement, 0, 0);
    for (const k of order) { renderLayers(r, r.eye, [L[k]], null); b.filter = `blur(${(f.blur[k] || 0) * scale}px)`; b.drawImage(r.renderer.domElement, 0, 0); }
    b.filter = 'none';
  };
  pass(f.cam, 1);
  if (f.mix && f.mix.a > 0) pass(f.mix.cam, f.mix.a);
  b.restore();
}

function gradient(c: CanvasRenderingContext2D, t: Tint, w: number, ht: number) {
  const g = t.dir === 'r' ? c.createRadialGradient(w * 0.62, ht * 0.4, 0, w * 0.5, ht * 0.5, w * 0.7) : t.dir === 'h' ? c.createLinearGradient(0, 0, w, 0) : c.createLinearGradient(0, 0, 0, ht);
  t.stops.forEach((s, i) => g.addColorStop(i / Math.max(1, t.stops.length - 1), s));
  return g;
}
/** Post effects (grade, grain, scanlines, chroma, glow, flare, letterbox) onto c, within x ≥ from. */
function postFx(r: Rig, c: CanvasRenderingContext2D, fx: Fx, from: number, time: number) {
  const w = c.canvas.width, ht = c.canvas.height, src = r.buf;
  c.save(); c.beginPath(); c.rect(from, 0, w - from, ht); c.clip();
  c.filter = fx.filter || 'none'; c.drawImage(src, 0, 0, w, ht); c.filter = 'none';
  if (fx.chroma) {
    const k = fx.chroma * (w / W);
    c.globalCompositeOperation = 'screen'; c.globalAlpha = 0.45;
    c.filter = 'sepia(1) saturate(9) hue-rotate(-50deg) brightness(.7)'; c.drawImage(src, k, 0, w, ht);
    c.filter = 'sepia(1) saturate(9) hue-rotate(160deg) brightness(.7)'; c.drawImage(src, -k, 0, w, ht);
    c.filter = 'none';
  }
  if (fx.glow) { c.globalCompositeOperation = 'screen'; c.globalAlpha = fx.glow; c.filter = `blur(${6 * (w / W)}px) brightness(1.1)`; c.drawImage(src, 0, 0, w, ht); c.filter = 'none'; }
  for (const t of fx.tints || []) { c.globalCompositeOperation = t.op; c.globalAlpha = t.alpha ?? 1; c.fillStyle = gradient(c, t, w, ht); c.fillRect(0, 0, w, ht); }
  if (fx.grain) { c.globalCompositeOperation = 'overlay'; c.globalAlpha = fx.grain; const pat = c.createPattern(r.noise, 'repeat')!; c.translate((time * 977) % 128, (time * 613) % 128); c.fillStyle = pat; c.fillRect(-128, -128, w + 256, ht + 256); c.setTransform(1, 0, 0, 1, 0, 0); }
  if (fx.scan) {
    c.globalCompositeOperation = 'multiply'; c.globalAlpha = 0.28; c.fillStyle = '#000';
    for (let y = 0; y < ht; y += 4) c.fillRect(0, y, w, 1.5);
    const band = ((time * 0.35) % 1.2 - 0.1) * ht;
    c.globalCompositeOperation = 'screen'; c.globalAlpha = 0.55;
    const g = c.createLinearGradient(0, band - 10, 0, band + 10); g.addColorStop(0, '#fff0'); g.addColorStop(0.5, '#fffc'); g.addColorStop(1, '#fff0'); c.fillStyle = g; c.fillRect(0, band - 10, w, 20);
  }
  if (fx.flare) {
    const y = ht * 0.33, x = w * (0.6 + 0.08 * Math.sin(time * 0.8));
    c.globalCompositeOperation = 'screen'; c.globalAlpha = 1;
    const g = c.createLinearGradient(0, 0, w, 0); g.addColorStop(0, '#2a6cff00'); g.addColorStop(x / w, '#9fd0ffee'); g.addColorStop(1, '#2a6cff00');
    c.fillStyle = g; c.fillRect(0, y - ht * 0.012, w, ht * 0.024);
    const rg = c.createRadialGradient(x, y, 0, x, y, ht * 0.16); rg.addColorStop(0, '#ffffffee'); rg.addColorStop(0.3, '#a8d4ff88'); rg.addColorStop(1, '#a8d4ff00');
    c.fillStyle = rg; c.fillRect(x - ht * 0.2, y - ht * 0.2, ht * 0.4, ht * 0.4);
  }
  c.restore();
  if (fx.bars) { const bar = (ht - w / 2.39) / 2; c.fillStyle = '#0d0c0b'; c.fillRect(0, 0, w, bar); c.fillRect(0, ht - bar, w, bar); }
}

function drawTag(c: CanvasRenderingContext2D, text: string, scale: number, x0: 'l' | 'r' = 'l') {
  c.save(); c.font = `600 ${10 * scale}px ui-monospace, 'SF Mono', Menlo, monospace`;
  const tw = c.measureText(text).width, pad = 5 * scale, bh = 16 * scale, x = x0 === 'l' ? 7 * scale : c.canvas.width - tw - pad * 2 - 7 * scale, y = 7 * scale;
  c.fillStyle = 'rgba(21,19,15,.72)'; c.beginPath(); c.roundRect(x, y, tw + pad * 2, bh, 4 * scale); c.fill();
  c.fillStyle = '#F6F3EE'; c.textBaseline = 'middle'; c.fillText(text, x + pad, y + bh / 2 + 0.5 * scale); c.restore();
}

function drawFrame(r: Rig, v: View, u: number, time: number, setCtx: CanvasRenderingContext2D, seesCtx: CanvasRenderingContext2D): string {
  const f = v.spec.frame(u);
  applyObjects(r, f);
  // Set view: fixed 3/4 overview with the camera, its path and sight line.
  const dir = new THREE.Vector3(0.62, 0.62, 1).normalize();
  r.over.position.copy(v.fitCenter).addScaledVector(dir, v.fitDist); r.over.lookAt(v.fitCenter); r.over.updateMatrixWorld();
  placeGizmo(r.gizmo, f.cam, v.gizmoSize);
  const marks = v.spec.marks || (v.spec.path === false ? [] : [v.spec.frame(0).cam]);
  r.ghosts.forEach((gz, i) => { if (marks[i]) placeGizmo(gz, marks[i], v.gizmoSize); else gz.g.visible = false; });
  const s = r.sight.geometry.attributes.position as THREE.BufferAttribute; s.setXYZ(0, ...f.cam.p); s.setXYZ(1, ...f.cam.look); s.needsUpdate = true; r.sight.geometry.computeBoundingSphere();
  renderLayers(r, r.over, [L.env, L.person, L.props, L.macro, L.gizmo], BG_SET);
  setCtx.drawImage(r.renderer.domElement, 0, 0, setCtx.canvas.width, setCtx.canvas.height);
  // Camera view.
  drawSees(r, f);
  const c = seesCtx, w = c.canvas.width, ht = c.canvas.height, scale = w / W;
  c.save(); c.filter = f.grade || 'none';
  if (f.motion && f.motion > 0.5) { const k = f.motion * (w / W) * (w / r.buf.width); c.globalAlpha = 1; c.drawImage(r.buf, 0, 0, w, ht); for (let i = -3; i <= 3; i++) { if (!i) continue; c.globalAlpha = 0.16; c.drawImage(r.buf, (i * k) / 3, 0, w, ht); } }
  else c.drawImage(r.buf, 0, 0, w, ht);
  c.restore();
  const fx = v.spec.fx;
  if (fx) {
    const from = f.wipe === undefined ? 0 : Math.round(f.wipe * w);
    postFx(r, c, fx, from, time);
    if (f.wipe !== undefined) {
      c.save(); c.fillStyle = '#FFFDF9'; c.fillRect(from - scale, 0, 2 * scale, ht); c.restore();
      drawTag(c, 'before', scale, 'l'); drawTag(c, 'after', scale, 'r');
    }
  }
  if (f.flash) { c.save(); c.globalAlpha = f.flash * 0.85; c.fillStyle = '#fff'; c.fillRect(0, 0, w, ht); c.restore(); }
  if (f.tag && v.spec.layout === 'sees') drawTag(c, f.tag, scale);
  return f.tag || '';
}

// ---------- The popover card ----------
let card: HTMLElement | null = null;
let showing: { anchor: HTMLElement; view: View; set: CanvasRenderingContext2D; sees: CanvasRenderingContext2D; t0: number; lab: HTMLElement; tag: string } | null = null;
let raf = 0;
const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const groupColor = (g: HelpGroup) => (g === 'move' ? FIELD_COLORS.camera : FIELD_COLORS[g]);
const groupName = (g: HelpGroup) => (g === 'move' ? 'Camera move' : CAMERA_GROUPS[g]);

function ensureCard() {
  if (card?.isConnected) return card;
  card = h('div', { class: 'ch-card', id: 'ch-card', role: 'tooltip', hidden: true });
  document.body.append(card);
  return card;
}

function position(el: HTMLElement, anchor: HTMLElement) {
  const a = anchor.getBoundingClientRect(), cw = el.offsetWidth, chh = el.offsetHeight, m = 10, vw = innerWidth, vh = innerHeight;
  // Sit beside the whole side panel (or open menu) so the card never covers the control in use.
  const host = anchor.closest('.ch-menu, .side'), left = host ? Math.min(a.left, host.getBoundingClientRect().left) : a.left;
  let x = left - cw - m, y = a.top + a.height / 2 - chh / 2;
  if (x < m) { x = a.right + m; if (x + cw > vw - m) { x = Math.min(vw - cw - m, Math.max(m, a.left)); y = a.bottom + m; if (y + chh > vh - m) y = a.top - chh - m; } }
  el.style.left = `${Math.round(x)}px`; el.style.top = `${Math.round(Math.max(m, Math.min(vh - chh - m, y)))}px`;
}

function tick(now: number) {
  raf = 0;
  if (!showing || !card) return;
  if (!showing.anchor.isConnected) { hideHelp(); return; }
  const r = getRig(), spec = showing.view.spec, dur = spec.dur ?? 2.6;
  const t = (now - showing.t0) / 1000;
  let u: number;
  if (reduced()) u = spec.still ?? 0.75;
  else if (spec.loop) u = (t % dur) / dur;
  else { const hold0 = 0.35, hold1 = 0.75, p = dur + hold0 + hold1; u = clamp(((t % p) - hold0) / dur); }
  const tag = drawFrame(r, showing.view, u, t, showing.set, showing.sees);
  if (spec.layout !== 'sees' && tag !== showing.tag) { showing.tag = tag; showing.lab.textContent = tag ? `Camera sees · ${tag}` : 'Camera sees'; }
  if (!reduced() && !document.hidden) raf = requestAnimationFrame(tick);
}

/** Shows the help card for a term next to an anchor element. */
export function showHelp(anchor: HTMLElement, group: HelpGroup, term: string) {
  const spec = SPECS[`${group}:${term}`];
  if (!spec) { hideHelp(); return; }
  const el = ensureCard();
  if (showing?.anchor === anchor && showing.view.spec === spec && !el.hidden) return;
  const r = getRig(), dpr = r.dpr;
  const mk = (cls: string) => { const c = h('canvas', { class: cls, width: Math.round(W * dpr), height: Math.round(H * dpr), 'aria-hidden': 'true' }); return c; };
  const setC = mk('ch-set'), seesC = mk('ch-sees');
  const layout = spec.layout || 'set';
  const labSees = h('span', { class: 'ch-lab ch-lab-sees' }, layout === 'set' ? 'Camera sees' : 'What the camera sees');
  el.style.setProperty('--c', groupColor(group));
  el.replaceChildren(
    h('div', { class: 'ch-head' }, h('span', { class: 'ch-kind' }, h('i'), groupName(group)), h('b', { class: 'ch-title' }, spec.title)),
    h('div', { class: `ch-stage is-${layout}${spec.inset === false ? ' no-inset' : ''}` }, setC, seesC,
      h('span', { class: 'ch-lab ch-lab-set' }, layout === 'set' ? 'On set' : 'Set'), labSees),
    h('p', { class: 'ch-line', id: 'ch-card-line' }, spec.line),
    h('p', { class: 'ch-use' }, h('span', {}, 'Use it for'), ' ', spec.use));
  el.hidden = false;
  el.classList.remove('is-in'); void el.offsetWidth; el.classList.add('is-in');
  position(el, anchor);
  anchor.setAttribute('aria-describedby', 'ch-card-line');
  showing = { anchor, view: prepare(r, spec), set: setC.getContext('2d')!, sees: seesC.getContext('2d')!, t0: performance.now(), lab: labSees, tag: '' };
  if (!raf) raf = requestAnimationFrame(tick);
}

document.addEventListener('visibilitychange', () => { if (!document.hidden && showing && !raf) raf = requestAnimationFrame(tick); });

export function hideHelp() {
  if (raf) cancelAnimationFrame(raf); raf = 0;
  showing?.anchor.removeAttribute('aria-describedby');
  showing = null;
  if (card) { card.hidden = true; card.replaceChildren(); }
  scheduleDispose();
}

/** Hover (after a short delay) or keyboard focus on el shows the help card for the term. */
export function attachHelp(el: HTMLElement, group: HelpGroup, term: string | (() => string)) {
  const key = () => (typeof term === 'function' ? term() : term);
  if (typeof term === 'string' && !SPECS[`${group}:${term}`]) return el;
  let timer = 0;
  el.addEventListener('pointerenter', () => { clearTimeout(timer); timer = window.setTimeout(() => showHelp(el, group, key()), 220); });
  el.addEventListener('pointerleave', () => { clearTimeout(timer); if (showing?.anchor === el) hideHelp(); });
  el.addEventListener('focus', () => { if (el.matches(':focus-visible')) showHelp(el, group, key()); });
  el.addEventListener('blur', () => { clearTimeout(timer); if (showing?.anchor === el) hideHelp(); });
  el.addEventListener('keydown', ev => { if (ev.key === 'Escape' && showing?.anchor === el) { ev.stopPropagation(); hideHelp(); } });
  el.addEventListener('pointerdown', () => { clearTimeout(timer); if (showing?.anchor === el) hideHelp(); });
  return el;
}

// ---------- Picker: a listbox whose active option previews itself ----------
let openMenu: { close(focusBack: boolean): void } | null = null;

/** A button that opens a list of terms; hovering or arrowing to one shows its animated preview. */
export function termPicker(opts: { group: HelpGroup; label: string | Node; ariaLabel: string; items: { value: string; label?: string }[]; current?: string; onPick(value: string): void; className?: string }) {
  const btn = h('button', { type: 'button', class: opts.className || 'ch-pick', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-label': opts.ariaLabel }, opts.label);
  btn.onclick = () => (btn.getAttribute('aria-expanded') === 'true' ? openMenu?.close(true) : open());
  btn.onkeydown = ev => { if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); open(); } };
  function open() {
    openMenu?.close(false);
    if (!opts.items.length) return;
    const id = `ch-menu-${Math.random().toString(36).slice(2, 8)}`;
    let active = Math.max(0, opts.items.findIndex(i => i.value === opts.current));
    const list = h('div', { class: 'ch-menu', role: 'listbox', id, tabindex: -1, 'aria-label': opts.ariaLabel, style: `--c:${groupColor(opts.group)}` },
      h('div', { class: 'ch-menu-head', 'aria-hidden': 'true' }, h('i'), groupName(opts.group), h('small', {}, 'hover or ↑↓ to preview')),
      ...opts.items.map((it, i) => {
        const help = cameraHelp(opts.group, it.value);
        const o = h('div', { class: 'ch-opt' + (it.value === opts.current ? ' is-current' : ''), role: 'option', id: `${id}-${i}`, 'aria-selected': String(it.value === opts.current) },
          h('span', { class: 'ch-opt-t' }, it.label || help?.title || it.value), help ? h('span', { class: 'ch-opt-h' }, help.line) : null);
        o.onpointerenter = () => setActive(i, false);
        o.onclick = () => pick(i);
        return o;
      }));
    const opt = (i: number) => list.querySelector<HTMLElement>(`#${id}-${i}`)!;
    function setActive(i: number, scroll = true) {
      opt(active)?.classList.remove('is-active');
      active = (i + opts.items.length) % opts.items.length;
      const el = opt(active); el.classList.add('is-active'); list.setAttribute('aria-activedescendant', el.id);
      if (scroll) el.scrollIntoView({ block: 'nearest' });
      showHelp(el, opts.group, opts.items[active].value);
    }
    function pick(i: number) { const v = opts.items[i].value; close(true); opts.onPick(v); }
    function close(focusBack: boolean) {
      hideHelp(); list.remove(); document.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', onResize);
      btn.setAttribute('aria-expanded', 'false'); openMenu = null;
      if (focusBack && btn.isConnected) btn.focus({ preventScroll: true });
    }
    const outside = (ev: PointerEvent) => { if (!list.contains(ev.target as Node) && ev.target !== btn && !btn.contains(ev.target as Node)) close(false); };
    const onResize = () => close(false);
    list.onkeydown = ev => {
      if (ev.key === 'ArrowDown') { ev.preventDefault(); setActive(active + 1); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); setActive(active - 1); }
      else if (ev.key === 'Home') { ev.preventDefault(); setActive(0); }
      else if (ev.key === 'End') { ev.preventDefault(); setActive(opts.items.length - 1); }
      else if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(active); }
      else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(true); }
      else if (ev.key === 'Tab') close(false);
    };
    document.body.append(list);
    const a = btn.getBoundingClientRect(), lh = list.offsetHeight, lw = list.offsetWidth;
    const below = a.bottom + 4 + lh <= innerHeight - 8;
    list.style.left = `${Math.round(Math.max(8, Math.min(innerWidth - lw - 8, a.right - lw)))}px`;
    list.style.top = `${Math.round(below ? a.bottom + 4 : Math.max(8, a.top - lh - 4))}px`;
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true); window.addEventListener('resize', onResize);
    openMenu = { close };
    list.focus({ preventScroll: true });
    setActive(active);
  }
  return btn;
}

/** ⓘ next to the Move select: hover/focus previews the chosen move; click opens the move picker. */
export function moveHelp(select: HTMLSelectElement) {
  const items = () => Array.from(select.options).map(o => ({ value: o.value, label: o.textContent || o.value }));
  const btn = termPicker({ group: 'move', label: 'i', ariaLabel: 'What do the camera moves mean? Browse moves with previews', className: 'ch-info', items: items(), current: select.value, onPick: v => { select.value = v; select.dispatchEvent(new Event('change')); } });
  btn.title = '';
  attachHelp(btn, 'move', () => select.value);
  return btn;
}
