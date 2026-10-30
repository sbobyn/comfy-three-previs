// Starter projects: versioned snapshots committed under examples/starters/<slug>/starter.json.
// A snapshot is a whole blockout (scene, groups, paths, environment, shots with cameras, style,
// prompts and cast) plus, from version 2, the finished media a newcomer should see: each object's
// primary look and design sheet, each shot's chosen still, its blockout clip and its chosen video,
// and the cut. Media files live in <slug>/media/ and are listed in "media". Creating a project from
// a starter deep-copies the snapshot with fresh ids and copies whichever media files are present.
import { readFile, copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { makeEntity, makeShot } from '../../shared/director.mjs';
import { normalizePrompts, normalizeStyle } from '../../shared/prompt.mjs';

export const STARTER_FORMAT = 'comfy-previs-starter';
export const STARTER_VERSION = 2;
export const STARTERS_DIR = fileURLToPath(new URL('../../examples/starters/', import.meta.url));

const GENERATED_KEEP = ['presetId', 'model', 'seed', 'prompt'];
const keepGenerated = g => (g ? Object.fromEntries(GENERATED_KEEP.filter(k => g[k] !== undefined).map(k => [k, g[k]])) : undefined);
const newest = list => [...list].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] || null;

/**
 * What a starter shows for each shot: the chosen still (`hero.stills[shotId]`, else the shot's in-use start
 * key frame), the end key frame if any, the chosen video (`hero.videos[shotId]`, else the cut's clip, else the
 * newest result) and the blockout clip that video came from.
 */
export function starterPicks(project, hero = {}) {
  const assets = project.assets || [];
  return project.shots.map(s => {
    const frames = s.references.filter(r => r.role === 'frame');
    const starts = frames.filter(r => r.note === 'key frame start' || !r.note);
    const start = starts.find(r => r.id === hero.stills?.[s.id]) || starts.at(-1) || null;
    const end = frames.filter(r => r.note === 'key frame end').at(-1) || null;
    const mine = assets.filter(a => a.shotId === s.id && a.mime?.startsWith('video/'));
    const clip = project.edit?.clips?.find(c => c.shotId === s.id);
    const video = mine.find(a => a.id === hero.videos?.[s.id]) || mine.find(a => a.id === clip?.assetId && a.kind === 'workflow-result') || newest(mine.filter(a => a.kind === 'workflow-result'));
    const renders = mine.filter(a => a.kind === 'camera-render');
    const blockout = renders.find(a => a.id === video?.source?.sourceAssetId) || newest(renders);
    return { shotId: s.id, start, end, video, blockout, clip: clip && video && clip.assetId === video.id ? clip : null };
  });
}

/**
 * Turn a full project document into a portable starter snapshot.
 * With `media: false` (the version 1 shape) no looks, sheets, stills or videos are kept.
 * Otherwise the snapshot lists media files as { path, from, kind } where `from` is the file inside the
 * project folder; the exporter turns each into a web-sized file at `path` and fills in bytes and sha256.
 */
