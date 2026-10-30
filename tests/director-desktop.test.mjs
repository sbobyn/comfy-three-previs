import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
// Pure desktop helpers, transpiled and run without a browser (same harness as director-mobile.test.mjs).
const load = file => { const exports = {}; runInNewContext(ts.transpileModule(readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports, structuredClone }); return exports; };
const mobile = load('director-mobile-core.ts');
const plain = x => JSON.parse(JSON.stringify(x)); // values made in the vm context have its prototypes

test('a mouse window from 880 px keeps the desktop workspace; touch tablets keep the tablet layout', () => {
  const tier = (width, height, touch) => mobile.tierOf(q => ({ matches: q === mobile.QUERIES.compact ? width <= 699 : q === mobile.QUERIES.medium ? width >= 700 && width <= 1023 : q === mobile.QUERIES.short ? height <= 500 : q === mobile.QUERIES.desk ? width >= 880 : touch }));
  assert.equal(tier(880, 900, false).tier, null);
  assert.equal(tier(1024, 768, false).tier, null);
  assert.equal(tier(879, 900, false).tier, 'medium');
  assert.equal(tier(900, 1200, true).tier, 'medium', 'an iPad-sized touch screen stays on the tablet layout');
  assert.equal(tier(844, 390, true).tier, 'compact', 'phone landscape is still theatre');
  assert.equal(tier(390, 844, true).tier, 'compact');
});

const core = load('director-desktop-core.ts');
const shot = (refs = [], o = {}) => ({ id: 's1', title: 'The dive', description: '', duration: 4, camera: { move: 'static', target: null, distance: 5, height: 1.6, angle: 0, mm: 35 }, references: refs, render: null, cast: { include: [], exclude: [] }, ...o });
const frame = (id, note, name = id) => ({ id, name, file: `${id}.png`, mime: 'image/png', role: 'frame', entityId: null, note, createdAt: '' });

test('the top bar offers one primary action per step and follows what the shot has', () => {
  const f = { castNeed: 0, keyFrames: false, hasStart: false, hasEnd: false, exportOk: true, exportReason: '', exportBusy: false };
  assert.equal(core.stepAction('build', f).label, 'Cast looks');
  assert.match(core.stepAction('build', { ...f, castNeed: 2 }).title, /2 cast members/);
  assert.equal(core.stepAction('shoot', f).label, 'Generate video', 'a blockout-clip model needs no still');
  const still = core.stepAction('shoot', { ...f, keyFrames: 'start' });
  assert.deepEqual([still.kind, still.label, still.at], ['still', 'Generate still', 'start']);
  assert.equal(core.stepAction('shoot', { ...f, keyFrames: 'start', hasStart: true }).label, 'Generate video');
  assert.equal(core.stepAction('shoot', { ...f, keyFrames: 'start+end', hasStart: true }).at, 'end');
  assert.equal(core.stepAction('shoot', { ...f, keyFrames: 'start+end', hasStart: true, hasEnd: true }).kind, 'video');
  assert.equal(core.stepAction('cut', f).label, 'Export film');
  const blocked = core.stepAction('cut', { ...f, exportOk: false, exportReason: 'Make a blockout for every shot in the cut first (1 missing)' });
  assert.equal(blocked.disabled, true); assert.match(blocked.title, /1 missing/);
  assert.equal(core.stepAction('cut', { ...f, exportBusy: true }).label, 'Exporting…');
});

test('the status strip names the step’s state, with a short form for narrow windows', () => {
  const s = shot([frame('a', 'key frame start')], { render: { previsShotId: 'x' } });
  const p = { scene: { entities: [{ shape: 'person' }, { shape: 'group' }] }, shots: [s], assets: [{ kind: 'workflow-result', shotId: 's1' }] };
  assert.deepEqual(plain(core.stepStatus('build', p, s, { stale: false, videos: 0, castNeed: 1, castTotal: 3 })), { parts: ['1 object', '1 of 3 cast need images'], short: '1 need images' });
  assert.deepEqual(plain(core.stepStatus('shoot', p, s, { stale: true, videos: 1, castNeed: 0, castTotal: 0 })), { parts: ['Shot 01', 'The dive', 'blockout changed', '1 still', '1 video'], short: 'blockout changed' });
  assert.deepEqual(plain(core.stepStatus('cut', p, s, { stale: false, videos: 1, castNeed: 0, castTotal: 0 }).short), '1/1 video');
  assert.deepEqual(plain(core.keyFrameSlots({ id: 'ltx-25-flf-v1', task: 'first-frame', inputs: { lastFrame: {} } })), ['start', 'end']);
  assert.deepEqual(plain(core.keyFrameSlots({ id: 'x', task: 'transform-video' }, { x: { keyFrames: true } })), ['start'], 'the preset’s keyFrames flag counts');
  assert.deepEqual(plain(core.keyFrameSlots({ id: 'wan', task: 'transform-video' })), []);
});

