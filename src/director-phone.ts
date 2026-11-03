import './director-phone.css';
import { api, h, toast } from './director-common';
import { registerAimSource, createAimSource, type AimSource, type Quat } from './director-aim';
import { PhoneAim, withBaseYaw, yawToward, yawOf, pitchOf, type PhoneButton } from './director-phone-core';
import { defaultSettings } from './smoothing';
import { relayUrl } from './protocol';
import { qrSvg } from './qr';

export { withBaseYaw, yawToward } from './director-phone-core';

/**
 * Phone aim source for the Director. The phone page (phone.html, served only on
 * the optional HTTPS LAN listener) streams device orientation through the
 * loopback relay at /vcam; this page joins as a viewer, claims the phone, and
 * turns the samples into a smoothed, yaw-zeroed camera orientation.
 *
 * orientation() follows the AimSource contract: a world-space camera quaternion.
 * At re-zero the phone's heading maps to "looking down world -Z"; pitch and roll
 * stay absolute (gravity). Rotate it with withBaseYaw() to aim along a shot.
 */

type Rig = { pos: [number, number, number]; mm: number | null; recording: boolean };

class PhoneLink {
  readonly aim = new PhoneAim(defaultSettings());
  private socket: WebSocket | null = null;
  private users = 0;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private timers: ReturnType<typeof setInterval>[] = [];
  private readonly listeners = new Set<(b: PhoneButton) => void>();
  rig: Rig = { pos: [0, 1.6, 6], mm: null, recording: false };

  acquire() { if (this.users++ === 0) this.open(); }
  release() { if (--this.users === 0) this.close(); }
  onButton(cb: (b: PhoneButton) => void) { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; }

  private send(message: unknown) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message)); }

  private open() {
    const ws = new WebSocket(relayUrl('viewer'));
    this.socket = ws;
    ws.onopen = () => { this.aim.socketOpen = true; this.send({ t: 'claim' }); this.sendRig(); };
    ws.onmessage = event => {
      const button = this.aim.receive(String(event.data), performance.now());
      if (button) for (const cb of this.listeners) cb(button);
    };
    ws.onclose = () => {
      if (this.socket !== ws) return;
      this.socket = null;
      this.aim.disconnected();
      if (this.users > 0) this.retry = setTimeout(() => this.open(), 1000);
    };
    // The phone pauses itself if it hears nothing from the desktop for 2 s.
    this.timers = [
      setInterval(() => this.sendRig(), 250),
      setInterval(() => this.send({ t: 'ping', id: this.aim.ping(performance.now()) }), 1000),
    ];
  }

  private close() {
    clearTimeout(this.retry);
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    const ws = this.socket; this.socket = null; ws?.close();
    this.aim.disconnected();
  }

  private sendRig() {
    const aim = this.aim.orientation(performance.now());
    this.send({
      t: 'rig', mode: 'director', pos: this.rig.pos, aim, format: null, settings: this.aim.settings,
      controls: { enabled: true, recording: this.rig.recording },
      ...(this.rig.mm ? { mm: this.rig.mm } : {}),
    });
  }
}

let link: PhoneLink | null = null;
const shared = () => (link ??= new PhoneLink());

/** True while a paired phone is streaming its orientation. */
export function phoneConnected() { return !!link && link.aim.connected(); }

/** Tells the phone what the desktop is doing (camera position, lens, recording) for its buttons/readout. */
export function setPhoneRig(rig: Partial<Rig>) { Object.assign(shared().rig, rig); }

registerAimSource('phone', (): AimSource => {
  const l = shared();
  l.acquire();
  let disposed = false;
  return {
    id: 'phone',
    label: 'Phone',
    connected: () => l.aim.connected(),
    status: () => l.aim.status(performance.now()),
    orientation: () => l.aim.orientation(performance.now()),
    rezero: () => l.aim.rezero(),
    lensMm: () => l.aim.lensMm(),
    onButton: cb => l.onButton(cb),
    dispose: () => { if (!disposed) { disposed = true; l.release(); } },
  };
});

