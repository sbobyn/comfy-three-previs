import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
// Pure desktop helpers, transpiled and run without a browser (same harness as director-mobile.test.mjs).
const load = file => { const exports = {}; runInNewContext(ts.transpileModule(readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports, structuredClone }); return exports; };
const mobile = load('director-mobile-core.ts');

test('a mouse window from 880 px keeps the desktop workspace; touch tablets keep the tablet layout', () => {
  const tier = (width, height, touch) => mobile.tierOf(q => ({ matches: q === mobile.QUERIES.compact ? width <= 699 : q === mobile.QUERIES.medium ? width >= 700 && width <= 1023 : q === mobile.QUERIES.short ? height <= 500 : q === mobile.QUERIES.desk ? width >= 880 : touch }));
  assert.equal(tier(880, 900, false).tier, null);
  assert.equal(tier(1024, 768, false).tier, null);
  assert.equal(tier(879, 900, false).tier, 'medium');
  assert.equal(tier(900, 1200, true).tier, 'medium', 'an iPad-sized touch screen stays on the tablet layout');
  assert.equal(tier(844, 390, true).tier, 'compact', 'phone landscape is still theatre');
  assert.equal(tier(390, 844, true).tier, 'compact');
});
