// Launch accessibility and the public demo's first impression (L4/L5 of the 31 Oct UX review).
// The browser test runs axe-core on the real workspace (Build, Shoot, Cut, the still composer and the Generate video
// dialog) at desktop and phone sizes, against a throwaway server holding one bundled starter. It needs the built
// app (pnpm build, which pnpm check runs first), playwright-core with a local Chrome/Chromium, and axe-core.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { demoStarters } from '../scripts/snapshot-demo.mjs';
import { startApp, skipReason as skip, SIZES } from './fixtures/a11y-app.mjs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('demo home: demo scenes open their projects, Run locally explains the install, no "Your projects"', () => {
  const home = read('src/director-home.ts');
  assert.match(home, /'Explore a demo scene'/);
  assert.match(home, /'Run locally'/);
  assert.match(home, /git clone --depth 1 --single-branch https:\/\/github\.com\/sbobyn\/comfy-three-previs\.git/, 'the README’s Quick start');
  assert.match(home, /DEMO \? h\('p', \{ class: 'home-demo-note', role: 'note' \}/, 'read-only is said before any action');
  assert.match(home, /DEMO \? null : h\('section', \{ class: 'home-section', 'aria-labelledby': 'projects-title' \}/, 'the demo has no Your projects');
  assert.match(home, /'Explore the demo scenes'/);
  // First use (fewer than 3 projects) leads with a starter; New scene leads after that.
  assert.match(home, /isNew \? \[openStarter\('primary'\), newScene\('New scene', ''\)\] : \[newScene\('New scene'\), openStarter\(\)\]/);
  assert.match(read('src/demo-shim.ts'), /case 'director\/starters': return file\('starters\.json'/);
  assert.match(read('scripts/snapshot-demo.mjs'), /await write\('starters\.json', \{ starters \}\)/);
  const ws = read('src/director.ts');
  assert.match(ws, /if \(DEMO && sessionStorage\.getItem\('previs\.demoNote'\) !== '1'\)/, 'the workspace says read-only on arrival');
});

test('demo starters pair with snapshotted projects by title; unpaired starters are left out', () => {
  const starters = [{ slug: 'final-lap', title: 'Final Lap', description: 'd', shots: 4, entities: 9, scene: { entities: [] }, shot: { id: 'x' }, media: 3 }, { slug: 'new-one', title: 'New one' }];
  const out = demoStarters(starters, [{ id: 'p1', title: 'Starter · Final Lap' }, { id: 'p2', title: 'Something else' }]);
  assert.deepEqual(out.map(s => [s.slug, s.projectId]), [['final-lap', 'p1']]);
  assert.equal(out[0].media, undefined, 'only what the home card draws');
  assert.deepEqual(demoStarters(undefined, []), []);
});

test('still composer keeps its moment text across re-renders (model or takes change)', () => {
  const ws = read('src/director.ts');
  assert.match(ws, /moment: string; guide: boolean/);
  assert.match(ws, /'aria-label': 'What happens at this moment', value: f\.moment \}\);\n\s+moment\.oninput = \(\) => \{ f\.moment = moment\.value; \};/);
  assert.match(ws, /const open = \(t: number\) => \{ f\.open = true; f\.prompt = null; f\.moment = '';/, 'a new still starts empty');
});

// No credentials and no mocked cloud (mock: false): nothing here can reach a paid provider. The server, browser and their shutdown
// live in tests/fixtures/a11y-app.mjs, which keeps the event loop alive and caps every wait, so a loaded machine cannot cancel this test.
test('axe (WCAG 2.2 A/AA): Build, Shoot, Cut, still composer and Generate video dialog, desktop and phone', { skip, timeout: 240_000 }, async () => {
  const app = await startApp({ mock: false });
  const found = {};
  try {
    for (const [size, opts] of SIZES) {
      const page = await app.page(opts);
      const scan = async name => { found[`${size} ${name}`] = await page.axe(); };
      const open = async view => {
        await page.goto(`${app.base}/director.html?project=${app.id}${view ? `&view=${view}` : ''}`, { waitUntil: 'networkidle' });
        await page.waitForSelector('.ws-top .step-btn[aria-selected="true"]', { state: 'attached' });
      };
      await open(''); await page.waitForSelector('.outline .obj', { state: 'attached' }); await scan('Build');
      await open('shoot'); await page.waitForSelector('.shotpane [data-sec="camera"]', { state: 'attached' }); await scan('Shoot');
      if (size === 'desktop') {
        await page.getByRole('button', { name: '+ Start', exact: true }).click();
        const moment = page.getByRole('textbox', { name: 'What happens at this moment' });
        await moment.fill('The anchor takes a breath.');
        await scan('Still composer');
        const model = page.getByRole('combobox', { name: 'Image model', exact: true });
        const values = await model.locator('option').evaluateAll(xs => xs.map(x => x.value));
        if (values.length > 1) { await model.selectOption(values[1]); assert.equal(await moment.inputValue(), 'The anchor takes a breath.', 'a model change keeps the draft'); }
      }
      await page.locator('.act-go:visible, .m-cta:visible').first().click();
      await page.waitForSelector('dialog[open]'); await scan('Generate video dialog');
      await page.keyboard.press('Escape');
      await open('sequence'); await page.waitForSelector('.step-btn[data-step="cut"][aria-selected="true"]', { state: 'attached' }); await page.waitForSelector('.sq-board', { state: 'attached' }); await scan('Cut');
      await page.context().close();
    }
  } finally { await app.stop(); }
  assert.equal(Object.keys(found).length, 9, 'every screen was scanned');
  assert.deepEqual(Object.fromEntries(Object.entries(found).filter(([, v]) => v.length)), {}, 'axe violations');
});
