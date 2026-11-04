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
  const selection = new Selection(), frames = [], pivots = [];
  let opened = 0, view = 'set';
  const start = source.indexOf('  onClickSelect(id, mode) {');
  const end = source.indexOf('  onContextMenu(', start);
  assert.ok(start > 0 && end > start);
  const entities = new Map(['car', 'tree', 'lamp'].map(id => [id, { id }]));
  const scene = { view: () => view, pivotOn: id => pivots.push(id), frame: ids => frames.push([...ids]), focusOn: e => frames.push([e.id]) };
  const context = { selection, entity: id => entities.get(id) || null, scene, openObject: () => opened++ };
  runInNewContext(compile(`globalThis.callbacks = {${source.slice(start, end)}};`), context);
  context.callbacks.onClickSelect('car', 'replace');
  context.callbacks.onClickSelect('tree', 'add');
  context.callbacks.onClickSelect('tree', 'toggle');
  context.callbacks.onMarquee(['tree', 'lamp']);
  assert.deepEqual(selection.ids, ['car', 'tree', 'lamp']);
  assert.equal(opened, 4, 'every non-empty selection opens the object controls');
  assert.deepEqual(pivots, ['car'], 'only a replacing click moves the orbit pivot');
  assert.deepEqual(frames, [], 'selection never reframes the camera');
  view = 'shot';
  context.callbacks.onClickSelect('lamp', 'replace');
  assert.deepEqual(selection.ids, ['lamp']);
  assert.deepEqual(pivots, ['car'], 'the shot camera view keeps its pivot');
  assert.deepEqual(frames, []);
  context.callbacks.onClickSelect(null, 'replace');
  assert.deepEqual(selection.ids, []);
  assert.equal(opened, 5, 'clearing the selection opens nothing');
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
