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
  assert.equal(core.dialogEstimate({ pricing: { ratePerSecond: 0.16 } }, 4, 'cloud'), '≈ $0.64 for 4s');
  assert.equal(core.dialogEstimate({ pricing: {} }, 4, 'cloud'), 'Priced at quote');
  // Review L1: a paid partner graph run through Local ComfyUI is never labelled free.
  assert.equal(core.dialogEstimate({ pricing: { ratePerSecond: 0.16 } }, 4, 'local'), '≈ $0.64 for 4s · partner model, billed on Local too');
  assert.equal(core.dialogEstimate({ pricing: { ratePerSecond: 0 } }, 4, 'local'), 'Free · local');
  assert.equal(core.dialogEstimate({ pricing: {} }, 4, 'local'), 'Priced at quote', 'an unpriced graph is priced at the quote, not assumed free');
  assert.equal(core.dialogEstimate({ id: 'wan-vace-13b-edge-v1', pricing: {} }, 4, 'local'), 'Free · local', 'native local graph');
  const src = readFileSync(new URL('../src/director.ts', import.meta.url), 'utf8');
  const open = src.slice(src.indexOf('function openRender()'), src.indexOf('// ---------- In-app video generation'));
  assert.match(open, /rg-controls.*hWf.*hBackend.*hEst.*hGo/s, 'the header row holds the decision');
  assert.match(open, /labels: \['Blockout', 'Start still'\]/, 'blockout ↔ start still seam when a still exists');
  assert.match(open, /modelInputsDiagram\(def\.task/);
  // Generate never submits: it makes the blockout if needed, then presses the quote button (approval stays in the quote card).
  const go = open.slice(open.indexOf('hGo.onclick'), open.indexOf('const dlg ='));
  assert.match(go, /\.gen-quote/); assert.doesNotMatch(go, /generation\/submit/);
});

