import * as THREE from 'three';
import type { Studio } from './scene';
export type CameraFrame = { t: number; p: number[]; q: number[]; mm: number };

// The existing camera controller owns operation. This adapter captures its resolved
// camera and supplies saved playback after that controller has updated each frame.
export function installPrevisCamera(studio: Studio): () => void {
  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;top:12px;left:280px;right:12px;z-index:30;background:#15212ef2;padding:12px;border:1px solid #6b8ca8;border-radius:8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;color:#eee;font:13px system-ui';
  const link = document.createElement('a'); link.href = '/'; link.textContent = '← Previs shots'; link.style.color = '#b4dbf7';
  const title = document.createElement('input'); title.value = 'Camera study'; title.setAttribute('aria-label', 'Previs shot title');
  const record = document.createElement('button'); record.textContent = 'Record shot';
  const play = document.createElement('button'); play.textContent = 'Play saved motion';
  const save = document.createElement('button'); save.textContent = 'Save shot & beauty';
  const status = document.createElement('span'); status.textContent = 'Browser scene · no Blender required';
  panel.append(link, title);
  for (const [axis, index] of [['X', 0], ['Y', 1], ['Z', 2]] as const) {
    const label = document.createElement('label'); label.textContent = 'Subject ' + axis;
    const input = document.createElement('input'); input.type = 'number'; input.step = '0.5'; input.style.width = '60px'; input.value = String(studio.subjectPosition()[index]); input.setAttribute('aria-label', 'Subject ' + axis);
    input.oninput = () => { const p = studio.subjectPosition(); p[index] = Number(input.value); studio.setSubjectPosition(p); };
    label.append(input); panel.append(label);
  }
  panel.append(record, play, save, status); document.body.append(panel);
  let frames: CameraFrame[] = [], recording = false, started = 0, playing = NaN;
  const frame = (t: number): CameraFrame => ({ t, p: studio.pov.position.toArray(), q: studio.pov.quaternion.toArray(), mm: studio.pov.getFocalLength() });
  const stop = () => { recording = false; record.textContent = 'Record shot'; };
  record.onclick = () => { if (recording) { stop(); return; } frames = []; playing = NaN; recording = true; started = performance.now(); record.textContent = 'Stop shot'; };
  play.onclick = () => { stop(); playing = Number.isNaN(playing) ? performance.now() : NaN; };
  save.onclick = async () => {
    stop(); save.disabled = true;
    try {
      const current = await (await fetch('/api/project')).json();
      const response = await fetch('/api/browser-shot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: current.project.revision, title: title.value, camera: frame(0), frames, subject: studio.subjectPosition(), png: studio.capture().split(',')[1] }) });
      const result = await response.json(); if (!response.ok) throw Error(result.error);
      status.textContent = `Saved · ${frames.length} motion samples · beauty PNG`;
    } catch (e) { status.textContent = (e as Error).message; } finally { save.disabled = false; }
  };
  const shotId = new URLSearchParams(location.search).get('shot');
  if (shotId) void fetch('/api/project').then(r => r.json()).then(({ project }) => {
    const shot = project.shots.find((s: { id: string }) => s.id === shotId);
    if (!shot || shot.binding.source !== 'three') throw Error('Browser shot unavailable');
    title.value = shot.title; frames = shot.browser.frames.length ? shot.browser.frames : [shot.browser.camera]; studio.setSubjectPosition(shot.browser.subject); playing = performance.now();
    panel.querySelectorAll<HTMLInputElement>('input[type=number]').forEach((input, i) => input.value = String(shot.browser.subject[i]));
    status.textContent = 'Restored browser shot';
  }).catch(e => status.textContent = e.message);
  return () => {
    const now = performance.now();
    if (recording) { const t = Math.min(60, (now - started) / 1000); if (!frames.length || t - frames[frames.length - 1].t >= 1 / 24) frames.push(frame(t)); if (t >= 60) stop(); }
    if (!Number.isNaN(playing) && frames.length) {
      const t = Math.min((now - playing) / 1000, frames[frames.length - 1].t);
      const b = frames.findIndex(f => f.t >= t), right = frames[b < 0 ? frames.length - 1 : b], left = frames[Math.max(0, b - 1)];
      const u = right.t === left.t ? 0 : (t - left.t) / (right.t - left.t);
      studio.setCameraPosition(new THREE.Vector3().fromArray(left.p).lerp(new THREE.Vector3().fromArray(right.p), u));
      studio.pov.quaternion.fromArray(left.q).slerp(new THREE.Quaternion().fromArray(right.q), u);
      studio.setFocalLength(left.mm + (right.mm - left.mm) * u);
    }
  };
}
