// Copyright (c) 2026 Steven Bobyn. SPDX-License-Identifier: MIT
// Look presets (docs/look-presets.md): the scene, setting and lighting of a shot chosen as structured parameters before a
// still or video is made — time of day, weather, season, lighting mood, wardrobe and art style, plus a per-object subject
// swap. The project keeps a default look; a shot keeps its own on top. Presets compose into the shot's prompt sections
// (shared/prompt.mjs presetSections) under anything you typed, so they share the auto-prompt's length budget, the camera
// line's repaint medium and the regeneration keys (shared/regen.mjs adds one `preset:<axis>` part per set axis).
//
// A variant is a copy of a base shot (same camera, timing and blocking) whose look differs on ONE axis by default
// ("Night (vs base)"). Its still is an edit of the base still — image 1 is the base still, then the cast's images — told to
// change only that attribute and keep everything else identical (variantEditPrompt), on an edit-capable model. Phrasings
// come from the Look Lab v2 run (.evidence, 2026-11-03): anime held only on Nano Banana 2.1 with no style reference;
// claymation held on Nano Banana 2.1 with a clay still as a style reference; Kling O1 edit rushes a walking character
// ahead of the blockout, Seedance 2.5 edit keeps the pace.

/** The explicit negative every preset look carries (cars included: GPT Image 2.5 added grille emblems in v2). */
export const NO_BRANDS_NEGATIVE = 'No logos, badges, car emblems or readable text.';
/** The negative's shortest form, for the 'minimal' fit of a shot whose required text leaves little room. */
export const NO_BRANDS_SHORT = 'No logos, car emblems or text.';
/** Edit-capable still model for variants (keeps identity in an edit of the base still; cheapest of the edit models). */
export const VARIANT_STILL_MODEL = 'nano-banana-2-1';
export const VARIANT_VIDEO_MODELS = { timing: 'seedance-25-edit-v1', cheap: 'kling-o1-edit-v1' };
export const MAX_VARIANTS = 12;

