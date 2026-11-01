// Close-up captures of the places where coplanar surfaces and shadows are most likely to fail: track joints,
// markings, the finish line, walls, stand rows, court lines, the desk, the lake and river. Read-only for starters:
// it writes one extra project per starter (a copy of the imported source project whose shots are these fixed
// cameras) into a private data directory, then captures each through /api/director/frame, the app's own renderer.
//   node scripts/blender/capture-closeups.mjs <server-url> <data-dir> <output-dir>
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { starterSourceId } from '../../server/previs/starters.mjs';

// [name, camera position, look-at point, focal length]. The first Final Lap view matches the reported frame.
export const CLOSEUPS = {
  'final-lap': [
    ['wall-and-stands', [-12, 1.4, 41.5], [-6, 1.2, 50], 50],
    ['wall-shadow-low', [-24, 0.6, 44], [-14, 0.2, 47.2], 35],
    ['front-stretch-joint', [-22.5, 1.2, 36], [-20, 0, 40], 28],
    ['turn-segment-overlap', [90, 9, -12], [99, 0, 0], 35],
    ['finish-line', [16, 1.6, 35.5], [20, 0, 40], 30],
    ['stand-rows', [-4, 5, 50], [0, 4.5, 60], 35],
    ['pit-wall', [-30, 1.1, 36], [-24, 0.5, 32.5], 35],
  ],
  posterized: [
    ['court-lines-paint', [5.5, 1.8, 3.5], [10, 0, 0], 28],
    ['center-circle', [2.2, 1.6, 2.6], [0, 0, 0], 28],
    ['sideline-stands', [-3, 2, 8], [0, 1.5, 14], 28],
  ],
  'breaking-news': [
    ['desk-front-panel', [1.4, 1.1, 1.6], [0, 0.5, -0.6], 30],
    ['floor-markings', [6, 1.4, 4], [9, 0, 6.5], 28],
    ['video-wall', [1.8, 1.8, -1.2], [0, 2.2, -4.5], 30],
  ],
  wingspan: [
    ['river-on-terrain', [22, 4, 26], [14, 0.3, 16], 35],
    ['lake-edge', [8, 3.5, -6], [0, 0.4, -16], 30],
  ],
};

const closeupId = slug => { const h = createHash('sha1').update(`zfight-closeups:${slug}`).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };

async function writeProject(dataDir, slug) {
  const id = closeupId(slug), dir = join(dataDir, 'director', id);
  if (existsSync(join(dir, 'project.json'))) return id;
  const p = JSON.parse(await readFile(join(dataDir, 'director', starterSourceId(slug), 'project.json'), 'utf8'));
  const base = p.shots[0];
  p.id = id; p.title = `${p.title} · close-ups`; p.assets = []; p.edit = { clips: [] }; p.messages = [];
  p.shots = CLOSEUPS[slug].map(([name, at, look, mm], i) => ({
    ...structuredClone(base), id: `${id.slice(0, 24)}${String(i).padStart(12, '0')}`, title: name, description: name, duration: 1, start: 0,
    camera: { ...base.camera, move: 'custom', mm, keys: [{ t: 0, p: at, look, mm }, { t: 1, p: at, look, mm }], timing: 'linear' }, references: [], render: null,
  }));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'project.json'), JSON.stringify(p, null, 2) + '\n');
  return id;
}

const [url, dataDir, out] = process.argv.slice(2);
if (!url || !dataDir || !out) throw Error('Usage: capture-closeups.mjs <server-url> <data-dir> <output-dir>');
await mkdir(out, { recursive: true });
for (const slug of Object.keys(CLOSEUPS)) {
  const projectId = await writeProject(dataDir, slug);
  const p = await (await fetch(`${url}/api/director/project?id=${projectId}`)).json();
  for (const shot of p.project.shots) {
    const response = await fetch(`${url}/api/director/frame`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId, shotId: shot.id, t: 0, width: 1280, height: 720 }) });
    const frame = await response.json();
    if (!response.ok || !frame.data) throw Error(JSON.stringify(frame));
    const file = `closeup-${slug}-${shot.title}.png`;
    await writeFile(join(out, file), Buffer.from(frame.data, 'base64'));
    console.log(file);
  }
}
