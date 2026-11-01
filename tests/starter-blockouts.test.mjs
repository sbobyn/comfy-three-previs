import test from 'node:test';
import assert from 'node:assert/strict';
import { loadStarters, instantiateStarter } from '../server/previs/starters.mjs';
import { entityAt, focusPoint, shotCameraAt, stillStale, videoStale } from '../shared/director.mjs';
import { frameLayout, shotProjector } from '../shared/still-match.mjs';
import { terrainHeight } from '../shared/terrain.mjs';
import { planBatch } from '../server/previs/batch.mjs';
import { builtInPresets } from '../server/previs/presets.mjs';

const starters = await loadStarters();
const named = (s, name) => s.scene.entities.find(e => e.name === name);

test('starter shots fit Seedance edit and keep their lead readable throughout the camera move', () => {
  const minimum = builtInPresets.find(p => p.id === 'seedance-25-edit-v1').constraints.sourceVideo.duration.min;
  for (const s of starters) for (const sh of s.shots) {
    assert.ok(sh.duration >= minimum && sh.duration <= 5, `${s.slug}: ${sh.title} duration`);
    const lead = s.scene.entities.find(e => e.id === sh.camera.target);
    for (let i = 0; i <= sh.duration * 24; i++) {
      const t = i / 24, pose = { ...lead, ...entityAt(lead, sh.start + t) };
      const point = shotProjector(sh, s.scene.entities, t).project(focusPoint(pose));
      assert.ok(point.z > 0 && point.x > 0.1 && point.x < 0.9 && point.y > 0.05 && point.y < 0.95, `${s.slug}: ${sh.title} lead at ${t}s`);
      const item = frameLayout(s, sh, t).items.find(e => e.id === lead.id);
      if (lead.shape === 'bird' || lead.shape === 'car') {
        assert.ok(item.inFrame > 0.99, `${sh.title}: uncropped ${lead.name}`);
        assert.ok(item.box[2] - item.box[0] >= 0.15, `${sh.title}: immediately readable ${lead.name}`);
      }
      if (s.slug === 'posterized') {
        assert.ok(item.inFrame > 0.99, `${sh.title}: keep the guard's feet and head in frame`);
        assert.ok(!item.hiddenBy, `${sh.title}: another player hides the guard at ${t}s`);
      }
    }
  }
});

test('Final Lap shows a nose-first pass and a full car-length win across the line', () => {
  const s = starters.find(s => s.slug === 'final-lap'), hero = named(s, 'Comfy car'), rival = named(s, 'Rival car');
  const at = (e, t) => entityAt(e, t).position;
  assert.ok(at(hero, 0)[0] < at(rival, 0)[0], 'rival starts ahead');
  assert.ok(at(hero, 8)[0] > at(rival, 8)[0], 'Comfy draws level and passes');
  assert.ok(at(hero, 16)[0] - at(rival, 16)[0] >= 4.5, 'Comfy finishes a car length clear');
  const line = named(s, 'Start-finish line').position[0];
  assert.ok(at(hero, 12)[0] < line && at(hero, 16)[0] > line, 'the finish occurs during Checkered flag');
  for (const sh of s.shots) for (let t = 0; t <= sh.duration; t += 0.25) {
    for (const e of [hero, rival]) {
      const pose = entityAt(e, sh.start + t), next = entityAt(e, sh.start + t + 0.01);
      const heading = Math.atan2(next.position[0] - pose.position[0], next.position[2] - pose.position[2]) * 180 / Math.PI;
      assert.ok(next.position[0] > pose.position[0] && Math.abs(heading - pose.rotation) < 1.5, 'local +z nose follows the lane-change tangent');
      const item = frameLayout(s, sh, t).items.find(x => x.id === e.id);
      assert.ok(item?.inFrame > 0.99, `${sh.title}: both cars stay in frame`);
    }
  }
  assert.ok(s.scene.entities.filter(e => e.kind === 'environment').every(e => !e.lookFrom), 'set pieces do not inherit the infield image');
});

