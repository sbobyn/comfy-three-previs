import * as THREE from 'three';
import type { Studio } from './scene';
export type CameraFrame = { t: number; p: number[]; q: number[]; mm: number };

// The existing camera controller owns operation. This adapter captures its resolved
// camera and supplies saved playback after that controller has updated each frame.
export function installPrevisCamera(studio: Studio, adoptCamera: (frame: CameraFrame) => void): () => void {
  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;top:12px;left:280px;right:12px;z-index:30;background:#15212ef2;padding:12px;border:1px solid #6b8ca8;border-radius:8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;color:#eee;font:13px system-ui';
  const link = document.createElement('a'); link.href = '/'; link.textContent = '← Previs shots'; link.style.color = '#b4dbf7';
  const title = document.createElement('input'); title.value = 'Camera study'; title.setAttribute('aria-label', 'Previs shot title');
  const record = document.createElement('button'); record.textContent = 'Record shot';
  const play = document.createElement('button'); play.textContent = 'Replay motion';
  const timeline = document.createElement('input'); timeline.type = 'range'; timeline.min = '0'; timeline.max = '0'; timeline.step = String(1 / 24); timeline.setAttribute('aria-label', 'Recorded motion time');
  const position = document.createElement('output'); position.setAttribute('aria-label', 'Current camera');
  const exportVideo = document.createElement('button'); exportVideo.textContent = 'Export saved motion video';
  const save = document.createElement('button'); save.textContent = 'Save new shot & beauty';
  const status = document.createElement('span'); status.textContent = 'Browser scene · no Blender required';
  panel.append(link, title);
  for (const [axis, index] of [['X', 0], ['Y', 1], ['Z', 2]] as const) {
    const label = document.createElement('label'); label.textContent = 'Subject ' + axis;
    const input = document.createElement('input'); input.type = 'number'; input.step = '0.5'; input.style.width = '60px'; input.value = String(studio.subjectPosition()[index]); input.setAttribute('aria-label', 'Subject ' + axis);
    input.oninput = () => { const p = studio.subjectPosition(); p[index] = Number(input.value); studio.setSubjectPosition(p); };
    label.append(input); panel.append(label);
  }
  panel.append(record, play, timeline, save, exportVideo, status, position); document.body.append(panel);
  let savedShotId: string | undefined;
  let exporting = false;
  let frames: CameraFrame[] = [], recording = false, started = 0, playing = false, playhead = 0, previousTime = performance.now();
  const frame = (t: number): CameraFrame => ({ t, p: studio.pov.position.toArray(), q: studio.pov.quaternion.toArray(), mm: studio.pov.getFocalLength() });
  const duration = () => frames.at(-1)?.t || 0;
  const syncTransport = () => { timeline.max = String(duration()); timeline.value = String(playhead); play.disabled = frames.length < 2 || recording; play.textContent = playing ? 'Pause replay' : 'Replay motion'; };
  function poseAt(time: number, samples = frames): CameraFrame {
    if (time <= samples[0].t) return { ...samples[0], t: time };
    if (time >= samples[samples.length - 1].t) return { ...samples[samples.length - 1], t: time };
    const next = samples.findIndex(f => f.t >= time);
    const right = samples[next], left = samples[next - 1];
    const u = (time - left.t) / (right.t - left.t);
    return { t: time, p: new THREE.Vector3().fromArray(left.p).lerp(new THREE.Vector3().fromArray(right.p), u).toArray(), q: new THREE.Quaternion().fromArray(left.q).slerp(new THREE.Quaternion().fromArray(right.q), u).toArray(), mm: left.mm + (right.mm - left.mm) * u };
  }
  function apply(pose: CameraFrame) { studio.setCameraPosition(new THREE.Vector3().fromArray(pose.p)); studio.pov.quaternion.fromArray(pose.q); studio.setFocalLength(pose.mm); }
  const stop = () => {
    if (recording) { const t = Math.min(60, (performance.now() - started) / 1000); if (t > (frames.at(-1)?.t || 0)) frames.push(frame(t)); }
    recording = false; record.textContent = 'Record shot'; syncTransport();
  };
  const pause = () => { if (playing && frames.length) adoptCamera(poseAt(playhead)); playing = false; syncTransport(); };
  record.onclick = () => {
    if (recording) { stop(); return; }
    pause(); frames = [frame(0)]; playhead = 0; recording = true; started = performance.now(); record.textContent = 'Stop shot'; syncTransport();
  };
  play.onclick = () => { stop(); if (playing) pause(); else { playhead = 0; playing = true; previousTime = performance.now(); syncTransport(); } };
  timeline.oninput = () => { const selectedTime = Number(timeline.value); stop(); playing = false; playhead = selectedTime; if (frames.length) { const pose = poseAt(playhead); adoptCamera(pose); apply(pose); } syncTransport(); };
  save.onclick = async () => {
    stop(); pause(); save.disabled = true;
    try {
      const current = await (await fetch('/api/project')).json();
      const response = await fetch('/api/browser-shot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: current.project.revision, title: title.value, camera: frame(0), frames, subject: studio.subjectPosition(), png: studio.capture().split(',')[1] }) });
      const result = await response.json(); if (!response.ok) throw Error(result.error);
      savedShotId = result.project.shots.at(-1).id;
      status.textContent = `Saved · ${frames.length} motion samples · beauty PNG`;
    } catch (e) { status.textContent = (e as Error).message; } finally { save.disabled = false; }
  };
  const shotId = new URLSearchParams(location.search).get('shot');
  if (shotId) void fetch('/api/project').then(r => r.json()).then(({ project }) => {
    const shot = project.shots.find((s: { id: string }) => s.id === shotId);
    if (!shot || shot.binding.source !== 'three') throw Error('Browser shot unavailable');
    savedShotId = shot.id; title.value = shot.title; frames = shot.browser.frames; studio.setSubjectPosition(shot.browser.subject); adoptCamera(shot.browser.camera); apply(shot.browser.camera); syncTransport();
    panel.querySelectorAll<HTMLInputElement>('input[type=number]').forEach((input, i) => input.value = String(shot.browser.subject[i]));
    status.textContent = 'Restored browser shot';
  }).catch(e => status.textContent = e.message);
  exportVideo.onclick = async () => {
    if (!savedShotId) { status.textContent = 'Save a short recorded shot first.'; return; }
    stop(); pause(); exporting = true;
    const controls = Array.from(panel.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button'));
    const disabled = controls.map(c => c.disabled); controls.forEach(c => c.disabled = true);
    let stageId: string | undefined;
    const original = frame(0), originalSubject = studio.subjectPosition(), originalFrames = frames;
    try {
      const current = await (await fetch('/api/project')).json();
      const shot = current.project.shots.find((s: {id: string}) => s.id === savedShotId);
      if (!shot?.browser?.frames?.length) throw Error('Saved shot needs recorded motion.');
      // Export the immutable saved motion, independent of controller and wall-clock updates.
      const exportFrames: CameraFrame[] = structuredClone(shot.browser.frames), exportSubject = [...shot.browser.subject];
      const recordedDuration = exportFrames[exportFrames.length - 1].t;
      const fps = 24, count = Math.floor(recordedDuration * fps) + 1;
      status.textContent = `Sampling ${count} frames at ${fps} fps from saved motion; encoded duration ${(count / fps).toFixed(3)}s, recording ${recordedDuration.toFixed(3)}s.`;
      const post = async (path: string, body: unknown) => { const r = await fetch('/api/video/browser/' + path, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); const data=await r.json(); if(!r.ok) throw Error(data.error); return data; };
      const { stage } = await post('start', {revision:current.project.revision,shotId:savedShotId,width:640,height:360,fps,frameCount:count});
      stageId = stage.id;
      for (let i = 0; i < count; i++) {
          studio.setSubjectPosition(exportSubject); apply(poseAt(i / fps, exportFrames));
          const png = studio.capture(640,360).split(',')[1];
          await post('frame',{stageId:stage.id,index:i,png});
          status.textContent = `Exporting saved camera frame ${i + 1}/${count}`;
        }
        const { asset } = await post('finish',{stageId:stage.id});
        status.textContent = `Video saved: ${asset.frameCount} frames · ${asset.duration}s. Open video workflows to review.`;
    } catch(e) { status.textContent = (e as Error).message; }
    finally {
      if (stageId) await fetch('/api/video/browser/abort', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({stageId})}).catch(() => {});
      controls.forEach((c,i) => c.disabled = disabled[i]);
      frames = originalFrames; studio.setSubjectPosition(originalSubject); adoptCamera(original); apply(original); exporting=false; exportVideo.disabled=false; }
  };
  syncTransport();
  return () => {
    if (exporting) return;
    const now = performance.now(), dt = (now - previousTime) / 1000; previousTime = now;
    if (recording) {
      const t = Math.min(60, (now - started) / 1000);
      if (t - frames[frames.length - 1].t >= 1 / 24) frames.push(frame(t));
      playhead = t; timeline.max = String(t); timeline.value = String(t);
      status.textContent = `Recording ${t.toFixed(1)} s · ${frames.length} samples`;
      if (t >= 60) stop();
    }
    if (playing && frames.length) {
      playhead = Math.min(duration(), playhead + dt); const pose = poseAt(playhead); apply(pose); timeline.value = String(playhead);
      if (playhead >= duration()) { playing = false; adoptCamera(pose); syncTransport(); }
    }
    position.textContent = `Camera ${studio.pov.position.toArray().map(x => x.toFixed(2)).join(', ')} · ${studio.pov.getFocalLength().toFixed(1)} mm · ${playhead.toFixed(2)} s`;
    panel.dataset.camera = JSON.stringify(frame(playhead));
  };
}
