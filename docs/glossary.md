# Glossary

One name per thing, used the same way in the app, the docs and the film. When a UI string and this page disagree, change the string.

## The steps

| Term | Meaning | Not |
|---|---|---|
| **Build** | Place objects in the 3D scene and give the cast their images. | Edit, Design |
| **Shoot** | Frame each shot through the shot camera, or fly it live. | Direct, Camera tab |
| **Cut** | Put the shots in order, pick each shot's version, trim, export the film. | Edit, Sequence, Timeline |

## Scene and cast

| Term | Meaning | Not |
|---|---|---|
| **Object** | Anything placed in the scene (a person, a car, a prop, a wall). | Entity (code only), Item |
| **Cast** | The objects in a shot. The shot camera decides by default; ticks override it. | Cast list, Roster |
| **Hero cast** | The cast that matters to the story: the shot's subject, then characters, vehicles and props. Listed first under "In this shot". | Main objects |
| **Set** | The environment pieces in frame (track, stands, grass). Folded into one group. | Set pieces, Scenery |
| **Cast image** | The picture of an object that is sent to image and video models. The first one is the **primary** cast image. | Look, Cast Card image, Reference (code only) |
| **Shared image** | One cast image used by several objects. Shown once, as "× N objects", and folded into one row ("Turns 3–4 · surface ×12"). | Look family (code only), Shared look |
| **Description** | What an object is, in words. It goes into the auto-prompt. | Notes, Cast Card |
| **Project style** | The look of the whole film ("35 mm anamorphic, teal-and-orange grade"). | Style board |
| **Shared asset** | An object saved to this computer's library with its description, cast images and design sheets, ready to **Place** in any project. **Save to library** makes one; **Export** writes it as one `.previs-asset.zip`. | Library asset (code: asset), Prefab, Template |
| **@handle** | The short name an object or shared asset answers to (`@red-racecar`), made from its name. In the scene first, then the library. | Tag, Slug |
| **Imported model** | An object whose mesh came from a 3D file (GLB, glTF, FBX, OBJ, STL, PLY, USDZ) by drop, **Import model…** or Claude. Its Cast Card keeps the file, **Licence** and **Credit**. See [Import a 3D model](import.md). | Asset (that is a shared asset), Upload |
| **Backdrop card** | An image standing in the scene as an upright, unlit card (a sky, a location photo). Shift-drop an image or **+ Add ▾ → Backdrop card…**. | Billboard, Plate (that is a background video) |
| **Clip** | An animation stored in an imported model's file (Walk, Wave). An object plays one at a time, with an offset and speed, and can switch clips from a shot's start. | Action, Animation, Take |
| **Pose** | Joint angles of a figure: the bundled people and birds, or an imported humanoid. **Stand**, **walk**, **run**, **sit**, **jump**, **point** and **wave** are library poses. | Posture, Keyframe |
| **Stand-in** | What image and video models see of an imported figure: *posed, as shown*, or a *neutral grey stand-in* in the stand pose. | Proxy (that is the plain shape of an object without a mesh), Mannequin |

"Cast Card" is the old name for an object's description plus its cast images. It survives only in code and in the auto-prompt's source labels; do not use it in new UI.

## Shots and media

| Term | Meaning | Not |
|---|---|---|
| **Shot camera** | The camera that films the shot. "Director view" is the free camera for building. | Render camera |
| **Fly camera** | Drive the shot camera live (keys, gamepad, phone) and record a take. | Live camera |
| **Blockout** | The grey clip filmed through the shot camera at 24 fps: the motion every video model follows. **Make blockout** the first time, **Remake blockout** after a change. | Render, Capture, Previs clip, "Make again" |
| **Still** | A generated image of one moment of a shot. A **start still** and an **end still** are the key frames some video models animate between. | Key frame image, Frame |
| **Auto-prompt** | The prompt the app writes from the story, cast, world and camera. You can edit it. | Generated prompt |
| **Video model** | The model that makes the shot's video (LTX, Seedance, Kling …). **Runs on** says where: Comfy Cloud or local ComfyUI. | Workflow (code only), Preset |
| **Version** | One generated video of a shot. The cut uses one version per shot ("Newest" by default). Repeated runs of the same model are **takes** ("LTX 2.5 Fast · take 2"). | Result, Output |
| **Out of date** | An output whose inputs changed since it was made: the camera or timing, an object its blockout frames can show, its prompt, a cast image, its model or its seed. Hover the badge for what changed. Moving an object no frame shows changes nothing. **Inputs changed** means the still is still sent to video models but a batch makes it again. | Stale (code only), Dirty |
| **Pin** | Accept a still, video take or cast image as it is: it is never out of date and a batch keeps it. **Pinned** to undo. | Lock, Freeze |
| **Only what changed** | How batches run: an output is made again only when its inputs changed (or something it is made from is made again). `force` remakes anyway. See docs/regeneration.md. | Incremental, Cache |

## Generating and spending

| Term | Meaning |
|---|---|
| **Generate** | Make a still or a video. Always shows a **quote** first; nothing runs until you **approve** it. |
| **Estimate** | Rate × length, shown before the quote ("≈ $0.69"). Cloud bills actual usage, so an estimate and an allowance are not a hard cap. |
| **Allowance** | The most you approve for one request or batch. Claude sets one per request (`maxCostUsd`); paid runs need the server started with `PREVIS_ALLOW_PAID=1`. |
| **Budget** | The server's caps across all requests: `PREVIS_BUDGET_CAP_USD` (account, per month by default) and `PREVIS_BUDGET_PROJECT_CAP_USD` (per project). Each paid run reserves its estimate (list price + reference images + the paid grader, plus a `PREVIS_BUDGET_MARGIN` safety margin, 10% by default) first and is refused if that would pass a cap; the refusal lists those parts. Unpriced models are refused unless `PREVIS_ALLOW_UNKNOWN_COST=1`. The Jobs panel shows what is left, settled and reserved. |
| **Usage report** | `pnpm usage:report`: what Comfy Cloud billed per model and per product for a date range, next to the local budget ledger. Read-only. |
| **Usage settle** | `pnpm usage:settle`: the ledger matched to billed hourly buckets by model and time window, with the variance. Billing has no job IDs, so only an entry alone on its model in its hour gets its own variance; shared hours show the window total and nothing is invented. Read-only. |

## In the Cut viewer

| Term | Meaning |
|---|---|
| **Compare** | One frame split into bands: blockout · start still · each version, labelled by model, with draggable seams. |
| **Overlay** | Boxes around the hero cast as the shot camera sees them, each linked to its cast image and its words in the prompt; the generated frame fades in under the same boxes. |
| **Export film** | One H.264 file of the cut, 1280×720 at 24 fps. |

## Wording rules

- Verbs on buttons: **Make** for free local work (Make blockout), **Generate** for model runs (Generate still, Generate video), **Remake** to redo either kind of local work.
- One primary action per screen, in the CTA colour (`--cta`, ink on paper) on desktop and mobile. Coral (`--accent`) is kept for the live camera: Fly camera, record and the shutter.
- Say what will happen and what it costs; never say "approval required" where the server would spend without asking.
