# First use and review routes

The procedural browser study set needs no Blender, account, credentials, external media or absolute path. Previs is MIT licensed, including the code inherited from three-vcam (see THIRD_PARTY_NOTICES.md). No private `.blend`, AI output or weights are bundled.

## Clean setup

Install Node 22.12+ and pnpm 10.18.0 separately, then run from a committed checkout:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm start
```

Open http://127.0.0.1:5190. The default project is `.previs`; `PREVIS_DATA_DIR=./my-project` chooses another folder and `PORT=5193` another port. One server owns each project. FFmpeg and FFprobe must already be on PATH for export; use **Setup → Check video tools** first. `PREVIS_FFMPEG` / `PREVIS_FFPROBE` may select existing executables. No global installation runs automatically.

Offline verification uses `pnpm install --offline --frozen-lockfile` with a populated cache; a new machine still needs its dependencies. Parent verification uses Node 22.23.2; the separate baseline packaging audit used Node 25.2.1. Keep `PREVIS_ALLOW_PAID=0`. Cloud validation needs your private `.env` key; authoring and saved playback do not. Missing credentials must stop validation, never trigger a test upload.

## Browser first — recommended

1. Choose **Start a three-second dolly**. This opens a new unsaved take with 1280×720 selected. The short-move picker also offers a crane. Existing shots stay intact. Move the subject before creating another short move if desired.
2. Replay or scrub. The preset is a planned delivery sequence: 72 poses at times 0…71/24 seconds, each frame lasting 1/24 second, exactly three seconds of video. Manual Record shot remains available. Takes over 120 export frames fail preflight; they are never shortened to fit.
3. Inspect **Delivery plan**: 640×360 or 1280×720, 16:9, fixed 24 fps, frame count and encoded duration. Guide aspects do not change delivery framing. Off-grid manual recordings disclose recorded end, final grid sample and N/24 duration.
4. **Save new shot & beauty → Reopen saved shot**. Subject, camera motion and delivery settings return. Reopening holds the saved capture pose; Replay starts at the recorded first pose.
5. Inspect **Export source**: the saved shot/revision is distinct from the live camera view. Live edits are omitted until saved as a new shot. **Export saved motion video** renders directly at the saved resolution, with live controls disabled. No 360p upscaling occurs. Changing delivery requires saving a new shot; existing capture versions remain immutable.
6. **Use this exact video in a workflow** carries the shot and asset IDs. Choose Task → Workflow → Backend, inspect live requirements, review inputs/prompt/parameters, then prepare. The player and prepared source must identify the same asset. Preparation uploads and submits nothing. A three-second Kling input currently has a $0.378 partner estimate, with the total unknown. Stop before Run.

640×360 fails Kling's declared minimum height; recapture at 720p or choose a compatible workflow. Browser authoring remains one study set, not a general scene editor. Phone/gamepad hardware remains unqualified.

## Blender first — existing scene

Follow [Blender MCP setup](standalone-previs.md#blender-mcp). Open and save your own `.blend`, enable/start its matching addon, then Connect / refresh. Select exact scene/camera/range → save shot → preview framing → render video → choose workflow/backend → review request. Blender owns content; Previs restores temporary settings and does not save the source file.

Saved bindings retain file identity. Moving a project preserves media playback, but live rendering needs the separately saved `.blend` and deliberate rebinding. Linked textures/assets remain Blender dependencies. The private sphere/ring demo is local review material, not a shipped template.

With Blender closed, saved shots, comparisons, notes and downloads still work. Reopen Blender, start its MCP addon, then Connect / refresh; no project restart is needed. An uncertain operation instead requires explicit idle/settings reconciliation. Connection loss never proves cancellation or triggers retry. Combined transfer copies cameras only into a new scene, omitting geometry/materials/lights; no round trip or Otter dependency is promised.

## Recorded comparison and safe copies

The workspace exposes only the explicitly identified completed Kling example when present. It never promotes a user's project or QA run by title/order. Clean installs explain that private media is absent; missing job links give a recovery instruction. Use the complete private review-project copy named in [review-pack.md](review-pack.md).

The retained Kling source is 72 frames / 3 seconds, its result 73 / 3.041667 seconds at 24 fps. Compare, inspect the historical request, reload notes and download originals. Selected comparison/job output is explicit in the URL and restores after full reload; missing sources/outputs never substitute another version. No new generation is needed. The local SD1.5 framewise review remains quality-rejected.

Before editing supplied examples, shut down their owning app cleanly, copy the whole project folder, and open the copy. Keep project.json, assets, renders and all receipts together. Never remove a live lock or copy it into another runtime. This checkpoint already uses a disposable copy and preserves the original seven assets and three reviews.

See the [temporal-model proposal](local-temporal-test.md) for separate download/execution approval. These review routes authorize no spending or provider uploads.
