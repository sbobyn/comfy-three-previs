// Auto-prompt block (Shot tab): the shot's prompt composed from its Cast Cards, world, action and camera,
// shown as labelled colour chips and matching coloured spans. Edits are saved on the shot and always win;
// Regenerate previews the new text beside the edit before replacing it. Camera style tags add their terms.
import './director-prompt.css';
import type { DirectorProject, Shot } from '../shared/director.mjs';
import { autoPromptSegments, autoPromptText, highlightRanges, shotStyle, suggestedStyle, CAMERA_TERMS, CAMERA_GROUPS, FIELD_COLORS } from '../shared/prompt.mjs';
import type { Segment, StyleTags } from '../shared/prompt.mjs';
import { h, toast } from './director-common';

type Ctx = { project(): DirectorProject; runEntry(e: { label: string; redo: unknown[]; undo: unknown[] }): Promise<unknown>; select(id: string): void };
let kind: 'video' | 'image' = 'video';
let editing = false, preview = false;

/** Text with each segment's span coloured and labelled (title shows the chip name). */
function colouredText(text: string, segs: Segment[]) {
  const box = h('div', { class: 'ap-text' });
  let at = 0;
  for (const r of highlightRanges(text, segs)) {
    if (r.start > at) box.append(h('span', { class: 'ap-plain', title: 'Your text' }, text.slice(at, r.start)));
    box.append(h('span', { class: 'ap-span', title: `${r.seg.label} · from ${r.seg.source}`, style: `--c:${r.seg.color}`, 'data-ids': (r.seg.ids || []).join(' ') }, text.slice(r.start, r.end)));
    at = r.end;
  }
  if (at < text.length) box.append(h('span', { class: 'ap-plain', title: 'Your text' }, text.slice(at)));
  return box;
}

