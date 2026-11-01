import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, cp, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadStarters, starterSnapshot, starterSourceProject, starterSourceId, STARTERS_DIR } from '../server/previs/starters.mjs';
import { shotSignature } from '../shared/director.mjs';
import { exportStarters, SOURCES } from '../scripts/export-starters.mjs';
import { importStarters, liveServer } from '../scripts/import-starters.mjs';

const quiet = () => {};
const withDir = async fn => { const root = await mkdtemp(join(tmpdir(), 'starters-roundtrip-')); try { return await fn(root); } finally { await rm(root, { recursive: true, force: true }); } };

test('starters:export --check against the imported bundles changes no JSON or media file', async () => {
  await withDir(async root => {
    const done = await importStarters({ dataDir: root, log: quiet });
    assert.deepEqual(done.map(d => d.slug), SOURCES.map(s => s.slug));
    for (const d of done) assert.equal(d.id, starterSourceId(d.slug));
    const { failed, diffs } = await exportStarters({ dataDir: root, check: true, log: quiet });
    assert.equal(failed, 0);
    assert.deepEqual(diffs, [], 'the bundle in examples/starters is not what its source projects export; run pnpm starters:import and pnpm starters:export --check');
  });
});

test('--check reports an edited bundle JSON, an edited, missing or stray media file, and never writes the bundle', async () => {
  await withDir(async root => {
    await importStarters({ dataDir: root, log: quiet });
    const bundle = join(root, 'bundle');
    await cp(STARTERS_DIR, bundle, { recursive: true });
    const slug = 'wingspan', dir = join(bundle, slug);
    const snap = JSON.parse(await readFile(join(dir, 'starter.json'), 'utf8'));
    // Hand-edited JSON.
    snap.shots[0].title += ' (edited)';
    writeFileSync(join(dir, 'starter.json'), JSON.stringify(snap, null, 2) + '\n');
    // One byte of a bundled image changed, one video missing, one stray file.
    const [image, video] = [snap.media.find(m => m.kind === 'image'), snap.media.find(m => m.kind === 'video')];
    const bytes = readFileSync(join(dir, image.path)); bytes[bytes.length - 1] ^= 0xff; writeFileSync(join(dir, image.path), bytes);
    await rm(join(dir, video.path));
    writeFileSync(join(dir, 'media', 'refs', '00000000-0000-0000-0000-000000000000.webp'), 'stray');
    const before = readdirSync(join(dir, 'media', 'refs')).length;

    const { diffs } = await exportStarters({ dataDir: root, out: bundle, check: true, log: quiet });
    const by = Object.fromEntries(diffs.map(d => [d.path, d.change]));
    assert.equal(by[`${slug}/starter.json`], 'changed');
    assert.equal(by[`${slug}/${image.path}`], 'changed');
    assert.equal(by[`${slug}/${video.path}`], 'added');
    assert.equal(by[`${slug}/media/refs/00000000-0000-0000-0000-000000000000.webp`], 'removed');
    assert.equal(diffs.length, 4, JSON.stringify(diffs));
    // The check works on a scratch copy: the edited bundle is still exactly as edited.
    assert.equal(JSON.parse(readFileSync(join(dir, 'starter.json'), 'utf8')).shots[0].title, snap.shots[0].title);
    assert.ok(!existsSync(join(dir, video.path)));
    assert.equal(readdirSync(join(dir, 'media', 'refs')).length, before);
  });
});

test('importing keeps every id and signature; a re-import leaves an existing source project alone', async () => {
  const starters = await loadStarters();
  for (const s of starters) {
    const { project, files } = starterSourceProject(s);
    assert.deepEqual(project.scene.entities.map(e => e.id), s.scene.entities.map(e => e.id));
    assert.deepEqual(project.shots.map(x => x.id), s.shots.map(x => x.id));
    assert.deepEqual(project.assets.map(a => a.id), s.assets.map(a => a.id));
    assert.equal(files.length, s.media.length, `${s.slug} imports every listed file`);
    // The signatures in the bundle were made with these ids, so they match the blocking as imported: nothing is remapped.
    for (const sh of project.shots) {
      const want = shotSignature(project, sh);
      for (const r of sh.references) assert.equal(r.generated?.signature, want, `${s.slug} ${sh.title} still ${r.id}`);
      for (const a of project.assets.filter(x => x.shotId === sh.id && x.kind === 'camera-render')) assert.equal(a.source.signature, want, `${s.slug} ${sh.title} blockout`);
    }
    // And the document exports back to the same snapshot, without touching the disk.
    const src = SOURCES.find(x => x.slug === s.slug);
    const again = starterSnapshot(project, { slug: s.slug, title: src.title, description: src.description, order: s.order, hero: src.hero });
    assert.deepEqual(again.shots, s.shots);
    assert.deepEqual(again.scene, s.scene);
    assert.deepEqual(again.edit, s.edit);
  }
  await withDir(async root => {
    await importStarters({ dataDir: root, only: 'posterized', log: quiet });
    const file = join(root, 'director', starterSourceId('posterized'), 'project.json');
    await writeFile(file, '{"edited":true}');
    const logs = [];
    assert.deepEqual(await importStarters({ dataDir: root, only: 'posterized', log: m => logs.push(m) }), []);
    assert.match(logs[0], /already exists/);
    assert.equal(readFileSync(file, 'utf8'), '{"edited":true}');
    assert.equal((await importStarters({ dataDir: root, only: 'posterized', force: true, log: quiet })).length, 1);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).id, starterSourceId('posterized'));
  });
});

test('--force refuses while a live server holds the data dir; adding missing source projects is allowed', async () => {
  await withDir(async root => {
    await writeFile(join(root, '.server-lock'), `${process.pid}:test`);
    assert.equal(await liveServer(root), process.pid);
    await assert.rejects(importStarters({ dataDir: root, only: 'wingspan', force: true, log: quiet }), /stop it before --force/);
    assert.equal((await importStarters({ dataDir: root, only: 'wingspan', log: quiet })).length, 1);
    await writeFile(join(root, '.server-lock'), '999999999:stale');
    assert.equal(await liveServer(root), null);
    assert.equal((await importStarters({ dataDir: root, only: 'wingspan', force: true, log: quiet })).length, 1);
  });
});
