# Standalone Comfy Previs — setup and architecture

This topic branch extends the existing three-vcam application from `b37ebb01d1232165f48a718673f9d6b4cf2836be`. It does not use Otter's server, editor, library, assistant, account, or launcher. Keep this branch private. Our code is now MIT licensed; inherited provenance caveats are listed in THIRD_PARTY_NOTICES.md.

## Run

Requires Node 22.12+ and pnpm 10. Install with `pnpm install --frozen-lockfile`, then `pnpm check && pnpm test`. `pnpm start` serves the built app at `http://127.0.0.1:5190`. `PORT` changes the port; `PREVIS_DATA_DIR` selects a project folder (default `.previs`, gitignored). Each folder is one project. Browser work, Blender rendering and native local processing need no Comfy account. Cloud and paid Partner Nodes require separately configured credentials.

The server locks its project folder. Graceful shutdown releases that lock. After a crash, the server checks the recorded PID and archives a dead process's lock automatically. A live owner is refused; never remove its lock. Atomic saves and revision checks protect against simultaneous UI/agent edits. Media are immutable previews and versioned video/result assets. Keep the complete project folder, including assets, renders, generation-jobs, comfy-jobs and Blender operation receipts.

## Cloud credentials

1. Copy `.env.example` to `.env` in the checkout root if that file does not already exist. Preserve any existing settings. On macOS/Linux, restrict access with `chmod 600 .env`.
2. Open `.env` locally and fill in `COMFY_CLOUD_API_KEY=` with your Comfy Cloud API key. Keep `PREVIS_ALLOW_PAID=0` for connection checks. Do not prefix credentials with `VITE_`, put them in graph/project JSON, or enter them in chat.
3. Stop and restart the app with `pnpm start`, retaining the same `PREVIS_DATA_DIR` and Blender settings. A running server does not reload credentials automatically. Existing shell variables override `.env`; unset an outdated shell value if you intend to use the file instead.
4. Open **Setup & readiness → Check Cloud access**. This reads Cloud's node schemas without uploading media or submitting a job. A missing key is reported locally; HTTP401 means the configured credential was not accepted.

`.env` is ignored by Git; `.env.example` contains only empty credentials and safe defaults. Only the server consumes `COMFY_CLOUD_API_KEY`; it is injected into authenticated requests, never returned in project/job records. The Node22 startup command uses `--env-file-if-exists=.env`, so installation remains usable without Cloud. `pnpm dev` uses the same startup path. Launching `node server/previs/server.mjs` directly does **not** load the file; use `pnpm start`, or supply the same Node flag from the checkout root. Agent clients connect to the running Previs server and do not need the Cloud key.

A valid credential does not authorize charges. Keep paid execution disabled until the exact backend, source assets, workflow, settings, known/unknown costs and spending allowance have been reviewed. Deliberately enabling `PREVIS_ALLOW_PAID=1` after approval still requires a matching per-request approval fingerprint. Do not enable it merely to test connectivity. Local Partner Nodes use the separate optional `COMFY_API_KEY`; ordinary local computation needs no key.

## Blender MCP

