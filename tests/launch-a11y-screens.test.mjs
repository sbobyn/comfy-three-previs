// Accessibility of the screens launch-a11y.test.mjs does not reach: the home page, the Cast images dialog (and its quote),
// the Library dialog with every tab including Shared assets, the Save to library dialog, the Blender import flow, and a quote
// card in the Generate video dialog. axe-core (WCAG 2.2 A/AA) runs on each at desktop and phone sizes; then the checks axe cannot
// make: what a screen reader is told (the polite live region), the text alternative of the 3D viewport, and where focus lands.
// Needs the built app (pnpm build), playwright-core with a local Chrome/Chromium, and axe-core; Comfy Cloud is mocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeZip } from '../server/previs/zip.mjs';
import { startApp, skipReason, SIZES } from './fixtures/a11y-app.mjs';

const HANDOFF = fileURLToPath(new URL('./fixtures/blender-handoff/shot.previs-blender/', import.meta.url));
const live = page => page.evaluate(() => [...document.querySelectorAll('.sr-live')].map(e => e.textContent).join(' | '));
/** The polite live region is filled a moment after the event (readers ignore a region that arrives with its text). */
const said = async (page, re, msg) => { try { await page.waitForFunction(([src, flags]) => [...document.querySelectorAll('.sr-live')].some(e => new RegExp(src, flags).test(e.textContent || '')), [re.source, re.flags], { timeout: 5000 }); } catch { assert.fail(`${msg}: nothing matching ${re} in the live region (${await live(page)})`); } };
const blenderZip = async () => writeZip([
  { name: 'shot.previs-blender/blender-previs.json', data: await readFile(join(HANDOFF, 'blender-previs.json')) },
  ...(await Promise.all((await readdir(join(HANDOFF, 'frames'))).map(async f => ({ name: `shot.previs-blender/frames/${f}`, data: await readFile(join(HANDOFF, 'frames', f)) })))),
]);

