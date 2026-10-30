# Comfy Three Previs guide

Build → Cast → Shoot → Generate → Cut. Open a starter on the home page to explore a finished example, or create an empty scene. The in-app **Guide** has interactive examples; opening it never edits a project or starts a generation.

![Home and starter projects](../public/guide/home.webp)

## 1. Build

Block out the people, vehicles, props and set with simple 3D objects.

- Right-click or press **Shift + A** to add an object, then name it.
- Drag empty space to orbit, right-drag to pan and scroll to zoom. Click selects; Shift-click adds to the selection; Shift-drag draws a selection box.
- **G / R / S** move, rotate and resize. **X / Y / Z** constrain an axis; type a number and press Enter to confirm. Escape cancels.
- **Ctrl/⌘ + G** groups selected objects. Click again inside a selected group to edit a piece.
- Press **I** to set a key at the playhead, move later in the shot, move the object and set another key. Preview to see the motion.

![Build: scene and object controls](../public/guide/build.webp)

## 2. Cast

Give objects cast images so their appearance carries between shots.

- Open an object and upload or drop an image, or request an image from its description.
- A design sheet shows the same design from several views. Pick the image you want to use for the object.
- The app gathers cast images for objects visible in the shot. Review the actual inputs before approving a request: models accept different inputs and counts.
- Make a still to check the shot's composition and appearance before making a video.

The in-app guide compares the grey blockout with this Breaking News still and shows the cast images used.

![Breaking News still](../public/guide/breaking-news-s2-still.webp)

## 3. Shoot

Pick a shot, frame its subject and preview the camera move.

- Set **distance, height, angle and lens**, then choose a move. The information button beside Move previews it.
- **Preview** plays the shot. **C** looks through the shot camera.
- **Fly camera** records a take using the keyboard, gamepad or phone. Keep the take to use it as camera keys.
- Keyboard flight: W/S forward/back, A/D sideways, Q/E turn, Space/Shift up/down, arrows aim, Alt slows, R records and Escape releases.

![Shoot: shot camera and settings](../public/guide/shoot.webp)

See [device controls](device-controls.md) for gamepad layouts and [phone setup](director-phone.md) for pairing over local HTTPS. The guide includes keyboard, gamepad and phone diagrams.

## 4. Generate

Make the grey blockout, then ask a video model to turn it into the shot.

- **Make blockout** captures the shot camera on your computer for free. If you change the shot, make the blockout again.
- Choose a video model. Some models follow a clip; others animate from one or two stills and do not see the full camera move.
- Review the inputs, where the model runs and the estimated cost. Paid work needs explicit approval; opening the guide never approves anything.
- Inspect the result against the blockout. A still is typically a few cents and a five-second video about a dollar, but the estimate for your selected model is the one to check.

[Watch the blockout](../public/guide/final-lap-s2-blockout.mp4) · [Watch the generated shot](../public/guide/final-lap-s2-generated.mp4)

### Stills that match the blockout

Storyboard stills (key frames) get three things so the image keeps the blockout's camera and blocking:

- **A guide frame (image 1)** rendered in a guide look: vehicles get bright headlights, a pale nose and windscreen and red tail lights; people get a pale face and shoes; a light ground grid, a light sky (dim indoors) and shadows near the shot. Labels never appear. The workspace viewport and blockout videos look as before.
- **The camera in words**, measured from the scene through the shot camera: move and moment, lens, shot size, camera height and angle, which side of the subject we see, the horizon, and each visible object's place, size, crop and heading ("nose pointing screen-right: a flat side profile… front end cut off by the right edge"). The composer shows it under the inputs.
- **Fewer cast images**: looks of objects actually in frame, one environment image and the previous shot's last still, labelled as design-only so their pose doesn't override the guide.

**FLUX 3** follows the blockout best and is the storyboard default; **Nano Banana 2.1** also follows it well, phrased as an edit of image 1, but tends to turn side profiles into chase angles. See `.evidence/stillmatch-20261030/RESULTS.md` in the integration checkout for the comparison.

**Match check.** With `PREVIS_MATCH_GRADER=gemini` (and paid generation on), each new key frame is graded 0–10 for camera and blocking by Gemini 3.5 Flash on Comfy Cloud (a few cents; about 20 s before the still attaches). The storyboard shows "matches blockout N/10", and a batch with `retryWeakMatch: true` redoes a still graded below 5 once with FLUX 3 (or Nano Banana 2.1 if it was FLUX 3), charged to the batch budget. Without the flag a free local edge-and-light score is stored with `rough: true`; it did not track camera match on hand-labelled stills, so it is never shown as a match score and never triggers a retry.

![Generate: review inputs and estimate](../public/guide/generate.webp)

## 5. Cut

Choose the versions, order and timing of the film.

- Drag shot rows to reorder them.
- Choose a version for each shot and trim its in/out times.
- **In cut** includes or leaves out a shot. Compare blockout and generated video by dragging the seam or using the arrow keys.
- Preview the sequence, then **Export film** to write an MP4 in shot order. Project export separately keeps the editable project and its media together.

![Cut board: order, version, trims and export](../public/guide/cut.webp)

## Other ways to work

You can direct the same project through Claude using the MCP connector; see the [README setup](../README.md#direct-scenes-from-claude-mcp). Phone aiming requires local HTTPS and a trusted certificate. The public demo is read-only; generation needs a local installation.

## Guide media and maintenance

The shipped examples live in `public/guide/`; `manifest.json` records their source project, shot, asset and capture time. URLs in the app respect the deployment base, including GitHub Pages. See [guide integration and capture](guide-integration.md) for the capture command and the module APIs.

Older review packs and checkpoints are historical engineering notes, not current user instructions. See [the historical document index](history/README.md).
