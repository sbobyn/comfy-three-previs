# Starter display meshes

These authored, texture-free low-poly GLBs upgrade all 189 visible objects in the four
starter scenes. Empty groups remain editor pivots. There are 32 reusable assets, about
1.2 MB combined, each below 5,000 triangles (most below 1,500). No downloaded or generated
third-party art, paid generation, textures, skinning, animation clips or Blender runtime dependency.

## Rebuild

From the repository root, with Blender and Node 22+ on PATH:

```sh
blender -b --python scripts/blender/generate-blockouts.py
pnpm starters:import --data-dir .evidence/blockout-source
node scripts/blender/assign-blockouts.mjs .evidence/blockout-source
pnpm starters:export --data-dir .evidence/blockout-source
pnpm starters:export --data-dir .evidence/blockout-source --check
pnpm check && pnpm test
```

The generator ends by running `pnpm lint:blockouts` and fails if any GLB, at its proxy size or at any starter
scale, or any starter scene has two surfaces on one plane. Decals, lines and inset panels use `decal(material)`
(a `-decal` material: `polygonOffset` and no shadow casting in the viewer). They are lifted `gap(axis)` off the
surface below: 3 mm in world metres at the smallest scale the starters show that model. Caps sit on the body
and overhang it by the same gap. Rules: [Blockout modelling rules](../../docs/blockout-modeling-rules.md).

The generator was verified with Blender 5.3.0 Alpha, build `5988184be881`.
It writes `public/models/blockouts/*.glb` and their triangle/byte manifest. Triangle index
ordering is canonicalised, but Blender can vary equivalent accessor sharing between rebuilds;
byte-identical GLBs are not guaranteed. Geometry bounds, joints, triangle budgets and coplanar
surfaces are checked by the tests and lint. Scripts resolve
paths relative to the repository, so they contain no workstation-specific project paths.
The assignment script modifies imported source projects, never the starter bundles directly.
Use a private data directory with no running server, as for any starter export.

## Geometry and loading contract

`Entity.model` is an optional **bundled display mesh ID**, validated against the shape in
`shared/blockout-models.mjs`. It is not an import path or URL. A shape change clears an
incompatible model. Legacy projects and new primitives still render as before.

Models use metres, Y up, +Z forward, a bottom-centre pivot, and the same unscaled bounds
as `SHAPES[entity.shape]`. The generator authors in Previs axes, stores Blender `(x,-z,y)`,
and exports glTF Y up. This agrees with the thin-import pipeline's Blender `(x,y,z)` →
Previs `(x,z,-y)` convention. No dependency on that separate rendered-frame importer.
Terrain is the exception to proxy-box fitting: it samples `shared/terrain.mjs` on a 49×49
grid, keeping the original heights/coordinates and applying flat slope materials.

The Three.js loader caches source GLBs; each entity owns its cloned mesh/materials, with
`entity-color` tinted from the existing entity colour. Static assets are copied by Vite
and use `BASE_URL`, including the offline/static demo. Home previews, editor, shot monitor,
still guides and headless/video captures use the same meshes. Boot and headless capture
await models; a saved capture fails explicitly if a mesh is unavailable. Thin geometry
is double-sided, with back-face shadow casting; decals cast no shadow. The sun's shadow box is fitted to each shot,
with biases set from its texel size (see the rules doc).

The proxy shape still drives camera targets, framing, cast selection and animation.
Unposed bundled model IDs are excluded from the **blocking signature**, like cast looks.
A model with pose keys is included because its joints determine the animated silhouette.
The bundled stills and MP4s remain byte-identical and show the earlier primitive geometry;
they are not new renders of these models. Explicitly capture a new blockout to get new pixels.
Any camera, timing, proxy shape, position, rotation, scale or path edit still invalidates
media as before. Tests pin all fields outside the explicitly revised actor blocking and shot/cast text to a baseline
hash and validate mesh bounds, coverage, triangles, dependencies and starter round trips.

## Capture evidence

On a private server (`PREVIS_ALLOW_PAID=0 PREVIS_HEADLESS=1`), after importing the starters:

```sh
node scripts/blender/capture-blockouts.mjs http://127.0.0.1:5285 .evidence/blockouts2-20261031/after
# Run the same command with the original build/data and a before/ destination first.
python3 scripts/blender/contact-sheet.py .evidence/blockouts2-20261031  # Pillow required
```

This uses `/api/director/frame` → `render-worker` → `scene.capture`, the app's own GPU
capture path. It records 960×540 frames at start, midpoint, and the last 24 fps frame of
all 13 shots. Keep the built app unchanged while capturing. `contact-sheet.png` compares
all shot midpoints; the four scene contact sheets compare all 39 frame pairs. `capture-closeups.mjs <server> <data-dir>
<out>` adds fixed close-ups of the trouble spots in each starter (a close-ups copy of each source project). Raw captures,
request manifests and gate logs remain in the ignored evidence directory.

## Articulated animation pass (2026-10-31)

The starter leads now use small rigid-part hierarchies (`joint_*` glTF nodes), with no skinning or animation mixer.
The Blender generator fits the neutral hierarchy once to its original proxy; posing never rescales it. Player,
anchor and operator limbs bend at named pivots; eagle feathers overlap the wing beats; elk nod; race-car wheels
rotate and steer independently of the body. The backboard is framed transparent arena glass so the fixed dunk
camera can see the score. Glass does not cast an opaque shadow. All meshes remain under 5,000 triangles and the
library remains under 1.5 MB. A targeted rebuild is supported after Blender's `--`, for example `-- eagle player`.

`shared/blockout-pose.mjs` validates and evaluates joint angles. `Entity.pose` and `PathKey.pose` store local XYZ
degrees; `PathKey.ease` selects linear or smoothstep interpolation for the outgoing segment. Omitted ease retains
the old position spline. `src/director-scene.ts` applies the same absolute joint transforms for viewport, stills and
capture, so scrubbing backwards cannot accumulate rotations. Posed model IDs and all pose keys enter the shot
signature; static unposed bundled models retain the earlier fidelity-only signature policy.

Reapply the authored animation recipe only to a private imported data directory, with its server stopped:

```sh
node scripts/blender/animate-starters.mjs <data-dir>
pnpm starters:export --data-dir <data-dir>
pnpm starters:export --data-dir <data-dir> --check
```

`capture-animation.mjs <private-server-url> <output-dir>` captures every shot at 1280×720, 24 fps through
`render-blockout` → `captureShotVideo`. Use a **separate disposable data directory**: capture attaches new assets.
`animation-sheets.py <evidence-root> [before|after] [shot-file-prefix]` extracts every frame and makes 24-frame
review pages plus eight-frame overview sheets (Pillow and FFmpeg required). The before/after clips, sheets,
prompt plans and per-shot critique for this pass live in `.evidence/animation-20261031/`.
