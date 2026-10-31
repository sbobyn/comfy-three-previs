// One rule for every paid image request the workspace sends (stills, object images, cast images, design sheets): it goes
// out only under a spending bound the artist approved on screen (a quote card or a batch approval), with the prepared
// quote's estimate inside what is left of that bound. A request with no estimate is never sent from here. Each request
// is sent once; the server still checks the fingerprint, paid switch and budget ledger. No imports, so tests load it as is.

/** A total the artist approved for one action, and the estimates sent under it so far. */
export type SpendBound = { capUsd: number; spentUsd: number };
type Quote = { status?: string; amount?: number | null; estimate?: number | null };
type Prepared = { id: string; fingerprint: string; quote?: Quote };
type Approval = { approved: true; fingerprint: string; allowance: { currency: 'USD'; maxAmount: number; allowUnknownCharges?: true } };
type Api = (path: string, body?: unknown) => Promise<any>;

const r4 = (x: number) => Math.round(x * 10000) / 10000;
/** A local request on native nodes: the server quoted a known $0. */
export const isFree = (job: Prepared) => job.quote?.status === 'known' && job.quote.amount === 0;
/** What the prepared quote expects this request to bill (list + references + grader), 0 when free, null when unknown. */
export function expectedUsd(job: Prepared): number | null {
  if (isFree(job)) return 0;
  const e = job.quote?.estimate;
  return typeof e === 'number' && Number.isFinite(e) ? e : null;
}
/** A starting allowance for the artist to review: the estimate with 25 % headroom, rounded up to the cent. */
export const suggestedCap = (estimate: number) => Math.max(0.01, Math.ceil(estimate * 125 - 1e-9) / 100);

/** The approval for one prepared request under `bound`, or why it must not be sent. */
export function approvalFor(job: Prepared, bound: SpendBound | null): { approval: Approval } | { refused: string } {
  if (isFree(job)) return { approval: { approved: true, fingerprint: job.fingerprint, allowance: { currency: 'USD', maxAmount: 0 } } };
  const est = expectedUsd(job);
  if (est === null) return { refused: 'This request has no cost estimate; nothing was sent. Choose a priced model.' };
  if (!bound || !(bound.capUsd > 0)) return { refused: 'Approve a spending limit first; nothing was sent.' };
  const left = r4(bound.capUsd - bound.spentUsd);
  if (est > left + 1e-9) return { refused: `Estimated $${est.toFixed(3)} would pass the $${bound.capUsd.toFixed(2)} you approved ($${Math.max(0, left).toFixed(2)} left); nothing was sent.` };
  // Comfy Cloud bills actual usage (the quote is an estimate), so the approval accepts unknown charges up to what is left.
  return { approval: { approved: true, fingerprint: job.fingerprint, allowance: { currency: 'USD', maxAmount: left, allowUnknownCharges: true } } };
}

/** Send one prepared image request once under `bound`, then count its estimate as spent. Throws (nothing sent) when refused. */
export async function submitImage(api: Api, projectId: string, job: Prepared, bound: SpendBound | null) {
  const a = approvalFor(job, bound);
  if ('refused' in a) throw Object.assign(Error(a.refused), { refused: true });
  const r = await api('director/refgen/submit', { projectId, requestId: job.id, approval: a.approval });
  if (bound) bound.spentUsd = r4(bound.spentUsd + (expectedUsd(job) ?? 0));
  return r;
}
