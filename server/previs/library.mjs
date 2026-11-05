// Reusable blockout assets: one object (with everything grouped under it), its Cast Card, looks and design sheets,
// saved as a small starter-shaped bundle in <PREVIS_DATA_DIR>/library/ and placed into any project as add_entity ops
// plus a file copy. Design: .evidence/REUSABLE-ASSETS-DESIGN-20261031.md.
//
//   library/assets/<assetId>/asset.json         manifest (field allowlist below; no paths, job ids or secrets)
//   library/assets/<assetId>/refs/<refId>.<ext>  looks, sheet views, composed boards
//   library/assets/<assetId>/versions/<n>.json   earlier manifests; media files are never deleted
//
// The functions here never take a lock: the director runs every library write on its own serial queue, so a save and
// a place never interleave within one server. Several servers on one PREVIS_LIBRARY_DIR are not supported.
import { validateMesh, MESH_LIMITS } from './mesh.mjs';
import { blockoutModel, projectMesh } from '../../shared/blockout-models.mjs';
import { mkdir, readFile, readdir, writeFile, stat, mkdtemp, rm, realpath, lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { readZip, writeZip, zipEntryNames } from './zip.mjs';
import { atomicJson } from './atomic.mjs';
import { snapshotEntity } from './starters.mjs';
import { imageSize } from './frames.mjs';
import { SHAPES, KINDS, ROLES, handleOf, descendantsOf, entitySize, lookSource, castCard, makeEntity } from '../../shared/director.mjs';
import { normalizeSheets } from '../../shared/sheet-presets.mjs';
import { rigidApply } from '../../shared/editor-controls.mjs';
import { readHandoffDir, readHandoffZip, validateHandoff } from './blender-import.mjs';
import { bundledMesh, coplanarWarnings, meshWarnings } from './coplanar.mjs';
import { parseGlb } from '../../shared/blockout-lint.mjs';

export const ASSET_FORMAT = 'comfy-previs-asset';
// Version 2 adds optional `license`, `authors` and `parametric` (the generator recipe that made the asset, so an agent
// can re-make it with other parameters). Bundles without those fields are still written as version 1.
export const ASSET_FORMAT_VERSION = 2;
const MiB = 1024 ** 2;
// Safety limits (design §8). Tests may pass smaller ones to openLibrary; the server always uses these.
export const LIMITS = Object.freeze({ zipBytes: 64 * MiB, zipEntries: 32, unzippedBytes: 96 * MiB, imageBytes: 10 * MiB, entities: 50, assets: 500, tags: 12, tagLength: 24, description: 300, shrinkPx: 1600 });
/** The only names a bundle may contain, in a zip or a directory. */
export const ENTRY = /^asset\.json$|^refs\/[a-f0-9-]{36}\.(png|jpg|webp|glb)$/;
const REF_FILE = /^[a-f0-9-]{36}\.(png|jpg|webp)$/;
const UUID = /^[a-f0-9-]{36}$/;
const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
// A string that looks like a local path never goes into a bundle (and a bundle carrying one is refused).
const LOCAL_PATH = /^\/|^[A-Za-z]:[\\/]|^~/;
// references[].generated keeps what explains an image; request, prompt and job ids, outputs and signatures stay home.
const GENERATED_KEEP = ['presetId', 'model', 'seed', 'prompt'];

function fail(message, status = 400) { const e = Error(message); e.status = status; throw e; }
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const vec3 = (v, d) => (Array.isArray(v) && v.length === 3 && v.every(x => typeof x === 'number' && Number.isFinite(x)) ? [...v] : d);
const uuidOr = v => (typeof v === 'string' && UUID.test(v) ? v : null);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function sniffImage(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}
/** Pixel size of a PNG, JPEG or WebP (VP8, VP8L, VP8X); nulls when the header is not understood. */
export function imageDims(bytes) {
  if (sniffImage(bytes) !== 'image/webp') return imageSize(bytes);
  const chunk = bytes.subarray(12, 16).toString('latin1');
  if (chunk === 'VP8X' && bytes.length >= 30) return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
  if (chunk === 'VP8 ' && bytes.length >= 30) return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L' && bytes.length >= 25) { const [b0, b1, b2, b3] = bytes.subarray(21, 25); return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) }; }
  return { width: null, height: null };
}

/** The library folder: PREVIS_LIBRARY_DIR when set (several data dirs can share one), else <data>/library. */
export function libraryDir(dataDir, env = process.env) {
  return env.PREVIS_LIBRARY_DIR ? resolve(env.PREVIS_LIBRARY_DIR) : join(dataDir, 'library');
}

// ---------- Manifest: field allowlist, canonical hash, path scan ----------

const canonical = v => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v));
/** What "unchanged" means: the canonical manifest without savedAt, version and supersedes, plus every media hash. */
export function contentHash(m) {
  const { savedAt, version, supersedes, contentHash: _, ...rest } = m;
  return `sha256:${sha(`${canonical(rest)}\n${(m.media || []).map(x => x.sha256).join('\n')}`)}`;
}

