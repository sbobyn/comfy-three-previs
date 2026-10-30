# Director user guide

The director workspace is where you block out one scene, plan its shots, and send camera renders to ComfyUI.

## 1. Start or open a project

The launch page (`http://127.0.0.1:5190`) shows:

- **Setup**: what's ready on this machine (FFmpeg, Cloud key, local ComfyUI…). Fix any ✗ items first.
- **New project**: name it, then **Start empty** or pick a starter project (Breaking News, Wingspan, Final Lap, Posterized). Starters are full multi-shot scenes you can change freely; see `examples/starters/`.
- **Open project**: your projects, newest first. **⋯** gives you Export, Duplicate and Archive. **Import project…** loads a `.previs.zip`, and **Archived** lets you restore archived projects.

## 2. Block out the scene

- **Drag** an object to move it. Drag empty space to orbit. **F** frames everything.
- **+ next to Scene** adds an object (person, car, box, table, building, tree…).
- Click an object to open its panel. From there you can rename it, change its type, colour, facing, size or height, add notes, aim the camera at it, or open its **Looks**.
- Keys: **R** rotates the selected object, **Delete** removes it, **Esc** deselects.

## 3. Direct in plain language

The **Direct** tab is a chat about the current shot. Type `@` to mention an object. Drop, paste or attach images to add them as references for that shot.

- **Built-in agent** (pill reads **Agent ready**): when Claude Code is installed on this Mac and signed in (`claude` once in a terminal), Previs runs it for you with Previs tools only, on your existing login. No terminal, no API key. Questions and prompt requests are answered in the thread (**Copy**, **Use as shot prompt**); scene, shot, camera and animation changes arrive as a **proposed changes** card you **Apply** or **Discard** (one undo step). A one-line change to an existing object or shot applies straight away with **Undo** (switch that off on the card). **Stop** interrupts a turn; a failed turn offers **Retry**. The agent cannot render or spend money. Set `PREVIS_AGENT=off` to disable it, `PREVIS_AGENT_MODEL` to pick the model (default `sonnet`), `PREVIS_CLAUDE_PATH` if `claude` is somewhere unusual.
- **Your agent (MCP)** (pill reads **Agent connected**): your own Claude Code / Codex / MCP client reads each message, edits the scene live and replies. Click the pill for setup steps; choose **Your agent (MCP)** in the composer's route menu.
- Without either, the **built-in parser** handles phrases like:
  - `add a red car on the left` · `put a detective next to the car facing the runner`
  - `slow dolly in on @runner, 50mm, low angle` · `orbit around the car over 4 seconds`
  - `new shot: wide establishing crane up` · `environment: rainy neon alley`
  - Story sentences, such as `the runner sprints past the car`, are added to the shot description.

## 4. Shots and camera

- The **Shots** list on the left has a live thumbnail per shot. **+** adds a shot.
- The **Shot** tab holds the title, description, camera move, target, duration (up to 5 s), lens, distance, height and angle. **Set start/end from view** turns the current orbit view into custom camera keys.
- The camera's path and frame show in the set. The **SHOT CAM** monitor is the actual camera view; click it (or press **C**) to look through the camera. **Space** plays the shot.

### Operate the camera (gamepad, keyboard, phone)

The **Operate** block in the Shot tab records a camera move live, in two passes:

1. **Position pass:** fly the path as a drone (or dolly along a path) with a gamepad (Game or RC Mode 2 stick layout) or the keyboard (W/S forward and back, A/D strafe, Q/E turn, Space/Shift up and down, R record, Esc release). Gamepad: A arms, records and stops; B releases; X levels; LB slow; RB fast.
2. **Aim pass:** the recorded path replays in real time while you aim with the right stick, a pointer drag, or your phone.

**Keep take** turns the take into the shot's camera keys (up to 64, recorded timing kept, up to 5 s) as one undoable edit. The scene's animation plays from the shot's start while you record.

**Phone** (transport bar) pairs a phone over your local network; see [director-phone.md](director-phone.md) for the one-time certificate setup. **Aim** previews the shot camera aimed by the phone. In the Operate aim pass, choose **Phone** as the aim source: the phone's Record and Re-zero buttons drive the take.

## 5. Looks: one consistent design for every object

