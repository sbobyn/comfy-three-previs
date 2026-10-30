// Auto-prompt block (Shot tab): the shot's prompt composed from its Cast Cards, world, action and camera,
// shown as labelled colour chips and matching coloured spans. Edits are saved on the shot and always win;
// Regenerate previews the new text beside the edit before replacing it. Camera style tags add their terms.
import './director-prompt.css';
import type { DirectorProject, Shot } from '../shared/director.mjs';
import { autoPromptSegments, autoPromptText, highlightRanges, shotStyle, suggestedStyle, CAMERA_TERMS, CAMERA_GROUPS, FIELD_COLORS } from '../shared/prompt.mjs';
import type { Segment, StyleTags } from '../shared/prompt.mjs';
import { withCameraLine } from '../shared/camera-source.mjs';
import type { CameraSource } from '../shared/camera-source.mjs';
import { h, toast } from './director-common';
import { termPicker, attachHelp } from './director-camhelp';

type Ctx = { project(): DirectorProject; runEntry(e: { label: string; redo: unknown[]; undo: unknown[] }): Promise<unknown>; select(id: string): void; refresh?(): void; cameraSource?(s: Shot): CameraSource };
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
  // The video prompt's camera line follows the shot's chosen video model (blockout clip, start → end stills or one still).
  const cameraSource = ctx.cameraSource?.(s) || 'blockout';
  const segs = autoPromptSegments(p, s, kind, { cameraSource }), auto = autoPromptText(p, s, kind, { cameraSource });
  const saved = s.prompts?.[kind];
  const edited = !!(saved?.edited && saved.text);
  const text = edited ? (kind === 'video' ? withCameraLine(saved!.text, cameraSource) : saved!.text) : auto;
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

  const seg = h('div', { class: 'seg', role: 'tablist', 'aria-label': 'Prompt type' }, ...(['video', 'image'] as const).map(k => h('button', { type: 'button', role: 'tab', class: k === kind ? 'on' : '', 'aria-selected': String(k === kind), title: k === 'video' ? 'For the video model: the camera comes from the blockout, so the prompt names no camera move' : 'For stills (no motion)', onclick: () => { kind = k; editing = preview = false; rerender(); } }, k === 'video' ? 'Video prompt' : 'Still prompt')));
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

  const block = h('div', { class: 'block ap-block' + (edited ? ' is-edited' : '') },
    h('div', { class: 'block-head' }, h('span', { class: 'eyebrow' }, 'Prompt'), marker, h('span', { style: 'flex:1' }), seg),
    chips, body,
    editing || preview ? null : h('div', { class: 'ap-actions' },
      h('button', { class: 'btn sm', type: 'button', onclick: () => { editing = true; rerender(); } }, 'Edit'),
      h('button', { class: 'btn sm ghost', type: 'button', title: edited ? 'Preview the new auto-prompt next to your edit before replacing it' : 'Rebuild from the Cast Cards and camera', onclick: () => { if (edited) { preview = true; rerender(); } else { toast('Auto-prompt is already up to date with the Cast Cards'); } } }, 'Regenerate'),
      h('button', { class: 'btn sm ghost', type: 'button', onclick: () => void navigator.clipboard.writeText(text).then(() => toast('Prompt copied')) }, 'Copy'),
      h('span', { class: 'note', style: 'margin-left:auto' }, edited ? 'Your edit is used for generation.' : 'Composed from the cast · edit to override')));
  return block;
}
/** Camera style tags (Phase C): suggestions come from the shot's camera until you change them. Their terms go into the prompt. */
export function cameraStyleBlock(s: Shot, ctx: Ctx) {
  // Camera style tags (Phase C): suggestions come from the shot's camera until you change them.
  const st = shotStyle(s), chosen = !!s.style;
  const setStyle = (next: StyleTags | null, label: string) => ctx.runEntry({ label, redo: [{ op: 'update_shot', id: s.id, patch: { style: next } }], undo: [{ op: 'update_shot', id: s.id, patch: { style: s.style ?? null } }] }).then(() => { (document.activeElement as HTMLElement | null)?.blur?.(); ctx.refresh?.(); });
  const styleRow = h('div', { class: 'ap-style' }, ...(Object.keys(CAMERA_TERMS) as (keyof StyleTags)[]).map(g => {
    // [camhelp] A picker whose options preview themselves (animated card), instead of a plain select.
    const sel = termPicker({ group: g, label: `+ ${CAMERA_GROUPS[g]}`, ariaLabel: `Add ${CAMERA_GROUPS[g]} term`, items: CAMERA_TERMS[g].filter(t => !st[g].includes(t)).map(t => ({ value: t })), onPick: t => void setStyle({ ...st, [g]: [...st[g], t] }, `Add ${CAMERA_GROUPS[g]}`) });
    return h('div', { class: 'ap-sgroup' }, h('span', { class: 'ap-sname', style: `--c:${FIELD_COLORS[g]}` }, h('i'), CAMERA_GROUPS[g]),
      ...st[g].map(t => attachHelp(h('button', { type: 'button', class: 'ap-tag', style: `--c:${FIELD_COLORS[g]}`, 'aria-label': `Remove “${t}”`, onclick: () => void setStyle({ ...st, [g]: st[g].filter(x => x !== t) }, `Remove ${CAMERA_GROUPS[g]}`) }, t, ' ×'), g, t)), sel);
  }));

  return h('div', { class: 'block ap-block ap-camstyle' },
    h('div', { class: 'ap-stylehead' }, h('span', { class: 'eyebrow' }, 'Camera style'), chosen ? h('button', { class: 'btn ghost sm', type: 'button', title: 'Back to suggestions from the shot camera', onclick: () => void setStyle(null, 'Reset camera style') }, 'Reset') : h('span', { class: 'note' }, 'Suggested from the shot camera')),
    styleRow,
    h('p', { class: 'note' }, 'Lens and filter terms go into the prompts. Movement and cuts are notes for you: the blockout is the camera, so no prompt describes the move.'));
}
export { suggestedStyle };
