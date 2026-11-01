# Starter projects

The home page's **Starters** row offers these four projects (plus **New scene** for an empty stage).
Opening one creates a new project from its snapshot, so the starter itself never changes.

```
examples/starters/
  index.json                  # { "starters": [slug, …] } — home-page order
  <slug>/starter.json         # the snapshot
  <slug>/media/refs/<id>.webp # object looks, design-sheet views and boards, shot stills
  <slug>/media/assets/<id>.mp4  # each shot's blockout clip and chosen video
```

## What a starter opens with

Each starter opens with bundled media, with no generation and no network:

- every cast member's primary image, and its design sheet (each view plus the composed board);
- for each shot, the start and end stills, the blockout clip and the video made from them;
- the cut, with the chosen video and trim for every shot.

The 2026-10-31 blocking pass kept every entity ID, cast look and design sheet; the shot media was then
made again for the revised blocking (2026-10-31, about $14.83 at list prices). The four shots the demo
leads with use the final tier: GPT Image 2.5 stills and a Seedance 2.5 edit of the blockout clip, so the
blockout is the camera (Final Lap · Checkered flag, Posterized · Posterized, Wingspan · The glide,
Breaking News · The headline). The other nine use the draft tier: FLUX.2 Pro or FLUX 3 stills and an LTX
Fast clip animated from the start still, whose camera only approximates the blockout; three of them are
trimmed in the cut where the clip stops matching the shot (The valley, The draft, From the stands). Every
still and blockout clip carries the signature of the current blocking, so a copy reports nothing as out
of date and a new batch does not remake them.

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
unchanged. Display models fit the original proxies and do not change blocking signatures; the
bundled stills and videos still contain the earlier geometry. Capture a new blockout to see the
new meshes in a video. Reproducible Blender scripts and capture instructions:
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

The four starters' media is about 32 MB (the export stops at 80 MB and then keeps only the hero shots'
videos). It is committed with the code rather than downloaded from a release so that a fresh clone opens
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

The earlier paid stills and videos are preserved byte-for-byte and **intentionally out of date** for this new
animation. No paid regeneration was performed. Fresh starter copies report that state, and a dry-run batch
plans new key stills and blockouts before video generation. The invariant test pins all cameras, timing, set
transforms, cast images and media to the pre-animation snapshot; animation tests additionally check posed shoe
contact, scoring and prompt retention. Reproducible authoring and evidence commands are in the Blender README.
