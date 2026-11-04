import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// B21: scenes with terrain render outdoors (renderer only; GPU output is checked by hand, see .evidence b21-*).
const src = await readFile(new URL('../src/director-scene.ts', import.meta.url), 'utf8');

test('terrain scenes get a daylight sky, haze and stronger fill; studio sets keep their look', () => {
  assert.match(src, /export const isOutdoor = \(entities[^)]*\) => entities\.some\(e => e\.shape === 'terrain'\)/);
  assert.match(src, /stage\.scene\.background = outdoor \? outdoorSky\(\) : new THREE\.Color\(e\.sky\)/);
  assert.match(src, /stage\.scene\.fog = outdoor \? new THREE\.Fog\(OUTDOOR\.horizon, \.\.\.OUTDOOR\.fog\) : null/);
  assert.match(src, /const STUDIO = \{ hemi: \[0xc4ccd8, 0x2a2420, 1\.1\] as const, sun: \[0xffffff, 1\.7\] as const, sunAt: \[9, 16, 11\] as const \}/, 'studio lighting unchanged');
});

test('every shot-camera render of a terrain scene hides the flat ground, road and grid; the editor view keeps them', () => {
  assert.match(src, /applyEnv\(stage, project\.scene\.environment\.preset, outdoor\); hideFlatGround\(stage, outdoor\);/, 'renderStill');
  assert.match(src, /function cleanRender[\s\S]{0,400}const restore = hideFlatGround\(\{ ground, road, grid \}, env\.endsWith\(':outdoor'\)\);\s*r\.render\(scene, cam\);\s*restore\(\);/, 'monitor and capture');
  assert.match(src, /if \(view === 'set'\) \{[\s\S]{0,200}scene\.fog = null;\s*composer\.render\(\);/, 'editor view stays fog-free');
});
