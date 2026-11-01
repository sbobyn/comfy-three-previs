# Comfy Three Previs guide

Build → Cast → Shoot → Generate → Cut. Open a starter on the home page to explore a finished example (cast images, design sheets, stills, a video per shot and a cut, all already made; if the blocking changed after they were made, the starter says so and marks those videos "older"), or create an empty scene. The in-app **Guide** has interactive examples; opening it never edits a project or starts a generation.

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
- Set a budget so a busy day cannot run away: `PREVIS_BUDGET_CAP_USD` (account, per month) and `PREVIS_BUDGET_PROJECT_CAP_USD` (per project). Paid work over a cap is refused before it is sent, the Jobs panel shows what is left, `pnpm usage:report` shows what was actually billed and `pnpm usage:settle` compares it with the ledger (README, Configuration). Estimates include reference images and the paid grader, and reservations add `PREVIS_BUDGET_MARGIN` (10% by default); a dry-run batch shows each part.

[Watch the blockout](../public/guide/final-lap-s2-blockout.mp4) · [Watch the generated shot](../public/guide/final-lap-s2-generated.mp4)

### Stills that match the blockout

Storyboard stills (key frames) get three things so the image keeps the blockout's camera and blocking:

- **A guide frame (image 1)** rendered in a guide look: vehicles get bright headlights, a pale nose and windscreen and red tail lights; people get a pale face and shoes; a light ground grid, a light sky (dim indoors) and shadows near the shot. Labels never appear. The workspace viewport and blockout videos look as before.
- **The camera in words**, measured from the scene through the shot camera: move and moment, lens, shot size, camera height and angle, which side of the subject we see, the horizon, and each visible object's place, size, crop and heading ("nose pointing screen-right: a flat side profile… front end cut off by the right edge"). The composer shows it under the inputs.
- **Fewer cast images**: looks of objects actually in frame, one environment image and the previous shot's last still, labelled as design-only so their pose doesn't override the guide. The shot's subject and the cast its description names (@handle) always send their look while in frame, even far away: a hero car 70 m down the track is still the hero.
- **The moment**: a start still is told it shows the first instant (the action is only beginning), an end still the last. The shot text describes the whole action and on its own pulls a start still to the climax.

A still remembers the blocking it was made from. When the shot changes (camera, timing or any object's position), a batch makes that key frame again rather than handing a video the old layout; the plan says "Blocking changed since its key frame; made again". Stills made before this was recorded count as changed when the shot's blockout clip is newer than them. Uploaded frames are always kept.

**Exact frames.** A blockout is 24 fps: a 5 s shot has frames 0–119, and **End** is frame 119 (4.958 s), the last frame the clip shows, not 5.000 s. The storyboard playhead snaps to a frame (**+ Still at frame 60**), and a still records its frame, is made from that frame's guide and is graded against it. Stills made before this show **≈frame** (an older End was made at the shot's full length). The track marks the key frames: **S**, **E** and ◆ for each in-between frame, green when current, amber when the shot has changed since (out of date stills are never sent), outlined when there is no still yet.

**Key frame roles.** Start → end models get the newest take at the first and last frame. **Use as start / Use as end** on a mid-shot still makes it the start or end instead; it is marked with its frame and goes out of date with the shot like any still. **Pin as in-between** sends a still as a timed in-between frame, offered only for a model that takes one: of the built-in models, only **Kling 4.0 · start → end stills** (up to 8, from the Comfy Cloud node's `middle_frames` input). Kling spaces them evenly, so the storyboard and the quote show where each lands and which frames land exactly. Other models take a start and an optional end frame and list pinned in-between frames as not sent. Claude does the same with `previs_director_keyframe` (see a frame's guide, make a still there, pin it, list what a model takes).

**FLUX 3** follows the blockout best on side profiles and people and is the storyboard default; **Nano Banana 2.1** also follows it well, phrased as an edit of image 1, but tends to turn side profiles into chase angles. On head-on and going-away vehicles it is the other way round: FLUX 3 reversed a car or split the field with a wall (graded 5), and Nano Banana 2.1 matched (9); GPT Image 2.5, the final tier's still model, also matched (9). See `.evidence/stillmatch-20261030/RESULTS.md` and `.evidence/hero-20261030/HERO.md` in the integration checkout.

