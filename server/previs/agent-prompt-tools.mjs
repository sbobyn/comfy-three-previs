// Prompt transparency and model settings for the MCP agent (server/previs/agent.mjs): the assembled prompt by section, per-
// section overrides and locks, the version history with word diffs, and each model's parameters with per-shot settings.
// Every tool uses the same shared assembly as the workspace and the batch (shared/prompt-plan.mjs), so what Claude reads is
// what generation sends. Nothing here generates or spends.
import { videoPromptPlan, stillPromptPlan, promptHistory, comparePrompts, SECTION_GROUPS } from '../../shared/prompt-plan.mjs';
import { mergePromptSections, SYSTEM_KEYS } from '../../shared/prompt-sections.mjs';
import { sectionedSegments } from '../../shared/prompt.mjs';
import { cameraSourceOf, cameraMotionWords } from '../../shared/camera-source.mjs';
import { blenderBlockout, videoReferences } from '../../shared/director.mjs';
import { stillReferences, STRONG_GUIDE_MODEL, STILL_MAX_REFS } from '../../shared/still-match.mjs';
import { maxReferences } from '../../shared/video-refs.mjs';
import { resolveFrame } from '../../shared/keyframes.mjs';
import { imageEstimate, imageParamSpecs, resolveImageParams, resolveVideoParams, settingsApply, videoCapabilities, videoEstimate, videoParamSpecs } from '../../shared/model-params.mjs';

const kindOf = k => (k === 'image' ? 'image' : 'video');
const shortTitle = d => String(d?.title || d?.id || '').split(' · ')[0];