test('rail pips show blockout, still and video, with running jobs, and the filmstrip uses the still nearest mid-shot', () => {
  const s = shot([frame('a', 'key frame start'), frame('b', 'key frame @1.5s'), frame('c', 'key frame @1.5s'), frame('d', 'key frame end')], { render: { previsShotId: 'x' } });
  assert.deepEqual(plain(core.shotPips(s, { stale: false, videos: 0, stillRunning: false, videoRunning: false })), { blockout: 'ok', still: 'ok', video: 'none', label: 'Blockout ready · 4 stills · no video' });
  const run = core.shotPips(s, { stale: true, videos: 2, stillRunning: true, videoRunning: true });
  assert.deepEqual([run.blockout, run.still, run.video], ['changed', 'run', 'run']);
  assert.equal(run.label, 'Scene changed since the blockout · 4 stills (one generating) · 2 videos (one generating)');
  assert.equal(core.shotPips(shot(), { stale: false, videos: 0, stillRunning: false, videoRunning: false }).blockout, 'none');
  assert.equal(core.midStill(s).id, 'c', 'the newest take at the moment nearest mid-shot');
  assert.equal(core.midStill(shot([frame('u', 'something else')])), null, 'unpinned stills are not placed on the strip');
  assert.equal(core.midStill(shot()), null);
});

test('the shot scrubber places shots in the Cut’s order, with shots left out of the cut at the end', () => {
  const p = { shots: [shot([], { id: 'a', duration: 2 }), shot([], { id: 'b', duration: 3 }), shot([], { id: 'c', duration: 4 })] };
  assert.deepEqual(plain(core.filmSegments(p)), { segments: [{ shotId: 'a', start: 0, duration: 2, inCut: true }, { shotId: 'b', start: 2, duration: 3, inCut: true }, { shotId: 'c', start: 5, duration: 4, inCut: true }], total: 9 });
  p.edit = { clips: [{ shotId: 'c' }, { shotId: 'a' }] };
  const f = core.filmSegments(p);
  assert.deepEqual(plain(f.segments.map(x => [x.shotId, x.start, x.inCut])), [['c', 0, true], ['a', 4, true], ['b', 6, false]]);
});

test('changes from Claude are described in plain words and undone exactly; the user’s own job results are not counted', () => {
  const ent = (id, name, o = {}) => ({ id, name, kind: 'character', shape: 'person', position: [0, 0, 0], rotation: 0, scale: [1, 1, 1], color: '#fff', notes: '', ...o });
  const base = () => ({ title: 'Wingspan', scene: { environment: { preset: 'stage', description: '' }, entities: [ent('e1', 'Eagle'), ent('e2', 'Elk')] }, shots: [shot([], { id: 's1', title: 'The valley' })] });
  const a = base(), b = base();
  b.shots.push(shot([], { id: 's2', title: 'The dive' }));
  let x = core.externalChanges(a, b);
  assert.equal(x.text, 'Claude added The dive');
  assert.deepEqual(plain(x.undo), [{ op: 'remove_shot', id: 's2' }]);
  assert.deepEqual(plain(core.externalChanges(b, a).undo)[0].op, 'add_shot', 'the reverse diff re-applies it (redo)');
  const c = base(); c.scene.entities[0].position = [2, 0, 0];
  x = core.externalChanges(a, c);
  assert.equal(x.text, 'Claude moved Eagle'); assert.deepEqual(plain(x.ids), ['e1']);
  assert.deepEqual(plain(x.undo), [{ op: 'update_entity', id: 'e1', patch: { position: [0, 0, 0] } }]);
  const d = base(); d.scene.entities[1].notes = 'Bull elk'; d.scene.entities.push(ent('e3', 'Hawk')); d.shots[0].camera = { ...d.shots[0].camera, move: 'dolly-in' };
  x = core.externalChanges(a, d);
  assert.equal(x.text, 'Claude added Hawk and 2 more changes');
  assert.deepEqual(plain(x.undo), [{ op: 'remove_entity', id: 'e3' }, { op: 'update_entity', id: 'e2', patch: { notes: '' } }, { op: 'update_shot', id: 's1', patch: { camera: a.shots[0].camera } }]);
  const e = base(); e.shots[0].references.push(frame('f1', 'key frame start')); e.shots[0].render = { previsShotId: 'x' };
  assert.equal(core.externalChanges(a, e), null, 'stills and blockouts are the user’s own jobs');
  const gone = base(); gone.shots = []; a.shots[0].references.push(frame('f1', 'key frame start'));
  assert.equal(core.externalChanges(a, gone).undo, null, 'a removed shot with stills cannot be brought back whole, so no Undo');
});

