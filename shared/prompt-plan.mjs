// Copyright (c) 2026 Steven Bobyn. SPDX-License-Identifier: MIT
// The final generation prompt, assembled by section. This is the one place a shot's still and video prompts are put
// together for a model: the browser's storyboard and Generate dialog, the batch and the MCP tools all call
// videoPromptPlan / stillPromptPlan and send `plan.text`, and the prompt inspector shows `plan.sections` from the same call,
// so what the artist reads is what is sent.
//
// A plan: { kind, mode, text (the exact final prompt), length, maxLength, sections: [row], cameraWarning, … }. Each row says
// where its words come from (source, group), its policy (inherit | override | lock | system) and whether it made it into
// the final text (status: included | shortened | omitted | removed | cut | orphan, with `why`).
//   mode 'sections' – the composed prompt (auto-prompt with section overrides and locks)
//   mode 'edit'     – the shot's whole-prompt edit (Prompt block), section controls paused
//   mode 'request'  – text typed for this one request (Generate dialog, storyboard composer, MCP `prompt`)
//   mode 'compiled' – the fallback compiled prompt with numbered references (shared/director.mjs compilePrompt)
import { sectionedSegments, sectionsMedium, shotPrompt, VIDEO_PROMPT_CAP } from './prompt.mjs';
import { CAMERA_SOURCE_LABELS, cameraLine, cameraLineIn, cameraMotionWarning, cameraMotionWords, fitPrompt, stripCameraLines, withCameraLine } from './camera-source.mjs';
import { compilePrompt, referenceLegend } from './director.mjs';
import { editsGuide, stillPromptParts } from './still-match.mjs';
import { sectionsText, sourceChanged, wordDiff, diffStats } from './prompt-sections.mjs';

export const SECTION_GROUPS = { shot: 'Shot description', cast: 'Cast & look', style: 'Style', camera: 'Blockout & camera rules', model: 'Model-specific' };
const GROUP_OF = { intro: 'shot', action: 'shot', edit: 'shot', request: 'shot', compiled: 'shot', note: 'shot', world: 'cast', style: 'style', camera: 'camera', frame: 'camera', moment: 'camera', rules: 'camera', guide: 'model', refs: 'model' };
export const sectionGroup = key => GROUP_OF[key] || (key.startsWith('obj:') ? 'cast' : key.startsWith('cam-') ? 'style' : 'model');
const SYSTEM_COLOR = '#6B6B6B';

function row(r, kind) {
  const system = !!r.system;
  const out = {
    key: r.key, label: r.label, source: r.source, group: r.group || sectionGroup(r.key), color: r.color || SYSTEM_COLOR, ...(r.ids?.length ? { ids: r.ids } : {}),
    policy: system ? 'system' : r.policy || 'inherit', system, editable: !system && !!r.editable,
    text: r.text || '', autoText: r.autoText ?? r.text ?? '', status: r.status || 'included', ...(r.why ? { why: r.why } : {}), ...(r.changes ? { changes: r.changes } : {}),
  };
  if (r.policy && r.policy !== 'inherit' && sourceChanged(r)) out.sourceChanged = true;
  // Free text that directs the camera contradicts the camera rule; it is flagged, never rewritten.
  if (kind === 'video' && !system && out.text) { const words = cameraMotionWords(out.text); if (words.length) out.cameraWords = words; }
  return out;
}
const WHY = { omitted: 'Left out to keep the video prompt short', shortened: 'Shortened to its first sentence to keep the video prompt short', removed: 'You removed this section', orphan: 'Saved for an object that is no longer in this shot; not sent' };
/** Why a section was left out; for a video, the auto-prompt cap it was left out for (a heuristic, see shared/prompt.mjs). */
const why = (status, cap) => status === 'omitted' && Number.isFinite(cap) ? `${WHY.omitted} (this model’s auto-prompt aims for about ${cap.toLocaleString('en-US')} characters, a rule of thumb rather than a measured limit)` : WHY[status];
const composedRows = (rows, kind, cap) => rows.map(r => row({ ...r, system: r.key === 'camera', editable: r.key !== 'camera', group: sectionGroup(r.key), why: why(r.status, cap), ...(r.key === 'camera' ? { changes: kind === 'video' ? 'Follows the chosen model and the shot’s look: blockout clip, start → end stills or one still; a non-photoreal look repaints the blockout in that medium.' : 'Follows the shot camera’s lens.' } : {}) }, kind));
/** Mark rows whose text did not make it into the final text (cut to the model's limit). */
function settle(rows, final, limit) {
  for (const r of rows) if (r.text && (r.status === 'included' || r.status === 'shortened') && !final.includes(r.text)) { r.status = 'cut'; r.why = limit ? `Cut to fit the model’s ${limit.toLocaleString('en-US')}-character prompt limit` : 'Cut to fit the prompt limit'; }
  return rows;
}
const counts = rows => ({ overrides: rows.filter(r => r.policy === 'override').length, locks: rows.filter(r => r.policy === 'lock').length });