function cleanEntity(e) {
  const sheets = normalizeSheets(e.sheets);
  return {
    id: str(e.id, 36), name: str(e.name, 60), kind: KINDS.includes(e.kind) ? e.kind : 'prop', shape: SHAPES[e.shape] ? e.shape : 'box',
    position: vec3(e.position, [0, 0, 0]), rotation: num(e.rotation), scale: vec3(e.scale, [1, 1, 1]), color: /^#[0-9a-f]{6}$/i.test(e.color || '') ? e.color : '#8a8f98',
    notes: str(e.notes, 500), styleNotes: str(e.styleNotes, 300), pitch: num(e.pitch), roll: num(e.roll),
    ...(blockoutModel(e) || /^refs\/[a-f0-9-]{36}\.glb$/.test(e.model || '') ? { model: e.model } : {}),
    parent: uuidOr(e.parent), look: uuidOr(e.look), lookFrom: uuidOr(e.lookFrom), ...(sheets ? { sheets } : {}),
  };
}
function cleanGenerated(g) {
  if (!g || typeof g !== 'object') return undefined;
  const out = {};
  for (const k of GENERATED_KEEP) if (k === 'seed' ? Number.isInteger(g.seed) : typeof g[k] === 'string') out[k] = k === 'prompt' ? g[k].slice(0, 8000) : k === 'seed' ? g[k] : g[k].slice(0, 120);
  return Object.keys(out).length ? out : undefined;
}
function cleanReference(r) {
  const g = cleanGenerated(r.generated);
  return { id: str(r.id, 36), name: str(r.name, 80), file: str(r.file, 60), mime: str(r.mime, 20), role: ROLES.includes(r.role) ? r.role : 'prop', entityId: str(r.entityId, 36), note: str(r.note, 500), createdAt: str(r.createdAt, 40), ...(g ? { generated: g } : {}) };
}
const cleanMedia = m => ({ path: str(m.path, 60), size: Number.isInteger(m.size) ? m.size : 0, sha256: str(m.sha256, 64), width: Number.isInteger(m.width) ? m.width : null, height: Number.isInteger(m.height) ? m.height : null });
const cleanOrigin = o => ({ projectId: str(o?.projectId, 36), projectTitle: str(o?.projectTitle, 120), entityId: str(o?.entityId, 36), app: 'video-lab', source: ['project', 'project-export', 'blender', 'parametric'].includes(o?.source) ? o.source : 'project' });
const SPDX = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/;
const PARAM_KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
/** v2: generator recipe. Params are flat scalars only; anything else makes the manifest differ and is refused. */
function cleanParametric(p) {
  const params = {};
  if (p?.params && typeof p.params === 'object' && !Array.isArray(p.params)) {
    for (const [k, v] of Object.entries(p.params).slice(0, 40)) {
      if (PARAM_KEY.test(k) && (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'string')) params[k] = typeof v === 'string' ? v.slice(0, 80) : v;
    }
  }
  return { library: str(p?.library, 40), family: str(p?.family, 80), version: str(p?.version, 20), params, seed: Number.isInteger(p?.seed) && p.seed >= 0 ? p.seed : 0 };
}
/** v2 fields, kept only when present so version-1 manifests are unchanged. */
function cleanV2(m) {
  return {
    ...(m.license !== undefined ? { license: typeof m.license === 'string' && SPDX.test(m.license) ? m.license : null } : {}),
    ...(m.authors !== undefined ? { authors: (Array.isArray(m.authors) ? m.authors : []).filter(a => typeof a === 'string').slice(0, 8).map(a => a.slice(0, 80)) } : {}),
    ...(m.parametric !== undefined ? { parametric: cleanParametric(m.parametric) } : {}),
  };
}
export function cleanTags(tags, limits = LIMITS) {
  const list = Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(',') : [];
  return [...new Set(list.map(t => String(t).trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-').slice(0, limits.tagLength)).filter(Boolean))].slice(0, limits.tags);
}

/** The manifest rebuilt from allowed fields only. A bundle is accepted only when this equals what it carries. */
export function cleanManifest(m) {
  return {
    format: ASSET_FORMAT, formatVersion: Number.isInteger(m.formatVersion) ? m.formatVersion : ASSET_FORMAT_VERSION,
    version: Number.isInteger(m.version) && m.version > 0 ? m.version : 1,
    id: str(m.id, 36), handle: str(m.handle, 60), name: str(m.name, 60), kind: KINDS.includes(m.kind) ? m.kind : 'prop',
    tags: cleanTags(m.tags), description: str(m.description, LIMITS.description),
    savedAt: str(m.savedAt, 40), contentHash: str(m.contentHash, 71), ...(m.supersedes ? { supersedes: str(m.supersedes, 71) } : {}),
    origin: cleanOrigin(m.origin),
    entities: (Array.isArray(m.entities) ? m.entities : []).map(e => cleanEntity(e && typeof e === 'object' ? e : {})),
    references: (Array.isArray(m.references) ? m.references : []).map(r => cleanReference(r && typeof r === 'object' ? r : {})),
    media: (Array.isArray(m.media) ? m.media : []).map(x => cleanMedia(x && typeof x === 'object' ? x : {})),
    footprint: vec3(m.footprint, [1, 1, 1]),
    ...cleanV2(m),
  };
}

function firstDiff(a, b, path = '') {
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object' || Array.isArray(a) !== Array.isArray(b)) return path || '(manifest)';
  if (Array.isArray(a)) {
    if (a.length !== b.length) return path;
    for (let i = 0; i < a.length; i++) { const d = firstDiff(a[i], b[i], `${path}[${i}]`); if (d) return d; }
    return null;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDiff(a[k], b[k], path ? `${path}.${k}` : k); if (d) return d; }
  return null;
}
/** Every string in the manifest, with where it is. */
function* strings(v, path = '') {
  if (typeof v === 'string') yield [path, v];
  else if (Array.isArray(v)) for (let i = 0; i < v.length; i++) yield* strings(v[i], `${path}[${i}]`);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) yield* strings(x, path ? `${path}.${k}` : k);
}
/** Refuse any string that looks like a local path (/…, C:\…, ~…): bundles never carry where something lived. */
export function assertNoLocalPaths(m) {
  for (const [path, s] of strings(m)) if (LOCAL_PATH.test(s)) fail(`asset.json must not contain local paths (${path}: “${s.slice(0, 40)}”)`);
}

/**
 * Check a manifest completely: format, field allowlist, limits, internal links, no local paths. Media bytes are
 * checked separately (checkMedia). Returns the manifest.
 */
export function validateManifest(m, limits = LIMITS) {
  if (!m || typeof m !== 'object' || Array.isArray(m) || m.format !== ASSET_FORMAT) fail('Not a video-lab asset (asset.json format)');
  if (!Number.isInteger(m.formatVersion) || m.formatVersion < 1 || m.formatVersion > ASSET_FORMAT_VERSION) fail(`This asset needs a newer video-lab (format version ${m.formatVersion})`);
  if (m.formatVersion < 2 && (m.license !== undefined || m.authors !== undefined || m.parametric !== undefined || m.origin?.source === 'parametric')) fail('asset.json uses license, authors or parametric, which need format version 2');
  const diff = firstDiff(m, cleanManifest(m));
  if (diff) fail(`asset.json has a field outside the asset format, or an invalid value: ${diff}`);
  assertNoLocalPaths(m);
  if (!UUID.test(m.id)) fail('asset.json id must be a UUID');
  if (!/^[a-z0-9-]{1,60}$/.test(m.handle) || handleOf(m.handle) !== m.handle) fail('asset.json handle is not a valid @handle');
  if (!m.entities.length) fail('An asset needs at least one object');
  if (m.entities.length > limits.entities) fail(`An asset holds at most ${limits.entities} objects (this one has ${m.entities.length})`);
  const ids = new Set();
  for (const [i, e] of m.entities.entries()) {
    if (!UUID.test(e.id) || ids.has(e.id)) fail(`asset.json entities[${i}] needs a unique UUID id`);
    if (i === 0 ? e.parent !== null : !ids.has(e.parent)) fail(`asset.json entities[${i}] must come after its parent, inside the asset`);
    ids.add(e.id);
  }
  const refIds = new Set();
  for (const [i, r] of m.references.entries()) {
    const ext = r.file.split('.').pop();
    if (!UUID.test(r.id) || refIds.has(r.id) || !REF_FILE.test(r.file) || r.file !== `${r.id}.${ext}` || MIME[ext] !== r.mime) fail(`asset.json references[${i}] has an invalid id, file or type`);
    if (!ids.has(r.entityId)) fail(`asset.json references[${i}] belongs to no object in the asset`);
    if (!m.media.some(x => x.path === `refs/${r.file}`)) fail(`asset.json references[${i}] has no media entry`);
    refIds.add(r.id);
  }
  for (const e of m.entities) {
    if (e.model?.startsWith('refs/') && !m.media.some(x => x.path === e.model)) fail(`${e.name}: its mesh is missing`);
    if (e.look && !refIds.has(e.look)) fail(`${e.name}: its look is not in the asset`);
    if (e.lookFrom && (!ids.has(e.lookFrom) || e.lookFrom === e.id)) fail(`${e.name}: it shares a look from outside the asset`);
    for (const sh of e.sheets || []) for (const s of sh.slots) for (const a of s.attempts) if (a.referenceId && !refIds.has(a.referenceId)) fail(`${e.name}: a sheet view is not in the asset`);
  }
  const paths = new Set();
  for (const [i, x] of m.media.entries()) {
    if (!ENTRY.test(x.path) || x.path === 'asset.json' || paths.has(x.path) || !/^[a-f0-9]{64}$/.test(x.sha256)) fail(`asset.json media[${i}] has an invalid path or hash`);
    if (!m.references.some(r => `refs/${r.file}` === x.path) && !m.entities.some(e => e.model === x.path)) fail(`asset.json media[${i}] is not used by any reference`);
    if (x.size > limits.imageBytes) fail(`${x.path} is over ${limits.imageBytes / MiB} MB`);
    paths.add(x.path);
  }
  if (m.contentHash !== contentHash(m)) fail('asset.json was changed after it was saved (content hash does not match)');
  return m;
}

/** Each listed file: present, the declared size and hash, an image of the declared type under the image cap. */
export function checkMedia(m, get, limits = LIMITS) {
  let meshBytes = 0, triangles = 0;
  for (const x of m.media) {
    const bytes = get(x.path);
    if (!bytes) fail(`Asset is incomplete: ${x.path} is missing`);
    if (bytes.length > limits.imageBytes) fail(`${x.path} is over ${limits.imageBytes / MiB} MB`);
    if (bytes.length !== x.size || sha(bytes) !== x.sha256) fail(`Asset file changed: ${x.path}`);
    if (x.path.endsWith('.glb')) {
      const info = validateMesh(bytes); meshBytes += info.bytes; triangles += info.triangles * m.entities.filter(e => e.model === x.path).length;
      if (meshBytes > MESH_LIMITS.totalBytes || triangles > MESH_LIMITS.totalTriangles) fail('Meshes exceed 32 MB or 100000 triangles total');
      continue;
    }
    if (sniffImage(bytes) !== MIME[x.path.split('.').pop()]) fail(`${x.path} is not the PNG, JPEG or WebP image its name says`);
  }
}

/**
 * An asset bundle's files (Map name → bytes, from a zip or a folder) checked as a whole: only allowlisted names,
 * a valid manifest, every listed file present and as declared, nothing undeclared. Returns the manifest.
 */
export function readAssetBundle(files, limits = LIMITS) {
  for (const name of files.keys()) if (!ENTRY.test(name)) fail(`Unexpected file in asset bundle: ${name.slice(0, 80)}`);
  const raw = files.get('asset.json');
  if (!raw) fail('Not a video-lab asset (no asset.json)');
  let m; try { m = JSON.parse(raw.toString('utf8')); } catch { fail('asset.json is not valid JSON'); }
  validateManifest(m, limits);
  checkMedia(m, path => files.get(path), limits);
  for (const name of files.keys()) if (name !== 'asset.json' && !m.media.some(x => x.path === name)) fail(`Undeclared file in asset bundle: ${name}`);
  return m;
}

// ---------- Building an asset from a project ----------

/**
 * The asset for one object of a project: the object first, then everything grouped under it (parents before
 * children), positions relative to the object, root at the origin with its own yaw kept. A look shared from outside
 * the asset is copied in (look, description, style notes) so the asset never depends on another object.
 * Returns { manifest (without id, version, savedAt, hash, media), takes: [{ path, file, ref }] } where `file` is the
 * image file in the project's refs folder.
 */
export function assetSnapshot(project, root, { name, tags, description, limits = LIMITS, source = 'project' } = {}) {
  const all = project.scene.entities;
  const members = [root, ...descendantsOf(all, root.id)];
  if (members.length > limits.entities) fail(`An asset holds at most ${limits.entities} objects; ${root.name} has ${members.length} with everything grouped under it`);
  const inside = new Set(members.map(e => e.id));
  const refById = new Map((project.scene.references || []).map(r => [r.id, r]));
  const refs = new Map(), carrier = new Map();
  const entities = members.map(e => {
    let src = e, lookFrom = null;
    if (e.lookFrom && inside.has(e.lookFrom)) lookFrom = e.lookFrom;
    else if (e.lookFrom) {
      // Shared from outside: the first member using that source carries a copy of its look; later ones share it.
      const s = lookSource(project, e.id);
      if (s && s.id !== e.id && carrier.has(s.id)) lookFrom = carrier.get(s.id);
      else if (s && s.id !== e.id) { carrier.set(s.id, e.id); const card = castCard(project, e.id); src = { ...e, lookFrom: null, look: s.look, sheets: undefined, notes: card.description, styleNotes: card.styleNotes }; }
      else src = { ...e, lookFrom: null };
    }
    const out = snapshotEntity(project, src, r => { if (!refs.has(r.id)) refs.set(r.id, { ref: r, entityId: e.id }); }, refById);
    if (projectMesh(out.model)) out.model = `refs/${out.model.split('/').pop()}`;
    return cleanEntity({ ...out, lookFrom, parent: e.id === root.id ? null : e.parent });
  });
  const origin = entities[0].position;
  for (const e of entities) e.position = e.position.map((v, i) => Math.round((v - origin[i]) * 1e6) / 1e6);
  const takes = [], references = [];
  for (const { ref: r, entityId } of refs.values()) {
    const ext = String(r.file).split('.').pop();
    if (!REF_FILE.test(r.file || '') || !UUID.test(r.id)) fail(`${r.name || 'An image'} has an unexpected file name`);
    const g = cleanGenerated(r.generated);
    references.push({ id: r.id, name: str(r.name, 80), file: `${r.id}.${ext}`, mime: MIME[ext], role: ROLES.includes(r.role) ? r.role : 'prop', entityId, note: str(r.note, 500), createdAt: str(r.createdAt, 40), ...(g ? { generated: g } : {}) });
    takes.push({ path: `refs/${r.id}.${ext}`, file: r.file, ref: references.at(-1) });
  }
  for (const e of entities) if (e.model?.startsWith('refs/') && !takes.some(t => t.path === e.model)) takes.push({ path: e.model, file: e.model.slice(5), mesh: true, ref: { name: e.name } });
  const label = String(name || root.name).trim().slice(0, 60) || root.name;
  const manifest = {
    format: ASSET_FORMAT, formatVersion: 1, handle: handleOf(label), name: label, kind: entities[0].kind,
    tags: cleanTags(tags, limits), description: str(String(description ?? entities[0].notes ?? '').trim(), limits.description),
    origin: cleanOrigin({ projectId: project.id, projectTitle: project.title, entityId: root.id, source }),
    entities, references, footprint: entitySize(root).map(v => Math.round(v * 1000) / 1000),
  };
  return { manifest, takes };
}

/** Plain summary of what an asset holds, for replies: "1 look and a 9-view sheet". */
export function assetContents(m) {
  const looks = m.entities.filter(e => e.look).length;
  const sheets = m.entities.flatMap(e => e.sheets || []);
  const parts = [], meshes = m.entities.filter(e => e.model).length;
  if (meshes) parts.push(plural(meshes, 'mesh'));
  if (looks) parts.push(plural(looks, 'look'));
  if (sheets.length === 1) parts.push(`a ${sheets[0].slots.length}-view sheet`); else if (sheets.length) parts.push(plural(sheets.length, 'design sheet'));
  if (m.entities.length > 1) parts.push(`${plural(m.entities.length - 1, 'object')} grouped under it`);
  return parts.length ? parts.join(parts.length > 2 ? ', ' : ' and ').replace(/, ([^,]+)$/, ' and $1') : 'no images yet (a sized proxy: add its description and images)';
}

/** What the library dialog and previs_library_list show: the manifest without sheets and references. */
export function assetCard(m) {
  const { references, media, entities, ...rest } = m;
  const root = entities[0], look = references.find(r => r.id === root.look);
  return { ...rest, entities: entities.map(({ sheets, ...e }) => e), objects: entities.length, looks: entities.filter(e => e.look).length, sheetViews: entities.flatMap(e => e.sheets || []).reduce((n, s) => n + s.slots.length, 0), hasLook: !!look, hasSheet: entities.some(e => e.sheets?.length), thumb: look ? `/library-refs/${m.id}/${look.file}` : null, shape: root.shape, color: root.color };
}

// ---------- Finding an asset by name ----------

const sharedPrefix = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
/**
 * One asset for a reference: exact id; then @handle; then handleOf(ref) (so "Red Racecar" and "@Red-Racecar" hit
 * red-racecar); then the one handle that starts with it or contains it as a whole dash-separated word. Otherwise
 * fails with the nearest handles so the agent can ask instead of guess.
 */
export function resolveAssetRef(assets, ref) {
  const raw = String(ref ?? '').trim();
  if (!raw) fail('Name a library asset (its @handle)');
  const hit = assets.find(a => a.id === raw) || assets.find(a => a.handle === raw.replace(/^@/, ''));
  if (hit) return hit;
  const h = handleOf(raw);
  const same = assets.find(a => a.handle === h);
  if (same) return same;
  const partial = assets.filter(a => a.handle.startsWith(h) || `-${a.handle}-`.includes(`-${h}-`));
  if (partial.length === 1) return partial[0];
  const words = h.split('-');
  const nearest = [...partial, ...assets.filter(a => !partial.includes(a)).sort((a, b) => sharedPrefix(b.handle, h) - sharedPrefix(a.handle, h) || (b.tags || []).filter(t => words.includes(t)).length - (a.tags || []).filter(t => words.includes(t)).length)].slice(0, 5);
  fail(`${partial.length > 1 ? `“${raw}” matches several library assets` : `No library asset is called “${raw}”`}. ${nearest.length ? `Nearest: ${nearest.map(a => `@${a.handle}`).join(', ')}` : 'The library is empty; save an object with previs_library_save first'}.`, 404);
}

/** Search: every word of q appears in the handle, name, kind, tags or description. */
export function searchAssets(assets, { q, kind, tag } = {}) {
  const words = String(q || '').toLowerCase().replace(/@/g, '').split(/\s+/).filter(Boolean);
  return assets.filter(a => (!kind || a.kind === kind) && (!tag || (a.tags || []).includes(String(tag).toLowerCase()))
    && words.every(w => [a.handle, a.name.toLowerCase(), a.kind, ...(a.tags || []), a.description.toLowerCase()].some(x => x.includes(w))));
}

// ---------- Placing an asset into a project ----------

/**
 * The edit that brings an asset into a project: one add_entity op per object (fresh ids, parents first), the
 * references to append to project.scene.references (fresh ids, the copy's object ids) and the files to copy
 * (asset-relative `from` → project refs file `to`). Sheets point at the new reference ids. The root carries
 * `from: { asset, version, handle }`. `shot` adds the object to that shot's cast; `variantOf` makes the root share
 * an existing object's look instead of copying the asset's root images.
 */
export function placeAsset(project, m, { position, rotation, name, shot, variantOf } = {}) {
  const idMap = new Map(m.entities.map(e => [e.id, randomUUID()]));
  const root = m.entities[0];
  const find = ref => project.scene.entities.find(e => e.id === ref) || project.scene.entities.find(e => handleOf(e.name) === handleOf(String(ref)));
  const variant = variantOf ? find(variantOf) : null;
  if (variantOf && !variant) fail(`Unknown object ${variantOf} (variantOf)`);
  const target = shot === undefined || shot === null || shot === '' ? null : project.shots.find(s => s.id === shot) || project.shots.find(s => handleOf(s.title) === handleOf(String(shot))) || (/^\d+$/.test(String(shot)) ? project.shots[Number(shot) - 1] : null);
  if (shot !== undefined && shot !== null && shot !== '' && !target) fail(`Unknown shot ${shot}`);
  // Images the root alone uses are not copied when it shares a variant's look.
  const rootOnly = new Set(variant ? [root.look, ...(root.sheets || []).flatMap(sh => sh.slots.flatMap(s => s.attempts.map(a => a.referenceId)))].filter(Boolean) : []);
  for (const e of m.entities.slice(1)) for (const id of [e.look, ...(e.sheets || []).flatMap(sh => sh.slots.flatMap(s => s.attempts.map(a => a.referenceId)))]) rootOnly.delete(id);
  const refMap = new Map(), references = [], files = [];
  for (const r of m.references) {
    if (rootOnly.has(r.id) || (variant && r.entityId === root.id && r.note.startsWith('sheet:'))) continue;
    const id = randomUUID(), ext = r.file.split('.').pop();
    refMap.set(r.id, id);
    files.push({ from: `refs/${r.file}`, to: `${id}.${ext}` });
    references.push({ ...structuredClone(r), id, file: `${id}.${ext}`, entityId: idMap.get(r.entityId) });
  }
  const models = new Map();
  for (const e of m.entities) if (e.model?.startsWith('refs/') && !models.has(e.model)) {
    const file = `${randomUUID()}.glb`; files.push({ from: e.model, to: file });
    models.set(e.model, `/director-refs/${project.id}/${file}`);
  }
  const at = vec3(position, [0, 0, 0]);
  const yaw = typeof rotation === 'number' && Number.isFinite(rotation) ? rotation : root.rotation;
  const moved = rigidApply({ position: [0, 0, 0], rotation: root.rotation, scale: root.scale }, { position: at, rotation: yaw, scale: root.scale }, m.entities.slice(1));
  const ops = m.entities.map((e, i) => {
    const isRoot = i === 0, shares = isRoot && variant;
    const sheets = shares ? undefined : (e.sheets || []).map(sh => ({ ...structuredClone(sh), slots: sh.slots.map(s => ({ ...structuredClone(s), attempts: s.attempts.map(a => ({ ...a, referenceId: refMap.get(a.referenceId) || null })) })) }));
    const where = isRoot ? { position: at, rotation: yaw } : { position: moved[i - 1].position, rotation: moved[i - 1].rotation };
    const entity = {
      id: idMap.get(e.id), name: isRoot ? String(name || m.name).slice(0, 60) : e.name, kind: e.kind, shape: e.shape, ...where, scale: [...e.scale], color: e.color,
      ...(e.model ? { model: models.get(e.model) || e.model } : {}),
      notes: e.notes, styleNotes: e.styleNotes, pitch: e.pitch, roll: e.roll, parent: isRoot ? null : idMap.get(e.parent),
      look: shares ? null : refMap.get(e.look) || null, lookFrom: shares ? variant.id : e.lookFrom ? idMap.get(e.lookFrom) : null,
      ...(sheets?.length ? { sheets } : {}), ...(isRoot ? { from: { asset: m.id, version: m.version, handle: m.handle } } : {}),
    };
    return { op: 'add_entity', entity };
  });
  if (target) {
    const castIds = root.shape === 'group' ? m.entities.filter(e => e.shape !== 'group').map(e => idMap.get(e.id)) : [idMap.get(root.id)];
    const cast = target.cast || { include: [], exclude: [] };
    ops.push({ op: 'update_shot', id: target.id, patch: { cast: { include: [...new Set([...cast.include, ...castIds])], exclude: cast.exclude.filter(id => !castIds.includes(id)) } } });
  }
  return { ops, references, files, rootId: idMap.get(root.id), entityIds: m.entities.map(e => idMap.get(e.id)) };
}

/**
 * Coplanar overlaps inside an asset (between its own objects, and inside each of its meshes) as plain sentences.
 * A bundle is content-hashed, so import reports them rather than moving anything; placing it can still lift parts.
 */
export function bundleWarnings(m, files) {
  const base = '/director-refs/00000000-0000-0000-0000-000000000000/', parsed = new Map(), warnings = [];
  for (const x of m.media.filter(x => x.path.endsWith('.glb'))) {
    const bytes = files.get(x.path), owner = m.entities.find(e => e.model === x.path);
    try { parsed.set(base + x.path.slice(5), parseGlb(bytes)); } catch { continue; }
    warnings.push(...meshWarnings(bytes, `the mesh of “${owner?.name || x.path}”`));
  }
  const entities = m.entities.map(e => (e.model?.startsWith('refs/') ? { ...e, model: base + e.model.slice(5) } : e));
  return [...warnings, ...coplanarWarnings(entities, { meshOf: id => bundledMesh(id) ?? parsed.get(id) ?? null })].slice(0, 8);
}

// ---------- The library on disk ----------

function run(cmd, args) { return new Promise((ok, no) => execFile(cmd, args, { maxBuffer: 16 * MiB }, (err, stdout) => (err ? no(err) : ok(stdout)))); }
/** Re-encode an image as WebP no larger than px on its long side; null when ffmpeg is not available. */
async function shrinkToWebp(bytes, px, ffmpeg) {
  const tmp = await mkdtemp(join(tmpdir(), 'previs-asset-'));
  try {
    await writeFile(join(tmp, 'in'), bytes);
    await run(ffmpeg, ['-v', 'error', '-y', '-i', join(tmp, 'in'), '-vf', `scale='min(${px},iw)':'min(${px},ih)':force_original_aspect_ratio=decrease`, '-c:v', 'libwebp', '-quality', '82', '-map_metadata', '-1', join(tmp, 'out.webp')]);
    return await readFile(join(tmp, 'out.webp'));
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  finally { await rm(tmp, { recursive: true, force: true }); }
}

/** Read a regular file (never through a symlink), refusing it as soon as it passes cap bytes. */
async function readCapped(path, cap, what) {
  let fh;
  try { fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (e) { fail(e.code === 'ELOOP' ? `${what} is a symlink; give the real file` : `Cannot read ${what}`); }
  try {
    if (!(await fh.stat()).isFile()) fail(`${what} is not a file`);
    const chunks = [], buf = Buffer.alloc(1 << 20); let size = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (!bytesRead) break;
      size += bytesRead; if (size > cap) fail(`${what} is over ${Math.round(cap / MiB)} MB`, 413);
      chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
    }
    return Buffer.concat(chunks);
  } finally { await fh.close(); }
}
// A whole-project export (director.mjs EXPORT_FORMAT) can be large; one object is taken from it.
const PROJECT_EXPORT = 'comfy-previs-project', MAX_PROJECT_EXPORT = 1024 ** 3;
const sameOrigin = (a, project, entity) => a.origin?.projectId === project.id && a.origin?.entityId === entity.id;

// ---------- Blender handoff source (the seam) ----------
// The Blender thin import (server/previs/blender-import.mjs) owns reading and validating an export:
// blender-previs.json plus frames/. The library only needs one object's first frame record from it, so it uses that
// reader as is; openLibrary's `blender` option swaps in a stand-in for tests.
export const BLENDER_SIDECAR = 'blender-previs.json';
/** { readDir(path), readZip(buffer), validate(manifest) }: the Blender importer's own reader. */
export async function blenderHandoffReader() {
  return { readDir: readHandoffDir, readZip: readHandoffZip, validate: validateHandoff };
}
/** A stable UUID-shaped id from text, so importing the same Blender object again is the same asset's next version. */
function stableId(text) {
  const h = sha(`comfy-previs-library:${text}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
/**
 * One object of a validated Blender handoff as a one-object project: its first frame record gives shape, kind
 * (cast objects keep theirs, the rest are environment), colour and size (scale = size / the shape's size); the name
 * is the one video-lab uses (the cast: prefix already dropped). No images and no sheet: a sized proxy to fill in.
 */
export function blenderObject(manifest, object) {
  const objects = Array.isArray(manifest?.objects) ? manifest.objects : [];
  const ref = String(object || '').replace(/^@/, '');
  if (!ref) fail(`This is a Blender export; name the object to take from it: ${objects.slice(0, 8).map(o => o.name).join(', ')}`);
  const o = objects.find(x => x.name === ref || x.blenderName === ref) || objects.find(x => handleOf(x.name) === handleOf(ref));
  if (!o) fail(`No object called “${object}” in that Blender export; it has ${objects.slice(0, 8).map(x => x.name).join(', ')}`, 404);
  const shape = SHAPES[o.shape] && !['group', 'terrain'].includes(o.shape) ? o.shape : 'box';
  const own = KINDS.includes(o.kind) ? o.kind : SHAPES[shape].kind;
  const kind = !o.cast ? 'environment' : own === 'environment' ? 'prop' : own;
  const f = o.frames[0], base = SHAPES[shape].size;
  const scale = f.size.map((v, i) => Math.round(Math.max(0.05, Math.min(50, v / base[i])) * 1e6) / 1e6);
  const id = stableId(`blender:${manifest.source?.scene || ''}:${o.blenderName || o.name}`);
  const entity = makeEntity({ name: o.name, shape, kind, color: o.color, rotation: f.yaw, scale }, id);
  if (o.mesh) entity.model = `/director-refs/${id}/${id}.glb`;
  return { mesh: o.mesh || null, project: { id: '', title: String(manifest.source?.scene || 'Blender export').slice(0, 120), scene: { entities: [entity], references: [], environment: { preset: 'stage', description: '' } }, shots: [] }, entity };
}

export function openLibrary(dir, { limits = LIMITS, ffmpeg = 'ffmpeg', log = () => {}, blender = blenderHandoffReader } = {}) {
  const assetsDir = join(dir, 'assets');
  const assetDir = id => { if (!UUID.test(id || '')) fail('Unknown asset', 404); return join(assetsDir, id); };

  /** Every readable asset, newest first, plus the folder names whose manifest could not be read. */
  async function scan() {
    let names = []; try { names = await readdir(assetsDir, { withFileTypes: true }); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const assets = [], bad = [];
    for (const d of names) {
      if (!d.isDirectory() || !UUID.test(d.name)) continue;
      try { const m = JSON.parse(await readFile(join(assetsDir, d.name, 'asset.json'), 'utf8')); if (m?.format !== ASSET_FORMAT || m.id !== d.name || !Array.isArray(m.entities) || !m.entities.length) throw Error('bad'); assets.push(m); }
      catch { bad.push(d.name); }
    }
    return { assets: assets.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt))), bad };
  }

  /** Write a manifest and its media; the manifest it replaces goes to versions/<n>.json. Existing same files are kept. */
  async function write(m, blobs, previous) {
    const at = assetDir(m.id);
    await mkdir(join(at, 'refs'), { recursive: true });
    for (const [path, bytes] of blobs) {
      const to = join(at, path);
      let same = false; try { same = (await stat(to)).size === bytes.length && sha(await readFile(to)) === sha(bytes); } catch {}
      if (!same) await writeFile(to, bytes, { mode: 0o600 });
    }
    if (previous) { await mkdir(join(at, 'versions'), { recursive: true }); await atomicJson(join(at, 'versions', `${previous.version}.json`), previous); }
    await atomicJson(join(at, 'asset.json'), m);
  }

  /** Add an imported asset: a known id with the same content is a no-op, a known id with new content the next version. */
  async function install(m, files) {
    const { assets } = await scan();
    const existing = assets.find(a => a.id === m.id), clash = assets.find(a => a.handle === m.handle && a.id !== m.id);
    if (clash) fail(`@${m.handle} is already in the library as a different asset; rename one of them, then import again`, 409);
    const warnings = bundleWarnings(m, files), warn = warnings.length ? { warnings } : {};
    if (existing && existing.contentHash === m.contentHash) return { asset: assetCard(existing), action: 'unchanged', text: `@${existing.handle} v${existing.version} is already in your library`, ...warn };
    const next = cleanManifest(existing ? { ...m, version: existing.version + 1, supersedes: existing.contentHash } : m);
    await write(next, new Map(next.media.map(x => [x.path, files.get(x.path)])), existing);
    return { asset: assetCard(next), action: existing ? 'updated' : 'added', text: existing ? `Updated @${next.handle} in your library to v${next.version}` : `Added @${next.handle} to your library`, ...warn };
  }

  /** One object out of a whole-project export (.previs.zip), checked like a project import, saved as an asset. */
  async function fromProjectExport(files, object, input) {
    let manifest; try { manifest = JSON.parse(files.get('previs-export.json')?.toString('utf8')); } catch {}
    if (manifest?.format !== PROJECT_EXPORT || manifest.version !== 1 || !Array.isArray(manifest.files)) fail('Not a video-lab project export');
    for (const f of manifest.files) { const data = files.get(f.name); if (!data || sha(data) !== f.sha256) fail(`Export is incomplete or changed: ${f.name}`); }
    for (const name of files.keys()) if (name !== 'previs-export.json' && !manifest.files.some(f => f.name === name)) fail(`Unexpected file in export: ${name}`);
    let p; try { p = JSON.parse(files.get('project.json').toString('utf8')); } catch { fail('Export project.json is invalid'); }
    if (p?.version !== 1 || !Array.isArray(p.scene?.entities)) fail('Unsupported project version');
    if (!object) fail(`This is a whole project export (“${String(p.title || '').slice(0, 60)}”); name the object to take from it`);
    const ref = String(object).replace(/^@/, '');
    const e = p.scene.entities.find(x => x.id === ref) || p.scene.entities.find(x => handleOf(x.name) === handleOf(ref));
    if (!e) fail(`No object called “${object}” in that project; it has ${p.scene.entities.filter(x => x.shape !== 'group' || !x.parent).slice(0, 8).map(x => x.name).join(', ')}`, 404);
    return api.save(p, e, input, file => { const b = files.get(`refs/${file}`); if (!b) throw Error('missing'); return b; }, { source: 'project-export' });
  }

  /** One object out of a Blender handoff (folder or zip), read and validated by the Blender importer. */
  async function fromBlender(read, object, input) {
    const reader = await blender();
    const { manifest, frames, meshes = new Map() } = await read(reader);
    reader.validate(manifest, frames, meshes);
    const { project, entity, mesh } = blenderObject(manifest, object);
    return api.save(project, entity, input, () => meshes.get(mesh), { source: 'blender' });
  }

  const api = {
    dir, limits,
    scan,
    async list(query = {}) {
      const { assets, bad } = await scan();
      const found = searchAssets(assets, query).map(assetCard);
      return { assets: found, total: assets.length, ...(bad.length ? { unreadable: bad.length } : {}), ...(assets.length > limits.assets ? { warning: `The library has ${assets.length} assets; more than ${limits.assets} makes listing slow. Export and remove ones you no longer use.` } : {}) };
    },
    async get(ref) { return resolveAssetRef((await scan()).assets, ref); },
    refFile(id, file) {
      if (!REF_FILE.test(file || '') && !/^[a-f0-9-]{36}\.glb$/.test(file || '')) fail('Not found', 404);
      return join(assetDir(id), 'refs', file);
    },
    assetDir,
    /**
     * Save one object of a project (and everything grouped under it). readRef(file) returns the bytes of a project
     * refs file. Saving the same object again, an object placed from this asset, or with replace:true over a taken
     * handle makes the next version; an unchanged save is a no-op.
     */
    async save(project, entity, input = {}, readRef, { source = 'project' } = {}) {
      // Imported models (docs/import.md) carry their own file and rights; bundles hold blockout meshes only, for now.
      const inside = new Set([entity.id]);
      for (let grew = true; grew;) { grew = false; for (const e of project.scene.entities) if (e.parent && inside.has(e.parent) && !inside.has(e.id)) { inside.add(e.id); grew = true; } }
      const imported = project.scene.entities.find(e => inside.has(e.id) && e.source);
      if (imported) fail(`${imported.name} is an imported model; the library does not hold imported models yet. Import its file into each project instead`);
      const { assets } = await scan();
      const { manifest: base, takes } = assetSnapshot(project, entity, { name: input.name, tags: input.tags, description: input.description, limits, source });
      const blobs = [];
      for (const t of takes) {
        let bytes; try { bytes = await readRef(t.file); } catch {}
        if (!Buffer.isBuffer(bytes)) fail(`The ${t.mesh ? 'mesh' : 'image'} file of “${t.ref.name}” is missing from the project`);
        if (bytes.length > limits.imageBytes) fail(`“${t.ref.name}” is over ${limits.imageBytes / MiB} MB`);
        if (t.mesh) { validateMesh(bytes); blobs.push({ ...t, bytes }); continue; }
        if (sniffImage(bytes) !== t.ref.mime) fail(`“${t.ref.name}” is not the PNG, JPEG or WebP image its name says`);
        blobs.push({ ...t, bytes });
      }
      const total = () => blobs.reduce((n, b) => n + b.bytes.length, 0) + 64 * 1024;
      if (total() > limits.zipBytes) {
        // Over the bundle cap: shrink every image to WebP ≤ 1600 px when ffmpeg is here, else say what is big.
        for (const b of blobs.filter(b => !b.mesh)) {
          const small = await shrinkToWebp(b.bytes, limits.shrinkPx, ffmpeg);
          if (!small) fail(`This asset's images total ${(total() / MiB).toFixed(1)} MB, over the ${limits.zipBytes / MiB} MB limit, and ffmpeg is not available to shrink them: ${blobs.map(x => `${x.ref.name} ${(x.bytes.length / MiB).toFixed(1)} MB`).join(', ')}`);
          b.bytes = small; b.ref.file = `${b.ref.id}.webp`; b.ref.mime = 'image/webp'; b.path = `refs/${b.ref.file}`;
        }
        if (total() > limits.zipBytes) fail(`This asset's images total ${(total() / MiB).toFixed(1)} MB even as WebP, over the ${limits.zipBytes / MiB} MB limit`);
        log(`[library] shrank ${blobs.length} images of ${base.name} to WebP`);
      }
      const media = blobs.map(b => ({ path: b.path, size: b.bytes.length, sha256: sha(b.bytes), ...(b.mesh ? { width: null, height: null } : imageDims(b.bytes)) })).map(cleanMedia);
      const byHandle = assets.find(a => a.handle === base.handle);
      const previous = byHandle && (input.replace === true || sameOrigin(byHandle, project, entity) || byHandle.id === entity.from?.asset) ? byHandle : null;
      if (byHandle && !previous) fail(`@${base.handle} is already in the library; choose another name or save over it with replace: true`, 409);
      const m = { ...base, id: previous?.id || randomUUID(), version: previous ? previous.version + 1 : 1, savedAt: new Date().toISOString(), contentHash: '', ...(previous ? { supersedes: previous.contentHash } : {}), media };
      const ordered = cleanManifest(m);
      ordered.contentHash = contentHash(ordered);
      if (previous && previous.contentHash === ordered.contentHash) return { asset: assetCard(previous), action: 'unchanged', text: `@${previous.handle} v${previous.version} is already in the library, unchanged (${assetContents(previous)})` };
      // The exporter checks what the importer checks: allowlist, links, no local paths, every file as declared.
      validateManifest(ordered, limits);
      const files = new Map(blobs.map(b => [b.path, b.bytes]));
      checkMedia(ordered, p => files.get(p), limits);
      await write(ordered, files, previous);
      return { asset: assetCard(ordered), action: previous ? 'updated' : 'added', text: `Saved @${ordered.handle} v${ordered.version} with ${assetContents(ordered)}` };
    },
    /** <handle>.previs-asset.zip: asset.json and refs/, checked exactly as an import would check it. */
    async exportZip(ref) {
      const m = await api.get(ref);
      const files = new Map([['asset.json', Buffer.from(JSON.stringify(m, null, 2))]]);
      for (const x of m.media) files.set(x.path, await readCapped(join(assetDir(m.id), x.path), limits.imageBytes, x.path));
      readAssetBundle(files, limits);
      // Stamped with the version's savedAt, so exporting the same version twice gives the same bytes.
      const saved = new Date(m.savedAt);
      const data = writeZip([...files].map(([name, bytes]) => ({ name, data: bytes })), Number.isNaN(saved.getTime()) ? {} : { date: saved });
      if (data.length > limits.zipBytes) fail(`@${m.handle} is ${(data.length / MiB).toFixed(1)} MB, over the ${limits.zipBytes / MiB} MB bundle limit`);
      return { filename: `${m.handle}.previs-asset.zip`, data, asset: assetCard(m) };
    },
    /** Import a .previs-asset.zip from memory (browser upload or the home page drop). */
    async importZip(buffer) {
      if (buffer.length > limits.zipBytes) fail(`Asset bundles are at most ${limits.zipBytes / MiB} MB (this one is ${(buffer.length / MiB).toFixed(1)} MB)`, 413);
      const files = readZip(buffer, { maxEntries: limits.zipEntries, maxTotal: limits.unzippedBytes });
      return install(readAssetBundle(files, limits), files);
    },
    /**
     * Import from an absolute path: a .previs-asset.zip, a folder holding asset.json, or a .previs.zip project export
     * plus `object`. The path must be its own realpath; only allowlisted names are read; nothing is executed.
     */
    async importPath(path, { object, ...input } = {}) {
      if (typeof path !== 'string' || !isAbsolute(path)) fail('path must be an absolute path');
      let real; try { real = await realpath(path); } catch { fail(`Nothing at ${path}`, 404); }
      if (real !== path) fail(`Give the real path (no symlinks, “..” or trailing slash): ${real}`);
      const st = await lstat(path);
      if (st.isDirectory()) {
        const files = new Map();
        let total = 0;
        const take = async (name, cap) => { const b = await readCapped(join(path, name), cap, name); total += b.length; if (total > limits.unzippedBytes) fail('Asset folder content is too large', 413); files.set(name, b); };
        const listing = await readdir(path);
        if (!listing.includes('asset.json') && listing.includes(BLENDER_SIDECAR)) return fromBlender(r => r.readDir(path), object, input);
        if (!listing.includes('asset.json')) fail('That folder has no asset.json');
        await take('asset.json', limits.unzippedBytes);
        let m; try { m = JSON.parse(files.get('asset.json').toString('utf8')); } catch { fail('asset.json is not valid JSON'); }
        validateManifest(m, limits);
        try { if ((await lstat(join(path, 'refs'))).isSymbolicLink()) fail('refs is a symlink'); } catch (e) { if (e.status) throw e; }
        for (const x of m.media) await take(x.path, limits.imageBytes);
        return install(readAssetBundle(files, limits), files);
      }
      if (!st.isFile()) fail('path must be a file or a folder');
      // Asset bundles are capped at 64 MB (importZip checks again); project and Blender exports can be larger.
      const buffer = await readCapped(path, path.endsWith('.previs-asset.zip') ? limits.zipBytes : MAX_PROJECT_EXPORT, 'That file');
      const names = zipEntryNames(buffer);
      if (names.includes('asset.json')) return api.importZip(buffer);
      if (names.includes('previs-export.json')) return fromProjectExport(readZip(buffer, { maxTotal: MAX_PROJECT_EXPORT }), object, input);
      if (names.some(n => n.split('/').pop() === BLENDER_SIDECAR)) return fromBlender(r => r.readZip(buffer), object, input);
      fail('Not a video-lab asset bundle (.previs-asset.zip), asset folder, project export (.previs.zip) or Blender export');
    },
  };
  return api;
}
