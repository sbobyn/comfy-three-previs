// Copyright (c) 2026 Steven Bobyn. SPDX-License-Identifier: MIT
// Where a video's camera motion comes from. The blockout clip is the source of truth for camera motion:
// a video prompt never describes the move, it only tells the model which input to follow.
//   'blockout'  – the model takes the blockout clip itself (a source, control or reference video).
//   'keyframes' – the model animates between start and end stills made from the blockout's first and last
//                 frames; it only approximates the move between them.
//   'still'     – the model animates one still; the camera move is the model's guess.
export const CAMERA_SOURCES = ['blockout', 'keyframes', 'still'];

// Semantic workflow inputs that carry a video the model follows (presets declare one of these).
const MOTION_INPUT = /^(sourceVideo|controlVideo|referenceVideo\d*)$/;
/** Name of the definition's video input that the blockout clip binds to, or null. */
export function motionInput(definition) {
  return Object.keys(definition?.inputs || {}).find(name => MOTION_INPUT.test(name)) || null;
}

/**
 * Camera source of a video definition, from its declared inputs. With `assetBindings` (a saved
 * binding), only bound inputs count: a start → end model bound without its end still is 'still'.
 */
export function cameraSourceOf(definition, assetBindings = null) {
  const inputs = definition?.inputs || {}, has = name => !!inputs[name] && (!assetBindings || !!assetBindings[name]);
  const motion = motionInput(definition);
  if (motion && has(motion)) return 'blockout';
  if (has('firstFrame') && has('lastFrame')) return 'keyframes';
  return 'still';
}

// The one prompt sentence about the camera. It names the input to follow and never describes the move.
const BLOCKOUT_HEAD = 'Follow the camera motion and framing of the blockout video exactly; it is the camera.';
export const CAMERA_LINES = {
  blockout: `${BLOCKOUT_HEAD} Repaint it photoreal in the look of the still.`,
  keyframes: 'Move from the start still’s framing to the end still’s framing; keep the camera smooth and consistent with both.',
  still: 'Hold the still’s framing; keep the camera move subtle and consistent with it.',
};
/**
 * The camera line for `source`. A blockout line repaints the clip photoreal unless the shot's look names another medium
 * (`medium`, from lookMedium): then it repaints it in that medium and never says photoreal. It stays as short as the
 * photoreal line (a video prompt's length cap is budgeted with it).
 */
export const cameraLine = (source, medium = '') => (source === 'blockout' && medium
  ? `${BLOCKOUT_HEAD} Repaint it as ${medium} in the look of the still.`
  : CAMERA_LINES[source] || CAMERA_LINES.still);
// Every blockout line, photoreal or in any medium.
const BLOCKOUT_ANY = /Follow the camera motion and framing of the blockout video exactly; it is the camera\. Repaint it (?:photoreal|as [^.;\n]{1,80}) in the look of the still\./g;

// The look's medium. Photoreal is the default; a format or look that names another medium (anime, claymation …) gets
// that medium's phrase, which the blockout camera line and the still's edit rules use instead of "photoreal".
// First match wins, so "hand-drawn anime with cel shading" reads as anime.
const MEDIA = [
  [/\banime\b|\bmanga\b/i, 'anime'],
  [/\bclaymation\b|\bplasticine\b|\bstop[- ]motion\b|\bclay animation\b/i, 'stop-motion claymation'],
  [/\bwatercolou?rs?\b/i, 'a watercolour painting'],
  [/\b(?:3d|cg|cgi|computer)[- ]animat|\banimated feature\b/i, 'stylised 3D animation'],
  [/\boil[- ]paint/i, 'an oil painting'],
  [/\bpixel[- ]art\b/i, 'pixel art'],
  [/\bcomic[- ]book\b|\bgraphic novel\b/i, 'comic-book art'],
  [/\bcartoon\b|\b2d animat|\bcel[- ]shad/i, '2D cartoon animation'],
  [/\b(?:pencil|charcoal) (?:sketch|drawing)/i, 'a pencil drawing'],
];
/** The non-photoreal medium a look text names, or '' (photoreal, the default). */
export function lookMedium(text) {
  const t = stripCameraLines(text);
  return MEDIA.find(([re]) => re.test(t))?.[1] || '';
}
/**
 * The parts of a free-text prompt that set its look: the first sentence (its format, "Anime shot.") and every sentence
 * that starts "Look:", "Visual style:" or "Style:". The action and cast text are left out, so "watches anime on TV" does not
 * restyle a shot.
 */
export function lookText(text) {
  const s = stripCameraLines(text).split(/(?<=[.!?])\s+|\n+/).map(x => x.trim()).filter(Boolean);
  return [s[0], ...s.slice(1).filter(x => /^(?:look|visual style|style)\s*:/i.test(x))].filter(Boolean).join(' ');
}
/** A text without any camera line (in any medium) or legacy camera sentence. */
export function stripCameraLines(text) {
  let t = String(text || '').replace(BLOCKOUT_ANY, ' ');
  for (const line of Object.values(CAMERA_LINES)) t = t.split(line).join(' ');
  for (const k of LEGACY) t = t.replace(k, ' ');
  return t.replace(/[ \t]{2,}/g, ' ').trim();
}
/** The camera line a text already carries for `source` (in any medium), or null. */
export const cameraLineIn = (text, source) => (source === 'blockout' ? String(text || '').match(BLOCKOUT_ANY)?.[0] || null : String(text || '').includes(cameraLine(source)) ? cameraLine(source) : null);

// Short labels for the model card, batch plan and version chips.
export const CAMERA_SOURCE_LABELS = { blockout: 'Camera: from blockout', keyframes: 'Camera: from start → end stills (approximate)', still: 'Camera: from still (approximate)' };
export const CAMERA_SOURCE_GLYPHS = { blockout: '▶', keyframes: '⇥', still: '◻' };

