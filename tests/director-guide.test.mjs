import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../src/director-guide.ts', import.meta.url), 'utf8');
const compile = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

// Actual guide callbacks, simulated native dialog/DOM; no browser or backend transport.
function harness() {
  const nodes = [];
  const document = { activeElement: null, getElementById: id => nodes.find(n => n.id === id && n.isConnected) || null };
  function h(tag, attrs = {}, ...children) {
    const listeners = {};
    const node = { tag, ...attrs, children: children.filter(Boolean), isConnected: false,
      addEventListener: (name, cb) => { listeners[name] = cb; },
      dispatch: (name, event) => listeners[name]?.(event),
      showModal() { this.open = true; },
      close() { this.open = false; listeners.close?.(); },
      remove() { this.isConnected = false; },
      focus() { document.activeElement = this; },
      scrollIntoView() { this.scrolled = true; },
      querySelector(selector) { return walk(this).find(n => n.tag === selector); },
    };
    nodes.push(node); return node;
  }
  document.body = { append(node) { node.isConnected = true; } };
  const opener = h('button'); opener.isConnected = true; opener.focus();
  const exports = {};
  runInNewContext(compile(source), { exports, require: () => ({ h }), document });
  return { ...exports, document, opener, dialog: () => document.getElementById('journey-dialog') };
}
function walk(node) { return [node, ...(node.children || []).flatMap(c => typeof c === 'object' ? walk(c) : [])]; }
function text(node) { return typeof node === 'string' ? node : (node.children || []).map(text).join(' '); }

test('the complete guide is read-only until an explicit navigation choice', () => {
  const g = harness(), visited = [];
  const actions = Object.fromEntries(g.JOURNEY.map(s => [s.id, () => visited.push(s.id)]));
  g.openJourney({ actions, context: 'Saved demo · 3 shots' });
  const dlg = g.dialog();
  assert.equal(dlg.open, true);
  assert.equal(walk(dlg).filter(n => n.tag === 'li').length, 7);
  assert.deepEqual(visited, []);
  assert.match(text(dlg), /Saved demo · 3 shots/);
  const navigation = walk(dlg).find(n => n.tag === 'button' && text(n) === 'Review render settings');
  navigation.onclick();
  assert.deepEqual(visited, ['capture']);
  assert.equal(g.dialog(), null);
});

test('launch guidance works without a project; close restores the invoking control', () => {
  const g = harness();
  g.openJourney({ stage: 'workflow' });
  const dlg = g.dialog();
  assert.equal(g.document.activeElement.tag, 'h3');
  assert.equal(text(g.document.activeElement), 'Review the AI request');
  assert.equal(walk(dlg).filter(n => n.tag === 'button').length, 1, 'no project means no workspace actions');
  assert.match(text(dlg), /Open or create a project/);
  let stopped = false;
  dlg.dispatch('keydown', { key: 'z', ctrlKey: true, stopPropagation: () => { stopped = true; } });
  assert.equal(stopped, true, 'workspace undo must not run behind the guide');
  dlg.close();
  assert.equal(g.document.activeElement, g.opener);
  assert.equal(g.dialog(), null);
});

test('all stages navigate only their supplied action and preserve qualification warnings', () => {
  const g = harness(), visited = [];
  for (const step of g.JOURNEY) {
    g.openJourney({ actions: { [step.id]: () => visited.push(step.id) } });
    const dlg = g.dialog(), copy = text(dlg);
    assert.match(copy, /first-frame\/key-frame animation receives stills/);
    assert.match(copy, /Local framewise SD was quality-rejected/);
    assert.match(copy, /Unknown acceptance is not cancellation/);
    assert.match(copy, /hardware qualification/);
    walk(dlg).find(n => n.tag === 'button' && text(n) === step.action).onclick();
  }
  assert.deepEqual(visited, Array.from(g.JOURNEY, s => s.id));
});

test('workspace guide opens existing controls without editing, capturing or generating', async () => {
  const workspace = await readFile(new URL('../src/director.ts', import.meta.url), 'utf8');
  const start = workspace.indexOf('function showJourney() {');
  const end = workspace.indexOf('\n// Draggable panel edges.', start);
  assert.ok(start > 0 && end > start);
  const calls = [];
  let options;
  const context = {
    project: { title: 'Scene', scene: { entities: [] }, shots: [{}] },
    collapsed: { side: true },
    openJourney: o => { options = o; },
    setMode: mode => calls.push(mode), setTab: tab => calls.push(tab),
    setCollapsed: (panel, value) => { calls.push([panel, value]); context.collapsed[panel] = value; },
    textarea: { focus: () => calls.push('direction focus') }, shotTab: { focus: () => calls.push('shot focus') },
    seqModeBtn: { focus: () => calls.push('sequence focus') },
    openLooks: () => calls.push('looks'), openRender: () => calls.push('render settings'),
    openAssets: () => calls.push('assets'), toast: msg => calls.push(msg),
  };
  runInNewContext(compile(workspace.slice(start, end)), context);
  context.showJourney();
  assert.deepEqual(calls, []);
  assert.match(options.context, /0 saved video assets/);
  options.actions.scene();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), ['scene', ['side', false], 'direct', 'direction focus']);
  calls.length = 0;
  for (const id of ['looks', 'shot', 'capture', 'workflow', 'compare', 'export']) options.actions[id]();
  assert.deepEqual(calls, ['looks', 'scene', 'shot', 'shot focus', 'scene', 'render settings', 'sequence', 'sequence focus', 'sequence', 'sequence focus', 'assets']);
  context.project = undefined; calls.length = 0;
  context.showJourney();
  assert.deepEqual(calls, ['Wait for the project to finish loading.']);
});