// world: words after "the same scene" (time, weather, season); look: light and colour words; edit: the instruction for an edit
// of the base still. Labels are what the UI and agent show ("Night (vs base)").
export const LOOK_AXES = [
  { id: 'time', label: 'Time of day', edit: 'the time of day', presets: [
    { id: 'dawn', label: 'Dawn', world: 'at dawn, first pink light, lamps still on', look: 'soft pink and blue dawn light, long faint shadows', edit: 'make it dawn: first pink and blue light, long faint shadows, lamps still on' },
    { id: 'golden-hour', label: 'Golden hour', world: 'at golden hour, a low warm sun', look: 'warm amber light, long shadows', edit: 'make it golden hour: a low warm sun, amber light, long shadows' },
    { id: 'noon', label: 'Harsh noon', world: 'at noon, the sun straight overhead', look: 'harsh overhead sun, short hard shadows', edit: 'make it noon: harsh overhead sun, short hard shadows' },
    { id: 'blue-hour', label: 'Blue hour', world: 'at blue hour after sunset, lamps and windows just lit', look: 'deep blue twilight, warm lamp glow', edit: 'make it blue hour after sunset: deep blue sky, lamps and windows just lit' },
    { id: 'night', label: 'Night', world: 'at night, lamplight on the ground, lit windows', look: 'night, warm lamplight, cool moonlight', edit: 'make it night: dark sky, warm lamplight on the ground, lit windows, cool moonlight' },
  ] },
  { id: 'weather', label: 'Weather', edit: 'the weather', presets: [
    { id: 'fog', label: 'Fog', world: 'in thick fog, the distance lost in grey', look: 'dense soft fog, muted grey palette', edit: 'add thick fog: the distance lost in grey, muted colour' },
    { id: 'rain', label: 'Heavy rain', world: 'in heavy rain, puddles, wet glossy surfaces', look: 'storm light, falling rain, wet reflections', edit: 'make it heavy rain: falling rain, puddles, wet glossy ground with reflections' },
    { id: 'snowstorm', label: 'Snowstorm', world: 'in a heavy snowstorm, snow piling on every surface', look: 'driving snow, white-grey haze, cold light', edit: 'make it a heavy snowstorm: driving snow, snow piling on the ground, roofs and the car' },
    { id: 'overcast', label: 'Overcast', world: 'on a flat overcast day', look: 'flat soft grey light, no hard shadows', edit: 'make it a flat overcast day: soft grey light, no hard shadows' },
  ] },
  { id: 'season', label: 'Season', edit: 'the season', presets: [
    { id: 'spring', label: 'Cherry-blossom spring', world: 'in spring, trees in full pink blossom, petals on the ground', look: 'soft spring light, pastel colour', edit: 'make it spring: the trees in full pink blossom, petals on the ground' },
    { id: 'summer', label: 'Summer', world: 'in high summer, trees in full green leaf', look: 'warm summer light', edit: 'make it high summer: the trees in full green leaf' },
    { id: 'autumn', label: 'Peak autumn', world: 'at peak autumn, trees blazing red and gold, fallen leaves', look: 'crisp autumn light, rich warm colour', edit: 'make it peak autumn: the trees red and gold, fallen leaves on the ground' },
    { id: 'winter', label: 'Winter', world: 'in winter, snow on the ground and roofs, bare trees', look: 'cold soft winter light', edit: 'make it winter: snow on the ground, roofs and the car, bare trees' },
  ] },
  { id: 'mood', label: 'Lighting mood', edit: 'the lighting', presets: [
    { id: 'soft', label: 'Soft', look: 'soft diffused light, gentle contrast', edit: 'make the light soft and diffused with gentle contrast' },
    { id: 'high-key', label: 'High key', look: 'bright high-key light, low contrast', edit: 'make the lighting bright and high-key with low contrast' },
    { id: 'low-key', label: 'Low key', look: 'low-key light, deep shadows, hard contrast', edit: 'make the lighting low-key: deep shadows, hard contrast' },
    { id: 'warm', label: 'Warm', look: 'warm tungsten tones', edit: 'warm the colour of the light to tungsten tones' },
    { id: 'cool', label: 'Cool', look: 'cool blue tones', edit: 'cool the colour of the light to blue tones' },
  ] },
  { id: 'wardrobe', label: 'Wardrobe or era', edit: 'the clothes', presets: [
    { id: '1950s', short: '1950s clothes', label: '1950s', wear: '1950s clothes: a fitted jacket, high-waisted trousers, two-tone shoes' },
    { id: 'cyberpunk', short: 'cyberpunk clothes', label: 'Cyberpunk', wear: 'cyberpunk clothes: a black tech jacket with glowing piping, cargo trousers, platform boots' },
    { id: 'workwear', short: 'plain workwear', label: 'Workwear', wear: 'a plain navy work uniform, a high-visibility vest and steel-toe boots, no patches or insignia' },
    { id: 'formal-evening', short: 'formal evening wear', label: 'Formal evening', wear: 'formal evening wear: dark satin and tailoring, polished shoes' },
    { id: 'raincoat', short: 'a yellow raincoat', label: 'Raincoat', wear: 'a bright yellow hooded raincoat and rubber boots' },
    { id: 'winter-coat', short: 'a winter coat', label: 'Winter coat', wear: 'a puffer coat, knitted hat, scarf and gloves' },
  ] },
  { id: 'style', label: 'Art style', edit: 'the medium', presets: [
    { id: 'photoreal', label: 'Photoreal', look: 'photoreal', edit: 'make it a photoreal film frame' },
    // Anime: Nano Banana 2.1 with no style reference (a reference pulled every model back to semi-photoreal).
    { id: 'anime', label: 'Anime', intro: ['2D cel anime shot.', '2D cel anime key frame, hand-drawn, single frame.'], look: '2D hand-drawn TV anime: bold clean ink outlines, flat two-tone cel shading, painted sky, no photo texture', edit: 'redraw the whole frame as 2D hand-drawn anime: bold clean ink outlines, flat two-tone cel shading, painted sky, no photographic texture', model: { still: 'nano-banana-2-1', styleRef: false } },
    // Claymation: Nano Banana 2.1 with a clay still as a style reference.
    { id: 'claymation', label: 'Claymation', intro: ['Stop-motion claymation shot.', 'Stop-motion claymation frame, single frame.'], look: 'all plasticine: chunky clay forms, tabletop set, soft studio light', edit: 'remake the whole frame in plasticine as a stop-motion claymation set: chunky clay forms, a tabletop miniature, soft studio light', model: { still: 'nano-banana-2-1', styleRef: true } },
    { id: '3d-animated', label: '3D animated', intro: ['Stylised 3D animated feature shot.', 'Stylised 3D animated feature film still, single frame.'], look: 'stylised 3D animated feature, soft rounded shapes, warm bounce light', edit: 'redraw the whole frame as a stylised 3D animated feature: soft rounded shapes, warm bounce light', model: { still: 'nano-banana-2-1', styleRef: false } },
    { id: 'watercolour', label: 'Watercolour', intro: ['Animated watercolour painting.', 'Watercolour painting, single frame.'], look: 'loose watercolour, soft bleeding washes, paper texture', edit: 'repaint the whole frame as a loose watercolour: soft bleeding washes, paper texture', model: { still: 'nano-banana-2-1', styleRef: false } },
  ] },
];
const AXIS = Object.fromEntries(LOOK_AXES.map(a => [a.id, a]));
export const AXIS_IDS = LOOK_AXES.map(a => a.id);
/** The preset with this id on an axis, or null. */
export const presetOf = (axis, id) => AXIS[axis]?.presets.find(p => p.id === id) || null;
const SUBJECT_MAX = 160;
const clean = t => String(t ?? '').replace(/\s+/g, ' ').trim();
const trail = t => clean(t).replace(/[\s.,;:]+$/, '');

