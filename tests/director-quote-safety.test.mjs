import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
const source = await readFile(new URL('../src/director.ts', import.meta.url), 'utf8');
const compile = s => ts.transpileModule(s, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const h = (tag, attrs = {}, ...children) => ({ tag, checked: false, ...attrs, children: children.filter(c => c != null && c !== false), className: attrs.class || '', style: {}, replaceChildren(...c) { this.children = c; }, scrollIntoView() {} });
const walk = n => n && typeof n === 'object' ? [n, ...(n.children || []).flatMap(walk)] : [];
const text = n => typeof n === 'string' ? n : (n.children || []).map(text).join(' ');

test('single-shot preparation creates a review card and never clicks submission', async () => {
  const a = source.indexOf('  quoteBtn.onclick = async () => {', source.indexOf('async function renderGenerate'));
  const b = source.indexOf('\n  const drawJobs', a);
  const quoteBtn = {}, controls = [{ value: 'h3' }, { value: 'cloud' }, { checked: true }, { checked: true }];
  let prepared = 0, reviewed = 0;
  const ctx = { quoteBtn, wf: controls[0], backendSel: controls[1], useRefs: controls[2], timing: controls[3], project: { revision: 7 }, s: {}, st: {}, choices: [], h,
    out: h('div'), getPrompt: () => 'Preserve Video 1',
    prepareShotVideo: async () => { prepared++; return { def: {}, job: { validation: { compatible: true } }, request: {} }; },
    genQuote: () => { reviewed++; return { querySelector() { throw Error('Must not auto-click submission'); } }; },
  };
  runInNewContext(compile(source.slice(a, b)), ctx);
  await quoteBtn.onclick();
  assert.equal(prepared, 1); assert.equal(reviewed, 1);
  assert.ok(controls.every(c => c.disabled === false));
});

test('paid submission requires explicit review, allowance and unknown-charge acknowledgment; it dispatches once', async () => {
  const a = source.indexOf('function genQuote('), b = source.indexOf('// ---------- Live sync', a);
  const sent = [], timers = [];
  const ctx = { h, api: async (path, body) => { sent.push({ path, body }); return { job: { id: 'job', status: 'queued' } }; }, setTimeout: fn => timers.push(fn) };
  runInNewContext(compile(source.slice(a, b)), ctx);
  const job = { id: 'job', fingerprint: 'exact-fingerprint', quote: { status: 'unknown' }, validation: { compatible: true }, sources: { sourceVideo: { id: 'source', frameCount: 96, duration: 4 } } };
  const card = ctx.genQuote(job, { title: 'H3' }, { backend: { kind: 'cloud' } }, {});
  const nodes = walk(card), go = nodes.find(n => n.class?.includes('gen-send'));
  const [approve, unknown] = nodes.filter(n => n.tag === 'input' && n.type === 'checkbox');
  const allowance = nodes.find(n => n.type === 'number');
  assert.equal(go.hidden, undefined);
  assert.equal(go.disabled, true);
  await go.onclick(); assert.equal(sent.length, 0);
  approve.checked = true; approve.onchange(); await go.onclick(); assert.equal(sent.length, 0);
  unknown.checked = true; unknown.onchange();
  allowance.value = 'bad'; allowance.oninput(); await go.onclick(); assert.equal(sent.length, 0);
  allowance.value = '3'; allowance.oninput(); await go.onclick(); await go.onclick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].path, 'generation/submit');
  assert.equal(sent[0].body.approval.fingerprint, 'exact-fingerprint');
  assert.equal(sent[0].body.approval.allowance.maxAmount, 3);
  assert.equal(timers.length, 1);
  assert.match(text(card), /not a provider-enforced spending cap/);
});

test('sequence quote displays approval and never schedules batch dispatch', async () => {
  const source = await readFile(new URL('../src/director-sequence.ts', import.meta.url), 'utf8');
  const a = source.indexOf('  async function quote() {'), b = source.indexOf('  quoteBtn.onclick', a);
  const p = { revision: 1, shots: [{ id: 'shot', title: 'Shot', render: { duration: 4 }, duration: 4 }] };
  let cards = 0;
  const ctx = { P: () => p, picked: new Set(['shot']), busy: false, draw() {}, batch: h('div'), h, modelSel: { value: 'h3' }, choice: () => [{ id: 'h3' }], fresh: () => true, activeJob: () => null,
    bindAndQuote: async () => ({ job: { validation: { compatible: true } }, est: null, refs: [] }),
    drawQuote: () => { cards++; }, setTimeout: () => { throw Error('Quote must not dispatch'); },
  };
  runInNewContext(compile(source.slice(a, b)), ctx);
  await ctx.quote();
  assert.equal(cards, 1);
  assert.equal(ctx.busy, false);
});
