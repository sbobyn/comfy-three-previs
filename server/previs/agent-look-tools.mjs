// Look presets for the MCP agent (server/previs/agent.mjs): list the presets, set a shot's (or the project's default) look,
// and add single-axis variants of a base shot. A variant's still is an edit of the base still (shared/look-variants.mjs) and its
// video follows the same blocking; previs_director_batch_generate's `variants` option quotes and makes them in one batch.
// Nothing here generates or spends.
import { LOOK_AXES, NO_BRANDS_NEGATIVE, effectiveLook, lookLabels, normalizeLook, baseShotOf, lookDiff, variantLabel, variantModels, AXIS_IDS } from '../../shared/look-presets.mjs';
import { explainStale, staleText } from '../../shared/regen.mjs';

const lookSchema = {
  type: ['object', 'null'],
  description: `Preset ids per axis (${LOOK_AXES.map(a => `${a.id}: ${a.presets.map(p => p.id).join('|')}`).join('; ')}). null on an axis removes it; "none" on a shot clears the project default for that axis. subjects: { objectId: "a red-tailed hawk" } swaps what an object is.`,
  properties: { ...Object.fromEntries(AXIS_IDS.map(a => [a, { type: ['string', 'null'] }])), subjects: { type: 'object', additionalProperties: { type: ['string', 'null'] } } },
  additionalProperties: false,
};
const axesSchema = {
  type: 'object', description: 'Values to vary, per axis: { time: ["night"], season: ["winter"], style: ["claymation"], subject: [{ objectId, text }] }. One variant per value, each changing only that axis.',
  properties: { ...Object.fromEntries(AXIS_IDS.map(a => [a, { type: 'array', items: { type: 'string' } }])), subject: { type: 'array', items: { type: 'object', properties: { objectId: { type: 'string' }, text: { type: 'string' } }, required: ['objectId', 'text'], additionalProperties: false } } },
  additionalProperties: false,
};
/** Agent axes (subject: [{ objectId, text }]) → shared/look-presets axes (subject: [{ entityId, text }]), resolving object names. */
export function axesFor(p, axes = {}) {
  const out = { ...axes };
  if (axes.subject) out.subject = axes.subject.map(x => ({ entityId: p.scene.entities.find(e => e.id === x.objectId || e.name === x.objectId)?.id || x.objectId, text: x.text }));
  return out;
}
/** A shot's look for the agent: its own, the effective one (with the project default), labels and, for a variant, what differs. */
export function lookView(p, s) {
  const look = effectiveLook(p, s), base = baseShotOf(p, s);
  return {
    shot: { id: s.id, title: s.title }, own: normalizeLook(s.look), effective: look, labels: lookLabels(p, look).map(x => x.label),
    ...(base ? { variantOf: { id: base.id, title: base.title }, differs: variantLabel(p, effectiveLook(p, base), look), axesChanged: lookDiff(effectiveLook(p, base), look).length } : {}),
    variants: p.shots.filter(x => x.variantOf === s.id).map(x => ({ id: x.id, title: x.title, label: variantLabel(p, look, effectiveLook(p, x)) })),
    suggested: variantModels(p, s, look),
  };
}
// What a look change makes out of date in a shot: its start still and its video (the cheapest honest summary).
function staleness(p, s) {
  return ['still', 'video'].map(type => { const x = explainStale(p, { type, shotId: s.id, ...(type === 'still' ? { at: 'start' } : {}) }); return { type, state: x.state, why: staleText(x) }; });
}

