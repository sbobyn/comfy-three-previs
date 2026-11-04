// Design sheet compositor: draws the chosen views of one object into a single PNG in the browser
// (no charge). Adapted from the DesignSheet app's sheet.mjs: same-scale figures, swatches, labels.

export type ComposeItem = { src: string; label: string; layout: 'body' | 'tile' | 'wide' };
export type ComposeOptions = { layout: 'turnaround' | 'full' | 'expressions'; name: boolean; labels: boolean; swatches: boolean; sameScale: boolean };

export const loadImage = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(Error('Could not load an image for the sheet.'));
  img.src = src;
});

type Src = HTMLImageElement | HTMLCanvasElement;
const sizeOf = (img: Src) => (img instanceof HTMLImageElement ? [img.naturalWidth, img.naturalHeight] : [img.width, img.height]);
function sample(img: Src, max = 160) {
  const [iw, ih] = sizeOf(img);
  const scale = Math.min(1, max / Math.max(iw, ih));
  const w = Math.max(1, Math.round(iw * scale)), h = Math.max(1, Math.round(ih * scale));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!; ctx.drawImage(img, 0, 0, w, h);
  return { data: ctx.getImageData(0, 0, w, h).data, w, h, scale };
}

type Box = { x: number; y: number; w: number; h: number };
/** Bounding box of everything that isn't plain light background, in source pixels. */
export function subjectBox(img: Src): Box {
  const [iw, ih] = sizeOf(img);
  const { data, w, h, scale } = sample(img);
  // Background = the average corner colour, so off-white studio backdrops still crop.
  const corner = [0, w - 1, (h - 1) * w, h * w - 1].map(p => [data[p * 4], data[p * 4 + 1], data[p * 4 + 2]]);
  const bg = [0, 1, 2].map(i => corner.reduce((s, c) => s + c[i], 0) / 4);
  const light = Math.min(...bg) > 200;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const far = light ? Math.hypot(data[i] - bg[0], data[i + 1] - bg[1], data[i + 2] - bg[2]) > 28 : true;
    if (data[i + 3] > 16 && far) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0 || !light) return { x: 0, y: 0, w: iw, h: ih };
  const pad = 2;
  const bx = Math.max(0, x0 - pad) / scale, by = Math.max(0, y0 - pad) / scale;
  const bw = (Math.min(w, x1 + pad + 1) - Math.max(0, x0 - pad)) / scale, bh = (Math.min(h, y1 + pad + 1) - Math.max(0, y0 - pad)) / scale;
  return { x: Math.round(bx), y: Math.round(by), w: Math.round(Math.min(bw, iw - bx)), h: Math.round(Math.min(bh, ih - by)) };
}

/**
 * Studio backdrops come back off-white or light grey; on a white sheet they show as boxes.
 * White-balance to the corner colour and push near-white to pure white. Dark/busy backgrounds are left alone.
 */
export function whiten(img: HTMLImageElement): Src {
  const w = img.naturalWidth, h = img.naturalHeight;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!; ctx.drawImage(img, 0, 0);
  const im = ctx.getImageData(0, 0, w, h), d = im.data, n = Math.max(4, Math.round(Math.min(w, h) * 0.03));
  const bg = [0, 0, 0]; let count = 0;
  for (const [x0, y0] of [[0, 0], [w - n, 0], [0, h - n], [w - n, h - n]]) for (let y = y0; y < y0 + n; y++) for (let x = x0; x < x0 + n; x++) { const i = (y * w + x) * 4; bg[0] += d[i]; bg[1] += d[i + 1]; bg[2] += d[i + 2]; count++; }
  for (let k = 0; k < 3; k++) bg[k] /= count;
  if (Math.min(...bg) < 190) return img;
  const gain = bg.map(v => 255 / Math.max(v, 1));
  for (let i = 0; i < d.length; i += 4) {
    const r = Math.min(255, d[i] * gain[0]), g = Math.min(255, d[i + 1] * gain[1]), b = Math.min(255, d[i + 2] * gain[2]);
    const m = Math.min(r, g, b), t = m >= 246 ? 1 : m > 226 ? (m - 226) / 20 : 0; // soft ramp to white
    d[i] = r + (255 - r) * t; d[i + 1] = g + (255 - g) * t; d[i + 2] = b + (255 - b) * t;
  }
  ctx.putImageData(im, 0, 0);
  return c;
}

