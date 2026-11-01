#!/usr/bin/env node
// Rebuild the starter blockouts that come from the beret-parts parametric library (no Blender needed).
//   BERET_PARTS=/path/to/beret-parts node scripts/blender/library-blockouts.mjs
// Bakes every id in scripts/blender/library-blockouts.json (family, preset/params, seed, Previs shape, minScale) into
// public/models/blockouts, updates those manifest entries, then runs the coplanar lint. People, animals and terrain
// stay on generate-blockouts.py, which skips the ids listed here.
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const lib = process.env.BERET_PARTS;
if (!lib) throw Error('Set BERET_PARTS to a beret-parts checkout (github.com/sbobyn/beret-parts)');
const out = join(root, 'public/models/blockouts');
const baked = JSON.parse(execFileSync(process.execPath, ['src/cli/main.ts', 'bake-blockouts', '--recipe', join(root, 'scripts/blender/library-blockouts.json'), '--out', out], { cwd: lib, encoding: 'utf8' }));
const manifestPath = join(out, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
for (const [id, v] of Object.entries(baked)) manifest[id] = { shape: v.shape, triangles: v.triangles, bytes: v.bytes };
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`library blockouts: ${Object.keys(baked).length} baked from ${lib} (${execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: lib, encoding: 'utf8' }).trim()})`);
execFileSync(process.execPath, ['scripts/blender/lint-blockouts.mjs'], { cwd: root, stdio: 'inherit' });