/**
 * The final video prompt for a shot and model, by section. `cameraSource` is the model's (shared/camera-source.mjs
 * cameraSourceOf), `refs` the planner rows the model receives (shared/director.mjs videoReferences; a start-still model gets
 * none), `maxLength` the model's prompt limit, `cap` the model's auto-prompt cap (shared/model-params.mjs autoPromptCap; a
 * heuristic, default VIDEO_PROMPT_CAP), `userPrompt` text typed for this request (null: the shot's prompt).
 * The text is exactly what the browser, batch and MCP bind.
 */
export function videoPromptPlan(project, shot, { cameraSource = 'blockout', refs = [], maxLength, cap = VIDEO_PROMPT_CAP, userPrompt = null, model = '' } = {}) {
  const legend = cameraSource === 'blockout' ? referenceLegend(refs) : '';
  // Reference labels are sent in the same prompt: reserve their room before optional prose.
  const opts = { cameraSource, cap: Math.max(0, cap - (legend ? legend.length + 1 : 0)) }, composed = shotPrompt(project, shot, 'video', opts);
  const P = userPrompt ?? composed, whole = !!(shot.prompts?.video?.edited && shot.prompts.video.text);
  const compiledNull = () => compilePrompt(project, shot, null, opts);
  let mode, rows, pre;
  if (cameraSource === 'blockout' ? !(P.trim() && P.trim() !== compiledNull().trim()) : !P.trim()) {
    mode = 'compiled';
    pre = cameraSource === 'blockout' ? compilePrompt(project, shot, refs, opts) : withCameraLine(compiledNull(), cameraSource);
    rows = [row({ key: 'compiled', label: 'Compiled prompt', source: 'Scene, cast and numbered references', text: stripCameraLines(pre) }, 'video'), row({ key: 'camera', label: 'Camera', source: CAMERA_SOURCE_LABELS[cameraSource], system: true, text: cameraLineIn(pre, cameraSource) || cameraLine(cameraSource) }, 'video')];
  } else if (userPrompt !== null && P.trim() !== composed.trim()) {
    mode = 'request';
    pre = [withCameraLine(P, cameraSource), legend].filter(Boolean).join('\n');
    rows = [row({ key: 'request', label: 'Your text for this request', source: 'Typed for this generation only', policy: 'override', text: stripCameraLines(P) }, 'video')];
  } else if (whole) {
    mode = 'edit';
    pre = [withCameraLine(P, cameraSource), legend].filter(Boolean).join('\n');
    rows = [row({ key: 'edit', label: 'Your edited prompt', source: 'Whole-prompt edit (Prompt block)', policy: 'override', text: stripCameraLines(shot.prompts.video.text) }, 'video')];
  } else {
    mode = 'sections';
    const applied = sectionedSegments(project, shot, 'video', opts);
    const medium = sectionsMedium(applied), join = () => [withCameraLine(sectionsText(applied), cameraSource, medium), legend].filter(Boolean).join('\n');
    pre = join();
    // A locked section is never dropped to fit the model's limit: unlocked sections go first, last in the prompt first.
    if (Number.isInteger(maxLength) && pre.length > maxLength && applied.some(r => r.policy === 'lock')) {
      for (const r of [...applied].reverse()) {
        if (pre.length <= maxLength) break;
        if (!r.active || !r.text || r.key === 'camera' || r.key === 'action' || r.policy === 'lock') continue;
        r.active = false; r.status = 'cut'; pre = join();
      }
    }
    rows = composedRows(applied, 'video', opts.cap);
  }
  if (mode !== 'sections' && mode !== 'compiled') rows.push(row({ key: 'camera', label: 'Camera', source: CAMERA_SOURCE_LABELS[cameraSource], system: true, text: cameraLineIn(pre, cameraSource) || cameraLine(cameraSource), changes: 'Follows the chosen model and the shot’s look: blockout clip, start → end stills or one still; a non-photoreal look repaints the blockout in that medium.' }, 'video'));
  if (legend && mode !== 'compiled') rows.push(row({ key: 'refs', label: 'Reference legend', source: `${refs.length} numbered image${refs.length === 1 ? '' : 's'} this model receives`, system: true, text: legend, changes: 'Follows the reference images: cast looks, start and end stills, and the model’s image limit.' }, 'video'));
  const text = fitPrompt(pre, maxLength, cameraSource);
  settle(rows, text, maxLength);
  for (const r of rows) if (r.status === 'cut' && !r.why) r.why = `Cut to fit the model’s ${maxLength}-character prompt limit`;
  return { kind: 'video', mode, model, cameraSource, cameraLabel: CAMERA_SOURCE_LABELS[cameraSource], text, length: text.length, maxLength: Number.isInteger(maxLength) ? maxLength : null, autoPromptCap: cap, cut: pre.length > text.length, sections: rows, cameraWarning: cameraMotionWarning(text, cameraSource), ...counts(rows) };
}

