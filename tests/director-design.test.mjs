import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
// Pure helpers for the Cut overlay and compare strip (same harness as director-desktop.test.mjs).
const load = file => { const exports = {}; runInNewContext(ts.transpileModule(readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports, structuredClone }); return exports; };
const core = load('director-design-core.ts');
const plain = x => JSON.parse(JSON.stringify(x));

test('the overlay boxes the subject and the described cast, not set dressing or the environment', () => {
  const cast = [
    { id: 'tower', kind: 'prop', lead: false, coverage: 0.9, hero: 1 },
    { id: 'track', kind: 'environment', lead: false, coverage: 1, hero: 2 },
    { id: 'rival', kind: 'vehicle', lead: false, coverage: 0.4, hero: 2 },
    { id: 'comfy', kind: 'vehicle', lead: true, coverage: 0.3, hero: 2 },
    { id: 'fan', kind: 'character', lead: false, coverage: 0.2, hero: 2 },
  ];
  assert.deepEqual(core.overlayCast(cast).map(c => c.id), ['comfy', 'rival', 'fan']);
  assert.deepEqual(core.overlayCast(cast, 2).map(c => c.id), ['comfy', 'rival']);
  // With fewer than two described objects in frame, the biggest others fill in.
  assert.deepEqual(core.overlayCast([cast[0], { ...cast[3], hero: 0 }]).map(c => c.id), ['comfy', 'tower']);
});

test('a prompt excerpt is 6–10 words: a whole clause when one fits, else ten words and an ellipsis', () => {
  assert.equal(core.promptExcerpt('Stock car race car in ComfyUI livery: electric blue body with bold yellow stripes and number 1.'), 'Stock car race car in ComfyUI livery');
  assert.equal(core.promptExcerpt('A tall news anchor in a navy suit stands behind the glass desk and reads'), 'A tall news anchor in a navy suit stands behind…');
  assert.equal(core.promptExcerpt('Bald eagle, wings spread.'), 'Bald eagle, wings spread');
  const n = core.promptExcerpt('one two three four five six seven eight nine ten eleven twelve').replace('…', '').split(' ').length;
  assert.ok(n >= 6 && n <= 10);
});

test('chips sit beside their boxes, in height order, never overlapping and inside the frame', () => {
  const boxes = [{ id: 'a', x0: 0.1, x1: 0.3, y0: 0.4, y1: 0.6 }, { id: 'b', x0: 0.2, x1: 0.4, y0: 0.42, y1: 0.5 }, { id: 'c', x0: 0.6, x1: 0.9, y0: 0.9, y1: 1 }];
  const slots = plain(core.layoutChips(boxes, 0.2, 0.04, 0.08));
  const left = slots.filter(s => s.side === 'l');
  assert.deepEqual(left.map(s => s.id), ['b', 'a'], 'the higher box gets the higher chip');
  assert.ok(Math.abs(left[1].y - left[0].y) >= 0.2 - 1e-9, 'stacked at least one chip apart');
  const c = slots.find(s => s.id === 'c');
  assert.equal(c.side, 'r'); assert.ok(c.y <= 1 - 0.08 - 0.2 + 1e-9, 'pushed up above the controls');
  for (const s of slots) assert.ok(s.y >= 0.04);
  assert.deepEqual(plain(core.leaderFrom({ x0: 0.5, x1: 0.7, y0: 0.2, y1: 0.4 }, 'l')), [0.58, 0.30000000000000004]);
});

test('compare bands run blockout → start still → each version, newest per model first, labelled by model', () => {
  const v = (id, at, workflow) => ({ id, createdAt: at, source: { workflow } });
  const versions = [v('f1', '2026-10-30T17:05', 'LTX 2.5 Fast · animate the key frame (draft)'), v('p1', '2026-10-30T19:20', 'LTX 2.5 Pro · animate the key frame'), v('f2', '2026-10-30T19:53', 'LTX 2.5 Fast · animate the key frame (draft)'), v('k1', '2026-10-30T18:00', 'Kling 4.0 · edit the complete video')];
  const bands = plain(core.compareBands({ id: 'b' }, { id: 's' }, versions));
  assert.deepEqual(bands.map(b => `${b.role}:${b.id}:${b.label}`), ['blockout:b:Blockout', 'still:s:Start still', 'video:f2:LTX 2.5 Fast · take 2', 'video:p1:LTX 2.5 Pro', 'video:k1:Kling 4.0', 'video:f1:LTX 2.5 Fast · take 1']);
  assert.equal(core.compareBands({ id: 'b' }, null, versions, 2).map(b => b.label).join(' | '), 'Blockout | LTX 2.5 Fast | LTX 2.5 Pro', 'one take per model needs no take number');
  assert.equal(core.modelOf({ source: {} }), 'Generated');
});

