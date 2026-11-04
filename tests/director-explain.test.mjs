import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../src/director-explain.ts', import.meta.url), 'utf8');
function harness() {
  const frames = [], timers = [], exports = {};
  let constructions = 0;
  const h = (tag, attrs = {}, ...children) => ({ tag, ...attrs, children, isConnected: true,
    classList: { add() {} }, addEventListener() {}, setAttribute(k, v) { this[k] = v; },
    append(...nodes) { this.children.push(...nodes); }, remove() { this.isConnected = false; },
  });
  const host = h('div');
  const document = { hidden: false, addEventListener() {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
    exports, require: name => name === 'three' ? { WebGLRenderer: class { constructor() { constructions++; throw new Error('No WebGL'); } } } : { h, KIND_COLORS: {}, LAYOUTS: {} },
    document, window: { setTimeout: f => timers.push(f) }, clearTimeout() {},
    requestAnimationFrame: f => frames.push(f), cancelAnimationFrame() {}, performance: { now: () => 0 },
    matchMedia: () => ({ matches: true }),
  });
  return { ...exports, host, document, frames, constructions: () => constructions };
}
test('all seven unique explainers mount and dispose without WebGL', () => {
  const g = harness();
  assert.deepEqual(Array.from(g.EXPLAINERS, x => x.id), ['navigate', 'select', 'transform', 'groups', 'animate', 'fly', 'camera-rig']);
  const mounted = g.EXPLAINERS.map(x => g.mountExplainer(g.host, x.id));
  assert.equal(g.constructions(), 0, 'renderer is lazy');
  g.frames.shift()(0);
  assert.equal(g.constructions(), 1, 'one guarded shared construction');
  for (const fig of g.host.children) assert.equal(fig.children[1].children[1].textContent.startsWith('Animated example:'), false);
  for (const m of mounted) { assert.equal(typeof m.dispose, 'function'); m.dispose(); m.dispose(); }
  assert.ok(g.host.children.every(n => !n.isConnected));
  g.mountExplainer(g.host, 'missing').dispose();
});
test('hidden document does not allocate WebGL', () => {
  const g = harness(); g.document.hidden = true;
  g.mountExplainer(g.host, 'navigate'); g.frames.shift()(0);
  assert.equal(g.constructions(), 0);
});
