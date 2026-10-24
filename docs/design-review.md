# Previs workstation design review

This bounded visual pass starts from the reviewed Tuesday release candidate `6915f88`. The first-use and earlier video checkpoints remain preserved. Exact integrated SHA, model identities, runtime ownership and verification logs are recorded in the operator-local [design checkpoint](../.evidence/design-20261024/checkpoint.json). The non-spending review build is **http://127.0.0.1:5199**; it uses a disposable full-library copy, not the original project.

## Layout and scope

The recommended **Bench** layout puts a neutral media stage beside a contextual inspector. The camera studio has a small header, unobstructed world/camera views, saved-motion transport below, and a scrolling shot/lens inspector. Camera pointer regions and rendering use the same measured stage bounds; native capture rendering remains unchanged. At narrow sizes, transport and inspector follow the stage in normal document flow. Below 500 CSS pixels, the camera takes the whole stage; the world orbit view is omitted.

The workflow workbench has two explicit views: **Source & request** and **Compare & review**. Switching views retains the prepared request and deliberate comparison selection. A compact shot/source strip identifies the selected immutable version. Captured settings and current shot bindings are separate. Task, Workflow and Backend remain distinct controls. Readable workflow parameters and LoRAs remain available; node mappings, full provenance and author graphs use Advanced disclosures. Job history is secondary, with a prominent unknown-outcome notice and automatically opened recovery history when needed.

The single alternative considered was a comparison-first stage with source/result always at the top. It was rejected for this pass because it would show several different source versions together during authoring. Saved comparison links instead open directly into the comparison view.

Published Ink, Yellow, Plum, Canvas, Warm White, Mauve and Cool Gray anchor the shell. Yellow prioritizes the next action, Plum plus a light indicator marks selection, and media stays on a neutral surround. Focus rings are offset from controls. No font downloads, Comfy artwork, framework, backend rewrite or media recoloring is included. Original Previs branding and third-party notices remain.

Sources: [shared brand reference](https://comfy.org/brand/) and [Comfy homepage](https://comfy.org/). The palette is an integration design reference, not an endorsement claim.

## Short review route

1. Open **Scenes & shots**. Browser-first and existing-Blender-file routes have explicit ownership labels. Saved media works with Blender closed. In a fresh project, start a browser dolly rather than connecting Blender.
2. Open **Camera studio** from a saved browser shot, or start a new three-second dolly. Replay → save a new shot → reopen → export at 1280×720. Delivery states 16:9, 24 fps, 72 frames / 3 seconds. Export uses saved motion, subject and delivery; it does not capture unsaved live edits.
3. Follow **Use this exact video in a workflow**. Check the source version, asset request revision, camera/lens/range, Task / Workflow / Backend and readable parameters. Prepare a quote. Confirm the request/player/estimate identify the same source. Stop before Run; the preview disables paid execution.
4. [Open the recorded Kling comparison](http://127.0.0.1:5199/generation.html?job=1c706a23-064a-4dcc-9f4e-2c6ec6ed8a3b&output=7416f999-83a6-40a7-916d-cb096b61415a). This opens existing media; no new generation occurs. Seek to 3.02 seconds. The source ends at 3 seconds while the 73-frame result continues to 3.041667 seconds. Notes and exact downloads belong to that saved request/output, not the current shot.
5. Open Advanced only when needed. Imported graphs, authored model/LoRA values, declared outputs, full request identity and recovery acknowledgments remain inspectable. A missing source/output is refused; another candidate is never silently substituted.

[Matched before/after screenshots](../.evidence/design-20261024/) · [short walkthrough](../.evidence/design-20261024/design-walkthrough.mp4). These are operator-local evidence, not bundled media or a fresh-generation demonstration.

## Evidence and limits

Actual Chrome acceptance covers browser authoring/save/reopen/native 720p export, source playback and quote preparation, retained Kling comparison, ended-player behavior, output/notes restoration, keyboard focus, first-run, disconnected Blender and stale capture states. The new export took 2.0 seconds on the review machine and was byte-identical to the retained export of the same motion. This is observed behavior, not a portable performance guarantee. No provider upload or submission occurred.

Connection loss, uncertain acceptance and recovery use clearly labelled disposable simulations plus existing guard tests. No real failure was induced in a paid job. Live Blender rendering was not repeated for a styling change; original scene ownership and fixed operation scripts remain intact.

Responsive checks cover 1440×900, 1280×720 and 720×450 CSS pixels. The last checks reflow equivalent to the available space at 200% zoom, not actual browser zoom: native control permission was unavailable and the browser shortcut did not change zoom. Actual OS download completion also remains unqualified; exact source/result URLs and bytes are verified, with the earlier browser-tool timeout retained as a limitation.

The retained framewise SD1.5 result remains quality-rejected. Local temporal qualification, its three missing pinned weights and separate download/execution approval are unchanged; see [local temporal test](local-temporal-test.md). Workspace-level billing of approximately $0.419934 is still not a proven final settled charge for the exact Kling job. Cloud retrieval compatibility and temporary support boundaries remain as documented in [Tuesday review](tuesday-review.md).

MIT covers original Previs contributions. Before distribution, Steven must confirm ownership of the 23 inherited three-vcam baseline paths or identify their upstream permissions. Git authorship is insufficient. No remote, visibility, publication or ownership decision was changed by this pass.
