// Prompt transparency: the final prompt is assembled once (shared/prompt-plan.mjs) and the inspector's sections are that
// assembly; section overrides and locks persist per shot; versions and diffs; model parameters from the registry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectDocument, applyOps } from '../server/previs/director.mjs';
import { loadStarters } from '../server/previs/starters.mjs';
import { builtInPresets } from '../server/previs/presets.mjs';
import { planBatch } from '../server/previs/batch.mjs';
import { videoPrompt } from '../server/previs/batch-drivers.mjs';
import { compilePrompt, referenceLegend, videoReferences } from '../shared/director.mjs';
import { shotPrompt, sectionedSegments, autoPromptText } from '../shared/prompt.mjs';
import { CAMERA_LINES, fitPrompt, withCameraLine } from '../shared/camera-source.mjs';
import { stillPrompt, stillReferences } from '../shared/still-match.mjs';
import { videoPromptPlan, stillPromptPlan, promptHistory, comparePrompts } from '../shared/prompt-plan.mjs';
import { applySections, mergePromptSections, normalizePromptSections, appendPromptVersion, MAX_PROMPT_VERSIONS, wordDiff, diffStats } from '../shared/prompt-sections.mjs';
import { videoParamSpecs, resolveVideoParams, resolveImageParams, settingsApply, savedClipSeconds, normalizeShotSettings, videoCapabilities, videoEstimate } from '../shared/model-params.mjs';

const starters = await loadStarters();
const project = slug => createProjectDocument({ template: slug }, undefined, starters);
const preset = id => builtInPresets.find(d => d.id === id);
const SOURCES = ['blockout', 'keyframes', 'still'];
// The assembly every caller used before the plan existed (browser shotVideoPrompt / prepareFirstFrame, batch videoPrompt), as an oracle.
function legacyVideo(p, s, cameraSource, refs, max) {
  const P = shotPrompt(p, s, 'video', { cameraSource }), auto = compilePrompt(p, s, null, { cameraSource });
  const pre = cameraSource !== 'blockout' ? withCameraLine(P.trim() || auto, cameraSource)
    : P.trim() && P.trim() !== auto.trim() ? [withCameraLine(P, cameraSource), referenceLegend(refs)].filter(Boolean).join('\n') : compilePrompt(p, s, refs, { cameraSource });
  return fitPrompt(pre, max, cameraSource);
}

test('no drift: with no overrides the plan is byte-identical to the previous assembly, and the batch sends the plan', () => {
  for (const st of starters) {
    const p = project(st.slug);
    for (const s of p.shots) {
      for (const cameraSource of SOURCES) for (const max of [undefined, 2500, 280]) {
        const refs = cameraSource === 'blockout' ? videoReferences(p, s, 7, { stills: true }) : [];
        const plan = videoPromptPlan(p, s, { cameraSource, refs, maxLength: max });
        assert.equal(plan.text, legacyVideo(p, s, cameraSource, refs, max), `${st.slug} / ${s.title} / ${cameraSource} / ${max}`);
        assert.equal(videoPrompt(p, s, cameraSource, refs, max), plan.text, 'batch and MCP use the same text');
        if (max !== 280) assert.equal(plan.text.split(CAMERA_LINES[cameraSource]).length - 1, 1, 'exactly one camera line at real model limits');
        // Every included section's words are in the final text, in order.
        let at = 0; for (const r of plan.sections.filter(x => x.status === 'included')) { const i = plan.text.indexOf(r.text, at); assert.ok(i >= 0, `${r.key} is in the final text`); at = i; }
      }
      for (const t of [0, s.duration]) {
        const looks = stillReferences(p, s, t, 9).looks, o = { project: p, shot: s, t, presetId: 'flux-3', looks, markers: true };
        assert.equal(stillPromptPlan(o).text, stillPrompt({ ...o, text: shotPrompt(p, s, 'image') }));
        assert.equal(stillPromptPlan({ ...o, text: 'A custom still.', moment: 'the car lifts' }).text, stillPrompt({ ...o, text: 'A custom still. At this moment: the car lifts.' }));
      }
    }
  }
});