**Match check.** With `PREVIS_MATCH_GRADER=gemini` (and paid generation on), each new key frame is graded 0–10 for camera and blocking by Gemini 3.5 Flash on Comfy Cloud ($0.01 reserved per graded still, an upper bound, counted in the still's quote, reservation and batch estimate; about 20 s before the still attaches). The storyboard shows "matches blockout N/10", and a batch with `retryWeakMatch: true` redoes a still graded below 6 once with FLUX 3 (or Nano Banana 2.1 if it was FLUX 3), charged to the batch budget. Without the flag a free local edge-and-light score is stored with `rough: true`; it did not track camera match on hand-labelled stills, so it is never shown as a match score and never triggers a retry.

![Generate: review inputs and estimate](../public/guide/generate.webp)

### Models

List prices are Comfy Cloud estimates from each node's live price badge (checked 2026-10-30). The app quotes every request before you approve it; reference-image surcharges and Cloud overhead are not included.

**Video** (start-still models animate the shot's Start still; start → end models also pin its End still, and without one fall back to the start-only model at the same price):

| Model | Comfy node | Takes | Clip lengths | ≈ List price |
|---|---|---|---|---|
| LTX 2.5 Fast (draft) | `LtxApi25ImageToVideo` | start still | 2–10 s | $0.13/s (720p) |
| LTX 2.5 Pro | `LtxApi25ImageToVideo` | start, or start → end | 2–10 s | $0.17/s (720p) |
| Seedance 2.5 | `ByteDance2ReferenceNodeV2` (start still as reference image 1; may reframe), `ByteDance2FirstLastFrameNode` | start (as reference), or start → end | 4–10 s | $0.33/s (720p, token-billed) |
| Kling 4.0 | `Kling4ImageToVideoNode` | start, or start → end | 3–10 s | $0.22/s (720p) |
| Veo 3.1 | `Veo3VideoGenerationNode`, `Veo3FirstLastFrameNode` | start, or start → end | 4, 6 or 8 s | $0.20/s (720p, no audio) |
| MiniMax Hailuo H3 | `MinimaxHailuo03FirstLastFrameNode` | start, or start → end | 4–10 s | $0.13/s (768p) |
| Wan 2.7 | `Wan2ImageToVideoApi` | start, or start → end | 2–10 s | $0.10/s (720p) |
| Seedance 2.5 · edit | `ByteDance2ReferenceNodeV2` (edit) | blockout clip | clip length, 4–30 s | $0.40/s (720p) |
| Kling O1 · edit | `KlingOmniProEditVideoNode` | blockout clip | 3–10 s | $0.13/s (720p) |
| Wan VACE 1.3B (local) | `WanVaceToVideo` | blockout edges | as set | local GPU |

**Images** (looks, design sheets and stills; "refs" counts cast images besides a still's blockout guide):

| Model | Comfy node | Refs | ≈ List price |
|---|---|---|---|
| Flux.2 [pro] (draft) | `Flux2ImageNode` | 7 | $0.03 |
| Flux.2 [max] | `Flux2ImageNode` | 7 | $0.07 (+ $0.03–0.24 for refs) |
| FLUX 3 | `Flux3ImageNode` | 9 | $0.07 |
| Flux 1.1 [pro] Ultra | `FluxProUltraImageNode` | guide only | $0.06 |
| GPT Image 2.5 (Sunburst, high) | `OpenAIGPTImageNodeV2` | 9 | $0.06–0.08 (+ ≈ $0.015 per ref) |
| Seedream 5.0 Pro | `ByteDanceSeedreamNodeV3` | 9 | $0.045 |
| Nano Banana Pro | `GeminiImage2Node` (refs padded and batched) | 9 | $0.16 |
| Nano Banana 2.1 / 2 | `GeminiNanoBanana2V2` | 9 | $0.05 / $0.08 |
| Local checkpoint | `CheckpointLoaderSimple` | guide only | local GPU |

Batch tiers: **draft** uses Flux.2 [pro] images and LTX 2.5 Fast video; **final** uses FLUX 3 looks and sheets, GPT Image 2.5 stills and Seedance 2.5 · edit video, which follows the blockout clip (set in `shared/tiers.mjs`). A batch sends every shot's stills before design sheets, so videos start as early as possible.

### Camera comes from the blockout

The blockout is the source of truth for camera motion. A video prompt never describes the move ("truck right", "low angle"); it carries one line that names the input to follow, plus lens and filter hints. Movement and cut tags are notes for you and stay out of the prompts.

Each video model takes its camera from one of three sources, shown on the Video-model card, the batch plan and each version in Cut:

- **Blockout** (Kling O1 edit, Seedance 2.5 edit, Wan VACE): the blockout clip itself is the video input, so your move is the camera. The start and end stills follow as the look, then the cast images. A blockout that is older than the shot is made again first. The final tier uses this.
- **Start → end stills** (LTX 2.5 Pro, Seedance 2.5, Kling 4.0, Veo 3.1, MiniMax Hailuo H3 and Wan 2.7 start → end): the model moves between stills made from the blockout's first and last frames. It only approximates the move in between.
- **One still** (the start-still models, including LTX 2.5 Fast in the draft tier): the model animates a single still and guesses the camera. The card marks this as approximate.

Which blockout model, from the three launch hero shots (a head-on pass with a whip pan, a dunk with a push-in, a slow orbit; `.evidence/hero-20261030/HERO.md`):

- **Seedance 2.5 · edit** held the blockout camera on all three, including a pass 3 m from the lens, and is the final-tier default. It needs a 4–30 s blockout clip (a shorter one is refused at plan time) and returns a clip about 0.3 s shorter than the input.
- **Kling O1 · edit** is a third of the price but dropped the fast pass's camera (it became a side-on tracking shot) and started a dunk from its look still instead of the run-up. Use it for slower moves and drafts.
- **LTX 2.5 Pro start → end** is the cheap control: it made a strong car-ad pass between two matched stills, but the eagle's wings flailed and the dunk jumped between its two stills.

Write the description as action and look only ("@comfy-car dives to the inside and blows past to take the checkered flag by a full car length"); the blockout supplies the camera, and the stills the composition.

## 5. Cut

Choose the versions, order and timing of the film.

- Drag shot rows to reorder them.
- Choose a version for each shot and trim its in/out times.
- **In cut** includes or leaves out a shot. Compare blockout and generated video by dragging the seam or using the arrow keys.
- **Compare takes** opens the shot's takes: every video it has made (Take 1 is the oldest), and its stills at each moment. Tick 2–4 to see them side by side, with the blockout as an optional reference lane. Videos play, pause, scrub and step frame by frame together (Space, ← →); a shorter take holds its last frame. Each take shows its model, settings and seed, cost, inputs and grades. Layout is graded only when the paid still grader ran; identity is not assessed; timing compares frame counts with the blockout. **Only differences** keeps just what differs. **Mark winner** makes a take the one the cut and film export play, and a newer take never replaces it. Choosing a take in the version menu does the same. No take is deleted. Through Claude: `previs_director_list_takes` and `previs_director_set_winner`.
- Preview the sequence, then **Export film** to write an MP4 in shot order. Project export separately keeps the editable project and its media together.

![Cut board: order, version, trims and export](../public/guide/cut.webp)

## Library: reuse objects across projects

Save a cast member or a set piece once and place it in any project on this computer.

- Select the object and choose **Save to library** under Appearance. Give it a name (its @handle) and a few tags. A group saves with everything inside it.
- The asset keeps the description, style notes, primary cast image and each finished design sheet. If the object shares another object's image, that image and description are copied into the asset. Animation and shot images are left behind.
- In another project, open **Library → Shared assets** and choose **Place**. The object lands 2 m in front of the shot's subject, selected, and Undo removes it. Through Claude: "put @red-racecar at the start line". An @handle names an object in the scene when one has it; otherwise Claude looks in the library.
- Saving the same object again, or a placed copy of it, makes the next version; older versions stay in `library/assets/<id>/versions/`. Nothing in the library is deleted by the app.
- **Export** writes one `<handle>.previs-asset.zip` to share. **Import asset…** in the Library dialog, or **Import…** on the home page, adds one to your library. An asset you already have with the same content is left unchanged; new content becomes its next version.

## Other ways to work

You can direct the same project through Claude using the MCP connector; see the [README setup](../README.md#direct-scenes-from-claude-mcp). A shot built in Blender can become a shot's blockout, with its camera, objects and rendered frames; see [Import a Blender shot](blender-import.md). Phone aiming requires local HTTPS and a trusted certificate. The public demo is read-only; generation needs a local installation.

## Guide media and maintenance

The shipped examples live in `public/guide/`; `manifest.json` records their source project, shot, asset and capture time. URLs in the app respect the deployment base, including GitHub Pages. See [guide integration and capture](guide-integration.md) for the capture command and the module APIs.

Older review packs and checkpoints are historical engineering notes, not current user instructions. See [the historical document index](history/README.md).

### Posing blockout characters

Bundled players, anchors and operators have simple rigid-part joints; eagles have wings, feather tips and a tail,
elk have a neck pivot, and race cars have steering, wheels and a sprung body. These are low-poly animation guides.
Use `previs_director_animate` or agent `set_keyframes` edits to pose them:

```json
{"object":"Comfy guard","keys":[
  {"t":0,"pose":{"armR":[-25,0,0],"forearmR":[-45,0,0]},"ease":"smoothstep"},
  {"t":1,"pose":{"armR":[-150,0,0],"forearmR":[-12,0,0]}}
]}
```

`pose` maps joint names to local XYZ degrees. Supported names are `body`, `head`, `armL/R`, `forearmL/R`,
`thighL/R`, `shinL/R`, `wingL/R`, `tipL/R`, `tail`, `steerL/R`, and `wheelFL/FR/RL/RR` (expand `L/R` to `L`
or `R`). Unsupported joints on a particular model do nothing. Pose angles blend without wrapping, so a wheel
can turn through 720°. An empty pose `{}` returns all joints to rest; missing joints in a pose mean rest.
Omitting pose from a transform key leaves the pose track alone. `update_entity` can also set a static `pose`
(`null` clears it). The keyframe tools accept at most 64 keys, in scene seconds, shared across shots.

An outgoing key's `ease: "linear"` gives constant segment speed; `"smoothstep"` eases to and from rest without
overshooting. Omit it to keep the existing position spline. Pose, rotation and scale default to linear blending.
Use linear keys for a moving car or the middle of a jump, and smoothstep for a hand settling onto the desk.
The viewport, thumbnail stills, browser video capture and headless renderer evaluate the same pose. Pose keys
and the posed model ID change the blocking signature, so earlier stills/videos become out of date.