test('cast rows sharing one image fold into a family named by what the names share', () => {
  assert.equal(core.familyLabel(['Turns 3–4 · surface 1', 'Turns 3–4 · surface 2', 'Turns 3–4 · surface 12'], 'x'), 'Turns 3–4 · surface');
  assert.equal(core.familyLabel(['Infield grass', 'Start-finish line', 'Front stretch 1'], 'Infield grass'), 'Infield grass', 'no shared start: the image owner’s name');
  assert.equal(core.familyLabel(['Comfy car'], 'x'), 'Comfy car');
  const rows = [{ id: 'a', name: 'Rival car', source: 'r.png' }, { id: 'b', name: 'Surface 1', source: 's.png' }, { id: 'c', name: 'Surface 2', source: 's.png' }, { id: 'd', name: 'Comfy car', source: 'd' }];
  const fams = plain(core.castFamilies(rows, () => 'owner'));
  assert.deepEqual(fams.map(f => [f.label, f.ids.length]), [['Rival car', 1], ['Surface', 2], ['Comfy car', 1]]);
  const src = readFileSync(new URL('../src/director.ts', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('function castBlock('), src.indexOf('/** Add any image already in the project'));
  assert.match(block, /cast-set/, 'set pieces sit in one collapsed Set group');
  assert.match(block, /In this shot · \$\{hero\.length\}/, 'the count is the hero cast');
  assert.match(src, /`× \$\{names\.size\} objects`/, 'the Generate dialog lists each image once, × N objects');
});

// The transport at 1024 / 880 / 1440 window widths: the stage's transport is 461 / 396 / 776 px wide there
// (measured in the workspace). Real stylesheet, the transport's real markup, headless Chrome.
const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);
const chrome = await (async () => { try { require.resolve('playwright-core'); return (await import('../server/previs/headless.mjs')).resolveExecutable(); } catch { return null; } })();
test('transport at 1024: Fly camera stays whole on the first row, keys and scrubber move to a second row', { skip: !chrome && 'no local Chromium/Chrome or playwright-core' }, async () => {
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--disable-background-networking'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 760 } });
    await page.route('**/*', route => route.abort());
    const row = `<div class="transport-row"><button class="btn sm icon" type="button" aria-label="Play">▶</button><span class="time"><span>0.00s / 4.00s</span><span class="t-film"> · film 0.00s</span></span><div class="kf-nav"><button class="btn ghost sm icon" type="button">‹◆</button><button class="btn ghost sm icon" type="button">◆</button><button class="btn ghost sm icon" type="button">◆›</button></div><div class="scrubwrap"><input type="range" min="0" max="4" step="0.01" aria-label="Playhead"></div><span class="movechip">Crane down on Rival car, 40mm normal, high angle, 4s</span><div class="fly"><button class="fly-btn" type="button"><i class="fly-dot"></i><span>Fly camera</span></button><button class="fly-device" type="button"><span>Keyboard</span><span class="chev">▾</span></button></div></div>`;
    await page.setContent(`<div id="w"><div class="transport"><div class="film-track"></div>${row}</div></div>`);
    await page.addStyleTag({ content: readFileSync(new URL('../src/director.css', import.meta.url), 'utf8') });
    const measure = width => page.evaluate(w => {
      document.querySelector('#w').style.width = `${w}px`;
      const r = s => document.querySelector(s).getBoundingClientRect();
      const t = r('.transport'), fly = r('.fly'), dev = r('.fly-device'), play = r('.transport-row > .btn'), scrub = r('.scrubwrap'), keys = r('.kf-nav');
      return { flyWhole: fly.left >= t.left && fly.right <= t.right + 0.5 && dev.width > 20, secondRow: scrub.top >= play.bottom - 1 && keys.top >= play.bottom - 1, scrubWide: scrub.width / t.width, sameRowAsFly: Math.abs(play.top - fly.top) < 8 };
    }, width);
    const at1024 = await measure(461);
    assert.ok(at1024.flyWhole, 'Fly camera, with its device menu, is not clipped');
    assert.ok(at1024.secondRow, 'keys and the scrubber are on the second row');
    assert.ok(at1024.sameRowAsFly && at1024.scrubWide > 0.6);
    const at880 = await measure(396);
    assert.ok(at880.flyWhole && at880.secondRow);
    const at1440 = await measure(776);
    assert.ok(at1440.flyWhole); assert.equal(at1440.secondRow, false, 'a wide stage keeps one row');
  } finally { await browser.close(); }
});

test('Claude’s example asks use the hero cast and include one end-to-end ask with a budget', () => {
  const p = { title: 'Starter · Final Lap', shots: [{ camera: { target: 'rival' } }, { camera: { target: 'comfy' } }, { camera: { target: 'comfy' } }],
    scene: { entities: [{ id: 'flag', name: 'Flag stand', kind: 'prop' }, { id: 'tower', name: 'Light tower 1', kind: 'prop', lookFrom: 'flag' }, { id: 'track', name: 'Oval track', kind: 'environment', notes: 'banked' }, { id: 'rival', name: 'Rival car', kind: 'vehicle', notes: 'black' }, { id: 'comfy', name: 'Comfy car', kind: 'vehicle', notes: 'blue' }], references: [{ entityId: 'comfy' }, { entityId: 'flag' }] } };
  assert.deepEqual(plain(core.heroCast(p)), ['Comfy car', 'Rival car', 'Flag stand']);
  const asks = core.claudeExamples(p);
  assert.equal(asks.length, 3);
  assert.match(asks[0], /^Orbit Comfy car .*Rival car/); assert.match(asks[1], /Rival car’s colours red.*start still/);
  assert.match(asks[2], /under \$1/); assert.match(asks[2], /Quote first/);
  assert.ok(asks.every(a => !/Flag stand|Light tower|Oval track/.test(a)), 'never the dullest objects');
  assert.match(core.claudeExamples(null)[0], /the main character/);
  const common = readFileSync(new URL('../src/director-common.ts', import.meta.url), 'utf8');
  const dlg = common.slice(common.indexOf('export function claudeDialog'));
  assert.match(dlg, /code-head.*copy/s, 'Copy sits in the header row');
  assert.match(dlg, /PREVIS_ALLOW_PAID=1/); assert.match(dlg, /not a hard cap/);
  assert.doesNotMatch(dlg, /still requires your explicit approval/, 'no overclaim about approval');
});

