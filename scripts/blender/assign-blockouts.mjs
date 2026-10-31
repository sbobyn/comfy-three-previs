// Apply only model ids to imported canonical source projects, then use starters:export.
// node scripts/blender/assign-blockouts.mjs <data-dir>
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SOURCES } from '../export-starters.mjs';
import { makeEntity } from '../../shared/director.mjs';
import { blockoutModel } from '../../shared/blockout-models.mjs';
const data = process.argv[2];
if (!data) throw Error('Pass the directory populated by pnpm starters:import');
function model(e) {
  const n = e.name.toLowerCase();
  if (e.shape === 'group') return null;
  if (e.shape === 'terrain') return 'terrain';
  if (e.shape === 'tree') return 'pine';
  if (e.shape === 'bird') return 'eagle';
  if (e.shape === 'car') return 'race-car';
  if (e.shape === 'lamp') return 'light';
  if (e.shape === 'person') return n.includes('anchor') ? 'anchor' : n.includes('operator') ? 'operator' : n.includes('phone') ? 'fan' : 'player';
  if (n.startsWith('elk')) return 'elk';
  if (n.startsWith('river')) return 'river';
  if (n.includes('lake')) return 'lake';
  if (n.includes('studio camera')) return 'studio-camera';
  if (n.includes('studio floor')) return 'studio-floor';
  if (n.includes('video wall')) return 'video-wall';
  if (n.includes('desk front')) return 'desk-panel';
  if (n.includes('desk')) return 'desk';
  if (n.includes('court floor')) return 'court';
  if (n.includes('center circle')) return 'circle';
  if (n.includes('paint')) return 'paint';
  if (n.includes('hoop support')) return 'support';
  if (n.includes('backboard')) return 'backboard';
  if (n.includes('rim')) return 'rim';
  if (n.includes('basketball')) return 'basketball';
  if (n.includes('stands')) return 'stands';
  if (n.includes('jumbotron')) return 'screen';
  if (n.includes('grass')) return 'grass';
  if (n.includes('start-finish')) return 'finish';
  if (n.includes('flag stand')) return 'flag-stand';
  if (n.includes('press box')) return 'press-box';
  if (n.includes('wall')) return 'barrier';
  if (n.includes('surface') || n.includes('stretch')) return 'track';
  throw Error(`Unmapped object: ${e.name}`);
}
for (const { slug, id } of SOURCES) {
  const path = join(data, 'director', id, 'project.json');
  const project = JSON.parse(await readFile(path, 'utf8'));
  let count = 0;
  for (const [index, e] of project.scene.entities.entries()) {
    const id = model(e);
    if (id) { e.model = id; if (!blockoutModel(e)) throw Error(`Wrong proxy for ${e.name}: ${id}`); project.scene.entities[index] = makeEntity(e, e.id); count++; }
  }
  await writeFile(path, JSON.stringify(project, null, 2) + '\n');
  console.log(`${slug}: ${count} meshes assigned; transforms, paths, cameras and media unchanged`);
}
