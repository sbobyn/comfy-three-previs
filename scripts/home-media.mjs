#!/usr/bin/env node
// Refresh homepage comparisons from bundled takes and their exact saved source clips. No server or paid calls.
// node scripts/home-media.mjs --out <fresh-directory>
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadStarters, starterSourceId } from '../server/previs/starters.mjs';

export const SHOWCASES = [
  { slug: 'breaking-news', shot: 'The headline' },
  { slug: 'final-lap', shot: 'Checkered flag', hero: 'race' },
  { slug: 'wingspan', shot: 'The glide', hero: 'eagle' },
  { slug: 'posterized', shot: 'Posterized', hero: 'dunk' },
  { slug: 'camera-moves', shot: 'Orbit right', hero: 'lighthouse' },
  { slug: 'look-lab', shot: 'Cyberpunk city', hero: 'street' },
  { slug: 'mountain-trail', shot: 'Ridge reveal' },
  { slug: 'city-blocks', shot: 'Drone rise' },
  { slug: 'two-hander', shot: 'Master' },
];

export function showcasePairs(starters) {
  return SHOWCASES.flatMap(spec => {
    const s = starters.find(s => s.slug === spec.slug), shot = s?.shots.find(sh => sh.title === spec.shot);
    if (!shot) throw Error(`${spec.slug}: missing showcase shot ${spec.shot}`);
    const chosen = s.edit?.clips.find(c => c.shotId === shot.id)?.assetId;
    const video = s.assets?.find(a => a.id === chosen && a.kind === 'workflow-result');
    if (!video) return [];
    const block = s.assets.find(a => a.id === video.source?.sourceAssetId && a.kind === 'camera-render' && a.shotId === shot.id);
    if (!block) throw Error(`${spec.slug}: chosen video has no source blockout for this shot`);
    return [{ ...spec, starter: s, shot, video, block }];
  });
}