/** Tool definitions; `deps` are agent.mjs helpers ({ get, post, project, shotOf }). */
export function lookTools({ post, project, shotOf }) {
  return [
    { name: 'previs_director_look_presets', description: `List the look presets (time of day, weather, season, lighting mood, wardrobe or era, art style, and per-object subject swaps) and, with a shot, its look: own and effective (with the project default), labels, the base it is a variant of and which single attribute differs ("Night (vs base)"), its variants, and the models suggested for a variant (still: an edit of the base still on an edit-capable model; video: Seedance 2.5 edit when a character's timing matters, Kling O1 edit otherwise). Every preset look carries "${NO_BRANDS_NEGATIVE}" Free.`,
      inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, shot: { type: 'string' } }, additionalProperties: false },
      run: async a => {
        const catalog = LOOK_AXES.map(x => ({ axis: x.id, label: x.label, presets: x.presets.map(p => ({ id: p.id, label: p.label, ...(p.model ? { suggests: p.model } : {}) })) }));
        if (!a.projectId) return { axes: catalog };
        const p = await project(a.projectId);
        return { axes: catalog, projectDefault: normalizeLook(p.look), ...(a.shot ? { look: lookView(p, shotOf(p, a.shot)) } : {}) };
      } },
    { name: 'previs_director_set_look', description: 'Set the look presets of a shot, or the project default (omit shot). Presets compose into the shot’s prompt sections under any text you typed, fit the prompt length budget, and are part of the still and video regeneration keys: the answer says which outputs this makes out of date (only that shot’s, or every shot without its own value for a project default). Keep one change at a time on a variant: it should differ from its base on a single attribute (a warning says when it does not). Free.',
      inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, shot: { type: 'string', description: 'Shot id or number; omit for the project default' }, look: lookSchema, replace: { type: 'boolean', description: 'Replace the whole look instead of merging axes into it' } }, required: ['projectId', 'look'], additionalProperties: false },
      run: async a => {
        let p = await project(a.projectId);
        const s = a.shot ? shotOf(p, a.shot) : null, current = normalizeLook(s ? s.look : p.look);
        const merged = a.look === null ? {} : a.replace ? a.look : { ...current, ...Object.fromEntries(Object.entries(a.look).filter(([k]) => k !== 'subjects')), ...(a.look.subjects ? { subjects: { ...(current.subjects || {}), ...a.look.subjects } } : {}) };
        for (const k of Object.keys(merged)) if (merged[k] === null) delete merged[k];
        if (merged.subjects) for (const [id, t] of Object.entries(merged.subjects)) { if (t === null) delete merged.subjects[id]; else { const e = p.scene.entities.find(x => x.id === id || x.name === id); if (!e) throw Error(`Unknown object ${id}`); if (e.id !== id) { merged.subjects[e.id] = t; delete merged.subjects[id]; } } }
        for (const k of AXIS_IDS) if (merged[k] && !normalizeLook({ [k]: merged[k] })[k]) throw Error(`Unknown ${k} preset ${merged[k]}; see previs_director_look_presets`);
        const op = s ? { op: 'update_shot', id: s.id, patch: { look: merged } } : { op: 'set_project', patch: { look: merged } };
        p = (await post('/api/director/edit', { projectId: p.id, ops: [op] })).project;
        const shots = s ? [p.shots.find(x => x.id === s.id)] : p.shots;
        const out = { scope: s ? 'shot' : 'project', look: normalizeLook(s ? shots[0].look : p.look), affects: shots.map(x => ({ shot: x.title, effective: lookLabels(p, effectiveLook(p, x)).map(l => l.label), outputs: staleness(p, x) })) };
        if (s) { const v = lookView(p, shots[0]); Object.assign(out, { effective: v.effective, ...(v.variantOf ? { differs: v.differs } : {}) }); if (v.axesChanged > 1) out.warning = `This variant now differs from its base on ${v.axesChanged} attributes (${v.differs}); a variant should change one thing at a time.`; }
        return out;
      } },
    { name: 'previs_director_add_variants', description: 'Add look variants of a base shot: copies with the same camera, timing, blocking and section text, each changing ONE attribute (single-axis by default: base × {night, winter, claymation} makes three shots, each "<value> (vs base)"). combine: true makes every combination instead; use it only when the user asks for combinations. An identical variant that exists is reused. A variant’s still is later made as an edit of the base still (keep everything else identical) and its video follows the same blockout. To quote and make them in one go, use previs_director_batch_generate with variants. Free.',
      inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, shot: { type: 'string', description: 'The base shot (id or number)' }, axes: axesSchema, combine: { type: 'boolean' } }, required: ['projectId', 'shot', 'axes'], additionalProperties: false },
      run: async a => {
        let p = await project(a.projectId); const base = shotOf(p, a.shot);
        const r = (await post('/api/director/edit', { projectId: p.id, ops: [{ op: 'add_variants', shotId: base.id, axes: axesFor(p, a.axes), combine: a.combine === true }] }));
        p = r.project; const res = r.results?.[0] || {};
        const row = id => { const x = p.shots.find(y => y.id === id); return { id, title: x.title, differs: variantLabel(p, effectiveLook(p, p.shots.find(y => y.id === x.variantOf)), effectiveLook(p, x)) }; };
        return { base: { id: res.base, title: p.shots.find(x => x.id === res.base)?.title }, added: (res.ids || []).map(row), existing: (res.existing || []).map(row), suggested: variantModels(p, base, effectiveLook(p, base)),
          next: 'Quote and make them with previs_director_batch_generate (dryRun first), passing shots: these ids, or variants: { shot, axes } to add and quote in one call. The base shot needs its start still first.' };
      } },
  ];
}
