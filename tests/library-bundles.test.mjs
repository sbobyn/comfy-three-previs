import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { crc32, deflateRawSync } from 'node:zlib';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDirector } from '../server/previs/director.mjs';
import { ENTRY, LIMITS, contentHash } from '../server/previs/library.mjs';
import { readZip, writeZip } from '../server/previs/zip.mjs';
import { castCard } from '../shared/director.mjs';

// The asset library, phase 2: <handle>.previs-asset.zip export and import (zip, folder, one object of a project
// export), with the design's size caps, file allowlist, field-allowlist manifest and no paths or secrets in bundles.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');
const png = n => Buffer.concat([PNG, Buffer.from(`variant ${n}`)]);
const sha = b => createHash('sha256').update(b).digest('hex');
const CAR = 'c0000000-0000-4000-8000-000000000001', REQUEST = 'feed0000-0000-4000-8000-00000000beef';
const MiB = 1024 ** 2;

const withDir = async fn => { const root = await realpath(await mkdtemp(join(tmpdir(), 'previs-bundles-'))); try { return await fn(root); } finally { await rm(root, { recursive: true, force: true }); } };

/** A project with a red racecar: generated look (with job ids that must not travel) and a 2-view sheet. */
async function racecar(director) {
  const p = await director.create({ template: 'empty', title: 'Final Lap' });
  await director.edit(p.id, [{ op: 'add_entity', entity: { id: CAR, name: 'Red Racecar', shape: 'car', kind: 'vehicle', position: [4, 0, -2], color: '#d9534f', notes: 'a low red single-seater with gold wheels' } }]);
  const look = (await director.reference(p.id, { scope: 'object', entityId: CAR, name: 'look', data: png(0).toString('base64'), generated: { requestId: REQUEST, outputKey: 'out-1', presetId: 'flux-3', model: 'FLUX 3 Image', seed: 3, prompt: 'red car', backend: 'cloud:https://cloud.comfy.org', promptId: 'prompt-123' } })).referenceId;
  const views = [];
  for (const n of [1, 2]) views.push((await director.reference(p.id, { scope: 'object', entityId: CAR, name: `view ${n}`, data: png(n).toString('base64') })).referenceId);
  const slot = (sid, i) => ({ id: sid, label: sid, spec: { framing: 'whole', angle: sid }, attempts: [{ id: `a${i}`, requestId: REQUEST, referenceId: views[i], mode: 'generate', note: '', from: null, presetId: 'flux-3', seed: i, error: '', createdAt: '2026-10-31T10:00:00.000Z' }], selected: `a${i}`, accepted: `a${i}` });
  await director.edit(p.id, [{ op: 'update_entity', id: CAR, patch: { sheets: [{ id: 'sh1', setId: 'obj-turn4', label: 'Turnaround', options: {}, presetId: 'flux-3', createdAt: '2026-10-31T10:00:00.000Z', slots: [slot('front', 0), slot('back', 1)] }] } }, { op: 'set_look', entityId: CAR, referenceId: look }]);
  return { p: await director.get(p.id), look, views };
}

