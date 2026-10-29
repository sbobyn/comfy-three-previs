// Copyright (c) 2026 Steven Bobyn. SPDX-License-Identifier: MIT
// Video workflows that take reference images: derive a variant of a preset with N image inputs
// (referenceImage1..N, each a LoadImage) wired into the model's reference-image input.

/** How each supported video node takes reference images. */
export const REFERENCE_INPUTS = {
  // One IMAGE input holding a batch of up to 4 images; extra images are joined with ImageBatch.
  KlingOmniProEditVideoNode: { mode: 'batch', input: 'reference_images', max: 4 },
  // Auto-grow slots model.reference_images.image_1..N.
  ByteDance2ReferenceNodeV2: { mode: 'slots', input: 'model.reference_images.image_', max: 9 },
};

/** { nodeId, spec } for the first node in the graph that accepts reference images, else null. */
export function referenceTarget(definition) {
  for (const [nodeId, node] of Object.entries(definition?.graph || {})) {
    const spec = REFERENCE_INPUTS[node.class_type];
    if (spec) return { nodeId, spec };
  }
  return null;
}
export const maxReferences = definition => referenceTarget(definition)?.spec.max ?? 0;

/**
 * A copy of `definition` with `count` reference-image inputs. Returns the original when count is 0
 * or the workflow takes no references. Node ids are prefixed `ref` so they never clash.
 */
export function withReferenceImages(definition, count) {
  const target = referenceTarget(definition);
  const n = Math.min(Math.max(0, Math.floor(count)), target?.spec.max ?? 0);
  if (!target || !n) return definition;
  const d = structuredClone(definition);
  const node = d.graph[target.nodeId];
  for (let i = 1; i <= n; i++) {
    d.graph[`ref${i}`] = { class_type: 'LoadImage', inputs: { image: `previs-reference-${i}.png` } };
    d.inputs[`referenceImage${i}`] = { nodeId: `ref${i}`, input: 'image' };
  }
  if (target.spec.mode === 'batch') {
    let last = 'ref1';
    for (let i = 2; i <= n; i++) { d.graph[`refbatch${i}`] = { class_type: 'ImageBatch', inputs: { image1: [last, 0], image2: [`ref${i}`, 0] } }; last = `refbatch${i}`; }
    node.inputs[target.spec.input] = [last, 0];
  } else {
    for (let i = 1; i <= n; i++) node.inputs[`${target.spec.input}${i}`] = [`ref${i}`, 0];
  }
  const base = definition.provenance?.presetId || definition.id;
  d.title = `${definition.title} · ${n} reference image${n === 1 ? '' : 's'}`;
  d.provenance = { ...(definition.provenance || {}), presetId: base, referenceImages: n };
  return d;
}
