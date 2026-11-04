// Server side of the coplanar-surface lint (shared/blockout-lint.mjs): loads display meshes, then checks agent and MCP
// edits, library places and imports, and Blender imports. Two objects sharing a plane z-fight in the viewport and in
// every blockout frame, so an edit that creates one gets a warning; an import lifts a thin static object 2 mm where
// that is safe. Rules: docs/blockout-modeling-rules.md.
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseGlb, lintScene, lintMesh, describeFinding, offsetFix, COPLANAR } from '../../shared/blockout-lint.mjs';
import { BLOCKOUT_MODELS, projectMesh } from '../../shared/blockout-models.mjs';
import { makeEntity } from '../../shared/director.mjs';

const BUNDLED = fileURLToPath(new URL('../../public/models/blockouts/', import.meta.url));
const bundled = new Map();
/** A bundled display mesh (public/models/blockouts/<id>.glb), parsed once; null if it cannot be read. */
export function bundledMesh(id) {
  if (!Object.hasOwn(BLOCKOUT_MODELS, id)) return null;
  if (!bundled.has(id)) { try { bundled.set(id, parseGlb(readFileSync(`${BUNDLED}${id}.glb`))); } catch { bundled.set(id, null); } }
  return bundled.get(id);
}

/**
 * meshOf for lintScene. Project meshes (/director-refs/<project>/<file>.glb) come from `parsed` (url → parseGlb output)
 * or are read through `refFile(projectId, file)`; unreadable meshes fall back to the proxy shape.
 */
export async function meshLoader(entities, { refFile = null, parsed = new Map() } = {}) {
  const parts = new Map(parsed);
  for (const e of entities) {
    const url = projectMesh(e.model);
    if (!url || parts.has(url) || e.source) continue; // imported models are not linted (shared/blockout-lint.mjs)
    const [, , projectId, file] = url.split('/');
    try { parts.set(url, refFile ? parseGlb(await readFile(await refFile(projectId, file))) : null); } catch { parts.set(url, null); }
  }
  return id => (Object.hasOwn(BLOCKOUT_MODELS, id) ? bundledMesh(id) : parts.get(id) ?? null);
}

const GEOMETRY = ['shape', 'model', 'position', 'rotation', 'pitch', 'roll', 'scale'];
/** id → the fields that place an entity's surfaces, to tell which entities an edit added or moved. */
export const geometryOf = entities => new Map(entities.map(e => [e.id, JSON.stringify(GEOMETRY.map(k => e[k] ?? null))]));
export function changedIds(before, entities) {
  const now = geometryOf(entities);
  return new Set([...now].filter(([id, g]) => before.get(id) !== g).map(([id]) => id));
}

const names = entities => Object.fromEntries(entities.map(e => [e.id, e.name]));
/** Warnings (plain sentences) for coplanar overlaps that involve any of `only`. */
export function coplanarWarnings(entities, { meshOf, only = null, limit = 8 } = {}) {
  if (only && !only.size) return [];
  const findings = lintScene(entities, { meshOf, only, limit });
  return findings.map(f => describeFinding(f, names(entities)));
}

/**
 * Lift thin, static objects in `movable` 2 mm off any surface they share with another object (at most three rounds),
 * then report what is left. entities is the whole scene after the change; it is not modified. Returns
 * { moves: Map(id → new position), fixed: [sentences], warnings: [sentences] }.
 */
export function fixCoplanar(entities, { meshOf, movable, protect = new Set(), limit = 8 }) {
  const scene = entities.map(e => structuredClone(e)), byId = new Map(scene.map(e => [e.id, e])), moves = new Map(), fixed = [];
  const keep = new Set([...scene.map(e => e.id).filter(id => !movable.has(id)), ...protect]);
  for (let round = 0; round < 3; round++) {
    const findings = lintScene(scene, { meshOf, only: movable, limit: 50 });
    const moved = new Set();
    for (const f of findings) {
      const fix = offsetFix(f, scene, { protect: keep });
      if (!fix || moved.has(fix.id)) continue; // one lift per object per round, then look again
      const e = byId.get(fix.id), other = byId.get(f.a.owner === fix.id ? f.b.owner : f.a.owner);
      e.position = fix.position; moves.set(fix.id, fix.position); moved.add(fix.id);
      fixed.push(`Lifted “${e.name}” ${COPLANAR.decalOffset * 1000} mm off “${other?.name}”: they shared a surface and would have z-fought.`);
    }
    if (!moved.size) break;
  }
  const left = lintScene(scene, { meshOf, only: movable, limit });
  return { moves, fixed: [...new Set(fixed)], warnings: left.map(f => describeFinding(f, names(scene))) };
}

/** The scene an op list would produce, for linting before it is applied (add_entity and update_entity only). */
export function sceneAfterOps(entities, ops) {
  const out = new Map(entities.map(e => [e.id, e]));
  for (const op of ops) {
    if (op.op === 'add_entity' && op.entity?.id) out.set(op.entity.id, makeEntity(op.entity, op.entity.id));
    else if (op.op === 'update_entity' && out.has(op.id)) out.set(op.id, makeEntity({ ...out.get(op.id), ...op.patch }, op.id));
  }
  return [...out.values()];
}

/** Coplanar overlaps inside one model, for import checks. Single-material meshes cannot fight with themselves. */
export function meshWarnings(bytes, label) {
  let parts; try { parts = parseGlb(bytes); } catch { return []; }
  return lintMesh(parts, { limit: 3 }).map(f => describeFinding(f).replace('the model', label));
}

/**
 * The gate for bundled content: every bundled GLB at its proxy size and at every scale a starter shows it, and every
 * starter scene between its objects. Returns [{ where, text, finding }]; empty means nothing will z-fight.
 */
export function lintBundled(starters) {
  const out = [], seen = new Set();
  for (const id of Object.keys(BLOCKOUT_MODELS)) {
    const parts = bundledMesh(id);
    if (!parts) { out.push({ where: `${id}.glb`, text: 'cannot be read' }); continue; }
    for (const f of lintMesh(parts)) out.push({ where: `${id}.glb`, text: describeFinding(f), finding: f });
  }
  for (const s of starters) {
    for (const e of s.scene.entities) {
      const key = `${e.model}|${e.scale}`;
      if (!e.model || !Object.hasOwn(BLOCKOUT_MODELS, e.model) || seen.has(key)) continue;
      seen.add(key);
      for (const f of lintMesh(bundledMesh(e.model), { scale: e.scale })) out.push({ where: `${e.model}.glb at ${s.slug} scale [${e.scale}]`, text: describeFinding(f), finding: f });
    }
    for (const f of lintScene(s.scene.entities, { meshOf: bundledMesh, limit: 100 })) out.push({ where: `${s.slug} starter`, text: describeFinding(f, names(s.scene.entities)), finding: f });
  }
  return out;
}
