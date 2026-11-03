import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { sanitize, pathOnly, diagnosticsText, issueBody, issueUrl, NEW_ISSUE_URL, MAX_ISSUE_URL, MAX_DIAGNOSTICS } from '../shared/report-issue.mjs';

// Built at runtime so the publish secret/path scan does not treat fixtures as live secrets or home paths.
const USERS = '/' + 'Users';
const JWT_HEAD = 'eyJ' + 'hbGciOi';
const ANT_KEY = 'sk-' + 'ant-abcdefgh12345678';
const GHP_KEY = 'ghp_' + 'ABCDEFGHijklmnop1234';

// "Report a problem" (shared/report-issue.mjs): nothing private may reach the prefilled GitHub issue.
test('sanitize removes keys, tokens, secrets and authorization values', () => {
  const s = sanitize(`COMFY_CLOUD_API_KEY=abc123def api_key: "zzz" token=t0k3n&x=1 {"secret":"s3cr3t"} Authorization: Bearer ${JWT_HEAD}.payload.sig password=hunter2`);
  for (const leaked of ['abc123def', 'zzz', 't0k3n', 's3cr3t', JWT_HEAD, 'hunter2']) assert.ok(!s.includes(leaked), `${leaked} in ${s}`);
  assert.match(s, /COMFY_CLOUD_API_KEY=\[redacted\]/);
  assert.equal(sanitize(`using ${ANT_KEY} and ${GHP_KEY}`), 'using [redacted] and [redacted]');
  assert.equal(sanitize('blob 0123456789abcdef0123456789abcdef01'), 'blob [redacted]');
});

test('sanitize keeps ids but strips paths to the home folder, emails and query strings', () => {
  const id = '7e0d0a11-0000-4000-8000-000000000001';
  assert.equal(sanitize(`project ${id}`), `project ${id}`, 'UUIDs survive');
  assert.equal(sanitize(`read ${USERS}/steven/dev/previs/data/x.json`), 'read ~/dev/previs/data/x.json');
  assert.equal(sanitize('at /home/ana/app.js and C:\\Users\\Ana\\app.js'), 'at ~/app.js and ~\\app.js');
  assert.equal(sanitize('in /srv/me/x', { home: '/srv/me' }), 'in ~/x');
  assert.equal(sanitize(`file://${USERS}/bo/a.png`), '[path]');
  assert.equal(sanitize(`file://${USERS}/bo/My%20Private%20Project/a.png?key=secret`), '[path]');
  assert.equal(sanitize(`file:///C:${USERS}/Ana/private.png`), '[path]');
  assert.equal(sanitize('mail ana.b+x@example.co.uk now'), 'mail [email] now');
  assert.equal(sanitize('GET /api/director/project?id=abc&key=1 → 500'), 'GET /api/director/project → 500');
  assert.equal(sanitize('https://example.com/a/b?sig=xyz#top'), 'https://example.com/a/b');
  assert.equal(pathOnly('http://127.0.0.1:5190/api/x?y=1#z'), '/api/x');
  assert.equal(pathOnly('/api/jobs?since=3'), '/api/jobs');
});

test('sanitizer covers quoted and partial credentials, URL credentials, fragments and private headers', () => {
  for (const input of [
    `api_key='private value with spaces'`,
    `{"access_token":"private value with spaces"}`,
    `password="private value without closing quote`,
    'https://alice:private@example.com/api?signature=private#private',
    '/api/project#access_token=private',
    'Cookie: session=private; unrelated=private',
    'Authorization: Bearer private',
    'Basic cHJpdmF0ZQ==',
  ]) {
    const sanitized = sanitize(input);
    assert.ok(!sanitized.includes('private') || sanitized === '[private header]', sanitized);
    assert.equal(sanitize(sanitized), sanitized, 'sanitization is idempotent');
  }
  assert.equal(pathOnly('/api/x?email=ana@example.com#token=private'), '/api/x');
  assert.equal(pathOnly('http://[broken/api?token=private'), 'http://[broken/api');
});

test('redaction precedes truncation and diagnostics/body bounds apply to oversized fields', () => {
  const errors = ['x'.repeat(290) + ' token=' + 's'.repeat(1000)];
  const details = diagnosticsText(Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`Field ${index}`, 'é'.repeat(1000)])), errors);
  assert.ok(details.length <= MAX_DIAGNOSTICS);
  assert.ok(!diagnosticsText({}, errors).includes('ssss'), 'no partial token at the cut');
  assert.ok(issueBody('é'.repeat(100000), 'é'.repeat(10000)).length <= MAX_DIAGNOSTICS + 1500);
  const body = new URL(issueUrl('Bug: key=private', `raw token=private alice@example.com ${USERS}/Ana/test`)).searchParams.get('body');
  assert.ok(!body.includes('private') && !body.includes('alice@') && !body.includes(`${USERS}/Ana`));
});

