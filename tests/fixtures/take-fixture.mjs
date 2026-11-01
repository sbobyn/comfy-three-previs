// A starter project with several takes per shot, made from the starter's own bundled media (no generation): the
// videos of the other shots are copied in as extra takes of shot 2 with different models, seeds and settings, and
// shot 2's start still gets a second, graded take. For the Take lab tests and screenshots.
import { readFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson } from '../../server/previs/atomic.mjs';
import { importStarters } from '../../scripts/import-starters.mjs';

/** Import `slug` into dataDir and give its shot 2 four video takes and two start-still takes. Returns { id, shotId, takes }. */
export async function takeFixture(dataDir, slug = 'breaking-news') {
  const [{ id }] = await importStarters({ dataDir, only: slug, log: () => {} });
  const dir = join(dataDir, 'director', id), file = join(dir, 'project.json');
  const p = JSON.parse(await readFile(file, 'utf8'));
  const s = p.shots[1], blockout = p.assets.find(a => a.shotId === s.id && a.kind === 'camera-render');
  const own = p.assets.find(a => a.shotId === s.id && a.kind === 'workflow-result');
  const others = p.assets.filter(a => a.shotId !== s.id && a.kind === 'workflow-result');
  // Same shot, three more takes: another model, and the same model with a different seed and resolution.
  const specs = [
    { from: others[0], workflow: 'LTX 2.5 Fast · first frame', cameraSource: 'still', parameters: { seed: 11, resolution: '720p', duration: 5 }, amount: 0.2, at: '2026-10-31T10:00:00.000Z' },
    { from: own, workflow: own.source.workflow, cameraSource: own.source.cameraSource || 'blockout', parameters: { seed: 1234, resolution: '720p', duration: 5 }, amount: 0.63, at: '2026-10-31T11:00:00.000Z' },
    { from: others[1] || others[0], workflow: own.source.workflow, cameraSource: own.source.cameraSource || 'blockout', parameters: { seed: 7, resolution: '1080p', duration: 5 }, amount: 0.84, at: '2026-10-31T12:00:00.000Z' },
  ];
  // The bundled take keeps its place as Take 1 and gets its settings recorded too.
  Object.assign(own, { createdAt: '2026-10-31T09:00:00.000Z' });
  own.source = { ...own.source, sourceAssetId: blockout.id, parameters: { seed: 42, resolution: '720p', duration: 5 }, definitionId: 'seedance-25-edit', inputs: ['sourceVideo', 'referenceImage1', 'referenceImage2'], quote: { status: 'unknown', amount: 0.63, currency: 'USD' } };
  const takes = [own.id];
  for (const x of specs) {
    const nid = randomUUID();
    await copyFile(join(dir, x.from.file), join(dir, `assets/${nid}.mp4`));
    p.assets.push({ ...structuredClone(x.from), id: nid, shotId: s.id, file: `assets/${nid}.mp4`, createdAt: x.at, starter: undefined,
      source: { sourceAssetId: blockout.id, workflow: x.workflow, backend: 'cloud', cameraSource: x.cameraSource, prompt: own.source.prompt || s.description, parameters: x.parameters, inputs: x.cameraSource === 'blockout' ? ['sourceVideo', 'referenceImage1'] : ['firstFrame'], quote: { status: 'unknown', amount: x.amount, currency: 'USD' } } });
    takes.push(nid);
  }
  // A second start-still take, graded by the paid grader, made before the first one so the bundled still stays in use.
  const start = s.references.find(r => r.role === 'frame' && r.note === 'key frame start');
  const sid = randomUUID();
  await copyFile(join(dir, 'refs', start.file), join(dir, 'refs', `${sid}.webp`));
  s.references.unshift({ ...structuredClone(start), id: sid, file: `${sid}.webp`, name: `${start.name} · alt`, createdAt: '2026-10-30T09:00:00.000Z', generated: { ...start.generated, seed: 777, model: 'FLUX 3 Image (BFL)', presetId: 'flux-3', guideMatch: { score: 4, layout: 4, camera: 6, headings: 3, why: 'The anchor faces screen left instead of the camera.', method: 'gemini-grader:Gemini 3.5 Flash' } } });
  start.generated = { ...start.generated, guideMatch: { score: 8, layout: 8, camera: 9, headings: 8, why: 'Same framing and desk position.', method: 'gemini-grader:Gemini 3.5 Flash' } };
  await atomicJson(file, p);
  return { id, shotId: s.id, takes, stills: [sid, start.id] };
}