/**
 * A stored look: { time?, weather?, season?, mood?, wardrobe?, style?: preset id | 'none', subjects?: { entityId: text } }.
 * 'none' on a shot clears the project default for that axis. Unknown ids and empty values are dropped; {} when nothing is set.
 */
export function normalizeLook(v) {
  const out = {};
  if (!v || typeof v !== 'object') return out;
  for (const a of LOOK_AXES) { const x = v[a.id]; if (x === 'none' || presetOf(a.id, x)) out[a.id] = x; }
  if (v.subjects && typeof v.subjects === 'object') {
    const s = {};
    for (const [id, text] of Object.entries(v.subjects).slice(0, 20)) { const t = trail(text).slice(0, SUBJECT_MAX); if (/^[\w-]{1,80}$/.test(id) && t) s[id] = t; }
    if (Object.keys(s).length) out.subjects = s;
  }
  return out;
}
/** A shot's look: the project default with the shot's own on top ('none' clears an axis); subjects merge per object. */
export function effectiveLook(project, shot) {
  const base = normalizeLook(project?.look), own = normalizeLook(shot?.look), out = {};
  for (const id of AXIS_IDS) { const x = own[id] ?? base[id]; if (x && x !== 'none') out[id] = x; }
  const subjects = { ...(base.subjects || {}), ...(own.subjects || {}) };
  for (const id of Object.keys(subjects)) if (!project?.scene?.entities?.some(e => e.id === id)) delete subjects[id];
  if (Object.keys(subjects).length) out.subjects = subjects;
  return out;
}
export const hasLook = look => Object.keys(look || {}).length > 0;

/** One readable label per set axis: [{ axis, id, label }] (subjects: one per object, label "Eagle → hawk"). */
export function lookLabels(project, look) {
  const out = [];
  for (const a of LOOK_AXES) if (look?.[a.id]) out.push({ axis: a.id, id: look[a.id], label: presetOf(a.id, look[a.id])?.label || look[a.id] });
  for (const [id, text] of Object.entries(look?.subjects || {})) out.push({ axis: 'subject', id, label: `${project.scene.entities.find(e => e.id === id)?.name || 'Object'} → ${text}` });
  return out;
}

