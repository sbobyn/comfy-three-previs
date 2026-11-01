// Free all-shot captures through the same captureShotVideo path as Make blockout.
// Use a disposable imported data directory: renders attach assets to these projects.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadStarters, starterSourceId } from '../../server/previs/starters.mjs';
const [url, out] = process.argv.slice(2);
if (!url || !out) throw Error('Usage: capture-animation.mjs <private-server-url> <out>');
await mkdir(out, { recursive: true });
const manifest = [];
for (const starter of await loadStarters()) for (const [index, shot] of starter.shots.entries()) {
  const projectId = starterSourceId(starter.slug);
  const response = await fetch(`${url}/api/director/render-blockout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId, shotId: shot.id, force: true, width: 1280, height: 720 }) });
  const result = await response.json();
  if (!response.ok) throw Error(JSON.stringify(result));
  const asset = result.project.assets.find(a => a.id === result.project.shots.find(s => s.id === shot.id).render.assetId);
  const media = await fetch(`${url}/director-assets/${projectId}/${asset.file.replace(/^assets\//, '')}`);
  if (!media.ok) throw Error(`Missing captured asset ${asset.id}`);
  const file = `${starter.slug}-${index + 1}.mp4`;
  await writeFile(join(out, file), Buffer.from(await media.arrayBuffer()));
  manifest.push({ slug: starter.slug, title: shot.title, shotId: shot.id, file, duration: shot.duration, frames: result.asset.frameCount, signature: asset.source?.signature });
  await writeFile(join(out, 'captures.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`${file}: ${result.asset.frameCount} frames`);
}
