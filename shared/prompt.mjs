// Copyright (c) 2026 Steven Bobyn. SPDX-License-Identifier: MIT
// Auto-prompt: a shot's prompt composed from its cast's Cast Cards, the world, the action and the
// camera. It is assembled text (not a model's judgement), returned as tagged segments so the UI can
// colour each part and show where it came from. Image and video prompts share everything except the
// camera/motion part.
import { shotObjects, castCard, describeCamera, MOVES } from './director.mjs';

// Camera vocabulary for style tags. Each term is the exact text added to the prompt.
export const CAMERA_TERMS = {
  movement: ['FPV drone chase', 'dolly zoom', 'crane up into an orbit', 'static locked-off shot', 'slow push-in', 'slow pull-out', 'tracking shot', 'dolly alongside', 'crane up', 'crane down', 'orbit around the subject', 'handheld', 'steadicam follow', 'drone flyover', 'whip pan', 'slow pan', 'tilt up'],
  cuts: ['speed ramp', 'hard cut', 'match cut', 'smash cut', 'jump cut', 'cross-dissolve', 'continuous take, no cuts'],
  lens: ['long lens compression', '14mm ultra-wide', '24mm wide', '35mm natural', '50mm normal', '85mm portrait', '135mm telephoto', 'anamorphic', 'macro', 'shallow depth of field', 'deep focus', 'rack focus'],
  filter: ['VHS tracking lines', 'chroma smear', 'Eastmancolor', 'deep blue dusk', 'saturated primaries', '35mm film grain', 'teal and orange grade', 'black and white', 'golden hour light', 'neon noir', 'bleach bypass', 'soft diffusion (ProMist)', 'anamorphic lens flare', 'high contrast', 'muted pastel palette'],
};
export const CAMERA_GROUPS = { movement: 'Movement', cuts: 'Cuts', lens: 'Lens', filter: 'Filter' };
// Starting suggestions from the shot's own camera, so the tags begin true to the blockout.
const MOVE_TERM = { static: 'static locked-off shot', 'dolly-in': 'slow push-in', 'dolly-out': 'slow pull-out', 'truck-left': 'tracking shot', 'truck-right': 'tracking shot', 'pan-left': 'slow pan', 'pan-right': 'slow pan', 'orbit-left': 'orbit around the subject', 'orbit-right': 'orbit around the subject', 'crane-up': 'crane up', 'crane-down': 'crane down', 'tilt-up': 'tilt up', custom: 'tracking shot' };
const lensTerm = mm => (mm <= 18 ? '14mm ultra-wide' : mm <= 28 ? '24mm wide' : mm <= 42 ? '35mm natural' : mm <= 65 ? '50mm normal' : mm <= 110 ? '85mm portrait' : '135mm telephoto');
export function suggestedStyle(shot) {
  return { movement: [MOVE_TERM[shot.camera.move] || 'tracking shot'], cuts: [], lens: [lensTerm(shot.camera.mm)], filter: [] };
}
export function normalizeStyle(s) {
  const out = {};
  for (const k of Object.keys(CAMERA_TERMS)) out[k] = [...new Set((Array.isArray(s?.[k]) ? s[k] : []).map(String).map(x => x.slice(0, 80)))].slice(0, 6);
  return out;
}
/** The shot's style tags: chosen ones, else suggestions from its camera. */
export function shotStyle(shot) {
  return shot.style ? normalizeStyle(shot.style) : suggestedStyle(shot);
}

// Colours: fixed per field, a rotating set per object. Labels always travel with colours.
// One colour per kind of object, everywhere: scene panel, viewport labels/outline, cast rows, prompt text.
export const KIND_COLORS = { character: '#B4235A', vehicle: '#2563C9', prop: '#B7791F', environment: '#2E7D5B' };
export const FIELD_COLORS = { action: '#15130F', world: '#2E7D5B', style: '#8A4CB8', camera: '#C8401F', movement: '#B5651D', cuts: '#A33E6E', lens: '#2F6DB5', filter: '#6D5BC2' };
const OBJECT_COLORS = ['#3B5BA9', '#B33A5E', '#1F7F8A', '#9A6A0C', '#4E8A2B', '#C2611E', '#7A4FC9', '#2F7A4E'];

/**
 * Tagged segments for a shot. kind 'video' (motion, for LTX) or 'image' (a still, for FLUX).
 * Each segment: { key, label, source, color, text }.
 */
