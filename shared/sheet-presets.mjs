// Copyright (c) 2026 Steven Bobyn. SPDX-License-Identifier: MIT
// Design sheets: sets of views of one scene object (turnarounds, headshots, expressions,
// details, establishing views). Each view is generated as its own image from the same
// identity reference (the object's primary image); the sheet is composed locally.
// Adapted from the DesignSheet app's presets (character-turnaround/public/designsheet/presets.mjs).

export const MAX_SHEET_SLOTS = 48; // one batch never exceeds this many images
const MAX_SHEETS = 8, MAX_ATTEMPTS = 12;

/** What to call the subject in prompts (never its name: models paint names on as lettering). */
export const SUBJECT = { character: 'character', vehicle: 'vehicle', prop: 'object', environment: 'place' };
const noun = kind => SUBJECT[kind] || 'object';

// Left/right always mean the image's left/right as the viewer sees it.
const CHARACTER_ANGLES = {
  front: 'facing the viewer, front view',
  left: 'side view in profile, the whole body turned to face the left edge of the image (viewer’s left)',
  right: 'side view in profile, the whole body turned to face the right edge of the image (viewer’s right)',
  back: 'back view, facing directly away from the viewer',
  'front-left': 'three-quarter front view, turned halfway toward the left edge of the image (viewer’s left)',
  'front-right': 'three-quarter front view, turned halfway toward the right edge of the image (viewer’s right)',
  'back-left': 'three-quarter back view, turned mostly away from the viewer, toward the left edge of the image (viewer’s left)',
  'back-right': 'three-quarter back view, turned mostly away from the viewer, toward the right edge of the image (viewer’s right)',
};
const objectAngles = n => ({
  front: `seen straight from the front, the front of the ${n} facing the viewer`,
  left: `exact side view, the front of the ${n} pointing toward the left edge of the image (viewer’s left)`,
  right: `exact side view, the front of the ${n} pointing toward the right edge of the image (viewer’s right)`,
  back: `seen straight from behind, the back of the ${n} facing the viewer`,
  'front-left': `three-quarter front view, the front of the ${n} angled toward the left edge of the image (viewer’s left)`,
  'front-right': `three-quarter front view, the front of the ${n} angled toward the right edge of the image (viewer’s right)`,
  'back-left': `three-quarter rear view, the back of the ${n} toward the viewer, its front angled toward the left edge of the image (viewer’s left)`,
  'back-right': `three-quarter rear view, the back of the ${n} toward the viewer, its front angled toward the right edge of the image (viewer’s right)`,
  top: `seen from directly above (top-down plan view), the front of the ${n} pointing toward the top edge of the image`,
});
export const anglesFor = kind => (kind === 'character' ? CHARACTER_ANGLES : objectAngles(noun(kind)));
export const ANGLE_LABELS = { front: 'Front', 'front-left': 'Front ¾ left', left: 'Left side', 'back-left': 'Back ¾ left', back: 'Back', 'back-right': 'Back ¾ right', right: 'Right side', 'front-right': 'Front ¾ right', top: 'Top' };

export const FRAMINGS = {
  full: { label: 'Full body', text: 'full body from head to feet, the whole figure inside the frame with a little space around it', aspect: '3:4', layout: 'body' },
  bust: { label: 'Head & shoulders', text: 'head-and-shoulders portrait, cropped at the upper chest', aspect: '1:1', layout: 'tile' },
  head: { label: 'Head', text: 'close-up of the head and face only', aspect: '1:1', layout: 'tile' },
  whole: { label: 'Whole object', text: 'the whole {n} inside the frame with a little space around it', aspect: '4:3', layout: 'body' },
  detail: { label: 'Detail', text: 'a close-up detail shot that fills the frame', aspect: '1:1', layout: 'tile' },
  wide: { label: 'Wide', text: 'a wide view of the whole place', aspect: '16:9', layout: 'wide' },
};

