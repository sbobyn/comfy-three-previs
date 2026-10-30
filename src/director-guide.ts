import { h } from './director-common';

export const JOURNEY = [
  { id: 'scene', title: 'Build the scene', action: 'Open direction & scene', detail: 'Start with a template or an empty project. Add and arrange objects in the viewport, or describe the blockout in Direct. Select an object to frame it and edit its identity. One editable scene can have several shots.' },
  { id: 'looks', title: 'Give objects a look', action: 'Open Looks', detail: 'Drop an image on an object, upload a reference, or open Generate image… in Object. Use Looks for shared style and object references. Images stay associated with their named objects; opening generation settings does not run a job.' },
  { id: 'shot', title: 'Direct each shot', action: 'Open Shot controls', detail: 'Choose a shot on the left. In Shot, review Cast and Auto-prompt, then camera, lens, duration and keyframes. Preview the move, or record a take in Operate. Review and keep a take deliberately. Edits save to this project; reopen it from Projects. Saving a camera edit does not update an earlier captured video.' },
  { id: 'capture', title: 'Capture the exact source', action: 'Review render settings', detail: 'Render shot shows framing, delivery resolution, frame count and FPS before capture. Capture camera video saves a new source asset with its scene/camera revision. Check that saved clip before choosing AI inputs; it can differ from the current shot settings.' },
  { id: 'workflow', title: 'Review the AI request', action: 'Open Sequence & generation', detail: 'Keep Task, Workflow and Backend separate. A full-video edit receives the clip; a control-video workflow receives a structure guide; first-frame/key-frame animation receives stills and cannot establish preservation of the original camera move. Review exact inputs, parameters, compatibility and quote before submitting.' },
  { id: 'compare', title: 'Compare and review', action: 'Open Sequence & comparison', detail: 'In Sequence, select a shot and Compare. The saved result stays tied to its original source, not the newest capture. Check appearance, composition and motion as well as dimensions, FPS, frame count and duration. Comparison stops at the shorter end; Generated plays the complete result without a timing fit.' },
  { id: 'export', title: 'Choose versions & take it with you', action: 'Open Assets & project export', detail: 'Use Sequence to choose source/result versions. Edit opens the timeline for arranging shots and exporting a cut. Assets lists saved media and downloads; project export preserves the editable project and its managed media. Keep an offline copy for presentation.' },
] as const;

export type JourneyStage = typeof JOURNEY[number]['id'];
type GuideOptions = { stage?: JourneyStage; context?: string; actions?: Partial<Record<JourneyStage, () => void>> };

/** Navigation only: opening the guide never edits a project or dispatches a job. */
export function openJourney({ stage, context, actions = {} }: GuideOptions = {}) {
  document.getElementById('journey-dialog')?.remove();
  const opener = document.activeElement as HTMLElement | null;
  let navigating = false;
  const rows = JOURNEY.map((step, i) => h('li', { id: `journey-${step.id}`, class: stage === step.id ? 'is-current' : '' },
    h('span', { class: 'journey-number', 'aria-hidden': 'true' }, String(i + 1).padStart(2, '0')),
    h('div', {}, h('h3', { tabindex: -1 }, step.title), h('p', {}, step.detail),
      actions[step.id] ? h('button', { class: 'btn sm', type: 'button', onclick: () => { navigating = true; dlg.close(); actions[step.id]!(); } }, step.action)
        : h('p', { class: 'note' }, 'Open or create a project to use this stage.'))));
  const dlg = h('dialog', { id: 'journey-dialog', class: 'journey-dialog', 'aria-labelledby': 'journey-title' },
    h('div', { class: 'dialog-head' }, h('h2', { id: 'journey-title' }, 'How Previs works'), h('button', { class: 'btn ghost sm', type: 'button', 'aria-label': 'Close guide', onclick: () => dlg.close() }, 'Close')),
    h('div', { class: 'dialog-body' },
      h('p', { class: 'journey-intro' }, 'Scene → shot → captured source → AI request → comparison. Start anywhere; the guide opens controls, never starts a capture or paid job.'),
      context ? h('p', { class: 'journey-context' }, context) : null,
      h('ol', { class: 'journey-steps' }, ...rows),
      h('details', { class: 'journey-boundaries' }, h('summary', {}, 'Other paths, power-user features & current limits'),
        h('dl', {},
          h('dt', {}, 'Agent / MCP'), h('dd', {}, 'Direct supports the built-in Claude Code runner, your own MCP client, and an offline phrase parser. Runner installed does not mean account quota is available. Parser is not AI. Use Agent for connection instructions.'),
          h('dt', {}, 'Imported workflows & LoRAs'), h('dd', {}, 'The advanced workflow page imports API graphs and maps inputs, outputs and editable parameters. Authored models and LoRA settings are preserved; missing nodes or weights must be resolved explicitly. Local execution is not automatically free if a graph contains paid API nodes.'),
          h('dt', {}, 'Blender-owned scenes'), h('dd', {}, 'Connect actual Blender MCP, bind an existing scene/camera/range, then inspect and render. Blender remains authoritative. Saved media is usable while Blender is disconnected. Combined transfer is camera-only; no geometry round trip.'),
          h('dt', {}, 'Phone & Xbox'), h('dd', {}, 'Control and recording interfaces exist. Pair the phone and connect the controller for a real-device rehearsal; software presence is not hardware qualification. Keyboard and saved moves remain the demo fallback.'),
          h('dt', {}, 'AI qualification'), h('dd', {}, 'Saved Cloud results prove execution, not creative acceptance. The retained Take One LTX run uses key-frame images and is largely static; it does not qualify the requested chase motion. Local framewise SD was quality-rejected; temporal local video remains unqualified.'),
          h('dt', {}, 'Recovery & costs'), h('dd', {}, 'Keep receipts and track known jobs. Unknown acceptance is not cancellation: do not blindly resubmit. An estimate or spending allowance is not a settled bill. No capture, provider upload or generation runs from this guide.')),
        h('nav', { 'aria-label': 'Specialist tools' }, h('a', { href: '/index.html' }, 'Camera studio'), h('a', { href: '/previs.html' }, 'Blender scenes'), h('a', { href: '/generation.html' }, 'Advanced workflows'), h('a', { href: '/setup.html' }, 'Setup & readiness')))));
  // Keep workspace undo/transform shortcuts out of this read-only modal; native Tab/Escape still work.
  dlg.addEventListener('keydown', ev => ev.stopPropagation());
  dlg.addEventListener('close', () => { dlg.remove(); if (!navigating && opener?.isConnected) opener.focus(); }, { once: true });
  document.body.append(dlg);
  dlg.showModal();
  if (stage) { const row = rows[JOURNEY.findIndex(s => s.id === stage)]!; row.scrollIntoView({ block: 'nearest' }); row.querySelector('h3')?.focus({ preventScroll: true }); }
}
