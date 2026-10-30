#!/usr/bin/env node
// Re-export the launch page starters from their source projects into examples/starters/.
//
//   node scripts/export-starters.mjs --server http://127.0.0.1:5173
//   node scripts/export-starters.mjs --data-dir ~/path/to/previs-data
//
// Each starter is written to examples/starters/<slug>/starter.json (no renders, references or
// assets for now). Run it again after editing a starter project to refresh the snapshot.
// Override a source project with --<slug> <project-id>.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { STARTERS_DIR, starterSnapshot } from '../server/previs/starters.mjs';

export const SOURCES = [
  { slug: 'breaking-news', id: 'ff685e99-00bf-4f5f-979a-944f0caca7c9', title: 'Breaking News', description: 'News anchor delivers the headline' },
  { slug: 'wingspan', id: 'f158baf1-2cac-4311-859a-e5c590d381d4', title: 'Wingspan', description: 'Eagle dives through an alpine valley' },
  { slug: 'final-lap', id: 'ac79f20f-85d2-44ba-b1a4-0692c7eb6b0f', title: 'Final Lap', description: 'Comfy car wins on the last lap' },
  { slug: 'posterized', id: '5e9f88cf-0638-43aa-bba5-2eb9fa4cd7d6', title: 'Posterized', description: 'Comfy dunk in a packed arena' },
];

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const server = opt('server'), dataDir = opt('data-dir') || process.env.PREVIS_DATA_DIR;
const out = opt('out') || STARTERS_DIR;
if (!server && !dataDir) {
  console.error('Usage: node scripts/export-starters.mjs (--server <url> | --data-dir <dir>) [--out <dir>] [--<slug> <project-id>]');
  process.exit(2);
}

async function project(id) {
  if (server) {
    const r = await fetch(new URL(`/api/director/project?id=${id}`, server));
    const data = await r.json();
    if (!r.ok) throw Error(data.error || `HTTP ${r.status}`);
    return data.project;
  }
  return JSON.parse(await readFile(join(dataDir, 'director', id, 'project.json'), 'utf8'));
}

const written = [];
for (const [order, src] of SOURCES.entries()) {
  const id = opt(src.slug) || src.id;
  let p;
  try { p = await project(id); } catch (e) { console.error(`✗ ${src.slug}: could not read project ${id} (${e.message})`); process.exitCode = 1; continue; }
  const snap = starterSnapshot(p, { slug: src.slug, title: src.title, description: src.description, order });
  await mkdir(join(out, src.slug), { recursive: true });
  await writeFile(join(out, src.slug, 'starter.json'), `${JSON.stringify(snap, null, 2)}\n`);
  written.push(src.slug);
  console.log(`✓ ${src.slug}: ${snap.scene.entities.length} objects, ${snap.shots.length} shots`);
}
// The index lists every starter the server offers, in launch-page order.
let index = { starters: [] };
try { index = JSON.parse(await readFile(join(out, 'index.json'), 'utf8')); } catch {}
const order = [...new Set([...SOURCES.map(s => s.slug).filter(s => written.includes(s) || index.starters.includes(s)), ...index.starters])];
await writeFile(join(out, 'index.json'), `${JSON.stringify({ starters: order }, null, 2)}\n`);