export const INTENSITIES = {
  subtle: { label: 'Subtle', text: 'a subtle, understated' },
  clear: { label: 'Clear', text: 'a clear, readable' },
  strong: { label: 'Strong', text: 'a strong, exaggerated' },
};

export const EXPRESSION_PACKS = [
  { id: 'basic6', label: 'Basic 6', hint: 'Angry, disgust, fear, happy, sad, surprise', emotions: ['angry', 'disgusted', 'afraid', 'happy', 'sad', 'surprised'] },
  { id: 'acting9', label: 'Acting 9', hint: 'Neutral, content, laughing, smug, worried…', emotions: ['neutral', 'content', 'laughing', 'smug', 'worried', 'furious', 'weary', 'sad', 'stern'] },
  { id: 'mouth', label: 'Mouth shapes', hint: 'Lip-sync shapes for animation', emotions: ['rest (mouth closed)', 'A (open "ah")', 'E (wide "ee")', 'O (round "oh")', 'U (pursed "oo")', 'M/B/P (lips pressed)', 'F/V (teeth on lip)', 'L (tongue up)'], mouth: true },
];

const titleCase = s => s.charAt(0).toUpperCase() + s.slice(1);
const slug = s => String(s).toLowerCase().normalize('NFKD').replace(/¾/g, '34').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'view';
const slot = (label, spec) => ({ id: slug(label), label, spec });
const turn = (framing, angles) => angles.map(a => slot(a === 'left' || a === 'right' ? (framing === 'full' ? titleCase(a) : ANGLE_LABELS[a]) : ANGLE_LABELS[a], { framing, angle: a }));

const DETAILS = {
  vehicle: [['Front & lights', 'the front end: headlights, grille and badge area'], ['Wheel & side', 'one wheel, the tyre and the lower side panel'], ['Rear & tail lights', 'the rear end: tail lights and rear bodywork'], ['Interior', 'the cockpit or interior seen through the open door or window']],
  prop: [['Key feature', 'its most distinctive feature'], ['Material', 'its surface material, texture and finish'], ['Back & underside', 'the back or underside, showing how it is built']],
};
const ESTABLISHING = [
  ['Wide', 'wide establishing view showing the whole place at eye level'],
  ['Reverse', 'reverse angle: looking back the opposite way from the main view, same place'],
  ['High angle', 'high angle looking down over the whole place'],
  ['Ground level', 'ground-level view from a low camera just above the ground'],
];

/** Sets offered per object kind. `options` are the defaults; planSlots() expands them into slots. */
export const SHEET_SETS = [
  { id: 'turn3', kinds: ['character'], label: 'Turnaround · 3', hint: 'Front, side, back', layout: 'turnaround' },
  { id: 'turn4', kinds: ['character'], label: 'Turnaround · 4', hint: 'Front, left, back, right', layout: 'turnaround' },
  { id: 'turn8', kinds: ['character'], label: 'Turnaround · 8', hint: 'Adds the ¾ angles', layout: 'turnaround' },
  { id: 'heads3', kinds: ['character'], label: 'Headshots · 3', hint: 'Front, ¾, profile', layout: 'expressions' },
  { id: 'poses3', kinds: ['character'], label: 'Poses · 3', hint: 'Idle, walk, action', layout: 'turnaround' },
  { id: 'expressions', kinds: ['character'], label: 'Expressions', hint: 'Emotion packs × intensity × angle', layout: 'expressions', options: { pack: 'basic6', intensities: ['clear'], angle: 'front' } },
  { id: 'obj-turn4', kinds: ['vehicle', 'prop'], label: 'Turnaround · 4', hint: 'Front, sides, back', layout: 'turnaround', options: { top: false } },
  { id: 'obj-turn8', kinds: ['vehicle', 'prop'], label: 'Turnaround · 8', hint: 'Adds the ¾ angles', layout: 'turnaround', options: { top: false } },
  { id: 'details', kinds: ['vehicle', 'prop'], label: 'Details', hint: 'Close-ups of key parts', layout: 'expressions' },
  { id: 'establishing', kinds: ['environment'], label: 'Establishing · 4', hint: 'Wide, reverse, high, ground level', layout: 'full' },
  { id: 'custom', kinds: ['character', 'vehicle', 'prop', 'environment'], label: 'Custom view', hint: 'One view you describe', layout: 'full', options: { label: '', direction: '', angle: 'front', framing: '' } },
];
export const setsFor = kind => SHEET_SETS.filter(s => s.kinds.includes(kind || 'prop'));
export const setDef = id => SHEET_SETS.find(s => s.id === id) || null;

