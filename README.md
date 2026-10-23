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

For a reproducible first experience, choose **Start a three-second dolly** in the workspace. Replay → save → reopen → export directly at **1280×720** (or lightweight 640×360) → use that exact video in a workflow → inspect and prepare. Delivery resolution, 16:9 framing, 24 fps, frame count and timing appear before export. No Blender or external media is required. See [first-use routes](docs/first-use.md) for clean setup, existing Blender scenes and recorded comparisons.

### Configure Comfy Cloud

Copy `.env.example` to `.env` beside `package.json` if `.env` does not already exist. Add your key after `COMFY_CLOUD_API_KEY=` in that local file; keep `PREVIS_ALLOW_PAID=0`. On macOS/Linux, run `chmod 600 .env` to restrict file access. `.env` is gitignored; never add the key to a workflow, project, browser field or chat.

Restart with `pnpm start`, then open **Setup & readiness → Check Cloud access**. This inspects available nodes without submitting a job. `pnpm start` and `pnpm dev` load `.env` at startup using Node's built-in loader; existing shell variables take precedence. The app still starts when `.env` is absent. Adding a key does not approve paid generation: that separately requires a reviewed quote, deliberate enablement and a matching per-request approval. See [Cloud credential setup](docs/standalone-previs.md#cloud-credentials).

## Three deliberate paths

- **Work in Blender:** connect through the actual Blender MCP server/addon, inspect exact scene/camera/timing, bind a shot, render a local beauty PNG, save and recover it. Blender owns its file; Previs restores settings and does not save that file.
- **Work in the browser:** move the subject in the fixed camera-study set, operate and record the camera, save a new shot and preview, reopen, scrub and replay. Blender is optional.
- **Transfer supported content:** camera-only transfer into a uniquely named new scene in a disposable Blender project. Positions, orientations and lens animation transfer at 24 fps; geometry is omitted. Save the target file in Blender yourself.

**Video workflows (private candidate):** render a bounded Blender animation through actual MCP, or export a saved browser recording, into immutable MP4 shot versions. In **Video workflows**, choose Task / Workflow / Backend separately, import an API graph, explicitly map media/prompt/outputs, inspect live node/model choices, edit mapped parameters and LoRAs, prepare a quote, submit once when authorized, and collect/compare declared outputs. Paid execution is disabled by default. Existing image passthrough remains a transport test, not AI generation.

The [hands-on review pack](docs/review-pack.md) links the playable comparisons, real-app recording, architecture diagrams and qualification table. One approved Kling O1 Cloud edit is retained with its saved review: 73 frames / 3.041667 seconds versus the original 72 / 3 seconds, with no timing fit. A new user-imported local SD1.5 workflow performed genuine AI inference on every source frame and returned a video, but its appearance/temporal quality was rejected. It is framewise image inference, not a temporal video model; that release qualification still needs suitable installed weights. LoRA configuration is verified without inference. Paid execution remains disabled.

Cloud v1 remains available for existing integrations but may change without notice. Deprecated history retrieval has been replaced by the documented job-details endpoint with exact request/graph verification. Broader v2 migration is a separately scoped support decision. Inherited source ownership remains unresolved before distribution.
Use the in-app **Setup & readiness** page, then read [setup, architecture and recovery](docs/standalone-previs.md), [release boundaries and evidence](docs/release-checkpoint.md), and the [walkthrough outline](docs/demo-outline.md).

## Release boundaries

**Release requirement:** camera-controlled rendered video → real AI video workflow → collected and reviewed output. Both Comfy Cloud and a configured local ComfyUI backend are required, with imported API graphs and preserved LoRA settings. Task, workflow and backend are separate choices. Passthrough proves transport only and is not release completion. Implementation and qualification are tracked in [video checkpoint](docs/video-checkpoint.md). Depth/pose passes, broad asset conversion, a general world editor and physics remain deferred. Browser authoring uses the camera-study set. Phone/gamepad code is inherited; current hardware behavior is unqualified. [Historical prototype notes](docs/three-vcam-history.md) are evidence of earlier work, not current qualification.

Our standalone code is **MIT licensed**; see [LICENSE](LICENSE) and [license scope and third-party notices](THIRD_PARTY_NOTICES.md). Inherited three-vcam provenance still needs confirmation for any third-party portions. Keep this repository private; no publication is authorized.