test('axe (WCAG 2.2 A/AA): home, Cast images, Library tabs, Save to library, Blender import, quote card; desktop and phone', { skip: skipReason, timeout: 360_000 }, async () => {
  const app = await startApp();
  const found = {};
  try {
    for (const [size, opts] of SIZES) {
      const phone = size === 'phone', page = await app.page(opts);
      const scan = async name => { found[`${size} ${name}`] = await page.axe(); };
      const open = async (view = '') => { await page.goto(`${app.base}/director.html?project=${app.id}${view ? `&view=${view}` : ''}`, { waitUntil: 'networkidle' }); await page.waitForSelector('.ws-top .step-btn[aria-selected="true"]', { state: 'attached' }); await page.waitForSelector('.outline .obj', { state: 'attached' }); };
      const openLibrary = async () => {
        if (phone) { await page.getByRole('button', { name: 'More actions' }).click(); await page.getByRole('button', { name: 'Library' }).click(); }
        else { await page.locator('.help-menu-btn').click(); await page.getByRole('menuitem', { name: /Library/ }).click(); }
        await page.waitForSelector('#assets-dialog[open]');
      };

      // Home, first run: no projects, starters on offer. Then the Guide and Setup dialogs it opens.
      await page.goto(`${app.base}/`, { waitUntil: 'networkidle' });
      await page.waitForSelector('.home-starter-open', { state: 'attached' });
      await scan('Home');
      for (const name of ['Guide', 'Setup']) {
        await page.getByRole('button', { name, exact: true }).click(); await page.waitForSelector('dialog[open]'); await scan(`Home ${name} dialog`);
        await page.keyboard.press('Escape');
      }

      // Cast images: from the top bar (desktop) or the Library (both), then its quote table.
      await open();
      if (!phone) { await page.locator('.ws-top').getByRole('button', { name: 'Cast images', exact: true }).click(); await page.waitForSelector('#looks-dialog[open]'); await scan('Cast images'); await page.keyboard.press('Escape'); }
      await openLibrary();
      await scan('Library');
      for (const tab of ['Videos', 'Films', 'Cast images', 'Blockouts', 'Shot images', 'Shared assets']) {
        await page.locator('#assets-dialog .seg button', { hasText: tab }).click();
        await scan(`Library ${tab}${tab === 'Shared assets' ? ' (empty)' : ''}`);
      }
      await page.locator('#assets-dialog .dialog-head').getByRole('button', { name: 'Cast images', exact: true }).click();
      await page.waitForSelector('#looks-dialog[open]');
      if (phone) await scan('Cast images');
      await page.locator('#looks-dialog .lk-toolbar .lk-check input').first().check();
      await page.locator('#looks-dialog .lk-toolbar .btn.camera').click();
      await page.waitForSelector('#looks-dialog .lk-quote', { state: 'attached' });
      await said(page, /Quote ready for \d+ object/, 'the quote is announced');
      assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('lk-batch')), true, 'focus lands on the quote');
      await scan('Cast images quote');
      await page.keyboard.press('Escape');

      // Save to library, then the Shared assets tab holding it.
      if (phone) { await page.getByRole('button', { name: 'Scene: every object' }).click(); await page.locator('.m-scenesheet .outline .obj').first().click(); await page.waitForTimeout(500); }
      else await page.locator('.outline .obj').first().click();
      await page.getByRole('button', { name: 'Save to library' }).first().click();
      await page.waitForSelector('dialog[open] #save-asset-title'); await scan('Save to library');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some(t => /saved|library/i.test(t.textContent || '')));
      await said(page, /saved|library/i, 'the save is announced');
      await open(); await openLibrary();
      await page.locator('#assets-dialog .seg button', { hasText: 'Shared assets' }).click();
      await page.waitForSelector('#assets-dialog .asset', { state: 'attached' });
      await scan('Library Shared assets (one saved)');
      await page.keyboard.press('Escape');

      // A quote card in the Generate video dialog (the cloud is mocked; nothing is sent).
      await open('shoot');
      await page.locator('.act-go:visible, .m-cta:visible').first().click(); await page.waitForSelector('dialog[open]');
      await page.getByRole('button', { name: /Generate ▸|Review request/ }).first().click();
      await page.waitForSelector('dialog[open] .gen-quote', { state: 'attached', timeout: 30_000 });
      if (await page.locator('dialog[open] .prompt-box[aria-label="Quote to review"]').count() === 0) await page.locator('dialog[open] .gen-quote').click();
      await page.waitForSelector('dialog[open] .prompt-box[aria-label="Quote to review"]', { timeout: 30_000 });
      await said(page, /Quote ready: /, 'the video quote is announced');
      await scan('Generate video quote');
      await page.keyboard.press('Escape');

      // Home with a project, then the Blender import: a zip in the hidden file input becomes a project and opens.
      await page.goto(`${app.base}/`, { waitUntil: 'networkidle' });
      await page.waitForSelector('.home-project', { state: 'attached' });
      await scan('Home with projects');
      await page.locator('input[type=file]').nth(1).setInputFiles({ name: 'shot.previs-blender.zip', mimeType: 'application/zip', buffer: await blenderZip() });
      await page.waitForURL(/director\.html\?project=/, { timeout: 30_000 });
      await page.waitForSelector('.outline .obj', { state: 'attached' });
      await scan('Blender import: Build');
      await page.goto(page.url() + '&view=shoot', { waitUntil: 'networkidle' }); await page.waitForSelector('.shotpane [data-sec="camera"]', { state: 'attached' });
      await scan('Blender import: Shoot');
      await page.context().close();
    }
  } finally { await app.stop(); }
  const counts = Object.fromEntries(SIZES.map(([size]) => [size, Object.keys(found).filter(k => k.startsWith(size + ' ')).length]));
  assert.deepEqual(counts, { desktop: 18, phone: 18 }, 'every screen was scanned');
  assert.deepEqual(Object.fromEntries(Object.entries(found).filter(([, v]) => v.length)), {}, 'axe violations');
});

test('the 3D viewport has a text alternative: the objects around the shot camera, the camera, the selection', { skip: skipReason, timeout: 120_000 }, async () => {
  const app = await startApp();
  try {
    const page = await app.page(SIZES[0][1]);
    await page.goto(`${app.base}/director.html?project=${app.id}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.outline .obj', { state: 'attached' });
    const text = () => page.evaluate(() => { const c = document.querySelector('canvas.main'); return document.getElementById(c.getAttribute('aria-describedby'))?.textContent ?? null; });
    const first = await text();
    assert.match(first, /^Director view of the whole set\. 4 objects and \d+ set pieces: /);
    assert.match(first, /News anchor \(character\): [a-z ,]+, [\d.]+ m from the camera/);
    assert.match(first, /Shot camera: Custom keys, 40 mm normal lens, [\d.]+ m high, [a-z ]+, 5 s\./);
    assert.doesNotMatch(first, /Selected:/);
    await page.locator('.outline .obj .name', { hasText: 'Anchor desk' }).click();
    assert.match(await text(), /Selected: Anchor desk\.$/, 'follows the selection');
    await page.getByRole('button', { name: 'Shot camera', exact: true }).click();
    assert.match(await text(), /^Looking through the shot camera\./, 'follows the view');
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('viewport-summary')).position), 'absolute', 'visually hidden, still read');
    await page.context().close();
  } finally { await app.stop(); }
});