/**
 * The final still (key frame) prompt, by section. Options are stillPrompt's (shared/still-match.mjs) plus `moment` (what
 * happens at this moment, from the composer) and `text` (text typed for this request; default the shot's image prompt).
 * plan.text === stillPrompt({ …, text: [text, moment] }) — the same parts, joined the same way.
 */
export function stillPromptPlan({ project, shot, t = 0, text = null, moment = '', presetId = '', looks = [], prevImage = null, frame = null, max = 2500, markers = true, model = '' }) {
  const composed = shotPrompt(project, shot, 'image'), whole = !!(shot.prompts?.image?.edited && shot.prompts.image.text);
  const note = String(moment || '').trim() ? `At this moment: ${String(moment).trim()}.` : '';
  const mode = text !== null && text.trim() !== composed.trim() ? 'request' : whole ? 'edit' : 'sections';
  const applied = mode === 'sections' ? sectionedSegments(project, shot, 'image') : null;
  let body = mode === 'sections' ? sectionsText(applied) : text ?? composed;
  // The guide and rules repaint in the shot's look: its sections when composed, else what the text's look parts name.
  const medium = applied ? sectionsMedium(applied) : undefined;
  const build = () => stillPromptParts({ project, shot, t, text: [body.trim(), note].filter(Boolean).join(' '), presetId, looks, prevImage, frame, max, markers, medium });
  let parts = build();
  const over = () => { const b = parts.find(x => x.key === 'body'); return b.text !== b.full; };
  // A locked section is never dropped to fit the limit: unlocked sections go first, last in the prompt first.
  if (applied && over() && applied.some(r => r.policy === 'lock')) {
    for (const r of [...applied].reverse()) {
      if (!over()) break;
      if (!r.active || !r.text || r.key === 'camera' || r.key === 'action' || r.policy === 'lock') continue;
      r.active = false; r.status = 'cut'; body = sectionsText(applied); parts = build();
    }
  }
  const part = k => parts.find(x => x.key === k).text;
  const final = parts.map(x => x.text).filter(Boolean).join('\n').slice(0, max);
  const at = `${Math.round(t * 100) / 100} s`;
  const creative = mode === 'request' ? [row({ key: 'request', label: 'Your text for this still', source: 'Typed in the storyboard composer', policy: 'override', text: text.trim() }, 'image')]
    : mode === 'edit' ? [row({ key: 'edit', label: 'Your edited prompt', source: 'Whole-prompt edit (Prompt block)', policy: 'override', text: shot.prompts.image.text.trim() }, 'image')]
    : composedRows(applied, 'image');
  const sys = (key, label, source, changes) => row({ key, label, source, system: true, text: part(key), changes }, 'image');
  const rows = [
    sys('guide', 'Guide rules', editsGuide(presetId) ? `${model || presetId}: edits image 1` : 'Image 1 is the blockout frame', 'Follows the image model: Gemini models edit image 1, the others match it.'),
    sys('frame', 'Camera & layout in words', `Measured from the blockout at ${at}`, 'Follows the shot camera, the objects and the moment.'),
    sys('moment', 'Moment', `Shot time ${at}`, 'Follows the moment of the still (start, end or a time).'),
    ...creative,
    ...(note ? [row({ key: 'note', label: 'At this moment', source: 'Composer: what happens at this moment', policy: 'override', text: note }, 'image')] : []),
    sys('refs', 'Reference legend', `${looks.length} cast image${looks.length === 1 ? '' : 's'}${prevImage ? ' and the previous shot' : ''}`, 'Follows the cast in frame and the model’s image limit.'),
    sys('rules', 'Do not copy', markers ? 'Proxy blockout markers' : 'Imported Blender frame', 'Follows the blockout source.'),
  ].filter(r => r.text || !r.system);
  const bodyPart = parts.find(x => x.key === 'body');
  settle(rows, final, max);
  return { kind: 'image', mode, model: model || presetId, t, text: final, length: final.length, maxLength: max, cut: bodyPart.text !== bodyPart.full, sections: rows, cameraWarning: '', ...counts(rows) };
}

