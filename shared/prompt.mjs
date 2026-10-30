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

// Prompt hygiene. Every part ends in exactly one full stop, sentences repeated across parts appear
// once, and a video prompt stays near VIDEO_PROMPT_CAP characters (video models read the first few
// hundred characters closely and drift on long lists of set dressing).
export const VIDEO_PROMPT_CAP = 600;
const TRAIL = /[\s.,;:]+$/;
/** One clean sentence: collapsed spaces, no trailing ., ; or :, then a single full stop. */
export function sentence(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim().replace(TRAIL, '');
  return !t ? '' : /[!?…]$/.test(t) ? t : `${t}.`;
}
/** Sentences and ;-clauses of a text, without their end punctuation. */
const pieces = text => String(text || '').split(/(?<=[.!?])\s+|;\s*/).map(x => x.trim().replace(TRAIL, '')).filter(Boolean);
const pieceKey = x => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const cap1 = x => x.charAt(0).toUpperCase() + x.slice(1);

/**
 * Tagged segments for a shot. kind 'video' (motion, for LTX) or 'image' (a still, for FLUX).
 * Each segment: { key, label, source, color, text }.
 * Order: format → action → hero cast (most of the frame first) → one "Set:" sentence → look → camera → camera tags.
 * Cast named in the action (@handle) leads (people and vehicles before props, then in the order named);
 * the rest follow by frame coverage. A video prompt always keeps the action, the camera, the lead cast and
 * a second named cast member (shortened to their first sentence when needed), then adds the rest by priority
 * while it fits `cap`: format, look, set, more named cast, movement, lens, other cast, cuts, filter, set pieces.
 */
