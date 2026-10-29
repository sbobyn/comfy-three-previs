import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { openDirector } from '../server/previs/director.mjs';
import { writeZip, readZip } from '../server/previs/zip.mjs';
import { setupChecks } from '../server/previs/setup-check.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');
const sha = b => createHash('sha256').update(b).digest('hex');
const id = () => crypto.randomUUID();

test('zip round trip; unsafe paths, tampering and duplicates are refused', () => {
  const files = [{ name: 'a.json', data: Buffer.from('{"x":1}') }, { name: 'refs/b.png', data: PNG }];
  const out = readZip(writeZip(files));
  assert.deepEqual([...out.keys()], ['a.json', 'refs/b.png']);
  assert.ok(out.get('refs/b.png').equals(PNG));
  for (const bad of ['../evil', '/abs', 'a/../b', 'a\\b']) assert.throws(() => writeZip([{ name: bad, data: PNG }]), /Unsafe/);
  const zip = writeZip(files); zip[zip.indexOf(PNG) + 20] ^= 0xff;
  assert.throws(() => readZip(zip), /Checksum/);
  assert.throws(() => readZip(writeZip([{ name: 'a', data: PNG }, { name: 'a', data: PNG }])), /Duplicate/);
  assert.throws(() => readZip(Buffer.from('not a zip')), /Not a ZIP/);
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'previs-files-'));
  const jobs = [];
  const director = await openDirector(root, { engineJobs: () => jobs });
  const project = await director.create({ template: 'street', title: 'Files' });
  // A camera render in the shared engine, recorded on shot 1.
  const video = Buffer.from('fake-mp4-bytes'), assetId = id(), engineShotId = id();
  await mkdir(join(root, 'assets'), { recursive: true }); await writeFile(join(root, 'assets', assetId + '.mp4'), video);
  const previs = { get: () => ({ assets: [{ id: assetId, shotId: engineShotId, kind: 'video', sha256: sha(video), width: 1280, height: 720, fps: 24, frameCount: 72, duration: 3 }] }) };
  await director.recordRender(project.id, { shotId: project.shots[0].id, previsShotId: engineShotId, assetId, prompt: 'p', signature: 's' }, previs);
  await director.reference(project.id, { scope: 'object', entityId: 'Runner', name: 'look.png', data: PNG.toString('base64') });
  return { root, jobs, director, project, assetId, engineShotId, video };
}

test('renders and workflow results are copied into the project folder', async () => {
  const { root, jobs, director, project, assetId, engineShotId } = await fixture();
  let p = await director.get(project.id);
  assert.equal(p.assets.length, 1); assert.equal(p.assets[0].kind, 'camera-render');
  assert.deepEqual(await readdir(join(root, 'director', project.id, 'assets')), [assetId + '.mp4']);
  const out = Buffer.from('result-mp4'), resultId = id();
  await writeFile(join(root, 'assets', resultId + '.mp4'), out);
  jobs.push({ id: id(), shotId: engineShotId, definition: { title: 'Kling O1' }, backend: { kind: 'cloud' }, binding: { prompt: 'glass' }, quote: { status: 'unknown', amount: null, currency: 'USD' }, results: [{ id: resultId, filename: resultId + '.mp4', kind: 'video', mime: 'video/mp4', sha256: sha(out), width: 1280, height: 720, fps: 24, frameCount: 73, duration: 3.04 }] });
  jobs.push({ id: id(), shotId: id(), results: [{ id: id(), filename: 'x.mp4', mime: 'video/mp4' }] });
  assert.equal((await director.syncResults(project.id)).added, 1);
  assert.equal((await director.syncResults(project.id)).added, 0, 'sync is idempotent');
  p = await director.get(project.id);
  const result = p.assets.find(a => a.kind === 'workflow-result');
  assert.equal(result.shotId, p.shots[0].id); assert.equal(result.source.workflow, 'Kling O1'); assert.equal(result.frameCount, 73);
});

test('projects survive restart, export/import, duplicate and archive/restore', async () => {
  const { root, director, project, video } = await fixture();
  const reopened = await openDirector(root);
  const again = await reopened.get(project.id);
  assert.equal(again.title, 'Files'); assert.equal(again.scene.references.length, 1);
  const { filename, data } = await reopened.exportZip(project.id);
  assert.equal(filename, 'Files.previs.zip');
  const other = await openDirector(await mkdtemp(join(tmpdir(), 'previs-import-')));
  const { project: imported } = await other.importZip(data);
  assert.notEqual(imported.id, project.id); assert.match(imported.title, /\(imported\)$/);
  assert.equal(imported.shots[0].render, null, 'imported renders need re-rendering before workflow hand-off');
  assert.equal(imported.assets[0].imported, true);
  assert.ok((await readFile(await other.assetFile(imported.id, imported.assets[0].file.slice(7)))).equals(video));
  assert.ok((await readFile(await other.refFile(imported.id, imported.scene.references[0].file))).equals(PNG));
  const files = readZip(data); files.set('refs/extra.png', PNG);
  await assert.rejects(other.importZip(writeZip([...files].map(([name, d]) => ({ name, data: d })))), /Unexpected file|Unsafe/);
  const tampered = readZip(data); const ref = [...tampered.keys()].find(k => k.startsWith('refs/')); tampered.set(ref, Buffer.from('x'));
  await assert.rejects(other.importZip(writeZip([...tampered].map(([name, d]) => ({ name, data: d })))), /incomplete or changed/);
  const { project: copy } = await director.duplicate(project.id);
  assert.equal(copy.title, 'Copy of Files'); assert.equal((await readdir(join(root, 'director', copy.id, 'refs'))).length, 1);
  await director.archive(project.id);
  assert.ok(!(await director.list()).some(p => p.id === project.id));
  assert.equal((await director.archived())[0].id, project.id);
  await director.restore(project.id);
  assert.ok((await director.list()).some(p => p.id === project.id));
});

test('setup checks report presence only, never key values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'previs-setup-'));
  const r = await setupChecks({ root, data: join(root, 'data'), env: { COMFY_CLOUD_API_KEY: 'sk-secret-value', PREVIS_COMFY_URL: 'http://127.0.0.1:9' }, fetcher: async () => { throw Error('down'); } });
  assert.equal(r.checks.find(c => c.id === 'build').status, 'required');
  assert.equal(r.checks.find(c => c.id === 'cloud').status, 'ok');
  assert.equal(r.checks.find(c => c.id === 'local').status, 'optional');
  assert.ok(!JSON.stringify(r).includes('sk-secret-value'));
  assert.equal(r.ready, false);
});
