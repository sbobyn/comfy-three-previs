// Copyright (c) 2026 Steven Bobyn. SPDX-License-Identifier: MIT
// Helpers shared by the starter scene modules (scripts/starters/scenes) and the authoring script: geometry, walking and
// camera keys, and the checks the starter tests apply.
import { entityAt, focusPoint, videoReferences } from '../../shared/director.mjs';
import { frameLayout, shotProjector } from '../../shared/still-match.mjs';
import { videoPromptPlan } from '../../shared/prompt-plan.mjs';
import { builtInPresets } from '../../server/previs/presets.mjs';
import { cameraSourceOf } from '../../shared/camera-source.mjs';
import { autoPromptCap } from '../../shared/model-params.mjs';
import { maxReferences } from '../../shared/video-refs.mjs';

export const NO_BRANDS = 'No logos, brand names, badges, signage or lettering anywhere';
/** A filter tag on every shot: filter tags are always kept in a video prompt, so the no-brands rule survives its length cap. */
export const NO_BRANDS_TAG = 'no logos or lettering';

// ---------- geometry helpers for scene modules ----------
export const r3 = v => v.map(x => Math.round(x * 1000) / 1000);
export const lerp = (a, b, u) => a.map((x, i) => x + (b[i] - x) * u);
export const smooth = u => u * u * (3 - 2 * u);
/** Point at arc length s along a polyline of [x, z] points (clamped). */
export function along(points, s) {
  let left = Math.max(0, s);
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (left <= len || i === points.length - 1) { const u = Math.min(1, left / len); return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, Math.atan2(b[0] - a[0], b[1] - a[1])]; }
    left -= len;
  }
  return [...points.at(-1), 0];
}
/** Linear position keys every `step` seconds for a walker at `speed` m/s along `points` from scene time t0 to t1. */
export function walkKeys(points, { t0 = 0, t1, speed = 1.27, s0 = 0, ground = () => 0, step = 1 }) {
  const keys = [];
  for (let t = t0; t <= t1 + 1e-6; t += step) { const [x, z] = along(points, s0 + (t - t0) * speed); keys.push({ t: Math.round(t * 1000) / 1000, position: r3([x, ground(x, z), z]), ease: 'linear' }); }
  return keys;
}
/** Custom camera keys sampled from fn(seconds) → { p, look, mm } at n + 1 evenly spaced moments (played linearly). */
export function cameraKeys(duration, n, fn) {
  return Array.from({ length: n + 1 }, (_, i) => { const c = fn(duration * i / n); return { t: Math.round(i / n * 10000) / 10000, p: r3(c.p), look: r3(c.look), mm: Math.round((c.mm ?? 35) * 10) / 10 }; });
}
/** Where an object is (its focus point) at scene time t, from a project document. */
export function focusAt(project, name, t) { const e = project.scene.entities.find(x => x.name === name); return focusPoint({ ...e, ...entityAt(e, t) }); }

// ---------- checks (the same rules the starter tests apply) ----------
export function checkProject(p, { leaveFrame = [] } = {}) {
  const problems = [], ids = new Set(p.scene.entities.map(e => e.id));
  for (const e of p.scene.entities) if (e.lookFrom && !ids.has(e.lookFrom)) problems.push(`${e.name}: shares a look with “${e.lookFrom}”, which is not an object id`);
  for (const sh of p.shots) {
    if (sh.duration < 4 || sh.duration > 5) problems.push(`${sh.title}: ${sh.duration}s (4–5 s)`);
    const lead = p.scene.entities.find(e => e.id === sh.camera.target);
    if (!lead) { problems.push(`${sh.title}: no camera target`); continue; }
    if (!(lead.notes || '').trim()) problems.push(`${sh.title}: lead ${lead.name} has no Cast Card text`);
    if (!leaveFrame.includes(sh.title)) for (let i = 0; i <= sh.duration * 24; i++) {
      const t = i / 24, pose = { ...lead, ...entityAt(lead, (sh.start || 0) + t) };
      const pt = shotProjector(sh, p.scene.entities, t).project(focusPoint(pose));
      if (!(pt.z > 0 && pt.x > 0.1 && pt.x < 0.9 && pt.y > 0.05 && pt.y < 0.95)) { problems.push(`${sh.title}: lead ${lead.name} out of frame at ${t.toFixed(2)}s (${pt.x.toFixed(2)}, ${pt.y.toFixed(2)})`); break; }
      if (lead.shape === 'car' || lead.shape === 'bird') {
        const item = frameLayout(p, sh, t).items.find(e => e.id === lead.id);
        if (!(item?.inFrame > 0.99 && item.box[2] - item.box[0] >= 0.15)) { problems.push(`${sh.title}: ${lead.name} cropped or small at ${t.toFixed(2)}s`); break; }
      }
    }
    for (const model of builtInPresets.filter(d => d.inputs?.prompt)) {
      const cameraSource = cameraSourceOf(model), refs = model.task === 'first-frame' ? [] : videoReferences(p, sh, maxReferences(model), { stills: cameraSource === 'blockout' });
      const plan = videoPromptPlan(p, sh, { cameraSource, refs, cap: autoPromptCap(model), maxLength: model.constraints?.promptMaxLength });
      const missing = ['action', 'camera', `obj:${sh.camera.target}`].filter(k => !plan.sections.some(r => r.key === k && ['included', 'shortened'].includes(r.status)));
      if (plan.length > autoPromptCap(model)) { problems.push(`${sh.title} (${model.id}): ${plan.length} characters, over the ${autoPromptCap(model)} cap`); break; }
      if (!/no logos/i.test(plan.text)) { problems.push(`${sh.title} (${model.id}): the video prompt lost the no-brands rule`); break; }
      if (plan.cameraWarning || plan.cut || missing.length || plan.sections.some(r => !r.system && r.cameraWords?.length)) { problems.push(`${sh.title} (${model.id}): ${plan.cameraWarning || ''}${plan.cut ? ' cut' : ''}${missing.length ? ` missing ${missing}` : ''}`); break; }
    }
  }
  return problems;
}
