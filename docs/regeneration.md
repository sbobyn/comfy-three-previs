# Regenerating only what changed

Every blockout, still, cast image and video records what it was made from. When you change something, video-lab works
out which outputs it really affects, says why, and a batch makes only those again. It works like ComfyUI's
cache: each step's inputs are hashed, and a step with the same inputs as a kept output is skipped.

Code: `shared/regen.mjs` (keys, verdicts, reasons) and the blocking section of `shared/director.mjs`
(`blockoutManifest`, `blockoutObjects`). The browser, the batch planner (`server/previs/batch.mjs`) and the MCP tools
all call these functions, so they always reach the same answer.

## What each output is made from

An output stores a **manifest**: `{ v: 1, type, key, parts, ctx }`. `parts` has one short hash (or a readable id) per
input, and `key` is the hash of all of them. When the key no longer matches, comparing the parts gives the reasons.

| Output | Parts |
|---|---|
| **Blockout** | `camera`: the camera pose in every encoded frame (24 fps); `timing`: length and start; `environment`: the stage preset; and for each object the frames can show, `move:<id>` (its place in every frame) and `form:<id>` (shape, size, colour, model, and any other field it has) |
| **Cast image** (look) | `card`: the object's description and style notes; `prompt`: its auto look prompt, unless the prompt was typed by hand; `model`; `params` (aspect); `refs`: the images it was sent |
| **Still** | the blockout's parts; `moment` (start, end or seconds); `prompt`: the composed image prompt; `look:<id>` and `card:<id>` for each object in the cast; `preset:<axis>` for each look preset set (docs/look-presets.md); `base`: a look variant's base still; `model`; `params`; `seed` |
| **Video** | the blockout's parts; `source` (camera source); `prompt`: the composed video prompt for that camera source; `preset:<axis>` for each look preset set; `still:start` / `still:end` for models that take stills; `look:<id>` and `card:<id>` for models that take cast images; `model`; `params`; `seed` |

Notes:

- **Only what the frames can show counts.** An object counts for a shot if its bounding sphere, or the shadow it can
  cast on the ground, enters a slightly widened frustum (15% margin) in any encoded frame, at any size. The camera
  target always counts, and so do the parents and children of every object that counts. Moving something the shot
  never shows changes nothing. Animation outside the shot's frames changes nothing either: positions are sampled
  frame by frame. When unsure, an object is included.
- **Fields are hashed generically.** Only fields that cannot change a frame are left out: name, description, style
  notes, cast images, design sheets, library provenance and the parent link (positions are stored in world space).
  A field added later (imported meshes, rig clips, splats) is hashed automatically.
- **Seed is the seed setting.** A pinned seed for the shot and model, or `random`. Drawing a new random seed is not
  a change.
- **Prompt is the shot's prompt.** It is the composed prompt with section overrides, or your whole-prompt edit. A
  one-off text typed for a single request is judged by the shot's saved prompt at the time.
- **The previous shot's still** is sent to a still model as a continuity reference, but it is not part of the key.
  Including it would make every later shot out of date whenever an earlier one changes.
- **Not in a key:** design sheets (a batch still plans them as before), timed in-between key frames, and the
  reference legend and length fitting that are specific to each model.

## Verdicts and reasons

`explainStale(project, node, opts)` returns one of these states, together with `reasons`, a list of
`{ code, part, text, entityId? }`:

| State | Meaning |
|---|---|
| `fresh` | The kept output matches its inputs. |
| `stale` | Something it was made from changed. |
| `pinned` | You accepted it as it is. It counts as current, but it still reports what changed. |
| `uploaded` | An image you supplied. It is never out of date. |
| `missing` | Not made yet. |

These are the reason codes. The display text is in brackets.

- `camera` (camera changed)
- `timing` (timing changed)
- `environment`
- `object-moved` ("Eagle moved")
- `object-changed` ("Eagle changed (shape, size, colour or model)")
- `object-entered` ("Eagle is now in frame")
- `object-left`
- `moment`
- `prompt`
- `cast-card-changed` ("description of Eagle changed")
- `look-changed` ("cast image of Eagle changed")
- `still-changed` ("start still changed")
- `look-preset` ("Time of day preset changed (Night → Dawn)"; never blocking)
- `base-still` ("base still changed", a look variant)
- `model` ("model changed (flux-2-pro → flux-3)")
- `params`
- `seed`
- `source`
- `refs`
- `card` and `prompt` on a cast image
- `upstream`, `forced` and `unrecorded`, which are batch only (see below)

**Blocking versus inputs.** A still or video that is stale for a blocking reason (camera, timing or an object in
frame) is never sent to a video model, as before. A still whose only changes are to its prompt, cast images, model
or seed is still sent: the badge reads **inputs changed**, and a batch makes it again. The blockout gate
(`blockoutStale`, which decides whether a blockout must be remade before a video) uses the blocking parts only.

## The batch: only what changed

`planBatch` (and `previs_director_batch_generate`) gives each node a verdict for the model the batch would use.

