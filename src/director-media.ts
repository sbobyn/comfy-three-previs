// Guide media: a before/after slider (blockout ↔ generated, image or video), a lazy looping clip and an
// annotated screenshot. Media lives in public/guide (captured by scripts/guide-media.mjs) and is
// addressed under the deploy base so the GitHub Pages demo works too.
import './director-explain.css';
import { h } from './director-common';
import { seamKey } from './director-desktop-core';

export type Callout = { label: string; x: number; y: number; w: number; h: number };
export type GuideEntry = { id: string; file: string; kind: 'video' | 'image'; label?: string; project?: string; shot?: string; asset?: string; capturedAt?: string; callouts?: Callout[] };

/** URL of a file in public/guide under the deploy base. */
export const guideUrl = (file: string) => `${import.meta.env.BASE_URL}guide/${file}`;

let manifest: Promise<Map<string, GuideEntry>> | null = null;
/** public/guide/manifest.json by id (empty when it is missing). */
export function guideManifest() {
  return (manifest ||= fetch(guideUrl('manifest.json')).then(r => (r.ok ? r.json() : { entries: [] })).catch(() => ({ entries: [] }))
    .then((m: { entries?: GuideEntry[] }) => new Map((m.entries || []).map(e => [e.id, e]))));
}

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
/** Calls cb(true/false) as el enters or leaves the viewport (true at once when unsupported). */
function onVisible(el: Element, cb: (on: boolean) => void) {
  if (typeof IntersectionObserver !== 'function') { cb(true); return () => {}; }
  const io = new IntersectionObserver(es => { for (const e of es) cb(e.isIntersecting); });
  io.observe(el);
  return () => io.disconnect();
}

/**
 * Two aligned frames with a draggable seam: before on the left, after on the right (the Cut view's
 * compare convention). Sweeps gently until the first touch; reduced motion keeps a still 50/50 split.
 * Videos stay in sync, muted and looping, and play only while on screen.
 */