export function autoPromptSegments(project, shot, kind = 'video') {
  const { entities, environment } = project.scene;
  const seg = [];
  const add = (key, label, source, color, text) => { const t = String(text || '').trim(); if (t) seg.push({ key, label, source, color, text: t }); };
  const n = project.shots.indexOf(shot) + 1;
  add('intro', kind === 'video' ? 'Format' : 'Format', 'Auto-prompt', FIELD_COLORS.action, kind === 'video' ? 'Cinematic live-action shot.' : 'Cinematic film still, single frame.');
  const desc = (shot.description || '').replace(/@([a-z0-9-]+)/gi, (m, h) => entities.find(e => e.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') === h.toLowerCase())?.name || m).trim();
  add('action', 'Action', `Shot ${String(n).padStart(2, '0')} description`, FIELD_COLORS.action, desc ? (/[.!?]$/.test(desc) ? desc : desc + '.') : `${shot.title}.`);
  // Objects with the same Cast Card text (e.g. four identical cruisers) share one segment and chip.
  castGroups(project, shot).forEach((g, i) => {
    const names = g.cards.map(c => c.name), first = g.cards[0];
    const label = names.length === 1 ? first.name : `${first.name} +${names.length - 1}`;
    // The sentence is the description itself; the object name lives on the chip.
    const sentence = g.text.charAt(0).toUpperCase() + g.text.slice(1);
    add(`obj:${first.id}`, label, `${first.sharedFrom ? (project.scene.entities.find(e => e.id === first.sharedFrom)?.name || first.name) : first.name}’s Cast Card${names.length > 1 ? ` (shared by ${names.join(', ')})` : ''}`, g.color, /[.!?]$/.test(sentence) ? sentence : sentence + '.');
    seg.at(-1).ids = g.cards.map(c => c.id);
  });
  if (environment?.description) add('world', 'World', 'Scene world', FIELD_COLORS.world, `Setting: ${environment.description}.`);
  if (environment?.style) add('style', 'Visual style', 'Project style', FIELD_COLORS.style, `Look: ${environment.style}.`);
  if (kind === 'video') add('camera', 'Camera', 'Shot camera (blockout)', FIELD_COLORS.camera, `Camera: ${describeCamera(shot, entities)}. Follow the supplied camera motion exactly.`);
  else add('camera', 'Framing', 'Shot camera (blockout)', FIELD_COLORS.camera, `Framing: ${shot.camera.mm}mm lens, match the supplied blockout frame's composition.`);
  const st = shotStyle(shot);
  for (const g of Object.keys(CAMERA_TERMS)) {
    if (kind === 'image' && (g === 'movement' || g === 'cuts')) continue; // a still has no motion or cuts
    if (st[g].length) add(`cam-${g}`, CAMERA_GROUPS[g], 'Camera style tags', FIELD_COLORS[g], `${CAMERA_GROUPS[g]}: ${st[g].join(', ')}.`);
  }
  return seg;
}
/** Cast objects grouped by identical Cast Card text, each group with its colour (max 8 groups). */
export function castGroups(project, shot) {
  const groups = [];
  for (const c of shotObjects(project, shot)) {
    const card = castCard(project, c.entity.id);
    const text = [card.description, card.styleNotes].filter(Boolean).join(', ');
    if (!text) continue; // structural blockout pieces with an empty Cast Card add nothing to the prompt
    const g = groups.find(x => x.text === text);
    if (g) g.cards.push(card); else groups.push({ text, cards: [card] });
  }
  return groups.slice(0, 8).map(g => ({ ...g, color: KIND_COLORS[g.cards[0].kind] || OBJECT_COLORS[0] }));
}
/** Object id → its colour in this shot's prompt (chips, highlighted text, viewport outline). */
export function objectColors(project, shot) {
  return new Map(project.scene.entities.map(e => [e.id, KIND_COLORS[e.kind] || OBJECT_COLORS[0]]));
}
export const autoPromptText = (project, shot, kind = 'video') => autoPromptSegments(project, shot, kind).map(s => s.text).join(' ');

/** The prompt actually used: the user's edit if there is one, else the auto-prompt. */
export function shotPrompt(project, shot, kind = 'video') {
  const saved = shot.prompts?.[kind];
  return saved?.edited && saved.text ? saved.text : autoPromptText(project, shot, kind);
}
/** Character ranges of each segment found in a (possibly edited) text, for colouring. */
export function highlightRanges(text, segments) {
  const out = []; let from = 0;
  for (const s of segments) {
    let i = text.indexOf(s.text, from); if (i < 0) i = text.indexOf(s.text);
    if (i >= 0 && !out.some(r => i < r.end && i + s.text.length > r.start)) { out.push({ start: i, end: i + s.text.length, seg: s }); from = i + s.text.length; }
  }
  return out.sort((a, b) => a.start - b.start);
}
export function normalizePrompts(p) {
  const one = v => (v && typeof v.text === 'string' && v.edited ? { text: v.text.slice(0, 4000), edited: true, basedOn: String(v.basedOn || '').slice(0, 4000), editedAt: v.editedAt || new Date().toISOString() } : null);
  const out = {}; for (const k of ['video', 'image']) { const v = one(p?.[k]); if (v) out[k] = v; }
  return out;
}
export { MOVES };