/** A few dominant non-background colours from the identity image. */
export function swatches(img: HTMLImageElement, count = 5) {
  const { data } = sample(img, 72), bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
    if (a < 128 || Math.min(r, g, b) > 225) continue;
    const key = (r >> 5) << 6 | (g >> 5) << 3 | (b >> 5);
    const bin = bins.get(key) || { n: 0, r: 0, g: 0, b: 0 };
    bin.n++; bin.r += r; bin.g += g; bin.b += b; bins.set(key, bin);
  }
  const picked: number[][] = [];
  for (const bin of [...bins.values()].sort((a, b) => b.n - a.n)) {
    const c = [bin.r / bin.n, bin.g / bin.n, bin.b / bin.n].map(Math.round);
    if (picked.every(p => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]) > 60)) picked.push(c);
    if (picked.length === count) break;
  }
  return picked.map(([r, g, b]) => `rgb(${r},${g},${b})`);
}

const W = 2400, PAD = 72, GAP = 36, LABEL = 56;
const FONT = '-apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif';
const INK = '#15130F', MUTED = '#6E6961', LINE = '#E2DCD1';

function label(ctx: CanvasRenderingContext2D, text: string, cx: number, y: number) {
  ctx.fillStyle = MUTED; ctx.font = `600 28px ${FONT}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(text).toUpperCase(), cx, y); ctx.textAlign = 'left';
}

/**
 * Lay out the views: a same-scale row of figures/whole objects ("body"), a grid of square tiles
 * (heads, expressions, details) and a grid of wide frames (environments).
 * turnaround → the row only; expressions → the tiles only; full → everything.
 */
export async function composeSheet({ name, items, reference, options }: { name: string; items: ComposeItem[]; reference: string | null; options: ComposeOptions }) {
  const loaded = await Promise.all(items.map(async it => { const raw = await loadImage(it.src); return { ...it, raw, img: whiten(raw) }; }));
  let body = loaded.filter(x => x.layout === 'body'), tiles = loaded.filter(x => x.layout === 'tile'), wide = loaded.filter(x => x.layout === 'wide');
  if (options.layout === 'turnaround') { if (!body.length) { body = [...tiles, ...wide]; } tiles = []; wide = []; }
  if (options.layout === 'expressions') { tiles = [...tiles, ...body]; body = []; }
  const ref = options.swatches && reference ? await loadImage(reference).catch(() => null) : null;
  const inner = W - PAD * 2;
  const ops: ((ctx: CanvasRenderingContext2D) => void)[] = [];
  let y = PAD;

  const title = options.name && name;
  const cols = ref ? swatches(ref) : [];
  if (title || cols.length) {
    const y0 = y;
    if (title) ops.push(ctx => { ctx.fillStyle = INK; ctx.font = `700 64px ${FONT}`; ctx.textBaseline = 'middle'; ctx.fillText(name.toUpperCase(), PAD, y0 + 40); });
    if (cols.length) ops.push(ctx => cols.forEach((c, i) => { ctx.fillStyle = c; const s = 56, x = W - PAD - (cols.length - i) * (s + 14) + 14; ctx.beginPath(); ctx.roundRect(x, y0 + 12, s, s, 10); ctx.fill(); }));
    y += 80 + GAP;
  }

  if (body.length) {
    // Up to 4 figures per row keeps each one large enough to read.
    const perRow = body.length <= 4 ? body.length : Math.ceil(body.length / Math.ceil(body.length / 4));
    const cellW = (inner - GAP * (perRow - 1)) / perRow, rowH = perRow <= 3 ? 1100 : 900;
    const all = body.map(b => ({ ...b, box: options.sameScale ? subjectBox(b.img) : { x: 0, y: 0, w: b.raw.naturalWidth, h: b.raw.naturalHeight } }));
    // Same scale: each view is framed independently, so every figure gets the same height; shrink all equally if one is too wide.
    let scales = all.map(it => options.sameScale ? rowH / it.box.h : Math.min(rowH / it.box.h, cellW / it.box.w));
    if (options.sameScale) { const k = Math.min(1, ...all.map((it, i) => cellW / (it.box.w * scales[i]))); scales = scales.map(s => s * k); }
    for (let r = 0; r * perRow < all.length; r++) {
      const row = all.slice(r * perRow, r * perRow + perRow), y0 = y;
      const usedH = Math.min(rowH, Math.max(...row.map(it => it.box.h * scales[all.indexOf(it)])));
      const x0 = PAD + (inner - (row.length * cellW + (row.length - 1) * GAP)) / 2;
      row.forEach((it, i) => {
        const s = scales[all.indexOf(it)], dw = it.box.w * s, dh = it.box.h * s, cx = x0 + i * (cellW + GAP) + cellW / 2, bottom = y0 + usedH;
        ops.push(ctx => {
          ctx.drawImage(it.img, it.box.x, it.box.y, it.box.w, it.box.h, cx - dw / 2, options.sameScale ? bottom - dh : y0 + (usedH - dh) / 2, dw, dh);
          if (options.labels) label(ctx, it.label, cx, bottom + 34);
        });
      });
      y += usedH + (options.labels ? LABEL + 10 : 0) + GAP;
    }
  }

  const grid = (list: typeof loaded, perRowMax: number, maxW: number, aspect: number, radius: number) => {
    if (!list.length) return;
    const perRow = Math.min(perRowMax, list.length);
    const cw = Math.min(maxW, (inner - GAP * (perRow - 1)) / perRow), ch = cw / aspect;
    const rowW = perRow * cw + (perRow - 1) * GAP, x0 = PAD + (inner - rowW) / 2, top = y;
    list.forEach((it, i) => {
      const r = Math.floor(i / perRow), c = i % perRow, x = x0 + c * (cw + GAP), yy = top + r * (ch + (options.labels ? LABEL : 0) + GAP);
      ops.push(ctx => {
        const { naturalWidth: iw, naturalHeight: ih } = it.raw;
        // Cover-crop, biased toward the top so faces stay in frame.
        const k = Math.max(cw / iw, ch / ih), sw = cw / k, sh = ch / k;
        ctx.save(); ctx.beginPath(); ctx.roundRect(x, yy, cw, ch, radius); ctx.clip();
        ctx.drawImage(it.img, (iw - sw) / 2, Math.max(0, (ih - sh) * 0.2), sw, sh, x, yy, cw, ch); ctx.restore();
        ctx.strokeStyle = LINE; ctx.lineWidth = 2; ctx.beginPath(); ctx.roundRect(x, yy, cw, ch, radius); ctx.stroke();
        if (options.labels) label(ctx, it.label, x + cw / 2, yy + ch + 32);
      });
    });
    y += Math.ceil(list.length / perRow) * (ch + (options.labels ? LABEL : 0) + GAP);
  };
  grid(tiles, options.layout === 'expressions' ? 4 : 6, options.layout === 'expressions' ? 520 : 360, 1, 18);
  grid(wide, 2, 1200, 16 / 9, 14);

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = Math.max(Math.round(y - GAP + PAD), 400);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const op of ops) op(ctx);
  return canvas;
}

export const canvasBlob = (c: HTMLCanvasElement, type = 'image/png', quality?: number) => new Promise<Blob>((resolve, reject) => c.toBlob(b => (b ? resolve(b) : reject(Error('Could not encode the sheet'))), type, quality));
