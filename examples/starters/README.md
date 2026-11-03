# Starter projects

The home page's **Starters** row offers these nine projects (plus **New scene** for an empty stage): four finished
starters, then five blockout starters for testing cameras, devices, transitions and looks (below).
Opening one creates a new project from its snapshot, so the starter itself never changes.

```
examples/starters/
  index.json                  # { "starters": [slug, …] } — home-page order
  <slug>/starter.json         # the snapshot
  <slug>/media/refs/<id>.webp # object looks, design-sheet views and boards, shot stills
  <slug>/media/refs/<id>.glb  # imported models (the blockout starters' mannequin), copied byte for byte
  <slug>/media/assets/<id>.mp4  # each shot's blockout clip and chosen video
```

## Blockout starters (2026-11-02)

Five starters open with a blockout clip per shot and written Cast Cards, and no generated media: making the cast images,
stills and videos is the test. Look Lab is the exception: it also ships a start still per variant and twelve videos (below). They were built through the MCP tools on a private server (paid work off) by
`scripts/starters/author.mjs` and its scene modules in `scripts/starters/scenes/`; the bundles here remain the source of
truth. Every object is original, nothing carries a brand, logo, sign or lettering (each project style says so, and every
shot has the `no logos or lettering` filter tag, which a video prompt always keeps), every shot is 4–5 s with its camera
keyed in the blockout, and descriptions give action, not a camera move.

People are an **original procedural mannequin** (`scripts/starters/mannequin.mjs`, MIT): an imported, rigged GLB with
Walk, Idle and Wave clips, a dark face visor and dark shoes so facing reads at any distance. They exercise model import,
clips, poses, IK and the neutral stand-in. Buildings, rocks, chairs, tables, lamps and generic cars are the built-in proxy
shapes; trees, terrain and the lake use the bundled meshes.

| Starter | Shot | s | What it tests |
|---|---|---:|---|
| **Mountain Trail** | Ridge reveal | 5 | Aerial reveal: low behind a moraine, rising over it to the valley, the lake and the hiker. |
| | Slope dive | 5 | FPV dive down the south slope's fall line, levelling off behind the hiker. |
| | Trail track | 5 | Knee-high tracking shot beside the hiker on the dirt trail (Walk clip). |
| | Valley wide | 5 | Locked-off 24 mm wide of the whole valley. |
| **City Blocks** | Drone rise | 5 | Vertical rise between façades, holding on a commuter. |
| | Car track | 5 | Street-level front three-quarter track with a generic red hatchback. |
| | Rooftop orbit | 5 | 140° orbit around a figure at the edge of a 48 m tower (Idle clip). |
| | Pedestrian follow | 5 | Over-the-shoulder follow as the commuter steps off the kerb onto a zebra crossing. |
| **Camera Moves & Transitions** | Locked-off … Tilt up | 4 each | All 12 `MOVES` presets on the same four seconds (the keeper stands still), so only the camera differs. |
| | Dolly zoom (vertigo) | 4 | Back 5 → 12 m while the lens goes 24 → 58 mm: the keeper holds size, the tower looms. |
| | FPV fly-through | 4 | Low over the water, through a sea arch, up the cliff to the keeper. |
| | Handheld | 4 | Deterministic few-centimetre operator wobble (64 keys). |
| | Push-in + lens change | 4 | Push in with a 35 → 50 mm lens change. Focus is not modelled; "rack focus" is a lens note only. |
| | Whip pan A · out / B · in | 4 + 4 | Whip-pan-to-whip-pan: A whips off the waving keeper, B lands mid-whip on the boat. |
| | Match cut A · lantern / B · buoy | 4 + 4 | Match cut: A ends on the round lantern centred, B opens on the round buoy at the same place and size. |
| | Cut on action A · wide / B · close | 4 + 4 | Cut on action: A cuts as the door swings; B overlaps 0.2 s and follows the keeper in. |
| | Wipe A · foreground rock / B · reveal | 4 + 4 | In-camera foreground wipe: one constant-speed truck behind a rock, split at the moment it fills the frame. |
| **Look Lab** | Summer day · base … Claymation (stronger) | 4 × 34 | One blockout, thirty-four looks (below). |
| **Two-Hander** | Master; Over Ben · on Ada; Over Ada · on Ben | 5 each | Dialogue coverage on the 180° line: 32 mm master, 50 mm over-the-shoulders; sit pose plus keyed gestures. |
| | Insert · cup | 4 | 70 mm insert; Ada's hand reaches her cup by IK. |
| | Close-up · zoom on Ben | 4 | Lens change within the shot, 50 → 70 mm. The barista is sent to models as the neutral grey stand-in. |

