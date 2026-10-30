import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { README, withTable, modelRows } from '../scripts/models-table.mjs';

test('the README models table matches the built-in presets (run pnpm docs:models after changing presets)', () => {
  const readme = readFileSync(README, 'utf8');
  assert.equal(readme, withTable(readme));
  const rows = modelRows();
  assert.ok(rows.some(r => /LTX 2\.5/.test(r.model)) && rows.some(r => /FLUX 3/.test(r.model)));
  // The README never names a video model without a preset.
  for (const name of ['MiniMax']) assert.ok(!readme.includes(name) || rows.some(r => r.model.includes(name)), `${name} is advertised but has no preset`);
});
