// Exact-frame key stills (shared/keyframes.mjs): the frame model, start/end/in-between roles and their freshness, the
// edit ops, which registry video models really take timed in-between frames, the timing plan, and still grading
// against the exact guide frame. Nothing here reaches a server or provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FPS, frameCount, resolveFrame, momentSeconds, stillFrame, keyframeState, keyframePlan, middleFrameTarget, maxMiddleFrames, withMiddleFrames, evenFrames, TIMED_KEYFRAMES } from '../shared/keyframes.mjs';
import { keyStills, keyStillState, shotSignature, stillStale } from '../shared/director.mjs';
import { describeFrame } from '../shared/still-match.mjs';
import { applyOps, openDirector } from '../server/previs/director.mjs';
import { builtInPresets } from '../server/previs/presets.mjs';
import { validateGraph, validateWorkflowDefinition } from '../server/previs/workflows.mjs';
import { openRefgen } from '../server/previs/refgen.mjs';
import { backendSnapshot } from '../server/previs/backends.mjs';
import { cameraSourceOf } from '../shared/camera-source.mjs';

const liveInfo = JSON.parse(await readFile(new URL('./fixtures/partner-object-info.json', import.meta.url), 'utf8'));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');
const plain = x => JSON.parse(JSON.stringify(x));

async function project(duration = 5) {
  const director = await openDirector(await mkdtemp(join(tmpdir(), 'previs-keyframes-')));
  let p = await director.create({ template: 'street' });
  p = (await director.edit(p.id, [{ op: 'update_shot', id: p.shots[0].id, patch: { duration } }])).project;
  return { director, p };
}
// A generated still made for the shot as it is now, at an exact blockout frame.
async function still(director, p, index, extra = {}) {
  const s = p.shots[0], f = resolveFrame(p, s, { frame: index });
  const note = f.frameAt === 'start' ? 'key frame start' : f.frameAt === 'end' ? 'key frame end' : `key frame @${f.frameAt}s`;
  const r = await director.reference(p.id, { shotId: s.id, role: 'frame', note, name: `still ${index}`, data: PNG.toString('base64'), generated: { requestId: `req-${index}-${Math.random()}`, outputKey: 'o', model: 'FLUX 3', signature: shotSignature(p, s), frame: { index, fps: FPS, count: f.count, t: f.t }, ...extra } });
  return { p: r.project, id: r.referenceId };
}

test('frames: 24 fps, start is frame 0 and end is the last encoded frame, not the shot length', async () => {
  const { p } = await project(5), s = p.shots[0];
  assert.equal(frameCount(p, s), 120);
  assert.deepEqual(plain(resolveFrame(p, s, { at: 'start' })), { index: 0, t: 0, count: 120, role: 'start', frameAt: 'start' });
  const end = resolveFrame(p, s, { at: 'end' });
  assert.deepEqual([end.index, end.role, end.frameAt], [119, 'end', 'end']);
  assert.equal(end.t, 119 / 24, 'the review’s 4.958 s, not 5.000 s');
  assert.equal(resolveFrame(p, s, { at: 5 }).index, 119, 'seconds snap to the nearest encoded frame, inside the clip');
  assert.deepEqual([resolveFrame(p, s, { at: 2.5 }).index, resolveFrame(p, s, { at: 2.5 }).frameAt], [60, 2.5]);
  assert.equal(resolveFrame(p, s, { frame: 60 }).t, 2.5);
  assert.throws(() => resolveFrame(p, s, { frame: 120 }), /0 to 119/);
  assert.throws(() => resolveFrame(p, s, { frame: 1.5 }), /whole frame number/);
  assert.throws(() => resolveFrame(p, s, {}), /Choose a frame/);
  // Notes keep two decimals; each of the 120 frames still reads back as itself.
  for (let i = 0; i < 120; i++) assert.equal(Math.round(momentSeconds(i) * FPS), i);
  // A current Blender clip keeps its own frame count.
  const b = structuredClone(p); b.shots[0].render = { origin: 'blender', frameCount: 12, duration: 0.5, signature: shotSignature(b, b.shots[0]) };
  assert.equal(frameCount(b, b.shots[0]), 12);
});

