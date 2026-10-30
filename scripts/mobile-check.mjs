// Mobile acceptance checks (A1–A13 + desktop unchanged). Headless Chromium on Metal, one browser at a time.
// node scripts/mobile-check.mjs --base http://127.0.0.1:5274 [--desktop-only <dir>] [--phase 1|2|3]
import { chromium } from '/Users/stevenbobyn/dev/timeblock/node_modules/playwright-core/index.mjs';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('--base', 'http://127.0.0.1:5274');
const PHASE = Number(arg('--phase', '3'));
const OUT = arg('--out', '.evidence/mobile-design/W6/recovery');
const BASELINE = arg('--baseline', '.evidence/mobile-design/W6/baseline');
const BN = 'ff685e99-00bf-4f5f-979a-944f0caca7c9', FL = 'ac79f20f-85d2-44ba-b1a4-0692c7eb6b0f';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const DEV = {
  390: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: UA },
  430: { viewport: { width: 430, height: 932 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: UA },
  768: { viewport: { width: 768, height: 1024 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: UA.replace('iPhone', 'iPad') },
  844: { viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: UA },
};
const results = [], metrics = [];
const check = (id, ok, detail = '') => { results.push({ id, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${detail}`); };

// In-page metrics: overflow, off-screen interactive elements, small targets (with ::before slop), smallest text.
const pageMetrics = () => {
  const vis = el => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; const s = getComputedStyle(el); if (s.visibility === 'hidden' || s.display === 'none') return false; return !el.closest('[hidden],[inert]') || el.closest('dialog[open]'); };
  const onScreen = el => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; };
  const els = [...document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab]')].filter(vis);
  const hit = el => { const lab = el.matches('input') && el.closest('label'); if (lab) { const r = lab.getBoundingClientRect(), q = el.getBoundingClientRect(); return { w: Math.max(r.width, q.width), h: Math.max(r.height, q.height) }; } const r = el.getBoundingClientRect(); const b = getComputedStyle(el, '::before'); let w = r.width, h = r.height; if (b.content !== 'none' && b.position === 'absolute') { const t = parseFloat(b.top) || 0, l = parseFloat(b.left) || 0; w = Math.max(w, r.width - 2 * l); h = Math.max(h, r.height - 2 * t); } return { w, h }; };
  const prose = el => el.tagName === 'A' && el.closest('p, li');
  const scrollerClipped = el => { for (let p = el.parentElement; p; p = p.parentElement) { const s = getComputedStyle(p); if (/(auto|scroll|hidden)/.test(s.overflowX)) { const pr = p.getBoundingClientRect(); if (pr.right <= innerWidth + 1 && pr.left >= -1) return true; } } return false; };
  const small = els.filter(el => onScreen(el) && !prose(el) && getComputedStyle(el).pointerEvents !== 'none' && !el.closest('dialog:not([open])')).filter(el => { const { w, h } = hit(el); return w < 43.5 || h < 43.5; });
  const name = el => (el.getAttribute('aria-label') || el.textContent || el.className || el.tagName).toString().trim().replace(/\s+/g, ' ').slice(0, 32);
  const off = els.filter(el => { const r = el.getBoundingClientRect(); return (r.right > innerWidth + 1 || r.left < -1) && !scrollerClipped(el); });
  const texts = [...document.querySelectorAll('body *')].filter(el => vis(el) && onScreen(el) && [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()));
  return {
    url: location.pathname + location.search, docW: document.documentElement.scrollWidth, vw: innerWidth,
    overflow: document.documentElement.scrollWidth > innerWidth,
    targets: els.length, small: small.length, smallNames: small.map(name).slice(0, 20), off: off.map(name).slice(0, 12),
    fontMin: Math.min(...texts.map(el => parseFloat(getComputedStyle(el).fontSize))), fontMinEl: (() => { const m = texts.sort((a, b) => parseFloat(getComputedStyle(a).fontSize) - parseFloat(getComputedStyle(b).fontSize))[0]; return m ? name(m) : ''; })(),
  };
};

const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
async function session(dev, fn) {
  const ctx = await browser.newContext(dev); const page = await ctx.newPage(); const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  try { await fn(page, errors); } finally { await ctx.close(); }
  return errors;
}
const settle = (page, ms = 700) => page.waitForTimeout(ms);
async function snap(page, file, size) { await settle(page, 500); await page.screenshot({ path: `${OUT}/${file}-${size}.png` }); const m = await page.evaluate(pageMetrics); metrics.push({ screen: file, size, ...m }); check(`A2-${file}-${size}-all`, !m.overflow && !m.off.length, `overflow=${m.overflow} off=${m.off.join(',')}`); check(`A3-${file}-${size}-all`, m.small === 0, `small=${m.small} ${m.smallNames.join(' · ')}`); return m; }
// CDP dispatches trusted multi-touch input through Chromium's normal hit testing.
async function touchDrag(page, start, end, hold = 0) {
  const cdp = await page.context().newCDPSession(page);
  const points = ps => ps.map((p, id) => ({ ...p, id, radiusX: 2, radiusY: 2, force: 1 }));
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(start) });
    if (hold) await settle(page, hold);
    for (let i = 1; i <= 12; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(start.map((p, j) => ({ x: p.x + (end[j].x - p.x) * i / 12, y: p.y + (end[j].y - p.y) * i / 12 }))) });
      await settle(page, 20);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally { await cdp.detach(); }
}
const projectJson = id => fetch(`${BASE}/api/director/project?id=${id}`).then(r => r.json()).then(r => r.project);

// ---------- Desktop (no emulation): capture and compare with a baseline dir ----------
async function desktop(dir) {
  mkdirSync(dir, { recursive: true });
  const shots = {};
  await session({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 }, async page => {
    for (const [name, q] of [['build', ''], ['shoot', '&view=shoot'], ['cut', '&view=sequence']]) {
      await page.goto(`${BASE}/director.html?project=${BN}${q}`, { waitUntil: 'networkidle' });
      await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important} .jobs-pip{visibility:hidden!important}' });
      await settle(page, 2500);
      const info = await page.evaluate(() => ({ classes: [...document.body.classList].filter(c => c.startsWith('m-')), top: !!document.querySelector('.ws-top')?.getBoundingClientRect().height }));
      const buf = await page.screenshot({ path: `${dir}/desktop-${name}.png` });
      shots[name] = { buf, info };
    }
  });
  return shots;
}
const diffRatio = (a, b) => { if (a.length !== b.length) return 1; let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d / a.length; };

mkdirSync(OUT, { recursive: true });
const only = arg('--desktop-only');
try {
  if (only) { await desktop(only); console.log('desktop captured to', only); }
  else if (arg('--only') === 'camera-menus') { await camera(); await phonePage(); await menus(); if (results.some(r => !r.ok)) process.exitCode = 1; }
  else if (arg('--only') === 'menus') { await menus(); writeFileSync(`${OUT}/menus.json`, JSON.stringify({ results, metrics }, null, 2)); if (results.some(r => !r.ok)) process.exitCode = 1; }
  else if (arg('--only') === 'gestures') { await gestures(); if (results.some(r => !r.ok)) process.exitCode = 1; }
  else if (arg('--only') === 'later') { await gestures(); await cut(); await landscape(); await reduced(); await camera(); await phonePage(); writeFileSync(`${OUT}/later.json`, JSON.stringify({ results, metrics }, null, 2)); if (results.some(r => !r.ok)) process.exitCode = 1; }
  else await runAll();
} finally { writeFileSync(`${OUT}/metrics.json`, JSON.stringify({ results, metrics }, null, 2)); await browser.close(); }

async function runAll() {
  // Desktop unchanged
  let now = await desktop(`${OUT}/desktop`);
  const same = k => existsSync(`${BASELINE}/desktop-${k}.png`) ? Buffer.compare(readFileSync(`${BASELINE}/desktop-${k}.png`), now[k].buf) === 0 : null;
  // WebGL thumbnails occasionally differ by a few anti-aliased pixels between runs (the baseline itself does): retry once.
  if (Object.keys(now).some(k => same(k) === false)) { const again = await desktop(`${OUT}/desktop`); for (const k of Object.keys(now)) if (same(k) === false) now[k] = again[k]; }
  for (const [k, v] of Object.entries(now)) {
    check(`DESKTOP-${k}`, v.info.classes.length === 0 && v.info.top && same(k) === true, `m-classes=${v.info.classes.join(',') || 'none'} ws-top=${v.info.top} png-identical=${same(k)}`);
  }
  // A7 Home at 390 and 768
  for (const size of [390, 768]) {
    const errs = await session(DEV[size], async page => {
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle' }); await settle(page, 1500);
      await snap(page, 'home', size);
      const r = await page.evaluate(() => {
        const proj = document.querySelector('#projects-title')?.getBoundingClientRect().top ?? 1e9, st = document.querySelector('#starters-title')?.getBoundingClientRect().top ?? -1;
        const row = document.querySelector('.home-starters'); const scrolls = row ? row.scrollWidth > row.clientWidth && getComputedStyle(row).overflowX !== 'visible' : false;
        const more = document.querySelector('.home-more'); const moreVis = !!more && getComputedStyle(more).opacity === '1' && more.getBoundingClientRect().width > 0;
        const legacy = [...document.querySelectorAll('a[href]')].filter(a => /\/(index|previs|generation|comfy|render|transfer)\.html/.test(a.getAttribute('href')) && a.getBoundingClientRect().width > 0).map(a => a.getAttribute('href'));
        return { order: proj < st, scrolls, moreVis, legacy };
      });
      check(`A7-home-${size}`, r.order && r.scrolls && r.moreVis && !r.legacy.length, JSON.stringify(r));
    });
    check(`A1-home-${size}`, !errs.length, errs.join(' | '));
  }
  // Workspace at 390 and 768
  for (const size of [390, 430, 768]) await workspace(size);
  if (PHASE >= 2) { await gestures(); await cut(); await landscape(); await reduced(); }
  if (PHASE >= 3) { await camera(); await phonePage(); }
  await menus();
  writeFileSync(`${OUT}/metrics.json`, JSON.stringify({ results, metrics }, null, 2));
  const fails = results.filter(r => !r.ok);
  console.log(`\n${results.length - fails.length}/${results.length} checks passed`);
  if (fails.length) process.exitCode = 1;
}

async function workspace(size) {
  const W = DEV[size].viewport.width, H = DEV[size].viewport.height;
  const errs = await session(DEV[size], async page => {
    await page.goto(`${BASE}/director.html?project=${BN}&mcheck`, { waitUntil: 'networkidle' }); await settle(page, 2500);
    const b = await snap(page, 'build', size);
    check(`A2-build-${size}`, !b.overflow && !b.off.length, `overflow=${b.overflow} off=${b.off.join(',')}`);
    check(`A3-build-${size}`, b.small === 0, `small=${b.small} ${b.smallNames.join(' · ')}`);
    const vp = await page.evaluate(() => { const r = document.querySelector('.viewport').getBoundingClientRect(); const vis = s => { const e = document.querySelector(s); return !!e && e.getBoundingClientRect().width > 0 && getComputedStyle(e).display !== 'none' && !e.closest('[hidden]'); }; return { w: r.width, h: r.height, rail: vis('.rail'), side: vis('.side'), tabs: document.querySelectorAll('.m-tabbar [role=tab]').length }; });
    if (size === 390) check('A4-build-390', vp.w >= 380 && vp.h >= 480 && !vp.rail && !vp.side && vp.tabs === 3, JSON.stringify(vp));
    // Tabs change ?view=
    const views = [];
    for (const k of ['shoot', 'cut', 'build']) { await page.tap(`.m-tabbar [data-step=${k}]`); await settle(page, 600); views.push(new URL(page.url()).searchParams.get('view')); }
    if (size === 390) check('A4-tabs-390', views.join() === 'shoot,sequence,', views.join());
    // Scene sheet
    await page.tap('.m-fab.scene'); await settle(page, 600);
    const sc = await snap(page, 'build-scene', size);
    check(`A2-scene-${size}`, !sc.overflow && !sc.off.length, `off=${sc.off.join(',')}`);
    // A5 object flow from the Scene sheet row
    await page.tap('.m-sheet .outline .obj:not(.parent)'); await settle(page, 900);
    const o = await page.evaluate(() => { const s = document.querySelector('.m-sheet.m-panel.m-open'); const vp = document.querySelector('.viewport').getBoundingClientRect(); return { sheet: !!s, pane: !!s?.querySelector('.objectpane'), vpShare: vp.height / innerHeight, sheets: window.__mobile?.sheets() }; });
    await snap(page, 'build-object', size);
    if (size === 390) check('A5-object-390', o.sheet && o.pane && o.vpShare >= 0.45, JSON.stringify(o));
    if (size === 768) await page.tap('.m-objsheet .m-sheet-x'); else await page.tap('.m-scrim', { position: { x: 20, y: 20 } }); await settle(page, 600);
    const after = await page.evaluate(() => ({ open: !!document.querySelector('.m-sheet.m-panel.m-open'), sel: document.querySelector('.viewport')?.classList.contains('has-sel') }));
    if (size === 390) check('A5-close-390', !after.open && !after.sel, JSON.stringify(after));
    // Shoot
    await page.tap('.m-tabbar [data-step=shoot]'); await settle(page, 1200);
    const sh = await snap(page, 'shoot', size);
    check(`A2-shoot-${size}`, !sh.overflow && !sh.off.length, `off=${sh.off.join(',')}`);
    check(`A3-shoot-${size}`, sh.small === 0, `small=${sh.small} ${sh.smallNames.join(' · ')}`);
    const fr = await page.evaluate(() => { const v = document.querySelector('.viewport').getBoundingClientRect(); const a = document.querySelector('.side-act').getBoundingClientRect(); const t = document.querySelector('.m-tabbar').getBoundingClientRect(); return { w: v.width, h: v.height, top: v.top, act: { top: a.top, bottom: a.bottom, left: a.left, right: a.right }, tabTop: t.top }; });
    const segs = [];
    for (const k of ['story', 'cast', 'camera', 'video']) {
      await page.tap(`.m-shootseg [data-seg=${k}]`); await settle(page, 400);
      segs.push(await page.evaluate(k => [...document.querySelectorAll('.shotpane > [data-sec]')].filter(s => getComputedStyle(s).display !== 'none').map(s => s.dataset.sec).join('+'), k));
      if (k !== 'camera') await snap(page, k === 'cast' ? 'cast' : k === 'video' ? 'shoot-video' : 'shoot-story', size);
    }
    if (size === 390) check('A6-shoot-390', fr.top >= 0 && Math.abs(fr.w * 9 / 16 - fr.h) <= 2 && Math.abs(fr.w - W) <= 2 && fr.act.top >= 0 && fr.act.bottom <= fr.tabTop + 0.5 && fr.act.right <= W && segs.join() === 'story,cast,camera,video+more', `frame ${fr.w}×${fr.h} act=${JSON.stringify(fr.act)} tabTop=${fr.tabTop} segs=${segs.join()}`);
    await page.tap('.side-act .act-go'); await settle(page, 1200);
    const g = await page.evaluate(() => { const d = document.querySelector('dialog.render'); const r = d?.getBoundingClientRect(); return { open: !!d?.open, w: r?.width, task: d?.classList.contains('m-task') }; });
    await snap(page, 'shoot-generate', size);
    if (size === 390) check('A6-generate-390', g.open && Math.abs(g.w - W) <= 1 && g.task, JSON.stringify(g));
    await page.keyboard.press('Escape'); await settle(page, 500);
    // Jobs sheet (opened programmatically: the pip is hidden when idle)
    await page.evaluate(() => document.querySelector('.jobs-pip')?.click()); await settle(page, 800);
    if (await page.evaluate(() => !!document.querySelector('dialog.jobs-sheet[open]'))) { await snap(page, 'jobs', size); await page.keyboard.press('Escape'); await settle(page, 400); }
    // Cut
    await page.tap('.m-tabbar [data-step=cut]'); await settle(page, 1500);
    const c = await snap(page, 'cut', size);
    check(`A2-cut-${size}`, !c.overflow && !c.off.length, `off=${c.off.join(',')}`);
    // ⋯ menu
    await page.tap('.m-appbar .m-more'); await settle(page, 500);
    const menu = await page.evaluate(() => document.querySelectorAll('dialog.m-action[open] .m-act-row').length);
    check(`A1-menu-${size}`, menu >= 6, `rows=${menu}`);
    await page.keyboard.press('Escape'); await settle(page, 400);
  });
  check(`A1-workspace-${size}`, !errs.length, errs.join(' | '));
}

async function gestures() {
  const errs = await session(DEV[390], async page => {
    await page.goto(`${BASE}/director.html?project=${BN}&mcheck`, { waitUntil: 'networkidle' }); await settle(page, 2500);
    // Select via a label
    const label = page.locator('.labels .label:visible').first();
    const id = await label.getAttribute('data-id');
    await label.tap(); await settle(page, 900);
    // Lower the object panel with a real drag so the object can be reached.
    const head = await page.locator('.m-objsheet .m-grab').boundingBox();
    await touchDrag(page, [{ x: head.x + head.width / 2, y: head.y + head.height / 2 }], [{ x: head.x + head.width / 2, y: head.y + head.height / 2 + 200 }]); await settle(page, 900);
    const before = (await projectJson(BN)).scene.entities.find(e => e.id === id).position;
    const pt = await page.evaluate(id => window.__mobile.screenOf(id), id);
    console.log('MOVE target', JSON.stringify({ id, pt, hit: await page.evaluate(p => document.elementFromPoint(p.x, p.y)?.outerHTML.slice(0, 200), pt) }));
    const undoBefore = await page.evaluate(() => document.querySelector('.m-appbar .m-undo')?.disabled);
    await touchDrag(page, [pt], [{ x: pt.x + 120, y: pt.y }]); await settle(page, 1500);
    const after = (await projectJson(BN)).scene.entities.find(e => e.id === id).position;
    const undoAfter = await page.evaluate(() => document.querySelector('.m-appbar .m-undo')?.disabled);
    check('A8-move', JSON.stringify(before) !== JSON.stringify(after) && undoAfter === false, `before=${before} after=${after} undoDisabled ${undoBefore}→${undoAfter}`);
    await page.evaluate(() => document.querySelector('.m-appbar .m-undo').click()); await settle(page, 1200);
    const restored = (await projectJson(BN)).scene.entities.find(e => e.id === id).position;
    check('A8-undo', JSON.stringify(restored) === JSON.stringify(before), `restored=${restored}`);
    // Pinch on empty space: nothing moves
    await page.evaluate(() => window.__mobile.clearSelection()); await settle(page, 600);
    const all0 = JSON.stringify((await projectJson(BN)).scene.entities.map(e => e.position));
    const empty = await page.evaluate(() => { const r = document.querySelector('canvas.main').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 100 }; });
    await touchDrag(page, [{ x: empty.x - 30, y: empty.y }, { x: empty.x + 30, y: empty.y }], [{ x: empty.x - 90, y: empty.y }, { x: empty.x + 90, y: empty.y }]); await settle(page, 1200);
    const all1 = JSON.stringify((await projectJson(BN)).scene.entities.map(e => e.position));
    check('A8-pinch', all0 === all1, 'positions unchanged');
    // Long-press empty → Add sheet
    await touchDrag(page, [empty], [empty], 550); await settle(page, 900);
    const add = await page.evaluate(() => !!document.querySelector('.m-sheet.m-open .m-addgrid, dialog[open] .m-addgrid'));
    check('A8-longpress-add', add, '');
  });
  check('A1-gestures', !errs.length, errs.join(' | '));
}

async function cut() {
  const errs = await session(DEV[390], async page => {
    await page.goto(`${BASE}/director.html?project=${FL}&view=sequence&mcheck`, { waitUntil: 'networkidle' }); await settle(page, 2500);
    const r = await page.evaluate(() => ({ rows: document.querySelectorAll('.sq-board > .m-cutrow').length, all: document.querySelectorAll('.sq-board > *').length }));
    const m = await page.evaluate(pageMetrics);
    check('A9-rows', r.rows > 0 && r.rows === r.all && !m.off.length && !m.overflow, `${JSON.stringify(r)} off=${m.off.join(',')}`);
    // Compare seam
    const hasCompare = await page.evaluate(() => { const b = [...document.querySelectorAll('.sq-viewer .seg button')].find(x => x.textContent === 'Compare' && !x.disabled); b?.click(); return !!b; });
    await settle(page, 1200);
    if (hasCompare) {
      const s0 = await page.evaluate(() => document.querySelector('.sq-over').style.clipPath);
      const box = await page.locator('.sq-seam').boundingBox();
      const seam = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await touchDrag(page, [seam], [{ x: seam.x - 80, y: seam.y }]); await settle(page, 500);
      const s1 = await page.evaluate(() => document.querySelector('.sq-over').style.clipPath);
      check('A9-seam', s0 !== s1, `${s0} → ${s1}`);
    } else check('A9-seam', false, 'no Compare available');
    await snap(page, 'cut', 'finallap-390');
    await page.tap('.sq-board > .m-cutrow:nth-child(1) .m-cr-main'); await settle(page, 800);
    const sheet = await page.evaluate(() => !!document.querySelector('.m-sheet.m-open select[aria-label^="Version"]'));
    check('A9-shotsheet', sheet, '');
    await snap(page, 'cut-shot', 390);
    await page.keyboard.press('Escape'); await settle(page, 500);
    const order0 = (await projectJson(FL)).shots.map(s => s.id);
    const h1 = await page.locator('.sq-board > .m-cutrow:nth-child(1) .m-cr-grip').boundingBox();
    const h2 = await page.locator('.sq-board > .m-cutrow:nth-child(2) .m-cr-grip').boundingBox();
    await touchDrag(page, [{ x: h1.x + h1.width / 2, y: h1.y + h1.height / 2 }], [{ x: h1.x + h1.width / 2, y: h2.y + h2.height / 2 + 10 }], 400); await settle(page, 1500);
    const order1 = (await projectJson(FL)).shots.map(s => s.id);
    check('A9-reorder', order1[0] === order0[1] && order1[1] === order0[0], `${order0.slice(0, 2)} → ${order1.slice(0, 2)}`);
    await page.evaluate(() => document.querySelector('.m-appbar .m-undo').click()); await settle(page, 1500);
    const order2 = (await projectJson(FL)).shots.map(s => s.id);
    check('A9-undo', order2.join() === order0.join(), '');
  });
  check('A1-cut', !errs.length, errs.join(' | '));
  // 768 Cut for the screenshot set
  await session(DEV[768], async page => { await page.goto(`${BASE}/director.html?project=${FL}&view=sequence&mcheck`, { waitUntil: 'networkidle' }); await settle(page, 2500); await snap(page, 'cut', 'finallap-768'); await page.tap('.sq-board > .m-cutrow:nth-child(1) .m-cr-main'); await settle(page, 800); await snap(page, 'cut-shot', 768); });
}

async function landscape() {
  const errs = await session(DEV[844], async page => {
    await page.goto(`${BASE}/director.html?project=${BN}&mcheck`, { waitUntil: 'networkidle' }); await settle(page, 2500);
    const r = await page.evaluate(() => { const vis = s => { const e = document.querySelector(s); return !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height > 0; }; return { bar: vis('.m-appbar'), tab: vis('.m-tabbar'), vp: document.querySelector('.viewport').getBoundingClientRect().height / innerHeight, pill: vis('.m-steppill'), short: document.body.classList.contains('m-short') }; });
    await page.screenshot({ path: `${OUT}/landscape-844.png` });
    check('A10-landscape', !r.bar && !r.tab && r.vp >= 0.95 && r.pill && r.short, JSON.stringify(r));
  });
  check('A1-landscape', !errs.length, errs.join(' | '));
}

async function reduced() {
  await session(DEV[390], async page => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${BASE}/director.html?project=${BN}&mcheck`, { waitUntil: 'networkidle' }); await settle(page, 2500);
    await page.evaluate(() => { const c = document.querySelector('canvas.main'); c.style.visibility = 'hidden'; document.querySelector('.labels').style.visibility = 'hidden'; });
    await page.tap('.m-fab.scene');
    await page.waitForTimeout(16);
    const a = await page.screenshot(); await page.waitForTimeout(50); const b = await page.screenshot();
    const t = await page.evaluate(() => getComputedStyle(document.querySelector('.m-sheet.m-open')).transitionDuration);
    check('A11-reduced', Buffer.compare(a, b) === 0, `transition=${t} diff=${diffRatio(a, b)}`);
  });
}