// ---------- History and takes ----------
const short = s => String(s || '').split(' (')[0].split(' · ')[0];
/** Takes of a shot with the exact prompt each was made with: stills (key frames) or generated videos, oldest first. */
export function promptTakes(project, shot, kind) {
  if (kind === 'image') {
    return (shot.references || []).filter(r => r.role === 'frame' && r.generated?.prompt).map(r => ({ id: `still:${r.id}`, kind, label: `${(r.note || 'still').replace('key frame ', '')} · ${short(r.generated.model || r.generated.presetId)}${r.generated.seed != null ? ` · seed ${r.generated.seed}` : ''}`, at: r.createdAt || '', model: r.generated.presetId || short(r.generated.model), text: r.generated.prompt }));
  }
  return (project.assets || []).filter(a => a.kind === 'workflow-result' && a.shotId === shot.id && a.source?.prompt).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .map(a => ({ id: `video:${a.id}`, kind, label: `${short(a.source.workflow)} · ${String(a.createdAt || '').slice(0, 16).replace('T', ' ')}`, at: a.createdAt || '', model: short(a.source.workflow), text: a.source.prompt }));
}
/** Saved versions (newest last) and takes for one prompt kind. Version ids are `v:<id>`, take ids `still:…` / `video:…`. */
export function promptHistory(project, shot, kind) {
  const versions = (shot.promptVersions?.[kind] || []).map((v, i) => ({ ...v, id: `v:${v.id}`, label: `v${i + 1} · ${v.reason}${v.model ? ` · ${v.model}` : ''}${v.by !== 'you' ? ` · by ${v.by}` : ''}` }));
  return { versions, takes: promptTakes(project, shot, kind) };
}
/** Word diff between two history entries (ids from promptHistory, or 'current' with `current` text). */
export function comparePrompts(project, shot, kind, fromId, toId, current = '') {
  const h = promptHistory(project, shot, kind), all = [...h.versions, ...h.takes, { id: 'current', label: 'Current final prompt', text: current }];
  const a = all.find(x => x.id === fromId), b = all.find(x => x.id === toId);
  if (!a || !b) throw Error(`Unknown prompt version ${!a ? fromId : toId}`);
  const diff = wordDiff(a.text, b.text);
  return { from: { id: a.id, label: a.label }, to: { id: b.id, label: b.label }, diff, ...diffStats(diff), same: a.text === b.text };
}