**Looks** (top bar) opens the Looks board:

- **World** and **Visual style** notes apply to the whole project. They go into every look prompt and every shot prompt.
- Each object has a card showing its primary look, a **description** (wardrobe, materials, make, condition…), the shots whose camera sees it, and a view (full body, character sheet, face close-up, three-quarter, side profile, wide plate…).
- Tick objects (objects that appear prominently and have no look are pre-ticked), pick a model, then **Quote**. Nothing is sent. One approval with a total limit generates them one at a time. New looks become primary on objects that had none.
- Image models: FLUX 3 and Flux.2 [pro] (BFL), Flux 1.1 [pro] Ultra, Nano Banana 2.1 / 2 / Pro on Comfy Cloud, or a checkpoint in your local ComfyUI.

The **Object** tab shows the same thing for one object: the hero look and alternates (click to make primary, drop or upload images), the description, view presets, and a single-object quote.

Paid Cloud runs also require `PREVIS_ALLOW_PAID=1` on the server. Requests are never resent automatically.

### How looks reach the video

Each shot works out which objects its camera actually sees over the shot. When you generate a video, Previs sends, as reference images:

1. the primary look of every object in frame (the camera's subject first, then larger objects),
2. environment references,
3. style references,
4. the shot's key frame.

The prompt numbers them ("Runner — looks exactly like reference image 1"). Kling O1 takes up to 4 images; Seedance 2.5 takes up to 9. Untick **Looks as references** to send the blockout and prompt only. **LTX 2.5** works differently: it animates the shot's key frame (or its first blockout frame) and doesn't follow the blockout's motion.

## 6. Render and hand off

**Render shot →** renders each frame through the shot camera at 24 fps (1280×720 or 640×360) and saves the video into the project. Edit the compiled prompt if you like, then **Open in Comfy workflow →**. That page has the video and prompt preselected. Choose a workflow and backend there; it quotes and asks for approval before anything runs.

Workflow results come back automatically. They appear under **Workflow results** in the shot's Shot tab and in **Assets**.

## 7. Sequence: generate, review and export the whole film

Switch the top bar from **Scene** to **Sequence**. Every shot is listed in order:

- **Order:** drag a row, use ↑ ↓, or press Alt+↑/↓ on a focused row. Undo works as usual.
- **Blockout:** green means the camera video is up to date. **Render missing blockouts** captures every shot that has no blockout or has changed.
- **Generate:** tick shots (or **All**), pick a video model (Kling O1, Seedance 2.5…), then **Quote**. Nothing is sent. One approval with a total limit runs the shots one at a time; each is re-checked before it is sent, and a failed or uncertain job stops the batch without retrying.
- **Cut:** each row chooses the version used in the final cut (newest generated, else blockout, or any specific version), its in/out trim, and whether the shot is **In cut** or **Excluded**.
- **Viewer:** click a row to watch it and flip between **Blockout**, **Compare** (drag the seam between the blockout and the generated video) and **Generated**. **Play sequence** plays the cut in order.
- **Export final video** joins the cut into one 1280×720, 24 fps H.264 file. Every export is listed with Download.

**Advanced timeline** (or **Edit**) opens the clip timeline for duplicates and custom orders.

## 8. Assets, export and backup

**Assets** (top bar) lists everything in the project: camera renders (every version), workflow results, object looks and shot references. You can download any of them, reopen a render in a workflow, or compare a result with its source.

Everything lives in the project's own folder, `.previs/director/<project-id>/`, so **Export project (.zip)** carries all of it. When you import an export, its renders are kept for reference, but you render again before workflow hand-off: that re-registers the video with this machine's workflow engine and takes about a second.

## Limits

- One scene per project. Shots export up to 5 seconds (120 frames).
- Only the beauty pass is exported. Depth and pose guides aren't available yet.
- Reference images are named in prompts, not wired into image inputs automatically. Map image inputs on the workflow page.
- Look generation is text-to-image.

## Design references

The viewport controls (selection, G/R/S, snapping, framing, undo) and keyframe animation follow two reference notes from the Otter team: the *Otter blockout controls reference* and the *Otter keyframe animation reference*. They're kept outside this repository. Previs reimplements the behaviour independently; no Otter source is copied. Treat those notes as the intended reference for future work on these areas.