- **Skipped:** a node whose kept output is current (`Already rendered`, `Key frame already exists`,
  `Video is current`), or pinned (`Pinned: kept as is`). A cast image that is current gets no node, as before. A
  video is skipped when any take of the shot matches the key.
- **Planned with reasons:** a node whose output is missing, or stale (`reasons` say why).
- **Downstream:** when a node replaces an out-of-date output, everything that depends on it is planned too. That
  covers a new cast image → stills and reference-image videos, a new still → videos that take stills, and a new
  blockout → videos (reason `upstream`). Pinned outputs stop this. A first output, such as an object's first cast
  image, fills a gap and leaves alone what was made without it.
- **`force`:** `true` remakes every node. A list of node ids remakes just those: `video:<shotId>`,
  `still:<shotId>start`, `still:<shotId>end`, `still:<shotId>@<seconds>`, `look:<objectId>`, `sheet:<objectId>`.
  Blockouts are always remade when their blocking changes, and never otherwise.
- **The model is an input.** Switching a batch from draft to final remakes the stills, videos and cast images that
  recorded a manifest with the draft models. Pin a take to keep it.
- **Dry run.** `batch.regen = { remake, total, kept, pinned, paid }`, and the first event reads "N of M need
  regenerating, ≈ $X". Every planned node carries `reasons`, and every kept node carries a `note` (and `pinned`).

Nothing is deleted. A remake adds a new take; earlier takes stay in the Take lab. A cast image that is made again
becomes the primary image, and the old one stays.

**Masked region edits** are a separate path: they derive from a parent video take (fixed mask + crop + edit prompt),
not from the current shot’s ordinary video key. An accepted edit inherits the parent’s blocking staleness as “Edited
from an older take” and is never chosen as the implicit newest cut; mark it winner or set the clip deliberately. A
batch does not retry a masked edit with the ordinary shot-video preset.

## Where you see it

- **Badges.** Hover a badge to see what changed and what it affects. That covers **Blockout changed** (shot card,
  Cut rows, model inputs, Make blockout), **out of date**, **inputs changed** and **pinned** (storyboard stills),
  **generated · older** (Cut), and **Inputs changed** (Take lab).
- **Take lab.** **Pin** accepts a still or video take as it is; **Pinned** unpins it. The undo stack records both.
- **Object panel.** **What depends on this** says how many shots, stills and videos moving the object would make out of
  date, and how many its cast image or description feeds.
- **Cut → Quote selected.** Each row says **New**, **Changed: …** or **Up to date: a take already matches**, and the
  header says "N of M need regenerating". **Quote only what changed** quotes just those rows.
- **Jobs panel.** A batch row shows "N of M need regenerating · K kept"; open it to see each node and why.
- **MCP.** `previs_director_regen_status` lists what is out of date and why, per shot. With `object`, it also says what
  depends on that object. `previs_director_pin_output` pins and unpins. `previs_director_shot_inputs` has `upToDate`.
  A `previs_director_batch_generate` dry run lists `reasons`, `note` and `pinned` per node, plus a `summary` line. The
  edit op is `{op:"pin_output", id, pinned?}`.

## Where keys are recorded

| Output | Recorded by | Stored at |
|---|---|---|
| Blockout | `recordRender` (server/previs/director.mjs), computed from the saved project, and only when the capture's signature matches it | `shot.render.regen`, `asset.source.regen` |
| Still, cast image | refgen `prepare`, computed from the project when the request is quoted | `job.regen` → `reference.generated.regen` |
| Video | the caller that binds it (batch and MCP: `videoPreparer`; browser: `src/director-videogen.ts`) sends `regen` with `/api/generation/bind` | `binding.regen` → `asset.source.regen` (in `syncResults`) |

`cleanManifest` validates a manifest from a request body (size and characters) before it is stored.

## Migration note (older projects and starters)

Nothing needs migrating. Old outputs keep working as they are.

- **Old outputs have no manifest,** only the single whole-scene `signature` (`shotSignature`). They are judged by
  the old rule, `stillStale` / `videoStale` / `blockoutStale` through the signature. Any change to any object
  outside the description and cast images marks them out of date, even off screen. Their reason reads "the camera,
  timing or scene changed since it was made (older output: no per-input record)".
- **New outputs record both** a manifest and the signature, so older builds still read them. When both are present,
  the manifest decides.
- **In a batch,** an old still is kept when the old rule says it is current, whatever its model. An old video is
  kept only when its blocking is current and its recorded `definitionId` maps to the batch's model. Otherwise it is
  made again with the reason `unrecorded`. Before this change, videos were always made again.
- **To move a shot onto the new keys,** make its outputs again (or remake the blockout). Pinning works on old
  outputs too.
- **Starters** ship signatures only. The export keeps `signature` and drops `regen`, so a starter copy is judged
  exactly as before, and "a copy reports nothing as out of date" still holds. A bundle that carried manifests would
  need its object ids remapped in `instantiateStarter` first. That remapping is not built yet.
- **`shotSignature`** is unchanged and still mirrored in `src/director-capture.ts` (tests/headless.test.mjs). It is
  still sent with every capture, which is how the server knows the capture saw the saved blocking.
