import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function openProject(root) {
  await mkdir(join(root, 'renders'), { recursive: true });
  const file = join(root, 'project.json');
  let project;
  try { project = JSON.parse(await readFile(file, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; project = { version: 1, id: randomUUID(), revision: 0, title: 'My previs project', scenes: [], shots: [], references: [], renders: [], workflowBindings: [] }; }
  if (project.version !== 1) throw Error('Unsupported project version');
  async function save(next) { await writeFile(file + '.tmp', JSON.stringify(next, null, 2)); await rename(file + '.tmp', file); project = next; return structuredClone(project); }
  if (!project.revision) await save({ ...project, revision: 1 });
  let chain = Promise.resolve();
  return {
    get: () => structuredClone(project),
    mutate(revision, fn) {
      const task = chain.then(async () => {
        if (revision !== project.revision) { const e = Error('Project changed. Refresh before editing.'); e.status = 409; throw e; }
        const next = structuredClone(project); await fn(next); next.revision++; return save(next);
      });
      chain = task.catch(() => {}); return task;
    },
    async image(bytes) {
      if (bytes.length < 24 || bytes.length > 32 * 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw Error('Expected a PNG under 32 MB');
      const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
      if (!width || !height || width * height > 16000000) throw Error('Unsupported PNG dimensions');
      const id = randomUUID(); await writeFile(join(root, 'renders', id + '.png'), bytes, { flag: 'wx' }); return { id, width, height };
    },
  };
}
export function validateBinding(input, catalog) {
  const scene = catalog?.scenes.find(s => s.name === input.scene);
  if (!scene || !scene.cameras.includes(input.camera)) throw Error('Refresh Blender and choose an existing scene and camera');
  for (const key of ['frame', 'start', 'end']) if (!Number.isInteger(input[key]) || input[key] < scene.start || input[key] > scene.end) throw Error('Frames must be integers within the Blender scene range');
  if (input.start > input.end || input.frame < input.start || input.frame > input.end) throw Error('Preview frame must be within the shot range');
  if (!catalog.file) throw Error('Save the Blender file before binding a persistent shot');
  return { source: 'blender', file: catalog.file, scene: scene.name, camera: input.camera, fps: scene.fps, frame: input.frame, start: input.start, end: input.end };
}

export function validateBrowser(input) {
  const vector = (v, n) => Array.isArray(v) && v.length === n && v.every(x => Number.isFinite(x) && Math.abs(x) < 100000);
  const frame = f => f && Number.isFinite(f.t) && f.t >= 0 && f.t <= 61 && vector(f.p, 3) && vector(f.q, 4) && Math.abs(Math.hypot(...f.q) - 1) < 0.01 && Number.isFinite(f.mm) && f.mm >= 1 && f.mm <= 2000;
  if (!vector(input.subject, 3) || !frame(input.camera) || !Array.isArray(input.frames) || input.frames.length > 1500 || !input.frames.every((f, i) => frame(f) && (!i || f.t > input.frames[i - 1].t))) throw Error('Invalid browser camera recording');
  return { subject: input.subject, camera: input.camera, frames: input.frames, sceneVersion: 1 };
}