/** Tool definitions; `deps` are agent.mjs helpers ({ get, post, project, shotOf, videoDefs }). */
export function promptTools({ get, post, project, shotOf, videoDefs }) {
  // The shot's video model: the one saved on the shot, else its last job's, else the first choice (as the workspace picks).
  async function videoDefFor(p, s, id) {
    const gen = await get('/api/generation'), defs = videoDefs(gen);
    const last = s.render ? (gen.jobs || []).filter(j => j.shotId === s.render.previsShotId).at(-1)?.definition : null;
    const d = id ? defs.find(x => x.id === id) : defs.find(x => x.id === s.settings?.video?.model) || defs.find(x => x.id === (last?.provenance?.presetId || last?.id)) || defs[0];
    if (!d) throw Error(id ? `Unknown video model ${id}; see previs_director_models` : 'No video models are set up');
    return d;
  }
  async function imagePresets(p) { return (await get(`/api/director/refgen?projectId=${p.id}`)).presets || []; }
  async function imagePresetFor(p, s, id) {
    const all = await imagePresets(p), want = id || s.settings?.image?.model || STRONG_GUIDE_MODEL;
    const x = all.find(y => y.id === want); if (!x) throw Error(`Unknown image model ${want}; see previs_director_models`);
    return x;
  }
  // The encoded blockout frame generate_still uses (shared/keyframes.mjs): "end" is the clip's last frame.
  const atOf = (p, s, at) => resolveFrame(p, s, { at: at ?? 'start' }).t;
  // The plan generation would send right now for this shot, kind and model (the workspace composer's defaults).
  async function planFor(p, s, kind, model, at) {
    if (kind === 'video') {
      const d = await videoDefFor(p, s, model), cameraSource = cameraSourceOf(d);
      const refs = d.task === 'first-frame' ? [] : videoReferences(p, s, maxReferences(d), { stills: cameraSource === 'blockout' });
      return { model: d.id, plan: videoPromptPlan(p, s, { cameraSource, refs, maxLength: d.constraints?.promptMaxLength, model: shortTitle(d) }) };
    }
    const preset = await imagePresetFor(p, s, model), t = atOf(p, s, at), cap = preset.maxRefs ?? STILL_MAX_REFS[preset.id] ?? 0;
    const looks = stillReferences(p, s, t, cap).looks, prev = p.shots[p.shots.indexOf(s) - 1]?.references.filter(r => r.role === 'frame').at(-1);
    const refIds = [...looks.map(r => r.ref.id), ...(prev ? [prev.id] : [])].slice(0, Math.max(0, cap - 1));
    return { model: preset.id, plan: stillPromptPlan({ project: p, shot: s, t, presetId: preset.id, model: shortTitle(preset), looks: looks.slice(0, refIds.length), prevImage: prev && refIds.includes(prev.id) ? refIds.indexOf(prev.id) + 2 : null, markers: !blenderBlockout(p, s) }) };
  }
  const describe = (s, kind, model, plan) => ({
    shot: { id: s.id, title: s.title }, kind, model, mode: plan.mode, ...(plan.cameraSource ? { cameraSource: plan.cameraSource } : {}), ...(plan.t !== undefined ? { at: plan.t } : {}),
    final: plan.text, length: plan.length, maxLength: plan.maxLength, ...(plan.cameraWarning ? { cameraWarning: plan.cameraWarning } : {}),
    sections: plan.sections.map(r => ({ key: r.key, label: r.label, group: SECTION_GROUPS[r.group], source: r.source, policy: r.policy, editable: r.editable, status: r.status, ...(r.why ? { why: r.why } : {}), text: r.text, ...(r.policy !== 'inherit' && r.autoText !== r.text && r.autoText ? { sourceText: r.autoText } : {}), ...(r.sourceChanged ? { sourceChanged: true } : {}), ...(r.cameraWords ? { cameraWords: r.cameraWords } : {}), ...(r.changes ? { changedBy: r.changes } : {}) })),
    ...(plan.mode === 'edit' ? { note: 'A whole-prompt edit is in use, so section overrides are paused. previs_director_set_prompt text:null returns to the composed prompt.' } : {}),
  });
  const record = (p, s, kind, plan, reason, model) => post('/api/director/edit', { projectId: p.id, ops: [{ op: 'record_prompt_version', shotId: s.id, kind, version: { text: plan.text, model, reason, by: 'claude', sections: plan.sections.filter(r => !r.system).map(r => ({ key: r.key, policy: r.policy })) } }] });

  return [
    { name: 'previs_director_prompt_sections', description: 'Read a shot’s final generation prompt exactly as it would be sent, by section: each section’s text, where it comes from (shot description, a Cast Card, project style, camera-style tags, the camera rule, the reference legend, the still’s guide rules), its policy (inherit, override, lock, or system for rules that follow the model and blockout), and whether it is included, shortened, omitted for length or cut to the model’s limit. Also the full final text and a warning when free text directs the camera. kind video uses the shot’s saved video model (or model); kind image uses the shot’s still model (or model) at a moment (at: start, end or seconds). Free; nothing is sent.', inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, shot: { type: 'string', description: 'Shot number, title or id' }, kind: { type: 'string', enum: ['video', 'image'] }, model: { type: 'string', description: 'Model id from previs_director_models (default: the shot’s saved model)' }, at: { type: ['string', 'number'], description: 'Still only: "start" (default), "end" or seconds' } }, required: ['projectId', 'shot'], additionalProperties: false },
      run: async a => { const p = await project(a.projectId), s = shotOf(p, a.shot), kind = kindOf(a.kind), { model, plan } = await planFor(p, s, kind, a.model, a.at); return describe(s, kind, model, plan); } },
    { name: 'previs_director_set_prompt_section', description: 'Override, lock or reset one section of a shot’s composed prompt (keys from previs_director_prompt_sections). mode "override" replaces the section with text (empty text removes it); "lock" freezes it (its current text, or text) so source changes and length fitting never drop it and edits are refused until it is unlocked; "inherit" returns it to its source and unlocks it. System sections (the camera rule, reference legend, guide rules) cannot be changed: they follow the model and the blockout. A video section that directs the camera (dolly, pan, crane…) is saved but flagged: the blockout is the camera. Saves a prompt version; undoable in the workspace.', inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, shot: { type: 'string' }, kind: { type: 'string', enum: ['video', 'image'] }, section: { type: 'string', description: 'Section key, e.g. action, obj:<object id>, world, style, cam-lens' }, mode: { type: 'string', enum: ['override', 'lock', 'inherit'] }, text: { type: 'string', maxLength: 1500 } }, required: ['projectId', 'shot', 'kind', 'section', 'mode'], additionalProperties: false },
      run: async a => {
        const p = await project(a.projectId), s = shotOf(p, a.shot), kind = kindOf(a.kind), key = String(a.section);
        if (SYSTEM_KEYS.has(key) || ['guide', 'frame', 'moment', 'refs', 'rules'].includes(key)) throw Error(`“${key}” is a system rule: it follows the model, camera source and blockout and cannot be overridden. Change the model or the shot instead.`);
        const rows = sectionedSegments(p, s, kind, {}), cur = rows.find(r => r.key === key);
        if (!cur) throw Error(`No section “${key}” in this shot’s ${kind} prompt. Sections: ${rows.filter(r => r.key !== 'camera').map(r => r.key).join(', ')}`);
        const saved = s.promptSections?.[kind]?.[key];
        if (saved?.mode === 'lock' && (a.mode === 'override' || (a.mode === 'lock' && a.text !== undefined && a.text !== saved.text))) throw Error(`“${cur.label}” is locked. Unlock it first (mode "inherit"), then override it.`);
        if (a.mode === 'override' && typeof a.text !== 'string') throw Error('mode "override" needs text (empty text removes the section)');
        const value = a.mode === 'inherit' ? null : { mode: a.mode, text: a.mode === 'lock' && a.text === undefined ? cur.text : a.text, basedOn: cur.fullText || cur.autoText, at: new Date().toISOString() };
        // The final prompt after the change, for the version log (same assembly as generation).
        const next = structuredClone(p), ns = next.shots.find(x => x.id === s.id);
        ns.promptSections = mergePromptSections(ns.promptSections, { [kind]: { [key]: value } });
        const { model, plan } = await planFor(next, ns, kind);
        await post('/api/director/edit', { projectId: p.id, ops: [{ op: 'update_shot', id: s.id, patch: { promptSections: { [kind]: { [key]: value } } } }] });
        await record(p, s, kind, plan, a.mode === 'inherit' ? (saved?.mode === 'lock' ? 'unlock' : 'reset') : a.mode === 'lock' ? 'lock' : 'edit', model);
        const words = kind === 'video' && value?.text ? cameraMotionWords(value.text) : [];
        return { ok: true, section: key, label: cur.label, policy: a.mode, text: value ? value.text : cur.autoText, ...(words.length ? { cameraWords: words, warning: `This text directs the camera (${words.join(', ')}), but the blockout is the camera. It was saved; remove those words or change the camera in the shot.` } : {}), ...(s.prompts?.[kind]?.edited ? { note: 'A whole-prompt edit is in use, so this section takes effect after previs_director_set_prompt text:null.' } : {}), final: plan.text };
      } },
    { name: 'previs_director_prompt_history', description: 'List a shot’s saved versions of its final prompt (each edit, lock and quote, newest last) and its takes with the exact prompt each was made with (stills for kind image, generated videos for kind video). With from and to (ids from the list, or "current" for the prompt as it would be sent now), returns a word diff: parts marked same, add or del, and counts. Free.', inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, shot: { type: 'string' }, kind: { type: 'string', enum: ['video', 'image'] }, from: { type: 'string' }, to: { type: 'string', description: 'Default "current"' } }, required: ['projectId', 'shot', 'kind'], additionalProperties: false },
      run: async a => {
        const p = await project(a.projectId), s = shotOf(p, a.shot), kind = kindOf(a.kind), h = promptHistory(p, s, kind);
        const list = x => ({ id: x.id, label: x.label, at: x.at, model: x.model, length: x.text.length, ...(x.reason ? { reason: x.reason, by: x.by } : {}) });
        const out = { shot: { id: s.id, title: s.title }, kind, versions: h.versions.map(list), takes: h.takes.map(list) };
        if (!a.from) return out;
        const { plan } = await planFor(p, s, kind);
        const c = comparePrompts(p, s, kind, a.from, a.to || 'current', plan.text);
        return { ...out, diff: { from: c.from, to: c.to, same: c.same, added: c.added, removed: c.removed, parts: c.diff } };
      } },
    { name: 'previs_director_model_settings', description: 'Read or set a shot’s model and its settings, with what the model accepts and costs. kind video: the video model (camera source, inputs, prompt limit, clip lengths, price per second) and its parameters from the model registry (seed, clip length for start-still models, steps for local VACE; resolution, sound and model version are shown fixed because other values are not priced). kind image: the still model, seed and takes. Pass model and/or params to save them on the shot (used by the workspace, previs_director_generate_video/still and the batch when they use that model); reset:true clears them. Returns the estimate for the saved settings. Free; nothing is sent.', inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, shot: { type: 'string' }, kind: { type: 'string', enum: ['video', 'image'] }, model: { type: 'string' }, params: { type: 'object', description: 'e.g. { "seed": 7, "duration": 6 } (video) or { "seed": 7, "count": 2 } (image)' }, reset: { type: 'boolean' } }, required: ['projectId', 'shot', 'kind'], additionalProperties: false },
      run: async a => {
        let p = await project(a.projectId), s = shotOf(p, a.shot); const kind = kindOf(a.kind);
        if (a.reset || a.model !== undefined || a.params !== undefined) {
          const cur = s.settings?.[kind] || {}, model = a.model ?? cur.model;
          if (kind === 'video') await videoDefFor(p, s, model); else await imagePresetFor(p, s, model);
          const value = a.reset ? null : { model, params: a.params ?? (model === cur.model ? cur.params : undefined) };
          await post('/api/director/edit', { projectId: p.id, ops: [{ op: 'update_shot', id: s.id, patch: { settings: { [kind]: value } } }] });
          p = await project(a.projectId); s = shotOf(p, s.id);
        }
        if (kind === 'video') {
          const d = await videoDefFor(p, s, a.reset ? undefined : s.settings?.video?.model), applies = settingsApply(s.settings?.video?.model, d);
          const r = resolveVideoParams(d, s), seconds = r.seconds ?? s.render?.duration ?? s.duration;
          const params = videoParamSpecs(d, s).map(x => ({ ...x, current: x.key in r.applied ? r.applied[x.key] : x.key === 'duration' ? seconds : x.value, saved: x.key in r.applied }));
          return { shot: { id: s.id, title: s.title }, kind, model: d.id, savedOnShot: applies, capabilities: videoCapabilities(d), params, ...(r.ignored.length ? { ignored: r.ignored, note: 'These saved values are not valid for this model and are not sent.' } : {}), seconds, estimateUsd: videoEstimate(d, seconds) };
        }
        const preset = await imagePresetFor(p, s), r = resolveImageParams(preset.id, s), refs = Math.min(preset.maxRefs ?? 0, stillReferences(p, s, 0, preset.maxRefs ?? 0).looks.length) + 1;
        const params = imageParamSpecs(preset).map(x => ({ ...x, current: x.key === 'seed' ? r.seed ?? 'random' : x.key === 'count' ? r.count : x.value }));
        return { shot: { id: s.id, title: s.title }, kind, model: preset.id, title: preset.title, savedOnShot: s.settings?.image?.model === preset.id, params, estimate: imageEstimate(preset.id, { count: r.count, refs }) };
      } },
  ];
}
/** Record the final prompt a generation used (best effort: a failed write never blocks the job). */
export async function recordSentPrompt(post, projectId, shotId, kind, text, model) {
  try { await post('/api/director/edit', { projectId, ops: [{ op: 'record_prompt_version', shotId, kind, version: { text, model, reason: 'generate', by: 'claude' } }] }); } catch { /* history only */ }
}
