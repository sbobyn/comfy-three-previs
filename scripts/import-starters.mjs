#!/usr/bin/env node
// Load the bundles in examples/starters into a data directory as the canonical source projects.
//
//   node scripts/import-starters.mjs --data-dir ~/path/to/previs-data
//   node scripts/import-starters.mjs --data-dir ~/path/to/previs-data --only wingspan --force
//
// The bundle is the source of truth. Each starter becomes the project `starterSourceId(slug)` (see SOURCES in
// export-starters.mjs) with every entity, shot, image, clip and blocking signature id kept, plus its media files, so
// `pnpm starters:export --data-dir <dir> --check` reproduces the bundle byte for byte. Importing never renews ids
// (a user's copy from the Starters row does). An existing source project is left alone unless --force replaces
// its document and files. Stop any server that uses the directory first: a running server caches projects.
import { mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { loadStarters, starterSourceProject, STARTERS_DIR } from '../server/previs/starters.mjs';
import { atomicJson } from '../server/previs/atomic.mjs';
import { SOURCES } from './export-starters.mjs';

/** Write the source projects of the bundles (all, or `only` one) into `dataDir`. Returns [{ slug, id, files }]. */
export async function importStarters({ dataDir, startersDir = STARTERS_DIR, only, force = false, log = console.log } = {}) {
  const starters = (await loadStarters(startersDir)).filter(s => !only || s.slug === only);
  if (only && !starters.length) throw Error(`No starter "${only}" in ${startersDir}`);
  const done = [];
  for (const s of starters) {
    const src = SOURCES.find(x => x.slug === s.slug);
    if (!src) throw Error(`${s.slug} is not listed in SOURCES (scripts/export-starters.mjs)`);
    const { project, files } = starterSourceProject(s, { id: src.id });
    const dir = join(dataDir, 'director', project.id);
    if (existsSync(join(dir, 'project.json')) && !force) { log(`• ${s.slug}: ${project.id} already exists, left alone (use --force to replace it)`); continue; }
    for (const f of files) {
      const to = join(dir, f.to);
      await mkdir(dirname(to), { recursive: true });
      await copyFile(join(s.dir, f.from), to);
    }
    await atomicJson(join(dir, 'project.json'), project);
    log(`✓ ${s.slug}: project ${project.id}, ${files.length} files`);
    done.push({ slug: s.slug, id: project.id, files: files.length });
  }
  return done;
}

async function main(args) {
  const opt = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const dataDir = opt('data-dir') || process.env.PREVIS_DATA_DIR;
  if (!dataDir) { console.error('Usage: node scripts/import-starters.mjs --data-dir <dir> [--only <slug>] [--force]'); process.exit(2); }
  await importStarters({ dataDir, only: opt('only'), force: args.includes('--force') });
}

if (import.meta.url === `file://${process.argv[1]}`) await main(process.argv.slice(2));
