// Camera mode: this phone is the shot camera. A 'device' aim source (gyroscope) feeds Operate's aim pass;
// without motion (http origin, denied) it degrades to touch aim (drag to pan/tilt) through the 'pointer' source.
import * as THREE from 'three';
import { api, h, toast } from './director-common';
import { registerAimSource } from './director-aim';
import type { AimSource, Quat } from './director-aim';
import { requestMotionPermission, onDeviceQuaternion, applyGrip, YawZero } from './orientation';
import { fly } from './director-operate';
import { openSheet } from './director-mobile-sheet';
import type { MobileCtx } from './director-mobile';

let lastEvent = 0;
function deviceAimSource(): AimSource {
  const zero = new YawZero(), now = new THREE.Quaternion();
  let have = false, raw: THREE.Quaternion | null = null;
  const off = onDeviceQuaternion(q => { raw = applyGrip(q.clone(), 'portrait'); now.copy(raw); zero.apply(now); have = true; lastEvent = performance.now(); });
  return {
    id: 'device', label: 'This phone',
    connected: () => have,
    status: () => (have ? 'This phone · move it to aim' : 'Waiting for motion…'),
    orientation: (): Quat | null => (have ? [now.x, now.y, now.z, now.w] : null),
    rezero() { if (raw) { zero.capture(raw); now.copy(raw); zero.apply(now); } },
    dispose() { off(); },
  };
}
let registered = false;

/** Choose the Operate aim source through its own panel control (Operate reads its options once at load). */
function useSource(id: string) {
  fly.setDevice('phone');
  const sel = document.querySelector<HTMLSelectElement>('.op-panel select[aria-label="Operate source"]');
  if (sel && Array.from(sel.options).some(o => o.value === id)) { sel.value = id; sel.dispatchEvent(new Event('change')); return true; }
  return false;
}

