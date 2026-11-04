// Copyright (c) 2026 Steven Bobyn. SPDX-License-Identifier: MIT
// The request for a look variant's still (shared/look-presets.mjs): an edit of the base shot's still at the same moment, with
// the cast's images and, for an art style that asks for one, a style reference. Shared by the batch still driver and the MCP
// still tool, so both send the same images and words.
import { baseShotOf, effectiveLook, lookDiff, variantEditPrompt, variantModels, presetOf, normalizeLook, variantLooks, variantShotInput } from './look-presets.mjs';
import { makeShot } from './director.mjs';
import { stillReferences } from './still-match.mjs';
import { shotPrompt } from './prompt.mjs';
import { lookMedium, lookText } from './camera-source.mjs';

const NOTES = { start: ['key frame start', ''], end: ['key frame end'] };
const noteOf = at => NOTES[at] || [`key frame @${at}s`];
/** The base shot's still at a moment ('start', 'end' or seconds), or null. */
export function baseStill(project, shot, at = 'start') {
  const base = baseShotOf(project, shot); if (!base) return null;
  return base.references.filter(r => r.role === 'frame' && noteOf(at).includes(r.note || '')).at(-1) || null;
}
/**
 * A still to use as the style reference for an art style: the newest still of another shot whose image prompt names the same
 * medium (Look Lab's claymation shots, or an earlier claymation variant). Never the base still or the shot's own.
 */
export function styleReference(project, shot, styleId) {
  const want = lookMedium(lookText(`${presetOf('style', styleId)?.intro?.[1] || ''} Look: ${presetOf('style', styleId)?.look || ''}`));
  if (!want) return null;
  const base = baseShotOf(project, shot);
  const shots = project.shots.filter(s => s.id !== shot.id && s.id !== base?.id && lookMedium(lookText(shotPrompt(project, s, 'image'))) === want);
  return shots.flatMap(s => s.references.filter(r => r.role === 'frame' && r.generated)).sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''))).at(-1) || null;
}

/**
 * Everything a variant still request needs: { guideReferenceId (the base still, image 1), referenceIds (cast images, then the
 * style reference), prompt, model (suggested), styleRef (id or null), change ([{ axis, from, to }]) }. `cap` is the model's
 * image limit (the base still counts as one). Throws when the base has no still at that moment.
 */
export function variantStillRequest(project, shot, { at = 'start', t = 0, cap = 9 } = {}) {
  const base = baseShotOf(project, shot); if (!base) throw Error('This shot is not a variant');
  const guide = baseStill(project, shot, at);
  if (!guide) throw Error(`Make the base shot's ${typeof at === 'number' ? `@${at}s` : at} still first: a variant is an edit of it`);
  const look = effectiveLook(project, shot), change = lookDiff(effectiveLook(project, base), look), models = variantModels(project, shot, look);
  // Cast images (objects in frame), without those whose subject this variant swaps: their old image would undo the swap.
  const swapped = new Set(change.filter(d => d.axis === 'subject').map(d => d.entityId));
  const room = Math.max(0, cap - 1);
  const looks = stillReferences(project, shot, t, room + 1).looks.filter(r => !swapped.has(r.entityId));
  const style = models.styleRef ? styleReference(project, shot, look.style) : null;
  const castRoom = Math.max(0, room - (style ? 1 : 0)), cast = looks.slice(0, castRoom);
  const referenceIds = [...cast.map(r => r.ref.id), ...(style && room > 0 ? [style.id] : [])];
  const prompt = variantEditPrompt(project, shot, base, { refs: cast.map(r => r.label), styleRef: style && room > 0 ? cast.length + 2 : null });
  return { guideReferenceId: guide.id, referenceIds, prompt, model: models.still, styleRef: style && room > 0 ? style.id : null, change };
}

/**
 * Add variant shots of a base shot to `project` (mutates it), as the `add_variants` edit op and a batch's dry run do.
 * `looks` (explicit) or `axes` (+ `combine`, only when asked for) — see variantLooks. A variant whose look matches an existing
 * variant of the base is reused. New shots go after the base and its earlier variants. Returns { base, ids, existing, looks }.
 */
export function addVariantShots(project, baseId, { axes, combine = false, looks } = {}, newId) {
  let base = project.shots.find(s => s.id === baseId); if (!base) throw Error('Unknown shot');
  if (base.variantOf) base = project.shots.find(s => s.id === base.variantOf) || base;
  const wanted = looks ? looks.map(normalizeLook) : variantLooks(effectiveLook(project, base), axes || {}, { combine: combine === true });
  if (!wanted.length) throw Error('No variant differs from the base: choose at least one preset that is not the base’s');
  const ids = [], existing = [];
  for (const look of wanted) {
    const same = project.shots.find(x => x.variantOf === base.id && !lookDiff(effectiveLook(project, x), look).length);
    if (same) { existing.push(same.id); continue; }
    if (project.shots.length >= 50) throw Error('A scene supports at most 50 shots');
    const input = variantShotInput(project, base, look), id = newId();
    const shot = makeShot(input, id, project.shots.length + 1, project.scene.entities);
    for (const k of ['style', 'promptSections', 'motionCritical']) if (input[k] !== undefined) shot[k] = input[k];
    Object.assign(shot, { variantOf: base.id, look });
    let at = project.shots.indexOf(base) + 1; while (project.shots[at]?.variantOf === base.id) at++;
    project.shots.splice(at, 0, shot); ids.push(id);
  }
  return { base, ids, existing, looks: wanted };
}
