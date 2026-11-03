// Source truth (launch blocker L3): stills made for an earlier blocking are never sent as current, on any path; free
// text that directs the camera is surfaced. The browser, batch and agent share shared/director.mjs videoReferences /
// keyStillState and the /api/director/video-refs route, so these checks cover all of them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { openDirector, directorRoutes } from '../server/previs/director.mjs';
import { builtInPresets } from '../server/previs/presets.mjs';
import { blockoutStale, castRows, keyStillState, objectLooks, shotSignature, videoReferences } from '../shared/director.mjs';
import { explainStale, staleText } from '../shared/regen.mjs';
import { shotPrompt } from '../shared/prompt.mjs';
import { FIRST_FRAME_FALLBACK } from '../shared/tiers.mjs';
import { cameraMotionWords, cameraMotionWarning, cameraSourceOf, CAMERA_LINES, CAMERA_SOURCE_LABELS, withCameraLine } from '../shared/camera-source.mjs';
import { blockoutFidelity, fidelityAdvice } from '../shared/blockout-fidelity.mjs';

const source = await readFile(new URL('../src/director.ts', import.meta.url), 'utf8');
const compile = s => ts.transpileModule(s, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const slice = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
// A tiny DOM stand-in: the workspace builds plain objects that we read as text.
const h = (tag, attrs = {}, ...children) => ({ tag, ...attrs, children: children.flat().filter(c => c != null && c !== false) });
const text = n => (n == null ? '' : typeof n === 'string' ? n : (n.children || []).map(text).join(' '));

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==';

test('a camera edit makes generated start/end stills stale: readiness says so and no path sends them', async () => {
  const director = await openDirector(await mkdtemp(join(tmpdir(), 'previs-source-truth-')));
  let p = await director.create({ template: 'street' });
  const s0 = p.shots[0], made = shotSignature(p, s0);
  // Generated key frames, made for the current blocking (as refgen records them), plus an uploaded mid-shot still.
  for (const at of ['start', 'end']) p = (await director.reference(p.id, { shotId: s0.id, role: 'frame', note: `key frame ${at}`, data: PNG, generated: { requestId: `req-${at}`, outputKey: 'o1', signature: made, model: 'FLUX 3' } })).project;
  let s = p.shots[0];
  assert.deepEqual([keyStillState(p, s).startState, keyStillState(p, s).endState], ['ready', 'ready']);
  assert.deepEqual(videoReferences(p, s, 4, { stills: true }).filter(r => r.role === 'frame').map(r => r.label), ['start still', 'end still']);

  // The review's repro: move the camera. Both stills now show the old framing.
  p = (await director.edit(p.id, [{ op: 'update_shot', id: s.id, patch: { camera: { angle: s.camera.angle + 40 } } }])).project; s = p.shots[0];
  const st = keyStillState(p, s);
  assert.deepEqual([st.startState, st.endState], ['stale', 'stale'], 'readiness reports stale, not "Start still ready"');
  assert.deepEqual(videoReferences(p, s, 4, { stills: true }).filter(r => r.role === 'frame'), [], 'stale stills never lead the look references');
  assert.deepEqual(videoReferences(p, s, 4).filter(r => r.role === 'frame'), [], 'nor ride along as the key-frame reference');

  // The shared route refuses them for start-frame models (browser, batch and agent all prepare through it).
  const engine = { get: () => ({ shots: [{ id: 'ps1', browser: { director: { shotId: s.id } } }], renders: [] }), append: () => { throw Error('nothing may be registered'); } };
  const route = directorRoutes(director, engine);
  const post = (path, body) => route('POST', new URL('http://x' + path), body);
  await assert.rejects(post('/api/director/video-refs', { projectId: p.id, shotId: s.id, previsShotId: 'ps1', max: 2, firstFrame: true, lastFrame: true }),
    e => e.status === 409 && e.apiCode === 'stale-still' && /start and end stills were made before the shot’s camera, timing or scene changed.*nothing was sent/.test(e.message));
  await assert.rejects(post('/api/director/video-refs', { projectId: p.id, shotId: s.id, previsShotId: 'ps1', max: 2, firstFrame: true, lastFrame: false }), e => e.apiCode === 'stale-still' && /The start still was/.test(e.message), 'a start-only model checks only the start');
  assert.deepEqual((await post('/api/director/video-refs', { projectId: p.id, shotId: s.id, previsShotId: 'ps1', max: 4, stills: true })).references.filter(r => r.role === 'frame'), [], 'a blockout model gets no stale look stills');

  // An uploaded still is the artist's choice and never stale; a new generated still for the new blocking is ready.
  p = (await director.reference(p.id, { shotId: s.id, role: 'frame', note: 'key frame end', data: PNG })).project;
  p = (await director.reference(p.id, { shotId: s.id, role: 'frame', note: 'key frame start', data: PNG, generated: { requestId: 'req-new', outputKey: 'o1', signature: shotSignature(p, p.shots[0]), model: 'FLUX 3' } })).project;
  assert.deepEqual([keyStillState(p, p.shots[0]).startState, keyStillState(p, p.shots[0]).endState], ['ready', 'ready']);
});

test('camera-motion words in free text are found outside the camera line; object motion is not', () => {
  assert.deepEqual(cameraMotionWords('Slow dolly left, whip pan to the car.'), ['dolly left', 'whip pan']);
  assert.deepEqual(cameraMotionWords('The runner sprints. Crane down as the camera pushes in; tracking shot.'), ['Crane down', 'camera pushes', 'tracking shot']);
  assert.deepEqual(cameraMotionWords('Zoom in on the badge, pan left across the street, handheld'), ['Zoom in', 'pan left', 'handheld']);
  for (const line of Object.values(CAMERA_LINES)) assert.deepEqual(cameraMotionWords(withCameraLine('The actor turns, the car speeds across the frame and a frying pan sizzles; the crane swings the cargo.', line === CAMERA_LINES.blockout ? 'blockout' : line === CAMERA_LINES.keyframes ? 'keyframes' : 'still')), [], 'camera lines and object motion are fine');
  assert.equal(cameraMotionWarning('A quiet street.'), '');
  assert.match(cameraMotionWarning('Whip pan to the car.', 'blockout'), /“Whip pan”.*camera comes from the blockout clip/);
  assert.match(cameraMotionWarning('Dolly in.', 'keyframes'), /start and end stills/);
});

test('workspace: the model input card reports stale stills after a camera edit (not “ready”), and the End choice is explicit', async () => {
  const director = await openDirector(await mkdtemp(join(tmpdir(), 'previs-source-truth-ui-')));
  let p = await director.create({ template: 'street' });
  for (const at of ['start', 'end']) p = (await director.reference(p.id, { shotId: p.shots[0].id, role: 'frame', note: `key frame ${at}`, data: PNG, generated: { requestId: `req-${at}`, outputKey: 'o1', signature: shotSignature(p, p.shots[0]), model: 'FLUX 3' } })).project;
  const def = builtInPresets.find(d => d.id === 'ltx-25-flf-v1'), choices = builtInPresets.filter(d => d.task === 'first-frame');
  const card = project => {
    const ctx = { h, project, genCache: { presets: choices, definitions: [], jobs: [] }, shotModel: () => def, videoChoices: st => st.presets, modelLabel: d => d.title, referenceCapacity: () => 0, plannedReferences: () => [],
      cameraSourceOf, keyStillState, shotPrompt, cameraMotionWarning, CAMERA_SOURCE_LABELS, castRows, objectLooks, signature: shotSignature, clipSeconds: () => 5, clipLengths: () => '2–10 s', startOnlyFallback: d => FIRST_FRAME_FALLBACK[d.id],
      modelInputsDiagram: () => h('div'), middleSlotText: () => null, refUrl: r => r.file, fromBlender: () => false, localStorage: { setItem() {} }, shotPane: { dataset: {} }, KIND_COLORS: {}, entity: () => null,
      blockoutFidelity, fidelityAdvice, runEntry: async () => {}, blockoutOld: s => blockoutStale(project, s), blockoutWhy: s => staleText(explainStale(project, { type: 'blockout', shotId: s.id })), noCloudKey: () => false, isLocalModel: () => false, NO_KEY: '', openSetup() {} };
    runInNewContext(compile(slice('function modelBlock(s: Shot) {', '// ---------- Shot panel sections')), ctx);
    return text(ctx.modelBlock(project.shots[0]));
  };
  const before = card(p);
  assert.match(before, /Start still ready/); assert.match(before, /End still ready/);
  assert.match(before, /Start \+ end stills \+ text · Direction is a guess/, 'how faithfully the route keeps blockout direction (heuristic)');
  p = (await director.edit(p.id, [{ op: 'update_shot', id: p.shots[0].id, patch: { camera: { angle: 40 }, description: 'Slow dolly left, whip pan to the car.' } }])).project;
  const after = card(p);
  assert.doesNotMatch(after, /still ready/, 'the review saw “Start still ready” / “End still ready” here after the edit');
  assert.match(after, /Start still is out of date: the camera, timing or scene changed/); assert.match(after, /End still is out of date/);
  assert.match(after, /or choose to animate the start still alone with LTX 2\.5 Pro when you generate/, 'the start-only path is offered as a choice, not taken silently');
  assert.match(after, /Camera words.*“dolly left”, “whip pan”/, 'free text that directs the camera is flagged');
});

test('workspace: a Blender shot’s still guide is the imported frame from the server, without proxy markers', async () => {
  const calls = [], captures = [];
  const ctx = { h, projectId: 'proj', scene: { capture: (...a) => { captures.push(a); return 'data:image/png;base64,UFJPWFk='; } }, api: async (path, body) => { calls.push({ path, body }); return { data: 'QkxFTkRFUg==', mime: 'image/png', source: 'blender', frame: 0 }; } };
  runInNewContext(compile(slice('const blenderGuides = new Map', '/** "Matches blockout 8/10"')), ctx);
  const shot = { id: 'shot', render: { assetId: 'clip' } };
  const b = ctx.guideFrame(shot, 0, true);
  assert.equal(await b.data, 'data:image/png;base64,QkxFTkRFUg=='); assert.equal(captures.length, 0, 'no proxy capture for an imported clip');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), { path: 'director/frame', body: { projectId: 'proj', shotId: 'shot', t: 0, width: 1280, height: 720, guide: true } });
  assert.equal(b.img.src, 'data:image/png;base64,QkxFTkRFUg=='); assert.equal(b.img.alt, 'Blender frame');
  await ctx.guideFrame(shot, 0, true).data; assert.equal(calls.length, 1, 'cached per clip and time');
  const proxy = ctx.guideFrame(shot, 1, false);
  assert.equal(await proxy.data, 'data:image/png;base64,UFJPWFk='); assert.equal(captures.length, 1);
  const composer = slice('function keyFrameBlock(s: Shot) {', '/** Image 1 of a still');
  assert.match(composer, /markers: !blender/, 'the prompt drops the proxy-marker legend for a Blender frame');
  assert.match(composer, /guide: \(await guide\.data\)\.split/, 'the request sends the previewed guide');
  assert.doesNotMatch(composer, /scene\.capture\(t, 1280, 720/, 'the composer never captures the proxy itself');
});