test('stills read their frame: recorded index, start/end notes, @t notes, and an older End made at the shot length', async () => {
  const { p } = await project(4), s = p.shots[0];
  assert.deepEqual(plain(stillFrame(p, s, { note: 'key frame @2.5s' })), { index: 60, t: 2.5, exact: true, override: false });
  assert.deepEqual(plain(stillFrame(p, s, { note: 'key frame @2.37s' })), { index: 57, t: 2.37, exact: false, override: false }, 'not on a frame: approximate');
  assert.deepEqual(plain(stillFrame(p, s, { note: 'key frame end' })), { index: 95, t: 4, exact: false, override: false }, 'an older End: the camera end pose, not an encoded frame');
  assert.deepEqual(plain(stillFrame(p, s, { note: 'key frame end', generated: { frame: { index: 95 } } })), { index: 95, t: 95 / 24, exact: true, override: false });
  assert.equal(stillFrame(p, s, { note: '' }), null);
});

test('key frames: pinned in-between frames use the newest take there and go stale with the camera; shortened shots drop them', async () => {
  let { director, p } = await project(5);
  ({ p } = await still(director, p, 0)); ({ p } = await still(director, p, 119)); ({ p } = await still(director, p, 60));
  const { p: p2, id: newer } = await still(director, p, 60); p = p2;
  p = (await director.edit(p.id, [{ op: 'set_middle_keys', shotId: p.shots[0].id, frames: [60, 90] }])).project;
  let st = keyframeState(p, p.shots[0]);
  assert.deepEqual([st.start.state, st.end.state, st.start.index, st.end.index], ['ready', 'ready', 0, 119]);
  assert.deepEqual(st.middle.map(m => [m.index, m.state]), [[60, 'ready'], [90, 'missing']]);
  assert.equal(st.middle[0].ref.id, newer, 'the newest take at a pinned frame is the one used');
  // A camera edit: every still made for the old blocking is stale (the same rule as keyStillState, the L3 fix).
  p = (await director.edit(p.id, [{ op: 'update_shot', id: p.shots[0].id, patch: { camera: { angle: 35 } } }])).project;
  st = keyframeState(p, p.shots[0]);
  assert.deepEqual([st.start.state, st.end.state, st.middle[0].state], ['stale', 'stale', 'stale']);
  assert.deepEqual([keyStillState(p, p.shots[0]).startState, keyStillState(p, p.shots[0]).endState], ['stale', 'stale']);
  // Shorter shot: frame 90 no longer falls inside 2 s (48 frames).
  p = (await director.edit(p.id, [{ op: 'update_shot', id: p.shots[0].id, patch: { duration: 2 } }])).project;
  const short = keyframeState(p, p.shots[0]).middle.find(m => m.index === 90);
  assert.deepEqual([short.state, short.outOfRange], ['missing', true]);
});

test('ops: set_middle_keys validates; use_as_key_still makes an override that keeps its frame and goes stale with the shot', async () => {
  let { director, p } = await project(5);
  let mid; ({ p, id: mid } = await still(director, p, 60));
  const s = () => p.shots[0];
  assert.throws(() => applyOps(structuredClone(p), [{ op: 'set_middle_keys', shotId: s().id, frames: [0] }]), /between the first and last frame/);
  assert.throws(() => applyOps(structuredClone(p), [{ op: 'set_middle_keys', shotId: s().id, frames: [1, 2, 3, 4, 5, 6, 7, 8, 9] }]), /up to 8/);
  p = (await director.edit(p.id, [{ op: 'set_middle_keys', shotId: s().id, frames: [72, 30, 72] }])).project;
  assert.deepEqual(s().middleKeys, [30, 72], 'sorted, unique');
  p = (await director.edit(p.id, [{ op: 'set_middle_keys', shotId: s().id, frames: [] }])).project;
  assert.equal(s().middleKeys, undefined, 'cleared');

  const r = await director.edit(p.id, [{ op: 'use_as_key_still', shotId: s().id, referenceId: mid, role: 'start' }]); p = r.project;
  const copy = s().references.find(x => x.id === r.results[0].id);
  assert.equal(keyStills(s()).start.id, copy.id, 'the override is the start key frame every video path picks');
  assert.equal(copy.file, s().references.find(x => x.id === mid).file, 'shares the image file');
  assert.deepEqual(plain(stillFrame(p, s(), copy)), { index: 60, t: 2.5, exact: true, override: true }, 'remembers it shows frame 60');
  assert.equal(copy.generated.requestId, undefined, 'not mistaken for a new output during result collection');
  assert.equal(stillStale(p, s(), copy), false);
  p = (await director.edit(p.id, [{ op: 'update_shot', id: s().id, patch: { camera: { height: 3 } } }])).project;
  assert.equal(stillStale(p, s(), s().references.find(x => x.id === copy.id)), true, 'the old client-side copy dropped provenance and never went stale; this one does');
  assert.equal(keyStillState(p, s()).startState, 'stale');
  assert.throws(() => applyOps(structuredClone(p), [{ op: 'use_as_key_still', shotId: s().id, referenceId: mid, role: 'middle' }]), /start or end/);
});

