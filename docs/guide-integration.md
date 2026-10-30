# Guide integration and capture

## Interfaces for W1/W3

`openJourney({ stage?, context?, actions? })` and `JOURNEY` remain exported by `src/director-guide.ts`. The five ids are **build, cast, shoot, generate, cut**. Actions only navigate; opening the guide never starts work. Old ids remain accepted for the existing caller: scene→build, looks→cast, shot→shoot, capture/workflow→generate, compare/export→cut. When both old actions are present, the first matching old action wins; W1 should supply the five new actions directly.

In `director.ts` `renderHelp`, wrap each Controls group with `section[data-explain]`, create a `.help-explain` host, and call `mountExplainer(host, id)` from `director-explain.ts`. Dispose the returned handle before rebuilding or removing the host. Ids: `navigate`, `select`, `transform`, `groups`, `animate`, `fly`, `camera-rig`; `EXPLAINERS` also provides titles and group names. The rig explainer demonstrates distance, height, angle and lens; mounting it beside those controls is W1 integration. Camera-help exports remain unchanged.

Other exports: `keyboardDiagram()`, `gamepadDiagram('game'|'drone')`, `phoneDiagram()`, `phonePairDiagram()` and `modelInputsDiagram(task, { twoFrames?, castImages? })`. W1 can mount input diagrams in the video-model card; W3 can mount device diagrams in Fly camera/phone panels. All diagrams already appear where applicable inside the guide. The model-input diagram is available for integration, not mounted in the guide.

`director-media.ts` exports `beforeAfter({ before, after, kind: 'image'|'video', labels?, posters?, alt? })` and `loopClip({ src, poster?, alt })`. Each returns a DOM element with `dispose()`; call it when removing that element to stop playback and release observers/listeners. `guideManifest()` and `guideUrl(file)` resolve media under the deploy base. W3 can reuse these on home/empty-state surfaces without copying assets. Reduced motion disables autoplay and seam sweeps; explicit Play remains available. Explainers share one lazy renderer, pause off screen/when hidden and release the renderer after idle.

## Recapture existing media

With a local server using disposable starter data and paid generation disabled:

```sh
node scripts/guide-media.mjs --base http://127.0.0.1:5276 --out .evidence/guide-capture-new
```

Use a fresh output directory: the script refuses to overwrite existing media. It reads saved assets and captures page screenshots, without submitting generation. Opening Generate can request a free quote. Review the output before replacing shipped media in a separately authorized task. `--no-screens` skips the browser; `--all` includes every shot with saved results. `PREVIS_FFMPEG` and `PREVIS_CHROMIUM` select binaries. Browser capture requires `playwright-core` and hardware GPU rendering.

The manifest includes provenance, sizes, guide aliases and missing-media notes. Clips are H.264 640×360, at most 1 MiB each; the folder limit is 12 MiB. Images are WebP. Existing capture includes one design sheet per starter, not every sheet type (J12). Screenshots reflect the capture-time UI and should be refreshed after W1/W3 integration. No recapture or generation was performed during Astra recovery.

## Recovery verification

Run `pnpm check` (typecheck and both Vite builds), `node --test tests/*.test.mjs`, and the recovery browser script recorded under `.evidence/ux-audit/W4/`. The browser checks use the actual home Guide at 880/1280/1600, every explainer tab, reduced-motion stills, seam keys, video playback/sync, native Escape/Tab and focus return. No standalone HTML entry is needed.

Historical docs are indexed under `docs/history/README.md`; moving their existing files is deferred because this recovery forbids deletion. Workspace hook edits remain with W1/W3; this workstream does not edit their source.
