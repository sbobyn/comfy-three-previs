// The Take lab in a real browser (same harness as launch-a11y.test.mjs): axe (WCAG 2.2 A/AA) on the video and still
// comparisons at desktop and phone sizes, lanes that step together frame by frame, and a picked winner that the Cut
// then plays. A throwaway server holds one starter with extra takes copied from its own media; nothing is generated.
// Needs the built app (pnpm build), playwright-core with a local Chrome/Chromium, and axe-core.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { takeFixture } from './fixtures/take-fixture.mjs';

const require = createRequire(import.meta.url);
const deps = (() => { try { require.resolve('playwright-core'); require.resolve('axe-core'); return true; } catch { return false; } })();
const chrome = deps ? await import('../server/previs/headless.mjs').then(m => m.resolveExecutable()).catch(() => null) : null;
const built = existsSync(new URL('../dist/director.html', import.meta.url));
const skip = !chrome ? 'no local Chromium/Chrome, playwright-core or axe-core' : !built ? 'app not built (pnpm build)' : false;
const freePort = () => new Promise((resolve, reject) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }).on('error', reject); });

test('Take lab: axe-clean on videos and stills (desktop, phone); lanes step together; the winner feeds the Cut', { skip, timeout: 240_000 }, async () => {
  const { chromium } = require('playwright-core');
  const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
  const dir = await mkdtemp(join(tmpdir(), 'previs-takes-axe-'));
  const f = await takeFixture(join(dir, 'data'));
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  // No credentials and no ComfyUI: nothing here can reach a paid provider.
  const server = spawn(process.execPath, ['server/previs/server.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port), PREVIS_DATA_DIR: join(dir, 'data'), PREVIS_BUDGET_DIR: join(dir, 'budget'), PREVIS_COMFY_URL: 'http://127.0.0.1:9', PREVIS_ALLOW_PAID: '0', COMFY_CLOUD_API_KEY: '', COMFY_API_KEY: '', PREVIS_HEADLESS: '', PREVIS_AGENT: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { server.stdout.on('data', d => { if (String(d).includes('Comfy Previs:')) resolve(); }); server.once('exit', c => reject(Error('server exited ' + c))); });
  const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--disable-background-networking'] });
  const found = {}, errors = [];
  try {
    for (const [size, opts] of [['desktop', { viewport: { width: 1440, height: 1000 } }], ['phone', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }]]) {
      const ctx = await browser.newContext({ ...opts, reducedMotion: 'reduce' });
      await ctx.addInitScript(() => localStorage.setItem('previs.tour.v1', '1'));
      await ctx.route('**/*', route => (new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort()));
      const page = await ctx.newPage();
      page.on('pageerror', e => errors.push(`${size}: ${e.message}`));
      const scan = async name => {
        await page.waitForTimeout(400);
        await page.addScriptTag({ content: AXE });
        const r = await page.evaluate(() => window.axe.run({ runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } }));
        found[`${size} ${name}`] = r.violations.map(v => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`);
      };
      await page.goto(`${base}/director.html?project=${f.id}&view=sequence`, { waitUntil: 'networkidle' });
      if (size === 'desktop') { await page.waitForSelector('.sq-row'); await page.locator('.sq-row').nth(1).click(); }
      else { await page.waitForSelector('.m-cutrow'); await page.locator('.m-cutrow .m-cr-main').nth(1).click(); await page.waitForTimeout(300); await page.keyboard.press('Escape'); await page.waitForTimeout(300); }
      await page.getByRole('button', { name: 'Compare takes' }).first().click();
      await page.waitForSelector('dialog.takes[open] .tk-lane video');
      assert.match(await page.textContent('#takes-title'), /Shot 02/);
      // The winner (the starter's chosen video) and the three newest, plus the blockout lane.
      assert.equal(await page.locator('dialog.takes .tk-lane').count(), 5);
      assert.deepEqual(await page.$$eval('dialog.takes .tk-pick-s', xs => xs.map(x => x.textContent)), ['seed 7 · ≈ $0.84', 'seed 1234 · ≈ $0.63', 'seed 11 · ≈ $0.20', 'seed 42 · ≈ $0.63'], 'newest first, seed and cost');
      await scan('videos');
      if (size === 'desktop') {
        await page.waitForFunction(() => [...document.querySelectorAll('dialog.takes .tk-lane video')].every(v => v.readyState >= 2));
        for (let i = 0; i < 12; i++) await page.getByRole('button', { name: 'Forward one frame' }).click();
        await page.waitForTimeout(300);
        const times = await page.$$eval('dialog.takes .tk-lane video', vs => vs.map(v => v.currentTime));
        assert.ok(times.every(t => Math.abs(t - times[0]) < 1e-3) && Math.floor(times[0] * 24 + 1e-6) === 12, `every lane on frame 12: ${times}`);
        assert.match(await page.textContent('.tk-clock'), /^Frame 12 /);
        await page.getByRole('checkbox', { name: 'Only differences' }).check();
        await scan('only differences');
        await page.getByRole('checkbox', { name: 'Only differences' }).uncheck();
        await page.getByRole('button', { name: /^Mark winner: Take 3 / }).click();
        await page.getByRole('button', { name: /^Winner: Take 3 / }).waitFor();
        assert.match(await page.textContent('.tk-status'), /Take 3 .* is the winner\. The cut plays it\./);
      }
      await page.getByRole('radio', { name: /^Stills/ }).click();
      await page.waitForSelector('dialog.takes .tk-lane img');
      await scan('stills');
      await page.keyboard.press('Escape');
      if (size === 'desktop') {
        const chosen = await page.locator('.sq-row').nth(1).locator('select').first().evaluate(s => s.selectedOptions[0].textContent);
        assert.match(chosen, /^★ .*Take 3 /, 'the Cut plays the winner');
        const p = JSON.parse(await readFile(join(dir, 'data', 'director', f.id, 'project.json'), 'utf8'));
        assert.equal(p.shots[1].winner, f.takes[2]);
        assert.equal(p.assets.filter(a => a.shotId === p.shots[1].id && a.kind === 'workflow-result').length, 4, 'losing takes kept');
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
    const ended = once(server, 'exit'); server.kill('SIGTERM'); await ended;
    await rm(dir, { recursive: true, force: true });
  }
  assert.deepEqual(errors, []);
  assert.equal(Object.keys(found).length, 5, 'every view was scanned');
  assert.deepEqual(Object.fromEntries(Object.entries(found).filter(([, v]) => v.length)), {}, 'axe violations');
});
