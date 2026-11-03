// Tiny synthetic helpers for masked-edit offline tests (no private project media).
import { createHash, randomUUID } from 'node:crypto';

export const ids = n => Array.from({ length: n }, () => randomUUID());
export const sha = b => createHash('sha256').update(b).digest('hex');

/** Solid RGB24 frame. */
export function rgbFrame(w, h, rgb = [255, 0, 0]) {
  const buf = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    buf[i * 3] = rgb[0]; buf[i * 3 + 1] = rgb[1]; buf[i * 3 + 2] = rgb[2];
  }
  return buf;
}

/** Checkerboard RGB24 frame for edge/preservation tests. */
export function checkerFrame(w, h, a = [0, 255, 0], b = [0, 0, 255], cell = 8) {
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const on = ((Math.floor(x / cell) + Math.floor(y / cell)) & 1) === 0;
      const c = on ? a : b, i = (y * w + x) * 3;
      buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2];
    }
  }
  return buf;
}

export function rectMask({ x = 100, y = 100, w = 200, h = 200, featherPx = 8 } = {}) {
  return {
    v: 1,
    mode: 'fixed',
    width: 1280,
    height: 720,
    coordinateSpace: 'source-pixels',
    featherPx,
    strokes: [{ type: 'rect', x, y, w, h }],
  };
}

export function videoAsset(id, shotId, at, extra = {}) {
  return {
    id, kind: 'workflow-result', shotId, file: `assets/${id}.mp4`, mime: 'video/mp4',
    sha256: extra.sha256 || 'a'.repeat(64), width: 1280, height: 720, fps: 24, frameCount: 81, duration: 81 / 24,
    createdAt: at, source: { sourceAssetId: extra.sourceAssetId || randomUUID(), workflow: 'Seedance · edit', backend: 'cloud', cameraSource: 'blockout', prompt: 'A coat.', ...extra.source },
  };
}
