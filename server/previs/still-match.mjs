// Free blockout-match check for key-frame stills: both images shrunk to a small grey grid with FFmpeg, then scored by
// shared/still-match.mjs guideMatchScore (edge orientation + edge density + light layout). Never blocks a still:
// any failure returns null.
import { spawn } from 'node:child_process';
import { guideMatchScore, MATCH_SIZE } from '../../shared/still-match.mjs';
import { GRADER_PRICES } from '../../shared/tiers.mjs';

export const MATCH_METHOD = `edges-${MATCH_SIZE.width}x${MATCH_SIZE.height}-v1`;

/** Image bytes (PNG/JPEG/WebP) → w×h grey pixels (0–255), area-averaged. */
export function greyPixels(bytes, { width, height } = MATCH_SIZE) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PREVIS_FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-frames:v', '1', '-vf', `scale=${width}:${height}:flags=area,format=gray`, '-f', 'rawvideo', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = []; let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('ffmpeg timed out')); }, 30000);
    child.stdout.on('data', d => out.push(d)); child.stderr.on('data', d => { err = (err + d).slice(-1000); });
    child.on('error', e => { clearTimeout(timer); reject(Error(`ffmpeg is not available: ${e.message}`)); });
    child.on('close', code => {
      clearTimeout(timer);
      const px = Buffer.concat(out);
      code === 0 && px.length === width * height ? resolve(new Uint8Array(px)) : reject(Error(`ffmpeg could not read the image: ${err.trim().split('\n').at(-1) || `exit ${code}`}`));
    });
    child.stdin.on('error', () => {}); child.stdin.end(bytes);
  });
}

/** { score 0–10, orientation, edges, light, raw, method } for a still against its guide frame, or null. */
export async function stillGuideMatch(guideBytes, stillBytes, size = MATCH_SIZE) {
  try {
    const [a, b] = await Promise.all([greyPixels(guideBytes, size), greyPixels(stillBytes, size)]);
    return { ...guideMatchScore(a, b, size.width, size.height), method: MATCH_METHOD };
  } catch { return null; }
}

// ---------- Paid grader (opt-in: PREVIS_MATCH_GRADER=gemini) ----------
export const GRADER_MODEL = 'Gemini 3.5 Flash';
/** Budget reservation for one grade: token-billed, about a cent (two small images in, one short verdict out). */
export const GRADER_RESERVE_USD = GRADER_PRICES.gemini;
export const GRADER_PROMPT = 'Image 1 is a grey 3D blockout of a film frame: the plan. Image 2 is a generated photoreal frame that should match it. Ignore colours, materials, lighting, style, identity and extra background detail. Judge only the camera and blocking: camera height and angle, lens and shot size, framing, the horizon, and where each main object is in frame and which way it faces. A main object facing the other way, or seen from another side (front, side or rear), caps headings at 3 and score at 5. Reply with JSON only: {"camera": 0-10, "layout": 0-10, "headings": 0-10, "score": 0-10, "why": "one short sentence"}. 10 = same camera and blocking, 5 = same idea but clearly different camera or placement, 0 = unrelated.';
/** The grader workflow: guide and still in, Gemini's JSON verdict out as text. */
export function graderGraph(guide, still, seed = 1, plan = '') {
  const prompt = plan ? `${GRADER_PROMPT}\nThe plan in words (measured from the 3D scene; trust it for which way things face when image 1 is ambiguous):\n${plan}` : GRADER_PROMPT;
  return {
    1: { class_type: 'LoadImage', inputs: { image: guide } },
    2: { class_type: 'LoadImage', inputs: { image: still } },
    3: { class_type: 'GeminiNodeV3', inputs: { model: GRADER_MODEL, 'model.prompt': prompt, 'model.images.image_1': ['1', 0], 'model.images.image_2': ['2', 0], 'model.thinking_level': 'LOW', 'model.max_output_tokens': 2048, 'model.seed': seed, 'model.system_prompt': 'You compare film frames for camera and blocking only. Answer with one JSON object.', 'model.temperature': 0, 'model.top_p': 0.95 } },
    4: { class_type: 'PreviewAny', inputs: { source: ['3', 0] } },
  };
}
/** Pull { score, camera, layout, headings, why } out of the grader's text; null if there is no usable score. */
export function parseGrade(text) {
  const m = /\{[\s\S]*\}/.exec(String(text || '')); if (!m) return null;
  let j; try { j = JSON.parse(m[0]); } catch { return null; }
  const n = v => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(10, Math.round(Number(v) * 10) / 10)) : null);
  const score = n(j.score); if (score == null) return null;
  return { score, camera: n(j.camera), layout: n(j.layout), headings: n(j.headings), why: String(j.why || '').slice(0, 200) };
}
/**
 * Grade a still against its guide on Comfy Cloud (a few cents at most; token-billed). Uploads both images, submits once,
 * polls up to timeoutMs. Returns { score, …, method } or null (never throws: grading must not block a still).
 */
export async function gradeStillPaid({ adapter, upload = (b, o) => adapter.upload(b, o), guideBytes, stillBytes, requestId, projectId, plan = '', timeoutMs = 60000, pollMs = 2000 }) {
  try {
    const [g, s] = await Promise.all([upload(guideBytes, { filename: `${requestId}-grade-guide.png`, mime: 'image/png', subfolder: `previs/${requestId}` }), upload(stillBytes, { filename: `${requestId}-grade-still.png`, mime: 'image/png', subfolder: `previs/${requestId}` })]);
    const { promptId } = await adapter.submit({ graph: graderGraph(g.value, s.value, 1, plan), requestId: `${requestId}-grade`, projectId, partnerNodes: true });
    for (const end = Date.now() + timeoutMs; Date.now() < end;) {
      await new Promise(r => setTimeout(r, pollMs));
      const h = await adapter.history(promptId).catch(() => null);
      if (!h) continue;
      if (['error', 'cancelled'].includes(h.status?.status_str)) return null;
      if (!h.status?.completed) continue;
      const out = h.outputs?.['4'], text = [out?.text, out?.string, out?.ui?.text].flat().find(x => typeof x === 'string');
      const grade = parseGrade(text);
      return grade ? { ...grade, method: `gemini-grader:${GRADER_MODEL}`, promptId } : null;
    }
    return null;
  } catch { return null; }
}
