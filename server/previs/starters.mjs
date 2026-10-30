// Starter projects: versioned snapshots committed under examples/starters/<slug>/starter.json.
// A snapshot is a whole blockout (scene, groups, paths, environment, shots with cameras, style,
// prompts and cast) without renders, references or assets. Creating a project from a starter
// deep-copies the snapshot with fresh ids. A starter folder may later carry a media/ folder
// listed in "media"; nothing reads it yet.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { makeEntity, makeShot } from '../../shared/director.mjs';
import { normalizePrompts, normalizeStyle } from '../../shared/prompt.mjs';

export const STARTER_FORMAT = 'comfy-previs-starter';
export const STARTER_VERSION = 1;
export const STARTERS_DIR = fileURLToPath(new URL('../../examples/starters/', import.meta.url));

// Fields that point at generated media or per-project files. Stripped from snapshots for now.
const ENTITY_DROP = ['look', 'sheets'];
const SHOT_DROP = ['id', 'references', 'render'];

/** Turn a full project document into a portable starter snapshot. */
export function starterSnapshot(project, { slug, title, description, order = 0 }) {
  const entities = project.scene.entities.map(e => {
    const out = { ...structuredClone(e) };
    for (const k of ENTITY_DROP) delete out[k];
    return out;
  });
  const ids = new Set(entities.map(e => e.id));
  const shots = project.shots.map(s => {
    const out = structuredClone(s);
    for (const k of SHOT_DROP) delete out[k];
    if (out.cast) out.cast = { include: out.cast.include.filter(id => ids.has(id)), exclude: out.cast.exclude.filter(id => ids.has(id)) };
    if (out.camera?.target && !ids.has(out.camera.target)) out.camera.target = null;
    return out;
  });
  for (const e of entities) {
    if (e.parent && !ids.has(e.parent)) e.parent = null;
    if (e.lookFrom && !ids.has(e.lookFrom)) e.lookFrom = null;
  }
  const { name, environment } = project.scene;
  return { format: STARTER_FORMAT, version: STARTER_VERSION, slug, order, title, description, scene: { name: name || title, environment: structuredClone(environment || {}), entities }, shots, media: [] };
}

function valid(s) {
  return s?.format === STARTER_FORMAT && s.version <= STARTER_VERSION && /^[a-z0-9-]{1,40}$/.test(s.slug || '') && Array.isArray(s.scene?.entities) && Array.isArray(s.shots) && s.shots.length > 0;
}

/** Read every starter snapshot, sorted by order. Bad files are skipped. */
export async function loadStarters(dir = STARTERS_DIR) {
  let index;
  try { index = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')); } catch { return []; }
  const out = [];
  for (const slug of index.starters || []) {
    try { const s = JSON.parse(await readFile(join(dir, slug, 'starter.json'), 'utf8')); if (valid(s) && s.slug === slug) out.push(s); } catch {}
  }
  return out.sort((a, b) => (a.order || 0) - (b.order || 0));
}

/** What the launch page needs: title, description and enough of shot 1 to draw a thumbnail. */
export function starterCard(s) {
  return { slug: s.slug, title: s.title, description: s.description, shots: s.shots.length, entities: s.scene.entities.length, scene: s.scene, shot: s.shots[0] };
}

/** Scene and shots for a new project: a deep copy of the snapshot with fresh ids everywhere. */
export function instantiateStarter(s) {
  const map = new Map(s.scene.entities.map(e => [e.id, randomUUID()]));
  const re = id => (typeof id === 'string' && map.has(id) ? map.get(id) : null);
  const entities = s.scene.entities.map(e => makeEntity({ ...structuredClone(e), parent: re(e.parent), lookFrom: re(e.lookFrom) }, map.get(e.id)));
  const shots = s.shots.map((x, i) => {
    const src = structuredClone(x);
    const shot = makeShot({ ...src, camera: { ...src.camera, target: re(src.camera?.target) }, cast: { include: (src.cast?.include || []).map(re).filter(Boolean), exclude: (src.cast?.exclude || []).map(re).filter(Boolean) } }, randomUUID(), i + 1, entities);
    if (src.prompts) shot.prompts = normalizePrompts(src.prompts);
    if (src.style) shot.style = normalizeStyle(src.style);
    return shot;
  });
  return { scene: { name: s.scene.name || s.title, environment: structuredClone(s.scene.environment || {}), entities }, shots };
}