async function camera() {
  const errs = await session(DEV[390], async page => {
    await page.goto(`${BASE}/director.html?project=${BN}&view=shoot&mcheck`, { waitUntil: 'networkidle' }); await settle(page, 2500);
    await page.tap('.m-appbar .m-more'); await settle(page, 400);
    await page.locator('dialog.m-action .m-act-row', { hasText: 'Use this phone as camera' }).tap(); await settle(page, 1200);
    const r = await page.evaluate(() => {
      const hud = document.querySelector('.m-camera'); const sh = hud?.querySelector('.m-shutter')?.getBoundingClientRect();
      const unlabeled = [...(hud?.querySelectorAll('button, input') || [])].filter(b => !b.getAttribute('aria-label') && !b.textContent.trim()).length;
      return { hud: !!hud, https: !!document.querySelector('.m-sheet.m-open .m-https, dialog[open] .m-https'), shutter: sh ? Math.min(sh.width, sh.height) : 0, unlabeled, aim: window.__operate?.state().phase };
    });
    await page.screenshot({ path: `${OUT}/camera-390.png` });
    check('A12-camera', r.hud && r.https && r.shutter >= 72 && !r.unlabeled, JSON.stringify(r));
    await page.getByRole('button', { name: 'Use touch aim', exact: true }).tap(); await settle(page, 400);
    const touch = await page.evaluate(() => ({ hud: !!document.querySelector('.m-camera:not([hidden])'), phase: window.__operate?.state().phase }));
    await page.screenshot({ path: `${OUT}/camera-touch-390.png` });
    check('A12-touchaim', touch.hud && touch.phase === 'live', JSON.stringify(touch));
    check('A12-mobile-hud-only', await page.evaluate(() => getComputedStyle(document.querySelector('.op-hud')).display === 'none'), 'desktop Operate overlay hidden');
    const before = await projectJson(BN), beforeCamera = JSON.stringify(before.shots[0].camera);
    await page.tap('.m-shutter');
    await touchDrag(page, [{ x: 140, y: 350 }], [{ x: 220, y: 390 }]); await settle(page, 1200);
    if (await page.evaluate(() => window.__operate.state().phase === 'live')) await page.tap('.m-shutter'); await settle(page, 500);
    check('A12-record', await page.evaluate(() => window.__operate.state().phase === 'review'), 'touch aim take recorded');
    await page.getByRole('button', { name: 'Keep this take as the shot camera', exact: true }).tap(); await settle(page, 1200);
    const kept = await projectJson(BN);
    check('A12-keep', JSON.stringify(kept.shots[0].camera) !== beforeCamera, 'camera persisted on disposable project');
    await page.getByRole('button', { name: 'Done: leave camera mode', exact: true }).tap();
    await page.tap('.m-appbar .m-undo'); await settle(page, 1000);
    check('A12-undo', JSON.stringify((await projectJson(BN)).shots[0].camera) === beforeCamera, 'original camera restored');
  });
  check('A1-camera', !errs.length, errs.join(' | '));
  await session(DEV[768], async page => { await page.goto(`${BASE}/director.html?project=${BN}&view=shoot&mcheck`, { waitUntil: 'networkidle' }); await settle(page, 2500); await page.evaluate(() => window.__mobile.camera()); await settle(page, 1000); await page.getByRole('button', { name: 'Use touch aim', exact: true }).tap(); await settle(page, 400); await page.screenshot({ path: `${OUT}/camera-768.png` }); });
}

