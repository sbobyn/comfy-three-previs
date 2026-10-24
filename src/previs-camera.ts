import * as THREE from 'three';
import type { Studio } from './scene';
import { browserDelivery, browserVideoPlan } from '../shared/browser-delivery.mjs';
export type CameraFrame = { t: number; p: number[]; q: number[]; mm: number };

export function shortCameraMove(kind: string, subject: number[], mm: number): CameraFrame[] {
  const target = new THREE.Vector3().fromArray(subject);
  const start = target.clone().add(new THREE.Vector3(-3, kind === 'crane' ? -1 : 0, 12));
  const end = target.clone().add(new THREE.Vector3(3, kind === 'crane' ? 3 : 0, kind === 'crane' ? 10 : 12));
  const camera = new THREE.PerspectiveCamera();
  return Array.from({ length: 72 }, (_, index) => {
    camera.position.lerpVectors(start, end, index / 71); camera.lookAt(target);
    return { t: index / 24, p: camera.position.toArray(), q: camera.quaternion.toArray(), mm };
  });
}

// The existing camera controller owns operation. This adapter captures its resolved
// camera and supplies saved playback after that controller has updated each frame.
export function installPrevisCamera(studio: Studio, adoptCamera: (frame: CameraFrame) => void): () => void {
  const panel = document.createElement('div');
  panel.className = 'previs-camera';
  const title = document.createElement('input'); title.value = 'Camera study'; title.setAttribute('aria-label', 'Previs shot title');
  const record = document.createElement('button'); record.textContent = 'Record shot';
  const play = document.createElement('button'); play.textContent = 'Replay motion';
  const timeline = document.createElement('input'); timeline.type = 'range'; timeline.min = '0'; timeline.max = '0'; timeline.step = String(1 / 24); timeline.setAttribute('aria-label', 'Recorded motion time');
  const position = document.createElement('output'); position.setAttribute('aria-label', 'Current camera'); position.setAttribute('aria-live','off');
  const exportVideo = document.createElement('button'); exportVideo.textContent = 'Export saved motion video';
  const workflowLink = document.createElement('a'); workflowLink.hidden = true; workflowLink.className = 'button-link primary';
  const preset = document.createElement('select'); preset.setAttribute('aria-label', 'Short camera move');
  for (const [value,text] of [['dolly','Three-second dolly · 72 frames'],['crane','Three-second crane · 72 frames']]) { const o=document.createElement('option');o.value=value;o.textContent=text;preset.append(o); } preset.value='dolly';
  const usePreset = document.createElement('button'); usePreset.textContent = 'Use short move';
  const resolution = document.createElement('select'); resolution.setAttribute('aria-label', 'Delivery resolution');
  for (const [value,text] of [['640','640×360 · lightweight'],['1280','1280×720 · Kling input']]) { const o=document.createElement('option');o.value=value;o.textContent=text;resolution.append(o); } resolution.value='640';
  const save = document.createElement('button'); save.textContent = 'Save new shot & beauty';
  const savedDetail=document.createElement('small');savedDetail.setAttribute('aria-label','Saved export source');
  const status = document.createElement('span'); status.textContent = 'Browser scene · no Blender required';
  const inspector = document.createElement('div'); inspector.className='camera-controls';
  const heading=document.createElement('h2');heading.textContent='Shot inspector';
  const labelled=(text:string,control:HTMLElement)=>{const label=document.createElement('label');label.textContent=text;label.append(control);return label;};
  inspector.append(heading,labelled('Shot title',title));
  const subjectFields=document.createElement('div');subjectFields.className='frames';
  for (const [axis, index] of [['X', 0], ['Y', 1], ['Z', 2]] as const) {
    const label = document.createElement('label'); label.textContent = 'Subject ' + axis;
    const input = document.createElement('input'); input.type = 'number'; input.step = '0.5'; input.value = String(studio.subjectPosition()[index]); input.setAttribute('aria-label', 'Subject ' + axis);
    input.oninput = () => { const p = studio.subjectPosition(); p[index] = Number(input.value); studio.setSubjectPosition(p); };
    label.append(input); subjectFields.append(label);
  }
  const delivery = document.createElement('small'); delivery.setAttribute('aria-label','Delivery plan');
  inspector.append(subjectFields,labelled('Short camera move',preset),usePreset,labelled('Delivery resolution',resolution),save,exportVideo,workflowLink,delivery);
  const provenance=document.createElement('details'),summary=document.createElement('summary');summary.textContent='Saved export source · Advanced';provenance.append(summary,savedDetail);inspector.append(provenance);
  const transport=document.createElement('div');transport.className='motion-transport';
  const transportButtons=document.createElement('div');transportButtons.className='row';transportButtons.append(record,play);
  const transportReadout=document.createElement('div');transportReadout.className='transport-readout';transportReadout.append(status,position);
  status.setAttribute('role','status');timeline.setAttribute('title','Scrub saved camera motion');
  transport.append(transportButtons,timeline,transportReadout);
  save.className='primary';exportVideo.className='export-action';
  panel.append(inspector,transport);document.body.append(panel);
  // Keep the adapter usable without page mounts (including agent simulations).
  document.getElementById?.('previsMount')?.append(inspector);document.getElementById?.('motionMount')?.append(transport);
  let savedShotId: string | undefined;
  const showSaved = (shot:any,revision:number) => {savedDetail.textContent=`Export source: saved shot ${shot.id.slice(0,8)} · saved at revision ${shot.createdRevision??'not recorded'} · opened project revision ${revision}. Export always uses this saved scene, subject and camera motion. Live pose/subject edits are not included; save a new shot to capture changes.`;};
  let exporting = false;
  let frames: CameraFrame[] = [], recording = false, started = 0, playing = false, playhead = 0, previousTime = performance.now();
  const frame = (t: number): CameraFrame => ({ t, p: studio.pov.position.toArray(), q: studio.pov.quaternion.toArray(), mm: studio.pov.getFocalLength() });
  const duration = () => frames.at(-1)?.t || 0;
  const selectedDelivery = () => browserDelivery({width:Number(resolution.value),height:Number(resolution.value)*9/16,fps:24});
  const showDelivery = () => {
    const settings=selectedDelivery();
    try { const plan=browserVideoPlan(frames,settings); delivery.textContent=`Delivery: ${plan.width}×${plan.height} · 16:9 · 24 fps · ${plan.frameCount} frames · ${plan.duration.toFixed(6)} s. Motion samples 0–${plan.recordedDuration.toFixed(6)} s; final export sample ${plan.sampledEndTime.toFixed(6)} s. Each frame lasts 1/24 s. Format guides only; delivery is always 16:9.`; }
    catch(e) { delivery.textContent=`Delivery: ${settings.width}×${settings.height} · 16:9 · 24 fps. ${(e as Error).message}`; }
  };
  const syncTransport = () => { timeline.max = String(duration()); timeline.value = String(playhead); play.disabled = frames.length < 2 || recording; play.textContent = playing ? 'Pause replay' : 'Replay motion'; showDelivery(); };
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
  resolution.onchange = () => {showDelivery();status.textContent='Delivery changed. Save a new shot before exporting; existing captures keep their original settings.';};
  usePreset.onclick = () => {
    stop(); pause(); frames=shortCameraMove(preset.value,studio.subjectPosition(),studio.pov.getFocalLength());playhead=0;savedShotId=undefined;workflowLink.hidden=true;savedDetail.textContent='Unsaved take · Replay → Save new shot → Reopen → Export saved motion. Existing captures stay unchanged.';
    adoptCamera(frames[0]);apply(frames[0]);title.value=preset.value==='crane'?'Three-second crane':'Three-second dolly';syncTransport();status.textContent='Short move ready · Replay, then save a new shot. No existing shot was changed.';
  };
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
      const response = await fetch('/api/browser-shot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: current.project.revision, title: title.value, camera: frame(0), frames, subject: studio.subjectPosition(), delivery:selectedDelivery(), png: studio.capture().split(',')[1] }) });
      const result = await response.json(); if (!response.ok) throw Error(result.error);
      savedShotId = result.project.shots.at(-1).id;showSaved(result.project.shots.at(-1),result.project.revision);
      workflowLink.href='/index.html?shot='+savedShotId;workflowLink.textContent='Reopen saved shot';workflowLink.hidden=false;
      status.textContent = `Saved · ${frames.length} motion samples · beauty PNG`;
    } catch (e) { status.textContent = (e as Error).message; } finally { save.disabled = false; }
  };
  const shotId = new URLSearchParams(location.search).get('shot');
  if (shotId) void fetch('/api/project').then(r => r.json()).then(({ project }) => {
    const shot = project.shots.find((s: { id: string }) => s.id === shotId);
    if (!shot || shot.binding.source !== 'three') throw Error('Browser shot unavailable');
    savedShotId = shot.id;showSaved(shot,project.revision); title.value = shot.title; frames = shot.browser.frames; resolution.value=String(browserDelivery(shot.browser.delivery).width);studio.setSubjectPosition(shot.browser.subject); adoptCamera(shot.browser.camera); apply(shot.browser.camera); syncTransport();
    inspector.querySelectorAll<HTMLInputElement>('input[type=number]').forEach((input, i) => input.value = String(shot.browser.subject[i]));
    status.textContent = 'Restored browser shot';
  }).catch(e => status.textContent = e.message);
  exportVideo.onclick = async () => {
    if (!savedShotId) { status.textContent = 'Save a short recorded shot first.'; return; }
    stop(); pause(); exporting = true;
    const exportStarted = performance.now();
    const controls = Array.from(document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select'));
    const disabled = controls.map(c => c.disabled); controls.forEach(c => c.disabled = true);
    let stageId: string | undefined;
    const original = frame(0), originalSubject = studio.subjectPosition(), originalFrames = frames;
    try {
      const current = await (await fetch('/api/project')).json();
      const shot = current.project.shots.find((s: {id: string}) => s.id === savedShotId);
      if (!shot?.browser?.frames?.length) throw Error('Saved shot needs recorded motion.');
      // Export the immutable saved motion, independent of controller and wall-clock updates.
      const exportFrames: CameraFrame[] = structuredClone(shot.browser.frames), exportSubject = [...shot.browser.subject];
      const plan=browserVideoPlan(exportFrames,shot.browser.delivery), chosen=selectedDelivery();
      if(chosen.width!==plan.width||chosen.height!==plan.height)throw Error('Delivery differs from the saved shot. Save a new shot with these delivery settings before exporting.');
      const {fps,frameCount:count,width,height,recordedDuration}=plan;
      status.textContent = `Sampling ${count} frames at ${fps} fps from saved motion; encoded duration ${(count / fps).toFixed(3)}s, recording ${recordedDuration.toFixed(3)}s.`;
      const post = async (path: string, body: unknown) => { const r = await fetch('/api/video/browser/' + path, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); const data=await r.json(); if(!r.ok) throw Error(data.error); return data; };
      const { stage } = await post('start', {revision:current.project.revision,shotId:savedShotId,width,height,fps,frameCount:count});
      stageId = stage.id;
      for (let i = 0; i < count; i++) {
          studio.setSubjectPosition(exportSubject); apply(poseAt(i / fps, exportFrames));
          const png = studio.capture(width,height).split(',')[1];
          await post('frame',{stageId:stage.id,index:i,png});
          status.textContent = `Exporting saved camera frame ${i + 1}/${count}`;
        }
        const { asset } = await post('finish',{stageId:stage.id});
        workflowLink.href=`/generation.html?shot=${savedShotId}&asset=${asset.id}`;workflowLink.textContent='Use this exact video in a workflow →';workflowLink.hidden=false;
        savedDetail.textContent=`Exported immutable source ${asset.id} · version ${asset.version} · capture revision ${asset.requestRevision}. Live camera view is restored; open the workflow link to play the exact exported video.`;
        status.textContent = `Video saved: ${asset.frameCount} frames · ${asset.duration}s · ${width}×${height}. Export took ${((performance.now()-exportStarted)/1000).toFixed(1)} s. Open video workflows to review.`;
    } catch(e) { status.textContent = (e as Error).message; }
    finally {
      if (stageId) await fetch('/api/video/browser/abort', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({stageId})}).catch(() => {});
      controls.forEach((c,i) => c.disabled = disabled[i]);
      frames = originalFrames; studio.setSubjectPosition(originalSubject); adoptCamera(original); apply(original); exporting=false; exportVideo.disabled=false; }
  };
  if(new URLSearchParams(location.search).get('starter')==='dolly-3s'&&!shotId)void Promise.resolve().then(()=>{resolution.value='1280';usePreset.click();});
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
