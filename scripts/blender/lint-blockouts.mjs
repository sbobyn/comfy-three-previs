#!/usr/bin/env node
// Fail (exit 1) if any bundled blockout GLB or starter scene has two surfaces on one plane (z-fighting).
// generate-blockouts.py runs this after every rebuild; tests/blockout-lint.test.mjs runs the same check.
//   node scripts/blender/lint-blockouts.mjs
import { loadStarters } from '../../server/previs/starters.mjs';
import { lintBundled } from '../../server/previs/coplanar.mjs';

const findings = lintBundled(await loadStarters());
for (const f of findings) console.error(`${f.where}: ${f.text}`);
console.log(findings.length ? `blockout lint: ${findings.length} coplanar overlap(s)` : 'blockout lint: no coplanar overlaps in bundled GLBs or starters');
process.exitCode = findings.length ? 1 : 0;
