import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDirector } from '../server/previs/director.mjs';
import { setupChecks } from '../server/previs/setup-check.mjs';

// The asset library, phase 3: the workspace and home page controls, the docs, and the doctor line.
const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('workspace: Save to library on the Appearance block and the group bar; Shared assets in the Library dialog', () => {
  const ui = read('src/director.ts');
  assert.match(ui, /h\('span', \{ class: 'eyebrow' \}, 'Appearance'\), saveToLibraryBtn\(e\)\)/, 'beside the description and style notes');
  assert.match(ui, /'Ungroup', h\('kbd', \{\}, '⇧⌘G'\)\), saveToLibraryBtn\(e\)\)/, 'a group saves with everything inside it');
  assert.match(ui, /const saveToLibraryBtn = \(e: Entity\) => DEMO \? null :/, 'not in the read-only demo');
  assert.match(ui, /api\('director\/library\/save', \{ projectId, object: e\.id, name: .*, tags: .*, replace \}\)/);
  assert.match(ui, /\{ label: 'Save over it', run: \(\) => void send\(true\) \}/, 'a taken handle offers to save over it');
  assert.match(ui, /shared: 'Shared assets'/);
  assert.match(ui, /api\('director\/library'\)/);
  assert.match(ui, /api\('director\/library\/place', \{ projectId, asset: a\.id, position \}\)/);
  assert.match(ui, /undoStack\.push\(\{ label: `Place @\$\{r\.handle\}`, redo: .*undo: \[\.\.\.r\.entityIds\]\.reverse\(\)\.map\(\(id: string\) => \(\{ op: 'remove_entity', id \}\)\) \}\)/, 'Place is one undo step');
  assert.match(ui, /select\(r\.root\); toast\(r\.text\)/, 'the placed object is selected and the reply names its handle');
  assert.match(ui, /href: `\/api\/director\/library\/export\?id=\$\{a\.id\}`, download: ''/);
  assert.match(ui, /fetch\('\/api\/director\/library\/import-zip', \{ method: 'POST', headers: \{ 'Content-Type': 'application\/zip' \}, body: f \}\)/);
  assert.match(ui, /const shown = filter === 'all' \? own : items\.filter/, 'All stays this project’s own media');
  assert.match(read('src/director.css'), /\.asset \.asset-shape \{/);
});

test('home page: one Import… takes a project export or a shared asset', () => {
  const home = read('src/director-home.ts');
  assert.match(home, /if \(data\.kind === 'asset'\) \{ toast\(data\.text\); return; \}/);
  assert.match(home, /title: 'A project \(\.previs\.zip\) or a shared asset \(\.previs-asset\.zip\)'/);
});

test('docs: README, guide and glossary describe the library', () => {
  assert.match(read('README.md'), /## Asset library/); assert.match(read('README.md'), /`PREVIS_LIBRARY_DIR`/);
  assert.match(read('README.md'), /previs_library_list/);
  assert.match(read('docs/director.md'), /## Library: reuse objects across projects/);
  assert.match(read('docs/glossary.md'), /\| \*\*Shared asset\*\* \|/); assert.match(read('docs/glossary.md'), /\| \*\*@handle\*\* \|/);
});

test('pnpm doctor lists the library once there is one, and names unreadable assets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'previs-library-doctor-'));
  try {
    const data = join(root, 'data'), env = { PREVIS_COMFY_URL: 'http://127.0.0.1:9' }, fetcher = async () => { throw Error('down'); };
    assert.equal((await setupChecks({ root, data, env, fetcher })).checks.find(c => c.id === 'library'), undefined, 'a fresh install shows no library line');
    const director = await openDirector(data);
    const p = await director.create({ template: 'street' });
    await director.library.save(p.id, { object: 'Runner' });
    const broken = join(data, 'library', 'assets', '00000000-0000-4000-8000-000000000000');
    await mkdir(broken, { recursive: true }); await writeFile(join(broken, 'asset.json'), '{ not json');
    const line = (await setupChecks({ root, data, env, fetcher })).checks.find(c => c.id === 'library');
    assert.equal(line.status, 'warn');
    assert.match(line.detail, /^1 shared asset in .*library; 1 unreadable: 00000000-0000-4000-8000-000000000000$/);
    assert.deepEqual((await director.library.list()).assets.map(a => a.handle), ['runner'], 'the app skips it');
    assert.equal((await director.library.list()).unreadable, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
