# Import a 3D model

Bring a real mesh into the scene: a character from Mixamo, a car from Sketchfab, a set from a scan or your own Blender export. The model becomes an ordinary object with its own Cast Card. It shows in the viewport and in every blockout clip, still guide and card thumbnail, including those the headless renderer makes. Rigged humanoids can play their animation clips and hold poses. The import is free and local, and nothing is generated.

## Formats

| File | Notes |
|---|---|
| `.glb` | Used as is. |
| `.gltf` | Its `.bin` buffers and textures are packed into one GLB. Import them together: drop all the files, pick them all, or zip the folder. |
| `.fbx` | Converted with three.js's FBX loader. Textures embedded in the file, or next to it in a zip, are kept. |
| `.obj` | Converted. Its `.mtl` and textures are read when they are next to it (in a zip, a multi-file drop, or the same folder for a path import). |
| `.stl`, `.ply` | Converted to a plain grey mesh, with vertex colours when the file has them. A PLY must have faces. A Gaussian-splat PLY is refused with a clear message (splats are [not supported yet](#not-yet)). |
| `.usdz` | Converted with three.js's USD loader. Skeletons import. Skeletal animation does not yet. |
| `.zip` | Holds one of the above with its files. Finder's `__MACOSX` entries are ignored. |
| `.png`, `.jpg`, `.webp` | A [backdrop card](#backdrop-cards). |

Every format ends up as one self-contained GLB in the project's `refs/` folder, so projects export, import and duplicate with the model inside them. Textures stay PNG, JPEG or WebP, as the original bytes. A texture in any other format (TGA, TIFF, BMP) is left out, with a note.

## Import

- **Drop** the file (or several files, or a zip) on the viewport. In the director view the object lands where you dropped it; in the camera view it lands at the orbit target. Images still work as before: an image dropped on an object becomes its cast image.
- **+ Add ▾ → Import model…** opens a file picker (choose several files for a glTF or an OBJ with its textures).
- **From Claude**: `previs_import_asset` with `projectId` and `path` (absolute) or `url` (https), and optionally `name`, `kind`, `place: { position, rotation }`, `height` (metres), `licence` and `attribution`. It returns the object id, size, clips, rig joints, units and warnings.
- **curl**:

  ```sh
  curl -X POST 'http://127.0.0.1:5190/api/director/import-asset?projectId=<id>&name=robot.glb&x=0&y=0&z=-2&licence=CC0' \
    -H 'Content-Type: application/octet-stream' --data-binary @robot.glb
  curl -X POST http://127.0.0.1:5190/api/director/import-asset -H 'Content-Type: application/json' \
    -d '{"projectId": "<id>", "path": "/abs/path/robot.fbx", "height": 1.7}'
  ```

The whole file is checked before anything changes, so a refused import leaves the project untouched.

## What you get

- **One object**, named from the file (`x_bot-final.fbx` → *X bot final*). It is a character if it has a humanoid rig, an environment piece if it is more than 8 m across, and otherwise a prop. Change the type in the inspector.
- **Its real size.** glTF and USDZ are metres. FBX uses the unit it declares (centimetres by default). OBJ, STL and PLY have no units, so the size decides: over 100 units is read as millimetres, over 10 as centimetres, otherwise metres. A humanoid outside 1.2–2.3 m tall is scaled to 1.8 m. The result says which rule applied (`units`), and `height` overrides it. The object's box is the model's rest bounds (for a humanoid, its standing width rather than its T-pose arm span), so framing, cast detection, camera words and overlay boxes see the true size. An object can be at most 50× its proxy shape, so anything over 50 m (300 m for very large sets, which use the building shape) is clamped, with a warning.
- **Facing.** A humanoid is turned to face the shot's +z, like the bundled people. A file that is Z-up or faces backwards is corrected, in 90° steps only: a figure's natural lean is never "straightened".
- **Its Cast Card** with an **Imported model** section: the file, units and triangle count, and fields for **Licence** and **Credit**. Fill them in when the model is not yours. They travel with the project and are never part of a prompt. Only these two fields (and the source link) can be edited. The file facts and the rig are fixed at import.

Imported models are drawn with their own materials and textures. They are left out of the coplanar-surface lint, which is meant for blockout geometry. **Save to library** refuses them for now; import the file into each project instead.

## Backdrop cards

An image can stand in the scene as a flat, upright card: a painted sky behind a set, a location photo, a storyboard panel to block against. **Shift**-drop a PNG, JPEG or WebP on an empty part of the viewport, choose **+ Add ▾ → Backdrop card…**, or give `previs_import_asset` an image path. The card is 4 m wide, or `height` metres tall, at the image's aspect ratio. It faces +z, is unlit (it shows the image's own colours under any light), is visible from both sides, and is an environment object. Several images dropped together stand side by side. Without Shift, a dropped image still becomes a cast image or a shot reference.

## Rigged characters

A skinned model whose bone names follow a common humanoid scheme is detected as a humanoid. Supported schemes are Mixamo (`mixamorig:LeftForeArm`), Unreal (`upperarm_l`, `calf_r`), Rigify (`DEF-upper_arm.L`), VRM (`J_Bip_L_LowerArm`), 3ds Max Biped (`Bip01 L Calf`) and plain Blender names (`forearm.L`). The names are then checked against the hierarchy: hand under forearm under upper arm, shin under thigh, both under the hips. If the check fails, there are no poses, but clips still play. Fingers, twist bones and toes are left alone.

### Clips

The file's animation clips are listed on the Cast Card. A new import plays its first clip of at least two frames. Mixamo's one-frame `mixamo.com` bind pose is skipped. A file without clips starts in the stand pose. For each clip you can set:

- **Clip**: which one plays (or *No clip*, to use poses).
- **Offset**: seconds into the clip at the start of the scene.
- **Speed**: −4× to 4×.
- **◆ Key for <shot>**: play the chosen clip from that shot's start. Shots before it keep what they had, so each shot can have its own clip, offset and speed. *Clear keys* removes them.

Clips loop by default and play **in place**: the hips keep their bob and sway, but the object's own path moves it across the set. Set `inPlace: false` to let a clip carry the figure, or `loop: false` to hold the last frame. Evaluation is absolute: the frame at time t is always the same, whatever was shown before. So scrubbing, out-of-order captures and the headless renderer agree.

### Poses

**Pose** buttons apply a library pose: **tpose**, **stand**, **walk**, **run**, **sit**, **jump**, **point**, **wave**. On an object with motion keys, the pose is keyed at the playhead; otherwise it becomes the object's pose. Poses blend between keys like the bundled figures' joint keys. While a clip plays, a pose adds on top of it.

Angles use the same joint names as the bundled figures, plus `spine`, `neck`, `handL/R` and `footL/R`: XYZ degrees about the character's own axes (x = its left, y = up, z = its front). They are relative to a **canonical T-pose**, so an A-pose rig and a T-pose rig take the same numbers. Each joint turns relative to its parent joint. Right-side joints are mirrored, so equal numbers on L and R make a symmetric pose:

| Angles | Effect |
|---|---|
| `armL [0, 0, -80]` | lowers the left arm to the side |
| `armL [0, -90, 0]` | points the left arm forward |
| `forearmL [0, -90, 0]` | bends the elbow |
| `thighL [-90, 0, 0]` | lifts the thigh forward |
| `shinL [90, 0, 0]` | bends the knee |
| `body [10, 0, 0]` | leans forward |

**Bent legs keep the feet down.** Without a clip, the hips drop so the lowest foot stays where a straight-legged stance puts it, so *sit* sits at about seat height. A *jump* pose therefore lands on the ground: key the object up to lift it.

**IK.** `previs_director_perform` with `ik: { handR: [x, y, z] }` (or `handL`, `footL`, `footR`) reaches for a point in metres, in the object's own frame, with the origin at its feet and +z its front. The solver bends elbows backward and knees forward. A point out of reach straightens the limb toward it. The solution is stored as ordinary joint angles, so renders never depend on solver state.

### What image and video models see

**Models see** on the Cast Card (`standIn` in `previs_director_perform`) is either:

- **Posed, as shown** (default): every capture shows the clip and pose you see.
- **Neutral grey stand-in**: blockout clips, still guides and frames show the figure in plain grey, in the stand pose, with no clip.

Reference-video models such as Seedance 2.5 · edit copy the blockout's limb poses, so a stiff or wrong pose comes back stiff or wrong. Use the stand-in when the figure's motion should come from the prompt rather than the blockout. The viewport always shows the posed figure.

### From Claude

`previs_director_perform({ projectId, object, shot?, at?, clip?, offset?, speed?, loop?, inPlace?, pose?, ik?, standIn? })`. Without `shot`/`at`, it sets the default. With `shot` (and optionally `at` seconds into it), it keys the change from that moment. `clip: null` stops the clip.

### Stale blockouts

The clip, its keys, offset and speed, poses and stand-in are all part of the shot's blockout signature. Changing any of them marks earlier blockouts and stills as out of date, as moving an object does. The model file is in the signature too. Licence and credit are not.

## Limits and refusals

| Limit | Value |
|---|---|
| Upload (file, zip or multi-file drop) | 200 MB |
| One file read from a path | 128 MB |
| Stored GLB | 96 MB |
| Triangles | 500,000 |
| Nodes · animations · textures · joints per skin | 8,000 · 64 · 64 · 512 |

Also refused: files that point outside their folder (`../`, absolute paths, `http:`/`file:` URIs) and Draco- or meshopt-compressed meshes (export without mesh compression). So are other required extensions three.js does not load, node trees with cycles, buffer views that run past the file, files with no triangles, and more than one model in a zip. URL imports must be https, including after redirects. The server parses files and never runs anything in them.

## Not yet

- **Gaussian splats** (`.ply` 3DGS, `.spz`, `.splat`). three.js 0.187 decodes them only for its WebGPU renderer, and the viewport is WebGL. Spark (`@sparkjs/spark`, MIT) is the likely route.
- **Animation-only files** (a Mixamo clip downloaded *without skin*) are refused. Their clips cannot yet be added to a character already in the scene.
- **USDZ skeletal animation**, KTX2/Basis textures, and Draco/meshopt decoding.
- **Library bundles** of imported models.

## Tested

On 2026-11-02:

- `tests/asset-import.test.mjs` (fixtures made in the test) and `tests/rig.test.mjs`.
- With `PREVIS_BLENDER` set: FBX, USDZ and OBJ+MTL exports of a rigged figure from `scripts/blender/build-rigged-test-asset.py`, on Blender 5.3.0 Alpha.
- By hand, outside the repo: a Mixamo X Bot FBX (49,112 triangles, 65 bones) imported, posed (stand, sit, IK reach) and rendered by the headless renderer into a blockout clip next to a clip-playing figure and a neutral stand-in. Mixamo files are not committed; their redistribution terms are unclear.
