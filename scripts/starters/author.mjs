#!/usr/bin/env node
// Copyright (c) 2026 Steven Bobyn. SPDX-License-Identifier: MIT
// Author the blockout-only starters (Mountain Trail, City Blocks, Camera Moves, Look Lab, Two-Hander) through the MCP
// tools, as a user's agent would, on a private server with headless rendering and paid work off:
//
//   PORT=5292 PREVIS_DATA_DIR=/tmp/starter-src PREVIS_HEADLESS=1 PREVIS_ALLOW_PAID=0 node server/previs/server.mjs
//   node scripts/starters/author.mjs --url http://127.0.0.1:5292 [--only look-lab] [--sheets .evidence/starters2]
//   pnpm starters:export --server http://127.0.0.1:5292 --only look-lab --look-lab <project id printed above>
//
// Each scene module (scripts/starters/scenes/<slug>.mjs) builds one project from an empty stage: objects and Cast Cards,
// the imported mannequin (scripts/starters/mannequin.mjs) and its clips, animation, shots and cameras. This script then
// checks every shot the way the starter tests do (the lead stays in frame, prompts carry no camera move), renders the
// blockout clips on the server (free) and, with --sheets, writes a contact sheet per shot. Nothing paid is ever called.
// The bundles in examples/starters stay the source of truth; this is how they were first made.
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connect } from './mcp.mjs';
import { mannequinGlb } from './mannequin.mjs';
import { checkProject } from './kit.mjs';

export const SCENES = ['mountain-trail', 'city-blocks', 'camera-moves', 'look-lab', 'two-hander'];

/** Mannequin GLBs (sand and slate) written once per run. */
async function mannequins() {
  const dir = join(tmpdir(), 'starter-mannequins'); await mkdir(dir, { recursive: true });
  const out = {};
  for (const [name, colours] of Object.entries({ sand: { body: '#c9b79c', trim: '#5b5550' }, slate: { body: '#7d8a99', trim: '#2f3540' } })) {
    out[name] = join(dir, `mannequin-${name}.glb`); await writeFile(out[name], await mannequinGlb(colours));
  }
  return out;
}

/** The authoring context a scene module gets: tool calls with batching, and geometry helpers. */
function context(m, projectId, glbs) {
  let queue = [];
  const h = {
    projectId, glbs, call: m.call,
    op(op) { queue.push(op); return h; },
    // add_entity keeps lookFrom as given; update_entity resolves a name to the object's id, so shared looks link after the add.
    add({ lookFrom, ...entity }) { h.op({ op: 'add_entity', entity }); return lookFrom ? h.op({ op: 'update_entity', id: entity.name, patch: { lookFrom } }) : h; },
    async flush() {
      while (queue.length) {
        const ops = queue.splice(0, 50);
        const r = await m.call('previs_director_edit', { projectId, ops });
        for (const w of r.warnings || []) console.warn(`  ⚠ ${w}`);
      }
    },
    async animate(animations) { await h.flush(); for (let i = 0; i < animations.length; i += 20) await m.call('previs_director_animate', { projectId, animations: animations.slice(i, i + 20) }); },
    async perform(args) { await h.flush(); return m.call('previs_director_perform', { projectId, ...args }); },
    /** Import a mannequin as a character; returns its entity (with model, source and perform). */
    async mannequin(name, { colour = 'sand', position = [0, 0, 0], rotation = 0 } = {}) {
      await h.flush();
      await m.call('previs_import_asset', { projectId, path: glbs[colour], name, kind: 'character', place: { position, rotation }, licence: 'MIT — original procedural mannequin (scripts/starters/mannequin.mjs)', attribution: 'video-lab starters' });
      return (await h.project()).scene.entities.find(e => e.name === name);
    },
    /** Another figure sharing an imported mannequin's file (same model, rig and clips). */
    clone(from, name, { position = [0, 0, 0], rotation = 0, ...rest } = {}) {
      const { id, look, sheets, ...e } = from;
      return h.add({ ...structuredClone(e), name, position, rotation, path: null, ...rest });
    },
    async project() { await h.flush(); return (await m.call('previs_director_get', { projectId })).project; },
  };
  return h;
}

async function main(args) {
  const opt = k => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
  const url = opt('url') || process.env.PREVIS_URL || 'http://127.0.0.1:5292', only = opt('only'), sheets = opt('sheets');
  const m = await connect(url), glbs = await mannequins();
  try {
    for (const slug of SCENES.filter(s => !only || s === only)) {
      const scene = (await import(`./scenes/${slug}.mjs`)).default;
      const { project } = await m.call('previs_director_create_project', { title: scene.title, template: 'empty' });
      console.log(`• ${slug}: project ${project.id}`);
      const h = context(m, project.id, glbs);
      await scene.build(h);
      const p = await h.project();
      const problems = checkProject(p, scene);
      for (const x of problems) console.warn(`  ✗ ${x}`);
      if (problems.length && !args.includes('--force')) { console.warn('  Not rendering: fix the problems above (or pass --force).'); continue; }
      for (const [i, sh] of p.shots.entries()) {
        if (sheets) {
          await mkdir(join(sheets, slug), { recursive: true });
          const v = await m.call('previs_director_view_shot', { projectId: project.id, shot: sh.id, what: 'blockout', contactSheet: 6, width: 960 });
          await writeFile(join(sheets, slug, `${String(i + 1).padStart(2, '0')}.png`), Buffer.from(v.find(c => c.type === 'image').data, 'base64'));
        }
        if (scene.render && !scene.render(sh, i)) continue;
        if (args.includes('--no-render')) continue;
        const r = await m.call('previs_director_render_blockout', { projectId: project.id, shot: sh.id, force: true });
        console.log(`  ✓ ${sh.title}: blockout ${r.asset?.frameCount} frames`);
      }
      console.log(`  → pnpm starters:export --server ${url} --only ${slug} --${slug} ${project.id}`);
    }
  } finally { m.close(); }
}

if (import.meta.url === `file://${process.argv[1]}`) await main(process.argv.slice(2));