test('Posterized rises above the defender and sends the ball through the rim; Wingspan stays above water and terrain', () => {
  const p = starters.find(s => s.slug === 'posterized'), guard = named(p, 'Comfy guard'), rival = named(p, 'Rival defender'), ball = named(p, 'Basketball'), rim = named(p, 'East rim');
  assert.ok(Math.abs(entityAt(guard, 8).position[1]) < .1, 'start grounded before the leap; posed shoe contact checked by rig tests');
  assert.ok(entityAt(guard, 11.1).position[1] - entityAt(rival, 11.1).position[1] > 1, 'guard rises above the rival');
  assert.ok(entityAt(ball, 10.6).position[1] > rim.position[1]);
  assert.ok(entityAt(ball, 11.4).position[1] < rim.position[1]);
  const w = starters.find(s => s.slug === 'wingspan'), eagle = named(w, 'Bald eagle'), lake = named(w, 'Alpine lake'), terrain = named(w, 'Alpine terrain');
  assert.equal(eagle.shape, 'bird');
  for (const sh of w.shots) for (let t = 0; t <= sh.duration; t += 0.1) {
    const p = entityAt(eagle, sh.start + t).position, cam = shotCameraAt(sh, w.scene.entities, t).p;
    assert.ok(p[1] > terrainHeight(terrain, p[0], p[2]) + 2);
    assert.ok(cam[1] > terrainHeight(terrain, cam[0], cam[2]) + 1, 'camera never begins inside a hillside');
    if (sh.title === 'The glide') {
      assert.ok(Math.hypot((p[0] - lake.position[0]) / 20, (p[2] - lake.position[2]) / 20) < 0.9, 'low glide stays inside the lake shoreline');
      assert.ok(p[1] - lake.position[1] < 5, 'low over the water');
    }
  }
});

// Animation changes intentionally stale the earlier paid takes; no generation is performed in this pass.
// Media made before the animation pass that the 2026-11-01 regeneration did not replace (see examples/starters/README.md):
// Wingspan was not regenerated, and Seedance refused both Posterized · Posterized videos, so that shot keeps its earlier
// video and the blockout clip it was made from, next to new stills.
const EARLIER_MEDIA = {
  wingspan: { 'The valley': ['stills', 'video'], 'The dive': ['stills', 'video'], 'The glide': ['stills', 'video'] },
  posterized: { Posterized: ['video'] },
};

test('starter copies open with current stills and videos, except the takes listed as made for the earlier animation', () => {
  for (const s of starters) {
    const p = instantiateStarter(s);
    for (const sh of p.shots) {
      const earlier = EARLIER_MEDIA[s.slug]?.[sh.title] || [];
      const stills = sh.references.filter(r => r.generated);
      assert.deepEqual(stills.map(r => r.note).sort(), ['key frame end', 'key frame start'], `${s.slug} ${sh.title}: one start and one end still`);
      assert.ok(stills.every(r => stillStale(p, sh, r) === earlier.includes('stills')), `${s.slug} ${sh.title}: stills ${earlier.includes('stills') ? 'keep the earlier' : 'carry the current'} blocking signature`);
      const renders = p.assets.filter(a => a.shotId === sh.id && a.kind === 'camera-render');
      assert.equal(renders.length, 1, `${s.slug} ${sh.title}: one blockout clip, the one the video was made from`);
      assert.equal(renders[0].duration, sh.duration);
      assert.equal(renders[0].frameCount, sh.duration * 24);
      const video = p.assets.find(a => a.shotId === sh.id && a.kind === 'workflow-result');
      assert.equal(video.source.sourceAssetId, renders[0].id, `${s.slug} ${sh.title}: video keeps its actual blockout source`);
      assert.equal(videoStale(p, sh, video), earlier.includes('video'), `${s.slug} ${sh.title}: video ${earlier.includes('video') ? 'keeps the earlier' : 'follows the current'} blocking`);
      const clip = p.edit.clips.find(c => c.shotId === sh.id);
      assert.equal(clip?.assetId, video.id, `${s.slug} ${sh.title}: the cut uses the shot's video`);
    }
    // A dry run replaces exactly the stale stills: it never feeds an old posed still into a new clip, and never remakes a paid current one.
    const plan = planBatch(p, { steps: ['stills', 'videos'], tier: 'final', dryRun: true, maxCostUsd: 50 });
    for (const n of plan.nodes.filter(x => x.type === 'still')) {
      const sh = p.shots.find(x => x.id === n.target.shotId), stale = (EARLIER_MEDIA[s.slug]?.[sh.title] || []).includes('stills');
      assert.equal(n.status === 'skipped', !stale, `${s.slug} ${sh.title}: final-tier plan ${stale ? 'replaces the stale' : 'keeps the current'} ${n.target.t} still`);
    }
    assert.equal(plan.nodes.filter(x => x.type === 'still').length, p.shots.length * 2);
  }
});
