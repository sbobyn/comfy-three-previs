// Theme (src/theme.ts and the <head> boot script in each page): Dark is the default, Light and System are a persisted choice,
// System follows the OS, the theme is set before first paint, and render.html (blockouts for the video models) never reads it.
// The browser half runs axe (WCAG 2.2 A/AA) on the main screens in both themes; it needs the built app, like launch-a11y.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { startApp, skipReason, SIZES } from './fixtures/a11y-app.mjs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const theme = (() => { const exports = {}; runInNewContext(ts.transpileModule(read('src/theme.ts'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports, globalThis: {} }); return exports; })();
const store = v => ({ getItem: k => (k === 'previs.theme' ? v : null) });

test('theme: Dark unless the user chose Light or System; System follows the OS', () => {
  assert.equal(theme.readThemePref(store(null)), 'dark', 'new users get Dark');
  assert.equal(theme.readThemePref(store('nonsense')), 'dark', 'an unknown value is the default');
  assert.equal(theme.readThemePref({ getItem() { throw Error('blocked'); } }), 'dark', 'blocked storage is the default');
  for (const v of ['dark', 'light', 'system']) assert.equal(theme.readThemePref(store(v)), v);
  assert.equal(theme.resolveTheme('system', true), 'dark'); assert.equal(theme.resolveTheme('system', false), 'light');
  assert.equal(theme.resolveTheme('light', true), 'light'); assert.equal(theme.resolveTheme('dark', false), 'dark');
  assert.equal(theme.THEME_PREFS.map(t => t.label).join(' · '), 'Dark · Light · System');
});

/** The inline boot script of one page, run with a stored value and an OS preference. */
function boot(page, stored, osDark) {
  const html = read(page), src = html.match(/<script>\s*([\s\S]*?previs\.theme[\s\S]*?)<\/script>/)?.[1];
  assert.ok(src, `${page} sets the theme in <head>`);
  assert.ok(html.indexOf(src) < html.indexOf('type="module"'), `${page}: the theme is set before the app (and its CSS) loads`);
  const root = { dataset: {}, style: {} };
  runInNewContext(src, { localStorage: { getItem: () => stored }, window: { matchMedia: () => ({ matches: osDark }) }, document: { documentElement: root } });
  return root;
}

test('theme: every app page applies the stored choice before first paint, the same way src/theme.ts does', () => {
  for (const page of ['start.html', 'director.html', 'setup.html']) {
    for (const stored of [null, 'dark', 'light', 'system', 'bogus']) for (const osDark of [true, false]) {
      const root = boot(page, stored, osDark), want = theme.resolveTheme(theme.readThemePref(store(stored)), osDark);
      assert.equal(root.dataset.theme, want, `${page} ${stored} os=${osDark ? 'dark' : 'light'}`);
      assert.equal(root.style.colorScheme, want);
    }
  }
  assert.doesNotMatch(read('render.html'), /previs\.theme|data-theme/, 'blockout renders for the video models never depend on the theme');
  assert.doesNotMatch(read('src/render-worker.ts'), /theme/i);
});