// ---------- Prompt sections ----------
const castOf = (groups, id) => groups.find(g => g.cards.some(c => c.id === id));
/**
 * Section overrides a look makes for one prompt kind (merged UNDER the shot's own overrides by shared/prompt.mjs):
 *   intro  the art style's format line (non-photoreal styles)
 *   world  "Set: the same scene at night, in heavy rain, in winter …" (time, weather, season)
 *   style  "Look: <medium>, <light>…" + the explicit negative; kept as the project style + negative when only the wardrobe or a
 *          subject changes, so the look is otherwise identical
 *   obj:<id>  the lead's Cast Card with the new clothes; a swapped subject's text
 * `groups` is shared/prompt.mjs castGroups (section keys name a group's first object). `compact` keeps the first clause of each
 * light phrase, to fit a tight length budget. Each override: { mode: 'override', text, basedOn: '', preset: true }.
 */
export function lookSectionTexts(project, shot, kind, look, { groups = [], compact = false } = {}) {
  const out = {};
  if (!hasLook(look)) return out;
  const pick = (axis, k) => presetOf(axis, look[axis])?.[k] || '';
  const short = t => (compact ? t.split(',')[0] : t);
  const style = presetOf('style', look.style);
  // 'tight': the style's own look already names its medium (the camera line reads it from there), so its format line goes.
  if (style?.intro && compact !== 'tight') out.intro = style.intro[kind === 'video' ? 0 : 1];
  const world = ['time', 'weather', 'season'].map(a => short(pick(a, 'world'))).filter(Boolean);
  if (world.length) out.world = `Set: the same scene ${world.join(', ')}.`;
  // 'tight' (a combination over the budget): the strongest light phrase only.
  const light = ['time', 'weather', 'season', 'mood'].map(a => short(pick(a, 'look'))).filter(Boolean).slice(0, compact === 'tight' ? 1 : 4);
  // The base look: the art style's, else photoreal when the light changes, else the project style left as it is (a wardrobe or
  // subject change keeps the look identical). The explicit negative is always there.
  const projectStyle = trail(project.scene.environment?.style || '').replace(/^look:\s*/i, '');
  const own = !(style && style.id !== 'photoreal') && !light.length && !style;
  const medium = style && style.id !== 'photoreal' ? short(style.look) : own ? projectStyle || 'photoreal' : 'photoreal';
  const lookLine = `Look: ${[medium, ...light].join(', ')}.`;
  out.style = /no logos/i.test(lookLine) ? lookLine : `${lookLine} ${NO_BRANDS_NEGATIVE}`;
  // 'minimal' (the shot's required text leaves almost no room): one look line with the first setting or light phrase, no world.
  if (compact === 'minimal') {
    delete out.intro; delete out.world;
    const first = ['time', 'weather', 'season'].map(a => pick(a, 'world').split(',')[0]).find(Boolean) || light[0] || '';
    const mediumWord = style && style.id !== 'photoreal' ? style.look.split(/[,:]/)[0] : own ? '' : 'photoreal';
    out.style = `Look: ${[mediumWord, first].filter(Boolean).join(', ') || projectStyle.split(/[,.]/)[0] || 'photoreal'}. ${NO_BRANDS_SHORT}`;
  }
  // Wardrobe dresses a character lead only (an eagle or a car has no clothes).
  const lead = project.scene.entities.find(e => e.id === shot.camera?.target && e.kind === 'character')?.id, wear = pick('wardrobe', 'wear');
  // Compact: the Cast Card's first clause (who they are) and the new clothes.
  if (wear && lead) { const g = castOf(groups, lead), who = trail(g?.text || '').split(/[,.;]/)[0]; if (g) out[`obj:${g.cards[0].id}`] = compact === 'minimal' ? `${who}, now in ${pick('wardrobe', 'short')}.` : compact ? `${who}, the same person, now wearing ${wear}.` : `${trail(g.text)}. Same person, now wearing ${wear}.`; }
  let swapped = false;
  for (const [id, text] of Object.entries(look.subjects || {})) { const g = castOf(groups, id); if (g) { swapped = true; out[`obj:${g.cards[0].id}`] = `${trail(text).charAt(0).toUpperCase()}${trail(text).slice(1)}.`; } }
  // Nothing in the look applies to this shot (a wardrobe without a character lead, a swap of an object not in it): no sections.
  if (!style && !world.length && !light.length && !(wear && lead) && !swapped) return {};
  return Object.fromEntries(Object.entries(out).map(([k, text]) => [k, { mode: 'override', text, basedOn: '', preset: true }]));
}