// ---------- Pairing dialog ----------

type Readiness = { available: boolean; error: string | null; paired: boolean; expiresAt?: string | null; ca?: boolean };
let pairing: { url: string; expiresAt: string } | null = null;

const deg = (r: number) => `${((r * 180) / Math.PI).toFixed(1)}°`;
function qrBox(text: string, caption: string) {
  const box = h('figure', { class: 'phone-qr' });
  try { box.innerHTML = qrSvg(text, 4); } catch { box.append(h('div', { class: 'muted' }, 'Link too long for a QR code')); }
  box.append(h('figcaption', {}, caption));
  return box;
}
const PHONE_DOC = 'https://github.com/sbobyn/comfy-three-previs/blob/main/docs/director-phone.md';
const codeBox = (text: string) => h('div', { class: 'code' }, text, copyButton(text));
function copyButton(text: string) {
  const b = h('button', { class: 'btn sm', type: 'button' }, 'Copy');
  b.onclick = async () => { await navigator.clipboard.writeText(text).then(() => { b.textContent = 'Copied'; }, () => { b.textContent = 'Copy failed'; }); setTimeout(() => (b.textContent = 'Copy'), 1400); };
  return b;
}

export function openPhonePairing() {
  document.getElementById('phone-dialog')?.remove();
  const l = shared();
  l.acquire();
  const pairArea = h('div', { class: 'phone-pair' });
  const statusRows: Record<string, HTMLElement> = {};
  const row = (key: string, label: string) => { statusRows[key] = h('span', { class: 'mono' }, '—'); return h('div', { class: 'phone-stat' }, h('span', { class: 'muted' }, label), statusRows[key]); };
  const dot = h('span', { class: 'dot' });
  const pill = h('span', { class: 'pill' }, dot, h('span', {}, 'Phone'));
  const rezero = h('button', { class: 'btn sm', type: 'button', onclick: () => { l.aim.rezero(); toast('Phone re-zeroed: its current heading is now straight ahead'); } }, 'Re-zero');

  async function render() {
    let ready: Readiness;
    try { ready = await api<Readiness>('phone'); } catch (e) { pairArea.replaceChildren(h('p', { class: 'note' }, (e as Error).message)); return; }
    if (!ready.paired) pairing = null;
    if (!ready.available) {
      pairArea.replaceChildren(
        h('p', { class: 'note' }, ready.error || 'Phone HTTPS is not available.'),
        h('p', { class: 'muted', style: 'margin:0' }, 'The phone needs its own HTTPS address on your Wi‑Fi. One-time setup on this Mac (creates new local files only, changes no trust settings):'),
        codeBox('node scripts/phone-certificate.mjs ./phone-cert YOUR_MAC_LAN_IP'),
        h('p', { class: 'muted', style: 'margin:0' }, 'Then add these to .env and restart Comfy Previs:'),
        codeBox('PREVIS_PHONE_HOST=YOUR_MAC_LAN_IP\nPREVIS_PHONE_PORT=5443\nPREVIS_PHONE_CERT=/abs/path/server.crt\nPREVIS_PHONE_KEY=/abs/path/server.key\nPREVIS_PHONE_CA=/abs/path/ca.crt'),
        h('p', { class: 'muted', style: 'margin:0' }, 'Step by step: ', h('a', { href: PHONE_DOC, target: '_blank', rel: 'noreferrer' }, 'Phone camera guide ↗')));
      return;
    }
    if (!pairing) {
      pairArea.replaceChildren(
        h('p', { class: 'muted', style: 'margin:0' }, 'Create a private link for your phone. Creating a new link disconnects any phone that is already paired.'),
        h('div', {}, h('button', { class: 'btn primary', type: 'button', onclick: create }, 'Create phone link')));
      return;
    }
    const caUrl = new URL('/phone-ca.crt', pairing.url).href;
    pairArea.replaceChildren(
      h('div', { class: 'phone-qrs' },
        ready.ca ? qrBox(caUrl, '1 · Certificate (first time only)') : null,
        qrBox(pairing.url, ready.ca ? '2 · Phone camera link' : 'Phone camera link')),
      h('div', { class: 'code phone-link' }, pairing.url, copyButton(pairing.url)),
      ready.ca ? h('div', { class: 'phone-line' }, h('a', { href: caUrl, target: '_blank', rel: 'noreferrer' }, 'CA certificate (ca.crt)'), h('span', { class: 'muted' }, '— open on the phone, or AirDrop the ca.crt file')) : h('p', { class: 'note', style: 'margin:0' }, 'PREVIS_PHONE_CA is not set, so the certificate is not served here. AirDrop your ca.crt to the phone.'),
      h('div', { class: 'phone-line' },
        h('span', { class: 'muted' }, `Pairing lasts eight hours (until ${new Date(pairing.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}) or until you stop it. Keep the link private.`),
        h('button', { class: 'btn ghost sm', type: 'button', onclick: create }, 'New link'),
        h('button', { class: 'btn ghost sm', type: 'button', onclick: revoke }, 'Stop pairing')));
  }
  async function create() {
    try { pairing = await api<{ url: string; expiresAt: string }>('phone/pair', {}); } catch (e) { toast((e as Error).message, true); }
    void render();
  }
  async function revoke() {
    try { await api('phone/revoke', {}); pairing = null; toast('Phone pairing stopped'); } catch (e) { toast((e as Error).message, true); }
    void render();
  }

  function tick() {
    const now = performance.now(), aim = l.aim, stats = aim.stats(now), motion = aim.motion(now), q = aim.orientation(now);
    pill.classList.toggle('on', motion === 'streaming');
    pill.classList.toggle('wait', aim.connected() && motion !== 'streaming');
    statusRows.status.textContent = aim.status(now);
    statusRows.phone.textContent = !aim.socketOpen ? 'desktop link offline' : aim.phonePresent ? 'connected' : 'not connected';
    statusRows.motion.textContent = motion === 'none' ? (aim.phonePresent ? 'waiting for Enable motion' : '—') : motion;
    statusRows.age.textContent = stats.lastSampleAge === null ? '—' : stats.lastSampleAge < 1000 ? `${Math.round(stats.lastSampleAge)} ms` : `${(stats.lastSampleAge / 1000).toFixed(1)} s`;
    statusRows.rate.textContent = stats.rate ? `${stats.rate} Hz · jitter ${Number.isNaN(stats.jitter) ? '—' : stats.jitter.toFixed(1) + ' ms'}` : '—';
    statusRows.latency.textContent = Number.isNaN(stats.halfRtt) ? '—' : `${stats.halfRtt.toFixed(1)} ms one-way`;
    statusRows.aim.textContent = q ? `yaw ${deg(yawOf(q))} · pitch ${deg(pitchOf(q))}` : '—';
    statusRows.lens.textContent = aim.lensMm() ? `${Math.round(aim.lensMm()!)} mm` : '—';
    rezero.disabled = !q;
  }

  const dlg = h('dialog', { id: 'phone-dialog', class: 'phone-dialog', 'aria-labelledby': 'phone-title' },
    h('div', { class: 'dialog-head' }, h('h2', { id: 'phone-title' }, 'Aim with your phone'), pill, h('button', { class: 'btn ghost sm icon', type: 'button', 'aria-label': 'Close', onclick: () => dlg.close() }, '✕')),
    h('div', { class: 'dialog-body' },
      h('p', { class: 'muted', style: 'margin:0' }, 'Hold your phone like a camera: its orientation aims the shot camera. Phone buttons re-zero, set the lens and start/stop recording. Only the phone camera page is reachable on your network — never your projects.'),
      pairArea,
      h('details', { class: 'phone-steps' }, h('summary', {}, 'iPhone setup steps'),
        h('ol', {},
          h('li', {}, 'Join the ', h('b', {}, 'same Wi‑Fi'), ' as this Mac.'),
          h('li', {}, h('b', {}, 'Install the certificate'), ' (first time only): scan code 1 in Safari. Safari warns because it is not trusted yet — tap Show Details → visit this website, then Allow the download. Or AirDrop ca.crt.'),
          h('li', {}, 'Settings → General → VPN & Device Management → ', h('b', {}, 'Install'), ' "Previs local phone CA".'),
          h('li', {}, 'Settings → General → About → Certificate Trust Settings → ', h('b', {}, 'turn on full trust'), ' for it.'),
          h('li', {}, 'Scan code 2 (or ', h('b', {}, 'reload'), ' the phone page if it was already open).'),
          h('li', {}, 'Tap ', h('b', {}, 'Enable motion + touch'), ' and allow Motion & Orientation access.'),
          h('li', {}, 'Point the phone where the shot should look and tap ', h('b', {}, 'Re-zero'), '.'))),
      h('section', { class: 'phone-status' },
        h('div', { class: 'phone-status-head' }, h('span', { class: 'eyebrow' }, 'Live status'), rezero),
        row('status', 'Status'), row('phone', 'Phone'), row('motion', 'Motion'), row('age', 'Last sample'), row('rate', 'Rate'), row('latency', 'Latency'), row('aim', 'Aim'), row('lens', 'Phone lens'))));
  const timer = setInterval(tick, 250);
  dlg.addEventListener('close', () => { clearInterval(timer); l.release(); dlg.remove(); });
  document.body.append(dlg);
  dlg.showModal();
  tick();
  void render();
}