test('theme: the dark tokens override the light ones and keep the stage text constant', () => {
  const css = read('src/director.css');
  assert.match(css, /:root\[data-theme="dark"\] \{[\s\S]*?--paper:\s*#211927;[\s\S]*?--ink:\s*#F0EFED;/);
  assert.match(css, /--stage-ink:\s*#211927;/);
  assert.doesNotMatch(css, /background: var\(--on-stage\); color: var\(--ink\)/, 'text on light stage chips uses --stage-ink, not the theme ink');
});

// Check the colour roles themselves as well as axe's rendered-screen coverage.
// Official Comfy colours: comfy.org/_website/IconButton.CCPIfO3V.css.
test('theme: brand text, buttons, focus and control boundaries retain AA contrast', () => {
  const [light, dark] = read('src/director.css').split(':root[data-theme="dark"] {');
  const tokens = css => Object.fromEntries([...css.split('/* ---------- Base')[0].matchAll(/--([\w-]+):\s*(#[\da-f]{6})\s*;/gi)].map(m => [m[1], m[2]]));
  const luminance = hex => {
    const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
    return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  };
  const pairs = [
    ...['ink', 'ink-2', 'ink-3', 'ink-4', 'accent'].flatMap(fg => ['paper', 'paper-2', 'paper-3', 'card'].map(bg => [fg, bg, 4.5])),
    ...['ok', 'warn', 'bad', 'info'].map(fg => [fg, `${fg}-soft`, 4.5]),
    ['accent-ink', 'accent', 4.5], ['accent-ink', 'accent-hover', 4.5],
    ['cta-ink', 'cta', 4.5], ['cta-ink', 'cta-hover', 4.5], ['accent', 'accent-soft', 4.5],
    ['on-stage', 'stage', 4.5], ['on-stage-2', 'stage-2', 4.5],
    ...['paper', 'paper-2', 'paper-3', 'card'].map(bg => ['ink', bg, 3]), // focus ring
    ['cta-line', 'paper', 3], ['cta-line', 'card', 3], ['line-2', 'card', 3],
  ];
  const base = tokens(light);
  for (const [theme, values] of [['light', base], ['dark', { ...base, ...tokens(dark) }]]) {
    for (const [fg, bg, minimum] of pairs) {
      const [low, high] = [luminance(values[fg]), luminance(values[bg])].sort((a, b) => a - b);
      const contrast = (high + .05) / (low + .05);
      assert.ok(contrast >= minimum, `${theme}: ${fg} on ${bg} is ${contrast.toFixed(2)}:1; needs ${minimum}:1`);
    }
  }
});

test('theme in the browser: Dark by default, Light persists across reloads and sessions, System follows the OS; axe passes in both themes', { skip: skipReason, timeout: 360_000 }, async () => {
  const app = await startApp();
  const found = {};
  try {
    const page = await app.page(SIZES[0][1]), ctx = page.context();
    const themeOf = p => p.evaluate(() => document.documentElement.dataset.theme);
    // Set before the stylesheet applies: the first paint is already dark.
    await ctx.addInitScript(() => { document.addEventListener('readystatechange', () => { if (document.readyState === 'interactive') window.__themeAtInteractive = document.documentElement.dataset.theme; }); });
    await page.goto(`${app.base}/`, { waitUntil: 'networkidle' });
    assert.equal(await themeOf(page), 'dark', 'new users get Dark');
    assert.equal(await page.evaluate(() => window.__themeAtInteractive), 'dark', 'set before the page is interactive');
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(33, 25, 39)');

    // The setting: Setup → Appearance. Light applies at once and survives a reload and a new page.
    await page.getByRole('button', { name: 'Setup' }).first().click();
    await page.getByRole('radio', { name: 'Light' }).check();
    assert.equal(await themeOf(page), 'light');
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await themeOf(page), 'light', 'persists across reloads');
    const again = await ctx.newPage(); await again.goto(`${app.base}/director.html?project=${app.id}`, { waitUntil: 'networkidle' });
    assert.equal(await themeOf(again), 'light', 'persists across pages and sessions of this browser');
    await again.close();

    // System follows the OS, live.
    await page.getByRole('button', { name: 'Setup' }).first().click();
    await page.getByRole('radio', { name: 'System' }).check();
    await page.emulateMedia({ colorScheme: 'light' }); await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.evaluate(() => localStorage.getItem('previs.theme')), 'system');
    assert.equal(await themeOf(page), 'dark', 'System at load reads the OS');
    await page.close();

    // axe on the main screens in both themes, desktop and phone.
    for (const t of ['dark', 'light']) for (const [size, opts] of SIZES) {
      const p = await app.page(opts);
      await p.context().addInitScript(v => localStorage.setItem('previs.theme', v), t);
      await p.goto(`${app.base}/`, { waitUntil: 'networkidle' }); await p.waitForSelector('.home-starter-open', { state: 'attached' });
      found[`${t} ${size} Home`] = await p.axe();
      for (const view of ['', 'shoot', 'sequence']) {
        await p.goto(`${app.base}/director.html?project=${app.id}${view ? `&view=${view}` : ''}`, { waitUntil: 'networkidle' });
        await p.waitForSelector('.ws-top .step-btn[aria-selected="true"]', { state: 'attached' });
        assert.equal(await themeOf(p), t);
        found[`${t} ${size} ${view || 'build'}`] = await p.axe();
      }
      await p.close();
    }
  } finally { await app.stop(); }
  const bad = Object.entries(found).filter(([, v]) => v.length);
  assert.deepEqual(bad, [], bad.map(([k, v]) => `${k}: ${v.join('; ')}`).join('\n'));
});
