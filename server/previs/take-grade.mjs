// Copyright (c) 2026 Steven Bobyn. SPDX-License-Identifier: MIT
// Paid take direction check (PREVIS_MATCH_GRADER=gemini with PREVIS_ALLOW_PAID=1): four moments of a generated video are
// tiled into one image (plus the blockout's four when the 3D scene no longer matches the clip) and sent to the match grader
// once; its reading of the subject's facing and travel is compared with the blockout (shared/take-direction.mjs) and saved on the take as
// pass / warn / fail with a reason. One grade costs what one still grade does: the budget reserves and books
// GRADER_PRICES.gemini, and the take shows that ledger entry's amount, so what is shown is what is booked.
import { randomUUID } from 'node:crypto';
import { createBackend } from './backends.mjs';
import { uploadCacheFor } from './upload-cache.mjs';
import { contactSheet } from './frames.mjs';
import { GRADER_MODEL } from './still-match.mjs';
import { GRADER_PRICES } from '../../shared/tiers.mjs';
import { shotSignature } from '../../shared/director.mjs';
import { directionTimes, blockoutPlan, directionPrompt, parseDirection, judgeDirection, DIRECTION_METHOD } from '../../shared/take-direction.mjs';

export const DIRECTION_GRADE_USD = GRADER_PRICES.gemini;
const SAMPLES = 4, SHEET = { width: 1536, cols: 2, type: 'image/jpeg' }; // 2 × 2 frames, about 760 px wide each
function fail(message, status = 400, extra = {}) { throw Object.assign(Error(message), { status, ...extra }); }
/** What the budget ledger books for a check: its settled cost (billed when reconciled), 0 when released, else the reservation's expected charge. */
export function bookedCost(r) {
  if (!r) return { usd: DIRECTION_GRADE_USD, status: 'estimate' };
  const micros = r.state === 'released' ? 0 : r.state === 'settled' ? r.costMicros ?? r.expectedMicros : r.expectedMicros;
  return { usd: Math.round((micros ?? 0) / 100) / 1e4, status: r.state === 'released' ? 'released' : r.state === 'settled' && /^billed/.test(r.costStatus || '') ? 'billed' : 'estimate' };
}

/**
 * The grader workflow: the take's frames (and, when the blockout was not measured, the blockout's frames first) in,
 * Gemini's JSON reading out as text. Same node and settings as the still grader.
 */
export function directionGraph(blockout, take, prompt, seed = 1) {
  const images = blockout ? { 'model.images.image_1': ['1', 0], 'model.images.image_2': ['2', 0] } : { 'model.images.image_1': ['2', 0] };
  return {
    ...(blockout ? { 1: { class_type: 'LoadImage', inputs: { image: blockout } } } : {}),
    2: { class_type: 'LoadImage', inputs: { image: take } },
    3: { class_type: 'GeminiNodeV3', inputs: { model: GRADER_MODEL, 'model.prompt': prompt, ...images, 'model.thinking_level': 'LOW', 'model.max_output_tokens': 2048, 'model.seed': seed, 'model.system_prompt': 'You read which way the subject of film frames faces and moves, relative to the camera. Answer with one JSON object.', 'model.temperature': 0, 'model.top_p': 0.95 } },
    4: { class_type: 'PreviewAny', inputs: { source: ['3', 0] } },
  };
}

/** Submit once and poll; the grader's text, or null (never throws: a check must not break the take). */
export async function runDirectionGrader({ adapter, upload, blockoutBytes, takeBytes, prompt, requestId, projectId, timeoutMs = 90000, pollMs = 2000 }) {
  try {
    const sub = `previs/${requestId}`;
    const [b, t] = await Promise.all([blockoutBytes ? upload(blockoutBytes, { filename: `${requestId}-blockout.jpg`, mime: 'image/jpeg', subfolder: sub }) : null, upload(takeBytes, { filename: `${requestId}-take.jpg`, mime: 'image/jpeg', subfolder: sub })]);
    const { promptId } = await adapter.submit({ graph: directionGraph(b?.value ?? null, t.value, prompt), requestId, projectId, partnerNodes: true });
    for (const end = Date.now() + timeoutMs; Date.now() < end;) {
      await new Promise(r => setTimeout(r, pollMs));
      const h = await adapter.history(promptId).catch(() => null);
      if (!h) continue;
      if (['error', 'cancelled'].includes(h.status?.status_str)) return { promptId, text: null };
      if (!h.status?.completed) continue;
      const out = h.outputs?.['4'];
      return { promptId, text: [out?.text, out?.string, out?.ui?.text].flat().find(x => typeof x === 'string') ?? null };
    }
    return { promptId, text: null };
  } catch (e) { return { promptId: null, text: null, error: e.message, notSent: e.notSent === true }; }
}

/**
 * The direction checker. `grade({ projectId, assetId, maxCostUsd })` samples, reserves, grades, saves the check on the take
 * (director.recordTakeCheck) and returns it with its cost. options: { budget, allowPaid, grader, backend, uploadCache,
 * sheet (test hook: (inputs) → image bytes), run (test hook replacing runDirectionGrader) }.
 */