/** Expand a set + options into its slots ({ id, label, spec }). Never more than MAX_SHEET_SLOTS. */
export function planSlots(setId, kind, options = {}) {
  const o = { ...(setDef(setId)?.options || {}), ...options };
  const whole = kind === 'environment' ? 'wide' : kind === 'character' ? 'full' : 'whole';
  let out;
  switch (setId) {
    case 'turn3': out = [slot('Front', { framing: 'full', angle: 'front' }), slot('Side', { framing: 'full', angle: 'left' }), slot('Back', { framing: 'full', angle: 'back' })]; break;
    case 'turn4': out = turn('full', ['front', 'left', 'back', 'right']); break;
    case 'turn8': out = turn('full', ['front', 'front-left', 'left', 'back-left', 'back', 'back-right', 'right', 'front-right']); break;
    case 'heads3': out = [slot('Front', { framing: 'bust', angle: 'front' }), slot('¾', { framing: 'bust', angle: 'front-left' }), slot('Profile', { framing: 'bust', angle: 'left' })]; break;
    case 'poses3': out = [slot('Idle', { framing: 'full', angle: 'front-left', pose: 'a relaxed idle stance' }), slot('Walk', { framing: 'full', angle: 'left', pose: 'mid-stride walking' }), slot('Action', { framing: 'full', angle: 'front-right', pose: 'a dynamic action pose that suits the character' })]; break;
    case 'expressions': out = expressionSlots(o); break;
    case 'obj-turn4': out = turn('whole', ['front', 'left', 'back', 'right', ...(o.top ? ['top'] : [])]); break;
    case 'obj-turn8': out = turn('whole', ['front', 'front-left', 'left', 'back-left', 'back', 'back-right', 'right', 'front-right', ...(o.top ? ['top'] : [])]); break;
    case 'details': out = (DETAILS[kind] || DETAILS.prop).map(([label, detail]) => slot(label, { framing: 'detail', angle: 'front', detail })); break;
    case 'establishing': out = ESTABLISHING.map(([label, view]) => slot(label, { framing: 'wide', angle: 'front', view })); break;
    case 'custom': {
      const label = String(o.label || '').trim().slice(0, 40) || 'Custom';
      out = [slot(label, { framing: FRAMINGS[o.framing] ? o.framing : whole, angle: anglesFor(kind)[o.angle] ? o.angle : 'front', direction: String(o.direction || '').slice(0, 300) })];
      break;
    }
    default: out = [];
  }
  return out.slice(0, MAX_SHEET_SLOTS);
}

/** Expression slots: emotions × intensities × angles (front, ¾ or both). */
export function expressionSlots({ pack = 'basic6', intensities = ['clear'], angle = 'front' }) {
  const p = EXPRESSION_PACKS.find(x => x.id === pack) || EXPRESSION_PACKS[0];
  const angles = angle === 'both' ? ['front', 'front-left'] : [angle === 'front-left' ? 'front-left' : 'front'];
  const levels = p.mouth ? [null] : (Array.isArray(intensities) ? intensities : []).filter(l => INTENSITIES[l]);
  const out = [];
  for (const a of angles) for (const level of levels.length ? levels : ['clear']) for (const emotion of p.emotions) {
    const name = titleCase(emotion.replace(/ \(.*\)$/, ''));
    const label = [name, level && levels.length > 1 && INTENSITIES[level].label, angles.length > 1 && (a === 'front' ? 'front' : '¾')].filter(Boolean).join(' · ');
    out.push({ id: slug([name, level, a].filter(Boolean).join('-')), label, spec: { framing: 'bust', angle: a, expression: emotion, intensity: level, mouth: !!p.mouth } });
  }
  return out;
}

