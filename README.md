# Comfy Three Previs

**Open-source AI previs: 3D blockouts, consistent cast images, gamepad & phone camera, AI video.**

Block out a scene in 3D in your browser, give every character and prop a consistent look, frame the shot with a real camera (keyboard, gamepad or your phone), then turn the blockout into storyboard stills and AI video on Comfy Cloud. Built with three.js, Vite and Node.

**Live demo:** <https://sbobyn.github.io/comfy-three-previs/> — read-only. Image and video generation need a local install (below).

**Launch film:** <https://sbobyn.github.io/comfy-three-previs/launch-film.mp4> (also [square](https://sbobyn.github.io/comfy-three-previs/launch-film-1x1.mp4), [vertical](https://sbobyn.github.io/comfy-three-previs/launch-film-9x16.mp4) and [30 s](https://sbobyn.github.io/comfy-three-previs/launch-film-30s.mp4)).

## Features

- **3D blockout editor** — place, name, group and animate simple objects; keyframed camera moves per shot.
- **Cast Cards** — a description and reference images for every character, vehicle and prop. Generate images with AI, including design sheets (turnarounds and expressions), and pick a primary look.
- **Auto-prompts** — each shot prompt is written from the scene, with every object's words colour-linked to the object in the viewport.
- **Storyboard stills** — image-to-image from the rendered blockout, so composition stays locked to your camera.
- **AI video on Comfy Cloud** — LTX 2.5 from your key frames, Seedance 2.5 and Kling O1 edits of the blockout clip, and Wan VACE on your own ComfyUI, with a model-input card showing exactly what each model receives. See [What models work today](#what-models-work-today).
- **Live camera** — keyboard, gamepad "drone" flying, or an iPhone as a handheld camera over local HTTPS.
- **Sequence, Compare & export** — play shots in order, compare versions side by side, export projects as portable `.previs.zip` files.
- **Claude connector (MCP)** — `server/previs/agent.mjs` lets you direct scenes from Claude Desktop or Claude Code; every edit shows up live in the app and can be undone.

## Quick start

You need **Node.js 22.12+** and **pnpm 10** (`corepack enable`). FFmpeg is needed to export camera videos.

```sh
git clone https://github.com/sbobyn/comfy-three-previs.git
cd comfy-three-previs
pnpm install
pnpm build
cp .env.example .env      # then fill in COMFY_CLOUD_API_KEY
pnpm start                # → http://127.0.0.1:5190
```

`pnpm run doctor` checks your machine and explains how to fix anything missing.

### Configuration (`.env`)

| Variable | What it does |
|---|---|
| `COMFY_CLOUD_API_KEY` | Your Comfy Cloud API key (comfy.org). Enables quotes and generation. |
| `PREVIS_ALLOW_PAID` | Set to `1` to allow paid generation. Default `0`; each run still shows a cost estimate first. |
| `PORT` | Server port. Default `5190`. |
| `PREVIS_DATA_DIR` | Where projects are stored. Default `.previs/` in the checkout. |
| `PREVIS_COMFY_URL` | A local ComfyUI server, e.g. `http://127.0.0.1:8000`. |
| `PREVIS_FFMPEG`, `PREVIS_FFPROBE` | Full paths if FFmpeg is not on your `PATH`. |
| `PREVIS_PHONE_*` | Phone camera over HTTPS (see below). |

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

Then ask Claude to build a scene. It can create projects, edit objects and Cast Cards, write shots and cameras, quote generations and run them. Paid tools do not ask you again: each call carries a `maxCostUsd` that Claude sets and the run is skipped when the estimate is higher, and nothing paid runs unless the server has `PREVIS_ALLOW_PAID=1`. Models without a price estimate are refused unless the call passes `allowUnknownCost`. Tell Claude your budget, or leave `PREVIS_ALLOW_PAID` at `0` to keep it to free work and quotes.

Claude sees the director tools (`previs_director_*`). The older engine, Blender and raw-workflow tools (`previs_render_animation`, `previs_submit_passthrough` and the like) are listed only when the MCP server runs with `PREVIS_MCP_LEGACY=1`; their Blender, transfer, raw Comfy and handoff routes also need the app started with `PREVIS_LEGACY_ROUTES=1`.

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

Open one from the home page and make it yours: **Breaking News** (a news anchor breaks the story of this launch), **Wingspan** (an eagle dives through an alpine valley), **Final Lap** (the Comfy car wins on the last lap) and **Posterized** (a dunk in a packed arena), or start from an empty stage. Each opens finished: every cast member's image and design sheet, a still, the blockout clip and a generated video for each shot, and a cut. The media is in the repo (about 34 MB, see [examples/starters](examples/starters/README.md)), so nothing is downloaded or generated.

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

[Build · Cast · Shoot · Generate · Cut](docs/director.md) — the user guide, with captured examples. The in-app **Guide** adds interactive viewport examples and before/after comparisons.

## Development

```sh
pnpm check     # typecheck + build
pnpm test      # node --test
```

The server is plain Node (`server/previs/`), the browser app is Vite + three.js (`src/`), and shared scene logic lives in `shared/`.

### Publishing

`scripts/publish-public.sh` publishes the committed tree to the public repo and redeploys the live demo with the latest launch film. It runs the gate and a secret scan first, adds one commit to public `main` (the tree, not the history) and one to `gh-pages` (`pnpm run demo:build` from a temporary read-only server, plus `launch-film*.mp4` from the newest `.evidence/launch-film/v*/`), then checks the Pages build and loads the demo in headless Chrome. It never force-pushes. Settings are environment variables listed at the top of the script (`TRAILER_DIR`, `SOURCE_DATA`, `DRY_RUN=1`, …).

## License

MIT — see [LICENSE](LICENSE). Third-party components and their licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and `third-party-licenses/`.
