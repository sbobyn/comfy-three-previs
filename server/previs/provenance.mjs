// Generation results in the legacy project store (project.json) keep their provenance by reference: the
// receipt (generation-jobs/<generationJobId>.json) already holds the request shot and source assets, so the
// asset lists them in `byReference` instead of copying them (a copy was ~40 KB per result, rewritten on
// every attach). Only a copy identical to its receipt is ever dropped; expandAsset() restores it exactly.
import { isDeepStrictEqual } from 'node:util';

// provenance field → receipt field
const FROM_RECEIPT = { requestShot: 'shot', sourceAssets: 'sources' };

/** The asset with copies that equal its receipt replaced by references (unchanged when there is nothing to drop). */
export function compactAsset(asset, receipt) {
  const provenance = asset?.provenance;
  if (!provenance?.generationJobId || !receipt || String(receipt.id).toLowerCase() !== String(provenance.generationJobId).toLowerCase()) return asset;
  const next = { ...provenance }, refs = new Set(provenance.byReference || []);
  for (const [field, from] of Object.entries(FROM_RECEIPT)) {
    if (Object.hasOwn(next, field) && receipt[from] !== undefined && isDeepStrictEqual(next[field], receipt[from])) { delete next[field]; refs.add(field); }
  }
  if (refs.size === (provenance.byReference || []).length) return asset;
  return { ...asset, provenance: { ...next, byReference: [...refs] } };
}

/** The asset with referenced fields read back from its receipt. Fields whose receipt is missing stay in `byReference`. */
export function expandAsset(asset, receiptOf) {
  const provenance = asset?.provenance, refs = provenance?.byReference;
  if (!Array.isArray(refs)) return asset;
  const receipt = receiptOf(provenance.generationJobId), next = { ...provenance }, left = [];
  for (const field of refs) {
    if (FROM_RECEIPT[field] && receipt && receipt[FROM_RECEIPT[field]] !== undefined) next[field] = structuredClone(receipt[FROM_RECEIPT[field]]);
    else left.push(field);
  }
  if (left.length) next.byReference = left; else delete next.byReference;
  return { ...asset, provenance: next };
}

/** Migration on load: compacts every asset in place. Returns how many changed (0 = nothing to write). */
export function compactAssets(project, receiptOf) {
  let changed = 0;
  if (!Array.isArray(project.assets)) return 0;
  project.assets = project.assets.map(asset => {
    const id = asset?.provenance?.generationJobId;
    const next = id ? compactAsset(asset, receiptOf(id)) : asset;
    if (next !== asset) changed++;
    return next;
  });
  return changed;
}