**Flying your own take.** Mountain Trail and City Blocks are laid out for **Fly camera** with a keyboard, gamepad (Drone RC
Mode 2) or phone: the valley floor is about 200 m of open meadow with the hiker crossing it on a clear path, and the city
has 12 m streets, a plaza and a 48 m roof. Open a shot, press **Fly camera** and record; at the default 6 m/s (×2.5 with RB)
a 5 s take covers 30–75 m. Keep the take to replace the shot's camera keys.

**Transitions.** The Cut joins shots with hard cuts only: film export concatenates them and the sequence player switches
clips. A dissolve, a whip-pan blur, a wipe or any other transition effect is not supported. What a blockout *can* do is
craft the transition into the shots themselves, as the pairs above do:

| Transition | Craft in the blockout | In the Cut |
|---|---|---|
| Hard cut, cut on action, match cut | Yes: overlap the action across the pair; frame matching shapes at the same place and size | Hard cut (supported) |
| Whip pan to whip pan | Yes: end A and start B mid-whip, both fast | Hard cut; no motion-blur bridge |
| Foreground wipe | Yes: pass the camera behind a foreground object and split there | Hard cut on the covered frame |
| Cross-dissolve, dip to black, graphic wipe | No | Not supported |

The pairs' `cuts` style tags (`whip pan to whip pan`, `match cut`, `cut on action`, `in-camera foreground wipe`) note the
intent; like all movement and cut tags they stay out of the prompts.

