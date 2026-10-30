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

Each starter opens finished, with no generation and no network:

- every cast member's primary image, and its design sheet (each view plus the composed board);
- for each shot, the chosen start still (and end still, where there is one), the blockout clip and the
  chosen video;
- the cut, with the chosen video and trim for every shot.

Set pieces (stands, track surfaces, light towers, hoop supports) have no image on purpose: they render
as their blockout colour and are described once in the shot prompt's **Set:** sentence.

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
are already there, and a starter whose media folder is missing still opens, just without images and videos.

## Media size and why it is in git

The four starters' media is about 34 MB (the export stops at 80 MB and then keeps only the hero shots'
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
