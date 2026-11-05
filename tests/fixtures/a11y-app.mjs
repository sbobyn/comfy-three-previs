// A throwaway video-lab server holding one bundled starter, plus headless Chrome, for the browser accessibility tests
// (launch-a11y-screens, launch-keyboard). Comfy Cloud is mocked by tests/fixtures/mock-cloud.mjs and paid generation is off,
// so quotes can be prepared and read but nothing leaves the machine or is charged.
import { readFileSync, existsSync } from 'node:fs';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = new URL('../../', import.meta.url);

const deps = (() => { try { require.resolve('playwright-core'); require.resolve('axe-core'); return true; } catch { return false; } })();
const chrome = deps ? await import('../../server/previs/headless.mjs').then(m => m.resolveExecutable()).catch(() => null) : null;
/** A reason to skip the browser tests, or false when they can run. */
export const skipReason = !chrome ? 'no local Chromium/Chrome, playwright-core or axe-core' : !existsSync(new URL('dist/director.html', ROOT)) ? 'app not built (pnpm build)' : false;

export const SIZES = [['desktop', { viewport: { width: 1440, height: 1000 } }], ['phone', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }]];
const freePort = () => new Promise((resolve, reject) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }).on('error', reject); });

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * @param o.starter the bundled starter to load into the data dir (null: an empty data dir, as on first run)
 * @param o.mock true (default): Comfy Cloud is mocked and a fake key is set, so quotes can be prepared; false: no key and no
 *   mock, so nothing could reach a provider even if it tried.
 *
 * Lifecycle, so a loaded machine cannot leave the test awaiting nothing ("Promise resolution is still pending but the event loop
 * has already resolved"): a referenced timer keeps the event loop alive until stop() has finished; the server's exit is
 * observed from the moment it is spawned (waiting for an exit that already happened would never return); every wait is
 * capped; the browser is closed first and the server is always stopped, escalating to SIGKILL.
 */
export async function startApp({ starter = 'breaking-news', mock = true } = {}) {
  const keepAlive = setInterval(() => {}, 1000);
  const { chromium } = require('playwright-core');
  const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
  let dir, server, browser, gone = false, stderr = '';
  const stop = async () => {
    try { await browser?.close(); } catch { /* the browser may already be gone */ }
    if (server && !gone) {
      server.kill('SIGTERM');
      if (await Promise.race([exited, sleep(10_000).then(() => false)]) === false) { server.kill('SIGKILL'); await Promise.race([exited, sleep(5_000)]); }
    }
    if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
    clearInterval(keepAlive);
  };
  let exited;
  try {
    dir = await mkdtemp(join(tmpdir(), 'previs-a11y-'));
    let startersDir;
    if (mock) {
      const { loadStarters } = await import('../../server/previs/starters.mjs');
      const { shotSignature } = await import('../../shared/director.mjs');
      const starters = await loadStarters();
      startersDir = join(dir, 'mock-starters');
      await mkdir(startersDir);
      await writeFile(join(startersDir, 'index.json'), JSON.stringify({ starters: starters.map(s => s.slug) }));
      for (const s of starters) {
        // Synthetic current stills exercise the quote/focus flow without paid regeneration.
        for (const sh of s.shots) for (const r of sh.references || []) if (r.generated) r.generated.signature = shotSignature(s, sh);
        await mkdir(join(startersDir, s.slug));
        await writeFile(join(startersDir, s.slug, 'starter.json'), JSON.stringify(s));
        await symlink(join(s.dir, 'media'), join(startersDir, s.slug, 'media'));
      }
    }
    const id = starter ? (await (await import('../../scripts/import-starters.mjs')).importStarters({ dataDir: join(dir, 'data'), ...(startersDir ? { startersDir } : {}), only: starter, log: () => {} }))[0].id : null;
    const port = await freePort(), base = `http://127.0.0.1:${port}`;
    const env = { ...process.env, ...(startersDir ? { PREVIS_STARTERS_DIR: startersDir } : {}), PORT: String(port), PREVIS_DATA_DIR: join(dir, 'data'), PREVIS_BUDGET_DIR: join(dir, 'budget'), PREVIS_LIBRARY_DIR: join(dir, 'library'), PREVIS_COMFY_URL: 'http://127.0.0.1:9', PREVIS_ALLOW_PAID: '0', PREVIS_AGENT: 'off', COMFY_CLOUD_API_KEY: mock ? 'mock-key-not-real' : '', COMFY_API_KEY: '', PREVIS_HEADLESS: '' };
    server = spawn(process.execPath, [...(mock ? ['--import', './tests/fixtures/mock-cloud.mjs'] : []), 'server/previs/server.mjs'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    exited = new Promise(resolve => server.once('exit', (code, signal) => { gone = true; resolve({ code, signal }); }));
    server.stderr.on('data', d => { stderr = (stderr + d).slice(-2000); });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`the server did not start in 60 s: ${stderr}`)), 60_000);
      server.stdout.on('data', d => { if (String(d).includes('video-lab:')) { clearTimeout(timer); resolve(); } });
      exited.then(({ code, signal }) => { clearTimeout(timer); reject(Error(`the server exited (${code ?? signal}): ${stderr}`)); });
    });
    browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--disable-background-networking'], timeout: 60_000 });
    return {
      base, id, dir,
      /** A fresh page at one of SIZES. Tips are off, motion is reduced, and nothing but this server is reachable. */
      async page(opts) {
        const ctx = await browser.newContext({ ...opts, reducedMotion: 'reduce' });
        await ctx.addInitScript(() => localStorage.setItem('previs.tour.v1', '1'));
        await ctx.route('**/*', route => (new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort()));
        const page = await ctx.newPage();
        /** Run axe (WCAG 2.2 A/AA) on the page as it is now; resolves to the violations as short strings. */
        page.axe = async () => {
          await page.waitForTimeout(400);
          await page.addScriptTag({ content: AXE });
          const r = await page.evaluate(() => window.axe.run({ runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } }));
          return r.violations.map(v => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`);
        };
        return page;
      },
      stop,
    };
  } catch (e) { await stop(); throw e; }
}