test('workspace: the video quote card shows the effective camera, output seconds and final prompt, and flags camera words', () => {
  const ctx = { announce() {}, announceQuote() {}, refocus() {}, h, cameraMotionWarning, CAMERA_SOURCE_LABELS, planFacts: () => null, api: async () => ({}), setTimeout() {} };
  runInNewContext(compile(slice('function genQuote(', '// ---------- Live sync')), ctx);
  const job = { id: 'job', fingerprint: 'fp', cameraSource: 'still', quote: { status: 'unknown' }, validation: { compatible: true }, sources: { firstFrame: { id: 'img' } }, binding: { prompt: 'Whip pan to the car. Hold the still’s framing; keep the camera move subtle and consistent with it.' } };
  const card = text(ctx.genQuote(job, { title: 'LTX 2.5 Pro · start still', pricing: { ratePerSecond: 0.172 } }, { backend: { kind: 'cloud' } }, { duration: 5 }, { est: 0.8, seconds: 4, cameraSource: 'still', prompt: 'ignored: the bound prompt wins' }));
  assert.match(card, /Camera: from still \(approximate\)/);
  assert.match(card, /4s \(shot 5s\)/, 'the seconds the model makes, next to the shot length');
  assert.match(card, /≈ \$0\.800 estimate/, 'the prepared estimate for those seconds, not rate × shot length');
  assert.match(card, /Final prompt · exactly what is sent.*Whip pan to the car/);
  assert.match(card, /“Whip pan”.*camera comes from the start still/);
});
