import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProjectDocument } from '../server/previs/director.mjs';
import { loadStarters, starterSnapshot, starterPicks, STARTERS_DIR } from '../server/previs/starters.mjs';
import { shotSignature, starterBlockout, starterMediaStatus, stillStale, videoStale } from '../shared/director.mjs';

const starters = await loadStarters();

// Shots whose video (and so blockout clip) still predates the posed animation; see tests/starter-blockouts.test.mjs EARLIER_MEDIA.
// Existing media predates the 2026-11-03 inward-facing stand correction; do not relabel it as fresh.
const EARLIER_CLIPS = {
  'final-lap': ['Final lap', 'The draft', 'From the stands', 'Checkered flag'],
  posterized: ['Fast break', 'The drive', 'Posterized'],
};

test('each starter ships the blockout clip of its video, current except where the video predates the posed animation', () => {
  for (const s of starters) {
    const p = createProjectDocument({ template: s.slug }, undefined, starters);
    assert.deepEqual(p.starterFiles, { listed: s.media.length, missing: 0 }, `${s.slug}: every listed file is in the checkout`);
    for (const sh of p.shots) {
      const b = starterBlockout(p, sh), earlier = (EARLIER_CLIPS[s.slug] || []).includes(sh.title);
      // Look Lab's variants share one blocking: a shot without its own clip has the signature of one that has it.
      if (!b && !p.edit?.clips?.some(c => c.shotId === sh.id)) { assert.ok(p.shots.some(o => starterBlockout(p, o)?.fresh && shotSignature(p, o) === shotSignature(p, sh)), `${s.slug} ${sh.title}: no clip and no shared blocking`); continue; }
      assert.ok(b, `${s.slug} ${sh.title}: bundled blockout clip`);
      assert.equal(b.fresh, !earlier, `${s.slug} ${sh.title}: the bundled clip ${earlier ? 'predates' : 'shows'} the posed animation`);
    }
  }
});