/** Image aspect for a slot (the refgen aspects: 1:1, 3:4, 4:3, 16:9). */
export function slotAspect(spec, kind) {
  if (kind === 'environment') return '16:9';
  if (spec?.angle === 'top') return kind === 'vehicle' ? '3:4' : '1:1';
  if (spec?.framing === 'whole') return kind === 'vehicle' ? '16:9' : '4:3';
  return (FRAMINGS[spec?.framing] || FRAMINGS.full).aspect;
}
/** How a slot is laid out on a composed sheet: body (same-scale row), tile (square grid) or wide. */
export const slotLayout = spec => (FRAMINGS[spec?.framing] || FRAMINGS.full).layout;

const line = (label, text) => (text ? `${label}${text}` : '');
// Objects may carry intended lettering (logos, printed shirts), so only forbid added text.
const NO_ADDED_TEXT = 'Do not add captions, labels, names, watermarks, borders or frames. Keep any lettering or logos that are part of the design itself (for example printed on clothing or bodywork) exactly as in the reference.';

/** Prompt for one view, generated from the identity reference (image 1). */
export function viewPrompt({ kind, spec, description, styleNotes, projectStyle, note, hasReference = true }) {
  const n = noun(kind), env = kind === 'environment';
  const framing = FRAMINGS[spec.framing] || FRAMINGS.full;
  const lines = [];
  if (env) lines.push(hasReference ? 'Show the exact same place as the first reference image: identical architecture, layout, materials, colours, lighting, time of day and rendering style.' : 'Create a reference image of a place.');
  else lines.push(hasReference ? `Draw the exact same ${n} as the first reference image: identical identity, ${kind === 'character' ? 'face, proportions, outfit,' : 'shape, proportions,'} materials, colours, markings and rendering style.` : `Create a ${n} design reference image.`);
  if (env) lines.push(`View: ${spec.view || framing.text}.`);
  else if (spec.framing === 'detail') lines.push(`Close-up detail of ${spec.detail || `the ${n}`}, ${framing.text}.`);
  else lines.push(`Show the ${n} ${anglesFor(kind)[spec.angle] || anglesFor(kind).front}. Framing: ${framing.text.replace('{n}', n)}.`);
  if (kind === 'character') {
    if (spec.pose) lines.push(`Pose: ${spec.pose}.`);
    else if (spec.framing === 'full') lines.push('Pose: neutral standing pose, arms relaxed.');
    if (spec.expression) {
      if (spec.mouth) lines.push(`Mouth shape for lip-sync: ${spec.expression}. Keep the rest of the face neutral.`);
      else lines.push(`Facial expression: ${spec.intensity ? INTENSITIES[spec.intensity].text + ' ' : ''}${spec.expression} expression.`);
    }
  }
  if (spec.direction) lines.push(`View: ${spec.direction}`);
  if (env) lines.push(`One single image of the place. ${NO_ADDED_TEXT}`);
  else lines.push(`Plain white background, soft even studio lighting. One single view of exactly one ${n}, no other ${kind === 'character' ? 'people' : 'objects'}. ${NO_ADDED_TEXT}`);
  lines.push(line(`${titleCase(n)} notes: `, description), line('Look: ', styleNotes), line('Rendering style: ', projectStyle), line('Additional direction: ', note));
  return lines.filter(Boolean).join('\n\n').slice(0, 2500);
}

