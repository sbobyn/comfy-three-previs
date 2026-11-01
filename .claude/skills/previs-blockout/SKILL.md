---
name: previs-blockout
description: Build or edit Comfy Previs blockouts (scene objects through the MCP tools, Blender scenes for import, or the bundled GLB generator) without z-fighting or shadow artefacts. Use when placing floors, lines, decals, signs, caps or trims, or when an edit result returns coplanar warnings.
---

# Previs blockouts without z-fighting

Blockout frames are camera truth: image and video models copy any flicker or striped shadow. Full rules and
the reasons for them: `docs/blockout-modeling-rules.md`.

## Rules

1. Never put two surfaces on the same plane. Two faces that point the same way, are within 1 mm of each other and
   overlap will z-fight.
2. Lift a line, decal, rug or sign at least 2 mm off the surface under it, along its normal. On a floor with its
   top at `y`, the object's bottom goes at `y + 0.002`. On a wall, push it out 2 mm.
3. Measure gaps in world metres at the scale shown. Model-space gaps shrink with non-uniform scale, so a 5 cm slab
   needs `0.003 / 0.05` model units.
4. Caps and trims sit on the body or overhang it by the gap; they are never exactly as wide.
5. Objects standing on one floor, or overlapping copies of one object in one colour, are fine.

## When you edit through MCP

- `previs_director_edit` and `previs_propose_edit` list `warnings` first when an object you added or moved shares
  a plane with another. Fix each one: move the thinner object 2 mm along the named normal (`facing +y` means
  raise it).
- Library place lifts thin static parts 2 mm automatically and says so in `warnings`.
- Blender import does the same for thin static objects. `previs_export.py` warns in the sidecar first.

## When you change the bundled meshes

```sh
blender -b --python scripts/blender/generate-blockouts.py   # runs the lint; fails on any overlap
pnpm lint:blockouts                                          # the same check alone
node --test tests/blockout-lint.test.mjs
```

- Use `gap(axis)` and `decal(material)` in `generate-blockouts.py` for every marking, so the viewer gives it
  `polygonOffset` and no shadow casting.
- Look at the result: `node scripts/blender/capture-closeups.mjs <server> <data-dir> <out-dir>` on a private
  server, then compare the before and after images.