// ---------- Variants ----------
/** Axes on which two looks differ: [{ axis, from, to }] (subjects: axis 'subject', with the object id). */
export function lookDiff(base, other) {
  const out = [];
  for (const a of AXIS_IDS) if ((base?.[a] || null) !== (other?.[a] || null)) out.push({ axis: a, from: base?.[a] || null, to: other?.[a] || null });
  const ids = new Set([...Object.keys(base?.subjects || {}), ...Object.keys(other?.subjects || {})]);
  for (const id of ids) if ((base?.subjects?.[id] || null) !== (other?.subjects?.[id] || null)) out.push({ axis: 'subject', entityId: id, from: base?.subjects?.[id] || null, to: other?.subjects?.[id] || null });
  return out;
}
/** "Night (vs base)", "Night + Winter (vs base)", "Eagle → hawk (vs base)" or "Same as base". */
export function variantLabel(project, base, other) {
  const d = lookDiff(base, other);
  if (!d.length) return 'Same as base';
  const name = x => (x.axis === 'subject' ? `${project.scene.entities.find(e => e.id === x.entityId)?.name || 'Object'} → ${x.to || 'original'}` : x.to ? presetOf(x.axis, x.to)?.label || x.to : `No ${AXIS[x.axis].label.toLowerCase()}`);
  return `${d.map(name).join(' + ')} (vs base)`;
}
/** The base shot of a variant, or null. */
export const baseShotOf = (project, shot) => (shot?.variantOf ? project.shots.find(s => s.id === shot.variantOf && s.id !== shot.id) || null : null);

/**
 * The variant looks for a base look: single-axis by default — one variant per value, each changing that axis only — or, with
 * `combine: true` (only when asked for), every combination across the axes given. `axes`: { time: ['night'], season: ['winter'],
 * style: ['claymation'], subject: [{ entityId, text }] }. Values equal to the base are skipped. At most MAX_VARIANTS.
 */
export function variantLooks(baseLook, axes = {}, { combine = false } = {}) {
  const base = normalizeLook(baseLook), options = [];
  for (const [axis, values] of Object.entries(axes || {})) {
    const list = (Array.isArray(values) ? values : [values]).filter(Boolean);
    if (axis === 'subject') { const subs = list.filter(x => x?.entityId && trail(x.text)).map(x => ({ subjects: { ...(base.subjects || {}), [x.entityId]: trail(x.text).slice(0, SUBJECT_MAX) } })); if (subs.length) options.push(subs); continue; }
    if (!AXIS[axis]) throw Error(`Unknown look axis ${axis}; use ${[...AXIS_IDS, 'subject'].join(', ')}`);
    const vals = list.map(String).filter(v => { if (!presetOf(axis, v)) throw Error(`Unknown ${AXIS[axis].label.toLowerCase()} preset ${v}; use ${AXIS[axis].presets.map(p => p.id).join(', ')}`); return v !== base[axis]; });
    if (vals.length) options.push([...new Set(vals)].map(v => ({ [axis]: v })));
  }
  const looks = combine ? options.reduce((acc, opts) => acc.flatMap(a => opts.map(o => ({ ...a, ...o }))), [{}]).filter(x => Object.keys(x).length) : options.flat();
  const out = [], seen = new Set();
  for (const change of looks) { const look = normalizeLook({ ...base, ...change }), k = JSON.stringify(look); if (!seen.has(k) && lookDiff(base, look).length) { seen.add(k); out.push(look); } }
  if (out.length > MAX_VARIANTS) throw Error(`${out.length} variants; at most ${MAX_VARIANTS} per batch`);
  return out;
}

