// Headless renderer: a small pool of Chromium pages that load the built render.html and run the same client
// code as the workspace (blockout capture, still frames, sheet composition). GPU only (ANGLE Metal); refuses
// software rendering. Enabled with PREVIS_HEADLESS=1; playwright-core is an optional dependency.
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CHROMIUM_ARGS = Object.freeze(['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']);
const SOFTWARE = /swiftshader|software|llvmpipe|basic render/i;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BUNDLES = ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium'];
const OPS = { blockout: ['project', 'shot', 'width', 'height'], frame: ['project', 'shot', 't', 'width', 'height', 'type', 'guide'], sheet: ['project', 'entity', 'sheet', 'options'] };

function fail(message, status = 400, apiCode) { const e = Error(message); e.status = status; if (apiCode) e.apiCode = apiCode; throw e; }
export const unavailable = message => fail(message, 409, 'headless-unavailable');

/** PREVIS_CHROMIUM → newest ~/Library/Caches/ms-playwright/chromium-* → Chrome stable. */
export function resolveExecutable({ env = process.env, home = homedir(), exists = existsSync, list = readdirSync } = {}) {
  if (env.PREVIS_CHROMIUM) return exists(env.PREVIS_CHROMIUM) ? env.PREVIS_CHROMIUM : null;
  const cache = join(home, 'Library/Caches/ms-playwright');
  let dirs = [];
  try { dirs = list(cache).filter(d => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9))); } catch {}
  for (const d of dirs) for (const platform of ['chrome-mac-arm64', 'chrome-mac']) for (const bundle of BUNDLES) {
    const file = join(cache, d, platform, bundle); if (exists(file)) return file;
  }
  return exists(CHROME) ? CHROME : null;
}

/** render.html query for one op; unknown keys are dropped, objects are JSON-encoded. */
export function opQuery(op, params = {}) {
  if (!OPS[op]) fail('Unknown render op');
  const q = new URLSearchParams({ op });
  for (const k of OPS[op]) if (params[k] != null) q.set(k, typeof params[k] === 'object' ? JSON.stringify(params[k]) : String(params[k]));
  return `render.html?${q}`;
}

const probe = () => { const gl = document.createElement('canvas').getContext('webgl'); if (!gl) return null; const ext = gl.getExtension('WEBGL_debug_renderer_info'); return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER)); };
async function playwright() {
  try { return (await import('playwright-core')).chromium; }
  catch { return null; }
}

export function openHeadless({ port, enabled = process.env.PREVIS_HEADLESS === '1', executable = resolveExecutable(), poolSize = Number(process.env.PREVIS_HEADLESS_POOL) || 2, launcher = playwright, log = console.log } = {}) {
  const size = Math.max(1, Math.min(8, Math.floor(poolSize)));
  let reason = !enabled ? 'Headless rendering is off; start the server with PREVIS_HEADLESS=1' : !executable ? 'No Chromium found; set PREVIS_CHROMIUM' : null;
  let browser = null, launching = null, renderer = null, busy = 0;
  const waiters = [];

  async function launch() {
    const chromium = await launcher();
    if (!chromium) { reason = 'playwright-core is not installed; run pnpm install'; unavailable(reason); }
    const b = await chromium.launch({ executablePath: executable, headless: true, args: [...CHROMIUM_ARGS], ignoreDefaultArgs: ['--enable-unsafe-swiftshader'], handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
    try {
      const page = await b.newPage();
      try { renderer = await page.evaluate(probe); } finally { await page.close().catch(() => {}); }
    } catch (e) { await b.close().catch(() => {}); throw e; }
    if (!renderer || SOFTWARE.test(renderer)) {
      await b.close().catch(() => {});
      reason = `Refusing software rendering (${renderer || 'no WebGL'})`; unavailable(reason);
    }
    b.on('disconnected', () => { if (browser === b) browser = null; });
    log?.(`Headless renderer: ${renderer} · ${executable}`);
    return (browser = b);
  }
  async function ready() {
    if (reason) unavailable(reason);
    if (browser?.isConnected()) return browser;
    return (launching ||= launch().catch(e => { if (e.apiCode) throw e; unavailable(`Chromium failed to start: ${String(e.message).split('\n')[0]}`.slice(0, 500)); }).finally(() => { launching = null; }));
  }
  // Pool slots hand over directly to the next waiter so the limit is never exceeded.
  const acquire = () => (busy < size ? (busy++, Promise.resolve()) : new Promise(r => waiters.push(r)));
  const release = () => { const next = waiters.shift(); if (next) next(); else busy--; };

  return {
    get enabled() { return !reason; },
    get reason() { return reason; },
    async run(query, { timeoutMs = 180_000 } = {}) {
      const b = await ready();
      await acquire();
      let page = null; const errors = [];
      try {
        const deadline = Date.now() + timeoutMs;
        page = await b.newPage();
        page.on('pageerror', e => errors.push(e.message));
        await page.goto(`http://127.0.0.1:${port}/${query}`, { timeout: timeoutMs });
        const handle = await page.waitForFunction(() => window.__previsResult, null, { timeout: Math.max(1, deadline - Date.now()), polling: 200 });
        const { ok, error, ...payload } = await handle.jsonValue();
        if (!ok) fail(error || 'Headless render failed');
        return payload;
      } catch (e) {
        if (e.status) throw e;
        fail(`Headless render failed: ${String(e.message).split('\n')[0]}${errors.length ? ` (${errors[0]})` : ''}`.slice(0, 500), 500);
      } finally { await page?.close().catch(() => {}); release(); }
    },
    /** Health: launches the browser once (if enabled) so the renderer string is known. */
    async status({ probe: launchIfNeeded = true } = {}) {
      if (launchIfNeeded && !reason && !renderer) await ready().catch(() => {});
      return { enabled: !reason, executable, pool: { size, busy, queued: waiters.length }, renderer, ...(reason ? { reason } : {}) };
    },
    async close() { reason ||= 'Headless renderer closed'; const b = browser || (await launching?.catch(() => null)); browser = null; await b?.close().catch(() => {}); },
  };
}
