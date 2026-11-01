#!/usr/bin/env node
// Snapshot the starter projects from a running Comfy Three Previs server into
// a static read-only demo (dist-demo/demo-data + dist-demo/demo-media).
// GET requests only. Run after `VITE_DEMO=1 vite build ... --outDir dist-demo`
// (or just `pnpm run demo:build`).
//
// The demo shows the bundled starters (examples/starters, the source of truth): by default it reads their source
// projects, the ids `pnpm starters:import` writes, so the server's data dir must hold them (publish-public.sh imports
// them into its copy of the data). Every demo project that pairs with a starter must re-export to exactly that
// bundle's scene, shots, images, clips and cut, or the snapshot fails before writing it.
//
// The demo shows each project as it stands, not its history: per shot the current start and end stills, the
// video the Cut uses and the blockout clip; per object its look and the shown take of each design-sheet slot.
// Other takes are left out unless they are inputs to kept media. Ids are kept, so every
// provenance link the UI follows still resolves. Stills become WebP at most 1280 px on either side (needs ffmpeg on
// PATH, or PREVIS_FFMPEG; probing uses PREVIS_FFPROBE or ffprobe); videos are copied as they are. Archived projects and "Regen …" scratch
// projects are never included.
//
//   PREVIS_URL        server to read from (default http://127.0.0.1:5230)
//   PREVIS_DATA       that server's data dir, for media files
//                     (default .evidence/dev-data, the same default as scripts/publish-public.sh)
//   DEMO_PROJECTS     comma-separated project ids (default: the four starters' source projects)
//   DEMO_MEDIA_MB     media budget in MiB (default 400); fail without dropping files
import { mkdir, writeFile, copyFile, readFile, rm } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { existsSync } from 'node:fs';
import { join, resolve, extname, dirname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { keyStills, lookSource } from '../shared/director.mjs';
import { starterPicks, starterSnapshot, loadStarters } from '../server/previs/starters.mjs';
import { SOURCES } from './export-starters.mjs';

const run = promisify(execFile);
// The starters' source projects (starterSourceId per slug), not the dev projects they were first exported from.
export const DEFAULT_PROJECTS = SOURCES.map(s => s.id);
export const STILL_MAX_WIDTH = 1280, STILL_QUALITY = 82;
export const DEFAULT_MEDIA_MB = 400;

/**
 * Which requested projects go into the demo. `listed` and `archived` are the server's project summaries.
 * Archived projects and scratch projects whose title starts with "Regen " are skipped; ids the server does not
 * know are reported as missing.
 */
export function pickProjects(ids, listed, archived = []) {
  const projects = [], skipped = [], missing = [];
  for (const id of ids) {
    const p = listed.find(x => x.id === id), gone = archived.find(x => x.id === id);
    if (gone || p?.archived) skipped.push({ id, title: gone?.title || p?.title, why: 'archived' });
    else if (!p) missing.push(id);
    else if (/^Regen(?:\s|$)/i.test(p.title || '')) skipped.push({ id, title: p.title, why: 'regeneration scratch project' });
    else projects.push(p);
  }
  return { projects, skipped, missing };
}

/**
 * What the demo keeps of one project: reference ids and asset ids.
 * Per shot: the current start and end stills (keyStills), the asset the Cut uses (else the newest video), the
 * blockout clip in the viewport (shot.render) and the one the video was made from. Per object: its look and the
 * shown take of every design-sheet slot plus the composed board.
 */
export function demoKeep(project) {
  const refs = new Set(), assets = new Set();
  const sceneRefs = project.scene.references || [];
  for (const e of project.scene.entities) {
    const owner = lookSource(project, e.id);
    const looks = sceneRefs.filter(r => r.entityId === owner?.id);
    const look = looks.find(r => r.id === owner?.look) || looks[0];
    if (look) refs.add(look.id);
    for (const sh of e.sheets || []) {
      for (const s of sh.slots || []) { const a = shownAttempt(s); if (a?.referenceId) refs.add(a.referenceId); }
      const composed = sceneRefs.find(r => r.entityId === e.id && r.note === `sheet:${sh.id}:composed`);
      if (composed) refs.add(composed.id);
    }
  }
  const picks = starterPicks(project);
  const all = project.assets || [];
  project.shots.forEach((s, i) => {
    const { start, end } = keyStills(s);
    if (start) refs.add(start.id);
    if (end) refs.add(end.id);
    const clips = project.edit?.clips?.filter(c => c.shotId === s.id) || [];
    const videos = clips.length ? clips.map(clip => {
      if (!clip.assetId) return picks[i].video;
      const asset = all.find(a => a.id === clip.assetId && a.shotId === s.id && a.mime?.startsWith('video/'));
      if (!asset) throw new Error(`Unresolved Cut asset ${clip.assetId} for ${s.id}`);
      return asset;
    }) : [picks[i].video];
    for (const video of videos) {
      if (video) assets.add(video.id);
      if (video?.source?.sourceAssetId && all.some(a => a.id === video.source.sourceAssetId)) assets.add(video.source.sourceAssetId);
    }
    if (s.render?.assetId && all.some(a => a.id === s.render.assetId)) assets.add(s.render.assetId);
    const blockout = all.filter(a => a.shotId === s.id && a.kind === 'camera-render').sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    if (blockout) assets.add(blockout.id);
    for (const r of s.references || []) if (r.role !== 'frame') refs.add(r.id);
  });
  // Only references that exist: a look or sheet attempt may point at a reference that was deleted.
  const known = new Set([...sceneRefs, ...project.shots.flatMap(s => s.references || [])].map(r => r.id));
  return { refs: new Set([...refs].filter(id => known.has(id))), assets };
}

const shownAttempt = s => (s.attempts || []).find(a => a.id === s.accepted) || (s.attempts || []).find(a => a.id === s.selected) || s.attempts?.at(-1) || null;

/** The file name a still has in the demo: same base name, `.webp` for images that are re-encoded. */
export const demoStillFile = file => file + '.webp'; // Keep the original extension to avoid PNG/JPEG basename collisions.

/**
 * A copy of the project document with only the kept references, assets, sheet takes and cut clips, and each
 * re-encoded still's file name pointing at its WebP. Ids are unchanged.
 */
export function slimProject(project, keep = demoKeep(project), media = new Map()) {
  const p = structuredClone(project);
  const ref = r => media.has(r.id) ? rewriteMedia(r, media.get(r.id), 'file') : r;
  p.scene.references = (p.scene.references || []).filter(r => keep.refs.has(r.id)).map(ref);
  for (const e of p.scene.entities) {
    if (e.look && !keep.refs.has(e.look)) e.look = null;
    if (!e.sheets) continue;
    for (const sh of e.sheets) for (const s of sh.slots || []) {
      s.attempts = s.attempts.filter(a => a.referenceId && keep.refs.has(a.referenceId));
      if (!s.attempts.some(a => a.id === s.selected)) s.selected = s.attempts.at(-1)?.id ?? null;
      if (!s.attempts.some(a => a.id === s.accepted)) s.accepted = null;
    }
  }
  for (const s of p.shots) s.references = (s.references || []).filter(r => keep.refs.has(r.id)).map(ref);
  p.assets = (p.assets || []).filter(a => keep.assets.has(a.id));
  // Null asset IDs mean "newest" in Cut; preserve these and excluded shots exactly.
  return p;
}

/**
 * The demo home's cards: the server's current starters (`GET director/starters`), each paired by title with the
 * snapshotted project it opens. Starters with no project in the demo are left out; the demo cannot create one.
 */
export function demoStarters(starters = [], projects = []) {
  return starters.flatMap(s => {
    const p = projects.find(x => bareTitle(x.title) === bareTitle(s.title));
    return p ? [{ slug: s.slug, title: s.title, description: s.description, shots: s.shots, entities: s.entities, scene: s.scene, shot: s.shot, projectId: p.id }] : [];
  });
}

const bareTitle = t => String(t || '').replace(/^Starter · /, '').trim().toLowerCase();

/** The bundled starter a demo project shows: by `template` slug, else by title (as demoStarters pairs cards). */
export const starterFor = (project, starters = []) =>
  starters.find(s => s.slug === project.template) || starters.find(s => bareTitle(s.title) === bareTitle(project.title)) || null;

/**
 * How a demo project differs from its bundled starter, as readable lines (empty when it matches). The project is
 * exported the way `pnpm starters:export` would export it and compared with the bundle: scene name and environment,
 * every entity (transform, path, display model, look, sheets), every shot (camera, timing, cast, prompts, stills),
 * the scene images, the blockout clips and videos, and the cut.
 */
export function starterDrift(project, starter) {
  const snap = starterSnapshot(project, { slug: starter.slug, title: starter.title, description: starter.description, order: starter.order });
  const out = [], named = x => x.name || x.title || x.id;
  const byId = (label, mine = [], theirs = [], name = named) => {
    for (const t of theirs) {
      const m = mine.find(x => x.id === t.id);
      if (!m) { out.push(`${label} “${name(t)}” is missing`); continue; }
      if (isDeepStrictEqual(m, t)) continue;
      const keys = [...new Set([...Object.keys(m), ...Object.keys(t)])].filter(k => !isDeepStrictEqual(m[k], t[k]));
      out.push(`${label} “${name(t)}” differs in ${keys.join(', ')}`);
    }
    for (const m of mine) if (!theirs.some(t => t.id === m.id)) out.push(`${label} “${name(m)}” is not in the bundle`);
  };
  if (snap.scene.name !== starter.scene.name) out.push(`scene name “${snap.scene.name}” is not “${starter.scene.name}”`);
  if (!isDeepStrictEqual(snap.scene.environment, starter.scene.environment || {})) out.push('scene environment differs');
  byId('shot', snap.shots, starter.shots);
  if (!isDeepStrictEqual(snap.edit?.clips || [], starter.edit?.clips || [])) out.push('cut differs');
  byId('entity', snap.scene.entities, starter.scene.entities);
  byId('image', snap.scene.references, starter.scene.references);
  byId('clip', snap.assets, starter.assets, a => `${a.kind} ${a.id}`);
  return out;
}

/** Follow input references and source clips, not unrelated output takes from the same job. */
export function demoClosure(project, refgen, generation) {
  const keep = demoKeep(project), refJobs = new Map(), videoJobs = new Map(), engineAssets = new Set();
  const refs = [...(project.scene.references || []), ...project.shots.flatMap(s => s.references || [])];
  const refById = new Map(refs.map(r => [r.id, r]));
  const assetById = new Map((project.assets || []).map(a => [a.id, a]));
  const visitRef = id => { if (refById.has(id)) keep.refs.add(id); };
  const visitJob = id => {
    if (!id || videoJobs.has(id)) return;
    const job = (generation.jobs || []).find(j => j.id === id);
    if (!job) throw new Error(`Missing video receipt ${id}`);
    videoJobs.set(id, job);
    for (const input of Object.values(job.sources || {})) visitInput(input);
  };
  const visitInput = input => {
    if (!input || typeof input !== 'object') return;
    visitRef(input.directorRef?.referenceId);
    if (input.id) engineAssets.add(input.id);
    if (assetById.has(input.id)) keep.assets.add(input.id);
    visitJob(input.generationJobId);
    visitJob(input.provenance?.generationJobId);
    for (const ancestor of Object.values(input.provenance?.sourceAssets || {})) visitInput(ancestor);
  };
  let previous;
  do {
    previous = keep.refs.size + keep.assets.size + refJobs.size + videoJobs.size;
    for (const id of keep.refs) {
      const r = refById.get(id);
      const job = (refgen.jobs || []).find(j => j.id === r?.generated?.requestId || j.referenceIds?.includes(id) || j.results?.some(x => x.id === id));
      if (!job && r?.generated?.requestId) throw new Error(`Missing image receipt ${r.generated.requestId}`);
      if (job) { refJobs.set(job.id, job); for (const input of job.refs || []) visitRef(input.referenceId); }
    }
    for (const id of keep.assets) {
      const a = assetById.get(id);
      if (a?.source?.sourceAssetId) {
        if (!assetById.has(a.source.sourceAssetId)) throw new Error(`Unresolved source asset ${a.source.sourceAssetId}`);
        keep.assets.add(a.source.sourceAssetId);
      }
      visitJob(a?.source?.jobId);
      visitJob(a?.generationJobId);
      visitJob(a?.provenance?.generationJobId);
    }
  } while (previous !== keep.refs.size + keep.assets.size + refJobs.size + videoJobs.size);
  return { ...keep, engineAssets, refJobs: [...refJobs.values()], videoJobs: [...videoJobs.values()] };
}

/** Actual file metadata and original identity remain distinct; graphs and bindings stay historical. */
export function rewriteMedia(record, media, field = 'file') {
  const recorded = Object.fromEntries(['file', 'filename', 'url', 'mime', 'mimeType', 'width', 'height', 'bytes', 'sha256'].filter(k => record[k] !== undefined).map(k => [k, record[k]]));
  return { ...record, [field]: media.file, ...(record.url ? { url: media.url } : {}),
    mime: media.mime, ...(record.mimeType ? { mimeType: media.mime } : {}),
    width: media.width, height: media.height, bytes: media.bytes, sha256: media.sha256,
    demoMedia: { original: { ...media.original, recorded }, derivative: { file: media.file, url: media.url, mime: media.mime,
      width: media.width, height: media.height, bytes: media.bytes, sha256: media.sha256, maxDimension: STILL_MAX_WIDTH, quality: STILL_QUALITY } } };
}

/** Re-encode a still as WebP bounded on both axes (never upscaled). Embedded metadata is dropped. */
export async function downscaleStill(src, dest, { ffmpeg = process.env.PREVIS_FFMPEG || 'ffmpeg' } = {}) {
  await mkdir(dirname(dest), { recursive: true });
  await run(ffmpeg, ['-v', 'error', '-n', '-threads', '1', '-i', src, '-vf', `scale=w='min(${STILL_MAX_WIDTH},iw)':h='min(${STILL_MAX_WIDTH},ih)':force_original_aspect_ratio=decrease`, '-frames:v', '1', '-c:v', 'libwebp', '-threads', '1', '-quality', String(STILL_QUALITY), '-map_metadata', '-1', dest]);
}

// Drop secrets and machine-specific paths.
const SECRET = /^(api[-_]?key|token|secret|authorization|password|credentials?)$/i;
const PATH = /(?:\/Users|\/home|\/var\/folders|\/private|\/tmp|[A-Z]:\\\\Users)\/[^"'\s)]*/g;
function clean(v) {
  if (Array.isArray(v)) return v.map(clean);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !SECRET.test(k)).map(([k, x]) => [k, clean(x)]));
  if (typeof v === 'string') return v.replace(PATH, '<local path>');
  return v;
}

