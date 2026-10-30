#!/usr/bin/env node
// Capture the guide's media from the four starters on a running server → public/guide/ + manifest.json.
// GET requests and page views only: nothing is edited, rendered or generated.
//
//   node scripts/guide-media.mjs [--base http://127.0.0.1:5274] [--out public/guide] [--all] [--no-screens]
//
//   --all          every shot with a generated video, not just the one picked per starter
//   --no-screens   skip the browser screenshots (home, Build, Shoot, Generate, Cut, phone)
//   PREVIS_FFMPEG  ffmpeg binary (default: ffmpeg on PATH); PREVIS_CHROMIUM as for the server
//
// Per starter: blockout clip and generated video (640×360 H.264, ≤ 1 MB, same length), their first
// frames, the shot's start still with the matching blockout frame, cast images and a design sheet
// (WebP). Screenshots at 1280×800 (phone 390×844) with the Cut view's controls located for callouts.
import { mkdir, writeFile, readdir, stat, rm, mkdtemp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CHROMIUM_ARGS, resolveExecutable } from '../server/previs/headless.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const base = (opt('--base', process.env.PREVIS_URL || 'http://127.0.0.1:5274')).replace(/\/$/, '');
const root = resolve(import.meta.dirname, '..');
const out = resolve(root, opt('--out', 'public/guide'));
const all = args.includes('--all'), screens = !args.includes('--no-screens');
const ffmpeg = process.env.PREVIS_FFMPEG || 'ffmpeg';
const CLIP_MAX = 1024 * 1024, TOTAL_MAX = 12 * 1024 * 1024;

// Starters by title (ids differ per data folder); `shot` is the index used for the guide.
const STARTERS = [
  { slug: 'breaking-news', title: /Breaking News/i, shot: 1 },
  { slug: 'final-lap', title: /Final Lap/i, shot: 1 },
  { slug: 'wingspan', title: /Wingspan/i, shot: 1 },
  { slug: 'posterized', title: /Posterized/i, shot: 0 },
];
// Guide aliases → per-starter files (no duplicate media).
const GUIDE = { cast: ['breaking-news', 1], generate: ['final-lap', 1] };

const get = async path => { const r = await fetch(`${base}/api/${path}`); if (!r.ok) throw new Error(`GET /api/${path} → ${r.status}`); return r.json(); };
const ff = (...a) => execFileSync(ffmpeg, ['-y', '-v', 'error', ...a], { stdio: ['ignore', 'ignore', 'inherit'] });
const size = async f => (await stat(f)).size;
const kb = n => `${Math.round(n / 1024)} KB`;
const assetUrl = (pid, file) => `${base}/director-assets/${pid}/${file.replace(/^assets\//, '')}`;
const refUrl = (pid, file) => `${base}/director-refs/${pid}/${file}`;
const now = new Date().toISOString();
const entries = [], missing = [];
const add = e => { entries.push({ capturedAt: now, ...e }); return e; };

/** 640×360 H.264, no audio, faststart; raises CRF until the file fits CLIP_MAX. */
async function clip(src, dest, seconds) {
  for (const crf of [23, 26, 29, 32]) {
    ff('-i', src, '-t', seconds.toFixed(3), '-an', '-vf', 'scale=640:360:force_original_aspect_ratio=increase,crop=640:360,fps=24', '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', dest);
    if (await size(dest) <= CLIP_MAX) return;
  }
  throw new Error(`Clip exceeds the 1 MB budget: ${dest}`);
}
const still = (src, dest, { at = 0, w = 640, h = 360, q = 78, last = false } = {}) =>
  ff(...(last ? ['-sseof', '-0.1'] : ['-ss', String(at)]), '-i', src, '-frames:v', '1', '-vf', `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`, '-c:v', 'libwebp', '-quality', String(q), dest);
/** WebP at w×h (cropped to fill), or w wide keeping the aspect when h is 0. */
const image = (src, dest, w, h, q = 80) => ff('-i', src, '-frames:v', '1', '-vf', h ? `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}` : `scale=${w}:-2`, '-c:v', 'libwebp', '-quality', String(q), dest);

// Preserve captured media: use a fresh output directory for each capture.
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) throw new Error('Output directory is not empty; choose a fresh --out directory.');
const tmp = await mkdtemp(join(tmpdir(), 'guide-media-'));

