# After Hours: one LA hero shot

Original editable blockout: two creators, a plum hover coupe, LA River concrete and an interpretation of Sixth Street Bridge. One four-second camera move, fixed 24 mm lens, gentle car lift during the last two seconds. The 52 objects remain individually editable. This is a designed approximation, not an architectural scan.

## Prepare locally, without spending

Run the existing app and explicitly create a fresh project:

```sh
PREVIS_URL=http://127.0.0.1:5230 node scripts/prepare-after-hours.mjs
```

The script records the new project ID under `.evidence/comfy-after-hours/project.json` before editing it. It refuses to reuse that checkpoint or edit an existing project. Open the printed URL. Review the shot and **Render shot → Capture camera video**, choosing 1280×720. Four seconds means 96 frames at 24 fps; frame times are 0 through 95/24 seconds. Camera-key times in the scene model are normalized 0–1; object path times are seconds.

`reference-boards.mjs` creates original vector wardrobe and car design boards. They are appearance concepts, **not photographs or AI character stills**. Attach the Ink and Yellow boards to their matching character objects and the car board to the coupe. The current primitive people show blocking/colour; detailed clothing and lettering are reference-driven targets for the generated result. Their fidelity has not been qualified.

## H3 workflow

`h3-workflow.mjs` contains the original mapped workflow definition. Its ordinary API graph is `afterHoursH3.graph`; it can be exported as JSON and imported through **Advanced workflows**. Map:

| Role | Loader | Model connection |
| --- | --- | --- |
| Source video | `1.file` | `2.model.reference_videos.video_1` |
| Appearance image 1 | `11.image` | `2.model.reference_images.image_1` |
| Appearance image 2 | `12.image` | `2.model.reference_images.image_2` |
| Appearance image 3 | `13.image` | `2.model.reference_images.image_3` |
| Prompt | `2.model.prompt` | Literal text |
| Declared output | Node 3 | MP4 / H.264 |

The director registers the three visible object looks in the order shown beside the workflow. The prompt legend records that order: in the prepared demo it is car, Ink creator, Yellow creator. The authored graph is retained; no model or LoRA substitution is performed. The picker now exposes imported video task definitions instead of restricting choices to LTX.

Selected model: **MiniMax H3**, through **Comfy Cloud**, 768P, 16:9, four output seconds, seed 4242, watermark off. The complete source is supplied as Video 1, not reduced to its first frame. This is reference-video motion transfer, not a claim of deterministic geometric control. Native output dimensions may differ from the 1280×720 source, and H3 may generate stereo audio while the source is silent. Keep the full returned file and disclose all differences; do not fit or discard them automatically.

Live schema validation alone establishes neither execution nor creative acceptance. One owner-approved H3 run has now completed; see [the execution and visual qualification record](QUALIFICATION.md). The result is stylized, so it does not qualify the requested live-action appearance.

## Quote and approval

The live Cloud reference-node price badge gives a partner estimate range of **$0.7722–$2.4453 USD** for 768P, four output seconds, one reference video and three images. Its formula is output seconds × $0.1287, plus a reference-video charge between 2 and 15 seconds at that rate. Three images remain within the included five. This is price-badge evidence, not a billed total; Cloud runtime/account charges remain unresolved. The durable quote correctly retains `status: unknown`.

The owner approved **one H3 request, $3 USD allowance, explicitly accepting unresolved runtime/account charges, no retries**. That authorization was used for the recorded run and does not authorize another generation. An application allowance is not a provider-enforced cap. Stop if the bound source, prompt, references, model/settings, backend or live pricing changes; prepare a new quote and obtain fresh approval. **Review request & quote** does not upload or submit. Spending checkboxes start unchecked. The separate submission button dispatches at most once.

## Review criteria

- Camera: foreground creator clears the car; viewpoint and bridge parallax follow the source.
- Car: no horizontal drift, gentle lift at the authored time, stable shape and wheel count.
- People: exactly two adults, consistent wardrobe and clear Comfy wordmark, no identity swaps.
- Appearance: believable automotive materials, warm LA light and lavender haze; no added cuts, crowds, explosions or signage.
- Delivery: inspect decoded frame count, FPS, dimensions, duration and audio. Compare with the original source without concealing differences.

## Rights and sources

Scene, prompt, graph and vector board composition are original Previs work under the repository's MIT scope. The unmodified yellow Comfy wordmark used in local boards was obtained from <https://comfy.org/icons/logo.svg>; its trademark rights remain with Comfy Org. It is not relicensed under MIT. Follow <https://comfy.org/brand/> and do not imply official endorsement. The logo itself is not bundled in this tracked example. Existing inherited three-vcam distribution questions remain separate.

Model and node references: <https://www.minimax.io/blog/minimax-h3> and <https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_api_nodes/nodes_minimax.py>. Validate the selected backend's live schema before every submission.