export function openTakeGrader(root, director, options = {}) {
  const allowPaid = () => (options.allowPaid ?? process.env.PREVIS_ALLOW_PAID === '1') === true;
  const graderOn = () => (options.grader ?? process.env.PREVIS_MATCH_GRADER) === 'gemini' && allowPaid();
  const backendFor = options.backend || (input => createBackend(input, options.backendOptions));
  const uploadCache = options.uploadCache || uploadCacheFor(root), sheet = options.sheet || contactSheet, run = options.run || runDirectionGrader;
  const budget = options.budget;

  /** What a check needs, without sending anything: the take, its blockout, the sample moments and the plan. */
  async function prepare(projectId, assetId) {
    const p = await director.get(projectId);
    const take = (p.assets || []).find(a => a.id === assetId);
    if (!take || take.kind !== 'workflow-result' || !String(take.mime || '').startsWith('video/')) fail('That is not a generated video take of this project', 404);
    const shot = p.shots.find(s => s.id === take.shotId); if (!shot) fail('The take’s shot was removed', 404);
    const renders = (p.assets || []).filter(a => a.kind === 'camera-render' && a.shotId === shot.id && String(a.mime || '').startsWith('video/'));
    const blockout = renders.find(a => a.id === take.source?.sourceAssetId) || renders.find(a => a.id === shot.render?.assetId) || renders.at(-1);
    if (!blockout) fail('The blockout this take was made from is no longer in the project; render the shot’s blockout first', 409);
    const times = directionTimes(blockout.duration ?? shot.duration, take.duration ?? shot.duration, SAMPLES);
    // The 3D scene is trusted for the blockout's facing only while it still matches the clip.
    const current = !blockout.source?.signature || blockout.source.signature === shotSignature(p, shot);
    return { p, shot, take, blockout, times, plan: blockoutPlan(p, shot, times, { current }) };
  }

  async function grade({ projectId, assetId, maxCostUsd = DIRECTION_GRADE_USD }) {
    if (!graderOn()) fail('The direction check uses the paid match grader: start the server with PREVIS_MATCH_GRADER=gemini and PREVIS_ALLOW_PAID=1. Nothing was sent.', 409, { apiCode: 'grader-off' });
    if (!(Number(maxCostUsd) >= DIRECTION_GRADE_USD)) fail(`A direction check costs $${DIRECTION_GRADE_USD.toFixed(2)}; maxCostUsd $${maxCostUsd} is below it. Nothing was sent.`, 402);
    const { p, shot, take, blockout, times, plan } = await prepare(projectId, assetId);
    const file = a => director.assetFile(p.id, a.file.replace(/^assets\//, ''));
    const [bFile, tFile] = await Promise.all([file(blockout), file(take)]);
    const last = a => Math.max(0, (a.duration || shot.duration) - 1 / (a.fps || 24));
    // Measured from the 3D scene: only the take is sent (see directionPrompt). Otherwise the blockout frames go first.
    const [blockoutBytes, takeBytes] = await Promise.all([plan.measured ? null : sheet(times.map(t => ({ file: bFile, t: Math.min(t, last(blockout)) })), SHEET), sheet(times.map(t => ({ file: tFile, t: Math.min(t, last(take)) })), SHEET)]);
    const id = `direction-${assetId.slice(0, 8)}-${randomUUID().slice(0, 8)}`;
    await budget.reserve({ id, source: 'grader', projectId: p.id, kind: 'image', model: 'Take direction check', label: `${shot.title || 'Shot'} · direction check`, estimateUsd: DIRECTION_GRADE_USD, components: { graderUsd: DIRECTION_GRADE_USD } });
    const adapter = backendFor({ kind: 'cloud' });
    const r = await run({ adapter, upload: (b, o) => uploadCache.upload(adapter, b, o), blockoutBytes, takeBytes, prompt: directionPrompt(plan), requestId: id, projectId: p.id });
    const parsed = r.text ? parseDirection(r.text, times.length) : null, judged = judgeDirection(plan, parsed);
    // Sent: it is billed whether or not the reading was usable. Never sent: nothing is owed.
    if (r.notSent) await budget.release(id, 'Not sent');
    else if (r.text != null) await budget.settle(id);
    else await budget.hold(id, 'Direction check did not return; a charge may still arrive');
    if (!judged) fail(r.notSent ? `The direction check could not be sent (${r.error || 'backend refused'}); nothing is owed.` : 'The grader did not return a usable reading; the reservation stays until it is reconciled. Check the take by eye.', 502, { reservationId: id });
    const check = { ...judged, subject: plan.subject?.name || null, measured: plan.measured, blockoutAssetId: blockout.id, method: `${DIRECTION_METHOD}:gemini-grader:${GRADER_MODEL}`, reservationId: id, promptId: r.promptId, gradedAt: new Date().toISOString() };
    await director.recordTakeCheck(p.id, take.id, 'direction', check);
    return { check, cost: bookedCost(budget.get(id)) };
  }
  return { grade, prepare, graderOn, priceUsd: DIRECTION_GRADE_USD };
}