export function beforeAfter(o: { before: string; after: string; kind: 'image' | 'video'; labels?: [string, string]; alt?: string; posters?: [string, string]; sweep?: boolean }) {
  const [la, lb] = o.labels || ['Blockout', 'Generated'];
  const media = (src: string, cls: string, poster?: string) => o.kind === 'video'
    ? h('video', { class: cls, muted: true, loop: true, playsinline: true, preload: 'none', poster, 'aria-hidden': 'true', 'data-src': src })
    : h('img', { class: cls, src, alt: '', loading: 'lazy', decoding: 'async', draggable: false });
  const a = media(o.before, 'ba-before', o.posters?.[0]), b = media(o.after, 'ba-after', o.posters?.[1]);
  const seam = h('div', { class: 'ba-seam', role: 'slider', tabindex: 0, 'aria-label': `Compare: ${la} left, ${lb} right`, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': 50, 'aria-valuetext': `${la} 50%` });
  const el = h('figure', { class: 'ba', 'aria-label': o.alt || `${la} and ${lb}, side by side` }, a, b, seam, h('span', { class: 'ba-tag l' }, la), h('span', { class: 'ba-tag r' }, lb));
  let x = 50, touched = o.sweep === false, visible = false, raf = 0, playing = o.kind === 'video' && !reduced();
  const set = (v: number) => { x = Math.max(0, Math.min(100, v)); el.style.setProperty('--x', `${x}%`); seam.setAttribute('aria-valuenow', String(Math.round(x))); seam.setAttribute('aria-valuetext', `${la} ${Math.round(x)}%`); };
  const stop = () => { touched = true; cancelAnimationFrame(raf); raf = 0; };
  const sweep = (t0: number) => (now: number) => {
    raf = 0;
    if (touched || !visible || document.hidden || !el.isConnected) return;
    set(50 + 30 * Math.sin(((now - t0) / 1000) * 0.9));
    raf = requestAnimationFrame(sweep(t0));
  };
  const fromPointer = (ev: PointerEvent) => { const r = el.getBoundingClientRect(); set(((ev.clientX - r.left) / Math.max(1, r.width)) * 100); };
  let drag = false;
  el.addEventListener('pointerdown', ev => { if ((ev.target as HTMLElement).closest('.ba-toggle')) return; stop(); drag = true; el.setPointerCapture?.(ev.pointerId); fromPointer(ev); });
  el.addEventListener('pointermove', ev => { if (drag) fromPointer(ev); });
  el.addEventListener('pointerup', () => { drag = false; });
  el.addEventListener('pointercancel', () => { drag = false; });
  seam.addEventListener('keydown', ev => {
    const v = seamKey(x, ev.key, ev.shiftKey);
    if (v === null) return;
    ev.preventDefault(); ev.stopPropagation(); stop(); set(v);
  });
  // Missing media (not captured yet): say so instead of showing a broken frame.
  const missing = () => { stop(); el.classList.add('is-missing'); el.dataset.missing = 'Example media is unavailable.'; el.replaceChildren(); };
  a.addEventListener('error', missing); b.addEventListener('error', missing);
  let disconnect = () => {}, visibility = () => {};
  const dispose = () => { stop(); disconnect(); document.removeEventListener('visibilitychange', visibility); if (o.kind === 'video') { (a as HTMLVideoElement).pause(); (b as HTMLVideoElement).pause(); } };
  if (o.kind === 'video') {
    const va = a as HTMLVideoElement, vb = b as HTMLVideoElement;
    const toggle = h('button', { class: 'ba-toggle', type: 'button' });
    const paint = () => { toggle.textContent = playing ? '❚❚' : '▶'; toggle.setAttribute('aria-label', playing ? 'Pause both videos' : 'Play both videos'); };
    const apply = () => {
      for (const v of [va, vb]) if (visible && !v.src && v.dataset.src) { v.src = v.dataset.src; v.preload = 'auto'; }
      if (playing && visible && !document.hidden) { void va.play().catch(() => {}); void vb.play().catch(() => {}); } else { va.pause(); vb.pause(); }
    };
    toggle.onclick = () => { playing = !playing; paint(); apply(); };
    va.addEventListener('timeupdate', () => { if (Math.abs(vb.currentTime - va.currentTime) > 0.12) vb.currentTime = va.currentTime; });
    va.addEventListener('play', () => { vb.currentTime = va.currentTime; });
    visibility = apply; document.addEventListener('visibilitychange', visibility);
    el.append(toggle); paint();
    disconnect = onVisible(el, on => { visible = on; apply(); if (on && !touched && !reduced() && !raf) raf = requestAnimationFrame(sweep(performance.now())); });
  } else disconnect = onVisible(el, on => { visible = on; if (on && !touched && !reduced() && !raf) raf = requestAnimationFrame(sweep(performance.now())); });
  set(50);
  return Object.assign(el, { dispose });
}

/** A muted looping clip that loads and plays only while on screen (still under reduced motion). */
export function loopClip(o: { src: string; poster?: string; alt: string }) {
  const v = h('video', { muted: true, loop: true, playsinline: true, preload: 'none', poster: o.poster, 'aria-label': o.alt, 'data-src': o.src });
  const toggle = h('button', { class: 'ba-toggle', type: 'button' });
  let playing = !reduced(), visible = false;
  const paint = () => { toggle.textContent = playing ? '❚❚' : '▶'; toggle.setAttribute('aria-label', playing ? 'Pause' : 'Play'); };
  const apply = () => { if (!v.src) { v.src = o.src; v.preload = 'auto'; } if (playing && visible && !document.hidden) void v.play().catch(() => {}); else v.pause(); };
  toggle.onclick = () => { playing = !playing; paint(); apply(); };
  const el = h('figure', { class: 'lc' }, v, toggle);
  paint(); const disconnect = onVisible(el, on => { visible = on; if (on || v.src) apply(); });
  document.addEventListener('visibilitychange', apply);
  return Object.assign(el, { dispose() { disconnect(); document.removeEventListener('visibilitychange', apply); v.pause(); } });
}

/** A screenshot with numbered boxes (fractions of the image) and a matching legend. */
export function annotatedShot(o: { src: string; alt: string; callouts: Callout[] }) {
  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
  const img = h('img', { src: o.src, alt: o.alt, loading: 'lazy', decoding: 'async' });
  const shot = h('div', { class: 'an-shot' }, img, ...o.callouts.map((c, i) => h('span', { class: 'an-box', 'aria-hidden': 'true', style: `left:${pct(c.x)};top:${pct(c.y)};width:${pct(c.w)};height:${pct(c.h)}` }, h('span', { class: 'an-pin' }, String(i + 1)))));
  img.addEventListener('error', () => { shot.replaceChildren(h('p', { class: 'note', style: 'padding:12px;margin:0' }, 'Example screenshot is unavailable.')); });
  return h('figure', { class: 'an' }, shot, o.callouts.length ? h('ol', { class: 'an-legend' }, ...o.callouts.map((c, i) => h('li', {}, h('i', {}, String(i + 1)), c.label))) : null);
}
