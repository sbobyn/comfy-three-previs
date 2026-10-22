# Standalone Comfy Previs — first local slice

This topic branch extends the existing three-vcam application from `b37ebb01d1232165f48a718673f9d6b4cf2836be`. It does not use Otter's server, editor, library, assistant, account, or launcher. Keep this branch private. Our code is now MIT licensed; inherited provenance caveats are listed in THIRD_PARTY_NOTICES.md.

## Run

Requires Node 22.12+ and pnpm 10. Install with `pnpm install --frozen-lockfile`, then `pnpm check && pnpm test`. `pnpm start` serves the built app at `http://127.0.0.1:5190`. `PORT` changes the port; `PREVIS_DATA_DIR` selects a project folder (default `.previs`, gitignored). Each folder is one project. No credentials or Comfy account are required.

The server locks its project folder. Graceful shutdown releases that lock. After a crash, the server checks the recorded PID and archives a dead process's lock automatically. A live owner is refused; never remove its lock. Atomic saves and revision checks protect against simultaneous UI/agent edits. Media are immutable PNGs. Keep the complete project folder to retain the project and renders.

## Blender MCP

Selected upstream: https://github.com/ahujasid/mcp-for-blender (formerly ahujasid/blender-mcp), package **2.2.2**, commit **5a3618fccb2d982d0dd61e7a1879912c3100073b**, MIT. Python >=3.10; upstream dependencies mcp >=1.26,<2 and httpx >=0.27. Use matching `addon.py` from that commit, installed using Blender's addon UI, and enable its server. Upstream supports a running GUI Blender, not background `-b` mode.

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

Open camera studio. Existing three-vcam rendering, flight, lens, smoothing, gamepad and phone-relay primitives are retained. The Previs adapter lets you move the existing subject, record resolved camera motion (up to 60 seconds, sampled at up to 24 Hz), and save a beauty PNG plus camera/subject/motion state as a shot. Reopen the saved camera/motion from the shot list. Reopening holds the saved capture pose; Replay motion plays the recorded motion, and the scrubber can inspect it. Captures are 640×360, 16:9; they represent the current operated camera, not a promised animation first-frame reference.

This is a fixed editable camera-study set, not a general world editor. Existing phone and gamepad code is present; no hardware qualification was performed. The default host is loopback and does not make phone LAN/HTTPS connectivity work automatically. Existing world-import, splat, text/image/video-to-world refinement and depth/pose rendering are not included.

## Project boundary and handoff

Version 1 stores project identity/revision/title; scenes with explicit `owner`; shots with source, scene/camera identity and timing; immutable renders; workflow bindings and transfer receipts, with references reserved for a later slice. Blender shots point to authoritative files; browser shots persist the small browser-set state and resolved motion. No automatic bidirectional scene synchronization is implied.

Download PNGs and the explicit asset handoff JSON from a shot. Rebinding preserves historical images with their original bindings; the manifest includes only previews matching the current binding. It includes source, timing, image URLs and supported pass. Only beauty stills are supported; requesting another pass is rejected, never substituted. This is an input manifest, not a Comfy workflow graph or executed job. The local passthrough path below supports explicit workflow binding and returned output review. Real AI video execution is a release requirement. This section describes the earlier transport baseline; see video-checkpoint.md for the corrected scope. Paid execution requires an exact quote and explicit approval.

## Bring your own agent

Start the app and point any stdio MCP client at `node <checkout>/server/previs/agent.mjs`, with `PREVIS_URL=http://127.0.0.1:5190`. Tools read project state, refresh Blender, add a Blender shot and render its preview. UI and clients use the same server, project revisions and operation queue. Use one app-owned Blender MCP process per Blender instance; direct external Blender MCP clients must be coordinated explicitly. No provider-specific agent implementation or config changes are needed.

## Inventory and licensing

- three-vcam: existing independent Three.js/Vite/TypeScript/ws camera prototype; no tracked source license. Private user-authorized continuation, no new license grant assumed.
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
