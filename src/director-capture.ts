// Blockout capture: render a shot's camera at a fixed 24 fps and record it on the shot (the source every
// workflow receives). Shared by the workspace (director.ts) and the headless render worker (render-worker.ts).
import { projectMesh } from '../shared/blockout-models.mjs';
import { focusPoint, cameraKeys } from '../shared/director.mjs';
import type { DirectorProject, Shot, Entity } from '../shared/director.mjs';
import type { DirectorScene } from './director-scene';

export type CaptureDeps = {
  api: <T = any>(path: string, body?: unknown) => Promise<T>;
  scene: Pick<DirectorScene, 'pose' | 'quaternionAt' | 'capture'> & Partial<Pick<DirectorScene, 'ready'>>;
  project: () => DirectorProject;
  entity: (id: string | null) => Entity | null;
  signature: (p: DirectorProject, s: Shot) => string;
  /** Show this shot in the scene before capturing. */
  select?: (s: Shot) => void;
  /** Receives the saved director project. */
  apply?: (p: DirectorProject) => void;
};
export type CaptureOptions = { width: number; height: number; prompt: string; onFrame?: (url: string, i: number, n: number) => void; onStatus?: (t: string) => void };

/** Same hash as director.ts `signature` (kept identical; tests/headless.test.mjs compares the two). */
export const shotSignature = (p: DirectorProject, s: Shot) => { const text = JSON.stringify([cameraKeys(s, p.scene.entities), s.duration, s.start || 0, p.scene.entities.filter(e => e.shape !== 'group').map(({ look, notes, name, styleNotes, lookFrom, parent, sheets, model, from, ...e }) => ({ ...e, ...(projectMesh(model) ? { model: model?.split('/').pop() } : {}) })), p.scene.environment.preset]); let x = 5381; for (let i = 0; i < text.length; i++) x = ((x << 5) + x + text.charCodeAt(i)) | 0; return (x >>> 0).toString(16); };

export async function captureShotVideo(deps: CaptureDeps, s: Shot, o: CaptureOptions) {
  const { api, scene } = deps;
  deps.select?.(s);
  await scene.ready?.();
  const project = deps.project();
  const idx = project.shots.findIndex(x => x.id === s.id), { width, height } = o;
  const n = Math.min(120, Math.max(2, Math.round(s.duration * 24))), at = (i: number) => i / 24;
  const motion = Array.from({ length: n }, (_, i) => { const p = scene.pose(at(i)); return { t: i / 24, p: p.p, q: scene.quaternionAt(at(i)), mm: Math.round(p.mm * 1000) / 1000 }; });
  o.onStatus?.('Saving camera motion…');
  const main = await api('project');
  const target = deps.entity(s.camera.target);
  const sig = deps.signature(project, s);
  const saved = await api('browser-shot', {
    revision: main.project.revision, title: `${project.title} · Shot ${idx + 1} · ${s.title}`.slice(0, 160), camera: motion[0], subject: target ? focusPoint(target) : [0, 1, 0], frames: motion,
    png: scene.capture(at(0), 640, 360).split(',')[1], delivery: { width, height, fps: 24 },
    director: { projectId: project.id, shotId: s.id, projectRevision: project.revision, sceneName: project.scene.name, shotTitle: s.title, camera: s.camera, entities: project.scene.entities },
  });
  const previsShot = saved.project.shots.filter((x: any) => x.browser?.director?.shotId === s.id).at(-1);
  const { stage } = await api('video/browser/start', { revision: saved.project.revision, shotId: previsShot.id, width, height, fps: 24, frameCount: n });
  let stageId: string | null = stage.id;
  try {
    for (let i = 0; i < n; i++) {
      const url = scene.capture(at(i), width, height);
      await api('video/browser/frame', { stageId, index: i, png: url.split(',')[1] });
      o.onFrame?.(url, i, n);
    }
    o.onStatus?.('Encoding…');
    const { asset } = await api('video/browser/finish', { stageId }); stageId = null;
    const r = await api('director/render', { projectId: project.id, shotId: s.id, previsShotId: previsShot.id, assetId: asset.id, prompt: o.prompt, signature: sig });
    deps.apply?.(r.project);
    return { asset, previsShotId: previsShot.id as string, project: r.project as DirectorProject };
  } finally { if (stageId) await api('video/browser/abort', { stageId }).catch(() => {}); }
}