test('sections: sources, groups and system rules; the camera rule cannot be overridden', () => {
  const p = project('final-lap'), s = p.shots[0];
  const plan = videoPromptPlan(p, s, { cameraSource: 'blockout', refs: videoReferences(p, s, 7, { stills: true }), maxLength: 2500 });
  const by = Object.fromEntries(plan.sections.map(r => [r.key, r]));
  assert.equal(by.action.group, 'shot'); assert.match(by.action.source, /Shot 01 description/);
  assert.ok(plan.sections.some(r => r.key.startsWith('obj:') && r.group === 'cast' && /Cast Card/.test(r.source)));
  assert.equal(by.camera.policy, 'system'); assert.equal(by.camera.editable, false); assert.equal(by.camera.text, CAMERA_LINES.blockout);
  assert.equal(by.refs.group, 'model'); assert.match(by.refs.text, /^Reference images: 1 = /);
  const kept = normalizePromptSections({ video: { camera: { mode: 'override', text: 'Dolly in.' }, action: { mode: 'override', text: 'X.' } } });
  assert.deepEqual(Object.keys(kept.video), ['action'], 'a camera override is dropped: the camera rule follows the model');
  const still = stillPromptPlan({ project: p, shot: s, t: 0, presetId: 'nano-banana-2-1', looks: [] });
  assert.deepEqual(still.sections.filter(r => r.system).map(r => r.key), ['guide', 'frame', 'moment', 'camera', 'rules']);
  assert.match(still.sections[0].source, /edits image 1/, 'a Gemini model edits image 1: a model-specific rule');
});

test('override, lock and leave out persist on the shot and change exactly what is sent', () => {
  const p = project('final-lap'), s = p.shots[0], key = sectionedSegments(p, s, 'video').find(r => r.key.startsWith('obj:')).key;
  applyOps(p, [{ op: 'update_shot', id: s.id, patch: { promptSections: { video: { action: { mode: 'override', text: 'The Comfy car takes the lead on the last bend.' } } } } }]);
  let plan = videoPromptPlan(p, s);
  assert.match(plan.text, /^The Comfy car takes the lead on the last bend\. /); assert.equal(plan.sections.find(r => r.key === 'action').policy, 'override');
  assert.equal(shotPrompt(p, s, 'video'), plan.text, 'shotPrompt (blockout capture, dialogs) sees the override too');
  // Lock a cast section, then change its Cast Card: the locked words stay, the source change is flagged.
  const locked = plan.sections.find(r => r.key === key).text;
  applyOps(p, [{ op: 'update_shot', id: s.id, patch: { promptSections: { video: { [key]: { mode: 'lock', text: locked, basedOn: locked } } } } }]);
  applyOps(p, [{ op: 'update_entity', id: key.slice(4), patch: { notes: 'A plain white car.', styleNotes: '' } }]);
  plan = videoPromptPlan(p, s);
  const row = plan.sections.find(r => r.key === key);
  assert.equal(row.policy, 'lock'); assert.equal(row.text, locked); assert.ok(plan.text.includes(locked)); assert.ok(!plan.text.includes('A plain white car')); assert.equal(row.sourceChanged, true);
  // Leave a section out; null returns it to inherit.
  applyOps(p, [{ op: 'update_shot', id: s.id, patch: { promptSections: { video: { 'cam-lens': { mode: 'override', text: '' } } } } }]);
  assert.ok(!videoPromptPlan(p, s).text.includes('Lens:')); assert.equal(videoPromptPlan(p, s).sections.find(r => r.key === 'cam-lens').status, 'removed');
  applyOps(p, [{ op: 'update_shot', id: s.id, patch: { promptSections: { video: { 'cam-lens': null } } } }]);
  assert.ok(videoPromptPlan(p, s).text.includes('Lens:'));
  // The image prompt has its own sections; the video ones do not touch it.
  assert.equal(shotPrompt(p, s, 'image'), autoPromptText(p, s, 'image'));
  // A whole-prompt edit wins and pauses the sections.
  applyOps(p, [{ op: 'update_shot', id: s.id, patch: { prompts: { video: { text: 'Hand-written prompt.', edited: true } } } }]);
  plan = videoPromptPlan(p, s);
  assert.equal(plan.mode, 'edit'); assert.ok(plan.text.startsWith('Hand-written prompt.')); assert.equal(plan.text.split(CAMERA_LINES.blockout).length - 1, 1);
  applyOps(p, [{ op: 'update_shot', id: s.id, patch: { promptSections: null } }]);
  assert.equal(s.promptSections, undefined);
});

