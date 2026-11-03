#!/usr/bin/env node
// Re-export the launch page starters from their source projects into examples/starters/.
//
//   node scripts/export-starters.mjs --server http://127.0.0.1:5270
//   node scripts/export-starters.mjs --data-dir ~/path/to/previs-data
//   node scripts/export-starters.mjs --data-dir ~/path/to/previs-data --check
//
// The bundles in examples/starters are the source of truth. `pnpm starters:import` loads them into a data
// directory as the canonical source projects (same ids); this script exports those projects back, and
// `--check` proves the round trip: it exports into a scratch copy of the bundle and fails (exit 1) if any
// JSON or media file would change, was added or would disappear. Nothing in examples/starters is written.
//
// Each starter is written to examples/starters/<slug>/starter.json plus a media/ folder: every object's
// primary look and design sheet, each shot's chosen still, its blockout clip and its chosen video
// (see starterPicks in server/previs/starters.mjs). Images become WebP no larger than 1600 px (a starter may set a smaller `encode`); videos become
// 720p H.264 at up to 2.5 Mbit/s with no audio (needs ffmpeg and ffprobe on PATH); imported models (GLB) are copied
// unchanged. A file whose source
// has not changed is not re-encoded, so re-exports leave unchanged media byte-identical.
//
// Options: --check; --<slug> <project-id> overrides a source project; --only <slug>; --no-media writes the
// version 1 snapshot (no media); --max-mb <n> (default 80) keeps only the hero shots' videos when over.
import { readFile, writeFile, mkdir, readdir, rm, cp, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { STARTERS_DIR, starterSnapshot, starterSourceId } from '../server/previs/starters.mjs';

const run = promisify(execFile);

// id: the canonical source project, the one `pnpm starters:import` writes from the bundle (ids kept, stable per slug).
// legacyId: the dev project the bundle was first exported from (before the 2026-10-31 blocking pass); not used.
// hero: the shots whose videos stay if the media is over budget. An imported source project holds exactly the
// shown still and video of every shot, so no explicit still picks are needed.
const SOURCE_DEFS = [
  { slug: 'breaking-news', legacyId: 'ff685e99-00bf-4f5f-979a-944f0caca7c9', title: 'Breaking News', description: 'A composed news bulletin: the studio, a headline delivered by the anchor, and a confident sign-off.',
    hero: { shots: ['3014d6d1-f093-4e8f-b791-aed102116cf3'] } },
  { slug: 'wingspan', legacyId: 'f158baf1-2cac-4311-859a-e5c590d381d4', title: 'Wingspan', description: 'An eagle descends through an open alpine valley and settles into a majestic low glide across the lake toward the ridge.',
    hero: { shots: ['3fa5f3ef-ff2d-4905-a7ea-d5afc9e5dd1a', '2c4b00d0-4453-42f2-8af7-a058616d2a3e'] } },
  { slug: 'final-lap', legacyId: 'ac79f20f-85d2-44ba-b1a4-0692c7eb6b0f', title: 'Final Lap', description: 'Two cars side by side: the Comfy car draws level, makes the pass and wins across the finish line.',
    hero: { shots: ['95a7f87c-6236-4628-a4e9-88bcea6dc6aa'] } },
  { slug: 'posterized', legacyId: '5e9f88cf-0638-43aa-bba5-2eb9fa4cd7d6', title: 'Posterized', description: 'A fast break, a drive into the lane, then the Comfy guard rising above the defender to finish at the rim.',
    hero: { shots: ['755f685b-a74e-4c80-8ffd-8dc9cbdfd450', '4feea365-12b8-456f-878e-80be456c4c27'] } },
  // Blockout starters (2026-11-02; authored with scripts/starters/author.mjs): blockout clips, no generated media; Look Lab
  // also ships a start still per variant and four videos (the paid hybrid, examples/starters/README.md).
  { slug: 'mountain-trail', title: 'Mountain Trail', description: 'A hiker crosses an open alpine valley toward a lake and a cabin: room to fly a drone or phone camera, with a ridge reveal, a slope dive, a low track and a wide.', hero: { shots: [] } },
  { slug: 'city-blocks', title: 'City Blocks', description: 'A downtown grid with traffic and pedestrians: a drone rise between buildings, a street-level car track, a rooftop orbit and a pedestrian follow.', hero: { shots: [] } },
  { slug: 'camera-moves', title: 'Lighthouse · Camera Moves', description: 'The lighthouse from the launch film. A keeper and a fishing boat: every camera move preset on the same four seconds, custom-key showcases, and shot pairs that craft whip, match, action and wipe transitions.', hero: { shots: [] } },
  // Look Lab ships many looks, so its copy is encoded smaller (540p video, lighter stills) to stay inside the 80 MB budget;
  // the full-quality originals stay in the source project. A media entry records a non-default encode, so changing it re-encodes.
  { slug: 'look-lab', title: 'Look Lab', description: 'One small-town street blockout in thirty-four looks: time of day, weather, seasons, people, wardrobe, anime, claymation, 3D animated and watercolour, all sharing one camera and one blocking.', hero: { shots: [] },
    encode: { imageMaxPx: 1280, imageQuality: 72, videoHeight: 540, videoKbps: 900, videoMaxKbps: 1200 } },
  { slug: 'two-hander', title: 'Two-Hander', description: 'A café conversation in coverage: a master, two over-the-shoulders, an insert of a reach for a cup and a zooming close-up, with seated, posed figures.', hero: { shots: [] } },
];

export const SOURCES = SOURCE_DEFS.map(d => ({ ...d, id: starterSourceId(d.slug) }));

const IMAGE_MAX_PX = 1600, VIDEO_HEIGHT = 720, VIDEO_KBPS = 2000, VIDEO_MAX_KBPS = 2500;
const DEFAULT_ENCODE = { imageMaxPx: IMAGE_MAX_PX, imageQuality: 82, videoHeight: VIDEO_HEIGHT, videoKbps: VIDEO_KBPS, videoMaxKbps: VIDEO_MAX_KBPS };

async function main(args) {
  const opt = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const server = opt('server'), dataDir = opt('data-dir') || process.env.PREVIS_DATA_DIR;
  if (!server && !dataDir) {
    console.error('Usage: node scripts/export-starters.mjs (--server <url> | --data-dir <dir>) [--check] [--out <dir>] [--only <slug>] [--no-media] [--max-mb 80] [--<slug> <project-id>]');
    process.exit(2);
  }
  const ids = Object.fromEntries(SOURCES.map(s => [s.slug, opt(s.slug)]).filter(([, id]) => id));
  const { failed, diffs } = await exportStarters({ server, dataDir, out: opt('out'), only: opt('only'), media: !args.includes('--no-media'), maxMb: Number(opt('max-mb') || 80), check: args.includes('--check'), ids });
  if (failed) process.exitCode = 1;
  if (args.includes('--check')) {
    if (diffs.length) {
      console.error(`✗ Re-exporting would change ${diffs.length} bundled file${diffs.length === 1 ? '' : 's'}:`);
      for (const d of diffs) console.error(`  ${d.change.padEnd(7)} ${d.path}`);
      console.error('The bundle in examples/starters is the source of truth: fix the source project (or run pnpm starters:import again), not the bundle.');
      process.exitCode = 1;
    } else if (!failed) console.log('✓ Re-export reproduces the bundle byte for byte.');
  }
}

/**
 * Export the source projects into `out` (default examples/starters). With `check`, export into a scratch copy of `out`
 * instead and return what differs from `out` (`diffs`: { path, change: 'changed' | 'added' | 'removed' }); `out` is never written.
 * `ids` overrides a source project per slug. `failed` counts starters whose project could not be read.
 */
export async function exportStarters({ server, dataDir, out: outDir, only, media = true, maxMb = 80, check = false, ids = {}, log = console.log } = {}) {
  const target = outDir || STARTERS_DIR, maxBytes = maxMb * 1024 * 1024;
  const scratch = check ? await mkdtemp(join(tmpdir(), 'starters-check-')) : null;
  const out = scratch || target;
  if (scratch) await cp(target, scratch, { recursive: true });
  try {
    const project = async id => {
      if (server) {
        const r = await fetch(new URL(`/api/director/project?id=${id}`, server));
        const data = await r.json();
        if (!r.ok) throw Error(data.error || `HTTP ${r.status}`);
        return data.project;
      }
      return JSON.parse(await readFile(join(dataDir, 'director', id, 'project.json'), 'utf8'));
    };
    // Bytes of a file inside a project folder: refs/<file> or assets/<file>.
    const source = async (pid, rel) => {
      if (!server) return readFile(join(dataDir, 'director', pid, rel));
      const [sub, name] = rel.split('/');
      const r = await fetch(new URL(`/${sub === 'refs' ? 'director-refs' : 'director-assets'}/${pid}/${name}`, server));
      if (!r.ok) throw Error(`${rel}: HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    };

    let failed = 0;
    const written = [], totals = [];
    for (const [order, src] of SOURCES.entries()) {
      if (only && only !== src.slug) continue;
      const id = ids[src.slug] || src.id;
      let p;
      try { p = await project(id); } catch (e) { console.error(`✗ ${src.slug}: could not read project ${id} (${e.message})`); failed++; continue; }
      const dir = join(out, src.slug);
      await mkdir(dir, { recursive: true });
      let prev = null; try { prev = JSON.parse(await readFile(join(dir, 'starter.json'), 'utf8')); } catch {}
      const snap = starterSnapshot(p, { slug: src.slug, title: src.title, description: src.description, order, media, hero: src.hero });
      if (media) await encodeMedia(snap, dir, prev, rel => source(p.id, rel), src.encode);
      totals.push({ slug: src.slug, snap, dir, hero: src.hero });
      written.push(src.slug);
    }
    // Over budget: keep the hero shots' videos only.
    const size = () => totals.reduce((a, t) => a + t.snap.media.reduce((b, m) => b + m.bytes, 0), 0);
    if (media && size() > maxBytes) {
      log(`Media is ${mb(size())}, over ${mb(maxBytes)}: keeping only the hero shots' videos.`);
      for (const t of totals) {
        const drop = new Set(t.snap.assets.filter(a => a.kind === 'workflow-result' && !t.hero.shots.includes(a.shotId)).map(a => a.id));
        t.snap.assets = t.snap.assets.filter(a => !drop.has(a.id));
        t.snap.edit.clips = t.snap.edit.clips.filter(c => !drop.has(c.assetId));
        t.snap.media = t.snap.media.filter(m => !drop.has(m.path.match(/([a-f0-9-]{36})\.mp4$/)?.[1]));
      }
    }
    for (const t of totals) {
      await writeFile(join(t.dir, 'starter.json'), `${JSON.stringify(t.snap, null, 2)}\n`);
      if (media) await prune(t.dir, t.snap.media);
      const bytes = t.snap.media.reduce((b, m) => b + m.bytes, 0);
      log(`✓ ${t.slug}: ${t.snap.scene.entities.length} objects, ${t.snap.shots.length} shots, ${(t.snap.scene.references || []).length} object images, ${(t.snap.assets || []).length} clips, media ${mb(bytes)}`);
    }
    if (media) log(`Total media ${mb(size())}`);
    // The index lists every starter the server offers, in launch-page order.
    let index = { starters: [] };
    try { index = JSON.parse(await readFile(join(out, 'index.json'), 'utf8')); } catch {}
    const order = [...new Set([...SOURCES.map(s => s.slug).filter(s => written.includes(s) || index.starters.includes(s)), ...index.starters])];
    await writeFile(join(out, 'index.json'), `${JSON.stringify({ starters: order }, null, 2)}\n`);
    return { failed, diffs: scratch ? await diffTrees(target, scratch, only) : [] };
  } finally { if (scratch) await rm(scratch, { recursive: true, force: true }); }
}

/** Files that differ between the bundle (`bundled`) and what the export produced (`exported`); `only` limits it to one starter. */
async function diffTrees(bundled, exported, only) {
  const files = async root => {
    const found = new Map();
    const walk = async dir => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) await walk(full); else if (e.isFile()) found.set(relative(root, full).split('\\').join('/'), full);
      }
    };
    await walk(root);
    return found;
  };
  const [a, b] = [await files(bundled), await files(exported)];
  const inScope = path => !only || path === 'index.json' || path.startsWith(`${only}/`);
  const diffs = [];
  for (const path of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    if (!inScope(path)) continue;
    if (!b.has(path)) diffs.push({ path, change: 'removed' });
    else if (!a.has(path)) diffs.push({ path, change: 'added' });
    else if (!(await readFile(a.get(path))).equals(await readFile(b.get(path)))) diffs.push({ path, change: 'changed' });
  }
  return diffs;
}