export function starterSnapshot(project, { slug, title, description, order = 0, media = true, hero = {} }) {
  const files = [];
  const refPath = r => `media/refs/${r.id}.webp`;
  const takeRef = r => { files.push({ path: refPath(r), from: `refs/${r.file}`, kind: 'image' }); return { id: r.id, name: r.name, file: `${r.id}.webp`, mime: 'image/webp', role: r.role, entityId: r.entityId ?? null, note: r.note || '', createdAt: r.createdAt, ...(r.generated ? { generated: keepGenerated(r.generated) } : {}) }; };
  const objectRefs = project.scene.references || [];
  const refById = new Map(objectRefs.map(r => [r.id, r]));
  const sceneRefs = [];
  const entities = project.scene.entities.map(e => {
    const out = structuredClone(e);
    delete out.look; delete out.sheets;
    if (!media) return out;
    const look = !e.lookFrom && refById.get(e.look);
    if (look) { sceneRefs.push(takeRef(look)); out.look = look.id; }
    // Design sheets: the shown take of every slot, plus the composed board. A sheet with no images is dropped.
    const sheets = [];
    for (const sh of e.sheets || []) {
      const slots = sh.slots.map(s => {
        const shown = s.attempts.find(a => a.id === s.accepted) || s.attempts.find(a => a.id === s.selected) || s.attempts.at(-1);
        const ref = shown && refById.get(shown.referenceId);
        return ref ? { ...structuredClone(s), attempts: [{ ...structuredClone(shown), requestId: null }], selected: shown.id, accepted: s.accepted === shown.id ? shown.id : null, ref } : null;
      });
      if (!slots.some(Boolean) || slots.some(x => !x)) continue;
      for (const s of slots) { if (s.ref.id !== out.look) sceneRefs.push(takeRef(s.ref)); delete s.ref; }
      const composed = objectRefs.find(r => r.entityId === e.id && r.note === `sheet:${sh.id}:composed`);
      if (composed) sceneRefs.push(takeRef(composed));
      sheets.push({ ...structuredClone(sh), slots });
    }
    if (sheets.length) out.sheets = sheets;
    return out;
  });
  const ids = new Set(entities.map(e => e.id));
  const picks = media ? starterPicks(project, hero) : [];
  const assets = [], clips = [];
  const takeAsset = a => {
    files.push({ path: `media/assets/${a.id}.mp4`, from: a.file, kind: 'video' });
    const source = a.kind === 'workflow-result' ? { workflow: a.source?.workflow || 'Video', backend: a.source?.backend || null, prompt: a.source?.prompt || '' } : { engineShotId: null };
    return { id: a.id, kind: a.kind, shotId: a.shotId, file: `assets/${a.id}.mp4`, mime: 'video/mp4', duration: a.duration ?? null, createdAt: a.createdAt, source };
  };
  const shots = project.shots.map((s, i) => {
    const out = structuredClone(s);
    delete out.render; delete out.references;
    if (out.cast) out.cast = { include: out.cast.include.filter(id => ids.has(id)), exclude: out.cast.exclude.filter(id => ids.has(id)) };
    if (out.camera?.target && !ids.has(out.camera.target)) out.camera.target = null;
    if (!media) { delete out.id; return out; }
    const pk = picks[i];
    // The chosen start still goes last: the newest start key frame is the one in use.
    out.references = [pk.end, pk.start].filter(Boolean).map(takeRef);
    if (pk.blockout) assets.push(takeAsset(pk.blockout));
    if (pk.video) { assets.push(takeAsset(pk.video)); clips.push({ shotId: s.id, assetId: pk.video.id, in: pk.clip?.in ?? 0, out: pk.clip?.out ?? null }); }
    return out;
  });
  for (const e of entities) {
    if (e.parent && !ids.has(e.parent)) e.parent = null;
    if (e.lookFrom && !ids.has(e.lookFrom)) e.lookFrom = null;
  }
  const { name, environment } = project.scene;
  const snap = { format: STARTER_FORMAT, version: media ? STARTER_VERSION : 1, slug, order, title, description, scene: { name: name || title, environment: structuredClone(environment || {}), entities }, shots, media: [] };
  if (media) {
    snap.scene.references = sceneRefs.filter((r, i, a) => a.findIndex(x => x.id === r.id) === i);
    snap.assets = assets;
    snap.edit = { clips };
    snap.media = files.filter((f, i, a) => a.findIndex(x => x.path === f.path) === i);
  }
  return snap;
}

function valid(s) {
  return s?.format === STARTER_FORMAT && s.version <= STARTER_VERSION && /^[a-z0-9-]{1,40}$/.test(s.slug || '') && Array.isArray(s.scene?.entities) && Array.isArray(s.shots) && s.shots.length > 0;
}

