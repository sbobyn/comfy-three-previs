#!/usr/bin/env node
// Checks this machine is ready to run video-lab. Never prints credential values.
//   pnpm run doctor          full check
//   node scripts/doctor.mjs --quick  only what `pnpm start` needs (used by prestart)
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupChecks } from '../server/previs/setup-check.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const quick = process.argv.includes('--quick');
const data = resolve(process.env.PREVIS_DATA_DIR || join(root, '.previs'));
const { ready, checks } = await setupChecks({ root, data });
const shown = quick ? checks.filter(c => c.status === 'required') : checks;
const mark = { ok: '✓', optional: '–', warn: '!', required: '✗' };
if (!quick) console.log('\nvideo-lab setup check\n');
for (const c of shown) {
  console.log(`  ${mark[c.status]} ${c.label.padEnd(26)} ${c.detail}`);
  if (c.status !== 'ok' && c.fix) console.log(`      → ${c.fix}`);
}
if (!quick) console.log(ready ? `\nReady. Start with: pnpm start  →  http://127.0.0.1:${process.env.PORT || 5190}\n` : '\nFix the ✗ items above, then run pnpm run doctor again.\n');
else if (!ready) console.error('\nvideo-lab is not ready to start. Run pnpm run doctor for details.\n');
process.exit(ready ? 0 : 1);
