import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
const core = {};
runInNewContext(ts.transpileModule(readFileSync(new URL('../src/director-mobile-core.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports: core });

test('mobile tiers preserve desktop and use theatre on a short landscape phone', () => {
  const tier = (width, height, touch) => core.tierOf(q => ({ matches: q === core.QUERIES.compact ? width <= 699 : q === core.QUERIES.medium ? width >= 700 && width <= 1023 : q === core.QUERIES.short ? height <= 500 : touch }));
  assert.equal(tier(390, 844, true).tier, 'compact');
  assert.equal(tier(768, 1024, true).tier, 'medium');
  assert.equal(tier(844, 390, true).short, true);
  assert.equal(tier(1280, 900, false).classes.length, 0);
});
test('sheet drag settles by distance and flick can dismiss only past peek', () => {
  assert.equal(core.nextDetent('half', -300, 0), 'full');
  assert.equal(core.nextDetent('half', 10, 0.6), 'peek');
  assert.equal(core.nextDetent('peek', 1, 0.6), null);
  assert.equal(core.nextDetent('full', -100, -0.8), 'full');
});
test('touch slop distinguishes tap, hold, drag, pinch and twist', () => {
  const p = [{ x: 0, y: 0 }], pair = [...p, { x: 100, y: 0 }];
  assert.equal(core.classify(p, [{ x: 7, y: 0 }], 100), 'tap');
  assert.equal(core.classify(p, p, 500), 'long-press');
  assert.equal(core.classify(p, [{ x: 20, y: 0 }], 100), 'drag');
  assert.equal(core.classify(pair, [...p, { x: 150, y: 0 }], 100), 'pinch');
  assert.equal(core.classify(pair, [...p, { x: 0, y: 100 }], 100), 'twist');
});
test('cut reorder clamps to board and leaves input order unchanged', () => {
  assert.equal(core.reorderIndex(1, -500, 72, 4), 0);
  assert.equal(core.reorderIndex(1, 500, 72, 4), 3);
  const a = ['a', 'b', 'c'];
  assert.equal(core.moved(a, 0, 2).join(), 'b,c,a');
  assert.equal(a.join(), 'a,b,c');
});
test('floor drag ray meets the floor and rejects upward rays', () => {
  const hit = core.floorHit({ p: [0, 10, 10], look: [0, 0, 0], mm: 35 }, 0, 0, 1);
  assert.ok(hit.every(n => Math.abs(n) < 1e-9));
  assert.equal(core.floorHit({ p: [0, 10, 10], look: [0, 20, 0], mm: 35 }, 0, 0, 1), null);
});