/** Read every starter snapshot, sorted by order. Bad files are skipped. Each carries its folder as `dir` (not enumerable). */
export async function loadStarters(dir = STARTERS_DIR) {
  let index;
  try { index = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')); } catch { return []; }
  const out = [];
  for (const slug of index.starters || []) {
    try {
      const s = JSON.parse(await readFile(join(dir, slug, 'starter.json'), 'utf8'));
      if (valid(s) && s.slug === slug) { Object.defineProperty(s, 'dir', { value: join(dir, slug), enumerable: false }); out.push(s); }
    } catch {}
  }
  return out.sort((a, b) => (a.order || 0) - (b.order || 0));
}

/** What the launch page needs: title, description and enough of shot 1 to draw a thumbnail. */
export function starterCard(s) {
  return { slug: s.slug, title: s.title, description: s.description, shots: s.shots.length, entities: s.scene.entities.length, scene: { ...s.scene, references: undefined }, shot: { ...s.shots[0], references: undefined }, media: (s.media || []).length };
}

/**
 * Scene, shots, assets and cut for a new project: a deep copy of the snapshot with fresh ids everywhere.
 * `has(path)` says whether a media file is present (a clone without media still opens, just without images);
 * images and videos whose file is missing are left out. `files` lists the copies to make: { from, to }.
 */
export function instantiateStarter(s, { has = () => true } = {}) {
  const map = new Map(s.scene.entities.map(e => [e.id, randomUUID()]));
  const re = id => (typeof id === 'string' && map.has(id) ? map.get(id) : null);
  const files = [];
  const mediaOk = path => (s.media || []).some(m => m.path === path) && has(path);
  const refMap = new Map();
  const copyRef = r => {
    const path = `media/refs/${r.file}`;
    if (!/^[a-f0-9-]{36}\.webp$/.test(r.file || '') || !mediaOk(path)) return null;
    const id = refMap.get(r.id) || randomUUID(); refMap.set(r.id, id);
    if (!files.some(f => f.to === `refs/${id}.webp`)) files.push({ from: path, to: `refs/${id}.webp` });
    return { ...structuredClone(r), id, file: `${id}.webp`, entityId: r.entityId ? re(r.entityId) : null };
  };
  const references = (s.scene.references || []).map(copyRef).filter(Boolean).filter(r => r.entityId);
  const entities = s.scene.entities.map(e => {
    const sheets = (e.sheets || []).map(sh => ({ ...structuredClone(sh), slots: sh.slots.map(x => ({ ...structuredClone(x), attempts: x.attempts.map(a => ({ ...a, referenceId: refMap.get(a.referenceId) || null })) })) }))
      .filter(sh => sh.slots.every(x => x.attempts.some(a => a.referenceId)));
    return makeEntity({ ...structuredClone(e), parent: re(e.parent), lookFrom: re(e.lookFrom), look: refMap.get(e.look) || null, sheets: sheets.length ? sheets : undefined }, map.get(e.id));
  });
  const shotMap = new Map();
  const shots = s.shots.map((x, i) => {
    const src = structuredClone(x);
    const shot = makeShot({ ...src, camera: { ...src.camera, target: re(src.camera?.target) }, cast: { include: (src.cast?.include || []).map(re).filter(Boolean), exclude: (src.cast?.exclude || []).map(re).filter(Boolean) } }, randomUUID(), i + 1, entities);
    if (src.id) shotMap.set(src.id, shot.id);
    if (src.prompts) shot.prompts = normalizePrompts(src.prompts);
    if (src.style) shot.style = normalizeStyle(src.style);
    shot.references = (src.references || []).map(copyRef).filter(Boolean);
    return shot;
  });
  const assetMap = new Map();
  const assets = (s.assets || []).flatMap(a => {
    const path = `media/${a.file}`, shotId = shotMap.get(a.shotId);
    if (!shotId || !/^assets\/[a-f0-9-]{36}\.mp4$/.test(a.file || '') || !mediaOk(path)) return [];
    const id = randomUUID(); assetMap.set(a.id, id);
    files.push({ from: path, to: `assets/${id}.mp4` });
    const m = (s.media || []).find(x => x.path === path);
    return [{ ...structuredClone(a), id, shotId, file: `assets/${id}.mp4`, sha256: m?.sha256 ?? null, width: m?.width ?? null, height: m?.height ?? null, fps: m?.fps ?? null, frameCount: m?.frameCount ?? null, duration: m?.duration ?? a.duration ?? null, starter: s.slug, source: { ...(a.source || {}), ...(a.kind === 'camera-render' ? { engineShotId: null } : { resultId: null }) } }];
  });
  const clips = (s.edit?.clips || []).filter(c => shotMap.has(c.shotId) && assetMap.has(c.assetId)).map(c => ({ id: randomUUID(), shotId: shotMap.get(c.shotId), assetId: assetMap.get(c.assetId), in: c.in ?? 0, out: c.out ?? null }));
  const out = { scene: { name: s.scene.name || s.title, environment: structuredClone(s.scene.environment || {}), entities }, shots, files };
  if (references.length) out.scene.references = references;
  if (assets.length) out.assets = assets;
  if (clips.length) out.edit = { clips, updatedAt: new Date().toISOString() };
  return out;
}

/** Copy a starter's media into a project folder. Idempotent: files already there are kept as they are. */
export async function attachStarterMedia(starterDir, projectDir, files) {
  let copied = 0;
  for (const f of files) {
    const to = join(projectDir, f.to);
    if (existsSync(to)) continue;
    await mkdir(dirname(to), { recursive: true });
    await copyFile(join(starterDir, f.from), to); copied++;
  }
  return copied;
}