export async function openCameraMode(c: MobileCtx) {
  if (document.querySelector('.m-camera')) return;
  if (!registered) { registerAimSource('device', deviceAimSource); registered = true; }
  const needsHttps = location.protocol !== 'https:' || !isSecureContext || typeof DeviceOrientationEvent === 'undefined';
  let motion = !needsHttps && await requestMotionPermission().catch(() => false);
  const step = c.step();
  if (step === 'cut') c.setStep('shoot');
  const s = c.shot(), n = String(c.project().shots.indexOf(s) + 1).padStart(2, '0');
  const rec = h('span', { class: 'm-cam-rec', role: 'status' }, h('i'), h('span', {}, 'AIM'));
  const link = h('span', { class: 'm-cam-link' });
  const lens = h('input', { type: 'range', min: 24, max: 135, step: 1, value: Math.round(s.camera.mm), 'aria-label': 'Lens focal length' });
  const lensOut = h('output', { class: 'mono' }, `${Math.round(s.camera.mm)} mm`);
  lens.oninput = () => { lensOut.textContent = `${lens.value} mm`; };
  lens.onchange = () => void c.edit([{ op: 'update_shot', id: s.id, patch: { camera: { mm: Number(lens.value) } } }]).catch(() => {});
  const shutter = h('button', { class: 'm-shutter', type: 'button', 'aria-label': 'Start recording the aim take' }, h('i'));
  const rezero = h('button', { class: 'm-btn m-cam-btn', type: 'button', 'aria-label': 'Re-zero: this direction is the shot’s start' }, 'Re-zero');
  const done = h('button', { class: 'm-btn m-cam-btn', type: 'button', 'aria-label': 'Done: leave camera mode' }, 'Done');
  const keep = h('button', { class: 'm-btn m-primary', type: 'button', 'aria-label': 'Keep this take as the shot camera' }, 'Keep');
  const again = h('button', { class: 'm-btn m-cam-btn', type: 'button', 'aria-label': 'Discard and record again' }, 'Again');
  const review = h('div', { class: 'm-cam-review', hidden: true }, h('span', {}, 'Take recorded · playing it back'), again, keep);
  const coach = h('div', { class: 'm-cam-coach', role: 'note' }, 'Point where the shot should start and tap Re-zero');
  const hud = h('div', { class: 'm-camera', role: 'dialog', 'aria-label': 'Camera mode' },
    h('div', { class: 'm-thirds', 'aria-hidden': 'true' }), h('div', { class: 'm-reticle', 'aria-hidden': 'true' }),
    h('div', { class: 'm-cam-top' }, rec, h('span', { class: 'm-cam-shot' }, `SHOT ${n} · ${s.title.toUpperCase()}`), link),
    coach,
    h('div', { class: 'm-cam-bottom' }, h('label', { class: 'm-cam-lens' }, h('span', {}, 'Lens'), lens, lensOut), review, h('div', { class: 'm-cam-ctl' }, rezero, shutter, done)));
  document.body.append(hud); document.body.classList.add('m-cam');
  c.setView('camera');
  let wake: { release(): Promise<void> } | null = null;
  try { wake = await (navigator as unknown as { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } }).wakeLock?.request('screen') || null; } catch {}
  try { await (screen.orientation as unknown as { lock?(o: string): Promise<void> }).lock?.('portrait'); } catch {}

  const engage = (src: string) => {
    if (fly.state().phase === 'live') fly.release();
    if (!useSource(src)) toast('Open the Shoot step once, then try again', true);
    fly.cycle(); // take control (armed): the viewfinder now follows this source
    link.textContent = src === 'device' ? 'GYRO' : 'TOUCH AIM';
    hud.classList.toggle('m-touchaim', src !== 'device');
  };
  const touchAim = () => { motion = false; engage('pointer'); coach.textContent = 'Drag to pan and tilt · the shutter records along the shot’s path'; };
  if (motion) {
    engage('device');
    setTimeout(() => { if (performance.now() - lastEvent > 1500 && document.body.contains(hud) && motion) { toast('No motion from this phone · using touch aim'); touchAim(); } }, 1600);
  } else {
    link.textContent = 'TOUCH AIM'; hud.classList.add('m-touchaim');
    const ready = await api<{ available: boolean; paired: boolean }>('phone').catch(() => ({ available: false, paired: false }));
    const pair = h('button', { class: 'm-btn', type: 'button', disabled: !ready.available }, 'Open the phone link');
    pair.onclick = async () => { try { const p = await api<{ url: string }>('phone/pair', {}); location.href = p.url; } catch (e) { toast((e as Error).message, true); } };
    const sh = openSheet({ title: 'Aiming with the gyroscope needs HTTPS', kind: 'action', cls: 'm-https', onClose: touchAim,
      body: [h('p', { class: 'm-note m-https' }, 'Phones only share motion with secure (https://) pages. This page is ', h('b', {}, location.origin), '. Touch aim works now: drag in the viewfinder to pan and tilt.'),
        h('p', { class: 'm-note' }, ready.available ? 'Or open the HTTPS phone link to use this phone as a camera remote for the session on your Mac.' : 'The HTTPS phone link is not set up on this server (see Setup on your Mac).')],
      foot: [pair, h('button', { class: 'm-btn m-primary', type: 'button', onclick: () => sh.close() }, 'Use touch aim')] });
  }

  shutter.onclick = () => { navigator.vibrate?.(12); if (fly.state().phase !== 'live') engage(motion ? 'device' : 'pointer'); fly.cycle(); coach.hidden = true; };
  rezero.onclick = () => { coach.hidden = true; if (motion) { fly.release(); engage('device'); } else engage('pointer'); toast('Re-zeroed: this is the start of the shot'); };
  const opBtn = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('.op-take button')).find(b => b.textContent === label);
  keep.onclick = () => { opBtn('Keep take')?.click(); review.hidden = true; };
  again.onclick = () => { opBtn('Discard')?.click(); review.hidden = true; engage(motion ? 'device' : 'pointer'); };
  const t0 = { at: 0 };
  let raf = 0;
  const tick = () => {
    const st = fly.state(), recording = st.rec === 'recording';
    if (recording && !t0.at) t0.at = performance.now(); if (!recording) t0.at = 0;
    rec.classList.toggle('on', recording);
    rec.lastElementChild!.textContent = recording ? `REC ${((performance.now() - t0.at) / 1000).toFixed(1)}` : st.phase === 'review' ? 'REVIEW' : 'AIM';
    shutter.classList.toggle('on', recording);
    shutter.setAttribute('aria-label', recording ? 'Stop recording' : 'Start recording the aim take');
    review.hidden = st.phase !== 'review' || !opBtn('Keep take');
    raf = requestAnimationFrame(tick);
  };
  tick();
  const close = () => {
    cancelAnimationFrame(raf);
    if (fly.state().phase === 'live') fly.release();
    hud.remove(); document.body.classList.remove('m-cam');
    void wake?.release().catch(() => {});
    try { (screen.orientation as unknown as { unlock?(): void }).unlock?.(); } catch {}
    c.setView(c.step() === 'build' ? 'set' : 'camera');
    removeEventListener('keydown', esc, true);
  };
  const esc = (ev: KeyboardEvent) => { if (ev.key === 'Escape' && !document.querySelector('dialog[open]')) { ev.stopImmediatePropagation(); close(); } };
  addEventListener('keydown', esc, true);
  done.onclick = close;
}
