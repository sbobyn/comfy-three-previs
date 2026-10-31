// Director projects: one editable blockout scene, its shots, per-shot image
// references and the direction thread shared by the browser and an MCP agent.
import { mkdir, readFile, readdir, writeFile, copyFile, rename, cp, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { writeZip, readZip } from './zip.mjs';
import { renderEdit, withTemp, imageToPng } from './edit.mjs';
import { normalizePrompts, normalizeStyle } from '../../shared/prompt.mjs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { recoveryId, saveResultBytes } from './result-recovery.mjs';
import { atomicJson } from './atomic.mjs';
import { interpret } from './director-parse.mjs';
import { planProposal, sceneView } from './agent-proposal.mjs'; // [agent]
import { autoPromptText, shotPrompt } from '../../shared/prompt.mjs'; // [agent]
import { TEMPLATES, ROLES, makeEntity, makeShot, normalizeCamera, clampDuration, clampStart, uniqueName, handleOf, compilePrompt, setKeyframes, removeKeys, videoReferences, keyStills, normalizeCast, descendantsOf, withDescendants } from '../../shared/director.mjs';
import { cameraSourceOf } from '../../shared/camera-source.mjs';
import { rigidApply } from '../../shared/editor-controls.mjs';
import { loadStarters, starterCard, instantiateStarter, attachStarterMedia } from './starters.mjs';
import { existsSync } from 'node:fs';

const uuid = /^[a-f0-9-]{36}$/;
const MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const MAX_IMAGE = 10 * 1024 * 1024;
const now = () => new Date().toISOString();
function fail(message, status = 400) { const e = Error(message); e.status = status; throw e; }

function sniff(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

// Which video a timeline clip plays: a chosen asset, else the shot's newest workflow result, else its newest camera render.
export function clipAsset(p, clip) {
  const assets = (p.assets || []).filter(a => a.shotId === clip.shotId && a.mime?.startsWith('video/'));
  if (clip.assetId) return assets.find(a => a.id === clip.assetId) || null;
  const newest = kind => assets.filter(a => a.kind === kind).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return newest('workflow-result') || newest('camera-render') || null;
}
export function editClips(p) { return p.edit?.clips?.length ? p.edit.clips : p.shots.map(s => ({ id: s.id, shotId: s.id, assetId: null, in: 0, out: null })); }

export function summary(p) {
  return { assets: (p.assets || []).length, id: p.id, title: p.title, template: p.template, updatedAt: p.updatedAt, createdAt: p.createdAt, revision: p.revision, shots: p.shots.length, entities: p.scene.entities.length, references: p.shots.reduce((n, s) => n + s.references.length, 0), renders: p.shots.filter(s => s.render).length, sceneName: p.scene.name };
}

// template: a built-in blockout (TEMPLATES) or the slug of a starter snapshot passed in `starters`.
export function createProjectDocument({ title, template = 'street' } = {}, id = randomUUID(), starters = []) {
  const starter = starters.find(s => s.slug === template);
  const t = starter ? starter.slug : TEMPLATES[template] ? template : 'empty';
  const spec = starter || TEMPLATES[t];
  const at = now();
  if (starter) {
    // A starter's media (looks, sheets, stills, blockout and chosen videos) comes along when its files are present.
    const { scene, shots, assets, edit, files, media: counts } = instantiateStarter(starter, { has: path => !!starter.dir && existsSync(join(starter.dir, path)) });
    const media = files.length && starter.dir ? { dir: starter.dir, files } : null;
    return { version: 1, id, title: String(title || starter.title).slice(0, 120), template: t, createdAt: at, updatedAt: at, revision: 1, scene, shots, ...(assets ? { assets } : {}), ...(edit ? { edit } : {}), starterFiles: counts, ...(media ? { starterMedia: media } : {}), messages: [{ id: randomUUID(), shotId: null, role: 'system', text: `Started from the “${starter.title}” starter. Change anything — describe edits to your agent or drag things in the viewport.`, attachments: [], status: 'handled', createdAt: at }] };
  }
  const entities = [];
  for (const e of spec.entities) entities.push(makeEntity({ ...e, name: uniqueName(entities, e.name) }, randomUUID()));
  const project = { version: 1, id, title: String(title || spec.title).slice(0, 120), template: t, createdAt: at, updatedAt: at, revision: 1, scene: { name: spec.title, environment: { ...spec.environment }, entities }, shots: [], messages: [] };
  project.shots.push(makeShot({ title: 'Shot 1', description: '' }, randomUUID(), 1, entities));
  project.messages.push({ id: randomUUID(), shotId: null, role: 'system', text: `Started from “${spec.title}”. Describe the blockout, camera and shots — or drag things in the viewport.`, attachments: [], status: 'handled', createdAt: at });
  return project;
}

function resolveEntity(p, ref) {
  if (!ref) return null;
  return p.scene.entities.find(e => e.id === ref) || p.scene.entities.find(e => handleOf(e.name) === handleOf(ref)) || null;
}
function resolveShot(p, ref) {
  if (!ref) return null;
  return p.shots.find(s => s.id === ref) || p.shots.find(s => handleOf(s.title) === handleOf(ref)) || (/^\d+$/.test(String(ref)) ? p.shots[Number(ref) - 1] : null) || null;
}

// Apply a list of edit operations to a project document in place. Returns per-op results.
export function applyOps(p, ops) {
  if (!Array.isArray(ops) || ops.length > 200) fail('ops must be an array of at most 200 edits');
  const results = [];
  const batchIds = new Set(ops.filter(o => o?.op === 'update_entity').map(o => resolveEntity(p, o.id)?.id).filter(Boolean));
  for (const op of ops) {
    switch (op?.op) {
      case 'add_entity': {
        if (p.scene.entities.length >= 200) fail('Scene supports at most 200 objects');
        const id = uuid.test(op.entity?.id || '') && !p.scene.entities.some(e => e.id === op.entity.id) ? op.entity.id : randomUUID();
        const entity = makeEntity({ ...op.entity, name: uniqueName(p.scene.entities, op.entity?.name || op.entity?.shape || 'Object') }, id);
        p.scene.entities.push(entity); results.push({ op: op.op, id }); break;
      }
      case 'update_entity': {
        const e = resolveEntity(p, op.id); if (!e) fail(`Unknown object ${op.id}`);
        const patch = op.patch || {};
        if (patch.lookFrom) {
          const src = resolveEntity(p, patch.lookFrom); if (!src) fail(`Unknown object ${patch.lookFrom}`);
          if (src.id === e.id) fail('An object cannot share its own look');
          // No loops: the source must not (eventually) share this object's look.
          for (let x = src, i = 0; x?.lookFrom && i < 8; i++) { if (x.lookFrom === e.id) fail(`${src.name} already uses ${e.name}’s look`); x = p.scene.entities.find(y => y.id === x.lookFrom); }
          patch.lookFrom = src.id;
        }
        if (patch.parent !== undefined && patch.parent !== null) {
          const par = resolveEntity(p, patch.parent); if (!par) fail(`Unknown object ${patch.parent}`);
          if (par.id === e.id || descendantsOf(p.scene.entities, e.id).some(d => d.id === par.id)) fail(`${par.name} is inside ${e.name}`);
          patch.parent = par.id;
        }
        const before = { position: [...e.position], rotation: e.rotation, scale: [...e.scale] };
        const next = makeEntity({ ...e, ...patch, name: patch.name ? uniqueName(p.scene.entities.filter(x => x !== e), patch.name) : e.name }, e.id);
        Object.assign(e, next);
        if (!next.sheets) delete e.sheets; // `sheets: []` clears them (makeEntity omits an empty list)
        // Children follow their parent rigidly, unless this batch already places them (the editor sends every moved object).
        if (['position', 'rotation', 'scale'].some(k => patch[k] !== undefined)) {
          const kids = descendantsOf(p.scene.entities, e.id).filter(d => !batchIds.has(d.id));
          rigidApply(before, { position: e.position, rotation: e.rotation, scale: e.scale }, kids.map(d => ({ position: d.position, rotation: d.rotation, scale: d.scale })))
            .forEach((x, i) => { const d = kids[i]; const moved = makeEntity({ ...d, ...x }, d.id); if (d.path?.length) { const dx = moved.position.map((v, j) => v - d.position[j]); moved.path = d.path.map(k => ({ ...k, p: Array.isArray(k.p) ? k.p.map((v, j) => v + dx[j]) : k.p })); } Object.assign(d, moved); });
        }
        results.push({ op: op.op, id: e.id }); break;
      }
      case 'group': {
        const members = (Array.isArray(op.ids) ? op.ids : []).map(x => resolveEntity(p, x)).filter(Boolean);
        if (!members.length) fail('group needs ids of objects to group');
        const top = members.filter(m => !members.some(o => o !== m && descendantsOf(p.scene.entities, o.id).includes(m)));
        const all = withDescendants(p.scene.entities, top.map(m => m.id)).map(id => p.scene.entities.find(x => x.id === id));
        const c = [0, 2].map(i => all.reduce((a, x) => a + x.position[i], 0) / all.length);
        const id = uuid.test(op.id || '') && !p.scene.entities.some(e => e.id === op.id) ? op.id : randomUUID();
        const parent = top.every(m => m.parent === top[0].parent) ? top[0].parent : null;
        const kinds = [...new Set(top.map(m => m.kind))];
        p.scene.entities.push(makeEntity({ name: uniqueName(p.scene.entities, op.name || 'Group'), shape: 'group', kind: kinds.length === 1 ? kinds[0] : 'environment', position: [c[0], 0, c[1]], parent }, id));
        for (const m of top) m.parent = id;
        results.push({ op: op.op, id }); break;
      }
      case 'ungroup': {
        const g = resolveEntity(p, op.id); if (!g) fail(`Unknown object ${op.id}`);
        for (const x of p.scene.entities) if (x.parent === g.id) x.parent = g.parent || null;
        if (g.shape === 'group') p.scene.entities = p.scene.entities.filter(x => x !== g);
        results.push({ op: op.op, id: g.id }); break;
      }
      case 'set_keyframes': {
        const e = resolveEntity(p, op.id); if (!e) fail(`Unknown object ${op.id}`);
        if (!Array.isArray(op.keys) || op.keys.length > 64) fail('keys must be an array of at most 64 keyframes');
        e.path = setKeyframes(e, op.keys, op.mode === 'replace' ? 'replace' : 'merge'); results.push({ op: op.op, id: e.id, keys: e.path?.length ?? 0 }); break;
      }
      case 'remove_keyframes': {
        const e = resolveEntity(p, op.id); if (!e) fail(`Unknown object ${op.id}`);
        if (!Array.isArray(op.times)) fail('times must be an array of scene seconds');
        e.path = removeKeys(e.path, op.times); results.push({ op: op.op, id: e.id, keys: e.path?.length ?? 0 }); break;
      }
      case 'clear_animation': {
        const e = resolveEntity(p, op.id); if (!e) fail(`Unknown object ${op.id}`);
        e.path = null; results.push({ op: op.op, id: e.id }); break;
      }
      case 'remove_entity': {
        const e = resolveEntity(p, op.id); if (!e) fail(`Unknown object ${op.id}`);
        p.scene.entities = p.scene.entities.filter(x => x !== e);
        for (const x of p.scene.entities) if (x.parent === e.id) x.parent = e.parent || null;
        // Object looks stay (unlisted) so undo can bring the object back with them; files are never removed.
        for (const s of p.shots) { if (s.camera.target === e.id) s.camera.target = null; for (const r of s.references) if (r.entityId === e.id) r.entityId = null; }
        results.push({ op: op.op, id: e.id }); break;
      }
      case 'add_shot': {
        if (p.shots.length >= 50) fail('A scene supports at most 50 shots');
        const id = uuid.test(op.shot?.id || '') && !p.shots.some(s => s.id === op.shot.id) ? op.shot.id : randomUUID();
        const camera = op.shot?.camera ? { ...op.shot.camera, target: resolveEntity(p, op.shot.camera.target)?.id ?? (op.shot.camera.target === undefined ? undefined : null) } : undefined;
        if (camera && camera.target === undefined) delete camera.target;
        const shot = makeShot({ ...op.shot, camera }, id, p.shots.length + 1, p.scene.entities);
        const at = Number.isInteger(op.index) ? Math.max(0, Math.min(p.shots.length, op.index)) : p.shots.length;
        p.shots.splice(at, 0, shot); results.push({ op: op.op, id }); break;
      }
      case 'update_shot': {
        const s = resolveShot(p, op.id); if (!s) fail(`Unknown shot ${op.id}`);
        const patch = op.patch || {};
        if (patch.title !== undefined) s.title = String(patch.title).slice(0, 120) || s.title;
        if (patch.description !== undefined) s.description = String(patch.description).slice(0, 4000);
        if (patch.duration !== undefined) s.duration = clampDuration(patch.duration);
        if (patch.start !== undefined) s.start = clampStart(patch.start);
        if (patch.prompts !== undefined) s.prompts = normalizePrompts({ ...(s.prompts || {}), ...(patch.prompts || {}) });
        if (patch.style !== undefined) { if (patch.style === null) delete s.style; else s.style = normalizeStyle(patch.style); }
        if (patch.cast !== undefined) {
          const known = id => resolveEntity(p, id)?.id || fail(`Unknown object ${id}`);
          s.cast = normalizeCast({ include: (patch.cast?.include || []).map(known), exclude: (patch.cast?.exclude || []).map(known) });
        }
        if (patch.camera) {
          const target = patch.camera.target === undefined ? s.camera.target : resolveEntity(p, patch.camera.target)?.id ?? null;
          s.camera = normalizeCamera({ ...s.camera, ...(patch.camera.move && patch.camera.move !== 'custom' ? { keys: null } : {}), ...patch.camera, target });
        }
        results.push({ op: op.op, id: s.id }); break;
      }
      case 'remove_shot': {
        const s = resolveShot(p, op.id); if (!s) fail(`Unknown shot ${op.id}`);
        if (p.shots.length === 1) fail('A scene needs at least one shot');
        p.shots = p.shots.filter(x => x !== s); results.push({ op: op.op, id: s.id }); break;
      }
      case 'reorder_shots': {
        const ids = op.ids; if (!Array.isArray(ids) || ids.length !== p.shots.length || new Set(ids).size !== ids.length) fail('Provide every shot id once');
        p.shots = ids.map(id => p.shots.find(s => s.id === id) || fail('Unknown shot ' + id)); results.push({ op: op.op }); break;
      }
      case 'update_reference': {
        const s = p.shots.find(x => x.references.some(r => r.id === op.referenceId));
        const objectRef = (p.scene.references || []).find(x => x.id === op.referenceId);
        const r = s?.references.find(x => x.id === op.referenceId) || objectRef; if (!r) fail('Unknown reference');
        if (objectRef && op.patch?.entityId === null) fail('Object looks stay linked to their object; remove the look instead');
        const patch = op.patch || {};
        if (patch.entityId !== undefined) r.entityId = patch.entityId === null ? null : resolveEntity(p, patch.entityId)?.id ?? fail('Unknown object ' + patch.entityId);
        if (patch.role !== undefined) { if (!ROLES.includes(patch.role)) fail('Role must be ' + ROLES.join(', ')); r.role = patch.role; }
        if (patch.name !== undefined) r.name = String(patch.name).slice(0, 80) || r.name;
        if (patch.note !== undefined) r.note = String(patch.note).slice(0, 500);
        results.push({ op: op.op, id: r.id }); break;
      }
      case 'use_take': {
        // The newest take at a moment is the one in use (and a key frame's newest take is what video models get): move this one last.
        const s = resolveShot(p, op.shotId); if (!s) fail('Unknown shot');
        const i = s.references.findIndex(r => r.id === op.referenceId && r.role === 'frame'); if (i < 0) fail('Unknown still');
        s.references.push(...s.references.splice(i, 1)); results.push({ op: op.op, id: op.referenceId }); break;
      }
      case 'remove_reference': {
        if ((p.scene.references || []).some(r => r.id === op.referenceId)) {
          p.scene.references = p.scene.references.filter(r => r.id !== op.referenceId);
          for (const e of p.scene.entities) if (e.look === op.referenceId) e.look = p.scene.references.find(r => r.entityId === e.id)?.id ?? null;
          results.push({ op: op.op, id: op.referenceId }); break;
        }
        const s = resolveShot(p, op.shotId); if (!s) fail('Unknown shot');
        // The image file is retained on disk; only the shot link is removed.
        s.references = s.references.filter(r => r.id !== op.referenceId); results.push({ op: op.op, id: op.referenceId }); break;
      }
      case 'link_look': {
        // Reuse any image already in the project (another object's look, a shot reference) as this object's look.
        const e = resolveEntity(p, op.entityId); if (!e) fail(`Unknown object ${op.entityId}`);
        const src = [...(p.scene.references || []), ...p.shots.flatMap(s => s.references)].find(r => r.id === op.referenceId); if (!src) fail('Unknown image');
        if ((p.scene.references || []).some(r => r.entityId === e.id && r.file === src.file)) fail(`${e.name} already uses that image`);
        const ref = { id: randomUUID(), name: src.name, file: src.file, mime: src.mime, role: e.kind === 'character' ? 'character' : e.kind === 'environment' ? 'environment' : 'prop', entityId: e.id, note: 'linked', createdAt: now(), ...(src.generated ? { generated: src.generated } : {}) };
        (p.scene.references ||= []).push(ref);
        if (!e.look) e.look = ref.id;
        results.push({ op: op.op, id: e.id, referenceId: ref.id }); break;
      }
      case 'set_look': {
        const e = resolveEntity(p, op.entityId); if (!e) fail(`Unknown object ${op.entityId}`);
        if (op.referenceId !== null && !(p.scene.references || []).some(r => r.id === op.referenceId && r.entityId === e.id)) fail('That look does not belong to this object');
        e.look = op.referenceId; results.push({ op: op.op, id: e.id }); break;
      }
      case 'set_scene': {
        const patch = op.patch || {};
        if (patch.name !== undefined) p.scene.name = String(patch.name).slice(0, 120) || p.scene.name;
        if (patch.environment) p.scene.environment = { preset: ['stage', 'street', 'interior'].includes(patch.environment.preset) ? patch.environment.preset : p.scene.environment.preset, description: patch.environment.description === undefined ? p.scene.environment.description : String(patch.environment.description).slice(0, 500), style: patch.environment.style === undefined ? p.scene.environment.style || '' : String(patch.environment.style).slice(0, 500) };
        results.push({ op: op.op }); break;
      }
      case 'set_edit': {
        if (!Array.isArray(op.clips) || op.clips.length > 60) fail('clips must be an array of at most 60');
        p.edit = { clips: op.clips.map(c => {
          const s = resolveShot(p, c.shotId); if (!s) fail(`Unknown shot ${c.shotId}`);
          const asset = c.assetId ? (p.assets || []).find(a => a.id === c.assetId && a.shotId === s.id) : null;
          if (c.assetId && !asset) fail('That video does not belong to this shot');
          const num = v => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v) * 1000) / 1000 : null);
          return { id: uuid.test(c.id || '') ? c.id : randomUUID(), shotId: s.id, assetId: asset?.id ?? null, in: num(c.in) ?? 0, out: num(c.out) };
        }), updatedAt: now() };
        results.push({ op: op.op, clips: p.edit.clips.length }); break;
      }
      case 'set_project': {
        if (op.patch?.title !== undefined) p.title = String(op.patch.title).slice(0, 120) || p.title;
        results.push({ op: op.op }); break;
      }
      default: fail(`Unknown op ${op?.op}`);
    }
  }
  return results;
}

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const EXT = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'image/png': 'png' };
export const EXPORT_FORMAT = 'comfy-previs-project';