const { projects } = await get('director/projects');
const found = [];
for (const s of STARTERS) {
  // Several copies can exist; take the one with the most saved media.
  const summary = projects.filter(p => s.title.test(p.title)).sort((a, b) => (b.assets || 0) - (a.assets || 0) || (b.references || 0) - (a.references || 0))[0];
  if (!summary) { missing.push(`starter ${s.slug} not on the server`); continue; }
  const { project: p } = await get(`director/project?id=${summary.id}`);
  found.push({ ...s, project: p });
  const label = p.title.replace(/^Starter · /, '');
  const shots = all ? p.shots.map((_, i) => i) : [s.shot];
  for (const i of shots) {
    const shot = p.shots[i]; if (!shot) continue;
    const tag = `${s.slug}-s${i + 1}`, meta = { project: p.id, shot: shot.id, label: `${label} · ${shot.title}` };
    const video = (p.assets || []).filter(a => a.kind === 'workflow-result' && a.shotId === shot.id).at(-1);
    const block = (video && p.assets.find(a => a.id === video.source?.sourceAssetId)) || (p.assets || []).filter(a => a.kind === 'camera-render' && a.shotId === shot.id).at(-1);
    if (block && video) {
      const seconds = Math.min(block.duration || shot.duration, video.duration || shot.duration);
      await clip(assetUrl(p.id, block.file), join(out, `${tag}-blockout.mp4`), seconds);
      await clip(assetUrl(p.id, video.file), join(out, `${tag}-generated.mp4`), seconds);
      still(join(out, `${tag}-blockout.mp4`), join(out, `${tag}-blockout.webp`));
      still(join(out, `${tag}-generated.mp4`), join(out, `${tag}-generated.webp`));
      add({ id: `${tag}-blockout`, file: `${tag}-blockout.mp4`, kind: 'video', asset: block.id, ...meta });
      add({ id: `${tag}-generated`, file: `${tag}-generated.mp4`, kind: 'video', asset: video.id, model: (video.source?.workflow || '').split(' ·')[0], ...meta });
      add({ id: `${tag}-blockout-poster`, file: `${tag}-blockout.webp`, kind: 'image', asset: block.id, ...meta });
      add({ id: `${tag}-generated-poster`, file: `${tag}-generated.webp`, kind: 'image', asset: video.id, ...meta });
    } else missing.push(`${tag}: no ${block ? 'generated video' : 'blockout clip'}`);
    // The shot's still and the blockout frame it was made from (start key → first frame, end key → last).
    const frame = (shot.references || []).find(r => r.role === 'frame' && /start/i.test(r.note || '')) || (shot.references || []).find(r => r.role === 'frame');
    if (frame && block) {
      image(refUrl(p.id, frame.file), join(out, `${tag}-still.webp`), 640, 360);
      still(assetUrl(p.id, block.file), join(out, `${tag}-still-blockout.webp`), { last: /end/i.test(frame.note || '') });
      add({ id: `${tag}-still`, file: `${tag}-still.webp`, kind: 'image', asset: frame.id, model: frame.generated?.model, ...meta });
      add({ id: `${tag}-still-blockout`, file: `${tag}-still-blockout.webp`, kind: 'image', asset: block.id, ...meta });
    } else missing.push(`${tag}: no still`);
  }
  // Cast images: the first image of each object (characters first), and one design sheet.
  const refs = p.scene.references || [], names = new Map(p.scene.entities.map(e => [e.id, e.name]));
  const firsts = [...new Map(refs.filter(r => r.entityId && ['character', 'vehicle', 'prop'].includes(r.role) && !/design sheet|· (Front|Back|Left|Right)/i.test(r.name)).map(r => [r.entityId, r])).values()]
    .sort((a, b) => (a.role === 'character' ? 0 : 1) - (b.role === 'character' ? 0 : 1)).slice(0, 4);
  for (const [n, r] of firsts.entries()) {
    image(refUrl(p.id, r.file), join(out, `${s.slug}-cast-${n + 1}.webp`), 160, 160);
    add({ id: `${s.slug}-cast-${n + 1}`, file: `${s.slug}-cast-${n + 1}.webp`, kind: 'image', project: p.id, asset: r.id, label: names.get(r.entityId) || r.name.split(' · ')[0] });
  }
  const sheet = refs.find(r => /design sheet/i.test(r.name));
  if (sheet) {
    image(refUrl(p.id, sheet.file), join(out, `${s.slug}-sheet.webp`), 640, 0);
    add({ id: `${s.slug}-sheet`, file: `${s.slug}-sheet.webp`, kind: 'image', project: p.id, asset: sheet.id, label: sheet.name });
  } else missing.push(`${s.slug}: no design sheet (J12)`);
}

// Guide aliases.
const byId = { get: id => entries.find(e => e.id === id), has: id => entries.some(e => e.id === id) };
const alias = (id, from) => { const e = byId.get(from); if (e) add({ ...e, id }); else missing.push(`guide ${id} (needs ${from})`); };
{ const [slug, i] = GUIDE.cast; const t = `${slug}-s${i + 1}`; alias('cast-before', `${t}-still-blockout`); alias('cast-after', `${t}-still`); for (const n of [1, 2, 3, 4]) if (byId.has(`${slug}-cast-${n}`)) alias(`cast-image-${n}`, `${slug}-cast-${n}`); }
{ const [slug, i] = GUIDE.generate; const t = `${slug}-s${i + 1}`; alias('generate-before', `${t}-blockout`); alias('generate-after', `${t}-generated`); alias('generate-before-poster', `${t}-blockout-poster`); alias('generate-after-poster', `${t}-generated-poster`); }