Most Blender work does not need this. To bring a Blender shot into the Director, use the headless helper in [blender-import.md](blender-import.md#choose-a-route). It needs no add-on and no arbitrary-code server, and Blender Agent (Agent Link) users should use it too. This section covers Previs driving a running Blender for camera previews.

Selected upstream: https://github.com/ahujasid/mcp-for-blender (formerly ahujasid/blender-mcp), package **2.2.2**, commit **5a3618fccb2d982d0dd61e7a1879912c3100073b**, MIT. This is the one pin for every Previs Blender MCP route. blender-import.md uses the same version, and the PyPI `mcp-for-blender==2.2.2` wheel bundles an `addon.py` byte-identical to this commit's. This route was tested with Blender 4.5.4 LTS (GUI); see Evidence and limits below. Python >=3.10; upstream dependencies mcp >=1.26,<2 and httpx >=0.27. Use matching `addon.py` from that commit, installed using Blender's addon UI, and enable its server. Upstream supports a running GUI Blender, not background `-b` mode.

Example with uv installed:

```sh
export PREVIS_BLENDER_MCP_COMMAND=uv
export PREVIS_BLENDER_MCP_ARGS='["tool","run","--from","git+https://github.com/ahujasid/mcp-for-blender@5a3618fccb2d982d0dd61e7a1879912c3100073b","mcp-for-blender"]'
export BLENDER_HOST=127.0.0.1
export BLENDER_PORT=9876
pnpm start
```

The first uv invocation downloads the small Python package/dependencies. Pin is source identity, not a claim of a fully locked Python dependency graph. Previs disables upstream telemetry in its child environment. Upstream addon update checks can be disabled with `BLENDERMCP_NO_UPDATE_CHECK=1` in Blender's environment. No global agent configuration is edited.

Architecture: browser → standalone Node HTTP server → actual upstream MCP stdio process → actual upstream Blender addon → Blender. The app uses MCP initialize, tools/list and tools/call (`execute_blender_code`) with fixed inspection/render scripts. The previous custom Otter subprocess bridge is not reused or described as MCP.

Save an existing Blender scene first. Connect/refresh, select exact scene and camera, choose shot range/frame, save shot, render preview. The local raw beauty preview uses square pixels at 640×360; compositing/sequencer/border cropping are disabled temporarily. Active scene/view layer, camera, camera markers, frame/subframe and changed render settings restore in `finally`. The app does not save the `.blend` file. Blender's Render Result and dirty flag may change during rendering. Blender remains authoritative.

App operations serialize. Refresh after external edits. File, scene, camera, FPS and frame range are checked again inside Blender before render. Do not edit Blender concurrently with a preview; external MCP clients do not share the app's queue. A durable operation receipt is saved before dispatch. An uncertain execution/transport failure or interrupted server locks further Blender execution across restarts. Recovery requires the exact operation and explicit confirmation that Blender is idle and its settings have been reviewed. Refresh follows reconciliation; the operation is never automatically retried. This does not cancel a running Blender operation.

## Browser-only path

Open camera studio. Existing three-vcam rendering, flight, lens, smoothing, gamepad and phone-relay primitives are retained. The Previs adapter lets you move the existing subject, record resolved camera motion (up to 60 seconds, sampled at up to 24 Hz), and save a beauty PNG plus camera/subject/motion state as a shot. Reopen the saved camera/motion from the shot list. Reopening holds the saved capture pose; Replay motion plays the recorded motion, and the scrubber can inspect it. Beauty PNG previews remain 640×360. Video delivery is saved with the shot: 640×360 or genuinely rendered 1280×720, 16:9 at 24 fps. The workspace offers new unsaved three-second dolly/crane sequences (72 frames); see first-use.md. Reopening retains delivery settings. Changing them requires a new shot save; historical captures remain immutable.

This is a fixed editable camera-study set, not a general world editor. Existing phone and gamepad code is present; no hardware qualification was performed. The default host is loopback and does not make phone LAN/HTTPS connectivity work automatically. Existing world-import, splat, text/image/video-to-world refinement and depth/pose rendering are not included.

## Project boundary and handoff

Version 1 stores project identity/revision/title; scenes with explicit `owner`; shots with source, scene/camera identity and timing; immutable renders; workflow bindings and transfer receipts, with references reserved for a later slice. Blender shots point to authoritative files; browser shots persist the small browser-set state and resolved motion. No automatic bidirectional scene synchronization is implied.

Download PNGs and the explicit asset handoff JSON from a shot. Rebinding preserves historical images with their original bindings; the manifest includes only previews matching the current binding. It includes source, timing, image URLs and supported pass. This older still-image manifest supports beauty PNGs only; requesting another pass is rejected. The separate video workflow page supports beauty MP4 assets. This is an input manifest, not a Comfy workflow graph or executed job. The local passthrough path below supports explicit workflow binding and returned output review. Real AI video execution is a release requirement. This section describes the earlier transport baseline; see video-checkpoint.md for the corrected scope. Paid execution requires an exact quote and explicit approval.

## Bring your own agent

Start the app and point any stdio MCP client at `node <checkout>/server/previs/agent.mjs`, with `PREVIS_URL=http://127.0.0.1:5190`. Tools read project state, refresh Blender, save/render shots and animations, inspect workflow backends, save definitions/bindings, quote, explicitly submit and track exact jobs. UI and clients use the same server, project revisions and operation queue. Use one app-owned Blender MCP process per Blender instance; direct external Blender MCP clients must be coordinated explicitly. No provider-specific agent implementation or config changes are needed.

## Inventory and licensing

- three-vcam: existing independent Three.js/Vite/TypeScript/ws camera prototype; no tracked inherited source license. Original Previs code is MIT under Steven’s explicit instruction; inherited ownership exceptions remain in THIRD_PARTY_NOTICES.md.
- Story Studio: already independently extracted, MIT (Steven Bobyn). Its storage/MCP patterns informed the boundary; no Story Studio files were copied and its active worktree was untouched.
- Otter: FSL-1.1-ALv2; no editor/render source copied. Prior branch and evidence retained on hold.
- Blender MCP: MIT, external pinned dependency; retain its license if redistributed.

## Evidence and limits

Local validation: `pnpm check` (TypeScript and browser/relay builds), `pnpm test` (storage conflicts/restart, binding validation, recording validation, HTTP origin boundaries, shared stdio MCP state, upstream timeout lock). Vite reports the existing large Three.js chunk warning; no threshold was changed.

Real UI proof uses disposable data and a separate Blender 4.5.4 GUI instance with the official pinned addon on an isolated port. It connects, inspects a saved scene, saves a camera shot, renders/display/saves a 640×360 PNG, and restores that shot/render after a server restart. Browser proof moves the subject, records a dolly path, saves 362 motion samples and a beauty image, then reopens the saved shot. A further actual MCP render with crop enabled and nonsquare pixels in the source returned exactly 640×360; all recorded settings restored and the source .blend SHA-256 remained unchanged. Focused integration rereview found no remaining blocker after the timeout, crop and range fixes. This is local workflow proof, not release or hardware qualification.

Overnight hardening evidence: 10 automated tests (fault injection is labeled simulated) include interrupted dispatch/restart with no duplicate operation, stale catalogs, explicit reconciliation, failed journal writes, and rebind provenance. Actual upstream MCP proof restored camera markers and frame/subframe as well as render settings; file/scene/camera/FPS/range refusals stayed recoverable. Real browser UI proof saved a moved subject and 58 camera-motion samples, reopened the exact capture pose, and replayed to the recorded final pose.

## Real local Comfy handoff

Start an existing local Comfy instance, then use **Local Comfy handoff** or **Use this render in local Comfy**. Default backend is `http://127.0.0.1:8000`; set `PREVIS_COMFY_URL` for another loopback HTTP port. Cloud hosts, credentials and URL paths are refused. No global Comfy configuration is changed.

1. Choose a saved render. Select the example graph or import an API-format JSON graph (not a Comfy UI-format workflow).
2. Explicitly select the `LoadImage.image` input and declare every `SaveImage` output; save the binding.
3. Inspect backend compatibility. The app checks native node schemas and queue state. A busy queue is refused; coordinate ownership before submitting.
4. Submit local passthrough once. The app uploads a uniquely named input, preserves the authored graph, and submits a clone with only the selected image filename replaced. The SaveImage filename prefix remains as authored.
5. Track the exact prompt ID. Only declared PNG outputs are collected, attached to the originating shot and request revision, and retained after restart. Rebinding a shot does not change that output provenance.

This earlier transport baseline accepts exactly one native `LoadImage` and one to eight native `SaveImage` nodes consuming its IMAGE output. It is a transport/binding/output proof, **not AI generation**. Custom, model, paid/API and cloud nodes are rejected; no models are installed. Native passthrough may discard alpha through LoadImage's IMAGE output; it is not a promise of byte-identical file copying. Backend PNG metadata may differ.

Durable receipts live in `comfy-jobs/` beside `project.json`. Prompt UUID and request revision persist before submission. Repeating the same request UUID only returns its receipt. Restart or a lost response never resubmits. Tracking checks queue/history and verifies prompt identity, correlation and submitted graph before collecting. If a prompt is absent, the UI explains the uncertainty; inspect backend history and outputs. Explicitly closing an unresolved receipt requires both operator acknowledgments and an empty backend queue. Closing records **unknown outcome**, does not cancel or retry, and preserves evidence. Later submission is a separate deliberate request.

The project MCP facade exposes readiness, local compatibility inspection, workflow binding, single submission and exact-job tracking to any compatible agent. The same allowlist, revision checks and receipts apply as in the UI. Recovery acknowledgments remain deliberate operator actions in the UI.

Real evidence: Comfy UI 0.38.0 at a coordinated local instance accepted the native passthrough from a real Blender preview. Declared output returned at 640×360 with identical RGB pixels, attached at request revision 5, and survived app restart. Automated HTTP simulations separately verify lost acceptance responses, uppercase UUID replay, history identity refusal, undeclared-output exclusion, provenance after shot rebinding, idempotent attachment and explicit uncertain receipt closure. They are not additional real Comfy runs.

## Deliberate browser → Blender camera transfer

Use **Transfer supported content**. Choose a saved browser shot, inspect a saved disposable Blender project through the same MCP connection, acknowledge that target, and create a new camera scene. This intentionally transfers **camera only**, not geometry. Blender owns the new scene; the browser shot is unchanged. Existing Blender scenes and the active window scene are preserved. Previs never saves or overwrites the `.blend` file. Save the disposable project yourself in Blender to persist the new scene across Blender restarts.

Supported fields: resolved position, quaternion orientation and focal length; a captured pose or recorded motion sampled on integer frames at 24 fps. Coordinates map `(x,y,z)` to `(x,-z,y)` (Y-up to Z-up); one unit is one meter. Camera local forward/up remain −Z/+Y. The camera uses a 36 mm horizontal sensor, 16:9, 640×360, square pixels and 0.5–300 meter clipping. Frame 1 is time zero. The last frame rounds upward to the 24 fps grid and retains the exact recorded endpoint, extending timing by less than one frame where needed. Integer-frame poses are verified; subframe interpolation is not qualified.

All geometry, including the torus-knot subject and study-set landmarks, materials, lights, fog, helpers, physics, audio and phone/gamepad signals are omitted. Add scene content in Blender before rendering the transferred camera. There is no lossless round trip or automatic synchronization. A new Blender shot binding records the target scene/camera, source shot, request revision and verification. If transport becomes uncertain, use the same durable Blender operation recovery; no automatic repeat occurs. A retained partial scene is reported for inspection, never deleted.

Real MCP proof: one 58-sample browser recording transferred to a new scene spanning frames 1–87 at 24 fps; first/middle/last frames 1/44/87 passed position, orientation, lens and optical-projection checks. The original active scene/camera/frame restored and source file hash stayed unchanged. Framing comparison projects the source subject position and two reference positions through both cameras; it is a geometric comparison, not pixel equality between different rendered scenes. Unit tests independently compare projection math with the actual Three.js camera and cover non-frame-aligned recording endpoints.

Additional Blender context proof: rendering a non-active target scene now establishes that scene before frame selection and restores the prior scene/view layer afterward. With active scene at frame 7 + 0.25 and target initially at frame 1, Blender's render-pre handler observed the requested target scene/camera at frame 2. Both scenes' before/after state matched and the file hash stayed unchanged. Two attempts to induce a real engine failure by disabling view layers instead produced successful renders; that fixture is not evidence of a product failure or failed-render recovery. Automated failure/timeout tests remain explicitly simulated. Render completion now additionally requires Blender's FINISHED status and a PNG result.

## Video assets and common generation path

Install FFmpeg and FFprobe on PATH, or set PREVIS_FFMPEG / PREVIS_FFPROBE to existing executables. The app does not install tools or models. Setup checks actual executables and separately checks Blender, its MCP process/addon, local Comfy and Cloud access.

`video.mjs` owns process-registered frame stages, validated PNG writes, ffmpeg encoding and ffprobe verification. `video-blender.mjs` emits fixed bounded Python; the browser cannot submit scripts. `video-routes.mjs` serializes through the app queue and journals before Blender dispatch. Blender renders every selected inclusive integer frame once; output FPS sets playback speed independently from source FPS. Capture limits: even dimensions through 1280×720, 1–120 frames, rational FPS 1–60, silent H.264 MP4. Stages and failed outputs are retained. Completed/failed browser stages release memory slots; abandoned uploads expire after five idle minutes on the next video request. Uncertain Blender stages remain protected until explicit idle/settings reconciliation.

Browser export uses the saved camera/subject snapshot and scene version, not live recording variables. It samples at 24 fps, N=floor(recorded duration×24)+1, final sample (N−1)/24, encoded duration N/24. These values are displayed and retained; no claim of exact endpoint timing is made for off-grid recordings. Browser export offers 640×360 and 1280×720, up to120 frames; longer takes can be saved/replayed but fail preflight before rendering. A lazily reused WebGL renderer allocates the selected size with pixel ratio1; no 360p upscale is used. Supported delivery dimensions/FPS are validated by a shared browser/server contract. Legacy snapshots retain their original640×360 default. It needs a capable WebGL browser. The exact snapshot hash and request revision persist with each immutable version.

`workflows.mjs` validates versioned capability definitions, scalar mappings, declared outputs and current node/model choices. `generation.mjs` owns immutable request preparation, quotes, approval fingerprints, dispatch identity and output receipts. `backends.mjs` has separate local and Cloud transport. `generation-routes.mjs` attaches collected media idempotently, retaining the actual primary input binding and the current request shot separately. Browser UI and stdio MCP use the same project/server instance.

Use **Task → Workflow → Backend**, then inspect the selected backend. Built-ins and imported API graphs use the same execution code. Graphs remain unchanged in saved definitions; only explicitly mapped values change in a prepared clone. Imports expose scalar parameters, including existing LoRA filenames/strengths/chains. Select choices from live schemas; unavailable authored or selected values remain visible and fail validation. Save binding/quote persists edits; **Load saved shot settings** explicitly restores them after reload. Nothing inserts LoRA loaders or substitutes weights. The app cannot prove a LoRA’s semantic base-model compatibility merely from a filename/schema.

Local endpoints currently accept loopback HTTP origins only (localhost or127.0.0.1 plus port). Remote/LAN/HTTPS and custom authentication require a later adapter extension. Media inputs must be compatible upload-enabled filename fields (`image_upload`, `video_upload`, `audio_upload`). One asset per semantic role is supported; arrays, arbitrary custom data loaders, complex widget editors and external-reference uploads are not implemented. Assets currently come from saved previews, capture or collected results. Declared outputs support PNG, MP4, WebM, MOV and MKV (MKV via definition/agent); formats must match. Unsupported dependencies and media mappings fail explicitly. This is not universal Comfy compatibility.

Cloud uses `COMFY_CLOUD_API_KEY` from the server environment; local Partner Nodes use `COMFY_API_KEY`. Never save credentials in definitions, projects or exports. Cloud v1 remains deprecated: object_info, upload/image, prompt, jobs/{id}, queue and view are isolated in its adapter; redirect retrieval omits the API-key header. One explicitly approved Kling O1 video-edit journey now qualifies live upload, execution, collection and selected-output review; see video-checkpoint.md for timing and visual differences. Existing v1 integrations remain supported without a stated shutdown date, although behavior may change without notice. This private checkpoint retains v1, replaces deprecated history_v2 retrieval with job details, and defers broad v2 execution migration. Recheck support before public beta; see review-pack.md. Cloud/private local weights are validated separately, never inferred from local success.

A local server is not necessarily free. Only a small exact native media-operation schema is classified as known $0. Custom/model/API graphs and Cloud costs remain unknown unless separately qualified. Imported pricing is evidence, not authorization. Paid/unknown dispatch is disabled unless PREVIS_ALLOW_PAID=1 is explicitly configured, and then still needs the exact fresh quote fingerprint plus an explicit allowance acknowledging unknown costs. The allowance is an application approval record, not a provider-enforced billing cap. Any relevant graph, source, shot, prompt, setting, schema or backend change invalidates prepared approval. Preparing another request clears UI approval. No automatic retries.

Generation receipts survive restart and bind request UUID, graph/definition hashes, asset hashes, source provenance, shot revision, prompt, parameters, backend identity, schema and quote. An ambiguous dispatch never resubmits. Track known IDs; inspect backend history and use deliberate reconciliation if identity cannot be recovered. Closing a receipt records unknown outcome rather than cancellation. Results retain original media and report timing/size/audio changes without fitting. Compare a source video or still with each declared output and save review notes against the selected output ID. A first-frame workflow does not preserve supplied camera motion merely by accepting one frame.
