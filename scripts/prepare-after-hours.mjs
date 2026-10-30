// Explicit operator command: creates one fresh demo through the running app API.
// Never edits a pre-existing project, captures, uploads to a provider, or generates.
import { mkdir, writeFile, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { afterHoursSpec } from '../examples/after-hours/scene.mjs';

const destination = resolve(process.argv[2] || '.evidence/comfy-after-hours/project.json');
try { await access(destination); throw Error(`A checkpoint already exists at ${destination}; open that project instead of creating duplicates.`); }
catch (e) { if (e.code !== 'ENOENT') throw e; }
const url = process.env.PREVIS_URL || 'http://127.0.0.1:5230';
async function api(path, body) {
  const r = await fetch(url + '/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json(); if (!r.ok) throw Error(data.error || `HTTP ${r.status}`); return data;
}
await mkdir(dirname(destination), { recursive: true });
const spec = afterHoursSpec();
const { project } = await api('director/projects', { title: spec.title, template: 'empty' });
const record = { projectId: project.id, shotId: project.shots[0].id, leads: spec.leads, url: `${url}/director.html?project=${project.id}`, createdAt: new Date().toISOString(), status: 'created-not-configured', paidExecution: 'not-authorized' };
await writeFile(destination, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
const { project: saved } = await api('director/edit', { projectId: project.id, ops: [
  { op: 'set_scene', patch: spec.scene },
  ...spec.entities.map(entity => ({ op: 'add_entity', entity })),
  { op: 'update_shot', id: record.shotId, patch: spec.shot },
] });
await writeFile(destination, JSON.stringify({ ...record, revision: saved.revision, status: 'blockout-ready' }, null, 2) + '\n');
console.log(JSON.stringify({ url: record.url, projectId: project.id, shotId: record.shotId, entities: saved.scene.entities.length, revision: saved.revision, checkpoint: destination }));
