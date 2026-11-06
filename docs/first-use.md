# Hands-on review: scene to silent film

Install and launch using the [README](../README.md#quick-start) shipped with your version.
The verified candidate is **0.1.0-review.20261106.1**; later local documentation changes do not alter that frozen archive.
Use a new data folder and keep paid generation off. Allow 20–30 minutes for a
first scene; provider and hardware integrations are optional later sessions.
The [full Director guide](director.md) explains the detailed controls.

## 1. Start and save a scene — 5 minutes

Open **New scene**, or open **Mountain Trail** to create an editable starter copy.
Name the project and one shot so you can identify your edits. Add a prop with
right-click or **Shift+A**, then move/rotate/scale it with **G/R/S**. Select an axis
with **X/Y/Z**; Escape cancels. Reload the page, return home and reopen the project.

**Expected:** the name, object and transform survive reopening. Scene changes are
saved by the server, not just in browser storage. Starter files remain unchanged.
**Limits:** starters are a mixture of blockouts and previously generated examples,
not all finished films. Older media can remain visible after an edit; it is not a
new render of your modified scene. See [starter contents](../examples/starters/README.md).

## 2. Cast and reusable assets — 5 minutes

Select an object and edit its Cast Card description. Upload a non-private reference
image if useful; writing a card or uploading a local image needs no paid provider.
**Requesting** a cast image or design sheet is generation and requires setup/approval.
Under Appearance choose **Save to library**, give it a name, then in a second test
scene use **Library → Shared assets → Place**. Export an asset ZIP if you want to
review portability. See [library behavior](director.md#library-reuse-objects-across-projects)
and [model/rig import](import.md).

**Expected:** placed assets carry their descriptions and finished reference images.
**Limits:** library assets are separate from scene ZIPs; animation/shot images are
not included in a saved library object. Format conversion and rigged asset workflows
need their documented tools and have not been requalified in this install test.

## 3. Camera and capture — 5 minutes

Choose a shot; adjust distance, height, angle and lens. Press **C** to view the shot
camera and use **Preview** to inspect the move. Try a simple move preset before
custom keys. Optionally key an object with **I**, advance the playhead, move it and
key it again. Keep the first test short (about 3 seconds).

Verify that your browser actually uses hardware WebGL before substantial capture.
**Make blockout** records the local 3D shot; FFmpeg encodes the result. It does not
call an AI provider. Keep the browser open while interactive capture runs. Agent
capture instead requires the optional headless setup in the README.

**Expected:** a playable blockout matching the camera, motion and duration. After
changing blocking/camera, capture again; old clips do not change automatically.
**Limits:** hardware availability varies; stop and report an unknown/software renderer
instead of silently switching to CPU scene rendering. Headless does not mean software.
Phone HTTPS/pairing, gamepad recording and Blender import are separate, untested
integration exercises for this version. [Camera controls](director.md#3-shoot),
[phone](director-phone.md), [gamepad](gamepad.md), [Blender](blender-import.md).

## 4. Optional generation — separately approved session

For the initial review, inspect model inputs and quotes, or compare bundled takes.
Do not enable paid work just to complete this guide. With provider setup and a
separately approved budget, make a start still, inspect it, then request a video.
A clip-input model sees the blockout motion; a one-still model only sees that still
and approximates motion. A first/last-frame model constrains endpoints, not the
path between them. Read the input summary before dispatch.

**Expected:** a real provider result becomes a take; compare it against the blockout.
**Limits:** no provider run is qualified by the fresh-install test. Historical prices
are estimates; references, grading and retries can cost extra. Dry-run batch plans
are simulations of scheduling/cost, not generated media. No guarantee of identity,
framing or motion fidelity. **Avoid Edit region / masked edits**: an unresolved
acceptance race can overwrite concurrent changes, and recovery improvements remain
in draft PR #1. See [providers/costs](../README.md#providers-api-keys-and-costs),
[model behavior](director.md#camera-comes-from-the-blockout) and [regeneration](regeneration.md).

## 5. Cut, export and reopen — 5 minutes

In **Cut**, reorder shots, include/exclude them and adjust trims. Where several takes
exist, use **Compare takes**, then **Mark winner** or choose a version explicitly.
For a no-provider review, use your captured blockout or bundled media.
**Export film** creates an MP4. Open it in your normal player and check framing,
duration, order and trims. Export the editable project as `.previs.zip`, then import
it as a test copy and verify the scene and saved media survived.

**Expected:** a playable **silent** MP4 plus a separate editable scene ZIP.
**Limits:** a shot needs an existing captured/generated clip to export; an empty
scene is not automatically filmed. Cuts are hard cuts, without transition effects.
Film export is not an audio/music editor. Project ZIP is not a backup of your entire
shared library or account ledger. For workflow handoff, expect to recapture as needed.

## Feedback and what has actually been tested

Record the package version, browser/OS, step, expected/actual result and whether a
reload changed it. Use **Report a problem → Copy details**, inspect/redact the
preview and share it with Steven's existing Video Lab review conversation. Opening
a GitHub issue link transmits draft text to GitHub; nothing needs to be published
for this review. Keep bugs, usability friction and feature ideas distinguishable;
Linear and release direction will be updated together after your feedback.

[Version evidence and exclusions](review-version.md) separates fresh-install checks,
prior hardware capture evidence, simulated tests and untested integrations. A passing
build or doctor is not human acceptance of the complete UI journey.