// Screenshots: one headless Chromium, GPU only.
if (screens) {
  let chromium = null;
  try { ({ chromium } = await import('playwright-core')); } catch { missing.push('screenshots: playwright-core is not installed'); }
  const executablePath = resolveExecutable();
  if (chromium && !executablePath) missing.push('screenshots: no Chromium found (set PREVIS_CHROMIUM)');
  if (chromium && executablePath) {
    const browser = await chromium.launch({ executablePath, headless: true, args: [...CHROMIUM_ARGS], ignoreDefaultArgs: ['--enable-unsafe-swiftshader'] });
    try {
      const shot = async (page, name, label, extra = {}) => { const png = join(tmp, `${name}.png`); await page.screenshot({ path: png }); image(png, join(out, `${name}.webp`), page.viewportSize().width, 0, 82); add({ id: name, file: `${name}.webp`, kind: 'image', label, ...extra }); };
      const settle = page => page.waitForTimeout(1500);
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
      page.on('dialog', d => void d.dismiss());
      await page.goto(`${base}/`, { waitUntil: 'networkidle' }); await settle(page);
      await shot(page, 'home', 'Home');
      const bn = found.find(f => f.slug === 'breaking-news')?.project;
      if (bn) {
        await page.goto(`${base}/director.html?project=${bn.id}`, { waitUntil: 'networkidle' }); await settle(page);
        await shot(page, 'build', 'Build', { project: bn.id });
        await page.goto(`${base}/director.html?project=${bn.id}&view=shoot`, { waitUntil: 'networkidle' }); await settle(page);
        await shot(page, 'shoot', 'Shoot', { project: bn.id });
        // Opens the Generate dialog only (a free quote); never submits.
        const gen = page.getByRole('button', { name: /^Generate video/ }).last();
        if (await gen.count() && await gen.isVisible()) {
          await gen.click(); await page.waitForSelector('dialog[open]', { timeout: 8000 }).catch(() => {}); await settle(page);
          if (await page.locator('dialog[open]').count()) await shot(page, 'generate', 'Generate video dialog', { project: bn.id }); else missing.push('screenshot generate: dialog did not open');
          await page.keyboard.press('Escape');
        } else missing.push('screenshot generate: no “Generate video” button (the shot needs a blockout)');
        await page.goto(`${base}/director.html?project=${bn.id}&view=sequence`, { waitUntil: 'networkidle' }); await settle(page);
        // Cut board callouts: fractions of the 1280×800 frame.
        const callouts = await page.evaluate(() => {
          const W = innerWidth, H = innerHeight, row = document.querySelector('.sq-row');
          const box = (el, label) => { if (!el) return null; const r = el.getBoundingClientRect(); return r.width ? { label, x: r.left / W, y: r.top / H, w: r.width / W, h: r.height / H } : null; };
          const exp = [...document.querySelectorAll('.sq-export button, .sq-viewer button')].find(b => /export/i.test(b.textContent || ''));
          return [box(row?.querySelector('.sq-grip'), 'Drag to reorder'), box(row?.querySelector('.sq-cut select'), 'Version used in the cut'), box(row?.querySelector('.sq-trim'), 'Trim in → out'),
            box(row?.querySelector('button[aria-pressed]'), 'In cut or left out'), box(document.querySelector('.sq-screen'), 'Compare blockout and generated'), box(exp, 'Export the film')].filter(Boolean);
        });
        await shot(page, 'cut', 'Cut', { project: bn.id, callouts });
        alias('cut-board', 'cut');
        if (callouts.length < 6) missing.push(`cut callouts: found ${callouts.length} of 6`);
      }
      await page.close();
      const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await phone.goto(`${base}/phone.html`, { waitUntil: 'networkidle' }); await settle(phone);
      await shot(phone, 'phone', 'Phone camera page (J9)');
      await phone.close();
    } finally { await browser.close(); }
  }
}
await rm(tmp, { recursive: true, force: true });

const files = await readdir(out);
let total = 0; for (const f of files) total += await size(join(out, f));
const sizes = Object.fromEntries(await Promise.all(files.map(async f => [f, await size(join(out, f))])));
const notCovered = ['J12: one design sheet per starter is captured, not one per sheet type', ...missing];
await writeFile(join(out, 'manifest.json'), JSON.stringify({ capturedAt: now, source: 'scripts/guide-media.mjs', entries: entries.map(e => ({ ...e, bytes: sizes[e.file] })), missing: notCovered }, null, 2) + '\n');
for (const f of files.sort()) console.log(`${f.padEnd(40)} ${kb(sizes[f]).padStart(8)}`);
console.log(`\n${files.length} files · ${(total / 1024 / 1024).toFixed(2)} MB${total > TOTAL_MAX ? ' — OVER the 12 MB budget' : ''}`);
if (total + await size(join(out, 'manifest.json')) > TOTAL_MAX) throw new Error('Guide media exceeds the 12 MB budget');
if (notCovered.length) console.log(`Not covered:\n- ${notCovered.join('\n- ')}`);
