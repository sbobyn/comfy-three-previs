# Starter projects

The launch page's **New project** row offers these starters (plus *Start empty*).
Each folder holds one versioned snapshot:

```
examples/starters/
  index.json              # { "starters": [slug, …] } — launch-page order
  <slug>/starter.json     # the snapshot
  <slug>/media/           # reserved: starter media (renders, looks), not used yet
```

`starter.json` (`format: "comfy-previs-starter"`, `version: 1`):

- `slug`, `order`, `title`, `description`
- `scene` — `name`, `environment` (preset, description, style) and `entities`
  (groups via `parent`, motion `path`s, notes, colours, shared looks via `lookFrom`)
- `shots` — title, description, duration, start, `camera` (move, target, lens, keys),
  `cast`, and optional `style` / `prompts`
- `media` — always `[]` for now. Later it can list files under `media/`, e.g.
  `{ "path": "media/shot-01.mp4", "role": "render", "shot": 0 }`.

Snapshots never contain absolute paths, renders, references, assets or
design-sheet images. Creating a project from a starter deep-copies the snapshot
with fresh ids (`POST /api/director/projects` with `template: "<slug>"`).

## Re-exporting

Edit the source projects in the app, then regenerate the snapshots from a
running server or straight from a data directory:

```sh
node scripts/export-starters.mjs --server http://127.0.0.1:5173
node scripts/export-starters.mjs --data-dir "$PREVIS_DATA_DIR"
```

Source project ids live in `SOURCES` in the script; override one with
`--<slug> <project-id>`.
