#!/usr/bin/env node
// Regenerate the four launch starters through the batch API (contract C3): looks, design sheets, stills and videos.
//
//   node scripts/pipeline/regenerate-starters.mjs --dry-run                       # plan + estimates only, nothing sent
//   node scripts/pipeline/regenerate-starters.mjs --url http://127.0.0.1:5270     # run (the server must allow paid work)
//
// Options: --url <server> (default $PREVIS_URL or http://127.0.0.1:5190), --dry-run, --tier draft|final (default draft),
// --max-cost <usd per project> (default 4), --steps looks,sheets,stills,videos, --only <slug>[,<slug>].
// One batch per starter, all at once (the server shares backend slots between them); progress follows each batch's SSE
// stream, falling back to polling. A batch that pauses (an uncertain job) is left for the operator; nothing is resent.
const STARTERS = [
  { slug: 'breaking-news', id: 'ff685e99-00bf-4f5f-979a-944f0caca7c9' },
  { slug: 'wingspan', id: 'f158baf1-2cac-4311-859a-e5c590d381d4' },
  { slug: 'final-lap', id: 'ac79f20f-85d2-44ba-b1a4-0692c7eb6b0f' },
  { slug: 'posterized', id: '5e9f88cf-0638-43aa-bba5-2eb9fa4cd7d6' },
];
const TERMINAL = ['completed', 'failed', 'cancelled', 'paused'];

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback; };
const url = (opt('url') || process.env.PREVIS_URL || 'http://127.0.0.1:5190').replace(/\/$/, '');
const dryRun = args.includes('--dry-run'), tier = opt('tier', 'draft'), maxCostUsd = Number(opt('max-cost', '4'));
const steps = opt('steps', 'looks,sheets,stills,videos').split(',').map(s => s.trim()).filter(Boolean);
const only = opt('only')?.split(',');
if (args.includes('--help') || !Number.isFinite(maxCostUsd) || maxCostUsd < 0) {
  console.error('Usage: node scripts/pipeline/regenerate-starters.mjs [--url <server>] [--dry-run] [--tier draft|final] [--max-cost <usd>] [--steps a,b] [--only <slug>]');
  process.exit(2);
}

const money = x => `$${(Math.round((x || 0) * 100) / 100).toFixed(2)}`;
async function api(method, path, body) {
  const r = await fetch(url + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(`${method} ${path}: ${j.error || `HTTP ${r.status}`}`);
  return j;
}

function printPlan(slug, b) {
  const by = {};
  for (const n of b.nodes) { const k = `${n.type}:${n.status}`; by[k] = by[k] || { type: n.type, status: n.status, count: 0, usd: 0 }; by[k].count++; by[k].usd += n.status === 'skipped' || n.status === 'failed' ? 0 : n.estimateUsd || 0; }
  console.log(`\n[${slug}] batch ${b.id} · ${b.status} · tier ${b.tier} · models ${Object.entries(b.models).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  for (const row of Object.values(by)) console.log(`  ${row.type.padEnd(8)} ${row.status.padEnd(8)} ×${String(row.count).padStart(3)}  ${row.usd ? money(row.usd) : ''}`);
  for (const n of b.nodes.filter(x => x.planError || x.status === 'failed')) console.log(`  ! ${n.label}: ${n.error}`);
  console.log(`  estimate ${money(b.estimateUsd)} of cap ${money(b.maxCostUsd)}${b.estimateUsd > b.maxCostUsd ? ' (over the cap: the last nodes will stop at the line)' : ''}`);
}

// Follow one batch: SSE first, polling if the stream drops. Resolves with the final batch document.
async function follow(slug, id) {
  const say = text => console.log(`[${slug}] ${text}`);
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${url}/api/director/batch/stream?id=${id}`);
      if (!res.ok || !res.body) throw Error(`stream HTTP ${res.status}`);
      const reader = res.body.getReader(), decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (let i; (i = buffer.indexOf('\n\n')) >= 0;) {
          const chunk = buffer.slice(0, i); buffer = buffer.slice(i + 2);
          const line = chunk.split('\n').find(l => l.startsWith('data: ')); if (!line) continue;
          const msg = JSON.parse(line.slice(6));
          if (msg.type === 'node' && msg.text) say(msg.text);
          if (msg.type === 'batch' && TERMINAL.includes(msg.batch.status)) { reader.cancel().catch(() => {}); return (await api('GET', `/api/director/batch?id=${id}`)).batch; }
        }
      }
    } catch (e) { if (attempt === 0) say(`stream unavailable (${e.message}); polling`); }
    const b = (await api('GET', `/api/director/batch?id=${id}`)).batch;
    if (TERMINAL.includes(b.status)) return b;
    await new Promise(r => setTimeout(r, 10000));
  }
}

const chosen = STARTERS.filter(s => !only || only.includes(s.slug) || only.includes(s.id));
console.log(`${dryRun ? 'Dry run' : 'Regenerating'} ${chosen.length} starter(s) on ${url}: steps ${steps.join(', ')}, tier ${tier}, cap ${money(maxCostUsd)} per project`);
const created = [];
for (const s of chosen) {
  try {
    const { batch } = await api('POST', '/api/director/batch', { projectId: s.id, steps, tier, maxCostUsd, dryRun });
    printPlan(s.slug, batch); created.push({ ...s, batch });
  } catch (e) { console.error(`[${s.slug}] ${e.message}`); process.exitCode = 1; }
}
const total = created.reduce((t, x) => t + x.batch.estimateUsd, 0);
console.log(`\nTotal estimate ${money(total)} (capped at ${money(Math.min(total, maxCostUsd * created.length))} by the per-project caps)`);
if (dryRun) process.exit(process.exitCode || 0);

const finals = await Promise.all(created.map(async s => ({ ...s, batch: await follow(s.slug, s.batch.id) })));
// Spend: the dashboard's per-job cost where it still lists the job, else the batch's committed estimate.
const { jobs = [] } = await api('GET', '/api/jobs').catch(() => ({}));
console.log('\nSummary');
let spent = 0;
for (const { slug, batch: b } of finals) {
  const ids = new Set(b.nodes.flatMap(n => [n.jobId, n.requestId, ...(n.requestIds || [])]).filter(Boolean));
  const listed = jobs.filter(j => ids.has(j.id) && j.costUsd != null), dash = listed.reduce((t, j) => t + j.costUsd, 0);
  const counts = b.nodes.reduce((m, n) => ({ ...m, [n.status]: (m[n.status] || 0) + 1 }), {});
  spent += b.spentEstimateUsd;
  console.log(`  ${slug.padEnd(14)} ${b.status.padEnd(9)} ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')} · committed ${money(b.spentEstimateUsd)}${listed.length ? ` · dashboard ${money(dash)} over ${listed.length} job(s)` : ''}`);
  if (b.status === 'paused') { console.log(`    paused: check the jobs panel, then POST /api/director/batch/resume {"id":"${b.id}"}`); process.exitCode = 1; }
}
console.log(`  total committed ${money(spent)}`);