export async function openDirector(root, options = {}) {
  const dir = join(root, 'director'), archiveDir = join(root, 'director-archive');
  await mkdir(dir, { recursive: true });
  const engineJobs = options.engineJobs || (() => []);
  const cache = new Map();
  const waiters = new Set();
  const agent = { lastSeen: 0, name: null };
  let chain = Promise.resolve();
  const serial = fn => { const next = chain.then(fn); chain = next.catch(() => {}); return next; };

  async function load(id) {
    if (!uuid.test(id || '')) fail('Unknown project', 404);
    if (cache.has(id)) return cache.get(id);
    try { const p = JSON.parse(await readFile(join(dir, id, 'project.json'), 'utf8')); cache.set(id, p); return p; }
    catch (e) { if (e.code === 'ENOENT') fail('Unknown project', 404); throw e; }
  }
  async function save(p) {
    p.revision++; p.updatedAt = now();
    if (p.messages.length > 400) p.messages = p.messages.slice(-400);
    await atomicJson(join(dir, p.id, 'project.json'), p); cache.set(p.id, p);
    wake();
    return structuredClone(p);
  }
  const agentPresent = () => waiters.size > 0 || Date.now() - agent.lastSeen < 45000;
  const runner = () => options.runner?.() || null; // [agent] built-in Claude Code runner, when installed
  function agentStatus() { return { connected: agentPresent(), waiting: waiters.size > 0, lastSeen: agent.lastSeen ? new Date(agent.lastSeen).toISOString() : null, name: agent.name, runner: runner()?.status() ?? null }; }
  // [agent] A proposal is re-planned from the base project every time, so ids and undo stay consistent.
  function proposalOf(p, m) { return m.proposal?.ops?.length ? planProposal(p, m.proposal.ops) : null; }
  async function pending(projectId) {
    const ids = projectId ? [projectId] : (await list()).map(p => p.id);
    const out = [];
    for (const id of ids) { const p = await load(id); for (const m of p.messages) if (m.status === 'pending') out.push({ projectId: id, message: m }); }
    return out;
  }
  function wake() { for (const w of [...waiters]) w(); }

  async function list() {
    const names = await readdir(dir, { withFileTypes: true });
    const out = [];
    for (const d of names) if (d.isDirectory() && uuid.test(d.name)) { try { out.push(summary(await load(d.name))); } catch {} }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  function runBuiltin(p, message) {
    const { ops, reply } = interpret(message.text, p, message.shotId, message.attachments);
    let text = reply;
    try { if (ops.length) applyOps(p, ops); } catch (e) { text = `Couldn’t apply that: ${e.message}`; }
    message.status = 'handled'; message.handledBy = 'builtin';
    p.messages.push({ id: randomUUID(), shotId: message.shotId, role: 'builtin', text, attachments: [], status: 'handled', createdAt: now(), replyTo: message.id });
  }

  return {
    list,
    agentStatus,
    async get(id) { return structuredClone(await load(id)); },
    async starters() { return (await loadStarters(options.startersDir)).map(starterCard); },
    create: input => serial(async () => {
      const p = createProjectDocument(input, randomUUID(), await loadStarters(options.startersDir));
      await mkdir(join(dir, p.id, 'refs'), { recursive: true });
      // Starter media is copied before the project is first saved, so it never lists a file it lacks.
      const media = p.starterMedia; delete p.starterMedia;
      if (media) await attachStarterMedia(media.dir, join(dir, p.id), media.files);
      p.revision = 0; return save(p);
    }),
    edit: (id, ops) => serial(async () => {
      const p = structuredClone(await load(id));
      const results = applyOps(p, ops);
      return { project: await save(p), results };
    }),
    message: (id, input) => serial(async () => {
      const p = structuredClone(await load(id));
      const text = String(input.text || '').trim().slice(0, 8000);
      const shot = resolveShot(p, input.shotId) || p.shots[0];
      const attachments = (Array.isArray(input.attachments) ? input.attachments : []).filter(a => shot.references.some(r => r.id === a));
      if (!text && !attachments.length) fail('Write a direction or attach a reference');
      const message = { id: randomUUID(), shotId: shot.id, role: 'user', text, attachments, status: 'pending', createdAt: now() };
      p.messages.push(message);
      const mode = ['auto', 'runner', 'agent', 'builtin'].includes(input.mode) ? input.mode : 'auto';
      // [agent] Auto: the built-in runner when Claude Code is installed, else a connected external agent, else the parser.
      const r = runner();
      const toRunner = mode === 'runner' || (mode === 'auto' && !!r?.available());
      if (toRunner && !r?.available()) fail('Claude Code is not installed on this Mac; choose another route', 503);
      if (mode === 'builtin' || (mode === 'auto' && !toRunner && !agentPresent())) runBuiltin(p, message);
      const queued = toRunner && r.busy?.(p.id);
      const runInput = { text, shotNumber: p.shots.indexOf(shot) + 1, shotTitle: shot.title, attachments: shot.references.filter(x => attachments.includes(x.id)).map(x => `refs/${x.file}`) };
      if (queued) { message.status = 'queued'; message.handledBy = 'runner'; message.runInput = runInput; } // starts when the current turn finishes
      else if (toRunner) { message.status = 'claimed'; message.handledBy = 'runner'; message.workStartedAt = now(); }
      const saved = await save(p);
      if (queued) return { project: saved, messageId: message.id, routed: 'queued' };
      if (toRunner) r.start(p.id, message.id, { text, shotNumber: p.shots.indexOf(shot) + 1, shotTitle: shot.title, attachments: shot.references.filter(x => attachments.includes(x.id)).map(x => `refs/${x.file}`) });
      return { project: saved, messageId: message.id, routed: toRunner ? 'runner' : message.status === 'pending' ? 'agent' : 'builtin' };
    }),
    /** The oldest message waiting for the built-in agent, now claimed. */
    nextQueued: id => serial(async () => {
      const p = structuredClone(await load(id));
      const m = p.messages.find(x => x.role === 'user' && x.status === 'queued'); if (!m) return null;
      m.status = 'claimed'; m.workStartedAt = now(); const input = m.runInput; delete m.runInput;
      await save(p); return { messageId: m.id, input };
    }),
    builtin: (id, messageId) => serial(async () => {
      const p = structuredClone(await load(id));
      const m = p.messages.find(x => x.id === messageId && x.role === 'user');
      if (!m) fail('Unknown message'); if (m.status === 'handled') fail('Message already handled', 409);
      runBuiltin(p, m); return { project: await save(p) };
    }),
    reference: (id, input) => serial(async () => {
      const p = structuredClone(await load(id));
      const objectScope = input.scope === 'object';
      const shot = objectScope ? null : resolveShot(p, input.shotId);
      if (!objectScope && !shot) fail('Choose a shot for this reference');
      const outputKey = input.generated?.outputKey, requestId = input.generated?.requestId;
      if (outputKey && requestId) {
        const refs = objectScope ? p.scene.references || [] : shot.references;
        const existing = refs.find(r => r.generated?.requestId === requestId && r.generated?.outputKey === outputKey);
        if (existing) return { project: p, referenceId: existing.id };
      }
      if (shot && shot.references.length >= 24) fail('A shot supports at most 24 references');
      const bytes = Buffer.from(String(input.data || ''), 'base64');
      if (!bytes.length || bytes.length > MAX_IMAGE) fail('Reference images must be PNG, JPEG or WebP under 10 MB');
      const mime = sniff(bytes); if (!mime) fail('Reference images must be PNG, JPEG or WebP under 10 MB');
      const refId = outputKey && requestId ? recoveryId(requestId, outputKey) : randomUUID(), file = `${refId}.${MIME[mime]}`;
      await mkdir(join(dir, p.id, 'refs'), { recursive: true });
      if (outputKey && requestId) await saveResultBytes(join(dir, p.id, 'refs', file), bytes);
      else await writeFile(join(dir, p.id, 'refs', file), bytes, { flag: 'wx', mode: 0o600 });
      const entity = input.entityId ? resolveEntity(p, input.entityId) : null;
      if (objectScope && !entity) fail('Choose an object for this look');
      if (objectScope && (p.scene.references || []).filter(r => r.entityId === entity.id).length >= 64) fail('An object supports at most 64 looks');
      const role = ROLES.includes(input.role) ? input.role : entity ? (entity.kind === 'character' ? 'character' : entity.kind === 'environment' ? 'environment' : 'prop') : 'style';
      const name = String(input.name || 'reference').replace(/\.[a-z0-9]+$/i, '').slice(0, 80) || 'reference';
      const ref = { id: refId, name, file, mime, role, entityId: entity?.id ?? null, note: String(input.note || '').slice(0, 200), createdAt: now(), ...(input.generated ? { generated: input.generated } : {}) };
      if (objectScope) { (p.scene.references ||= []).push(ref); if (!entity.look) entity.look = refId; }
      else shot.references.push(ref);
      return { project: await save(p), referenceId: refId };
    }),
    async refFile(projectId, file) {
      if (!uuid.test(projectId) || !/^[a-f0-9-]{36}\.(png|jpg|webp)$/.test(file)) fail('Not found', 404);
      return join(dir, projectId, 'refs', file);
    },
    async wait(projectId, timeoutSeconds = 50, name = null) {
      if (projectId) await load(projectId);
      agent.lastSeen = Date.now(); if (name) agent.name = String(name).slice(0, 60);
      const deadline = Date.now() + Math.max(1, Math.min(120, Number(timeoutSeconds) || 50)) * 1000;
      for (;;) {
        const found = await pending(projectId);
        if (found.length) {
          return serial(async () => {
            const claimed = [];
            for (const { projectId: pid, message } of await pending(projectId)) {
              const p = structuredClone(await load(pid));
              const m = p.messages.find(x => x.id === message.id); m.status = 'claimed'; m.workStartedAt = now();
              await save(p);
              const shot = p.shots.find(s => s.id === m.shotId);
              claimed.push({ projectId: pid, projectTitle: p.title, revision: p.revision, message: m, shot: shot ? { id: shot.id, number: p.shots.indexOf(shot) + 1, title: shot.title } : null, attachments: shot ? shot.references.filter(r => m.attachments.includes(r.id)) : [] });
            }
            agent.lastSeen = Date.now();
            return { messages: claimed };
          });
        }
        const left = deadline - Date.now();
        if (left <= 0) { agent.lastSeen = Date.now(); return { messages: [], timedOut: true }; }
        await new Promise(resolve => { const done = () => { clearTimeout(t); waiters.delete(done); resolve(); }; const t = setTimeout(done, Math.min(left, 15000)); waiters.add(done); });
        agent.lastSeen = Date.now();
      }
    },
    // Live activity on the message an agent is working on; keeps the agent counted as present.
    progress: (id, input) => serial(async () => {
      const p = structuredClone(await load(id));
      agent.lastSeen = Date.now();
      const m = input.messageId ? p.messages.find(x => x.id === input.messageId && x.role === 'user') : p.messages.find(x => x.role === 'user' && x.status === 'claimed');
      const text = String(input.text || '').trim().slice(0, 300);
      if (!m || !text || m.activity?.at(-1)?.text === text) return { project: p, logged: false }; // [agent] no duplicate consecutive lines
      m.activity = [...(m.activity || []), { at: now(), text, ...(input.auto ? { auto: true } : {}) }].slice(-40);
      if (!m.workStartedAt) m.workStartedAt = now();
      return { project: await save(p), logged: true };
    }),
    reply: (id, input) => serial(async () => {
      const p = structuredClone(await load(id));
      agent.lastSeen = Date.now();
      const original = input.messageId ? p.messages.find(m => m.id === input.messageId && m.role === 'user') : null;
      if (input.messageId && !original) fail('Unknown message');
      if (original) { original.status = 'handled'; original.handledBy = 'agent'; original.workEndedAt = now(); }
      const text = String(input.text || '').trim().slice(0, 8000); if (!text) fail('Reply text required');
      p.messages.push({ id: randomUUID(), shotId: original?.shotId ?? resolveShot(p, input.shotId)?.id ?? null, role: 'agent', text, attachments: [], status: 'handled', createdAt: now(), ...(original ? { replyTo: original.id } : {}), ...(input.via === 'runner' ? { via: 'runner' } : {}), ...(input.error ? { error: true } : {}) });
      return { project: await save(p) };
    }),
    // [agent] Built-in agent: edits collect on the user message as a proposal until the user applies or discards it.
    propose: (id, messageId, ops) => serial(async () => {
      const p = structuredClone(await load(id));
      const m = p.messages.find(x => x.id === messageId && x.role === 'user'); if (!m) fail('Unknown message');
      if (m.proposal?.status && m.proposal.status !== 'pending') fail('That proposal was already decided', 409);
      const plan = planProposal(p, [...(m.proposal?.ops || []), ...(Array.isArray(ops) ? ops : [])]);
      const fresh = plan.summary.slice(m.proposal?.ops?.length || 0);
      m.proposal = { ops: plan.ops, undo: plan.undo, summary: plan.summary, small: plan.small, status: 'pending' };
      m.activity = [...(m.activity || []), ...fresh.map(s => ({ at: now(), text: s.text, auto: true }))].slice(-40);
      await save(p);
      return { summary: fresh.map(s => s.text), ids: plan.ops.map(o => o.entity?.id || o.shot?.id || null) };
    }),
    // Project as the agent should see it mid-turn: pending proposal applied on a copy.
    async preview(id, messageId) {
      const p = await load(id); const m = p.messages.find(x => x.id === messageId);
      const plan = m ? proposalOf(p, m) : null;
      return { project: plan ? plan.preview : structuredClone(p), pending: plan?.summary || [], shotId: m?.shotId ?? null };
    },
    suggest: (id, messageId, input) => serial(async () => {
      const p = structuredClone(await load(id));
      const m = p.messages.find(x => x.id === messageId && x.role === 'user'); if (!m) fail('Unknown message');
      const s = resolveShot(p, input.shot); if (!s) fail(`Unknown shot ${input.shot}`);
      const text = String(input.text || '').trim().slice(0, 4000); if (!text) fail('Prompt text required');
      m.suggestion = { shotId: s.id, kind: input.kind === 'image' ? 'image' : 'video', text };
      await save(p); return { ok: true, shot: p.shots.indexOf(s) + 1 };
    }),
    // Apply / discard / undo a proposal. Apply runs its ops as one edit; the browser records one undo entry.
    proposal: (id, messageId, action) => serial(async () => {
      const p = structuredClone(await load(id));
      const m = p.messages.find(x => x.id === messageId && x.role === 'user'); if (!m?.proposal) fail('No proposal on that message');
      const pr = m.proposal;
      if (action === 'apply') { if (pr.status !== 'pending') fail('That proposal was already decided', 409); applyOps(p, pr.ops); pr.status = 'applied'; pr.decidedAt = now(); }
      else if (action === 'discard') { if (pr.status !== 'pending') fail('That proposal was already decided', 409); pr.status = 'discarded'; pr.decidedAt = now(); }
      else if (action === 'undo') { if (pr.status !== 'applied') fail('Nothing to undo', 409); applyOps(p, pr.undo); pr.status = 'undone'; pr.decidedAt = now(); }
      else fail('action must be apply, discard or undo');
      return { project: await save(p), proposal: pr };
    }),
    // Copy finished workflow results whose source is one of this project's camera renders.
    syncResults: id => serial(async () => {
      const p = structuredClone(await load(id));
      let added = 0;
      // Backfill renders recorded before projects kept their own asset copies.
      for (const s of p.shots) {
        const r = s.render; if (!r || (p.assets || []).some(a => a.id === r.assetId)) continue;
        let bytes; try { bytes = await readFile(join(root, 'assets', r.assetId + '.mp4')); } catch { continue; }
        const file = `assets/${r.assetId}.mp4`;
        await mkdir(join(dir, p.id, 'assets'), { recursive: true });
        try { await writeFile(join(dir, p.id, file), bytes, { flag: 'wx', mode: 0o600 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
        (p.assets ||= []).push({ id: r.assetId, kind: 'camera-render', shotId: s.id, file, mime: 'video/mp4', sha256: sha(bytes), width: r.width, height: r.height, fps: 24, frameCount: r.frameCount, duration: r.duration, version: 1, createdAt: r.createdAt, source: { engineShotId: r.previsShotId, engineAssetId: r.assetId, prompt: r.prompt, signature: r.signature || '' } });
        added++;
      }
      const byEngineShot = new Map((p.assets || []).filter(a => a.kind === 'camera-render').map(a => [a.source.engineShotId, a]));
      const known = new Set((p.assets || []).filter(a => a.kind === 'workflow-result').map(a => a.source.resultId));
      for (const job of engineJobs()) {
        const render = byEngineShot.get(job.shotId);
        if (!render || !Array.isArray(job.results)) continue;
        for (const r of job.results) {
          if (known.has(r.id) || !EXT[r.mime] || !/^[a-f0-9-]{36}\.[a-z0-9]+$/.test(r.filename || '')) continue;
          let bytes;
          try { bytes = await readFile(join(root, r.kind === 'image' ? 'renders' : 'assets', r.filename)); } catch { continue; }
          if (r.sha256 && sha(bytes) !== r.sha256) continue;
          const file = `assets/${r.id}.${EXT[r.mime]}`;
          await mkdir(join(dir, p.id, 'assets'), { recursive: true });
          await saveResultBytes(join(dir, p.id, file), bytes);
          (p.assets ||= []).push({ id: r.id, kind: 'workflow-result', shotId: render.shotId, file, mime: r.mime, sha256: sha(bytes), width: r.width, height: r.height, fps: r.fps ?? null, frameCount: r.frameCount ?? null, duration: r.duration ?? null, createdAt: now(), source: { engineShotId: job.shotId, sourceAssetId: render.id, jobId: job.id, resultId: r.id, workflow: job.definition?.title || job.definition?.id || 'Workflow', backend: job.backend?.kind || null, cameraSource: job.cameraSource || cameraSourceOf(job.definition, job.binding?.assetBindings), prompt: String(job.binding?.prompt || '').slice(0, 8000), quote: job.quote ? { status: job.quote.status, amount: job.quote.amount ?? null, currency: job.quote.currency || 'USD' } : null } });
          known.add(r.id); added++;
        }
      }
      return added ? { project: await save(p), added } : { project: p, added: 0 };
    }),
    async assetFile(projectId, file) {
      if (!uuid.test(projectId) || !/^[a-f0-9-]{36}\.(mp4|webm|mov|png)$/.test(file)) fail('Not found', 404);
      return join(dir, projectId, 'assets', file);
    },
    async exportZip(id) {
      const p = await load(id);
      const entries = [{ name: 'project.json', data: Buffer.from(JSON.stringify(p, null, 2)) }];
      for (const sub of ['refs', 'assets', 'refgen']) {
        let names = []; try { names = await readdir(join(dir, id, sub)); } catch {}
        for (const n of names.sort()) if (/^[a-f0-9-]{36}\.(png|jpg|webp|mp4|webm|mov|json)$/.test(n)) entries.push({ name: `${sub}/${n}`, data: await readFile(join(dir, id, sub, n)) });
      }
      const manifest = { format: EXPORT_FORMAT, version: 1, exportedAt: now(), projectId: p.id, title: p.title, files: entries.map(e => ({ name: e.name, size: e.data.length, sha256: sha(e.data) })) };
      return { filename: `${p.title.replace(/[^\w .-]+/g, '').trim().replace(/\s+/g, '-') || 'project'}.previs.zip`, data: writeZip([{ name: 'previs-export.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) }, ...entries]) };
    },
    importZip: buffer => serial(async () => {
      const files = readZip(buffer);
      let manifest; try { manifest = JSON.parse(files.get('previs-export.json')?.toString('utf8')); } catch { fail('Not a Comfy Previs project export'); }
      if (manifest?.format !== EXPORT_FORMAT || manifest.version !== 1 || !Array.isArray(manifest.files)) fail('Not a Comfy Previs project export');
      for (const f of manifest.files) { const data = files.get(f.name); if (!data || sha(data) !== f.sha256) fail(`Export is incomplete or changed: ${f.name}`); }
      for (const name of files.keys()) if (name !== 'previs-export.json' && !manifest.files.some(f => f.name === name)) fail(`Unexpected file in export: ${name}`);
      let p; try { p = JSON.parse(files.get('project.json').toString('utf8')); } catch { fail('Export project.json is invalid'); }
      if (p.version !== 1 || !p.scene || !Array.isArray(p.shots) || !p.shots.length) fail('Unsupported project version');
      const oldId = p.id; p.id = randomUUID(); p.title = String(p.title || 'Imported project').slice(0, 110) + ' (imported)'; p.importedFrom = { projectId: oldId, exportedAt: manifest.exportedAt };
      // Camera renders keep their files, but workflow hand-off needs this workspace's render engine: render again to use them.
      for (const s of p.shots) if (s.render) { s.render = null; }
      for (const a of p.assets || []) a.imported = true;
      for (const m of p.messages) if (m.status !== 'handled') m.status = 'handled';
      await mkdir(join(dir, p.id), { recursive: true });
      for (const f of manifest.files) {
        if (f.name === 'project.json') continue;
        if (!/^(refs|assets|refgen)\/[a-f0-9-]{36}\.(png|jpg|webp|mp4|webm|mov|json)$/.test(f.name)) fail(`Unexpected file in export: ${f.name}`);
        let data = files.get(f.name);
        if (f.name.startsWith('refgen/')) { const job = JSON.parse(data.toString('utf8')); job.projectId = p.id; if (job.status === 'quoted') { job.status = 'expired'; job.message = 'Imported quote; get a new quote here.'; } job.imported = true; data = Buffer.from(JSON.stringify(job, null, 2)); }
        await mkdir(join(dir, p.id, f.name.split('/')[0]), { recursive: true });
        await writeFile(join(dir, p.id, f.name), data, { flag: 'wx', mode: 0o600 });
      }
      p.revision = 0; const saved = await save(p);
      await options.onImported?.(p.id);
      return { project: saved };
    }),
    duplicate: id => serial(async () => {
      const src = await load(id), p = structuredClone(src);
      p.id = randomUUID(); p.title = `Copy of ${src.title}`.slice(0, 120); p.createdAt = now(); p.duplicatedFrom = src.id; p.revision = 0;
      p.messages = p.messages.map(m => ({ ...m, status: 'handled' }));
      await mkdir(join(dir, p.id), { recursive: true });
      for (const sub of ['refs', 'assets']) { try { await cp(join(dir, id, sub), join(dir, p.id, sub), { recursive: true, errorOnExist: true, force: false }); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
      return { project: await save(p) };
    }),
    // Archiving moves the folder aside; nothing is deleted. Restore brings it back.
    archive: id => serial(async () => {
      await load(id); if (waiters.size) wake();
      await mkdir(archiveDir, { recursive: true });
      await rename(join(dir, id), join(archiveDir, id)); cache.delete(id);
      return { archived: id };
    }),
    restore: id => serial(async () => {
      if (!uuid.test(id || '')) fail('Unknown project', 404);
      try { await stat(join(archiveDir, id, 'project.json')); } catch { fail('Unknown archived project', 404); }
      await rename(join(archiveDir, id), join(dir, id));
      return { project: structuredClone(await load(id)) };
    }),
    async archived() {
      let names = []; try { names = await readdir(archiveDir, { withFileTypes: true }); } catch {}
      const out = [];
      for (const d of names) if (d.isDirectory() && uuid.test(d.name)) { try { out.push(summary(JSON.parse(await readFile(join(archiveDir, d.name, 'project.json'), 'utf8')))); } catch {} }
      return out;
    },
    async exportEdit(id) {
      const p = structuredClone(await load(id));
      const clips = editClips(p);
      const missing = clips.map((c, i) => ({ c, i, s: p.shots.find(s => s.id === c.shotId) })).filter(x => !x.s || !clipAsset(p, x.c));
      if (missing.length) fail(`Render these shots before exporting: ${missing.map(x => x.s ? `${p.shots.indexOf(x.s) + 1} “${x.s.title}”` : `clip ${x.i + 1}`).join(', ')}`);
      const inputs = clips.map(c => { const a = clipAsset(p, c); return { file: join(dir, id, a.file), duration: a.duration, in: c.in, out: c.out ?? a.duration, assetId: a.id }; });
      const assetId = randomUUID(), file = `assets/${assetId}.mp4`;
      await mkdir(join(dir, id, 'assets'), { recursive: true });
      const meta = await withTemp(async tmp => {
        const out = join(tmp, 'edit.mp4');
        const m = await renderEdit(inputs, out);
        await copyFile(out, join(dir, id, file));
        return m;
      });
      const bytes = await readFile(join(dir, id, file));
      return serial(async () => {
        const q = structuredClone(await load(id));
        const asset = { id: assetId, kind: 'edit', shotId: null, file, mime: 'video/mp4', sha256: sha(bytes), width: meta.width, height: meta.height, fps: meta.fps, frameCount: meta.frameCount, duration: meta.duration, version: (q.assets || []).filter(a => a.kind === 'edit').length + 1, createdAt: now(), source: { clips: inputs.map(({ assetId: a, in: i, out: o }) => ({ assetId: a, in: i, out: o })) } };
        (q.assets ||= []).push(asset);
        return { project: await save(q), asset };
      });
    },
    recordRender: (id, input, previs) => serial(async () => {
      const p = structuredClone(await load(id));
      const shot = resolveShot(p, input.shotId); if (!shot) fail('Unknown shot');
      const origin = input.origin === 'blender' ? { origin: 'blender' } : {}; // a clip imported from Blender (blender-import.mjs), not the Previs proxies
      const main = previs.get();
      const asset = main.assets?.find(a => a.id === input.assetId && a.shotId === input.previsShotId && a.kind === 'video');
      if (!asset) fail('Exported video not found in the project');
      // Keep a project-owned copy so the project folder is self-contained.
      const bytes = await readFile(join(root, 'assets', asset.id + '.mp4'));
      if (sha(bytes) !== asset.sha256) fail('Exported video changed on disk; render again');
      await mkdir(join(dir, p.id, 'assets'), { recursive: true });
      const file = `assets/${asset.id}.mp4`;
      try { await writeFile(join(dir, p.id, file), bytes, { flag: 'wx', mode: 0o600 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      (p.assets ||= []).push({ id: asset.id, kind: 'camera-render', shotId: shot.id, file, mime: 'video/mp4', sha256: asset.sha256, width: asset.width, height: asset.height, fps: asset.fps, frameCount: asset.frameCount, duration: asset.duration, version: (p.assets || []).filter(a => a.kind === 'camera-render' && a.shotId === shot.id).length + 1, createdAt: now(), source: { engineShotId: input.previsShotId, engineAssetId: asset.id, prompt: String(input.prompt || '').slice(0, 8000), signature: String(input.signature || '').slice(0, 64), ...origin } });
      shot.render = { previsShotId: input.previsShotId, assetId: asset.id, prompt: String(input.prompt || compilePrompt(p, shot)).slice(0, 8000), frameCount: asset.frameCount, duration: asset.duration, width: asset.width, height: asset.height, signature: String(input.signature || '').slice(0, 64), createdAt: now(), ...origin };
      return { project: await save(p) };
    }),
  };
}

// HTTP routes. Returns undefined when the path is not a director route.
// Short human summary of agent edits for the activity log.
export function summarizeOps(ops, project) {
  const name = id => project.scene.entities.find(e => e.id === id || e.name === id)?.name || id;
  const shot = id => { const s = project.shots.find(x => x.id === id) || (/^\d+$/.test(String(id)) ? project.shots[Number(id) - 1] : null); return s ? `“${s.title}”` : 'a shot'; };
  const out = [];
  for (const o of ops || []) {
    if (o.op === 'add_entity') out.push(`Added ${o.entity?.name || o.entity?.shape || 'an object'}`);
    else if (o.op === 'update_entity') out.push(`Updated ${name(o.id)}${o.patch?.path !== undefined ? ' (animation)' : ''}`);
    else if (o.op === 'remove_entity') out.push(`Removed ${name(o.id)}`);
    else if (o.op === 'add_shot') out.push(`Added shot “${o.shot?.title || 'new shot'}”`);
    else if (o.op === 'update_shot') out.push(`Updated shot ${shot(o.id)}`);
    else if (o.op === 'remove_shot') out.push(`Removed shot ${shot(o.id)}`);
    else if (o.op === 'set_keyframes') out.push(`Keyframed ${name(o.id)} (${(o.keys || []).length} keys)`);
    else if (o.op === 'remove_keyframes') out.push(`Removed keyframes on ${name(o.id)}`);
    else if (o.op === 'clear_animation') out.push(`Cleared animation on ${name(o.id)}`);
    else if (o.op === 'set_scene') out.push('Updated the scene setting');
    else if (o.op === 'update_reference') out.push('Linked a reference');
  }
  const counts = new Map(); for (const s of out) counts.set(s, (counts.get(s) || 0) + 1);
  const lines = [...counts].map(([s, n]) => (n > 1 ? `${s} ×${n}` : s));
  return lines.length > 4 ? `${lines.slice(0, 3).join(' · ')} · +${lines.length - 3} more edits` : lines.join(' · ');
}

export function directorRoutes(director, previs, connect = () => null, runner = () => null) {
  return async function route(method, url, input, meta = {}) {
    const path = url.pathname;
    if (!path.startsWith('/api/director/')) return undefined;
    if (method === 'GET') {
      if (path === '/api/director/projects') return { projects: await director.list(), archived: (await director.archived()).length, agent: director.agentStatus(), connect: connect() };
      if (path === '/api/director/archived') return { projects: await director.archived() };
      if (path === '/api/director/starters') return { starters: await director.starters() };
      if (path === '/api/director/assets') { const { project: p } = await director.syncResults(url.searchParams.get('id')); return { assets: p.assets || [], shots: p.shots.map((s, i) => ({ id: s.id, number: i + 1, title: s.title })) }; }
      if (path === '/api/director/agent') return { agent: director.agentStatus(), connect: connect() };
      if (path === '/api/director/project') {
        await director.syncResults(url.searchParams.get('id'));
        const p = await director.get(url.searchParams.get('id'));
        const since = Number(url.searchParams.get('since'));
        return since === p.revision ? { unchanged: true, revision: p.revision, agent: director.agentStatus() } : { project: p, agent: director.agentStatus() };
      }
      fail('Unknown director route', 404);
    }
    switch (path) {
      case '/api/director/list': return { projects: await director.list(), agent: director.agentStatus() };
      case '/api/director/projects': return { project: await director.create(input) };
      case '/api/director/video-refs': {
        // Register the looks of everything a shot's camera sees (plus environment, style and key frame)
        // as images on the shot's render in the workflow engine, so a video workflow can bind them.
        const p = await director.get(input.projectId), s = p.shots.find(x => x.id === input.shotId);
        if (!s) fail('Unknown shot');
        const max = Math.max(0, Math.min(9, Math.floor(Number(input.max) || 0)));
        const engineShot = previs.get().shots.find(x => x.id === input.previsShotId);
        if (!engineShot || engineShot.browser?.director?.shotId !== s.id) fail('Render this shot’s blockout first');
        const references = [];
        // First-frame workflows take one image: the shot's newest key frame.
        const { start: startFrame, end: endFrame } = keyStills(s);
        // keyFrames: [start, end?] for first/last-frame workflows. `stills`: blockout-driven models get the start/end stills first, as the look.
        const picks = input.firstFrame ? [startFrame && { ref: startFrame, entityId: null, role: 'frame', label: 'start key frame' }, input.lastFrame && endFrame && { ref: endFrame, entityId: null, role: 'frame', label: 'end key frame' }].filter(Boolean) : videoReferences(p, s, max, { stills: input.stills === true });
        for (const x of picks) {
          const file = await director.refFile(p.id, x.ref.file);
          const bytes = await readFile(file), sha256 = createHash('sha256').update(bytes).digest('hex');
          const same = r => r.shotId === engineShot.id && r.directorRef?.sha256 === sha256;
          let render = previs.get().renders.find(same);
          if (!render) {
            // Check and insert inside the engine write queue: concurrent registrations, result attachment and binds
            // never race on the revision ("Project changed"), and two callers never register the same image twice.
            await previs.append(async q => {
              render = q.renders.find(same); if (render) return false;
              const image = await previs.image(await imageToPng(file));
              render = { id: image.id, shotId: engineShot.id, source: 'director-ref', pass: 'reference', width: image.width, height: image.height, binding: structuredClone(engineShot.binding), directorRef: { projectId: p.id, referenceId: x.ref.id, sha256 }, createdAt: new Date().toISOString() };
              q.renders.push(render);
            });
          }
          references.push({ renderId: render.id, referenceId: x.ref.id, entityId: x.entityId, role: x.role, label: x.label, name: x.ref.name, file: x.ref.file });
        }
        return { references, revision: previs.get().revision };
      }
      case '/api/director/get': { const p = await director.get(input.projectId); return { project: p, prompts: Object.fromEntries(p.shots.map(s => [s.id, compilePrompt(p, s)])) }; }
      case '/api/director/edit': {
        const r = await director.edit(input.projectId, input.ops);
        if (meta.agent) { const text = summarizeOps(input.ops, r.project); if (text) { const pr = await director.progress(input.projectId, { text, auto: true }); if (pr.logged) r.project = pr.project; } }
        return r;
      }
      case '/api/director/agent/progress': return director.progress(input.projectId, input);
      // [agent] Built-in runner tools (scoped to one message) and the browser's proposal decisions.
      case '/api/director/agent/scene': { const { project: p, pending, shotId } = await director.preview(input.projectId, input.messageId); return sceneView(p, shotId, pending); }
      case '/api/director/agent/prompt': {
        const { project: p } = await director.preview(input.projectId, input.messageId);
        const s = p.shots.find(x => x.id === input.shot) || p.shots.find(x => handleOf(x.title) === handleOf(String(input.shot || ''))) || p.shots[Number(input.shot) - 1]; if (!s) fail(`Unknown shot ${input.shot}`);
        const kind = input.kind === 'image' ? 'image' : 'video';
        return { shot: p.shots.indexOf(s) + 1, kind, auto: autoPromptText(p, s, kind), current: shotPrompt(p, s, kind), edited: !!(s.prompts?.[kind]?.edited) };
      }
      case '/api/director/agent/propose': return director.propose(input.projectId, input.messageId, input.ops);
      case '/api/director/agent/suggest': return director.suggest(input.projectId, input.messageId, input);
      case '/api/director/agent/proposal': return director.proposal(input.projectId, input.messageId, input.action);
      case '/api/director/agent/stop': {
        const r = runner()?.stop(input.projectId) ?? { stopped: false };
        // No live run (e.g. the server restarted mid-turn): close the stale message so the thread never sticks on “Thinking”.
        if (!r.stopped && input.messageId) { const p = await director.get(input.projectId); const m = p.messages.find(x => x.id === input.messageId && x.role === 'user' && x.status === 'claimed'); if (m) return director.reply(input.projectId, { messageId: m.id, text: 'Stopped.', via: 'runner', error: true }); }
        return r;
      }
      case '/api/director/agent/reset': return runner()?.reset(input.projectId) ?? { reset: false };
      case '/api/director/animate': {
        const ops = (Array.isArray(input.animations) ? input.animations : [input]).map(a => a.clear ? { op: 'clear_animation', id: a.object } : Array.isArray(a.removeTimes) ? { op: 'remove_keyframes', id: a.object, times: a.removeTimes } : { op: 'set_keyframes', id: a.object, keys: a.keys, mode: a.mode });
        const r = await director.edit(input.projectId, ops);
        if (meta.agent) { const text = summarizeOps(ops, r.project); if (text) { const pr = await director.progress(input.projectId, { text, auto: true }); if (pr.logged) r.project = pr.project; } }
        return r;
      }
      case '/api/director/message': return director.message(input.projectId, input);
      case '/api/director/message/builtin': return director.builtin(input.projectId, input.messageId);
      case '/api/director/reference': { const { generated, ...rest } = input; return director.reference(input.projectId, rest); }
      case '/api/director/agent/wait': return director.wait(input.projectId || null, input.timeoutSeconds, input.agentName);
      case '/api/director/agent/reply': return director.reply(input.projectId, input);
      case '/api/director/render': return director.recordRender(input.projectId, input, previs);
      case '/api/director/duplicate': return director.duplicate(input.projectId);
      case '/api/director/edit-export': return director.exportEdit(input.projectId);
      case '/api/director/archive': return director.archive(input.projectId);
      case '/api/director/restore': return director.restore(input.projectId);
      default: fail('Unknown director route', 404);
    }
  };
}
