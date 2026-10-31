# Import a Blender shot

Build a shot in Blender, by hand or with Claude Code driving Blender MCP, and bring it into Previs as a shot's blockout. Blender's camera becomes the shot camera. Each mesh becomes a proxy object sized from its Blender bounds. Blender's rendered frames become the blockout clip that camera-following video models (Seedance 2.5 · edit, Kling O1 · edit) use.

After the import the shot is an ordinary Previs shot: Cast Cards, looks, stills, the batch, Cut and Compare all work unchanged. The import is free and local, and nothing is generated.

## 1. Export from Blender

`scripts/blender/previs_export.py` writes one shot into a folder:

```
shot1/
  blender-previs.json          the sidecar (camera, objects, timing)
  frames/frame-000000.png …    one PNG per frame, 24 fps, 1280×720 or 640×360
```

Headless:

```sh
blender -b scene.blend -P scripts/blender/previs_export.py -- --out /abs/path/shot1 \
  [--camera ShotCam] [--start 1 --end 96] [--fps24] [--size 1280x720|640x360] [--engine keep|workbench|eevee|cycles]
```

Inside a running Blender (Blender MCP `execute_blender_code`, the Text Editor or the Python console):

```python
PREVIS_EXPORT = {'out': '/abs/path/shot1', 'camera': 'ShotCam', 'fps24': True}
exec(open('/path/to/comfy-three-previs/scripts/blender/previs_export.py').read())
```

The `previs_director_blender_helper` MCP tool returns the script's absolute path and both commands.

Rules:

- **Timing.** The scene must run at 24 fps; `--fps24` sets it for the export only. A shot is 12–120 frames (0.5–5 s), the Director's shot range.
- **Camera.** A perspective camera: `--camera`, else the scene camera. Constraints such as Track To are honoured.
- **Size.** Frames are rendered at 1280×720 (default) or 640×360, the two sizes Previs plays. The scene's own render engine is used unless `--engine` overrides it. Workbench or EEVEE renders 120 frames in seconds; Cycles can take a long time.
- **Folder.** `--out` is an absolute path to a new or empty folder, or an earlier export folder, which is replaced. A folder holding anything else is refused.
- **Your file is left alone.** The `.blend` is never saved. Render settings, the scene camera and the current frame are restored afterwards, even after an error.
- **Errors.** Headless runs exit with code 1 and print the reason. Inside Blender the reason is raised as an `ExportError`, so a running Blender stays open.
- **Output.** The script prints the folder's real path (for example `/private/tmp/…` rather than `/tmp/…`). Import from that path.

### Tagging objects

Every visible mesh is exported. Meshes under 1 cm tall, such as ground planes, are left out because Previs draws its own ground. Use these optional tags:

| Tag | Effect |
|---|---|
| name `cast:Comfy Car`, or custom property `previs_cast = 1` | Cast: a character, vehicle or prop in prompts. Untagged meshes come in as set pieces (`environment`). |
| `previs_name` | The name in Previs (default: the object name, without `cast:`). |
| `previs_shape` | `person`, `car`, `bird`, `box`, `table`, `chair`, `sphere`, `cylinder`, `lamp`, `building`, `wall`, `tree` or `rock`. Without it, a word in the name decides (car, truck, person, man, woman, tree, rock, wall, building, house, table, chair, lamp, bird, ball…), else `box`. |
| `previs_kind` | `character`, `vehicle`, `prop` or `environment`, for cast objects. |
| `previs_color` | `#rrggbb`. Default: the first material's Base Color. |
| `previs_ignore = 1` | Leave the object out. |

## 2. Import into Previs

There are three ways in. Each one creates a new project when no project is given.

- **From Claude** (MCP): `previs_director_import_blender` with `path` and, optionally, `projectId`, `shot` (re-import into that shot) and `title`. It returns the shot, the object mapping (`added` or `updated`), the landmark check and any warnings.
- **Home screen**: zip the export folder and choose **Import Blender shot…** next to Import. It opens a new project.
- **curl**:

  ```sh
  curl -X POST http://127.0.0.1:5190/api/director/import-blender -H 'Content-Type: application/json' \
    -d '{"path": "/abs/path/shot1", "projectId": "<optional>", "shotId": "<optional>", "title": "<optional>"}'
  curl -X POST 'http://127.0.0.1:5190/api/director/import-blender-zip?projectId=<optional>&title=Final%20lap' \
    -H 'Content-Type: application/zip' --data-binary @shot1.zip
  ```

With a project and no shot, the import adds a shot. With a shot, it replaces that shot's camera and blockout clip (see Refresh below). The whole export is checked before anything changes, so a bad export leaves the project untouched. The importer reads only `blender-previs.json` and `frames/frame-NNNNNN.png`. It refuses relative paths, symlinked folders or frames, and any other file in a zip (Finder's `__MACOSX` and `.DS_Store` entries are ignored). It never reads a `.blend` file.

