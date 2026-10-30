import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { Selection } from '../shared/editor-controls.mjs';

// Run the actual UI callbacks with a simulated scene; no browser or backend is contacted.
const source = await readFile(new URL('../src/director.ts', import.meta.url), 'utf8');
const compile = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

test('additive and marquee selections expose the contextual object controls', () => {
  const selection = new Selection(), tabs = [], frames = [];
  const start = source.indexOf('  onClickSelect(id, mode) {');
  const end = source.indexOf('  onContextMenu(', start);
  assert.ok(start > 0 && end > start);
  const context = { selection, scene: { view: () => 'set', frame: ids => frames.push([...ids]) }, setTab: tab => tabs.push(tab) };
  runInNewContext(compile(`globalThis.callbacks = {${source.slice(start, end)}};`), context);
  context.callbacks.onClickSelect('car', 'replace');
  context.callbacks.onClickSelect('tree', 'add');
  context.callbacks.onClickSelect('tree', 'toggle');
  context.callbacks.onMarquee(['tree', 'lamp']);
  assert.deepEqual(selection.ids, ['car', 'tree', 'lamp']);
  assert.deepEqual(tabs, ['object', 'object', 'object', 'object']);
  assert.deepEqual(frames, [['car']], 'additive selection keeps the current framing');
});

test('object description editing records the original value for undo', async () => {
  const start = source.indexOf('  notes.onchange =', source.indexOf('function renderObjectPane()'));
  const end = source.indexOf('\n  const styleText', start);
  assert.ok(start > 0 && end > start);
  const original = 'Original appearance. '.repeat(24), notes = { value: 'New appearance' }, entries = [];
  let refreshed = 0;
  runInNewContext(compile(source.slice(start, end)), {
    notes, e: { id: 'car', notes: original },
    runEntry: async entry => { entries.push(JSON.parse(JSON.stringify(entry))); },
    rerender: () => refreshed++,
  });
  notes.onchange();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].redo, [{ op: 'update_entity', id: 'car', patch: { notes: 'New appearance' } }]);
  assert.deepEqual(entries[0].undo, [{ op: 'update_entity', id: 'car', patch: { notes: original } }]);
  assert.equal(refreshed, 1);
});