test('a starter copy says how much of its media is missing and opens without it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'starters-missing-'));
  try {
    // A checkout whose starter media folders are gone (or still being regenerated).
    await cp(STARTERS_DIR, root, { recursive: true, filter: src => !src.includes('/media') });
    const bare = await loadStarters(root);
    assert.equal(bare.length, starters.length);
    for (const s of bare) {
      const p = createProjectDocument({ template: s.slug }, undefined, bare);
      assert.deepEqual(p.starterFiles, { listed: s.media.length, missing: s.media.length });
      assert.equal(p.assets, undefined); assert.equal(p.edit, undefined); assert.equal(p.starterMedia, undefined);
      assert.ok(p.shots.every(sh => sh.references.length === 0 && !starterBlockout(p, sh)));
      const st = starterMediaStatus(p);
      assert.deepEqual(st, { missing: s.media.length, listed: s.media.length, staleShots: [] });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('videos and stills made for an earlier blocking are reported per shot; a fresh project is not', () => {
  for (const s of starters) {
    const p = createProjectDocument({ template: s.slug }, undefined, starters);
    const st = starterMediaStatus(p);
    for (const sh of p.shots) {
      const clip = p.edit?.clips?.find(c => c.shotId === sh.id), video = p.assets.find(a => a.id === clip?.assetId);
      const src = p.assets.find(a => a.id === video?.source.sourceAssetId);
      // A cut video is stale exactly when the blockout it came from is not the current blocking.
      if (src) assert.equal(videoStale(p, sh, video), src.source.signature ? src.source.signature !== shotSignature(p, sh) : src.id !== starterBlockout(p, sh).asset.id, `${s.slug} ${sh.title}`);
      if (video && videoStale(p, sh, video)) assert.ok(st?.staleShots.includes(sh.id), `${s.slug} ${sh.title} listed as stale`);
    }
  }
  assert.equal(starterMediaStatus(createProjectDocument({ template: 'street' })), null);
});

test('videoStale follows the source blockout: same signature fresh, other signature or newer clip stale', () => {
  const p = createProjectDocument({ template: 'final-lap' }, undefined, starters), sh = p.shots[0];
  delete p.edit;
  const sig = shotSignature(p, sh), t = i => `2026-10-3${i}T00:00:00.000Z`;
  const render = (id, at, signature) => ({ id, kind: 'camera-render', shotId: sh.id, createdAt: t(at), source: signature ? { signature } : {} });
  const video = { id: 'v', kind: 'workflow-result', shotId: sh.id, createdAt: t(1), source: { sourceAssetId: 'r1' } };
  p.assets = [render('r1', 0, sig), video];
  assert.equal(videoStale(p, sh, video), false);
  p.assets = [render('r1', 0, 'other'), video];
  assert.equal(videoStale(p, sh, video), true);
  p.assets = [render('r1', 0), video];
  assert.equal(videoStale(p, sh, video), false, 'unsigned and still the newest clip');
  p.assets = [render('r1', 0), render('r2', 1, sig), video];
  assert.equal(videoStale(p, sh, video), true, 'a newer blockout clip exists');
  p.assets = [render('r1', 0), video]; sh.render = { assetId: 'r1', signature: sig };
  assert.equal(videoStale(p, sh, video), false, 'the shot render records the signature');
  assert.equal(videoStale(p, sh, { ...video, source: {} }), false, 'unknown source is not judged');
  assert.equal(starterBlockout(p, sh), null, 'a shot with its own blockout has no starter clip');
});

test('re-exporting keeps each blockout clip’s signature', () => {
  const p = createProjectDocument({ template: 'final-lap' }, undefined, starters), sh = p.shots[0];
  // The clip the exporter picks for shot 1, recorded the way the app records its own blockouts: on the shot's render.
  const clip = starterPicks(p)[0].blockout;
  assert.ok(clip, 'shot 1 has a blockout to export');
  delete clip.source.signature; sh.render = { assetId: clip.id, signature: 'abc123' };
  const snap = starterSnapshot(p, { slug: 'x', title: 'X', description: 'd' });
  assert.equal(snap.assets.find(a => a.id === clip.id)?.source.signature, 'abc123');
  // A clip that already carries one keeps it.
  delete sh.render; clip.source.signature = 'def456';
  assert.equal(starterSnapshot(p, { slug: 'x', title: 'X', description: 'd' }).assets.find(a => a.id === clip.id)?.source.signature, 'def456');
});

test('media made for a snapshot’s current blocking stays current in every copy (ids are renewed)', () => {
  for (const s of starters) {
    const snap = structuredClone(s); Object.defineProperty(snap, 'dir', { value: s.dir });
    // As after a fresh export: every still and the cut video's clip record the snapshot's blocking.
    for (const sh of snap.shots) for (const r of sh.references || []) if (r.generated) r.generated.signature = shotSignature(snap, sh);
    for (const c of snap.edit.clips) { const v = snap.assets.find(a => a.id === c.assetId); const src = snap.assets.find(a => a.id === v.source.sourceAssetId); src.source.signature = shotSignature(snap, snap.shots.find(x => x.id === c.shotId)); }
    const p = createProjectDocument({ template: s.slug }, undefined, [snap]);
    for (const sh of p.shots) assert.ok(sh.references.filter(r => r.generated).every(r => !stillStale(p, sh, r)), `${s.slug} ${sh.title}: current still judged stale`);
    assert.equal(starterMediaStatus(p), null, `${s.slug}: nothing to report`);
    // Moving an object afterwards makes them out of date again (a blockout starter has only its clips to go stale).
    p.scene.entities[0].position = [p.scene.entities[0].position[0] + 1, ...p.scene.entities[0].position.slice(1)];
    if (p.edit?.clips?.length) assert.ok(starterMediaStatus(p)?.staleShots.length > 0);
    else assert.ok(p.shots.some(sh => starterBlockout(p, sh)?.fresh === false), `${s.slug}: a moved object leaves the bundled clips stale`);
  }
});