// Camera sentences older prompts carried; an edited prompt that still holds one gets the current line instead.
const LEGACY = [
  /Camera: [^\n]*?\d+s\. Follow the supplied camera motion exactly\./g,
  /Preserve the supplied camera motion, framing and blocking\./g,
  /Start from the supplied frame and keep its composition, characters and look\./g,
];
/**
 * A prompt with exactly the camera line for `source`: any other camera line (or a legacy camera sentence) is swapped for
 * it; a prompt without one gets it appended. `medium` is the look's medium (default: what the text's look parts name).
 */
export function withCameraLine(text, source, medium = lookMedium(lookText(text))) {
  const line = cameraLine(source, medium), known = [...Object.values(CAMERA_LINES).filter(x => x !== line), BLOCKOUT_ANY, ...LEGACY];
  let out = String(text || '');
  for (const k of known) out = typeof k === 'string' ? out.split(k).join(line) : out.replace(k, () => line);
  // Keep the first copy only (a legacy prompt could hold two camera sentences).
  const first = out.indexOf(line);
  if (first >= 0) out = out.slice(0, first + line.length) + out.slice(first + line.length).split(line).join('').replace(/ {2,}/g, ' ');
  else out = [out.trim(), line].filter(Boolean).join(out.includes('\n') ? '\n' : ' ');
  return out.trim();
}

/**
 * A prompt cut to `max` characters that keeps its camera line and reference legend ("Reference images: …"):
 * the description is shortened instead, so the model always knows which input is the camera.
 */
export function fitPrompt(text, max, source) {
  const t = String(text || '');
  if (!Number.isInteger(max) || t.length <= max) return t;
  const line = cameraLineIn(t, source) || cameraLine(source, lookMedium(lookText(t))), lines = t.split('\n');
  const legend = lines.filter(l => /^Reference images: /.test(l)).join('\n');
  const body = lines.filter(l => !/^Reference images: /.test(l)).join('\n').split(line).join('').replace(/ {2,}/g, ' ').trim();
  const tail = [line, legend].filter(Boolean).join('\n'), room = max - tail.length - 1;
  if (room < 1) return t.slice(0, max);
  const cut = body.length > room ? body.slice(0, room).replace(/\s+\S*$/, '') : body;
  return `${cut} ${line}${legend ? `\n${legend}` : ''}`.slice(0, max);
}

// Phrases that direct the camera itself. Object motion ("the actor turns", "the car pans across") is not listed: only
// words a model reads as a camera instruction. The blockout (or the stills made from it) is the camera, so a video
// prompt carries none of these; free text that does contradicts the camera line.
const CAMERA_MOTION = [
  /\bdolly(?:ing)?(?:[- ](?:in|out|left|right|zoom|alongside))?\b/gi, /\bwhip[- ]pans?\b/gi, /\b(?:slow |fast )?pan(?:s|ning|ned)? (?:left|right|across|up|down|over|to)\b/gi,
  /\btilt(?:s|ing|ed)? (?:up|down)\b/gi, /\bcrane(?:s|d)? (?:up|down|shot|over)\b/gi, /\b(?:crash |dolly )?zoom(?:s|ing|ed)? (?:in|out)\b/gi, /\bcrash zoom\b/gi,
  /\btruck(?:s|ing)? (?:left|right)\b/gi, /\borbit(?:s|ing)? (?:left|right|around the subject)\b/gi, /\b(?:slow |fast )?push(?:es)?[- ]in\b/gi, /\bpull(?:s)?[- ](?:out|back)\b/gi,
  /\btracking shot\b/gi, /\bsteadicam\b/gi, /\bhandheld\b/gi, /\bdrone (?:shot|flyover|chase)\b/gi, /\bfpv\b/gi,
  /\bcamera (?:moves|pushes|pulls|rises|drops|swoops|follows|circles|pans|tilts|tracks|cranes|zooms|dollies|orbits|flies)\b/gi,
];
/**
 * Camera-motion phrases in a video prompt, outside its camera line (distinct, as written). Empty when the text leaves the
 * camera to its source. Surfaced to the user and the agent; the text is never rewritten.
 */
export function cameraMotionWords(text) {
  const t = stripCameraLines(text);
  // Longest phrase wins where two overlap ("whip pan to" is one instruction, not two).
  const hits = CAMERA_MOTION.flatMap(re => [...t.matchAll(re)].map(m => ({ at: m.index, end: m.index + m[0].length, text: m[0] })))
    .sort((a, b) => a.at - b.at || b.end - a.end);
  const kept = [], found = new Map();
  for (const h of hits) if (!kept.some(k => h.at < k.end && k.at < h.end)) kept.push(h);
  for (const h of kept) { const k = h.text.toLowerCase(); if (!found.has(k)) found.set(k, h.text); }
  return [...found.values()];
}
/** One sentence for a prompt with camera-motion words, or '' when it has none. */
export function cameraMotionWarning(text, source = 'blockout') {
  const words = cameraMotionWords(text);
  if (!words.length) return '';
  const from = source === 'blockout' ? 'the blockout clip' : source === 'keyframes' ? 'the start and end stills' : 'the start still';
  return `The prompt directs the camera (${words.map(w => `“${w}”`).join(', ')}), but the camera comes from ${from}. Remove those words, or change the camera in the shot.`;
}

/**
 * Camera-source annotation for an accepted masked edit: keep the parent's recorded grade when known.
 * Crop/mask support media are not a new blockout camera; unknown parent provenance stays unknown.
 */
export function cameraSourceForMaskedEdit(parentAsset) {
  const known = parentAsset?.source?.cameraSource;
  return CAMERA_SOURCES.includes(known) ? known : null;
}
