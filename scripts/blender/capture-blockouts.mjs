// Read-only app captures; run against a private server containing starters:import source projects.
// node scripts/blender/capture-blockouts.mjs http://127.0.0.1:5284 .evidence/blockouts2-20261031/before
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadStarters, starterSourceId } from '../../server/previs/starters.mjs';
const [url, out] = process.argv.slice(2);
if (!url || !out) throw Error('Usage: capture-blockouts.mjs <server-url> <output-dir>');
await mkdir(out, { recursive: true });
const manifest = [];
for (const s of await loadStarters()) for (const [i, shot] of s.shots.entries()) {
  for (const [moment, t] of [['start', 0], ['mid', shot.duration / 2], ['end', shot.duration - 1 / 24]]) {
    const request = { projectId: starterSourceId(s.slug), shotId: shot.id, t, width: 960, height: 540 };
    const response = await fetch(`${url}/api/director/frame`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
    const frame = await response.json();
    if (!response.ok || !frame.data) throw Error(JSON.stringify(frame));
    const file = `${s.slug}-${i+1}-${moment}.png`;
    await writeFile(join(out, file), Buffer.from(frame.data, 'base64'));
    manifest.push({ slug: s.slug, shot: shot.title, moment, file, ...request });
    console.log(`${file} t=${t.toFixed(3)}`);
  }
}
await writeFile(join(out, 'captures.json'), JSON.stringify(manifest, null, 2) + '\n');
