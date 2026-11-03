import { h } from './director-common';
import { explainerTabs, keyboardDiagram, gamepadDiagram, phoneDiagram, phonePairDiagram } from './director-explain';
import { beforeAfter, annotatedShot, guideManifest, guideUrl } from './director-media';
import type { GuideEntry } from './director-media';

export const JOURNEY = [
  {
    id: 'build', title: 'Build', action: 'Go to Build', promise: 'Block out the scene in grey 3D: the people, vehicles, props and set of your film.',
    points: ['Start from a <b>starter</b> or a new scene. <b>Right-click</b> or <b>Shift + A</b> adds an object.', '<b>Drag</b> to orbit, <b>right-drag</b> to pan, <b>scroll</b> to zoom. <b>Click</b> selects; <b>Shift-click</b> adds.', '<b>G / R / S</b> move, rotate and resize; <b>X / Y / Z</b> locks an axis; type a number for an exact amount.', '<b>Ctrl/⌘ + G</b> groups objects. <b>I</b> sets a key at the playhead so an object moves during the shot.'],
  },
  {
    id: 'cast', title: 'Cast', action: 'Open cast images', promise: 'Give each object a cast image so it looks the same in every shot.',
    points: ['Open an object and drop an image on it, or make one from a prompt.', 'A <b>design sheet</b> turns one image into front, side and back views.', 'Every shot that shows the object sends its cast image with the request.', 'A <b>still</b> previews the shot as a picture before you make a video.'],
  },
  {
    id: 'shoot', title: 'Shoot', action: 'Go to Shoot', promise: 'Place the shot camera, choose a move and preview each shot.',
    points: ['Pick a shot, then set <b>distance, height, angle and lens</b> and a <b>move</b>. The ⓘ next to Move shows each one.', '<b>▶ Preview</b> plays the shot through the shot camera; <b>C</b> looks through it.', '<b>Fly camera</b> records a hand-flown take with the keyboard, a gamepad or your phone.'],
  },
  {
    id: 'generate', title: 'Generate', action: 'Open Generate video', promise: 'Make the grey blockout clip, then a video model turns it into the shot.',
    points: ['<b>Make blockout</b> records the shot camera’s grey clip. It is free and runs on your computer.', 'Choose a <b>video model</b>: some follow the blockout clip, others animate from stills.', 'The dialog lists every input and the estimated cost. Nothing runs until you tick the approval box.'],
  },
  {
    id: 'cut', title: 'Cut', action: 'Go to Cut', promise: 'Line up the shots, choose versions, trim and export the film.',
    points: ['Shots play in order; drag a row to reorder.', 'Pick the <b>version</b> each shot uses and trim its <b>in</b> and <b>out</b>.', '<b>In cut</b> keeps or leaves out a shot; the seam compares blockout and generated.', '<b>Export film</b> writes one MP4 in shot order.'],
  },
] as const;

export type JourneyStage = typeof JOURNEY[number]['id'];
/** Stage ids from the previous seven-step guide; still accepted so older callers keep working. */
const LEGACY = { scene: 'build', looks: 'cast', shot: 'shoot', capture: 'generate', workflow: 'generate', compare: 'cut', export: 'cut' } as const;
type LegacyStage = keyof typeof LEGACY;
type GuideOptions = { stage?: JourneyStage | LegacyStage; context?: string; actions?: Partial<Record<JourneyStage | LegacyStage, () => void>> };

const resolveStage = (s?: JourneyStage | LegacyStage): JourneyStage | undefined => (s && s in LEGACY ? LEGACY[s as LegacyStage] : s as JourneyStage | undefined);
function actionFor(id: JourneyStage, actions: GuideOptions['actions'] = {}) {
  if (actions[id]) return actions[id];
  const old = (Object.keys(LEGACY) as LegacyStage[]).find(k => LEGACY[k] === id && actions[k]);
  return old ? actions[old] : undefined;
}
const rich = (html: string) => { const li = h('li'); li.innerHTML = html; return li; };

