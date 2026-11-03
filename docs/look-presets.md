# Look presets and variants

Choose a shot's scene, setting and lighting as parameters before a still or video is made, then fan one shot out into
variants that each change **one thing**. This is the Look Lab idea (examples/starters, Look Lab) as a product feature.

Code: `shared/look-presets.mjs` (catalog, composition, variants, edit prompt, model suggestions), `shared/look-variants.mjs`
(the variant still request, adding variant shots), `src/director-look-presets.ts` (the Look block),
`server/previs/agent-look-tools.mjs` (MCP). Tests: `tests/look-presets.test.mjs`, `tests/look-tools.test.mjs`.

## Presets

| Axis | Presets |
|---|---|
| Time of day | dawn, golden hour, harsh noon, blue hour, night |
| Weather | fog, heavy rain, snowstorm, overcast |
| Season | cherry-blossom spring, summer, peak autumn, winter |
| Lighting mood | soft, high key, low key, warm, cool |
| Wardrobe or era | 1950s, cyberpunk, workwear, formal evening, raincoat, winter coat (a character lead only) |
| Art style | photoreal, anime, claymation, 3D animated, watercolour |
| Subject swap | per object: what it is instead ("the eagle → a red-tailed hawk") |

A look is stored as structured fields: `shot.look = { time: 'night', style: 'anime', subjects: { <objectId>: 'a hawk' } }`, and
a project default at `project.look`. A shot inherits each axis from the project default; `'none'` on a shot clears it. Edit ops:
`update_shot { patch: { look } }`, `set_project { patch: { look } }`, `add_variants { shotId, axes, combine? }`.

## How a look reaches the prompt

Presets act as prompt-section overrides **under** anything you typed (shared/prompt.mjs `sectionOverrides`): your own section
text always wins. They set the format line (art style), the world ("Set: the same scene at night, …"), the look ("Look:
photoreal, night, warm lamplight, …") and the lead's Cast Card (the new clothes, or a swapped subject). The look line always
ends with the explicit negative **"No logos, badges, car emblems or readable text."** A wardrobe or subject change keeps the
project's own look text, so nothing else moves. The camera line repaints the blockout in the art style's medium.

**Length budget.** A video prompt keeps to its model's auto-prompt cap (600 characters). When the full preset text does not fit,
shorter forms are tried in turn (compact → tight → minimal). Every single preset fits on every blockout starter shot. A shot
whose own required text (action, lead, camera rule, reference legend) already fills the budget — some finished-starter shots
— keeps the look and the plan reports `lookWarning`; the prompt stays within the model's hard limit.

## Regeneration

Still and video manifests record one `preset:<axis>` part per set axis (and `preset:subject:<objectId>`), only when set, so
outputs made without presets keep their keys. Changing a preset makes only that shot's still and video out of date, with a
reason such as "Time of day preset changed (Night → Dawn)"; it is never a blocking change, so the blockout stays. A project
default dirties the shots that inherit that axis. An older output with no manifest (a starter's) is out of date once its shot has
a look ("look presets were set after it was made"). See docs/regeneration.md.

## Variants: one change at a time

`add_variants` copies a base shot — same camera, timing, blocking, description, style tags and section text — once per value,
each changing only that axis (`base × {night, winter, claymation}` makes three shots titled "… · Night (vs base)"). Every
combination is made only with `combine: true`. An identical variant is reused. The UI and the agent always say which attribute
differs from the base, and warn when a variant differs on more than one.

**Stills are edits of the base still.** Image 1 is the base shot's still at the same moment (refgen `guideReferenceId`), then the
cast's images (except a swapped subject's), then an optional style reference. The prompt says "Change only this: the time of
day: make it night … Keep everything else exactly as in image 1: the camera, framing and composition; every person's face, hair,
build, pose and clothes; every vehicle, building and prop …". The still's manifest records the base still (`base`), so a new base
still makes its variants out of date and a variant never dirties its base.

**Models** (what Look Lab v2 showed, 2026-11-03):

| | Model | Why |
|---|---|---|
| Variant still | Nano Banana 2.1 (`nano-banana-2-1`) | an edit model that keeps identity; anime only went truly 2D on it **without** a style reference |
| Claymation still | Nano Banana 2.1 + a clay still as style reference | the newest still of a claymation shot in the project |
| Video, character lead | Seedance 2.5 edit | kept the walker's pace frame by frame |
| Video, no character | Kling O1 edit | a third of the price; it rushes a walking character ahead of the blockout (the plan says so) |

A variant has the base's blocking, so its blockout clip is identical; the batch notes it ("Same blocking as the base") and renders
it free on the server. (Each shot still keeps its own clip record: a video attaches to its own shot through it.)

**One quote.** `previs_director_batch_generate` with `variants: { shot, axes, combine?, includeBase? }` and `steps` plans every
variant's still and video in one batch: a dry run is a preview on a copy of the project (nothing is added, and it cannot be
resumed); a run adds the variant shots, then makes them. The Look block shows a price per variant before you quote.

A smoke test on 2026-11-03 (one still, $0.058 list) turned Look Lab's summer-day still into night with the same framing, walker,
clothes, car, bench and tree (.evidence/look-presets-smoke.png, not in git).