export async function captureHomeMedia(out) {
  await mkdir(out, { recursive: true });
  if ((await readdir(out)).length) throw Error('Choose a fresh output directory; existing media is preserved.');
  const entries = [], pairs = [], now = new Date().toISOString();
  const ff = (...args) => execFileSync(process.env.PREVIS_FFMPEG || 'ffmpeg', ['-y', '-v', 'error', ...args]);
  const probe = file => JSON.parse(execFileSync(process.env.PREVIS_FFPROBE || 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file], { encoding: 'utf8' })).format.duration;
  const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
  const add = async e => entries.push({ capturedAt: now, ...e, bytes: (await readFile(join(out, e.file))).length });
  for (const p of showcasePairs(await loadStarters())) {
    const { starter: s, shot, video, block } = p, tag = `${s.slug}-s${s.shots.indexOf(shot) + 1}`;
    const source = asset => join(s.dir, 'media', asset.file);
    const frames = Math.floor(Math.min(Number(probe(source(block))), Number(probe(source(video)))) * 24 + 0.001);
    const meta = { project: starterSourceId(s.slug), shot: shot.id, label: `${s.title} · ${shot.title}` };
    const files = {};
    for (const [kind, asset] of [['blockout', block], ['generated', video]]) {
      const file = `${tag}-${kind}.mp4`, poster = `${tag}-${kind}.webp`;
      for (const crf of [23, 27, 31]) {
        ff('-i', source(asset), '-an', '-vf', 'setpts=PTS-STARTPTS,fps=24,scale=640:360:force_original_aspect_ratio=increase,crop=640:360', '-frames:v', String(frames), '-c:v', 'libx264', '-preset', 'fast', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(out, file));
        if ((await readFile(join(out, file))).length <= 1024 * 1024) break;
      }
      if ((await readFile(join(out, file))).length > 1024 * 1024) throw Error(`${file}: over 1 MB`);
      ff('-i', join(out, file), '-frames:v', '1', '-c:v', 'libwebp', '-quality', '82', join(out, poster));
      const lineage = kind === 'generated' ? { sourceAssetId: block.id, model: video.source.workflow.split(' ·')[0] } : {};
      await add({ id: `${tag}-${kind}`, file, kind: 'video', asset: asset.id, ...lineage, ...meta });
      await add({ id: `${tag}-${kind}-poster`, file: poster, kind: 'image', asset: asset.id, ...lineage, ...meta });
      files[kind] = { file, poster, asset: asset.id, source: `examples/starters/${s.slug}/media/${asset.file}`, sourceSha256: await hash(source(asset)), sha256: await hash(join(out, file)) };
      if (p.hero) for (const [from, to] of [[file, `${p.hero}-${kind}.mp4`], [poster, `${p.hero}-${kind}.webp`]]) {
        await mkdir(join(out, 'hero'), { recursive: true });
        await writeFile(join(out, 'hero', to), await readFile(join(out, from)));
      }
    }
    const frame = shot.references.find(r => r.role === 'frame' && /start/i.test(r.note || ''));
    if (frame) {
      const still = `${tag}-still.webp`, before = `${tag}-still-blockout.webp`;
      ff('-i', join(s.dir, 'media/refs', frame.file), '-frames:v', '1', '-vf', 'scale=640:360:force_original_aspect_ratio=increase,crop=640:360', '-c:v', 'libwebp', '-quality', '82', join(out, still));
      await writeFile(join(out, before), await readFile(join(out, files.blockout.poster)));
      await add({ id: `${tag}-still`, file: still, kind: 'image', asset: frame.id, ...meta });
      await add({ id: `${tag}-still-blockout`, file: before, kind: 'image', asset: block.id, ...meta });
    }
    const refs = [...new Map((s.scene.references || []).filter(r => r.entityId && ['character', 'vehicle', 'prop'].includes(r.role) && !/design sheet|· (Front|Back|Left|Right)/i.test(r.name)).map(r => [r.entityId, r])).values()].slice(0, 4);
    for (const [i, r] of refs.entries()) {
      const file = `${s.slug}-cast-${i + 1}.webp`;
      ff('-i', join(s.dir, 'media/refs', r.file), '-frames:v', '1', '-vf', 'scale=160:160:force_original_aspect_ratio=increase,crop=160:160', '-c:v', 'libwebp', '-quality', '82', join(out, file));
      await add({ id: `${s.slug}-cast-${i + 1}`, file, kind: 'image', asset: r.id, label: s.scene.entities.find(e => e.id === r.entityId)?.name || r.name, project: meta.project });
    }
    pairs.push({ slug: s.slug, hero: p.hero, shot: shot.id, title: meta.label, model: video.source.workflow, frames, fps: 24, duration: frames / 24, ...files });
    console.log(`${meta.label}: ${frames} common frames; ${block.id} → ${video.id}`);
  }
  const alias = (id, from) => { const e = entries.find(e => e.id === from); if (e) entries.push({ ...e, id }); };
  const cast = pairs.find(p => p.slug === 'breaking-news'), generate = pairs.find(p => p.slug === 'final-lap');
  if (cast) { const tag = cast.blockout.file.replace(/-blockout.mp4$/, ''); alias('cast-before', `${tag}-still-blockout`); alias('cast-after', `${tag}-still`); for (let i = 1; i <= 4; i++) alias(`cast-image-${i}`, `breaking-news-cast-${i}`); }
  if (generate) { const tag = generate.blockout.file.replace(/-blockout.mp4$/, ''); for (const [id, suffix] of [['generate-before', 'blockout'], ['generate-after', 'generated'], ['generate-before-poster', 'blockout-poster'], ['generate-after-poster', 'generated-poster']]) alias(id, `${tag}-${suffix}`); }
  // Preserve the guide's existing annotated workspace captures when refreshing only the shot comparisons.
  const guide = resolve(import.meta.dirname, '../public/guide');
  const old = JSON.parse(await readFile(join(guide, 'manifest.json'), 'utf8'));
  for (const e of old.entries.filter(e => ['home', 'build', 'shoot', 'generate', 'cut', 'cut-board', 'phone'].includes(e.id))) {
    await writeFile(join(out, e.file), await readFile(join(guide, e.file)));
    entries.push(e);
  }
  await writeFile(join(out, 'manifest.json'), JSON.stringify({ capturedAt: now, source: 'scripts/home-media.mjs', entries }, null, 2) + '\n');
  await writeFile(join(out, 'comparisons.json'), JSON.stringify({ source: 'scripts/home-media.mjs', pairs }, null, 2) + '\n');
  return pairs;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const i = process.argv.indexOf('--out');
  if (i < 0 || !process.argv[i + 1]) throw Error('Usage: node scripts/home-media.mjs --out <fresh-directory>');
  await captureHomeMedia(resolve(process.argv[i + 1]));
}