test('URL bounds handle Unicode, malformed surrogates, long titles and tight valid budgets', () => {
  for (const max of [256, 1000, MAX_ISSUE_URL]) {
    const url = issueUrl('🎥'.repeat(1000), issueBody('🎥'.repeat(10000) + '\ud800'), max);
    assert.ok(url.length <= max);
    assert.ok(new URL(url).searchParams.has('body'));
    assert.doesNotThrow(() => decodeURIComponent(url));
  }
  for (const max of [0, 100, Infinity, NaN, 7001]) assert.throws(() => issueUrl('t', 'b', max), RangeError);
});

test('diagnostics keep the last 10 errors, sanitized, and the body has the template sections', () => {
  const errors = Array.from({ length: 14 }, (_, i) => `error ${i} token=x${i}`);
  const d = diagnosticsText({ App: 'Comfy Previs 0.1.0', Empty: '', 'Project id': null }, errors);
  assert.match(d, /^App: Comfy Previs 0\.1\.0\n/);
  assert.ok(!d.includes('Empty') && !d.includes('Project id'), 'empty fields are left out');
  assert.equal((d.match(/^- error/gm) || []).length, 10);
  assert.ok(!d.includes('error 3 ') && d.includes('error 13'), 'oldest dropped');
  assert.ok(!/x1[0-3]/.test(d), 'tokens redacted');
  assert.match(diagnosticsText({}), /- none recorded/);
  const body = issueBody(d, 'Export failed for alice@example.com');
  for (const head of ['### What happened', '### What you expected', '### Steps to reproduce', '### Diagnostics']) assert.ok(body.includes(head), head);
  assert.match(body, /Export failed for \[email\]/);
});

test('issueUrl prefills title and body and stays under the cap, truncating the body', () => {
  const short = issueUrl('Bug: x', 'hello');
  assert.ok(short.startsWith(`${NEW_ISSUE_URL}?title=`));
  const u = new URL(short); assert.equal(u.searchParams.get('title'), 'Bug: x'); assert.equal(u.searchParams.get('body'), 'hello');
  const huge = issueBody(diagnosticsText({ App: 'x' }, Array.from({ length: 10 }, () => 'é'.repeat(300))) + 'ü'.repeat(9000));
  const url = issueUrl('Bug: long', huge);
  assert.ok(url.length <= MAX_ISSUE_URL, `${url.length}`);
  const body = new URL(url).searchParams.get('body');
  assert.match(body, /truncated/); assert.ok(body.startsWith('### What happened'));
  assert.ok(issueUrl('t', 'x'.repeat(5000), 1000).length <= 1000);
});

test('previs_report_issue returns the prefilled URL with setting names only, no values', async () => {
  const agent = spawn(process.execPath, ['server/previs/agent.mjs'], { env: { ...process.env, PREVIS_MCP_LEGACY: '', PREVIS_URL: 'http://127.0.0.1:9', PREVIS_REPORT_TEST_SECRET: 'do-not-leak-42' }, stdio: ['pipe', 'pipe', 'inherit'] });
  try {
    const lines = createInterface({ input: agent.stdout })[Symbol.asyncIterator]();
    agent.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'previs_report_issue', arguments: { summary: 'Blockout render hangs' } } }) + '\n');
    const m = JSON.parse((await lines.next()).value);
    assert.equal(m.result.isError, false, m.result.content[0].text);
    const out = JSON.parse(m.result.content[0].text);
    assert.ok(out.url.startsWith(NEW_ISSUE_URL) && out.url.length <= MAX_ISSUE_URL);
    assert.match(out.diagnostics, /Node: v\d+/); assert.match(out.diagnostics, /PREVIS_REPORT_TEST_SECRET/); assert.match(out.diagnostics, /app not reachable/);
    assert.ok(!out.diagnostics.includes('do-not-leak-42') && !out.url.includes('do-not-leak-42'));
    assert.equal(new URL(out.url).searchParams.get('title'), 'Bug: Blockout render hangs');
  } finally { agent.kill(); }
});

test('MCP reporting reads setup statuses only, redacts its summary, and makes no write requests', async () => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ dataDir: `${USERS}/Alice/private`, checks: [{ id: 'cloud', status: 'optional', detail: 'private setting value', fix: 'private fix' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const agent = spawn(process.execPath, ['server/previs/agent.mjs'], { env: { ...process.env, PREVIS_MCP_LEGACY: '', PREVIS_URL: `http://127.0.0.1:${server.address().port}`, PREVIS_REPORT_TEST_SECRET: 'private environment value' }, stdio: ['pipe', 'pipe', 'inherit'] });
  try {
    const lines = createInterface({ input: agent.stdout })[Symbol.asyncIterator]();
    agent.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'previs_report_issue', arguments: { summary: `Failure token="private summary" alice@example.com file://${USERS}/Alice/private` } } }) + '\n');
    const message = JSON.parse((await lines.next()).value);
    assert.equal(message.result.isError, false);
    const output = JSON.parse(message.result.content[0].text);
    assert.match(output.diagnostics, /Setup: cloud optional/);
    assert.match(output.diagnostics, /PREVIS_REPORT_TEST_SECRET/);
    assert.ok(!JSON.stringify(output).includes('private'));
    assert.ok(!new URL(output.url).searchParams.get('body').includes('alice@'));
    assert.deepEqual(requests, ['GET /api/director/setup']);
  } finally {
    agent.kill();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