/** The one visual per stage. Media comes from public/guide via its manifest; explainers are live. */
function stageVisual(id: JourneyStage, disposers: (() => void)[]) {
  const box = h('div', { class: 'jy-visual' });
  const cap = (text: string) => h('p', { class: 'jy-cap' }, text);
  if (id === 'build' || id === 'shoot') {
    const tabs = explainerTabs(id === 'build' ? ['navigate', 'select', 'transform', 'groups', 'animate'] : ['camera-rig', 'fly'], { label: id === 'build' ? 'Viewport examples' : 'Camera examples' });
    disposers.push(() => tabs.dispose());
    box.append(tabs.el, cap('Drag across a scene to scrub it.'));
    if (id === 'shoot') box.append(keyboardDiagram());
    return box;
  }
  let disposed = false;
  disposers.push(() => { disposed = true; });
  const compare = (o: Parameters<typeof beforeAfter>[0]) => { const el = beforeAfter(o); disposers.push(() => el.dispose()); return el; };
  void guideManifest().then(m => {
    if (disposed) return;
    const e = (k: string) => m.get(k);
    const url = (x?: GuideEntry) => (x ? guideUrl(x.file) : '');
    if (id === 'cast' && e('cast-before') && e('cast-after')) {
      const casts = [1, 2, 3, 4].map(i => e(`cast-image-${i}`)).filter(Boolean) as GuideEntry[];
      box.append(compare({ kind: 'image', before: url(e('cast-before')), after: url(e('cast-after')), labels: ['Blockout', 'Still'], alt: 'The grey blockout frame and the still made from it with the cast images' }));
      if (casts.length) box.append(h('div', { class: 'jy-casts' }, ...casts.map(c => h('figure', {}, h('img', { src: url(c), alt: c.label || '', loading: 'lazy' }), h('figcaption', {}, c.label || '')))));
      box.append(cap(`${e('cast-after')!.label || 'Starter'}: the cast images above went into this still.`));
    } else if (id === 'generate' && e('generate-before') && e('generate-after')) {
      box.append(compare({ kind: 'video', before: url(e('generate-before')), after: url(e('generate-after')), posters: [url(e('generate-before-poster')), url(e('generate-after-poster'))], alt: 'The grey blockout clip and the generated video of the same shot, side by side' }),
        cap(`${e('generate-after')!.label || 'Starter'}. Drag the seam or use ← → to compare.`));
    } else if (id === 'cut' && e('cut-board')) {
      box.append(annotatedShot({ src: url(e('cut-board')), alt: 'The Cut view: shots in order with version, trim, in-cut and export controls', callouts: e('cut-board')!.callouts || [] }));
    } else box.append(h('p', { class: 'note' }, 'Example media appears here once it has been captured.'));
  });
  return box;
}

/** Navigation only: opening the guide never edits a project or dispatches a job. */
export function openJourney({ stage, context, actions = {} }: GuideOptions = {}) {
  (document.getElementById('journey-dialog') as HTMLDialogElement | null)?.close();
  const opener = document.activeElement as HTMLElement | null;
  const current = resolveStage(stage);
  const disposers: (() => void)[] = [];
  let navigating = false;
  const rows = JOURNEY.map((step, i) => {
    const go = actionFor(step.id, actions);
    return h('li', { id: `journey-${step.id}`, class: 'jy-stage' + (current === step.id ? ' is-current' : '') },
      h('span', { class: 'journey-number', 'aria-hidden': 'true' }, String(i + 1).padStart(2, '0')),
      h('div', { class: 'jy-copy' }, h('h3', { tabindex: -1 }, step.title), h('p', { class: 'jy-promise' }, step.promise),
        h('ul', {}, ...step.points.map(rich)),
        go ? h('button', { class: 'btn sm', type: 'button', onclick: () => { navigating = true; dlg.close(); go(); } }, step.action)
          : h('p', { class: 'note' }, 'Open or create a project to use this stage.')),
      stageVisual(step.id, disposers));
  });
  const dlg = h('dialog', { id: 'journey-dialog', class: 'journey-dialog', 'aria-labelledby': 'journey-title' },
    h('div', { class: 'dialog-head' }, h('h2', { id: 'journey-title' }, 'How Comfy Previs works'), h('button', { class: 'btn ghost sm', type: 'button', 'aria-label': 'Close guide', onclick: () => dlg.close() }, 'Close')),
    h('div', { class: 'dialog-body' },
      h('p', { class: 'journey-intro' }, 'Build → Cast → Shoot → Generate → Cut. Start anywhere. This guide only opens controls: it never edits your project or starts a generation.'),
      context ? h('p', { class: 'journey-context' }, context) : null,
      h('ol', { class: 'journey-steps' }, ...rows),
      h('details', { class: 'journey-boundaries' }, h('summary', {}, 'Other ways to work, costs and limits'),
        h('dl', {},
          h('dt', {}, 'Claude'), h('dd', {}, 'Add Comfy Previs to Claude Code as an MCP server (see “Works with Claude” on the home page) and direct the scene in chat. Claude edits the same project you see.'),
          h('dt', {}, 'Gamepad and phone'), h('dd', {}, 'Fly camera works with the keyboard, any standard gamepad (two stick layouts) or your phone held like a camera. Pair the phone once by scanning a QR code.'),
          h('dt', {}, 'Costs'), h('dd', {}, 'Blockouts are free. A still is a few cents; a 5 s video is about a dollar. Nothing is charged without the approval box, and the dialog shows the estimate first.'),
          h('dt', {}, 'Limits'), h('dd', {}, 'Models that animate from stills do not see your camera move, so check each result against its blockout in Cut. Your work saves automatically; project export keeps the project and its media together.')),
        h('div', { class: 'ex-devices' }, gamepadDiagram('game'), gamepadDiagram('drone'), phoneDiagram(), phonePairDiagram()))));
  // Keep workspace undo/transform shortcuts out of this read-only modal; native Tab/Escape still work.
  dlg.addEventListener('keydown', ev => ev.stopPropagation());
  dlg.addEventListener('close', () => { for (const d of disposers) d(); dlg.remove(); if (!navigating && opener?.isConnected) opener.focus(); }, { once: true });
  document.body.append(dlg);
  dlg.showModal();
  if (current) { const row = rows[JOURNEY.findIndex(s => s.id === current)]!; row.scrollIntoView({ block: 'nearest' }); row.querySelector('h3')?.focus({ preventScroll: true }); }
}