test('the compare sweep starts all-blockout, ends at equal bands, and a dragged seam stays between its neighbours', () => {
  assert.deepEqual(plain(core.bandStops(4)), [25, 50, 75]);
  assert.deepEqual(plain(core.sweepStops(4, 0)), [100, 100, 100]);
  assert.deepEqual(plain(core.sweepStops(4, 1)), [25, 50, 75]);
  const mid = core.sweepStops(4, 0.4);
  assert.ok(mid[0] < mid[2] || mid[2] === 100, 'the first seam leads');
  assert.ok(mid.every(x => x >= 25 && x <= 100));
  assert.deepEqual(plain(core.moveStop([25, 50, 75], 1, 10)), [25, 27, 75]);
  assert.deepEqual(plain(core.moveStop([25, 50, 75], 2, 120)), [25, 50, 98]);
  assert.deepEqual(plain(core.moveStop([25, 50, 75], 0, -5)), [2, 50, 75]);
});

test('the Cut view puts the viewer above the rows and offers Overlay and Compare', () => {
  const seq = readFileSync(new URL('../src/director-sequence.ts', import.meta.url), 'utf8');
  const layout = seq.slice(seq.indexOf("const el = h('section', { class: 'sequence'"), seq.indexOf('// ---------- Board ----------'));
  assert.ok(layout.indexOf("'sq-viewer'") < layout.indexOf("'sq-toolbar'"), 'viewer first, then the toolbar and rows');
  assert.match(seq, /\['blockout', 'generated', 'compare', 'overlay'\]/);
  assert.match(seq, /ctx\.boxes\?\.\(s/, 'boxes come from the live scene through the shot camera');
  assert.match(readFileSync(new URL('../src/director.ts', import.meta.url), 'utf8'), /boxes: \(s, t\) => scene\.boxesAt\(s, t\)/);
});

test('the home hero sweeps once — all blockout, all generated, then rests at the middle — and starters reveal on scrub', () => {
  assert.equal(core.heroSweepAt(0), 100);
  assert.equal(Math.round(core.heroSweepAt(0.6)), 0);
  assert.equal(core.heroSweepAt(1), 50);
  assert.equal(core.heroSweepAt(2), 50, 'clamped after the sweep');
  const xs = Array.from({ length: 11 }, (_, i) => core.heroSweepAt(i / 10));
  assert.ok(xs.every(x => x >= 0 && x <= 100));
  const home = readFileSync(new URL('../src/director-home.ts', import.meta.url), 'utf8');
  assert.match(home, /starterMedia\('final-lap'/, 'the hero is The draft');
  assert.match(home, /sweep: 'once'/);
  assert.match(home, /reveal: true/, 'starter cards play the generated loop and scrub the blockout in');
  const media = readFileSync(new URL('../src/director-media.ts', import.meta.url), 'utf8');
  assert.match(media, /set\(o\.reveal \? 0 :/, 'a reveal card starts on the generated frame');
});

test('the Generate dialog leads with model · runs on · estimate · Generate, and quotes before anything runs', () => {
  assert.equal(core.dialogEstimate({ pricing: { ratePerSecond: 0.16 } }, 4, 'cloud'), '≈ $0.64');
  assert.equal(core.dialogEstimate({ pricing: {} }, 4, 'cloud'), 'Priced at quote');
  assert.equal(core.dialogEstimate({ pricing: { ratePerSecond: 0.16 } }, 4, 'local'), 'Free · local');
  const src = readFileSync(new URL('../src/director.ts', import.meta.url), 'utf8');
  const open = src.slice(src.indexOf('function openRender()'), src.indexOf('// ---------- In-app video generation'));
  assert.match(open, /rg-controls.*hWf.*hBackend.*hEst.*hGo/s, 'the header row holds the decision');
  assert.match(open, /labels: \['Blockout', 'Start still'\]/, 'blockout ↔ start still seam when a still exists');
  assert.match(open, /modelInputsDiagram\(def\.task/);
  // Generate never submits: it makes the blockout if needed, then presses the quote button (approval stays in the quote card).
  const go = open.slice(open.indexOf('hGo.onclick'), open.indexOf('const dlg ='));
  assert.match(go, /\.gen-quote/); assert.doesNotMatch(go, /generation\/submit/);
});
