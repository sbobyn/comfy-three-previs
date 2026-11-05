# Blockout modelling rules

Blockout frames are camera truth: every still and video model is given them as image 1 or as the source clip. Whatever
the blockout shows, the generated media copies, including rendering faults. The two faults that leak most are:

- **z-fighting:** two surfaces on one plane. The depth test picks a different winner pixel by pixel, so you see
  stripes, speckles or shimmer, which change every frame.
- **shadow acne and leaks:** striped self-shadowing, or light where a narrow gap should be dark.

These rules apply to anyone building a blockout: people in the editor or Blender, agents using the MCP tools, and
the Blender scripts that make the bundled meshes.

## The rules

1. **Never put two surfaces on the same plane.** Two faces that point the same way, are within 1 mm of each other
   and overlap will z-fight. This holds inside one model (a trim flush with its body) and between objects (a finish
   line sunk flush into the track).
2. **Lift decals, lines and inset panels at least 2 mm off the surface under them, along its normal.** On a floor
   whose top is at `y`, put the bottom of a rug or line at `y + 0.002`. On a wall, push a sign out 2 mm. The bundled
   meshes use 3 mm.
3. **Measure the gap in world metres at the scale the object is shown.** video-lab stretches models non-uniformly: a
   court is a 1 m model shown 5 cm tall. A gap of 0.003 in model units becomes 0.15 mm there. Author the gap
   as `0.003 m ÷ smallest scale on that axis`; `generate-blockouts.py` does this with `gap(axis)`.
4. **Caps and trims sit on the body or overhang it; they are never exactly as wide as it.** Stop the body under
   the cap, or make the cap 2 mm wider on each side. A dark cap exactly as wide as a pale wall caused the striped
   Final Lap wall.
5. **Cut or merge overlaps instead of stacking them.** If two parts would share a face, shorten one or join them.
6. **Some cases are fine.** Objects standing on one floor (their bases share the floor's plane, and the floor hides
   them) are fine. So are overlapping copies of the same object in the same colour (they draw the same pixel
   whichever wins). Rotated segments that overlap still need their markings at different heights.
7. **Decals don't cast shadows.** Name bundled decal materials `<name>-decal`. The viewer gives them `polygonOffset`,
   which keeps them in front at any distance, and turns off their shadow casting, which would otherwise smear a
   texel-wide dark halo around them.

## Where it is checked

| Where | What happens |
|---|---|
| `scripts/blender/generate-blockouts.py` | Runs `pnpm lint:blockouts` after every rebuild; the rebuild fails on any overlap. |
| `tests/blockout-lint.test.mjs` | Every bundled GLB at its proxy size and at every starter scale, and every starter scene: zero overlaps. |
| `previs_director_edit` (MCP), `/api/director/edit` | Objects the edit added or moved onto another object's plane come back as `warnings` (listed first). |
| `previs_propose_edit` (built-in agent) | The same warning, checked on the proposal's preview. |
| Library place | Lifts the placed thin, static parts 2 mm off a floor or wall they would share; reports the rest. |
| Library import | Reports overlaps inside the bundle (bundles are content-hashed, so nothing is moved). |
| Blender export (`previs_export.py`) | Adds a sidecar warning for objects sharing a plane in Blender. Your scene is never changed. |
| Blender import | Lifts thin, static imported objects 2 mm and warns about anything it cannot lift. The Blender clip is unchanged. |

The check itself is `shared/blockout-lint.mjs`. For each pair of same-facing triangles within 1 mm along their
normal, it clips their 2D overlap and reports it when the overlap is 1 mm² or more. It works in world metres, with
each entity's position, rotation, pitch, roll and scale. Run it with `pnpm lint:blockouts`.

## What the renderer does

The viewport, the shot monitor, card stills, blockout captures and the headless renderer (`/api/director/frame`,
render-blockout) all share `src/director-scene.ts`, so they match:

- **Shadows:** the sun's shadow box is fitted per shot to what the shot camera sees over its whole move, out to 4×
  the subject distance (40–160 m). Across the light it is clipped to the objects that can cast; along the light it
  spans every caster. Every frame of a shot shares one box, so there is no shimmer. The map is 2048² for sets up to
  60 m and 4096² beyond, with PCF filtering. Biases are in world terms from the texel size: half a texel of normal
  bias (at least 5 mm) and a quarter texel of depth bias. Closed meshes cast from their back faces.
- **Depth precision:** near is half the clearance to the closest object (0.1–2 m) and far reaches the farthest
  object outdoors. Depth precision depends almost entirely on near. A logarithmic depth buffer was not needed.
- **Decals:** `-decal` materials get `polygonOffset` (units −4, no slope factor, which would pull their thin side faces through what is in front of them) and cast no shadow.

## Checking by eye

```sh
node scripts/blender/capture-closeups.mjs http://127.0.0.1:<port> <data-dir> <out-dir>
```

This captures close-ups of the trouble spots in every starter: track joints, the finish line, walls, stand rows,
court lines, the desk, the lake and river. It uses a private server holding `pnpm starters:import` source projects
(see `scripts/blender/README.md`). Use `capture-blockouts.mjs` for every starter shot. The 2026-10-31 before/after
set is in `.evidence/zfight-20261031/`.