test('a locked section survives fitting to a model limit; unlocked sections are cut first and reported', () => {
  const p = project('final-lap'), s = p.shots[0], refs = videoReferences(p, s, 7, { stills: true });
  const rows = sectionedSegments(p, s, 'video'), cast = rows.filter(r => r.key.startsWith('obj:')), last = cast.at(-1);
  applyOps(p, [{ op: 'update_shot', id: s.id, patch: { promptSections: { video: { [last.key]: { mode: 'lock', text: last.text } } } } }]);
  const free = videoPromptPlan(p, s, { refs }), max = free.text.length - 40;
  const plan = videoPromptPlan(p, s, { refs, maxLength: max });
  assert.ok(plan.text.length <= max); assert.ok(plan.text.includes(last.text), 'the locked words are sent');
  assert.ok(plan.text.includes(CAMERA_LINES.blockout) && plan.text.includes('Reference images:'), 'camera line and legend are kept');
  assert.ok(plan.sections.some(r => r.status === 'cut' && /character prompt limit/.test(r.why)), 'what was cut is said');
});

test('a still keeps a locked section when its prompt is over the limit (today the tail is cut)', () => {
  const p = project('final-lap'), s = p.shots[0], looks = stillReferences(p, s, 0, 9).looks, o = { project: p, shot: s, t: 0, presetId: 'flux-3', looks };
  const before = stillPromptPlan(o);
  assert.equal(before.cut, true); const filter = before.sections.find(r => r.key === 'cam-filter');
  assert.equal(filter.status, 'cut', 'the inspector shows what the limit drops');
  applyOps(p, [{ op: 'update_shot', id: s.id, patch: { promptSections: { image: { 'cam-filter': { mode: 'lock', text: filter.text } } } } }]);
  const after = stillPromptPlan(o);
  assert.ok(after.text.includes(filter.text), 'the locked words are sent'); assert.ok(after.text.length <= 2500);
  assert.equal(after.sections.find(r => r.key === 'cam-filter').status, 'included');
  assert.ok(after.sections.some(r => r.status === 'cut' && r.policy === 'inherit'), 'an unlocked section went instead');
});

test('an override that directs the camera is saved but flagged; omitted sections are listed', () => {
  const p = project('final-lap'), s = p.shots[0];
  applyOps(p, [{ op: 'update_shot', id: s.id, patch: { promptSections: { video: { action: { mode: 'override', text: 'Slow dolly left, then a whip pan to the finish line.' } } } } }]);
  const plan = videoPromptPlan(p, s);
  assert.deepEqual(plan.sections.find(r => r.key === 'action').cameraWords, ['dolly left', 'whip pan']);
  assert.match(plan.cameraWarning, /directs the camera/);
  const big = project('breaking-news'), shot = big.shots.find(x => sectionedSegments(big, x, 'video').some(r => r.status === 'omitted'));
  assert.ok(shot, 'a starter shot has text the auto-prompt budget leaves out');
  assert.ok(videoPromptPlan(big, shot).sections.some(r => r.status === 'omitted' && /600 characters/.test(r.why)), 'and the plan says so');
});

test('record_prompt_version keeps a deduplicated, capped log; history diffs versions and takes', () => {
  const p = project('final-lap'), s = p.shots[0];
  const rec = (text, model = 'Seedance 2.5') => applyOps(p, [{ op: 'record_prompt_version', shotId: s.id, kind: 'video', version: { text, model, reason: 'quote', by: 'you' } }]);
  assert.equal(rec('First prompt.')[0].added, true);
  assert.equal(rec('First prompt.')[0].added, false, 'the same text and model is not repeated');
  rec('First prompt with a change.');
  assert.equal(s.promptVersions.video.length, 2);
  let list = []; for (let i = 0; i < MAX_PROMPT_VERSIONS + 5; i++) list = appendPromptVersion(list, { text: `v${i}` });
  assert.equal(list.length, MAX_PROMPT_VERSIONS); assert.equal(list.at(-1).text, `v${MAX_PROMPT_VERSIONS + 4}`);
  const h = promptHistory(p, s, 'video');
  assert.deepEqual(h.versions.map(v => v.text), ['First prompt.', 'First prompt with a change.']);
  const c = comparePrompts(p, s, 'video', h.versions[0].id, 'current', 'First prompt with a change.');
  assert.deepEqual(c.diff, [{ op: 'same', text: 'First prompt' }, { op: 'add', text: ' with a change' }, { op: 'same', text: '.' }]);
  assert.equal(c.added, 3);
  // Takes: each still keeps the exact prompt it was made with.
  s.references.push({ id: 'take-1', role: 'frame', note: 'key frame start', name: 't', file: 't.png', createdAt: '2026-10-31T10:00:00Z', generated: { prompt: 'Still prompt A.', presetId: 'flux-3', model: 'FLUX 3', seed: 1 } });
  s.references.push({ id: 'take-2', role: 'frame', note: 'key frame start', name: 't', file: 't.png', createdAt: '2026-10-31T11:00:00Z', generated: { prompt: 'Still prompt B.', presetId: 'flux-3', model: 'FLUX 3', seed: 2 } });
  const takes = promptHistory(p, s, 'image').takes;
  assert.deepEqual(takes.map(t => t.id).slice(-2), ['still:take-1', 'still:take-2'], 'after the starter’s own stills');
  assert.equal(comparePrompts(p, s, 'image', 'still:take-1', 'still:take-2').removed, 1);
});

