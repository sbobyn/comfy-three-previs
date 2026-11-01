// Spend trust (launch blocker L1): every paid image request from the workspace waits for a visible approval with a
// bound, is sent once and never above it; a request without an estimate is never sent. Submissions are intercepted:
// nothing here reaches a server or provider. The review's repro: one click on “Generate · ≈ $0.05” prepared a $0.42
// quote and submitted it at once with an unseen $0.84 allowance and unknown charges allowed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const read = f => readFile(new URL(`../src/${f}`, import.meta.url), 'utf8');
const compile = s => ts.transpileModule(s, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const spendSource = await read('director-spend.ts');
const spend = await import('data:text/javascript,' + encodeURIComponent(ts.transpileModule(spendSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText));
const between = (src, from, to) => { const a = src.indexOf(from); assert.ok(a >= 0, from); const b = src.indexOf(to, a); assert.ok(b > a, to); return src.slice(a, b); };
// A tiny DOM stand-in.
const h = (tag, attrs = {}, ...children) => ({ tag, ...attrs, children: children.flat().filter(c => c != null && c !== false), replaceChildren(...c) { this.children = c.flat().filter(x => x != null && x !== false); }, append(...c) { this.children.push(...c); }, scrollIntoView() {} });
const walk = n => (n && typeof n === 'object' ? [n, ...(n.children || []).flatMap(walk)] : []);
const text = n => (n == null ? '' : typeof n === 'string' ? n : (n.children || []).map(text).join(' '));
const quoted = (id, estimate, extra = {}) => ({ id, fingerprint: `fp-${id}`, count: 1, aspect: '16:9', seed: 1, model: 'GPT Image 2.5', backend: { kind: 'cloud' }, status: 'quoted', quote: { status: 'unknown', amount: null, estimate, label: `≈ $${estimate?.toFixed(3)} estimate (list $0.076 + 6 reference images $0.106 + grader $0.05)` }, ...extra });
const interceptor = () => { const sent = []; return { sent, api: async (path, body) => { sent.push({ path, body: JSON.parse(JSON.stringify(body)) }); if (path === 'director/refgen/prepare') return { job: quoted('prep', 0.42) }; return { job: { id: body.requestId, status: 'submitted' } }; } }; };

test('spend bound: free, unknown, within and over the approved total; sent once and counted', async () => {
  const { approvalFor, submitImage, expectedUsd, suggestedCap } = spend;
  assert.deepEqual(approvalFor({ id: 'l', fingerprint: 'f', quote: { status: 'known', amount: 0 } }, null).approval.allowance, { currency: 'USD', maxAmount: 0 }, 'free local needs no bound and accepts no charge');
  assert.match(approvalFor(quoted('u', null), { capUsd: 5, spentUsd: 0 }).refused, /no cost estimate; nothing was sent/);
  assert.match(approvalFor(quoted('a', 0.42), null).refused, /Approve a spending limit first/);
  assert.match(approvalFor(quoted('a', 0.42), { capUsd: 0.4, spentUsd: 0 }).refused, /Estimated \$0\.420 would pass the \$0\.40 you approved/);
  assert.deepEqual(approvalFor(quoted('a', 0.42), { capUsd: 1, spentUsd: 0.3 }).approval, { approved: true, fingerprint: 'fp-a', allowance: { currency: 'USD', maxAmount: 0.7, allowUnknownCharges: true } }, 'the allowance is what is left of the approved total');
  assert.equal(expectedUsd(quoted('a', 0.42)), 0.42); assert.equal(suggestedCap(0.42), 0.53);

  const { sent, api } = interceptor(), bound = { capUsd: 1, spentUsd: 0 };
  await submitImage(api, 'p', quoted('a', 0.42), bound);
  await submitImage(api, 'p', quoted('b', 0.42), bound);
  await assert.rejects(submitImage(api, 'p', quoted('c', 0.42), bound), e => e.refused === true && /\$0\.16 left/.test(e.message));
  assert.equal(sent.length, 2, 'the third request is not sent');
  assert.deepEqual(sent.map(x => x.body.approval.allowance.maxAmount), [1, 0.58]);
  assert.equal(bound.spentUsd, 0.84);
});

test('contract: only director-spend.ts submits image requests; video submits only from the approval cards', async () => {
  const files = (await readdir(new URL('../src/', import.meta.url))).filter(f => f.endsWith('.ts'));
  const image = [], video = [];
  for (const f of files) {
    const src = await read(f);
    if (src.includes("'director/refgen/submit'")) image.push(f);
    for (const m of src.matchAll(/api\('generation\/submit'/g)) video.push(`${f}:${src.slice(0, m.index).split('\n').length}`);
  }
  assert.deepEqual(image, ['director-spend.ts']);
  const director = await read('director.ts'), sequence = await read('director-sequence.ts');
  assert.equal(video.length, 2, video.join(', '));
  assert.ok(between(director, 'function genQuote(', '// ---------- Live sync').includes("api('generation/submit'"), 'shot video: the quote card');
  assert.ok(between(sequence, '  async function runBatch(', '\n  }\n').includes("api('generation/submit'"), 'sequence: the approved batch');
  assert.doesNotMatch(director, /generateNow/, 'no unseen one-click approval remains');
  for (const f of ['director-looks.ts', 'director-sheet.ts']) assert.doesNotMatch(await read(f), /allowUnknownCharges/, `${f} leaves allowances to director-spend.ts`);
  assert.equal([...director.matchAll(/allowUnknownCharges/g)].length, 1, 'director.ts: only the video quote card, after its own acknowledgment');
  assert.ok(between(director, 'function genQuote(', '// ---------- Live sync').includes('allowUnknownCharges: !free'));
});

test('storyboard still: Generate prepares and shows the quote; nothing is submitted until the card is approved within its limit', async () => {
  const director = await read('director.ts');
  const { sent, api } = interceptor(), reviewing = new Map(), cards = [];
  const versions = [];
  const ctx = { h, api, reviewing, projectId: 'p', project: {}, t: 0, snap: { index: 0, frameAt: 'start' }, s: { id: 'shot', duration: 5 }, f: { presetId: 'gpt-image-25', count: 1, seed: 7 }, words: { text: '' }, looks: [], refIds: [], prev: null, prevImage: null, blender: false,
    guide: { data: Promise.resolve('data:image/png;base64,R1VJREU=') }, stillPromptPlan: () => ({ text: 'full prompt' }), edit: async ops => { versions.push(...ops); }, prompt: { value: 'A still' }, moment: { value: '' },
    go: {}, status: h('div'), review: job => cards.push(job) };
  runInNewContext(compile(between(director, "  go.onclick = async () => {\n    go.disabled = true; status.className = 'status-line'; status.textContent = 'Preparing the quote", "\n  const inputs = h('div', { class: 'sb-inputs' }")), ctx);
  await ctx.go.onclick();
  assert.deepEqual(sent.map(x => x.path), ['director/refgen/prepare'], 'one click prepares only');
  assert.deepEqual([sent[0].body.frameAt, sent[0].body.frame], ['start', 0], 'the still names its exact blockout frame');
  assert.equal(cards.length, 1); assert.equal(reviewing.get('still:shot').id, 'prep');
  assert.deepEqual(versions.map(o => [o.op, o.kind, o.version.text, o.version.reason]), [['record_prompt_version', 'image', 'full prompt', 'quote']], 'the quoted prompt is kept as a version (history only)');

  // The card: the exact prepared quote, an allowance the artist sets, explicit approval; sent once.
  let closed = null;
  const qctx = { h, api, projectId: 'p', refgen: { paidExecutionEnabled: true }, loadRefgen: async () => {}, pollJobs() {}, ...spend };
  runInNewContext(compile(between(director, 'function quoteCard(', '\nfunction jobRow(')), qctx);
  const card = qctx.quoteCard(quoted('prep', 0.42), s => { closed = s; }), nodes = walk(card);
  assert.match(text(card), /≈ \$0\.420 estimate \(list \$0\.076/, 'the card shows the prepared quote, not the list price');
  const [approve, unknown] = nodes.filter(n => n.type === 'checkbox'), max = nodes.find(n => n.type === 'number'), go = nodes.find(n => n.class === 'btn camera');
  assert.equal(max.value, 0.53, 'a visible starting allowance near the quote');
  approve.checked = true; approve.onchange(); assert.equal(go.disabled, true, 'unknown Cloud charges need their own acknowledgment');
  unknown.checked = true; unknown.onchange(); assert.equal(go.disabled, false);
  max.value = '0.30'; await go.onclick();
  assert.equal(sent.length, 1, 'an allowance below the quote sends nothing'); assert.match(walk(card).map(n => n.textContent || '').join(' '), /would pass the \$0\.30 you approved/); assert.equal(closed, null);
  max.value = '0.50'; await go.onclick();
  assert.equal(sent.length, 2); assert.equal(closed, true);
  assert.deepEqual(sent[1], { path: 'director/refgen/submit', body: { projectId: 'p', requestId: 'prep', approval: { approved: true, fingerprint: 'fp-prep', allowance: { currency: 'USD', maxAmount: 0.5, allowUnknownCharges: true } } } });
  // A model without an estimate cannot be approved here.
  const none = qctx.quoteCard(quoted('none', null), () => {}), go2 = walk(none).find(n => n.class === 'btn camera');
  for (const c of walk(none).filter(n => n.type === 'checkbox')) { c.checked = true; c.onchange?.(); }
  assert.equal(go2.disabled, true); assert.match(text(none), /No cost estimate for this model/);
});

test('object image: Review quote prepares and shows the card; nothing is submitted', async () => {
  const director = await read('director.ts');
  const { sent, api } = interceptor(), reviewing = new Map(), cards = [];
  const ctx = { h, api, reviewing, projectId: 'p', e: { id: 'ent' }, form: { presetId: 'flux-3', prompt: 'A car', aspect: '4:3', count: 2, seed: 3, checkpoint: '' }, quoteBtn: {}, quoteStatus: h('div'), review: job => cards.push(job) };
  runInNewContext(compile(between(director, "  quoteBtn.onclick = async () => {\n    quoteBtn.disabled = true; quoteStatus.className = 'status-line'; quoteStatus.textContent = 'Preparing the quote", '\n  const jobs = refgen.jobs.filter(j => j.entityId === e.id);')), ctx);
  await ctx.quoteBtn.onclick();
  assert.deepEqual(sent.map(x => x.path), ['director/refgen/prepare']); assert.equal(cards.length, 1); assert.ok(reviewing.has('entity:ent'));
});

test('cast images board: quoting shows the table and waits; the approved total bounds every request and stops the batch', async () => {
  const looks = await read('director-looks.ts');
  const sent = [], picked = new Set(['e1', 'e2', 'e3']), ents = [...picked].map(id => ({ id, name: id.toUpperCase(), kind: 'prop' }));
  const api = async (path, body) => { sent.push({ path, body: JSON.parse(JSON.stringify(body)) }); if (path === 'director/refgen/prepare') return { job: quoted(`j${sent.length}`, body.entityId === 'e3' ? null : 0.42) }; if (path === 'director/refgen/submit') return { job: { id: body.requestId, status: 'completed' } }; return { job: { status: 'completed' } }; };
  const batch = h('div');
  const ctx = { h, api, batch, quoteBtn: {}, busy: false, plan: [], picked, views: {}, presetSel: { value: 'flux-3' }, countSel: { value: '1' }, P: () => ({ id: 'p', scene: { entities: ents } }), lookViews: () => ({ front: 'Front' }), lookPrompt: () => 'look', aspectFor: () => '4:3', lookSource: () => null,
    ctx: { reloadRefgen: async () => {}, refgen: () => ({ paidExecutionEnabled: true }) }, draw() {}, syncToolbar() {}, toast() {}, sleep: async () => {}, ...spend };
  runInNewContext(compile(between(looks, '  quoteBtn.onclick = async () => {', "\n  const dlg = h('dialog', { class: 'looks'")), ctx);
  await ctx.quoteBtn.onclick();
  assert.deepEqual(sent.map(x => x.path), ['director/refgen/prepare', 'director/refgen/prepare', 'director/refgen/prepare'], 'quoting sends nothing');
  const nodes = walk(batch), approve = nodes.find(n => n.type === 'checkbox'), cap = nodes.find(n => n.type === 'number'), go = nodes.find(n => n.class === 'btn camera');
  assert.match(text(batch), /E3.*Skipped · no cost estimate for this model/, 'an unpriced request is listed and skipped, never sent at a guessed price');
  assert.match(text(batch), /Estimated total.*≈ \$0\.84/);
  assert.equal(cap.value, '1.05'); assert.equal(go.disabled, true);
  approve.checked = true; approve.onchange(); assert.equal(go.disabled, false);
  cap.value = '0.60'; go.onclick();
  for (let i = 0; i < 20 && ctx.busy !== false; i++) await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 5));
  const submits = sent.filter(x => x.path === 'director/refgen/submit');
  assert.equal(submits.length, 1, 'the second $0.42 request would pass the $0.60 approved and is not sent');
  assert.equal(submits[0].body.approval.allowance.maxAmount, 0.6);
  assert.match(text(batch), /would pass the \$0\.60 you approved.*Stopped/);
});

test('design sheet: views wait for an approved total; the runner submits only under it and stops when it would pass', async () => {
  const sheet = await read('director-sheet.ts');
  const { estimateBreakdown } = await import('../shared/tiers.mjs');
  let started = 0;
  const ctx = { h, estimateBreakdown, money: n => `$${n.toFixed(3)}`, draw() {}, running: false, bound: null, asks: new Map(), ...spend };
  runInNewContext(compile(between(sheet, 'function askApproval(', '// ---------- Actions ----------')), ctx);
  ctx.askApproval({ id: 'e' }, 4, 'flux-2-pro', 1, () => { started++; });
  const panel = ctx.approvalPanel({ id: 'e' }), nodes = walk(panel);
  assert.match(text(panel), /4 image requests · ≈ \$0\.180 expected \(list \$0\.112 \+ reference images \$0\.068\)/, 'list + reference images, from the same prices the server quotes');
  const approve = nodes.find(n => n.type === 'checkbox'), cap = nodes.find(n => n.type === 'number'), go = nodes.find(n => n.class === 'btn cta');
  assert.equal(cap.value, '0.23'); go.onclick(); assert.equal(started, 0, 'not without approval');
  approve.checked = true; cap.value = '0.10'; approve.onchange(); go.onclick(); assert.equal(started, 0, 'not below the expected total');
  cap.value = '0.25'; cap.oninput(); go.onclick();
  assert.equal(started, 1); assert.deepEqual(JSON.parse(JSON.stringify(ctx.bound)), { capUsd: 0.25, spentUsd: 0 });
  assert.equal(ctx.approvalPanel({ id: 'e' }), null, 'the approval is used once');
  // The runner: submitImage under that bound; a refusal stops the queue instead of moving on.
  const run = between(sheet, 'async function runTask(', '/** Attempts whose request finished');
  assert.match(run, /submitImage\(api, ctx\.projectId, job, bound\)/);
  assert.match(run, /if \(\(err as any\)\.refused\) \{ await fail\(msg\); stopAfterCurrent = true; return true; \}/);
  assert.equal([...sheet.matchAll(/\bbound = /g)].length, 2, 'set only by the approval panel and cleared when the run ends');
  for (const call of ['createSheet(e, u)', "mode: 'generate', note: '', from: null", "task('retry'", "task('edit'"]) assert.match(sheet, new RegExp(`askApproval\\([^;]*${call.replace(/[()]/g, '\\$&')}`), `${call} waits for approval`);
});