/**
 * The still model, style reference and video model a variant should use, and why. Every variant still is an edit of the base
 * still on an edit-capable model (VARIANT_STILL_MODEL); an art style may ask for a style reference (claymation). A character
 * lead whose walk matters gets Seedance 2.5 edit; otherwise Kling O1 edit (cheaper, but it rushes a walking character).
 */
export function variantModels(project, shot, look) {
  const style = presetOf('style', look?.style), lead = project.scene.entities.find(e => e.id === shot.camera?.target);
  const timing = shot.motionCritical || lead?.kind === 'character';
  return {
    still: style?.model?.still || VARIANT_STILL_MODEL, styleRef: !!style?.model?.styleRef,
    video: timing ? VARIANT_VIDEO_MODELS.timing : VARIANT_VIDEO_MODELS.cheap,
    why: timing ? `${lead?.name || 'The lead'} walks: Seedance 2.5 edit keeps the blockout's timing; Kling O1 edit is cheaper but rushes a character ahead of the blockout.` : 'No character timing to keep: Kling O1 edit follows the blockout at a third of the price.',
  };
}

/**
 * The prompt for a variant still: an edit of the base still (image 1) that changes only the attributes that differ and keeps
 * everything else identical. `refs`: labels of the cast images that follow (image 2 …); `styleRef`: the image number of a
 * style reference, if one is sent.
 */
export function variantEditPrompt(project, shot, base, { refs = [], styleRef = null } = {}) {
  const from = effectiveLook(project, base), to = effectiveLook(project, shot), diff = lookDiff(from, to);
  const leadName = project.scene.entities.find(e => e.id === shot.camera?.target)?.name || 'the lead';
  const change = diff.map(d => {
    if (d.axis === 'subject') { const n = project.scene.entities.find(e => e.id === d.entityId)?.name || 'the subject'; return d.to ? `${n}: replace it with ${d.to}, at the same size, position, pose and heading` : `${n}: restore it as described`; }
    if (d.axis === 'wardrobe') return d.to ? `${leadName}'s clothes: dress them in ${presetOf('wardrobe', d.to).wear}` : `${leadName}'s clothes: back to the clothes in their description`;
    const p = presetOf(d.axis, d.to);
    return p ? `${AXIS[d.axis].edit}: ${p.edit}` : `${AXIS[d.axis].edit}: back to the base`;
  });
  const swapped = new Set(diff.filter(d => d.axis === 'subject').map(d => d.entityId));
  const keepPeople = diff.some(d => d.axis === 'wardrobe') ? "every person's face, hair, build and pose" : "every person's face, hair, build, pose and clothes";
  const lines = [
    `Edit image 1, the base still of this shot. Change only ${change.length > 1 ? 'these' : 'this'}: ${change.join('; ')}.`,
    `Keep everything else exactly as in image 1: the camera, framing and composition; ${keepPeople}; every vehicle, building and prop${swapped.size ? ' you are not replacing' : ''}, with the same design, colour and position.`,
    refs.length ? `${refs.map((r, i) => `The ${r} looks exactly like image ${i + 2}.`).join(' ')} Those images show only what things look like; the framing comes from image 1.` : '',
    styleRef ? `Image ${styleRef} is a style reference: match its material and surface only, never its content or framing.` : '',
    `${NO_BRANDS_NEGATIVE.replace(/\.$/, '')}; no captions, labels or watermarks. One single frame.`,
  ];
  return lines.filter(Boolean).join('\n');
}

/** The shot fields a new variant copies from its base: camera, timing, description, style tags, cast, section overrides. */
export function variantShotInput(project, base, look, title) {
  const keep = ['description', 'duration', 'start', 'camera', 'style', 'cast', 'promptSections', 'motionCritical'];
  const shot = Object.fromEntries(keep.filter(k => base[k] !== undefined).map(k => [k, structuredClone(base[k])]));
  return { ...shot, title: title || `${base.title} · ${variantLabel(project, effectiveLook(project, base), look)}`, variantOf: base.id, look };
}