async function phonePage() {
  const errs = await session(DEV[390], async page => {
    await page.goto(`${BASE}/phone.html`, { waitUntil: 'networkidle' }); await settle(page, 1200);
    const r = await page.evaluate(() => { const texts = [...document.querySelectorAll('body *')].filter(el => el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== 'hidden' && [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())); const min = Math.min(...texts.map(el => parseFloat(getComputedStyle(el).fontSize))); return { bg: getComputedStyle(document.body).backgroundColor, min, smallest: texts.filter(el => parseFloat(getComputedStyle(el).fontSize) < 12).map(el => el.textContent.trim().slice(0, 20)).slice(0, 5) }; });
    await page.screenshot({ path: `${OUT}/phone-390.png` });
    check('A13-phone', r.bg === 'rgb(18, 17, 16)' && r.min >= 12, JSON.stringify(r));
  });
  check('A1-phone', !errs.length, errs.join(' | '));
}

async function menus() {
  for (const size of [390, 768]) {
    const errs = await session(DEV[size], async page => {
      await page.goto(`${BASE}/director.html?project=${BN}&mcheck`, { waitUntil: 'networkidle' }); await settle(page, 1200);
      const renderer = await page.evaluate(() => { const gl = document.querySelector('canvas.main').getContext('webgl2'); const ext = gl.getExtension('WEBGL_debug_renderer_info'); return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : ''; });
      check(`GPU-${size}`, /Metal/.test(renderer) && !/SwiftShader|software|llvmpipe/i.test(renderer), renderer);
      for (const [name, screen] of [['Library', 'library'], ['Direct with Claude', 'claude'], ['Guide', 'guide']]) {
        await page.tap('.m-appbar .m-more'); await settle(page, 400);
        await page.getByRole('button', { name, exact: true }).tap(); await settle(page, 600);
        check(`A1-${screen}-open-${size}`, await page.locator('dialog[open]').count() > 0);
        await snap(page, screen, size);
        await page.keyboard.press('Escape'); await settle(page, 400);
        check(`A1-${screen}-close-${size}`, await page.locator('dialog[open]').count() === 0);
      }
    });
    check(`A1-more-sheets-${size}`, !errs.length, errs.join(' | '));
  }
}