test('registry truth: only Kling 4.0 start → end takes timed in-between frames; the variant validates against the live schema', () => {
  const video = builtInPresets.filter(d => ['first-frame', 'transform-video', 'control-video'].includes(d.task));
  assert.deepEqual(video.filter(d => maxMiddleFrames(d) > 0).map(d => d.id), ['kling-40-flf-v1']);
  assert.equal(middleFrameTarget(builtInPresets.find(d => d.id === 'kling-40-i2v-v1')), null, 'start-only Kling: middle frames have no defined spacing without an end');
  // Every timed spec matches what the captured live schema really offers.
  for (const [node, spec] of Object.entries(TIMED_KEYFRAMES)) {
    const grow = JSON.stringify(liveInfo[node]?.input);
    assert.match(grow, /"middle_frames":\["COMFY_AUTOGROW_V3"/, `${node} takes middle_frames`);
    assert.equal(JSON.parse(grow).required.model[1].options[0].inputs.optional.middle_frames[1].template.names.length, spec.max);
  }
  for (const name of ['LtxApi25ImageToVideo', 'ByteDance2FirstLastFrameNode', 'Veo3FirstLastFrameNode', 'MinimaxHailuo03FirstLastFrameNode', 'Wan2ImageToVideoApi'].filter(n => liveInfo[n]))
    assert.doesNotMatch(JSON.stringify(liveInfo[name].input), /middle_frame/, `${name} takes first/last frames only`);

  const kling = builtInPresets.find(d => d.id === 'kling-40-flf-v1'), d = withMiddleFrames(kling, 2);
  assert.notEqual(d, kling); assert.equal(withMiddleFrames(builtInPresets.find(x => x.id === 'veo-31-flf-v1'), 2).id, 'veo-31-flf-v1', 'others are unchanged');
  assert.deepEqual(Object.keys(d.inputs).filter(k => /^middleFrame/.test(k)), ['middleFrame1', 'middleFrame2']);
  assert.deepEqual(d.graph['2'].inputs['model.middle_frames.middle_frame_1'], ['mid1', 0]);
  assert.equal(d.provenance.middleFrames, 2); assert.equal(d.provenance.presetId, 'kling-40-flf-v1');
  assert.equal(cameraSourceOf(d), 'keyframes');
  const def = validateWorkflowDefinition({ ...d, id: 'saved' });
  const deferredInputs = Object.entries(def.inputs).filter(([k]) => k !== 'prompt').map(([, m]) => ({ ...m, kind: 'image', mime: 'image/png', filename: 'x.png' }));
  const v = validateGraph(structuredClone(def.graph), liveInfo, { deferredInputs });
  assert.equal(v.compatible, true, JSON.stringify(v.issues));
});

test('plan: Kling places in-between frames evenly and the plan shows each one’s drift; other models list them as not sent', async () => {
  let { director, p } = await project(5);
  ({ p } = await still(director, p, 0)); ({ p } = await still(director, p, 119)); ({ p } = await still(director, p, 30)); ({ p } = await still(director, p, 80));
  p = (await director.edit(p.id, [{ op: 'set_middle_keys', shotId: p.shots[0].id, frames: [30, 80] }])).project;
  const s = p.shots[0], kling = builtInPresets.find(d => d.id === 'kling-40-flf-v1');
  const plan = keyframePlan(p, s, kling, { seconds: 5 });
  assert.deepEqual([plan.start.index, plan.end.index], [0, 119]);
  assert.deepEqual(plan.middle.map(m => [m.index, m.slot, m.atSeconds]), [[30, 1, 1.667], [80, 2, 3.333]]);
  assert.equal(plan.middle[0].blockoutSeconds, Math.round((30 / 119) * 5 * 1000) / 1000);
  assert.deepEqual(plan.evenFrames, evenFrames(120, 2)); assert.deepEqual(plan.evenFrames, [40, 79]);
  assert.equal(plan.warnings.length, 1, 'frame 30 lands 0.41 s late; frame 80 is within a quarter second');
  assert.match(plan.warnings[0], /frame 30 lands at 1\.67 s of the 5 s clip, 0\.41 s later than in the blockout\. Frames 40, 79 land exactly/);
  for (const id of ['veo-31-flf-v1', 'ltx-25-i2v-v1', 'seedance-25-edit-v1']) {
    const other = keyframePlan(p, s, builtInPresets.find(d => d.id === id), { seconds: 5 });
    assert.equal(other.middle.length, 0); assert.deepEqual(other.unused.map(u => u.index), [30, 80], `${id} lists what it does not take`);
  }
  assert.match(keyframePlan(p, s, builtInPresets.find(d => d.id === 'veo-31-flf-v1')).unused[0].why, /only a start and an end frame/);
  assert.match(keyframePlan(p, s, builtInPresets.find(d => d.id === 'seedance-25-edit-v1')).unused[0].why, /follows the blockout clip/);
});

test('grading: a still is graded against its exact guide frame and that frame’s camera words from when it was requested', async () => {
  const { openBudget } = await import('../server/previs/budget.mjs');
  const root = await mkdtemp(join(tmpdir(), 'previs-keyframes-grade-'));
  const budget = await openBudget(join(root, 'budget'), { env: {} });
  const director = await openDirector(root);
  let p = await director.create({ template: 'street' });
  p = (await director.edit(p.id, [{ op: 'update_shot', id: p.shots[0].id, patch: { duration: 5, camera: { move: 'orbit' } } }])).project;
  const graded = [];
  const backend = input => ({
    snapshot: backendSnapshot(input),
    async inspect() { return { objectInfo: structuredClone(liveInfo) }; },
    async upload(bytes, o) { return { value: `previs/${o.filename}` }; },
    async submit(req) { if (req.graph[3]?.class_type === 'GeminiNodeV3') { graded.push(req.graph); return { promptId: 'grade-1' }; } return { promptId: 'still-1' }; },
    async history(id) { return id === 'grade-1' ? { status: { completed: true, status_str: 'success' }, outputs: { 4: { text: ['{"camera":9,"layout":8,"headings":8,"score":8,"why":"close"}'] } } } : { status: { completed: true, status_str: 'success' }, outputs: { 2: { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } } }; },
    async view() { return PNG; },
  });
  const refgen = await openRefgen(root, director, { backend, allowPaid: true, budget, grader: 'gemini' });
  const s = p.shots[0], words = describeFrame(p, s, 2.5).text;
  const job = await refgen.prepare({ projectId: p.id, target: 'shot', shotId: s.id, frame: 60, presetId: 'flux-2-pro', prompt: 'Image 1 is the blockout.', aspect: '16:9', count: 1, seed: 3, guide: PNG.toString('base64') });
  assert.deepEqual(plain(job.frame), { index: 60, fps: 24, count: 120, t: 2.5 }); assert.equal(job.frameAt, 2.5);
  assert.equal(job.gradePlan, words);
  await refgen.submit({ projectId: p.id, requestId: job.id, approval: { approved: true, fingerprint: job.fingerprint, allowance: { currency: 'USD', maxAmount: 1, allowUnknownCharges: true } } });
  // The shot changes before the still lands: the grade still judges the frame that was requested, not today’s shot.
  p = (await director.edit(p.id, [{ op: 'update_shot', id: s.id, patch: { camera: { angle: 60 } } }])).project;
  assert.notEqual(describeFrame(p, p.shots[0], 2.5).text, words);
  const done = await refgen.track({ projectId: p.id, requestId: job.id });
  assert.equal(done.status, 'completed');
  assert.ok(graded[0][3].inputs['model.prompt'].includes(words), 'the grader reads frame 60’s camera words from the request');
  assert.match(words, /Frame 2\.5s into/);
  const ref = (await director.get(p.id)).shots[0].references.find(r => r.id === done.referenceIds[0]);
  assert.equal(ref.note, 'key frame @2.5s');
  assert.deepEqual(plain(ref.generated.frame), { index: 60, fps: 24, count: 120, t: 2.5 });
  assert.equal(ref.generated.guideSha, job.guide.sha256, 'the still is paired with its guide image');
  assert.deepEqual([ref.generated.guideMatch.score, ref.generated.guideMatch.frame, ref.generated.guideMatch.guideSha], [8, 60, job.guide.sha256]);

  // The last encoded frame is the End: its camera words say so.
  const end = await refgen.prepare({ projectId: p.id, target: 'shot', shotId: s.id, frame: 119, presetId: 'flux-2-pro', prompt: 'x', aspect: '16:9', count: 1, seed: 4, guide: PNG.toString('base64') });
  assert.equal(end.frameAt, 'end'); assert.match(end.gradePlan, /^Camera: Last frame of /);
  await assert.rejects(refgen.prepare({ projectId: p.id, target: 'shot', shotId: s.id, frame: 120, presetId: 'flux-2-pro', prompt: 'x', aspect: '16:9', count: 1, seed: 4, guide: PNG.toString('base64') }), /0 to 119/);
});