test('word diff rebuilds both texts', () => {
  const pairs = [['', 'new'], ['old', ''], ['A red car turns left.', 'A blue car turns right, fast.'], ['Same.', 'Same.'], ['x '.repeat(3000), 'y '.repeat(3000)]];
  for (const [a, b] of pairs) {
    const d = wordDiff(a, b);
    assert.equal(d.filter(x => x.op !== 'add').map(x => x.text).join(''), a);
    assert.equal(d.filter(x => x.op !== 'del').map(x => x.text).join(''), b);
  }
  assert.deepEqual(diffStats(wordDiff('a b c', 'a c d')), { added: 1, removed: 1 });
  assert.deepEqual(mergePromptSections({ video: { action: { mode: 'override', text: 'A.' } } }, { video: { action: null } }), {});
  assert.equal(applySections([], [], { 'obj:gone': { mode: 'lock', text: 'Old.' } })[0].status, 'orphan');
});

test('model parameters come from the registry; saved settings apply to their model and drive the estimate', () => {
  const veo = preset('veo-31-flf-v1'), shot = { duration: 5 };
  const specs = Object.fromEntries(videoParamSpecs(veo, shot).map(x => [x.key, x]));
  assert.deepEqual(specs.duration.options, [4, 6, 8]); assert.equal(specs.duration.value, 4, 'auto: the length nearest the shot');
  assert.equal(specs.seed.editable, true); assert.equal(specs.resolution.editable, false); assert.match(specs.resolution.note, /not priced/);
  const s = { duration: 5, settings: normalizeShotSettings({ video: { model: 'veo-31-flf-v1', params: { seed: 7, duration: 6, resolution: '1080p' } } }) };
  const r = resolveVideoParams(veo, s);
  assert.deepEqual(r.parameters, { duration: 6, resolution: '720p', seed: 7 }); assert.equal(r.seconds, 6); assert.deepEqual(r.ignored, ['resolution'], 'a fixed setting is never sent');
  assert.equal(videoEstimate(veo, r.seconds), 1.2);
  assert.equal(settingsApply('veo-31-flf-v1', preset('veo-31-i2v-v1')), true, 'the start-only sibling keeps the saved seed and length');
  assert.equal(resolveVideoParams(preset('kling-40-i2v-v1'), s).parameters.seed, 42, 'another model keeps its own defaults');
  assert.equal(resolveVideoParams(preset('ltx-25-i2v-v1'), { duration: 3, settings: { video: { model: 'ltx-25-i2v-v1', params: { duration: 5 } } } }).parameters.duration, '5', 'LTX takes the length as a string');
  assert.deepEqual(Object.fromEntries(videoParamSpecs(preset('wan-vace-13b-edge-v1')).map(x => [x.key, x.editable])), { model: false, frames: false, steps: true, fps: false });
  assert.equal(videoCapabilities(preset('seedance-25-edit-v1')).inputs.blockoutClip, true);
  assert.deepEqual(resolveImageParams('flux-3', { settings: { image: { model: 'flux-3', params: { seed: 5, count: 3 } } } }), { count: 3, seed: 5 });
  assert.deepEqual(resolveImageParams('flux-2-pro', { settings: { image: { model: 'flux-3', params: { seed: 5, count: 3 } } } }), { count: 1, seed: null });
  assert.equal(savedClipSeconds(s, 'veo-31-flf-v1', [4, 6, 8]), 6);
  // The batch plans the saved clip length, so its reservation matches what is bound.
  const p = project('final-lap'), shot0 = p.shots[0];
  applyOps(p, [{ op: 'update_shot', id: shot0.id, patch: { settings: { video: { model: 'veo-31-flf-v1', params: { duration: 8 } } } } }]);
  assert.deepEqual(shot0.settings, { video: { model: 'veo-31-flf-v1', params: { duration: 8 } } });
  const plan = planBatch(p, { steps: ['videos'], models: { videos: 'veo-31-flf-v1' }, maxCostUsd: 100 });
  assert.equal(plan.nodes.find(n => n.id === `video:${shot0.id}`).estimateUsd, 1.6);
  applyOps(p, [{ op: 'update_shot', id: shot0.id, patch: { settings: { video: null } } }]);
  assert.equal(shot0.settings, undefined);
});