/** Build into fresh media/data directories. Failure retains evidence and never removes selected media. */
export async function snapshotDemo({ get, data, out, ids = DEFAULT_PROJECTS, starters: bundles, budget = DEFAULT_MEDIA_MB * 1048576, ffmpeg = process.env.PREVIS_FFMPEG || 'ffmpeg', ffprobe = process.env.PREVIS_FFPROBE || 'ffprobe' }) {
  if (!Number.isFinite(budget) || budget <= 0) throw new Error('DEMO_MEDIA_MB must be positive');
  const dataDir = join(out, 'demo-data'), mediaDir = join(out, 'demo-media');
  if (existsSync(dataDir) || existsSync(mediaDir)) throw new Error('Snapshot output already exists; build into a fresh output directory');
  await mkdir(dataDir, { recursive: true });
  const write = (name, body) => writeFile(join(dataDir, name), JSON.stringify(clean(body)));
  const { projects: all } = await get('director/projects');
  const { projects: archived } = await get('director/archived');
  const { projects: listed, skipped, missing } = pickProjects(ids, all, archived);
  if (missing.length) throw new Error(`Requested projects missing: ${missing.join(', ')}. The demo shows the bundled starters: stop the server, run pnpm starters:import --data-dir <its data dir>, and start it again`);
  bundles ||= await loadStarters();
  const generation = await get('generation');
  const media = [], jobs = new Map(), projects = [];
  const safe = (root, file) => {
    const path = resolve(root, file);
    if (!path.startsWith(resolve(root) + sep)) throw new Error(`Media path escapes root: ${file}`);
    return path;
  };
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const dimensions = async file => {
    const { stdout } = await run(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', file]);
    const [stream] = JSON.parse(stdout).streams;
    if (!stream?.width || !stream?.height) throw new Error(`No image dimensions: ${file}`);
    return { width: stream.width, height: stream.height };
  };
  const saved = new Map();
  async function save(source, target, image = false) {
    if (saved.has(target)) {
      if (saved.get(target).source !== source) throw new Error(`Conflicting media destination: ${target}`);
      return saved.get(target).record;
    }
    const src = safe(data, source), dest = safe(mediaDir, target);
    const originalBytes = await readFile(src); // A missing selected input fails the whole snapshot.
    const original = { file: source, bytes: originalBytes.length, sha256: hash(originalBytes) };
    let record;
    if (image) {
      original.mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' })[extname(source).toLowerCase()];
      Object.assign(original, await dimensions(src));
      await downscaleStill(src, dest, { ffmpeg });
      const bytes = await readFile(dest);
      record = { file: target.split('/').at(-1), url: '/' + target, mime: 'image/webp', ...await dimensions(dest), bytes: bytes.length, sha256: hash(bytes), original };
    } else {
      await mkdir(dirname(dest), { recursive: true }); await copyFile(src, dest);
      record = { file: target.split('/').at(-1), url: '/' + target, bytes: original.bytes, sha256: original.sha256, original };
    }
    media.push({ path: target, ...record }); saved.set(target, { source, record }); return record;
  }
  for (const summary of listed) {
    const { project, ...rest } = await get(`director/project?id=${summary.id}`);
    const refgen = await get(`director/refgen?projectId=${summary.id}`);
    const keep = demoClosure(project, refgen, generation), mapped = new Map();
    const pid = project.id;
    for (const ref of [...(project.scene.references || []), ...project.shots.flatMap(s => s.references || [])]) {
      if (keep.refs.has(ref.id) && !mapped.has(ref.id)) mapped.set(ref.id, await save(`director/${pid}/refs/${ref.file}`, `director-refs/${pid}/${demoStillFile(ref.file)}`, true));
    }
    const slim = slimProject(project, keep, mapped);
    const starter = starterFor(slim, bundles);
    const drift = starter ? starterDrift(slim, starter) : [];
    if (drift.length) throw new Error(`Demo project ${pid} (“${slim.title}”) differs from its bundled starter examples/starters/${starter.slug}:\n  ${[...drift.slice(0, 25), ...(drift.length > 25 ? [`… and ${drift.length - 25} more`] : [])].join('\n  ')}\nThe bundle is the source of truth: snapshot its source project (pnpm starters:import --data-dir <server data dir> --force, with the server stopped).`);
    const assetURLs = new Map();
    for (const asset of slim.assets) {
      const record = await save(`director/${pid}/${asset.file}`, `director-assets/${pid}/${asset.file.replace(/^assets\//, '')}`);
      assetURLs.set(asset.id, record.url);
    }
    for (const shot of slim.shots) if (shot.render?.assetId) {
      const id = shot.render.assetId;
      await save(`assets/${id}.mp4`, `assets/${id}.mp4`);
    }
    const imageJobs = [];
    for (const originalJob of keep.refJobs) {
      const job = structuredClone(originalJob);
      for (const input of [job.guide, ...(job.refs || [])].filter(Boolean)) {
        const record = await save(`director/${pid}/refgen/${input.file}`, `director-refgen/${pid}/${demoStillFile(input.file)}`, true);
        Object.assign(input, rewriteMedia(input, record)); input.url = record.url;
      }
      job.results = (job.results || (job.referenceIds || []).map(id => ({ id, kind: 'image' }))).filter(r => mapped.has(r.id)).map(r => ({ ...rewriteMedia(r, mapped.get(r.id)), url: mapped.get(r.id).url }));
      job.demoOriginalReferenceIds = job.referenceIds;
      job.referenceIds = (job.referenceIds || []).filter(id => keep.refs.has(id));
      imageJobs.push(job);
    }
    for (const originalJob of keep.videoJobs) {
      const previousJob = jobs.get(originalJob.id);
      const job = structuredClone(originalJob);
      const copyInput = async input => {
        const mime = input.mime || input.mimeType || '';
        const renderAsset = mime === 'image/png' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.id || '') && input.url === `/renders/${input.id}.png`;
        const source = `${input.sourceType === 'render' || renderAsset ? 'renders' : 'assets'}/${input.filename}`;
        const image = mime.startsWith('image/');
        const target = image ? `renders/${demoStillFile(input.filename)}` : `assets/${input.filename}`;
        const record = await save(source, target, image);
        const copied = image ? { ...rewriteMedia(input, record, 'filename'), url: record.url } : { ...input, url: record.url };
        if (input.provenance?.sourceAssets) {
          copied.provenance = { ...copied.provenance, sourceAssets: {} };
          for (const [name, ancestor] of Object.entries(input.provenance.sourceAssets)) copied.provenance.sourceAssets[name] = await copyInput(ancestor);
        }
        return copied;
      };
      for (const [key, input] of Object.entries(job.sources || {})) job.sources[key] = await copyInput(input);
      job.demoOriginalResults = (job.results || []).map(r => ({ id: r.id, url: r.url, sha256: r.sha256 }));
      const results = [...(previousJob?.results || [])];
      for (const result of job.results || []) if (!results.some(r => r.id === result.id) && (keep.assets.has(result.id) || keep.engineAssets.has(result.id))) {
        results.push(assetURLs.has(result.id) ? { ...result, url: assetURLs.get(result.id) } : await copyInput(result));
      }
      job.results = results;

      jobs.set(job.id, job);
    }
    await write(`project-${pid}.json`, { ...rest, project: slim, agent: { connected: false, waiting: false, lastSeen: null, name: null, runner: null } });
    await write(`refgen-${pid}.json`, { ...refgen, jobs: imageJobs, paidExecutionEnabled: false, cloudCredential: false });
    await write(`assets-${pid}.json`, { assets: slim.assets, shots: slim.shots.map((s, i) => ({ id: s.id, number: i + 1, title: s.title })) });
    projects.push({ ...summary, assets: slim.assets.length, references: slim.shots.reduce((n, s) => n + s.references.length, 0) });
  }
  await write('projects.json', { projects });
  const starters = demoStarters((await get('director/starters').catch(() => ({}))).starters, projects);
  await write('starters.json', { starters });
  await write('generation.json', { ...generation, jobs: [...jobs.values()], paidExecutionEnabled: false });
  await write('setup.json', { ready: true, checks: [] });
  const totalBytes = media.reduce((n, m) => n + m.bytes, 0);
  const manifest = { version: 1, projects: projects.map(p => p.id), skipped, media, totalBytes, budgetBytes: budget, complete: true, withinBudget: totalBytes <= budget };
  await write('snapshot-manifest.json', manifest);
  console.log(`demo snapshot: ${projects.length} projects (${starters.length} as finished-scene cards), ${jobs.size} generation jobs, ${media.length} media files (${(totalBytes / 1048576).toFixed(1)} MB), 0 skipped, 0 missing`);
  if (totalBytes > budget) throw new Error(`Demo media over budget: ${totalBytes} > ${budget} bytes; all selected media retained, publication refused`);
  return manifest;
}

async function main() {
  const root = resolve(import.meta.dirname, '..'), out = join(root, 'dist-demo');
  const server = process.env.PREVIS_URL || 'http://127.0.0.1:5230';
  if (!existsSync(join(out, 'director.html'))) throw new Error('dist-demo/ not built — run pnpm run demo:build');
  const get = async path => {
    const r = await fetch(server + '/api/' + path);
    if (!r.ok) throw new Error(`GET /api/${path} → ${r.status}`);
    return r.json();
  };
  await snapshotDemo({ get, data: resolve(root, process.env.PREVIS_DATA || '.evidence/dev-data'), out,
    ids: process.env.DEMO_PROJECTS ? process.env.DEMO_PROJECTS.split(',').map(x => x.trim()) : DEFAULT_PROJECTS,
    budget: Number(process.env.DEMO_MEDIA_MB || DEFAULT_MEDIA_MB) * 1048576 });
  await copyFile(join(out, 'start.html'), join(out, 'index.html'));
  // Preserve the existing removal of the retired camera page in a newly built demo.
  await rm(join(out, 'camera.html'), { force: true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
