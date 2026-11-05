// "Report a problem": the sanitizer, the diagnostics block and the prefilled GitHub issue URL, shared by the app
// (src/director-report.ts) and the MCP tool previs_report_issue (server/previs/agent.mjs). Nothing here sends anything.
export const REPO_URL = 'https://github.com/sbobyn/video-lab';
export const NEW_ISSUE_URL = `${REPO_URL}/issues/new`;
/** GitHub accepts long URLs, but browsers and proxies get unreliable past ~8 kB. */
export const MAX_ISSUE_URL = 7000;
export const MAX_DIAGNOSTICS = 12000;
const TRUNCATED = '\n…(truncated: use “Copy details” in the app for the full log)';

/** Strip what must never leave the machine: secrets, query strings, emails and the home directory. */
export function sanitize(text, { home } = {}) {
  let s = String(text ?? '').toWellFormed();
  if (home && home.length > 1) s = s.split(home).join('~');
  return s
    .replace(/\bfile:\/\/[^\s"'`<>)]*/gi, '[path]')
    .replace(/(\bhttps?:\/\/)[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/((?:\bhttps?:\/\/|\/)[^\s?#"'`<>)]*)[?#][^\s"'`<>)]*/gi, '$1')
    .replace(/(?:\/Users|\/home)\/[^/\s"'`:]+/g, '~')
    .replace(/\b[A-Za-z]:\\Users\\[^\\\s"'`]+/gi, '~')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
    .replace(/\b(?:Cookie|Set-Cookie|Authorization)(?:["']?\s*:\s*)[^\r\n]+/gi, '[private header]')
    .replace(/\b(Bearer|Basic|Token)\s+[\w\-.~+/=]+/gi, '$1 [redacted]')
    .replace(/([\w-]*(?:api[_-]?key|key|token|secret|password|passwd|authorization|auth|cookie|session|credential)[\w-]*)(["']?\s*[:=]\s*)(?:"[^"\r\n]*"?|'[^'\r\n]*'?|[^\s"',;&)}\[\]]+)/gi, '$1$2[redacted]')
    .replace(/\b(?:sk|pk|rk|ghp|gho|ghs|ghu|github_pat|xox[abpr])[-_][\w-]{8,}/g, '[redacted]')
    .replace(/\b[A-Za-z0-9_]{32,}\b/g, '[redacted]');
}

/** A request path with no origin, query or fragment. */
export function pathOnly(url) {
  try { return sanitize(new URL(String(url), 'http://x').pathname); } catch { return sanitize(String(url).split(/[?#]/)[0]); }
}

/** The user-visible Diagnostics block: label: value lines, then the recent errors (newest last, ~10). */
export function diagnosticsText(fields, errors = [], opts = {}) {
  const lines = Object.entries(fields).filter(([, v]) => v !== undefined && v !== null && v !== '').slice(0, 30).map(([k, v]) => `${sanitize(k, opts).slice(0, 80)}: ${sanitize(v, opts).slice(0, 500)}`);
  const recent = errors.slice(-10).map(e => `- ${sanitize(e, opts).replace(/\s+/g, ' ').slice(0, 300)}`);
  const diagnostics = [...lines, '', 'Recent errors:', ...(recent.length ? recent : ['- none recorded']), ''].join('\n');
  return diagnostics.length <= MAX_DIAGNOSTICS ? diagnostics : diagnostics.slice(0, MAX_DIAGNOSTICS - 20) + '\n…(truncated)';
}

export const ISSUE_TEMPLATE = '### What happened\n\n\n### What you expected\n\n\n### Steps to reproduce\n1. \n2. \n\n';

export function issueBody(diagnostics, summary = '') {
  return `${ISSUE_TEMPLATE.replace('### What happened\n\n', `### What happened\n${summary ? sanitize(summary).slice(0, 1000) + '\n' : ''}\n`)}### Diagnostics\n<!-- Collected by video-lab. Review it before submitting; remove anything you do not want to share. -->\n\`\`\`\n${sanitize(diagnostics).trim().slice(0, MAX_DIAGNOSTICS)}\n\`\`\`\n`;
}

/** The prefilled new-issue URL, under max characters: the body (logs last) is cut first, then the title. */
export function issueUrl(title, body, max = MAX_ISSUE_URL) {
  if (!Number.isInteger(max) || max < 256 || max > MAX_ISSUE_URL) throw new RangeError('Issue URL limit must be between 256 and 7000');
  const make = (t, b) => `${NEW_ISSUE_URL}?title=${encodeURIComponent(t.toWellFormed())}&body=${encodeURIComponent(b.toWellFormed())}`;
  let t = sanitize(title).slice(0, 200);
  body = sanitize(body);
  while (make(t, TRUNCATED).length > max && t.length) t = t.slice(0, -1);
  let url = make(t, body);
  if (url.length <= max) return url;
  const fence = body.lastIndexOf('```\n') === body.length - 4 ? '\n```\n' : '';
  let lo = 0, hi = body.length;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (make(t, body.slice(0, mid) + TRUNCATED + fence).length <= max) lo = mid; else hi = mid - 1; }
  url = make(t, body.slice(0, lo) + TRUNCATED + fence);
  return url.length <= max ? url : make(t, '');
}
