// Auto-prompt hygiene on the four starters' real projects (tests/fixtures/starter-projects).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { autoPromptSegments, autoPromptText, sentence, VIDEO_PROMPT_CAP } from '../shared/prompt.mjs';
import { objectNotes } from '../shared/director.mjs';

const load = slug => JSON.parse(readFileSync(new URL(`./fixtures/starter-projects/${slug}.json`, import.meta.url), 'utf8'));
const SLUGS = ['breaking-news', 'wingspan', 'final-lap', 'posterized'];
const projects = Object.fromEntries(SLUGS.map(s => [s, load(s)]));
const shot = (slug, title) => projects[slug].shots.find(s => s.title === title);
const sentences = text => text.split(/(?<=[.!?])\s+/).map(x => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()).filter(Boolean);
const PART = { intro: 0, action: 1, obj: 2, world: 3, style: 4, camera: 5, cam: 6 };
const part = key => PART[key.split(/[:-]/)[0]];

test('sentence() ends a part with exactly one full stop', () => {
  assert.equal(sentence('Setting: a studio.'), 'Setting: a studio.');
  assert.equal(sentence('a studio..  '), 'a studio.');
  assert.equal(sentence('a studio.;'), 'a studio.');
  assert.equal(sentence('Go!'), 'Go!');
  assert.equal(sentence('  '), '');
});

test('shared descriptions join without ".;" (objectNotes)', () => {
  const p = projects['final-lap'];
  const stretch = p.scene.entities.find(e => e.name === 'Front stretch 1');
  assert.equal(objectNotes(p, stretch), 'Mown infield grass with painted logo-free surface; Banked asphalt racing surface, white lane lines, tyre rubber marks');
});

for (const slug of SLUGS) {
  test(`${slug}: prompts are clean, ordered, deduplicated and capped`, () => {
    const p = projects[slug];
    for (const s of p.shots) for (const kind of ['video', 'image']) {
      const text = autoPromptText(p, s, kind), segs = autoPromptSegments(p, s, kind), where = `${slug} / ${s.title} (${kind})`;
      assert.doesNotMatch(text, /(?<!\.)\.\.(?!\.)|[.;,:]\s*[.;,]|\s{2,}/, `${where}: punctuation artifact in ${JSON.stringify(text)}`);
      const list = sentences(text);
      assert.equal(new Set(list).size, list.length, `${where}: a sentence repeats`);
      assert.ok(segs.filter(g => /^Set: /.test(g.text)).length <= 1, `${where}: more than one Set sentence`);
      const order = segs.map(g => part(g.key));
      assert.deepEqual(order, [...order].sort((a, b) => a - b), `${where}: parts out of order ${segs.map(g => g.key)}`);
      assert.ok(segs.some(g => g.key === 'action') && segs.some(g => g.key === 'camera'), `${where}: action and camera are always there`);
      if (kind === 'video' && text.length > VIDEO_PROMPT_CAP) {
        // Only the parts that are never cut may push a video prompt past the cap.
        assert.ok(segs.every(g => g.key === 'action' || g.key === 'camera' || g.key.startsWith('obj:')), `${where}: ${text.length} chars with optional parts`);
        assert.ok(text.length <= VIDEO_PROMPT_CAP + 120, `${where}: ${text.length} chars`);
      }
    }
  });
}

test('the hero cast leads: named in the action first, people and vehicles before props', () => {
  const first = (slug, title) => { const p = projects[slug], s = shot(slug, title); const g = autoPromptSegments(p, s).find(x => x.key.startsWith('obj:')); return p.scene.entities.find(e => e.id === g.key.slice(4)).name; };
  assert.equal(first('posterized', 'Posterized'), 'Comfy guard');
  assert.equal(first('wingspan', 'The dive'), 'Bald eagle'); // the elk fills more of the frame, but the eagle is the subject
  assert.equal(first('breaking-news', 'Breaking'), 'News anchor'); // named after the video wall, but a person beats a prop
  assert.equal(first('final-lap', 'The draft'), 'Comfy car');
  // Both cars and both players always make it in.
  for (const [slug, title, names] of [['final-lap', 'Final lap', ['Comfy car', 'Rival car']], ['posterized', 'The drive', ['Comfy guard', 'Rival defender']]]) {
    const p = projects[slug], ids = autoPromptSegments(p, shot(slug, title)).flatMap(g => g.ids || []);
    for (const n of names) assert.ok(ids.includes(p.scene.entities.find(e => e.name === n).id), `${title}: ${n}`);
  }
});

test('set dressing goes before the cast, and a still prompt is not capped', () => {
  const p = projects['final-lap'], s = shot('final-lap', 'The draft');
  const video = autoPromptText(p, s, 'video'), image = autoPromptText(p, s, 'image');
  assert.ok(video.length <= VIDEO_PROMPT_CAP);
  assert.doesNotMatch(video, /Mown infield grass/);
  assert.match(image, /Set: A packed oval speedway[^.]*; Mown infield grass/);
  assert.equal(autoPromptText(p, s, 'video').length, autoPromptSegments(p, s, 'video', { cap: VIDEO_PROMPT_CAP }).map(g => g.text).join(' ').length);
  assert.ok(autoPromptSegments(p, s, 'video', { cap: Infinity }).map(g => g.text).join(' ').length > VIDEO_PROMPT_CAP);
});
