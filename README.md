# Comfy Previs

A private, standalone camera-study and Blender preview app. No Otter server, editor, library, account, assistant or launcher is required.

## Run locally

Requires **Node 22.12+** and **pnpm 10.18.0**. Install those prerequisites separately; the app does not change global agent configuration.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm start
```

Open **http://127.0.0.1:5190**. `PREVIS_DATA_DIR` chooses a project folder (default `.previs`); keep the entire folder, including renders and operation/job receipts, to recover your project. `PORT` selects another local port. `pnpm dev` builds and starts this same complete app; rebuild after editing browser code. `pnpm dev:camera` is the inherited camera-only Vite development server on 5187 and does not provide project APIs.

## Three deliberate paths

- **Work in Blender:** connect through the actual Blender MCP server/addon, inspect exact scene/camera/timing, bind a shot, render a local beauty PNG, save and recover it. Blender owns its file; Previs restores settings and does not save that file.
- **Work in the browser:** move the subject in the fixed camera-study set, operate and record the camera, save a new shot and preview, reopen, scrub and replay. Blender is optional.
- **Transfer supported content:** camera-only transfer into a uniquely named new scene in a disposable Blender project. Positions, orientations and lens animation transfer at 24 fps; geometry is omitted. Save the target file in Blender yourself.

**Local Comfy handoff** binds a saved render to an imported API-format workflow or included example. The first release accepts native LoadImage → SaveImage only: inspect compatibility, submit once, track the saved prompt ID, and collect declared outputs against the originating shot and request revision. This is **passthrough, not AI generation**. No models, paid/API nodes, custom nodes or cloud execution are enabled.

Use the in-app **Setup & readiness** page, then read [setup, architecture and recovery](docs/standalone-previs.md), [release boundaries and evidence](docs/release-checkpoint.md), and the [walkthrough outline](docs/demo-outline.md).

## Release boundaries

Beauty stills only. No depth/pose passes, broad asset conversion, general world editor, physics, generated footage or Comfy authentication. Browser authoring uses the camera-study set. Phone/gamepad code is inherited; current hardware behavior is unqualified. [Historical prototype notes](docs/three-vcam-history.md) are evidence of earlier work, not current qualification.

Keep this repository private. The inherited three-vcam source has no tracked license grant. Publication requires Steven's confirmation of source ownership and intended copyright/license, plus separate publication approval. Private implementation does not grant redistribution rights.
