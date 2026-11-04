import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Actual sequence helpers with simulated media; no renderer, provider or video encoding.
const source = await readFile(new URL('../src/director-sequence.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const exports = {};
runInNewContext(compiled, { exports, require: () => ({}) });
const original = { id: 'original', kind: 'camera-render', width: 1280, height: 720, fps: 24, frameCount: 96, duration: 4 };
const result = { id: 'result', kind: 'workflow-result', width: 1280, height: 720, fps: 24, frameCount: 97, duration: 4.041667, source: { sourceAssetId: 'original' } };

test('comparison selects the result’s original source and never a newer render', () => {
  const latest = { ...original, id: 'newer' };
  assert.equal(exports.comparisonSource([latest, original], result), original);
  assert.equal(exports.comparisonSource([latest], result), null);
  assert.equal(exports.comparisonSource([original], { ...result, source: {} }), null);
  assert.equal(exports.comparisonSource([{ ...original, kind: 'workflow-result' }], result), null);
});

test('comparison discloses the extra frame and original durations without fitting', () => {
  const text = exports.comparisonFacts(original, result);
  assert.match(text, /96 frames · 4\.00 s/);
  assert.match(text, /97 frames · 4\.04 s/);
  assert.match(text, /Timing differs/);
  assert.match(text, /shorter clip/);
  assert.match(text, /Originals are unchanged/);
  assert.equal(original.frameCount, 96);
  assert.equal(result.duration, 4.041667);
  assert.doesNotMatch(exports.comparisonFacts(original, { ...original }), /differs/);
});

test('comparison names FPS and resolution differences', () => {
  const text = exports.comparisonFacts(original, { ...result, width: 640, height: 360, fps: 30 });
  assert.match(text, /640×360 · 30 fps/);
  assert.match(text, /Resolution differs/);
  assert.match(text, /Timing differs/);
});

test('the comparison pauses its partner when either media ends', () => {
  const handlers = source.split('\n').filter(line => /^(  video|  over)\.addEventListener\('ended'/.test(line)).join('\n');
  assert.ok(handlers.includes('over.pause') && handlers.includes('video.pause'));
  const media = () => ({ hidden: false, paused: false, addEventListener(name, fn) { this[name] = fn; }, pause() { this.paused = true; } });
  const video = Object.assign(media(), { currentTime: 4, duration: 4 }), over = Object.assign(media(), { currentTime: 4.041667, duration: 4.041667 });
  runInNewContext(handlers, { video, over });
  video.ended(); assert.equal(over.paused, true); assert.equal(over.currentTime, 4, 'the extra result frame remains available only in Generated');
  over.currentTime = over.duration = 3; video.currentTime = 3.04;
  over.ended(); assert.equal(video.paused, true); assert.equal(video.currentTime, 3, 'a shorter result also stops both at the shared end');
});
