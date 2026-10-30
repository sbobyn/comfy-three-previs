# Comfy Previs

Block out a 3D scene in the browser, direct it shot by shot (in plain language, through your own AI agent over MCP), attach and generate visual references for every object, preview the camera, and hand the exact camera render to a ComfyUI workflow.

Everything runs locally. Nothing is uploaded or charged unless you approve a specific quoted request.

## Quick start

You need **Node.js 22.12+**, **pnpm 10** and **FFmpeg** (for exporting camera videos).

```sh
# 1. Prerequisites (pick your OS)
#    macOS:   brew install node ffmpeg
#    Ubuntu:  sudo apt install ffmpeg   (Node 22+: https://nodejs.org or `nvm install 22`)
#    Windows: winget install OpenJS.NodeJS Gyan.FFmpeg
corepack enable            # provides the pinned pnpm version

# 2. Clone, install, build and check
git clone <this-repo-url> comfy-previs && cd comfy-previs
pnpm run bootstrap         # = pnpm install --frozen-lockfile && pnpm run build && pnpm run doctor

# 3. Run
pnpm start                 # → http://127.0.0.1:5190
```

`pnpm run doctor` re-checks your machine at any time and tells you how to fix anything missing. The launch page shows the same checklist.

### Optional: connect services

Copy `.env.example` to `.env` (it is git-ignored) and fill in only what you use, then restart `pnpm start`.

| Want to… | Set | Notes |
|---|---|---|
| Quote / generate on Comfy Cloud | `COMFY_CLOUD_API_KEY` | Quotes are free. Paid runs also need `PREVIS_ALLOW_PAID=1` **and** your approval of each quote. |
| Generate on your own GPU | run [ComfyUI](https://github.com/comfyanonymous/ComfyUI) locally | Default `http://127.0.0.1:8000`; change with `PREVIS_COMFY_URL`. Uses installed checkpoints only; nothing is downloaded. |
| Keep projects elsewhere | `PREVIS_DATA_DIR` | Default `.previs/` in the checkout. |
| Use another port | `PORT` | Default 5190. |
| Drive Blender | `PREVIS_BLENDER_MCP_COMMAND`, `PREVIS_BLENDER_MCP_ARGS` | See [setup & architecture](docs/standalone-previs.md#blender-mcp). |

Never commit `.env` or paste keys into prompts, workflows or chat.

### Optional: direct with your AI agent

Previs ships an MCP server (`server/previs/agent.mjs`). Click **Agent** in the app for the exact command, e.g. for Claude Code:

```sh
claude mcp add comfy-previs -e PREVIS_URL=http://127.0.0.1:5190 -- node /path/to/comfy-previs/server/previs/agent.mjs
```

Then ask your agent to *“listen for Previs direction”*. It reads your chat messages, edits the blockout/shots/camera and replies. Without an agent, a built-in parser handles simple directions offline. Agents can quote generations but only you can approve them.

## Using it

Open **How it works** on the launch page, or **Guide** inside a project, for the seven-stage feature map. Workspace guide buttons open the existing controls without starting a capture or generation. Expand the feature limits for MCP, Blender, imported graphs/LoRAs, devices and AI qualification.

See the [user guide](docs/director.md). In short: **New project** → describe or drag the blockout → add shots and camera moves → add looks to objects (upload or generate) → **Render blockout… / Generate video ▸** (bottom of the right panel) → **Open in Comfy workflow**.

## Your projects and files

Each project is one folder: `.previs/director/<project-id>/` holding `project.json` (scene, shots, chat), `refs/` (all images), `assets/` (camera renders and workflow results) and `refgen/` (generation receipts). Use **⋯ → Export** on the launch page for a portable `.previs.zip`, and **Import project…** to bring one in. **Archive** moves a project to `.previs/director-archive/` (restorable; the app never deletes your files). Back up by copying `.previs/`.

## Development

```sh
pnpm check     # typecheck + build
pnpm test      # node --test
pnpm run doctor   # environment check
```

The server is plain Node (`server/previs/`), the browser app is Vite + three.js (`src/`), shared scene logic lives in `shared/`.

## Earlier tools and release notes

The camera studio (keyboard / phone / gamepad), Blender scenes, and the video workflow page remain available from the launch page footer. Background: [setup & architecture](docs/standalone-previs.md), [release boundaries](docs/release-checkpoint.md), [device controls](docs/device-controls.md).

### Three deliberate paths

- **Work in Blender:** connect through the actual Blender MCP server/addon, inspect exact scene/camera/timing, bind a shot, render a local beauty PNG, save and recover it. Blender owns its file; Previs restores settings and does not save that file.
- **Work in the browser:** move the subject in the fixed camera-study set, operate and record the camera, save a new shot and preview, reopen, scrub and replay. Blender is optional.
- **Transfer supported content:** camera-only transfer into a uniquely named new scene in a disposable Blender project. Positions, orientations and lens animation transfer at 24 fps; geometry is omitted. Save the target file in Blender yourself.

**Video workflows (private candidate):** render a bounded Blender animation through actual MCP, or export a saved browser recording, into immutable MP4 shot versions. In **Video workflows**, choose Task / Workflow / Backend separately, import an API graph, explicitly map media/prompt/outputs, inspect live node/model choices, edit mapped parameters and LoRAs, prepare a quote, submit once when authorized, and collect/compare declared outputs. Paid execution is disabled by default. Existing image passthrough remains a transport test, not AI generation.

The [hands-on review pack](docs/review-pack.md) links the playable comparisons, real-app recording, architecture diagrams and qualification table. One approved Kling O1 Cloud edit is retained with its saved review: 73 frames / 3.041667 seconds versus the original 72 / 3 seconds, with no timing fit. A new user-imported local SD1.5 workflow performed genuine AI inference on every source frame and returned a video, but its appearance/temporal quality was rejected. It is framewise image inference, not a temporal video model; that release qualification still needs suitable installed weights. LoRA configuration is verified without inference. Paid execution remains disabled.

Cloud v1 remains available for existing integrations but may change without notice. Deprecated history retrieval has been replaced by the documented job-details endpoint with exact request/graph verification. Broader v2 migration is a separately scoped support decision. Inherited source ownership remains unresolved before distribution.
Use the in-app **Setup & readiness** page, then read [setup, architecture and recovery](docs/standalone-previs.md), [release boundaries and evidence](docs/release-checkpoint.md), and the [walkthrough outline](docs/demo-outline.md).

### Release boundaries

**Release requirement:** camera-controlled rendered video → real AI video workflow → collected and reviewed output. Both Comfy Cloud and a configured local ComfyUI backend are required, with imported API graphs and preserved LoRA settings. Task, workflow and backend are separate choices. Passthrough proves transport only and is not release completion. Implementation and qualification are tracked in [video checkpoint](docs/video-checkpoint.md). Depth/pose passes, broad asset conversion, a general world editor and physics remain deferred. Browser authoring uses the camera-study set. Phone/Xbox controls have an isolated operator flow and a phone-only HTTPS connection; see [device setup and rehearsal](docs/device-controls.md). Physical iPhone/Xbox qualification remains pending. [Historical prototype notes](docs/three-vcam-history.md) are evidence of earlier work, not current qualification.

Our standalone code is **MIT licensed**; see [LICENSE](LICENSE) and [license scope and third-party notices](THIRD_PARTY_NOTICES.md). Inherited three-vcam provenance still needs confirmation for any third-party portions. Keep this repository private; no publication is authorized.
