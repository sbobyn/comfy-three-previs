#!/usr/bin/env node
// Snapshot the starter projects from a running Comfy Three Previs server into
// a static read-only demo (dist-demo/demo-data + dist-demo/demo-media).
// GET requests only. Run after `VITE_DEMO=1 vite build ... --outDir dist-demo`
// (or just `pnpm run demo:build`).
//
//   PREVIS_URL        server to read from (default http://127.0.0.1:5230)
//   PREVIS_DATA       that server's data dir, for media files
//                     (default .evidence/dev-data, the same default as scripts/publish-public.sh)
//   DEMO_PROJECTS     comma-separated project ids (default: the four starters)
//   DEMO_MEDIA_MB     media budget in MB (default 60)
import { mkdir, writeFile, copyFile, readdir, stat, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = join(root, 'dist-demo');
const server = process.env.PREVIS_URL || 'http://127.0.0.1:5230';
const data = resolve(root, process.env.PREVIS_DATA || '.evidence/dev-data');
const ids = (process.env.DEMO_PROJECTS || 'ff685e99-00bf-4f5f-979a-944f0caca7c9,f158baf1-2cac-4311-859a-e5c590d381d4,ac79f20f-85d2-44ba-b1a4-0692c7eb6b0f,5e9f88cf-0638-43aa-bba5-2eb9fa4cd7d6').split(',');
const budget = Number(process.env.DEMO_MEDIA_MB || 60) * 1024 * 1024;

if (!existsSync(join(out, 'director.html'))) throw new Error('dist-demo/ not built — run: VITE_DEMO=1 vite build --base=/comfy-three-previs/ --outDir dist-demo');

const get = async path => {
  const r = await fetch(server + '/api/' + path);
  if (!r.ok) throw new Error(`GET /api/${path} → ${r.status}`);
  return r.json();
};

// Drop secrets and machine-specific paths.
const SECRET = /^(api[-_]?key|key|token|secret|authorization|password|credentials?)$/i;
const PATH = /(?:\/Users|\/home|\/var\/folders|\/private|\/tmp|[A-Z]:\\\\Users)\/[^"'\s)]*/g;
function clean(v) {
  if (Array.isArray(v)) return v.map(clean);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !SECRET.test(k)).map(([k, x]) => [k, clean(x)]));
  if (typeof v === 'string') return v.replace(PATH, '<local path>');
  return v;
}

// GitHub Pages serves index.html at the root: make that the project home (start.html). The old camera studio
// is gone (public/index.html is only a redirect stub), so it is replaced rather than kept as camera.html;
// the other retired pages stay as redirect stubs to the home page.
await copyFile(join(out, 'start.html'), join(out, 'index.html'));
await rm(join(out, 'camera.html'), { force: true });

const dataDir = join(out, 'demo-data'), mediaDir = join(out, 'demo-media');
await rm(dataDir, { recursive: true, force: true }); await rm(mediaDir, { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });
const write = (name, body) => writeFile(join(dataDir, name), JSON.stringify(clean(body)));

const { projects } = await get('director/projects');
const listed = ids.map(id => projects.find(p => p.id === id)).filter(Boolean);
if (listed.length !== ids.length) console.warn(`warning: ${ids.length - listed.length} requested project(s) not on the server`);
await write('projects.json', { projects: listed });

let text = '';
for (const p of listed) {
  const project = await get(`director/project?id=${p.id}`);
  project.agent = { connected: false, waiting: false, lastSeen: null, name: null, runner: null };
  const refgen = await get(`director/refgen?projectId=${p.id}`);
  const assets = await get(`director/assets?id=${p.id}`).catch(() => ({ assets: [] }));
  await write(`project-${p.id}.json`, project);
  await write(`refgen-${p.id}.json`, refgen);
  await write(`assets-${p.id}.json`, assets);
  text += JSON.stringify([project, refgen, assets]);
}

const gen = await get('generation');
gen.jobs = (gen.jobs || []).filter(j => text.includes(j.id));
gen.paidExecutionEnabled = false;
await write('generation.json', gen);
text += JSON.stringify(gen);
const setup = await get('director/setup').catch(() => null);
if (setup) await write('setup.json', setup);

// Media, most important first; stop adding once over budget.
const queue = [];
const dir = async (src, dest) => { if (existsSync(src)) for (const f of await readdir(src)) queue.push([join(src, f), join(dest, f)]); };
for (const p of listed) await dir(join(data, 'director', p.id, 'refs'), join(mediaDir, 'director-refs', p.id));
for (const p of listed) await dir(join(data, 'director', p.id, 'assets'), join(mediaDir, 'director-assets', p.id));
const uuids = new Set(text.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g) || []);
for (const id of uuids) {
  for (const [sub, ext] of [['assets', '.mp4'], ['renders', '.png'], ['assets', '.png']]) {
    const src = join(data, sub, id + ext);
    if (existsSync(src)) queue.push([src, join(mediaDir, sub, id + ext)]);
  }
}
let total = 0, skipped = 0;
for (const [src, dest] of queue) {
  const size = (await stat(src)).size;
  if (total + size > budget) { skipped++; continue; }
  await mkdir(resolve(dest, '..'), { recursive: true });
  await copyFile(src, dest); total += size;
}
console.log(`demo snapshot: ${listed.length} projects, ${gen.jobs.length} generation jobs, ${queue.length - skipped} media files (${(total / 1048576).toFixed(1)} MB)${skipped ? `, ${skipped} skipped over budget` : ''}`);
