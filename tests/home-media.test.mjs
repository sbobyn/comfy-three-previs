import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadStarters } from '../server/previs/starters.mjs';
import { showcasePairs } from '../scripts/home-media.mjs';

const root = new URL('../', import.meta.url);
const hash = file => createHash('sha256').update(readFileSync(new URL(file, root))).digest('hex');

test('each homepage showcase uses the chosen take’s recorded source, with equal-length clips and frame-zero posters', async () => {
  const manifest = JSON.parse(readFileSync(new URL('public/guide/comparisons.json', root), 'utf8'));
  const starters = await loadStarters(), expected = showcasePairs(starters);
  assert.equal(manifest.pairs.length, expected.length);
  for (const pair of manifest.pairs) {
    const source = expected.find(p => p.slug === pair.slug);
    assert.ok(source, pair.slug);
    assert.equal(pair.shot, source.shot.id);
    assert.equal(pair.generated.asset, source.video.id);
    assert.equal(pair.blockout.asset, source.video.source.sourceAssetId);
    for (const side of ['blockout', 'generated']) {
      assert.equal(hash(pair[side].source), pair[side].sourceSha256, `${pair.slug}: source must not drift`);
      assert.equal(hash(`public/guide/${pair[side].file}`), pair[side].sha256);
      const file = new URL(`public/guide/${pair[side].file}`, root).pathname;
      const probe = JSON.parse(execFileSync(process.env.PREVIS_FFPROBE || 'ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=nb_frames,r_frame_rate', '-of', 'json', file], { encoding: 'utf8' }));
      assert.equal(Number(probe.streams[0].nb_frames), pair.frames, `${pair.slug}: both clips end on the same frame`);
      assert.equal(probe.streams[0].r_frame_rate, '24/1');
      const decoded = execFileSync(process.env.PREVIS_FFMPEG || 'ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-c:v', 'libwebp', '-quality', '82', '-f', 'webp', 'pipe:1']);
      assert.deepEqual(decoded, readFileSync(new URL(`public/guide/${pair[side].poster}`, root)), `${pair.slug}: poster is frame zero of its own clip`);
      if (pair.hero) assert.equal(hash(`public/guide/hero/${pair.hero}-${side}.mp4`), pair[side].sha256, 'hero and starter card use the same take');
    }
  }
});

test('showcase selection refuses a chosen video without a source clip from that shot', async () => {
  const starters = structuredClone(await loadStarters());
  const race = starters.find(s => s.slug === 'final-lap');
  const chosen = race.edit.clips.find(c => race.shots.find(sh => sh.id === c.shotId)?.title === 'Checkered flag');
  race.assets.find(a => a.id === chosen.assetId).source.sourceAssetId = 'missing';
  assert.throws(() => showcasePairs(starters), /chosen video has no source blockout/);
});
