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

**Video workflows (private candidate):** render a bounded Blender animation through actual MCP, or export a saved browser recording, into immutable MP4 shot versions. In **Video workflows**, choose Task / Workflow / Backend separately, import an API graph, explicitly map media/prompt/outputs, inspect live node/model choices, edit mapped parameters and LoRAs, prepare a quote, submit once when authorized, and collect/compare declared outputs. Paid execution is disabled by default. Existing image passthrough remains a transport test, not AI generation.

Real local evidence includes a user-imported native video-processing graph, returned video and saved comparison review. LoRA import/edit/reload/preparation is verified without inference. Cloud's adapter is implemented against its **deprecated v1** contract; live Cloud validation is blocked by an unavailable credential. **No AI video result has been generated or qualified yet.**
Use the in-app **Setup & readiness** page, then read [setup, architecture and recovery](docs/standalone-previs.md), [release boundaries and evidence](docs/release-checkpoint.md), and the [walkthrough outline](docs/demo-outline.md).

## Release boundaries

**Release requirement:** camera-controlled rendered video → real AI video workflow → collected and reviewed output. Both Comfy Cloud and a configured local ComfyUI backend are required, with imported API graphs and preserved LoRA settings. Task, workflow and backend are separate choices. Passthrough proves transport only and is not release completion. Implementation and qualification are tracked in [video checkpoint](docs/video-checkpoint.md). Depth/pose passes, broad asset conversion, a general world editor and physics remain deferred. Browser authoring uses the camera-study set. Phone/gamepad code is inherited; current hardware behavior is unqualified. [Historical prototype notes](docs/three-vcam-history.md) are evidence of earlier work, not current qualification.

Our standalone code is **MIT licensed**; see [LICENSE](LICENSE) and [license scope and third-party notices](THIRD_PARTY_NOTICES.md). Inherited three-vcam provenance still needs confirmation for any third-party portions. Keep this repository private; no publication is authorized.
