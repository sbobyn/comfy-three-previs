// Failure taxonomy for generation and refgen receipts, shown in GET /api/jobs.
// classifyFailure(job) → { category, retryable, charged, advice } or null when the job has not failed.
//   retryable: a new request (or a plain resubmit of a never-sent draft) is expected to succeed without changes.
//   charged: 'no' (nothing reached a paid node), 'unknown' (billing cannot be proved from receipts).
// Built from stored fields only, so it also classifies receipts written before this module existed.

export const FAILURE_CATEGORIES = Object.freeze({
  'stale-revision': 'Another writer moved the engine project between read and write',
  busy: 'All submission slots for this backend were in use',
  duplicate: 'An identical request is already running or finished recently',
  'cost-cap': 'The quote is above the allowance or the batch budget',
  'quote-invalidated': 'Schema, inputs, settings or price changed after the quote',
  'invalid-params': 'Inputs or parameters were refused before dispatch',
  'transient-network': 'Network, timeout or a truncated/non-JSON backend response',
  auth: 'Credential missing or refused',
  'insufficient-credits': 'The account cannot pay for this request',
  'rate-limited': 'The backend refused the request with HTTP 429',
  'not-sent': 'Stopped before dispatch for another reason',
  'dispatch-uncertain': 'The request may or may not have reached the backend',
  'provider-transient': 'The partner/provider failed on its side (server error, timeout, overload)',
  'content-filter': 'The provider refused the prompt or an image on content grounds',
  'provider-rejected-params': 'The provider refused a parameter or an input image',
  'provider-error': 'The provider reported an execution error',
  cancelled: 'The job was cancelled on the backend',
  collection: 'The job ran but its output could not be collected yet',
  unknown: 'Unclassified failure',
});

const text = job => [job.failure?.detail, job.provider?.error?.message, job.lastAttempt?.error, job.message].filter(Boolean).join(' · ');
const TRANSIENT = /transport failed|timed out|timeout|invalid JSON|ECONN|EAI_AGAIN|ENOTFOUND|socket hang up|network|HTTP 50[0-4]|HTTP 408|HTTP 425/i;
const PROVIDER_TRANSIENT = /server side error|internal server error|service unavailable|temporarily|overloaded|try again|timed out|timeout|HTTP 5\d\d|bad gateway|gateway time/i;
const CONTENT = /moderat|safety|nsfw|content polic|flagged|inappropriate|prohibited|sensitive|violat|blocked by|filtered/i;
const PARAMS = /invalid|must be|must not|exceed|too (?:long|large|small|many)|out of range|not supported|unsupported|resolution|dimension|aspect|duration|required/i;

const result = (category, retryable, charged, advice) => ({ category, retryable, charged, advice });

export function classifyFailure(job) {
  if (!job) return null;
  const all = text(job), http = job.failure?.httpStatus ?? job.lastAttempt?.httpStatus ?? null;
  // Refused before dispatch (the draft keeps its status; lastAttempt records why).
  if (['quoted', 'prepared'].includes(job.status) && job.lastAttempt) return beforeDispatch(job.lastAttempt.code, job.lastAttempt.error || '', http);
  if (job.status === 'invalidated') return result('quote-invalidated', true, 'no', 'Quote again; the old approval no longer matches the request.');
  if (job.status === 'uncertain') return result('dispatch-uncertain', false, 'unknown', 'Do not resubmit. Check Comfy Cloud history for this request id; the tracker keeps polling a known prompt id.');
  if (job.status === 'recovery-required' || (['collecting', 'attaching'].includes(job.status) && job.failure)) return result('collection', false, 'unknown', 'Recover existing outputs only; never regenerate. Automatic recovery is limited to three attempts per phase across restarts.');
  if (job.status !== 'failed') return null;
  const phase = job.failure?.phase || null;
  if (phase === 'preparation' || phase === 'preflight') return beforeDispatch(null, all, http);
  if (phase === 'dispatch') {
    if (http === 401 || http === 403) return result('auth', false, 'no', 'Check COMFY_CLOUD_API_KEY on the server, then quote again.');
    if (http === 402) return result('insufficient-credits', false, 'no', 'Add credits to the Comfy account, then quote again.');
    if (http === 429) return result('rate-limited', true, 'no', 'The backend was rate limiting; quote again in a minute.');
    if (http === 400 || http === 413 || http === 422) return result('invalid-params', false, 'no', 'The backend refused the graph; read the detail, fix the inputs and quote again.');
    if (job.failure?.notSent === true) return result('not-sent', true, 'no', 'The backend did not accept the request; quote again.');
    return result('dispatch-uncertain', false, 'unknown', 'No proof of rejection; inspect backend history before any new request.');
  }
  if (phase === 'execution') {
    if (job.provider?.status === 'cancelled') return result('cancelled', true, 'unknown', 'Cancelled on the backend; generate again if it is still wanted.');
    if (CONTENT.test(all)) return result('content-filter', false, 'unknown', 'Reword the prompt or swap the flagged reference image; an identical retry will be refused again.');
    if (PROVIDER_TRANSIENT.test(all)) return result('provider-transient', true, 'unknown', 'Provider-side failure; a new request with the same settings usually succeeds. Partner charges for failed runs are not guaranteed to be refunded.');
    if (PARAMS.test(all)) return result('provider-rejected-params', false, 'unknown', 'The provider refused an input; check reference count, image sizes, duration and resolution against the model.');
    return result('provider-error', false, 'unknown', 'Read the provider detail before retrying.');
  }
  if (['declared-outputs', 'identity', 'history', 'media-transfer', 'media-probe', 'media-save'].includes(phase)) return result('collection', false, 'unknown', 'Do not regenerate. Inspect the saved provider output and recover collection; terminal failed receipts may need operator repair.');
  if (TRANSIENT.test(all)) return result('transient-network', true, 'unknown', 'Check the receipt before retrying.');
  return result('unknown', false, 'unknown', 'Read the receipt detail before retrying.');
}

function beforeDispatch(code, all, http) {
  if (code === 'busy' || /Backend busy/i.test(all)) return result('busy', true, 'no', 'Wait for a slot; the batch scheduler retries automatically.');
  if (code === 'duplicate' || /identical request/i.test(all)) return result('duplicate', false, 'no', 'Use the existing request instead of sending it again.');
  if (/Project changed/i.test(all)) return result('stale-revision', true, 'no', 'Retry; engine writes are queued server-side.');
  if (/allowance|budget|above the|maxAmount|exceeds the approved/i.test(all)) return result('cost-cap', false, 'no', 'Raise the allowance or budget, or choose a cheaper model.');
  if (/invalidated|Quote changed|prepare and quote again|Request changed/i.test(all)) return result('quote-invalidated', true, 'no', 'Quote again.');
  if (http === 401 || http === 403 || /COMFY_CLOUD_API_KEY|PREVIS_ALLOW_PAID/i.test(all)) return result('auth', false, 'no', 'Server credentials or the paid-execution switch are not set.');
  if (TRANSIENT.test(all)) return result('transient-network', true, 'no', 'Nothing was sent; resubmit the same request.');
  if (PARAMS.test(all) || /Choose|Unknown|missing|lacks|not schema-compatible|not compatible/i.test(all)) return result('invalid-params', false, 'no', 'Fix the inputs; nothing was sent.');
  return result('not-sent', true, 'no', 'Nothing was sent; resubmit the same request.');
}
