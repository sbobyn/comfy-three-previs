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
export const CAMERA_LINES = {
  blockout: 'Follow the camera motion and framing of the blockout video exactly; it is the camera. Repaint it photoreal in the look of the still.',
  keyframes: 'Move from the start still’s framing to the end still’s framing; keep the camera smooth and consistent with both.',
  still: 'Hold the still’s framing; keep the camera move subtle and consistent with it.',
};
export const cameraLine = source => CAMERA_LINES[source] || CAMERA_LINES.still;

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
 * A prompt with exactly the camera line for `source`: any other camera line (or a legacy camera
 * sentence) is swapped for it; a prompt without one gets it appended.
 */
export function withCameraLine(text, source) {
  const line = cameraLine(source), known = [...Object.values(CAMERA_LINES).filter(x => x !== line), ...LEGACY];
  let out = String(text || '');
  for (const k of known) out = typeof k === 'string' ? out.split(k).join(line) : out.replace(k, line);
  // Keep the first copy only (a legacy prompt could hold two camera sentences).
  const first = out.indexOf(line);
  if (first >= 0) out = out.slice(0, first + line.length) + out.slice(first + line.length).split(line).join('').replace(/ {2,}/g, ' ');
  else out = [out.trim(), line].filter(Boolean).join(out.includes('\n') ? '\n' : ' ');
  return out.trim();
}