/** Prompt for "Edit this image": the attempt is image 1, the identity reference image 2. */
export function editViewPrompt({ kind, instruction, styleNotes, projectStyle, hasIdentity = false }) {
  const n = noun(kind);
  return [
    `Edit the first reference image: ${instruction}`,
    `Change only what this instruction asks for. Keep everything else identical: the same ${n}, ${kind === 'character' ? 'face, proportions, outfit, ' : kind === 'environment' ? 'layout, ' : 'shape, proportions, '}colours, rendering style, framing, angle and background.`,
    hasIdentity && `The second reference image is the original ${n} design; stay consistent with it.`,
    NO_ADDED_TEXT,
    line('Look: ', styleNotes), line('Rendering style: ', projectStyle),
  ].filter(Boolean).join('\n\n').slice(0, 2500);
}

// ---------- Stored sheets (entity.sheets) ----------
// sheet: { id, setId, label, options, presetId, createdAt, slots: [{ id, label, spec, attempts, selected, accepted }] }
// attempt: { id, requestId, referenceId, mode: generate|retry|edit, note, from, presetId, seed, error, createdAt }
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const idOk = v => typeof v === 'string' && /^[A-Za-z0-9-]{1,48}$/.test(v);
const uuidOr = v => (typeof v === 'string' && /^[a-f0-9-]{36}$/.test(v) ? v : null);
function cleanSpec(s) {
  if (!s || typeof s !== 'object') return { framing: 'full', angle: 'front' };
  const out = {};
  for (const k of ['framing', 'angle', 'intensity']) if (typeof s[k] === 'string') out[k] = s[k].slice(0, 20);
  for (const k of ['pose', 'expression', 'detail', 'view', 'direction']) if (typeof s[k] === 'string' && s[k]) out[k] = s[k].slice(0, 300);
  if (s.mouth === true) out.mouth = true;
  return out;
}
function cleanOptions(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
  try { const t = JSON.stringify(o); return t.length <= 1000 ? JSON.parse(t) : {}; } catch { return {}; }
}
function cleanAttempt(a) {
  if (!a || !idOk(a.id)) return null;
  return { id: a.id, requestId: uuidOr(a.requestId), referenceId: uuidOr(a.referenceId), mode: ['generate', 'retry', 'edit'].includes(a.mode) ? a.mode : 'generate', note: str(a.note, 300), from: idOk(a.from) ? a.from : null, presetId: str(a.presetId, 40), seed: Number.isInteger(a.seed) ? a.seed : 0, error: str(a.error, 300), createdAt: str(a.createdAt, 40) };
}
function cleanSlot(s) {
  if (!s || !idOk(s.id)) return null;
  const attempts = (Array.isArray(s.attempts) ? s.attempts : []).map(cleanAttempt).filter(Boolean).slice(-MAX_ATTEMPTS);
  const has = id => attempts.some(a => a.id === id);
  return { id: s.id, label: str(s.label, 80) || s.id, spec: cleanSpec(s.spec), attempts, selected: has(s.selected) ? s.selected : null, accepted: has(s.accepted) ? s.accepted : null };
}
/** Normalise entity.sheets; returns null when there is nothing to store. */
export function normalizeSheets(value) {
  if (!Array.isArray(value)) return null;
  const sheets = value.filter(x => x && idOk(x.id)).slice(0, MAX_SHEETS).map(x => ({
    id: x.id, setId: str(x.setId, 40), label: str(x.label, 80), options: cleanOptions(x.options), presetId: str(x.presetId, 40), createdAt: str(x.createdAt, 40),
    slots: (Array.isArray(x.slots) ? x.slots : []).map(cleanSlot).filter(Boolean).slice(0, MAX_SHEET_SLOTS),
  }));
  return sheets.length ? sheets : null;
}
/** The attempt a slot puts on the sheet: the accepted one, else the selected/latest finished one. */
export function slotPick(s) {
  const done = s.attempts.filter(a => a.referenceId);
  return done.find(a => a.id === s.accepted) || done.find(a => a.id === s.selected) || done[done.length - 1] || null;
}
