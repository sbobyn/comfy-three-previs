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