const mb = n => `${(n / 1024 / 1024).toFixed(1)} MB`;
const sha = b => createHash('sha256').update(b).digest('hex');

/** Encode every listed file into <dir>/<path>, reusing the previous export's file when its source is unchanged. */
async function encodeMedia(snap, dir, prev, read, encode = null) {
  const e = { ...DEFAULT_ENCODE, ...(encode || {}) }, tag = encode ? JSON.stringify(encode) : null;
  const tmp = join(tmpdir(), `starter-media-${process.pid}`);
  await mkdir(tmp, { recursive: true });
  const out = [];
  for (const f of snap.media) {
    const bytes = await read(f.from);
    const sourceSha256 = sha(bytes), dest = join(dir, f.path);
    // A source that is the bundled file itself (an imported source project) or whose source is unchanged is not re-encoded.
    const old = prev?.media?.find(m => m.path === f.path && (m.sourceSha256 === sourceSha256 || m.sha256 === sourceSha256) && (f.kind === 'model' || (m.encode ? JSON.stringify(m.encode) : null) === tag));
    if (old && existsSync(dest) && sha(await readFile(dest)) === old.sha256) { out.push(old); continue; }
    if (old && old.sha256 === sourceSha256) { await mkdir(dirname(dest), { recursive: true }); await writeFile(dest, bytes); out.push(old); continue; }
    // An imported model (GLB) is copied as it is: it is already the checked, self-contained file the app stores.
    if (f.kind === 'model') {
      await mkdir(dirname(dest), { recursive: true }); await writeFile(dest, bytes);
      out.push({ path: f.path, kind: f.kind, bytes: bytes.length, sha256: sourceSha256, sourceSha256 });
      continue;
    }
    const input = join(tmp, `in-${sourceSha256.slice(0, 16)}`);
    await writeFile(input, bytes);
    await mkdir(dirname(dest), { recursive: true });
    if (f.kind === 'image') {
      await run('ffmpeg', ['-v', 'error', '-y', '-i', input, '-vf', `scale='min(${e.imageMaxPx},iw)':'min(${e.imageMaxPx},ih)':force_original_aspect_ratio=decrease`, '-c:v', 'libwebp', '-quality', String(e.imageQuality), '-map_metadata', '-1', dest]);
    } else {
      await run('ffmpeg', ['-v', 'error', '-y', '-i', input, '-vf', `scale=-2:'min(${e.videoHeight},ih)'`, '-c:v', 'libx264', '-preset', 'slow', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
        '-b:v', `${e.videoKbps}k`, '-maxrate', `${e.videoMaxKbps}k`, '-bufsize', `${e.videoMaxKbps * 2}k`, '-an', '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact', '-movflags', '+faststart', dest]);
    }
    const data = await readFile(dest);
    const entry = { path: f.path, kind: f.kind, bytes: data.length, sha256: sha(data), sourceSha256, ...(await probe(dest, f.kind)), ...(encode ? { encode } : {}) };
    out.push(entry);
    await rm(input, { force: true });
  }
  await rm(tmp, { recursive: true, force: true });
  snap.media = out;
}

async function probe(file, kind) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=width,height,r_frame_rate,nb_read_frames:format=duration', '-of', 'json', file]);
  const j = JSON.parse(stdout), s = j.streams?.[0] || {};
  if (kind === 'image') return { width: s.width, height: s.height };
  const [a, b] = String(s.r_frame_rate || '24/1').split('/').map(Number);
  return { width: s.width, height: s.height, fps: Math.round((a / (b || 1)) * 1000) / 1000, frameCount: Number(s.nb_read_frames) || null, duration: Math.round(Number(j.format?.duration) * 1000) / 1000 || null };
}

/** Delete media files the snapshot no longer lists. */
async function prune(dir, list) {
  const keep = new Set(list.map(m => m.path));
  for (const sub of ['refs', 'assets']) {
    let names = []; try { names = await readdir(join(dir, 'media', sub)); } catch { continue; }
    for (const n of names) if (!keep.has(`media/${sub}/${n}`)) await rm(join(dir, 'media', sub, n));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main(process.argv.slice(2));