export function autoPromptSegments(project, shot, kind = 'video', { cap = kind === 'video' ? VIDEO_PROMPT_CAP : Infinity } = {}) {
  const { entities, environment } = project.scene;
  const items = []; // { order, priority, seg } or set pieces { order: 3, priority, piece, ids }
  const seen = new Set();
  const fresh = list => list.filter(x => { const k = pieceKey(x); if (!k || seen.has(k)) return false; seen.add(k); return true; });
  const mk = (key, label, source, color, text) => ({ key, label, source, color, text });
  const n = project.shots.indexOf(shot) + 1;
  items.push({ order: 0, priority: 3, seg: mk('intro', 'Format', 'Auto-prompt', FIELD_COLORS.action, kind === 'video' ? 'Cinematic live-action shot.' : 'Cinematic film still, single frame.') });
  const handle = e => e.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const named = [];
  const desc = (shot.description || '').replace(/@([a-z0-9-]+)/gi, (m, h) => { const e = entities.find(x => handle(x) === h.toLowerCase()); if (e) named.push(e.id); return e?.name || m; }).trim();
  const action = sentence(desc || shot.title);
  fresh(pieces(action));
  if (action) items.push({ order: 1, priority: 0, seg: mk('action', 'Action', `Shot ${String(n).padStart(2, '0')} description`, FIELD_COLORS.action, action) });
  // Objects with the same Cast Card text (e.g. four identical cruisers) share one segment and chip.
  const groups = castGroups(project, shot);
  const rank = g => Math.min(...g.cards.map(c => { const j = named.indexOf(c.id); return j < 0 ? Infinity : j; }));
  const prop = g => (g.cards[0].kind === 'prop' ? 1 : 0);
  const hero = groups.filter(x => x.cards[0].kind !== 'environment').map((g, i) => ({ g, i, r: rank(g) }))
    .sort((a, b) => (a.r === Infinity) - (b.r === Infinity) || prop(a.g) - prop(b.g) || a.r - b.r || a.i - b.i);
  let castRank = 0;
  for (const { g, r } of hero) {
    const names = g.cards.map(c => c.name), first = g.cards[0];
    const parts = fresh(pieces(g.text)).map(cap1), text = parts.join('. ');
    if (!text) continue;
    const seg = mk(`obj:${first.id}`, names.length === 1 ? first.name : `${first.name} +${names.length - 1}`, `${first.sharedFrom ? (entities.find(e => e.id === first.sharedFrom)?.name || first.name) : first.name}’s Cast Card${names.length > 1 ? ` (shared by ${names.join(', ')})` : ''}`, g.color, sentence(text));
    seg.ids = g.cards.map(c => c.id);
    const short = parts.length > 1 ? { ...seg, text: sentence(parts[0]) } : null;
    items.push({ order: 2, sub: castRank, priority: castRank === 0 || (castRank === 1 && r !== Infinity) ? 1 : r !== Infinity || castRank === 1 ? 5.5 + castRank / 100 : 8 + castRank, seg, short });
    castRank++;
  }
  // The world and the set pieces the camera sees become one "Set:" sentence; extra set pieces are the first to go.
  const world = fresh(pieces(environment?.description)).join('; ');
  if (world) items.push({ order: 3, priority: 5, piece: world, ids: [] });
  for (const g of groups.filter(x => x.cards[0].kind === 'environment')) for (const x of fresh(pieces(g.text))) items.push({ order: 3, priority: 30, piece: x, ids: g.cards.map(c => c.id) });
  const look = fresh(pieces(environment?.style)).join('. ');
  if (look) items.push({ order: 4, priority: 4, seg: mk('style', 'Visual style', 'Project style', FIELD_COLORS.style, sentence(`Look: ${look}`)) });
  if (kind === 'video') items.push({ order: 5, priority: 1, seg: mk('camera', 'Camera', 'Shot camera (blockout)', FIELD_COLORS.camera, `${sentence(`Camera: ${describeCamera(shot, entities)}`)} Follow the supplied camera motion exactly.`) });
  else items.push({ order: 5, priority: 1, seg: mk('camera', 'Framing', 'Shot camera (blockout)', FIELD_COLORS.camera, `Framing: ${shot.camera.mm}mm lens, match the supplied blockout frame's composition.`) });
  const st = shotStyle(shot), tagPriority = { movement: 6, lens: 7, cuts: 20, filter: 21 };
  Object.keys(CAMERA_TERMS).forEach((g, i) => {
    if (kind === 'image' && (g === 'movement' || g === 'cuts')) return; // a still has no motion or cuts
    if (st[g].length) items.push({ order: 6, sub: i, priority: tagPriority[g], seg: mk(`cam-${g}`, CAMERA_GROUPS[g], 'Camera style tags', FIELD_COLORS[g], sentence(`${CAMERA_GROUPS[g]}: ${st[g].join(', ')}`)) });
  });

  const render = chosen => {
    const ordered = [...chosen].sort((a, b) => a.order - b.order || (a.sub ?? 0) - (b.sub ?? 0));
    const out = [], set = ordered.filter(x => x.piece);
    for (const x of ordered) {
      if (x.seg) out.push(x.seg);
      else if (x === set[0]) {
        const seg = mk('world', 'World', 'Scene world', FIELD_COLORS.world, sentence(`Set: ${set.map(y => y.piece).join('; ')}`));
        const ids = [...new Set(set.flatMap(y => y.ids))]; if (ids.length) seg.ids = ids;
        out.push(seg);
      }
    }
    return out;
  };
  const length = segs => segs.reduce((a, s) => a + s.text.length + 1, -1);
  const byPriority = [...items].sort((a, b) => a.priority - b.priority);
  // Required parts first; over the cap, named cast after the lead shrink to their first sentence, then the lead.
  const chosen = byPriority.filter(x => x.priority <= 1);
  const castReq = chosen.filter(x => x.short).sort((a, b) => b.sub - a.sub);
  for (const x of castReq) { if (length(render(chosen)) <= cap) break; chosen[chosen.indexOf(x)] = { ...x, seg: x.short }; }
  for (const x of byPriority.filter(y => y.priority > 1)) {
    if (length(render([...chosen, x])) <= cap) chosen.push(x);
    else if (x.short && length(render([...chosen, { ...x, seg: x.short }])) <= cap) chosen.push({ ...x, seg: x.short });
  }
  return render(chosen);
}
/** Cast objects grouped by identical Cast Card text, each group with its colour (max 8 groups). */
export function castGroups(project, shot) {
  const groups = [];
  for (const c of shotObjects(project, shot)) {
    const card = castCard(project, c.entity.id);
    const text = [card.description, card.styleNotes].map(x => String(x || '').trim().replace(TRAIL, '')).filter(Boolean).join('; ');
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