**Look Lab variants.** Thirty-four shots share one camera, start, duration and scene, so they have the same blocking
signature; the base variant and the twelve with videos ship a blockout clip, and generating any other variant makes its own (identical)
blockout first. Each
variant differs only in its prompt sections (Prompt sections in the shot, or `previs_director_set_prompt_section`), for
both video and image prompts: the world (`world`, the season or time of day), the look (`style`), the walker's Cast Card
text (`obj:<walker>`, clothing or a different person) and the format line (`intro`, for the stylised looks). The variants
are summer day (base), night, spring, fall, winter, a yellow raincoat, a formal suit, a different person (an older man),
anime, claymation, a stylised 3D animated feature and watercolour, then (v2) dawn, golden hour, blue hour, harsh noon, fog,
heavy rain, a snowstorm, overcast, cherry blossom, peak autumn, an elderly woman, a teen, a cyclist walking a bike, a dog
walker, a couple, a heavy-set South Asian man, 1950s, cyberpunk, workwear and formal evening wardrobe, and a stronger
anime and claymation. Every v2 variant sets its own `style` ending in "No logos, badges, car emblems, signage or readable
text." Every variant's video prompt fits the 600-character cap.
For the anime, claymation, 3D animated and watercolour variants (and v2's stronger anime and claymation) the camera line repaints the blockout in that medium
instead of photoreal (`lookMedium`, docs/director.md).

**Look Lab media (paid hybrid, 2026-11-02).** Every variant ships one start still: GPT Image 2.5, made from the shared
blockout frame and screened for no logos, brands or readable text, the blockout framing and the variant's look. Four
variants also ship a Seedance 2.5 edit of their own blockout clip, in the cut: **Night**, **Winter**, **Anime**
and **Claymation**. The other eight have a still only; a final-tier batch makes their end stills and videos. Cost
at list prices was $9.15: 13 stills, $1.25, at $0.094 each (two at $0.111, sent the previous shot's still as well) and 5
videos, $7.90, at $1.58 each. Billing settled at about $7.11 ($1.01 stills, $6.10 videos). Two takes were made and not
used: a claymation still retake, which looked more 3D animated than clay, and the first anime video, which dropped the
parked car and brought the walker to the lens far ahead of the blockout. The anime video still drops the parked car. A few
cars carry a small generic grille emblem with no readable mark. Details per item are in
`.evidence/LOOKLAB-QUOTE-20261102.md` (not in git).

**Look Lab v2 media (2026-11-03).** The 22 v2 variants each ship one start still: GPT Image 2.5 for the twenty photoreal
looks, Nano Banana 2.1 for the stronger anime (no style reference: with v1's anime still as a reference every model
copied its semi-photoreal look) and the stronger claymation (with v1's clay still as a reference). Eight also ship an
edit of their blockout clip: Kling O1 for **Golden hour**, **Blue hour**, **Snowstorm**, **Dog walker**,
**Couple** and **Claymation (stronger)**, and Seedance 2.5 for **Heavy rain** and **ad · Wardrobe ·
cyberpunk**. On the same shot (heavy rain), Seedance held the blockout's walker pace and size; Kling O1 kept the camera,
car, lamp, bench and tree but brought the walker toward the lens ahead of the blockout, so the cyberpunk video was remade on
Seedance for the same reason. Kling is about a third of the price. Five photoreal stills were remade to remove a car grille
emblem (golden hour, heavy rain, peak autumn, cyclist, 1950s). List cost $10.13 (33 stills $2.94, 8 Kling videos $4.03, 2
Seedance videos $3.16). The v2 prompt texts were trimmed slightly after the media was made, to fit the 600-character cap
with the shipped still listed as a reference. Details per item are in `.evidence/LOOKLAB-V2-QUOTE-20261102.md` (not in
git). Look Lab's copy is encoded smaller than the other starters' (540p video at about 1 Mbit/s, WebP stills at most
1280 px), set by its `encode` in `scripts/export-starters.mjs`; the full-quality originals are in the source project.

The snapshot format keeps a shot's prompt-section overrides, saved models and settings and its direction flag
(`promptSections`, `settings`, `motionCritical`); a copy re-keys `obj:<id>` sections to its own object ids. Prompt version
history stays with the source project.

## What a starter opens with

The four finished starters open with bundled media, with no generation and no network:

- every cast member's primary image, and its design sheet (each view plus the composed board);
- for each shot, the start and end stills, the blockout clip and the video made from them;
- the cut, with the chosen video and trim for every shot.

The shot media was made again on 2026-11-01 for the animation pass (below), from blockouts captured with the
low-poly display models and the z-fighting and shadow fixes, for about $9.60 at list prices. The shots the demo leads with
use the final tier: GPT Image 2.5 stills and a Seedance 2.5 edit of the blockout clip, so the blockout is the camera
(Final Lap · Checkered flag, Breaking News · The headline). The draft-tier shots use FLUX 3 stills and an LTX 2.5 Fast clip
animated from the start still, whose camera only approximates the blockout (the other shots of Final Lap, Posterized and
Breaking News). None is trimmed in the cut. Every one of those stills, blockout clips and videos carries the signature of
the current blocking, so a copy reports nothing as out of date and a new batch does not remake them.

Later passes the same day finished the rest. Posterized · Posterized is a Kling O1 edit of its current blockout clip
(Seedance had refused it twice as "may be related to copyright restrictions"). Wingspan's three shots are Seedance 2.5 edits
of their blockout clips: The valley and The glide from new GPT Image 2.5 stills, The dive from FLUX 3 stills. Earlier
LTX and Kling O1 takes of The valley and The dive turned the eagle toward the camera, against the blockout, and were not
used. Every shot of every starter now carries the current blocking, so a copy reports nothing as made for an earlier
blocking and none is trimmed in the cut.

Set pieces render as blockout colours. The race's track surfaces, stands and towers no longer inherit
an unrelated shared image; existing primary environment looks remain available. Cast identities remain
blue/yellow Comfy and green rival for the sports scenes.

## Revised shots

All camera motion is keyed in the blockout. Descriptions specify action; they do not instruct a second
camera move. Every shot is 4–5 seconds, suitable for Seedance 2.5 edit's four-second minimum.

| Starter | Shot | Seconds | Camera and action |
|---|---|---:|---|
| Breaking News | Breaking | 5 | Gentle descending push; anchor and desk read immediately. |
| | The headline | 5 | Straight 55 mm dolly-in on the anchor delivering the headline. |
| | On air | 5 | Restrained oblique push toward the desk for the sign-off. |
| Final Lap | Final lap | 4 | Descending three-quarter track with both cars already alongside. |
| | The draft | 4 | Low tracking two-shot; Comfy draws level in the inside lane. |
| | From the stands | 4 | Elevated sideline track; Comfy pulls ahead. |
| | Checkered flag | 4 | Front three-quarter track; Comfy crosses the line and wins by a car length. |
| Posterized | Fast break | 4 | Elevated lateral track with the ball carrier advancing. |
| | The drive | 4 | Lower tracking approach into the lane toward the defender. |
| | Posterized | 5 | Slow baseline push and rise; guard leaps above the defender, scores and lands. |
| Wingspan | The valley | 5 | Elevated following move with a visible eagle and open lake/ridge backdrop. |
| | The dive | 5 | Smooth descending follow into the lake, without sudden banks. |
| | The glide | 5 | Slow lateral arc around a spread-wing eagle low over water toward the ridge. |

Wingspan uses a simple `bird` shape with a white head, spread wings and a +z-facing beak. Its terrain is
broader and lower, its trees and wildlife sit on the shore, and its cameras stay above the terrain.
Final Lap has low surrounding terrain to activate the renderer's daylight sky and outdoor fill.

## Blender display assets

The 2026-10-31 asset pass adds a bundled `model` ID to every visible object: low-poly people,
race cars, birds and wildlife, studio equipment, court fixtures, track sections and set pieces.
The 32 GLBs total about 1.1 MB. Every original transform, path, camera, timing and media file is
unchanged. Display models fit the original proxies and do not change blocking signatures. The blockout
clips made on 2026-11-01 show these meshes (all but the earlier-animation shots listed above). Reproducible Blender scripts and capture instructions:
[`scripts/blender/README.md`](../../scripts/blender/README.md).

## Format

`starter.json` (`format: "comfy-previs-starter"`, `version: 2`):

- `slug`, `order`, `title`, `description`
- `scene`: `name`, `environment` (preset, description, style), `entities` (groups via `parent`, motion
  `path`s, notes, colours, shared looks via `lookFrom`, `look` and `sheets`) and `references` (object images)
- `shots`: title, description, duration, start, `camera` (move, target, lens, keys), `cast`, `style`,
  `prompts` and `references` (stills)
- `assets`: blockout clips (`camera-render`) and chosen videos (`workflow-result`, with the model and prompt
  that made them)
- `edit`: the cut (`clips`: shot, video, in, out)
- `media`: every file under `media/` with its size, SHA-256, dimensions and the SHA-256 of the source it was
  made from

Snapshots never contain absolute paths. Images are WebP no larger than 1600 px; videos are 720p H.264 at up
to 2.5 Mbit/s with no audio. Version 1 snapshots (no media) still load.

Creating a project from a starter (`POST /api/director/projects` with `template: "<slug>"`) deep-copies the
snapshot with fresh ids and copies the media files into the new project's folder. Copying skips files that
are already there. A starter whose media files are missing still opens, without those images and videos; the
project records how many were missing (`starterFiles`) and says so once when opened.

Blocking signatures (on stills and blockout clips) hash entity ids, which the copy renews. A signature that matches
the snapshot's blocking is rewritten to the copy's, so current media stays current; an older one stays out of date,
and the app marks such stills and videos as made for an earlier blocking. The exporter keeps every blockout clip's
signature. `PREVIS_STARTERS_DIR` points the server at another starters folder (for example one without `media/`).

## Media size and why it is in git

The starters' media is about 75 MB: 33 MB for the four finished starters and 42 MB for the five blockout starters
(blockout clips, two 110 KB mannequin GLBs and Look Lab's 12 MB of stills and videos, encoded smaller), 17.5 MB of it Camera Moves' 24 shots (the export stops at 80 MB and then
keeps only the hero shots' videos). It is committed with the code rather than downloaded from a release so that a fresh clone opens
finished starters offline, with no publish step to keep in sync, and so `pnpm demo:build` can use the same
files. Re-exporting only rewrites a file when its source changed, so history grows only when a starter's
content really changes.

## Source of truth and re-exporting

**The bundles in this folder are the source of truth.** The exporter's source projects live in a data directory and are
rebuilt from the bundles, not the other way round; a plain export of an old project must never overwrite a bundle.

```sh
# 1. Load the bundles into a data directory (a scratch copy, or any directory no server is using).
pnpm starters:import --data-dir "$PREVIS_DATA_DIR"            # --only <slug>; --force replaces an existing source project

# 2. Prove the round trip. Exports into a scratch copy and fails (exit 1) if any JSON or media file would change,
#    appear or disappear. Nothing in examples/starters is written. No FFmpeg needed when nothing changed.
pnpm starters:export --data-dir "$PREVIS_DATA_DIR" --check

# 3. After changing a source project (new stills, videos, blocking), write the bundle.
pnpm starters:export --data-dir "$PREVIS_DATA_DIR"            # FFmpeg and ffprobe on PATH; also --server <url>, --only <slug>
```

`starters:import` writes each bundle as the project `starterSourceId(slug)` (a fixed UUID per slug, listed as `id` in
`SOURCES` in `scripts/export-starters.mjs`, so it never collides with a user's project or the old dev projects). Every
entity, shot, image and clip id is kept, and the media files are copied unchanged. An existing source project is left
alone unless `--force`. Stop any server that uses the directory first: a running server caches projects.

`tests/starters-roundtrip.test.mjs` imports the bundles into a temporary directory and runs the same check, so
`pnpm test` fails if a bundled JSON or media file is not exactly what its source project exports (a hand-edited
snapshot, a changed file, a stale hash, a stray file, or an exporter change that alters the output).

### How a media file stays byte-identical

The exporter re-encodes a source file (WebP at most 1600 px, 720p H.264) only when it is not already the bundled
file. A source whose SHA-256 equals the bundle's recorded `sha256` for that path, or whose `sourceSha256` matches the
manifest, is copied or kept as it is; the manifest entry (including `sourceSha256`) is reused. Imported projects hold
the bundled files themselves, so nothing is re-encoded and re-exporting is exact. A file you change in a source
project is encoded once and then stays put.

### How signatures survive

A still's `generated.signature` and a blockout clip's `source.signature` hash the shot's blocking, which includes entity
ids (`shotSignature`). Two different things happen to ids:

- **Import and export keep ids**, so a signature in the bundle is still the signature of the blocking as imported.
  The exporter keeps each still's `generated.signature` and each blockout clip's `source.signature`. A new video
  keeps no signature of its own; it points at its blockout clip (`source.sourceAssetId`) and is current while that
  clip is.
- **Creating a project from a starter renews ids** (`instantiateStarter`). Any signature that equals the snapshot's
  current blocking is rewritten to the copy's, so current media stays current. A signature that differs stays as it
  was, so the app marks that still or video as made for an earlier blocking.

When you change the blocking of a source project, its old stills and videos keep their old signatures (they are then
reported as out of date) until you replace them.

### Regenerating media

Regenerate in the source project, never in the bundle:

1. `pnpm starters:import` into a data directory and start a private server on it (paid work off unless you mean it).
2. Dry-run, then run the batch against the source projects, which `scripts/pipeline/regenerate-starters.mjs` targets
   by default: `node scripts/pipeline/regenerate-starters.mjs --dry-run --url <server>`. Review and accept stills and
   videos in the app, and set the cut.
3. `pnpm starters:export --data-dir <dir>` writes the bundle, then `--check` confirms it. Commit the bundle.

Source project ids, hero shots (the videos kept if the media goes over budget) and titles live in `SOURCES` in
`scripts/export-starters.mjs`; override a project with `--<slug> <project-id>`. `--no-media` writes a version 1
snapshot without media. `--max-mb <n>` changes the size budget.

## Animation revision (2026-10-31)

The animation pass adds blended joint poses, wheel rotation and steering, a drafting lane change, dribbles,
a jump and cushioned landing, wing beats and dive recovery, elk head turns, and restrained studio gestures.
All 13 cameras, shot starts and durations are unchanged. Sports action is explicitly a slow-motion replay to
match the travel distances in the retained cameras. The arena backboard is now transparent so the scoring beat
is visible from the existing baseline view. Shot and cast wording is shorter and checked with the prompt-plan
assembler against every video model's auto-prompt cap; it gives no camera-motion instructions.

The paid media was then made again for this animation (2026-11-01; see "What a starter opens with" for the shots that
still carry the earlier animation). The invariant test pins all cameras, timing, set transforms and cast images to the
pre-animation snapshot (shot media is pinned by the round-trip test instead); animation tests additionally check posed shoe
contact, scoring and prompt retention. Reproducible authoring and evidence commands are in the Blender README.
