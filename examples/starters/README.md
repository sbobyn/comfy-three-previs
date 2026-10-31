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
- for each shot, the chosen start still (and end still, where there is one), the blockout clip and the
  chosen video, plus a fresh local blockout of the revised blocking;
- the cut, with the chosen video and trim for every shot.

The 2026-10-31 blocking pass keeps every existing entity ID, cast look and design sheet. The 16 generated
stills and 13 chosen videos are historical takes: they **do not match the revised blocking**. Old videos
still point to the old blockout they actually used; each shot also has a newer, locally rendered 720p
blockout. The old stills carry their original blocking signature, so a new batch remakes them. No paid
media was made for this pass. Replacing the 16 stills and 13 videos costs about **$24.52** at the final-tier
list prices; making start and end stills for every shot instead costs about **$25.28** including videos
(estimates from `shared/tiers.mjs`, excluding overhead and retries).

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

The four starters' media is about 40 MB (the export stops at 80 MB and then keeps only the hero shots'
videos). It is committed with the code rather than downloaded from a release so that a fresh clone opens
finished starters offline, with no publish step to keep in sync, and so `pnpm demo:build` can use the same
files. Re-exporting only rewrites a file when its source changed, so history grows only when a starter's
content really changes.

## Re-exporting

Edit the source projects in the app (choose the cut's videos and the stills to show), then regenerate the
snapshots from a running server or straight from a data directory. FFmpeg and ffprobe must be on `PATH`.

```sh
pnpm starters:export --server http://127.0.0.1:5190
pnpm starters:export --data-dir "$PREVIS_DATA_DIR"
pnpm starters:export --server http://127.0.0.1:5190 --only posterized
```

Source project ids, hero shots and explicit still picks live in `SOURCES` in
`scripts/export-starters.mjs`; override a project with `--<slug> <project-id>`. `--no-media` writes a
version 1 snapshot without media. `--max-mb <n>` changes the size budget.
