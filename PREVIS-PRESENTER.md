# Presenter notes

Operator notes for a live demo of Comfy Previs. For setup see the [README](README.md); for the user guide see [docs/director.md](docs/director.md).

## Before you start

- Run `pnpm start` and open the URL it prints (default http://127.0.0.1:5190). Generation needs `COMFY_CLOUD_API_KEY` and `PREVIS_ALLOW_PAID=1` in `.env`; without them, quotes still show and nothing is sent.
- The public demo (GitHub Pages) is read-only. Use it as a fallback if the local server or Cloud is unavailable.
- Every paid run shows its inputs and an estimate and waits for approval. Estimates are list prices, not billing.

## Sixty seconds

1. **Home (0–10 s).** Four starters: **Final Lap**, **Wingspan**, **Posterized**, **Breaking News**. Open **Final Lap**.
2. **Build (10–25 s).** Orbit the oval; select the Comfy car and drag it. Open its Cast Card to show the primary image and design sheet. Groups (Ctrl/⌘ + G) keep the scene panel tidy.
3. **Shoot (25–40 s).** Select *The draft*. Show the camera row (move, lens, distance), **Preview**, and the auto-prompt with colour-linked chips. Click generate to show the quote; do not confirm unless you mean to spend.
4. **Cut (40–55 s).** Shots in order with their chosen versions. Drag the seam to compare blockout and generated video.
5. **Claude (55–60 s).** With the `comfy-previs` MCP connector, ask Claude for a shot (e.g. "Add a low tracking shot as the guard drives baseline"). Edits appear live and can be undone. Claude can quote, but you still approve every paid run.

## Jobs and live progress

The **Generation jobs** pip (shown once a project has requests) opens the jobs panel: every image and video request for this project, its status and estimate, and live progress where the backend reports it. A job marked **Outcome unknown** may already have been charged; check it, do not resubmit it.

## Camera devices

Keyboard flight always works (W/A/S/D, Q/E, Space/Shift, R records). Gamepad and phone are supported but **were not checked on physical hardware for this release**. For a live attempt: press a button so the browser sees the gamepad; for the phone, follow the README's HTTPS setup and pair from the camera panel. Keep the saved camera moves as the fallback.

## Known limits

- First-frame video models (LTX) start from a still and do not see the whole camera move; compare against the blockout to judge.
- Live progress on Comfy Cloud is not verified end to end; jobs still complete and attach without it.
- Generated text (signs, jerseys) can garble; the starters' prompts keep on-screen text to a single word.