// ---------- Demo hook (live preview only, never recorded) ----------

type PreviewScene = {
  pose(): { p: [number, number, number]; look: [number, number, number]; mm: number };
  setAimOverride(q: Quat | null, mm?: number | null): void;
};

/**
 * Adds "Phone…" and "Look with phone" to a toolbar. While on, the shot camera
 * view follows the phone; re-zero points it along the shot's own heading.
 */
export function installPhoneDemo(toolbar: HTMLElement, scene: PreviewScene, showCamera: () => void) {
  let source: AimSource | null = null, off: (() => void) | null = null, baseYaw = 0, frame = 0;
  const chip = h('span', { class: 'phone-chip', hidden: true, role: 'status' });
  const look = h('button', { class: 'btn sm', type: 'button', 'aria-pressed': 'false', title: 'Look with phone: the shot camera view follows your phone (live preview, not recorded)', 'aria-label': 'Look with phone' }, 'Aim');
  const captureBase = () => { const p = scene.pose(); baseYaw = yawToward(p.p, p.look); };
  const loop = () => {
    frame = requestAnimationFrame(loop);
    if (!source) return;
    const q = source.orientation(), p = scene.pose();
    setPhoneRig({ pos: p.p, mm: source.lensMm?.() ?? p.mm });
    scene.setAimOverride(q ? withBaseYaw(q, baseYaw) : null, q ? source.lensMm?.() ?? null : null);
    chip.textContent = q ? `Phone · yaw ${deg(yawOf(q))} · pitch ${deg(pitchOf(q))}` : source.status();
    chip.classList.toggle('live', !!q);
  };
  const stop = () => { cancelAnimationFrame(frame); off?.(); source?.dispose(); source = null; scene.setAimOverride(null); chip.hidden = true; look.setAttribute('aria-pressed', 'false'); look.classList.remove('on'); };
  look.onclick = () => {
    if (source) return stop();
    source = createAimSource('phone')!;
    captureBase();
    off = source.onButton?.(b => { if (b === 'rezero') { captureBase(); toast('Phone re-zeroed'); } else toast('Phone Record: use Fly settings in the Camera section to record a take'); }) ?? null;
    look.setAttribute('aria-pressed', 'true'); look.classList.add('on'); chip.hidden = false;
    showCamera();
    loop();
  };
  // Compact group so the viewport toolbar stays on one row: [Phone | Aim] + live status chip.
  toolbar.append(h('div', { class: 'phone-group' }, h('button', { class: 'btn sm', type: 'button', title: 'Pair a phone to aim the camera', onclick: () => openPhonePairing() }, 'Phone'), look), chip);
}