## 3. What you get

- **Objects.** One proxy per exported mesh, matched to existing objects by name (the same key `@mentions` use). Position is the bottom centre of the object's bounds. Rotation is its yaw. Scale is chosen so that the proxy's extents equal Blender's bounds, so framing, cast detection, overlay boxes and the camera words see the true sizes. Animated objects get one key per frame, up to 64 keys, with yaw and (when an extent changes by more than 15 %) scale. A proxy can show 0.05–50× of its shape's size; anything larger is clamped, with a warning.
- **Camera.** A custom camera with linear timing, one key per frame up to 64, with the lens converted to Previs's 35 mm gauge. The subject is the shot's existing target, or else the cast object filling most of the first frame. The engine record keeps all frames, roll included. Previs camera words and overlay boxes assume a level camera, so the exporter warns when the camera rolls more than 2°.
- **Blockout clip.** Blender's frames encoded at 24 fps, recorded as the shot's blockout (`shot.render.origin = "blender"`). Render blockout skips the shot. Video models that follow the blockout use Blender's pixels. The model card says *Blender clip*.
- **Still guide.** While the import is current, `/api/director/frame` (used by the batch and the agent's stills) returns Blender's frame at `t` as image 1, and the still prompt drops the sentence about proxy markers. The workspace's live preview still shows the proxies.
- **Landmark check.** Blender projects up to three landmarks at the first, middle and last frame. The importer projects them again through the imported camera and warns when any lands more than 1 % of the frame width away. On the test scene every landmark lands within 0.005 %, with AUTO and VERTICAL sensor fits.

### Refresh and hand-over

Re-import into the same shot after changing the Blender scene. Objects are matched by name, so looks, notes, Cast Cards and names survive. Positions, sizes, paths and the camera are replaced. A new blockout clip version is recorded, and earlier clips and generated videos stay.

Editing the shot in Previs afterwards (moving an object, changing the camera or timing) makes the import stale. The workspace says *Edited since the Blender import*, the still guide goes back to the proxies, and the next blockout render, or Generate, replaces Blender's clip with a proxy blockout. Re-import from Blender to keep Blender's clip.

## The sidecar (version 1)

`blender-previs.json`, all geometry in raw Blender coordinates (Z-up, metres). The importer converts `(x, y, z) → (x, z, −y)`.

| Field | Rule |
|---|---|
| `format`, `version` | `"comfy-previs-blender-handoff"`, `1` |
| `exporter`, `source` | Provenance only: `{ name, version, blender }` and `{ file, scene, camera, frameStart, frameEnd }` |
| `fps` | `24` |
| `frameCount` | 12–120, equal to `frameEnd − frameStart + 1` and to the number of PNGs |
| `width`, `height` | `1280×720` or `640×360`; every PNG must match |
| `axes` | `"blender-z-up"` |
| `camera` | `sensorWidth`, `sensorHeight` (mm), `sensorFit` (`AUTO`, `HORIZONTAL` or `VERTICAL`); `keys[]`: one `{ frame, p, fwd, up, lens }` per frame (`fwd` = the camera's −Z, `up` = its +Y, world space); `checks[]`: up to 30 `{ frame, point, px }` landmarks Blender projected |
| `objects[]` | `{ name, blenderName, cast, shape, kind?, color?, frames[] }`; `frames` holds one record (static) or one per frame: `{ frame, position: bottom centre, yaw: degrees about +Z of the object's −Y (its front), size: [width, height, depth] in its yaw frame }`. At most 198 objects; names must stay distinct in Previs. |
| `warnings[]` | Strings, shown in the import receipt |

Other tools can write the same sidecar. The helper's command line, its `PREVIS_EXPORT` keys and this format are a stable interface. A change that breaks them gets a new `version`.

## Limits and notes

- Tested with Blender 5.3.0 Alpha (headless). The helper uses `evaluated_get`, `world_to_camera_view` and `render.render(write_still=True)`, which are stable across Blender 4.x and 5.x.
- Proxies are boxes of each object's extents. An irregular set piece is described by its size only.
- Lens shift is not carried over; the exporter warns.
- Files: up to 120 PNGs of up to 8 MB each, and a zip upload of up to 1 GB.

## Tests

`tests/blender-import.test.mjs` runs against a real export in `tests/fixtures/blender-handoff/`, made by `scripts/blender/build-test-scene.py`. It covers the mapping, the projection proof, rejections, a server round trip (import, downstream consumers, refresh, stale hand-over, the still guide, the zip import) and the two MCP tools. The helper test runs Blender when `PREVIS_BLENDER` names the binary:

```sh
PREVIS_BLENDER=/Applications/Blender.app/Contents/MacOS/Blender node --test tests/blender-import.test.mjs
```

To rebuild the fixture:

```sh
blender -b --factory-startup -P scripts/blender/build-test-scene.py -- --out "$PWD/tests/fixtures/blender-handoff/shot.previs-blender"
```