/** Zip entries as a Map, edited by fn(manifest, files), re-zipped; `rehash` keeps the content hash consistent. */
function tamper(zip, fn, { rehash = true } = {}) {
  const files = readZip(zip), m = JSON.parse(files.get('asset.json').toString('utf8'));
  fn(m, files);
  if (rehash) m.contentHash = contentHash(m);
  files.set('asset.json', Buffer.from(JSON.stringify(m)));
  return writeZip([...files].map(([name, data]) => ({ name, data })));
}
/** A ZIP whose entries are deflated (writeZip only stores), to test the decompressed-size cap. */
function deflatedZip(entries) {
  const locals = [], centrals = []; let offset = 0;
  for (const { name, data } of entries) {
    const n = Buffer.from(name), z = deflateRawSync(data), crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(z.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(z.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, n, z); centrals.push(central, n); offset += 30 + n.length + z.length;
  }
  const dir = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

test('round trip: save → export → import into another install → place keeps the Cast Card, look and sheet', async () => {
  await withDir(async root => {
    const a = await openDirector(join(root, 'a')), b = await openDirector(join(root, 'b'));
    const { p, look, views } = await racecar(a);
    const saved = (await a.library.save(p.id, { object: 'Red Racecar', tags: ['car'] })).asset;
    const { filename, data } = await a.library.exportZip('@red-racecar');
    assert.equal(filename, 'red-racecar.previs-asset.zip');
    const files = readZip(data);
    assert.deepEqual([...files.keys()].sort(), ['asset.json', ...[look, ...views].map(id => `refs/${id}.png`)].sort());
    for (const name of files.keys()) assert.match(name, ENTRY);
    // Nothing local or job-specific travels: no data dir, request, prompt or output ids, no backend.
    const text = files.get('asset.json').toString('utf8');
    for (const secret of [root, REQUEST, 'out-1', 'prompt-123', 'cloud:https', p.messages[0].id]) assert.ok(!text.includes(secret), secret);
    (function walk(v) { if (typeof v === 'string') assert.doesNotMatch(v, /^\/|^[A-Za-z]:[\\/]|^~/); else if (v && typeof v === 'object') Object.values(v).forEach(walk); })(JSON.parse(text));

    const first = await b.library.importZip(data);
    assert.equal(first.action, 'added'); assert.equal(first.text, 'Added @red-racecar to your library');
    assert.equal(first.asset.id, saved.id); assert.equal(first.asset.contentHash, saved.contentHash); assert.equal(first.asset.version, 1);
    const again = await b.library.importZip(data);
    assert.equal(again.action, 'unchanged', 'same id and content is a no-op');

    const q0 = await b.create({ template: 'street', title: 'Night race' });
    const placed = await b.library.place(q0.id, { asset: 'red racecar', position: [0, 0, 6], shot: '1' });
    const car = placed.project.scene.entities.find(e => e.id === placed.root);
    assert.equal(castCard(placed.project, car.id).description, castCard(p, CAR).description);
    const lookRef = placed.project.scene.references.find(r => r.id === car.look);
    assert.equal(sha(await readFile(join(root, 'b', 'director', q0.id, 'refs', lookRef.file))), sha(png(0)));
    assert.deepEqual(car.sheets[0].slots.map(s => placed.project.scene.references.some(r => r.id === s.attempts[0].referenceId && r.entityId === car.id)), [true, true]);
    assert.ok(placed.project.shots[0].cast.include.includes(car.id));

    // New content under the same id is the next version on the other install.
    await a.edit(p.id, [{ op: 'update_entity', id: CAR, patch: { styleNotes: 'glossy' } }]);
    await a.library.save(p.id, { object: CAR });
    const v2 = await b.library.importZip((await a.library.exportZip(saved.id)).data);
    assert.equal(v2.action, 'updated'); assert.equal(v2.asset.version, 2); assert.equal(v2.asset.supersedes, saved.contentHash);
    assert.ok(existsSync(join(root, 'b', 'library', 'assets', saved.id, 'versions', '1.json')));
  });
});

test('imports refuse files outside the allowlist, undeclared or changed files and manifests outside the field allowlist', async () => {
  await withDir(async root => {
    const a = await openDirector(join(root, 'a')), b = await openDirector(join(root, 'b'));
    const { p, look } = await racecar(a);
    await a.library.save(p.id, { object: CAR });
    const { data } = await a.library.exportZip('red-racecar');
    const lookPath = `refs/${look}.png`, stray = 'refs/00000000-0000-4000-8000-000000000000.png';
    const cases = [
      ['a file outside the allowlist', tamper(data, (m, f) => f.set('notes.txt', Buffer.from('hi'))), /Unexpected file in asset bundle: notes\.txt/],
      ['a script under refs/', tamper(data, (m, f) => f.set('refs/00000000-0000-4000-8000-000000000000.svg', Buffer.from('<svg/>'))), /Unexpected file in asset bundle: refs\/0+-0000-4000-8000-0+\.svg/],
      ['a nested folder', tamper(data, (m, f) => f.set('refs/x/a.png', PNG)), /Unexpected file/],
      ['an undeclared image', tamper(data, (m, f) => f.set(stray, PNG)), /Undeclared file in asset bundle/],
      ['a missing image', tamper(data, (m, f) => f.delete(lookPath)), /incomplete: refs\/.*is missing/],
      ['a changed image', tamper(data, (m, f) => f.set(lookPath, png(7))), /Asset file changed/],
      ['an SVG named .png', tamper(data, (m, f) => { const svg = Buffer.from('<svg onload="x"/>'); f.set(lookPath, svg); Object.assign(m.media.find(x => x.path === lookPath), { size: svg.length, sha256: sha(svg) }); }), /not the PNG, JPEG or WebP image/],
      ['an extra top-level field', tamper(data, m => { m.messages = ['hi']; }), /field outside the asset format.*: messages/],
      ['a job id on a look', tamper(data, m => { m.references[0].generated.requestId = REQUEST; }), /references\[0\]\.generated\.requestId/],
      ['an animation path', tamper(data, m => { m.entities[0].path = [{ t: 0, p: [0, 0, 0] }]; }), /entities\[0\]\.path/],
      ['a refgen job', tamper(data, m => { m.refgen = {}; }), /: refgen/],
      ['an absolute path in a note', tamper(data, m => { m.entities[0].notes = '/home/me/film/car.blend'; }), /must not contain local paths \(entities\[0\]\.notes/],
      ['a Windows path', tamper(data, m => { m.description = 'C:\\Users\\me\\car'; }), /must not contain local paths \(description/],
      ['a home path', tamper(data, m => { m.origin.projectTitle = '~/films/final-lap'; }), /must not contain local paths \(origin\.projectTitle/],
      ['a file name that escapes refs/', tamper(data, m => { m.references[0].file = '../asset.json'; }), /field outside the asset format|invalid id, file or type/],
      ['a changed manifest without a new hash', tamper(data, m => { m.entities[0].notes = 'edited'; }, { rehash: false }), /content hash does not match/],
      ['a newer format', tamper(data, m => { m.formatVersion = 3; }), /needs a newer Comfy Previs/],
      ['v2 fields in a version-1 manifest', tamper(data, m => { m.license = 'CC0-1.0'; }), /need format version 2/],
      ['a look shared from outside', tamper(data, m => { m.entities[0].lookFrom = '00000000-0000-4000-8000-000000000000'; }), /shares a look from outside the asset/],
      ['a parent outside the asset', tamper(data, m => { m.entities[0].parent = '00000000-0000-4000-8000-000000000000'; }), /must come after its parent, inside the asset/],
      ['a project export without its manifest', writeZip([{ name: 'project.json', data: Buffer.from('{}') }]), /Unexpected file in asset bundle: project\.json/],
    ];
    for (const [what, zip, error] of cases) await assert.rejects(b.library.importZip(zip), error, what);
    assert.deepEqual((await b.library.list()).assets, [], 'nothing was added');
    assert.ok(!existsSync(join(root, 'b', 'library', 'assets')) || (await readdir(join(root, 'b', 'library', 'assets'))).length === 0);
    // Unsafe archive names are refused by the zip reader before anything else.
    const evil = data.toString('latin1').replaceAll('asset.json', 'a/../.json');
    await assert.rejects(b.library.importZip(Buffer.from(evil, 'latin1')), /Unsafe archive path/);
  });
});

test('format v2: license, authors and the generator recipe travel with the asset and show on its card', async () => {
  await withDir(async root => {
    const a = await openDirector(join(root, 'a')), b = await openDirector(join(root, 'b'));
    const { p } = await racecar(a);
    await a.library.save(p.id, { object: CAR });
    const { data } = await a.library.exportZip('red-racecar');
    const recipe = { library: 'beret-parts', family: 'beret/car', version: '0.1.0', params: { length: 4.5, style: 'racer', wing: true }, seed: 7 };
    const v2 = tamper(data, m => { Object.assign(m, { formatVersion: 2, license: 'CC0-1.0', authors: ['Beret Labs'], parametric: recipe }); m.origin.source = 'parametric'; });
    const { asset } = await b.library.importZip(v2);
    assert.equal(asset.formatVersion, 2);
    const card = (await b.library.list()).assets[0];
    assert.equal(card.license, 'CC0-1.0');
    assert.deepEqual(card.authors, ['Beret Labs']);
    assert.deepEqual(card.parametric, recipe);
    assert.equal(card.origin.source, 'parametric');
    // Placing still works and records where the object came from, so an agent can find the recipe again.
    const q = await b.create({ template: 'empty', title: 'Pit lane' });
    const placed = await b.library.place(q.id, { asset: 'red-racecar' });
    const e = (await b.get(q.id)).scene.entities.find(x => x.id === placed.root);
    assert.equal(e.from.asset, asset.id);
    // Saving from a project still writes version 1, readable by older installs.
    await a.library.save(p.id, { object: CAR, replace: true });
    assert.equal((await a.library.list()).assets[0].formatVersion, 1);
    // Recipes are flat scalars; anything else, or a malformed licence, is refused.
    for (const [what, fn] of [
      ['nested params', m => { m.parametric.params.nested = { a: 1 }; }],
      ['a non-SPDX licence', m => { m.license = 'free for all!'; }],
      ['a non-string author', m => { m.authors = [42]; }],
    ]) await assert.rejects(b.library.importZip(tamper(v2, fn)), /field outside the asset format/, what);
  });
});

test('size caps: 64 MB zip, 32 entries, 96 MB unzipped, 10 MB per image, 50 objects', async () => {
  await withDir(async root => {
    const a = await openDirector(join(root, 'a')), b = await openDirector(join(root, 'b'));
    const { p, look } = await racecar(a);
    await a.library.save(p.id, { object: CAR });
    const { data } = await a.library.exportZip('red-racecar');
    await assert.rejects(b.library.importZip(Buffer.alloc(LIMITS.zipBytes + 1)), e => e.status === 413 && /at most 64 MB/.test(e.message));
    const many = Array.from({ length: 33 }, (_, i) => ({ name: `refs/00000000-0000-4000-8000-${String(i).padStart(12, '0')}.png`, data: PNG }));
    await assert.rejects(b.library.importZip(writeZip(many)), /Archive directory is invalid or too large/);
    const bomb = deflatedZip([{ name: 'refs/00000000-0000-4000-8000-000000000000.png', data: Buffer.alloc(97 * MiB) }]);
    assert.ok(bomb.length < MiB, 'the bomb itself is small');
    await assert.rejects(b.library.importZip(bomb), /Archive content is too large/);
    const big = Buffer.concat([PNG, Buffer.alloc(LIMITS.imageBytes + 1 - PNG.length)]);
    await assert.rejects(b.library.importZip(tamper(data, (m, f) => { f.set(`refs/${look}.png`, big); Object.assign(m.media.find(x => x.path === `refs/${look}.png`), { size: big.length, sha256: sha(big) }); })), /is over 10 MB/);
    const crowd = tamper(data, m => { for (let i = 0; i < 50; i++) m.entities.push({ ...m.entities[0], id: `e0000000-0000-4000-8000-${String(i).padStart(12, '0')}`, parent: m.entities[0].id, look: null, sheets: undefined }); m.entities.forEach(e => { if (!e.sheets) delete e.sheets; }); });
    await assert.rejects(b.library.importZip(crowd), /at most 50 objects \(this one has 51\)/);
  });
});

test('import from a path: absolute and real only, folders read only declared files, no symlinks', async () => {
  await withDir(async root => {
    const a = await openDirector(join(root, 'a')), b = await openDirector(join(root, 'b'));
    const { p, look } = await racecar(a);
    const { asset } = await a.library.save(p.id, { object: CAR });
    const zipPath = join(root, 'red-racecar.previs-asset.zip');
    await writeFile(zipPath, (await a.library.exportZip(asset.id)).data);
    await assert.rejects(b.library.importPath({ path: 'red-racecar.previs-asset.zip' }), /absolute path/);
    await mkdir(join(root, 'x'));
    await assert.rejects(b.library.importPath({ path: `${root}/x/../red-racecar.previs-asset.zip` }), /real path/);
    await symlink(zipPath, join(root, 'link.zip'));
    await assert.rejects(b.library.importPath({ path: join(root, 'link.zip') }), /real path/);
    await assert.rejects(b.library.importPath({ path: join(root, 'missing.zip') }), e => e.status === 404);
    await writeFile(join(root, 'notes.zip'), 'not a zip');
    await assert.rejects(b.library.importPath({ path: join(root, 'notes.zip') }), /Not a Comfy Previs asset bundle/);

    // A folder: the library's own asset folder (with versions/ and a stray file beside it) imports; strays are never read.
    const folder = join(root, 'a', 'library', 'assets', asset.id);
    await writeFile(join(folder, 'README.txt'), 'never read');
    const added = await b.library.importPath({ path: folder });
    assert.equal(added.action, 'added'); assert.equal(added.asset.id, asset.id);
    assert.ok(!existsSync(join(root, 'b', 'library', 'assets', asset.id, 'README.txt')));
    await assert.rejects(b.library.importPath({ path: folder + '/' }), /real path/);
    // A symlinked image inside a folder is refused.
    const copy = join(root, 'copy');
    await mkdir(join(copy, 'refs'), { recursive: true });
    await writeFile(join(copy, 'asset.json'), await readFile(join(folder, 'asset.json')));
    for (const n of await readdir(join(folder, 'refs'))) if (n !== `${look}.png`) await writeFile(join(copy, 'refs', n), await readFile(join(folder, 'refs', n)));
    await symlink(join(folder, 'refs', `${look}.png`), join(copy, 'refs', `${look}.png`));
    await assert.rejects(b.library.importPath({ path: copy }), /is a symlink/);
    await assert.rejects(b.library.importPath({ path: root }), /no asset\.json/);
  });
});

test('one object out of a .previs.zip project export, without importing the project', async () => {
  await withDir(async root => {
    const a = await openDirector(join(root, 'a')), b = await openDirector(join(root, 'b'));
    const { p } = await racecar(a);
    const file = join(root, 'Final-Lap.previs.zip');
    await writeFile(file, (await a.exportZip(p.id)).data);
    await assert.rejects(b.library.importPath({ path: file }), /whole project export \(“Final Lap”\); name the object/);
    await assert.rejects(b.library.importPath({ path: file, object: 'Blue car' }), /No object called “Blue car” in that project; it has Red Racecar/);
    const r = await b.library.importPath({ path: file, object: '@red-racecar' });
    assert.equal(r.action, 'added'); assert.match(r.text, /^Saved @red-racecar v1 with 1 look and a 2-view sheet$/);
    const m = await b.library.get('red-racecar');
    assert.equal(m.origin.source, 'project-export'); assert.equal(m.origin.projectId, p.id);
    assert.equal(m.references.length, 3);
    assert.deepEqual(await b.list(), [], 'the project itself was not imported');
    const tampered = readZip(await readFile(file)); tampered.set('project.json', Buffer.from('{"version":1}'));
    await writeFile(file, writeZip([...tampered].map(([name, data]) => ({ name, data }))));
    await assert.rejects(b.library.importPath({ path: file, object: 'Red Racecar' }), /Export is incomplete or changed: project\.json/);
  });
});

test('HTTP: export route, raw zip import, the home page drop sniffs asset bundles; MCP export and import', async () => {
  await withDir(async dir => {
    const port = 15298, base = `http://127.0.0.1:${port}`;
    const server = spawn(process.execPath, ['server/previs/server.mjs'], { env: { ...process.env, PORT: String(port), PREVIS_DATA_DIR: join(dir, 'data'), PREVIS_AGENT: 'off', PREVIS_LIBRARY_DIR: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => { server.stdout.on('data', d => { if (String(d).includes('Comfy Previs:')) resolve(); }); server.once('exit', c => reject(Error('server exited ' + c))); });
    const agent = spawn(process.execPath, ['server/previs/agent.mjs'], { env: { ...process.env, PREVIS_URL: base, PREVIS_MCP_LEGACY: '' }, stdio: ['pipe', 'pipe', 'ignore'] });
    const pending = new Map(); let n = 0;
    createInterface({ input: agent.stdout }).on('line', l => { const m = JSON.parse(l); pending.get(m.id)?.(m); });
    const rpc = (method, params) => new Promise(r => { const i = ++n; pending.set(i, r); agent.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
    const call = async (name, args) => { const m = await rpc('tools/call', { name, arguments: args }); return { error: m.result.isError, out: m.result.isError ? m.result.content[0].text : JSON.parse(m.result.content[0].text) }; };
    const post = async (path, body) => { const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, data: await r.json() }; };
    const upload = async (path, zip) => { const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: zip }); return { status: r.status, data: await r.json() }; };
    try {
      const { data: { project: lap } } = await post('/api/director/projects', { template: 'final-lap', title: 'Final Lap' });
      assert.equal((await post('/api/director/library/save', { projectId: lap.id, object: 'Comfy car' })).status, 200);
      const exported = await fetch(`${base}/api/director/library/export?id=${encodeURIComponent('@comfy-car')}`);
      assert.equal(exported.status, 200); assert.equal(exported.headers.get('content-type'), 'application/zip');
      assert.equal(exported.headers.get('content-disposition'), 'attachment; filename="comfy-car.previs-asset.zip"');
      const zip = Buffer.from(await exported.arrayBuffer());
      assert.ok(zip.length < LIMITS.zipBytes);
      assert.equal((await fetch(`${base}/api/director/library/export?id=nothing`)).status, 404);

      // The home page drop target: an asset bundle goes to the library, a project export still makes a project.
      const dropped = await upload('/api/director/import', zip);
      assert.equal(dropped.status, 200); assert.equal(dropped.data.kind, 'asset'); assert.equal(dropped.data.action, 'unchanged');
      const projectZip = Buffer.from(await (await fetch(`${base}/api/director/export?id=${lap.id}`)).arrayBuffer());
      const imported = await upload('/api/director/import', projectZip);
      assert.equal(imported.status, 200); assert.ok(imported.data.project?.id); assert.equal(imported.data.kind, undefined);
      assert.equal((await upload('/api/director/library/import-zip', zip)).data.action, 'unchanged');
      assert.equal((await upload('/api/director/library/import-zip', Buffer.from('nope'))).status, 400);
      assert.equal((await fetch(`${base}/api/director/library/import-zip`, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: Buffer.alloc(LIMITS.zipBytes + 1) })).status, 413);

      // MCP: export into a folder the user names, then import it on a fresh install's library (another data dir).
      const out = join(dir, 'share'); await mkdir(out);
      assert.match((await call('previs_library_export', { asset: '@comfy-car', dir: 'share' })).out, /absolute path/);
      assert.match((await call('previs_library_export', { asset: '@comfy-car', dir: join(dir, 'nope') })).out, /No folder at/);
      const ex = await call('previs_library_export', { asset: '@comfy-car', dir: out });
      assert.equal(ex.error, false, ex.out);
      assert.equal(ex.out.path, join(out, 'comfy-car.previs-asset.zip')); assert.equal(ex.out.handle, 'comfy-car');
      assert.deepEqual(await readdir(out), ['comfy-car.previs-asset.zip']);
      assert.equal(sha(await readFile(ex.out.path)), sha(zip));
      const same = await call('previs_library_import', { path: ex.out.path });
      assert.equal(same.error, false, same.out); assert.equal(same.out.action, 'unchanged');
      const fromProject = await call('previs_library_import', { path: join(dir, 'lap.previs.zip') });
      assert.equal(fromProject.error, true); assert.match(fromProject.out, /Nothing at/);
      await writeFile(join(dir, 'lap.previs.zip'), projectZip);
      const rival = await call('previs_library_import', { path: join(dir, 'lap.previs.zip'), object: 'Rival car' });
      assert.equal(rival.error, false, rival.out); assert.equal(rival.out.action, 'added'); assert.equal(rival.out.asset.handle, 'rival-car');
      assert.deepEqual((await call('previs_library_list', {})).out.assets.map(x => x.handle).sort(), ['comfy-car', 'rival-car']);
    } finally { agent.kill(); server.kill(); await new Promise(r => server.once('exit', r)); }
  });
});