test('demo mode: no Cloud status, the notice in the header (never over the transport), no camera.html', () => {
  const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const shim = read('src/demo-shim.ts');
  assert.doesNotMatch(shim, /camera\.html/, 'the retired camera studio is not linked');
  assert.match(shim, /url === '\/index\.html'.*return BASE \+ url\.slice\(11\)/s);
  assert.doesNotMatch(shim, /bottom:12px/, 'the floating notice no longer sits at the bottom, over the transport');
  assert.match(shim, /querySelector<HTMLElement>\('\.demo-badge'\)/, 'it steps aside for the page’s own badge');
  const snap = read('scripts/snapshot-demo.mjs');
  assert.doesNotMatch(snap, /rename\(/); assert.match(snap, /rm\(join\(out, 'camera\.html'\)/);
  assert.match(read('src/director-home.ts'), /setup && !DEMO \? setupStatus/, 'the home hides Cloud status in the demo');
  assert.match(read('src/director.ts'), /DEMO \? demoBadge\(\) : null/);
  assert.match(read('src/director-common.ts'), /export const DEMO = Boolean\(import\.meta\.env\.VITE_DEMO\)/);
});

test('one vocabulary and one CTA colour: the glossary’s terms are the UI’s terms', () => {
  const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const glossary = read('docs/glossary.md');
  for (const term of ['**Cast image**', '**Blockout**', '**Make blockout**', '**Remake blockout**', '**Compare**', '**Overlay**', '`--cta`']) assert.ok(glossary.includes(term), term);
  // UI strings (quoted text, not comments) use the glossary's words.
  const { readdirSync } = require('node:fs');
  const ui = readdirSync(new URL('../src/', import.meta.url)).filter(f => f.endsWith('.ts') && f !== 'director-agent.ts').map(f => read(`src/${f}`).split('\n').filter(l => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n')).join('\n');
  const quoted = ui.match(/'[^'\n]*'|`[^`\n]*`/g).join('\n');
  for (const old of ['Cast looks', 'Make again', 'Cast Card', 'Looks board', 'as a look for', 'object’s look']) assert.doesNotMatch(quoted, new RegExp(old), old);
  assert.match(ui, /s\.render \? 'Remake blockout' : 'Make blockout'/, 'Make the first time, Remake after');
  assert.match(ui, /s\.render \? 'Remake blockout…' : 'Make blockout…'/, 'the action bar says Remake after a change too');
  assert.doesNotMatch(ui, /\$\{setCount\} look|'image' : 'look'/, 'the set and families say shared image, not look');
  // The primary action shares one token on desktop and mobile; coral stays on the camera.
  assert.match(read('src/director.css'), /\.btn\.cta \{ background: var\(--cta\)/);
  assert.match(read('src/director.css'), /\.btn\.primary, \.btn\.camera \{ background: var\(--cta\)/);
  assert.doesNotMatch(read('src/director.css'), /\.act-go:hover \{ background: var\(--accent\)/, 'the primary action never turns coral');
  assert.doesNotMatch(read('src/director-sheet.ts'), /btn accent/, 'sheet actions use the CTA token');
  assert.match(read('src/director-mobile.css'), /\.side-act \.act-go \{ background: var\(--cta\)/);
  assert.match(read('src/director-mobile.css'), /\.m-btn\.m-cta \{ background: var\(--cta\)/);
  assert.match(read('src/director-home.css'), /\.home-btn\.primary \{ background: var\(--cta\)/);
});

test('mobile home: starters first for someone new, Archived on the header row', () => {
  const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  assert.match(read('src/director-home.ts'), /projects\.length < 3 \? ' is-new' : ''/);
  const css = read('src/director-home-mobile.css');
  assert.match(css, /\.home\.is-new #starters \{ order: 2; \}/);
  assert.match(css, /\.home-head \{ flex-wrap: nowrap;/);
});