export function promptBlock(s: Shot, ctx: Ctx) {
  const p = ctx.project();
  const segs = autoPromptSegments(p, s, kind), auto = autoPromptText(p, s, kind);
  const saved = s.prompts?.[kind];
  const edited = !!(saved?.edited && saved.text);
  const text = edited ? saved!.text : auto;
  const save = (next: string | null, label: string) => {
    const before = s.prompts?.[kind] ?? null;
    const value = next === null ? null : { text: next, edited: true, basedOn: auto, editedAt: new Date().toISOString() };
    return ctx.runEntry({ label, redo: [{ op: 'update_shot', id: s.id, patch: { prompts: { [kind]: value } } }], undo: [{ op: 'update_shot', id: s.id, patch: { prompts: { [kind]: before } } }] });
  };
  const rerender = () => { block.replaceWith(promptBlock(ctx.project().shots.find(x => x.id === s.id) || s, ctx)); };

  // Chips: one per contributing field/object, colour + label (+ source on hover).
  const chips = h('div', { class: 'ap-chips' }, ...segs.filter(g => g.key !== 'intro').map(g => {
    const objId = g.key.startsWith('obj:') ? g.key.slice(4) : null;
    return h('button', { type: 'button', class: 'ap-chip', style: `--c:${g.color}`, 'data-ids': (g.ids || []).join(' '), title: `From ${g.source}${objId ? ' · click to open the Cast Card' : ''}`, onclick: objId ? () => ctx.select(objId) : undefined }, h('i'), g.label, objId ? h('small', {}, 'Cast Card') : null);
  }));

  const seg = h('div', { class: 'seg', role: 'tablist', 'aria-label': 'Prompt type' }, ...(['video', 'image'] as const).map(k => h('button', { type: 'button', role: 'tab', class: k === kind ? 'on' : '', 'aria-selected': String(k === kind), title: k === 'video' ? 'For the LTX video (includes camera motion)' : 'For the FLUX still (no motion)', onclick: () => { kind = k; editing = preview = false; rerender(); } }, k === 'video' ? 'Video · LTX' : 'Image · FLUX')));
  const marker = edited ? h('span', { class: 'ap-edited', title: 'You edited this prompt; your text is what generation uses' }, 'Edited') : h('span', { class: 'ap-auto', title: 'Composed from the Cast Cards, world, action and camera — assembled text, not a model' }, 'Auto');

  let body: Node;
  if (editing) {
    const ta = h('textarea', { class: 'field ap-edit', rows: 8, 'aria-label': `${kind} prompt` }, text);
    const done = h('button', { class: 'btn sm primary', type: 'button' }, 'Save edit');
    done.onclick = async () => { const v = ta.value.trim(); editing = false; if (v && v !== text) await save(v === auto ? null : v, 'Edit prompt'); rerender(); };
    body = h('div', { class: 'ap-editor' }, ta, h('div', { class: 'ap-actions' }, done, h('button', { class: 'btn sm ghost', type: 'button', onclick: () => { editing = false; rerender(); } }, 'Cancel')));
    requestAnimationFrame(() => ta.focus());
  } else if (preview) {
    const changed = auto !== text;
    body = h('div', { class: 'ap-preview' },
      h('div', { class: 'ap-col' }, h('span', { class: 'eyebrow' }, 'Your edit (in use)'), colouredText(text, segs)),
      h('div', { class: 'ap-col' }, h('span', { class: 'eyebrow' }, 'New auto-prompt'), colouredText(auto, segs)),
      h('div', { class: 'ap-actions' },
        h('button', { class: 'btn sm primary', type: 'button', onclick: () => { preview = false; rerender(); } }, 'Keep my edits'),
        h('button', { class: 'btn sm', type: 'button', disabled: !changed && false, onclick: async () => { preview = false; await save(null, 'Use auto-prompt'); toast('Using the new auto-prompt (undo with ⌘Z)'); rerender(); } }, 'Replace with new')));
  } else {
    body = h('div', { class: 'ap-view', title: 'Click Edit to change the text' }, colouredText(text, segs));
  }

  // Camera style tags (Phase C): suggestions come from the shot's camera until you change them.
  const st = shotStyle(s), chosen = !!s.style;
  const setStyle = (next: StyleTags | null, label: string) => ctx.runEntry({ label, redo: [{ op: 'update_shot', id: s.id, patch: { style: next } }], undo: [{ op: 'update_shot', id: s.id, patch: { style: s.style ?? null } }] }).then(rerender);
  const styleRow = h('div', { class: 'ap-style' }, ...(Object.keys(CAMERA_TERMS) as (keyof StyleTags)[]).map(g => {
    const sel = h('select', { class: 'field', 'aria-label': `Add ${CAMERA_GROUPS[g]} term` }, h('option', { value: '' }, `+ ${CAMERA_GROUPS[g]}`), ...CAMERA_TERMS[g].filter(t => !st[g].includes(t)).map(t => h('option', { value: t }, t)));
    sel.onchange = () => { if (!sel.value) return; const next = { ...st, [g]: [...st[g], sel.value] }; void setStyle(next, `Add ${CAMERA_GROUPS[g]}`); };
    return h('div', { class: 'ap-sgroup' }, h('span', { class: 'ap-sname', style: `--c:${FIELD_COLORS[g]}` }, h('i'), CAMERA_GROUPS[g]),
      ...st[g].map(t => h('button', { type: 'button', class: 'ap-tag', style: `--c:${FIELD_COLORS[g]}`, title: `Remove “${t}”`, onclick: () => void setStyle({ ...st, [g]: st[g].filter(x => x !== t) }, `Remove ${CAMERA_GROUPS[g]}`) }, t, ' ×')), sel);
  }));

  const block = h('div', { class: 'block ap-block' + (edited ? ' is-edited' : '') },
    h('div', { class: 'block-head' }, h('span', { class: 'eyebrow' }, 'Auto-prompt'), marker, h('span', { style: 'flex:1' }), seg),
    chips, body,
    editing || preview ? null : h('div', { class: 'ap-actions' },
      h('button', { class: 'btn sm', type: 'button', onclick: () => { editing = true; rerender(); } }, 'Edit'),
      h('button', { class: 'btn sm ghost', type: 'button', title: edited ? 'Preview the new auto-prompt next to your edit before replacing it' : 'Rebuild from the Cast Cards and camera', onclick: () => { if (edited) { preview = true; rerender(); } else { toast('Auto-prompt is already up to date with the Cast Cards'); } } }, 'Regenerate'),
      h('button', { class: 'btn sm ghost', type: 'button', onclick: () => void navigator.clipboard.writeText(text).then(() => toast('Prompt copied')) }, 'Copy'),
      h('span', { class: 'note', style: 'margin-left:auto' }, edited ? 'Your edit is used for generation.' : 'Composed from the cast · edit to override')),
    h('div', { class: 'ap-stylehead' }, h('span', { class: 'eyebrow' }, 'Camera style'), chosen ? h('button', { class: 'btn ghost sm', type: 'button', title: 'Back to suggestions from the shot camera', onclick: () => void setStyle(null, 'Reset camera style') }, 'Reset') : h('span', { class: 'note' }, 'Suggested from the shot camera')),
    styleRow);
  return block;
}
export { suggestedStyle };
