# Comfy Three Previs

**Open-source AI previs: 3D blockouts, consistent cast images, gamepad & phone camera, AI video.**

Block out a scene in 3D in your browser, give every character and prop a consistent look, frame the shot with a real camera (keyboard, gamepad or your phone), then turn the blockout into storyboard stills and AI video on Comfy Cloud. Built with three.js, Vite and Node.

**Live demo:** <https://sbobyn.github.io/comfy-three-previs/> — read-only. Image and video generation need a local install (below).

**Launch film:** <https://sbobyn.github.io/comfy-three-previs/launch-film.mp4> (also [square](https://sbobyn.github.io/comfy-three-previs/launch-film-1x1.mp4), [vertical](https://sbobyn.github.io/comfy-three-previs/launch-film-9x16.mp4) and [30 s](https://sbobyn.github.io/comfy-three-previs/launch-film-30s.mp4)).

## Features

- **3D blockout editor** — place, name, group and animate simple objects; keyframed camera moves per shot.
- **Cast Cards** — a description and reference images for every character, vehicle and prop. Generate images with AI, including design sheets (turnarounds and expressions), and pick a primary look.
- **Auto-prompts** — each shot prompt is written from the scene, with every object's words colour-linked to the object in the viewport.
- **Prompt inspector** — see the exact prompt each still and video model receives, section by section with where every part comes from (cast, shot description, style, camera rules, model-specific additions), what was left out to fit, and override, lock or leave out any section per shot. Versions of the final prompt and every take's prompt can be diffed. Model settings (seed, clip length and the like, from each model's registry entry) are saved on the shot with their estimate.
- **Storyboard stills** — image-to-image from the rendered blockout, so composition stays locked to your camera.
- **AI video on Comfy Cloud** — LTX 2.5 from your key frames, Seedance 2.5 and Kling O1 edits of the blockout clip, and Wan VACE on your own ComfyUI, with a model-input card showing exactly what each model receives. See [What models work today](#what-models-work-today).
- **Live camera** — keyboard, gamepad "drone" flying, or an iPhone as a handheld camera over local HTTPS.
- **Sequence, Compare & export** — play shots in order, compare versions side by side, export projects as portable `.previs.zip` files.
- **Claude connector (MCP)** — `server/previs/agent.mjs` lets you direct scenes from Claude Desktop or Claude Code; every edit shows up live in the app and can be undone.

## Quick start

You need **Node.js 22.12+** and **pnpm 10** (`corepack enable`). FFmpeg is needed to export camera videos.

```sh
git clone --depth 1 --single-branch https://github.com/sbobyn/comfy-three-previs.git
cd comfy-three-previs
pnpm install
pnpm build
cp .env.example .env      # optional: add COMFY_CLOUD_API_KEY for quotes and generation
pnpm start                # → http://127.0.0.1:5190 (PORT=… to change)
```

The shallow clone downloads about 40 MB. A plain `git clone` also downloads the live demo's `gh-pages` history, about 900 MB.

No key is needed to try it: open a starter, build, shoot, preview, watch the starter's videos and cut. A Comfy Cloud key adds quotes and generation; nothing paid runs unless `PREVIS_ALLOW_PAID=1`. `pnpm run doctor` checks your machine and explains how to fix anything missing.

### Plan a batch without spending

A dry run plans every still and video a batch would make, with its estimate, and sends nothing. It needs no key:

```sh
curl -s -X POST http://127.0.0.1:5190/api/director/batch -H 'content-type: application/json' \
  -d '{"projectId":"<id from the project URL>","steps":["stills","videos"],"tier":"draft","maxCostUsd":0,"dryRun":true}'
```

Claude does the same with `previs_director_batch_generate` and `dryRun: true`.

### Configuration (`.env`)

| Variable | What it does |
|---|---|
| `COMFY_CLOUD_API_KEY` | Your Comfy Cloud API key (comfy.org). Enables quotes and generation. |
| `PREVIS_ALLOW_PAID` | Set to `1` to allow paid generation. Default `0`; each run still shows a cost estimate first. |
| `PORT` | Server port. Default `5190`. |
| `PREVIS_DATA_DIR` | Where projects are stored. Default `.previs/` in the checkout. |
| `PREVIS_LIBRARY_DIR` | Where shared assets are stored. Default `PREVIS_DATA_DIR/library/`. Point several data dirs at one library to share it (one server at a time). |
| `PREVIS_COMFY_URL` | A local ComfyUI server, e.g. `http://127.0.0.1:8000`. |
| `PREVIS_FFMPEG`, `PREVIS_FFPROBE` | Full paths if FFmpeg is not on your `PATH`. |
| `PREVIS_PHONE_*` | Phone camera over HTTPS (see below). |
| `PREVIS_BUDGET_CAP_USD`, `PREVIS_BUDGET_PROJECT_CAP_USD` | Spending caps in USD for the account (per month by default) and for each project. Unset means no cap. |
| `PREVIS_BUDGET_MARGIN` | Safety margin added to every reservation, in percent (`10` or `10%`; default 10). It is held while a job runs and released when it settles; it is never part of a displayed price. |
| `PREVIS_ALLOW_UNKNOWN_COST` | Set to `1` to let models without a price estimate run. Default: they are refused. |

**Budget.** Every paid run (images, sheets, stills, videos, batches, and Claude's tools) first reserves its estimated cost in a ledger at `PREVIS_DATA_DIR/budget/`. A run that would go over a cap is refused before anything is sent. The reservation becomes spend when the job finishes, and is freed if the job never ran. If a job fails after it was sent, or its outcome is unknown, the reservation is kept for 24 hours (`PREVIS_BUDGET_RESERVATION_TTL_HOURS`) because a charge may still arrive. The Jobs panel shows how much is left and warns at 50%, 80% and 95%. You can change the caps while the server runs: `POST /api/budget/caps` with `{ "accountCapUsd": 15 }` or `{ "projectId": "…", "projectCapUsd": 5 }`, saved in `budget/config.json`. Other settings: `PREVIS_BUDGET_PERIOD` (`month`, `day` or `all`), `PREVIS_BUDGET_TZ`, and `PREVIS_BUDGET_DIR` (point two servers at one ledger so they share a budget). Amounts are estimates, because Comfy Cloud does not cap spending itself. An estimate is the list price plus the reference images the model is sent (the blockout guide counts; per-model assumptions are in `shared/tiers.mjs`) plus the paid still grader (reserved at $0.01 per graded still, when `PREVIS_MATCH_GRADER=gemini`; `GRADER_PRICES` in `shared/tiers.mjs`. Billing for the 2026-10-31 regeneration showed about $0.006 per grade, so this keeps a margin over it that `pnpm usage:settle` will show as under-spend). A reservation adds the safety margin on top (`PREVIS_BUDGET_MARGIN`, default 10%), and batch caps (`maxCostUsd`) are checked against reservations, so a plan that fits on list prices alone can still be refused. Dry runs and cap refusals show the parts (list, references, grader, margin), and the Jobs panel shows what is settled and what is still reserved. A request the provider refuses can still be billed: a FLUX.2 Pro request that moderation rejects settles at its output price instead of being forgotten. `pnpm usage:report` prints what the account was billed per model and per product, next to the ledger (default: yesterday; `-- --from 2026-10-29 --to 2026-10-31`). `pnpm usage:settle` (same options, plus `--granularity hour|day`) compares ledger entries with the billed hourly buckets by model and time window: Comfy's billing has no job IDs, so an entry gets its own variance only when it is alone on its model in that hour, shared hours report the window total, and entries without billing yet are "pending", not zero. Both only read data and need `COMFY_CLOUD_API_KEY`.

`.env` is git-ignored. Never commit it or paste keys into prompts or chat.

## Direct scenes from Claude (MCP)

With the app running, add the MCP server to Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "comfy-previs": {
      "command": "node",
      "args": ["/path/to/comfy-three-previs/server/previs/agent.mjs"],
      "env": { "PREVIS_URL": "http://127.0.0.1:5190" }
    }
  }
}
```

Or with Claude Code:

```sh
claude mcp add comfy-previs -e PREVIS_URL=http://127.0.0.1:5190 -- node /path/to/comfy-three-previs/server/previs/agent.mjs
```

Then ask Claude to build a scene. It can create projects, edit objects and Cast Cards, write shots and cameras, quote generations and run them. Paid tools do not ask you again: each call carries a `maxCostUsd` that Claude sets and the run is skipped when the estimate is higher, and nothing paid runs unless the server has `PREVIS_ALLOW_PAID=1`. Models without a price estimate are refused unless the call passes `allowUnknownCost` and the server runs with `PREVIS_ALLOW_UNKNOWN_COST=1`. Every run also counts against the server's budget caps (see Configuration). Tell Claude your budget, or leave `PREVIS_ALLOW_PAID` at `0` to keep it to free work and quotes.

To bring a shot in from Blender (camera, tagged objects and rendered frames as the shot's blockout), Claude uses `previs_director_blender_helper` and `previs_director_import_blender`; see [Import a Blender shot](docs/blender-import.md).

Claude reads and edits the same prompt sections and model settings as the workspace: `previs_director_prompt_sections` returns the exact final prompt by section, `previs_director_set_prompt_section` overrides, locks or resets one section, `previs_director_prompt_history` diffs versions and takes, and `previs_director_model_settings` reads or saves the shot's model and parameters.

Claude sees the director tools (`previs_director_*`) and the asset library tools (`previs_library_list`, `_save`, `_place`, `_import`, `_export`), so "put @red-racecar at the start line" places a saved car in the current project. The older engine, Blender and raw-workflow tools (`previs_render_animation`, `previs_submit_passthrough` and the like) are listed only when the MCP server runs with `PREVIS_MCP_LEGACY=1`; their Blender, transfer, raw Comfy and handoff routes also need the app started with `PREVIS_LEGACY_ROUTES=1`.

## Phone camera

Your phone streams its orientation to the app over HTTPS on your local network.

1. Create a local certificate (nothing is installed or trusted automatically):

   ```sh
   node scripts/phone-certificate.mjs ./phone-cert 192.168.x.y   # your computer's LAN IP
   ```

2. Add to `.env` and restart:

   ```sh
   PREVIS_PHONE_HOST=192.168.x.y
   PREVIS_PHONE_PORT=5443
   PREVIS_PHONE_CERT=/path/to/phone-cert/server.crt
   PREVIS_PHONE_KEY=/path/to/phone-cert/server.key
   PREVIS_PHONE_CA=/path/to/phone-cert/ca.crt
   ```

3. Install `ca.crt` on the phone, then pair from the camera panel. Details: [device controls](docs/device-controls.md).

## Starters

Open one from the home page and make it yours: **Breaking News** (a news anchor breaks the story of this launch), **Wingspan** (an eagle dives through an alpine valley), **Final Lap** (the Comfy car wins on the last lap) and **Posterized** (a dunk in a packed arena), or start from an empty stage. Each opens with every cast member's image and design sheet, stills, a blockout clip and a generated video for each shot, and a cut. The media is in the repo (about 32 MB, see [examples/starters](examples/starters/README.md)), so nothing is downloaded or generated.

When a starter's blocking has changed since its stills and videos were made, it says so when you open it and marks those videos "older"; generating makes matching ones. If its media files are not in your checkout, it opens as a blockout and says that instead. A starter's blockout clip is for watching: generating first makes the shot's own blockout (free, in the browser).

## Asset library

Save any object to reuse it in other projects: select it and choose **Save to library** under Appearance (or ask Claude, `previs_library_save`). The object comes with everything grouped under it, its description, style notes, primary cast image and design sheets. The library lives in `PREVIS_DATA_DIR/library/`, outside any project, so archiving a project keeps it. In another project, open **Library → Shared assets** and choose **Place**, or tell Claude "put @red-racecar at the start line". A placed object answers to its @handle; a second copy becomes `@red-racecar-2`. Saving an object again makes a new version.

To share an asset, **Export** writes one `<handle>.previs-asset.zip`. Drop it on the home page's **Import…** (it goes to the library, not a new project), use **Import asset…** in the Library dialog, or have Claude run `previs_library_import` with its path. Claude can also take one object out of a colleague's `.previs.zip` project export, or out of a Blender export (the folder `previs_export.py` writes) with its optional viewport mesh and no images yet (the folder or a zip of it, read by the same importer as **Import Blender shot…**). Bundles hold `asset.json` and `refs/` images (PNG, JPEG, WebP up to 10 MB each) plus optional validated GLB blockout meshes (2 MB/20,000 triangles each; 32 MB/100,000 triangles total). A bundle holds at most 64 MB and 50 objects. They contain no local paths, job ids or keys, and imports refuse anything else.

## What models work today

These are the built-in presets; the table is generated from them (`pnpm docs:models`). Estimates are list prices; every run shows its own quote first.

<!-- models:start (generated by scripts/models-table.mjs; do not edit by hand) -->
| Model | Used for | Runs on | Takes | List-price estimate |
|---|---|---|---|---|
| Flux 1.1 [pro] Ultra | Looks, sheets and stills | Comfy Cloud | prompt, blockout frame (stills) | ≈ $0.060 / image |
| FLUX 3 Image (BFL) | Looks, sheets and stills | Comfy Cloud | prompt, up to 9 cast images, blockout frame (stills) | ≈ $0.066 / image |
| Flux.2 [pro] (BFL) | Looks, sheets and stills | Comfy Cloud | prompt, up to 7 cast images, blockout frame (stills) | ≈ $0.028 / image |
| Flux.2 [max] (BFL) | Looks, sheets and stills | Comfy Cloud | prompt, up to 7 cast images, blockout frame (stills) | ≈ $0.071 / image |
| GPT Image 2.5 (OpenAI) | Looks, sheets and stills | Comfy Cloud | prompt, up to 9 cast images, blockout frame (stills) | ≈ $0.076 / image |
| Seedream 5.0 Pro (ByteDance) | Looks, sheets and stills | Comfy Cloud | prompt, up to 9 cast images, blockout frame (stills) | ≈ $0.045 / image |
| Nano Banana Pro (Gemini 3 Pro Image) | Looks, sheets and stills | Comfy Cloud | prompt, up to 9 cast images, blockout frame (stills) | ≈ $0.16 / image |
| Nano Banana 2.1 (Gemini) | Looks, sheets and stills | Comfy Cloud | prompt, up to 9 cast images, blockout frame (stills) | ≈ $0.050 / image |
| Nano Banana 2 (Gemini 3.1 Flash Image) | Looks, sheets and stills | Comfy Cloud | prompt, up to 9 cast images, blockout frame (stills) | ≈ $0.081 / image |
| Local ComfyUI · installed checkpoint | Looks, sheets and stills | Your ComfyUI | prompt, blockout frame (stills) | free (your GPU) |
| LTX 2.5 Pro · start → end key frames | Video from key frames | Comfy Cloud | start key frame, end key frame, prompt | ≈ $0.17 / s |
| LTX 2.5 Pro · animate the key frame | Video from key frames | Comfy Cloud | start key frame, prompt | ≈ $0.17 / s |
| LTX 2.5 Fast · animate the key frame (draft) | Video from key frames | Comfy Cloud | start key frame, prompt | ≈ $0.13 / s |
| Seedance 2.5 · from the start still (reference) | Video from key frames | Comfy Cloud | start key frame, prompt | ≈ $0.33 / s |
| Seedance 2.5 · start → end stills | Video from key frames | Comfy Cloud | start key frame, end key frame, prompt | ≈ $0.33 / s |
| Kling 4.0 · animate the start still | Video from key frames | Comfy Cloud | start key frame, prompt | ≈ $0.22 / s |
| Kling 4.0 · start → end stills | Video from key frames | Comfy Cloud | start key frame, end key frame, prompt | ≈ $0.22 / s |
| Veo 3.1 · animate the start still | Video from key frames | Comfy Cloud | start key frame, prompt | ≈ $0.20 / s |
| Veo 3.1 · start → end stills | Video from key frames | Comfy Cloud | start key frame, end key frame, prompt | ≈ $0.20 / s |
| MiniMax Hailuo H3 · animate the start still | Video from key frames | Comfy Cloud | start key frame, prompt | ≈ $0.13 / s |
| MiniMax Hailuo H3 · start → end stills | Video from key frames | Comfy Cloud | start key frame, end key frame, prompt | ≈ $0.13 / s |
| Wan 2.7 · animate the start still | Video from key frames | Comfy Cloud | start key frame, prompt | ≈ $0.10 / s |
| Wan 2.7 · start → end stills | Video from key frames | Comfy Cloud | start key frame, end key frame, prompt | ≈ $0.10 / s |
| Seedance 2.5 · edit the complete video | Video from the blockout clip | Comfy Cloud | blockout video, prompt | ≈ $0.40 / s |
| Kling O1 · edit the complete video | Video from the blockout clip | Comfy Cloud | blockout video, prompt | ≈ $0.13 / s |
| Wan VACE 1.3B · edge control alternative | Video from the blockout clip | Your ComfyUI | blockout video (as control frames), prompt | free (your GPU) |
<!-- models:end -->

## Guide

[Build · Cast · Shoot · Generate · Cut](docs/director.md) — the user guide, with captured examples. The in-app **Guide** adds interactive viewport examples and before/after comparisons. Also: [phone and gamepad](docs/device-controls.md), [glossary](docs/glossary.md). The other files in `docs/` are dated engineering and review notes ([list](docs/history/README.md)); their links into `.evidence/` point at files that are not published.

## Development

```sh
pnpm check     # typecheck + build
pnpm test      # node --test
```

The server is plain Node (`server/previs/`), the browser app is Vite + three.js (`src/`), and shared scene logic lives in `shared/`.

### Publishing

`scripts/publish-public.sh` publishes the committed tree to the public repo and redeploys the live demo with the latest launch film. It runs the gate and a secret scan first, adds one commit to public `main` (the tree, not the history) and one to `gh-pages` (`pnpm run demo:build` from a temporary read-only server, plus `launch-film*.mp4` from the newest `.evidence/launch-film/v*/`), then checks the Pages build and loads the demo in headless Chrome. It never force-pushes. Settings are environment variables listed at the top of the script (`TRAILER_DIR`, `SOURCE_DATA`, `DRY_RUN=1`, …).

The demo shows the bundled starters: the publish script runs `starters:import --force` on its copy of the data, and `pnpm demo:build` snapshots those source projects and fails if any differs from its bundle in `examples/starters` (scene, models, cameras, stills, clips or cut). The demo snapshot keeps each shot's Cut selection, current key stills and blockouts, cast looks and sheets, and their input media and generation receipts. Archived projects and `Regen …` scratch projects are excluded. Images become WebP derivatives bounded to 1280 pixels on both axes; videos, source files and generation settings are unchanged. Derivative metadata records both original and published hashes, dimensions and paths. Snapshotting needs FFmpeg and ffprobe (`PREVIS_FFMPEG` / `PREVIS_FFPROBE`); missing media or a snapshot over `DEMO_MEDIA_MB` (default 400 MiB) fails the build instead of dropping files. `demo-data/snapshot-manifest.json` records every copied file and the measured media size. Build into a fresh output directory before snapshotting again. Publishing's `DRY_RUN=1` still fetches remote refs, although it does not push.

## License

MIT — see [LICENSE](LICENSE). Third-party components and their licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and `third-party-licenses/`.