test('the first-run tour shows once, on a new project', () => {
  const p = { revision: 2, createdAt: '2026-10-30T10:00:00Z', scene: { entities: [{}] } };
  const now = Date.parse('2026-10-30T12:00:00Z');
  assert.equal(core.shouldTour(p, null, now), true);
  assert.equal(core.shouldTour(p, '1', now), false, 'never again once dismissed');
  assert.equal(core.shouldTour({ ...p, revision: 40 }, null, now), false, 'an old, much-edited project is not new');
  assert.equal(core.shouldTour({ ...p, revision: 40, createdAt: '2026-10-30T11:50:00Z' }, null, now), true, 'a starter opened minutes ago is');
  assert.equal(core.shouldTour({ ...p, scene: { entities: [] } }, null, now), false, 'the empty stage has its own Start here card');
  assert.deepEqual(plain(core.TOUR.map(t => t.id)), ['block', 'cast', 'shoot', 'generate']);
});

test('a starter card’s seam pairs its blockout and generated video, falls back to stills, then to the blockout frame', () => {
  const e = (id, kind = 'image', label = '') => ({ id, file: `${id}.${kind === 'video' ? 'mp4' : 'webp'}`, kind, label });
  const entries = [e('final-lap-s2-blockout', 'video'), e('final-lap-s2-generated', 'video', 'Final Lap · The draft'), e('final-lap-s2-blockout-poster'), e('final-lap-s2-generated-poster'),
    e('final-lap-cast-2', 'image', 'Comfy car'), e('final-lap-cast-10', 'image', 'Pit crew'), e('final-lap-cast-1', 'image', 'Fan'), e('final-lap-sheet'),
    e('wingspan-s2-still-blockout'), e('wingspan-s2-still'), e('wingspan-cast-1', 'image', 'Eagle'), e('generate-before', 'video')];
  const fl = plain(core.starterMedia('final-lap', entries));
  assert.deepEqual([fl.kind, fl.before, fl.after, fl.posters], ['video', 'final-lap-s2-blockout.mp4', 'final-lap-s2-generated.mp4', ['final-lap-s2-blockout-poster.webp', 'final-lap-s2-generated-poster.webp']]);
  assert.deepEqual(fl.cast.map(c => c.label), ['Fan', 'Comfy car', 'Pit crew'], 'cast images in number order; the design sheet is not one');
  const ws = plain(core.starterMedia('wingspan', entries));
  assert.deepEqual([ws.kind, ws.before, ws.after, ws.cast.length], ['image', 'wingspan-s2-still-blockout.webp', 'wingspan-s2-still.webp', 1]);
  assert.deepEqual(plain(core.starterMedia('breaking-news', entries)), { kind: 'still', cast: [] }, 'no media: the card keeps its blockout frame');
  assert.equal(core.starterMedia('final', entries).kind, 'still', 'slugs match whole words only');
});

test('the seam moves by keyboard: arrows step 5, Shift 20, Home and End jump, and it stays in 0–100', () => {
  assert.equal(core.seamKey(50, 'ArrowRight'), 55);
  assert.equal(core.seamKey(50, 'ArrowLeft', true), 30);
  assert.equal(core.seamKey(98, 'ArrowUp'), 100);
  assert.equal(core.seamKey(3, 'ArrowDown'), 0);
  assert.equal(core.seamKey(40, 'Home'), 0);
  assert.equal(core.seamKey(40, 'End'), 100);
  assert.equal(core.seamKey(40, 'Enter'), null, 'other keys are left alone');
});

test('“Use this take” makes an earlier take the one in use, and undo restores the previous one', async () => {
  const { createProjectDocument, applyOps } = await import('../server/previs/director.mjs');
  const p = createProjectDocument({ template: 'street' }), s = p.shots[0];
  s.references.push(frame('a', 'key frame start'), frame('m', 'key frame @2s'), frame('b', 'key frame start'), frame('e', 'key frame end'));
  const entry = core.useTakeEntry(s, 'a');
  assert.deepEqual(plain(entry), { label: 'Use take at start', redo: [{ op: 'use_take', shotId: s.id, referenceId: 'a' }], undo: [{ op: 'use_take', shotId: s.id, referenceId: 'b' }] });
  assert.equal(core.useTakeEntry(s, 'b'), null, 'the take in use needs no change');
  assert.equal(core.useTakeEntry(s, 'nope'), null);
  applyOps(p, plain(entry.redo));
  const start = () => s.references.filter(r => r.note === 'key frame start').at(-1).id;
  assert.equal(start(), 'a', 'the server sends the newest start take to key-frame models');
  assert.equal(core.moments(s)[0].takes.at(-1).id, 'a');
  applyOps(p, plain(entry.undo));
  assert.equal(start(), 'b');
  assert.throws(() => applyOps(p, [{ op: 'use_take', shotId: s.id, referenceId: 'missing' }]), /Unknown still/);
  const copy = plain(core.keyFrameCopy(s, s.references.find(r => r.id === 'm'), 'end'));
  assert.deepEqual(copy, { role: 'frame', note: 'key frame end', name: 'm · end (from 2s)' }, 'a mid-shot still copied as the end key frame keeps its own moment');
  assert.equal(core.stillTime(s, { note: 'key frame end' }), s.duration);
});
