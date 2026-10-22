# Video workflow checkpoint — private candidate

The standalone app is the product; Otter remains a separate possible consumer. Topic: `feat/previs-video-workflows`, based on standalone candidate `0ad0cde`. MIT applies to original Previs code; see THIRD_PARTY_NOTICES.md for inherited ownership exceptions. No push, publication, paid run or new model download has occurred.

## Release requirement and current state

Release requires camera-controlled rendered video → real AI video workflow → collected, visually reviewed output, through both local and Cloud backend support. Native processing proves transport and timing only. The current candidate provides the video journey and an exact request preparation path; it is **not yet AI-video release qualified**.

| Capability | Evidence | Remaining boundary |
| --- | --- | --- |
| Blender animation through actual upstream MCP | Real disposable Blender scene,72frames,1280×720,24fps,3.000seconds,silent H.264; original file hash unchanged | Bounded beauty capture only, source file never saved |
| Browser save/reopen/replay/export | Real Chrome UI operated take; two immutable18-frame640×360,24fps exports have identical hashes and saved snapshot provenance | Fixed camera-study set;0.734s recording samples through0.70833s, encoded0.750s; endpoint quantization displayed |
| Imported local video workflow | Actual LoadVideo→GetVideoComponents→ImageInvert→CreateVideo→SaveVideo, user-imported IDs101–105; completed and reviewed in app | Native inversion, **not AI generation**; no model registry addition |
| Returned-media comparison | Real output1280×720,72frames,24fps,3s,silent; aligned playback and selected-output review | No stretching, trimming, interpolation or audio removal |
| Imported LoRA chain/settings | UI import, live choices, changed strengths/filename, saved binding, reload/restore and prepared graph; author graph unchanged | Configuration proof only; disconnected test chain, no LoRA inference or base-model qualification |
| Primary Kling workflow | Actual local and authenticated Cloud schemas accept the exact graph/video bindings; Cloud exposes3810 node schemas; the app prepared a fresh receipt | Cloud upload, paid dispatch and AI output remain unverified |
| Alternative Wan VACE1.3B | Local schema reports exactly three missing weights; authenticated Cloud schema accepts the original alternative graph and model selections | No downloads or inference; Cloud cost remains unknown and declared resolution/timing change requires acknowledgment |
| Recovery | Automated fault injection exercises capture-slot release, immutable export, revisions, durable dispatch/approval and collection | Simulated faults are not additional real backend runs |

## Architecture and ownership

Browser and stdio MCP → one standalone HTTP server/project revision queue. Blender operations use actual pinned mcp-for-blender2.2.2 and fixed scripts, with a durable operation written before dispatch. Blender owns its authored file. Browser shots own saved camera-study snapshots. Both create immutable versioned assets consumed by capability definitions. Definitions/author graph, prepared clone, binding, source hashes, shot snapshot, backend/schema and quote live in durable generation receipts. Local and Cloud upload/dispatch/history/output adapters are separate. No graph or model changes occur on backend selection.

One lead owns app5190, disposable Blender addon9887, browser and any shared Comfy jobs. Local8000 is an existing shared Comfy instance: inspect/coordinate its queue, never interrupt it. Tests use disposable data and simulated transports unless explicitly labeled real media encoding. Detailed current SHA, process IDs, data paths, commands and unresolved tasks are retained locally in `.evidence/video/CURRENT.md` (not committed). Keep original assets and all retained stages.

## Prepared demo request — no submission authorized

- Input: asset `f3d8d325-b6d0-4f0a-9cec-454c3391eb3e`, source shot `fd67ca3c-7132-4495-a05a-7569ae206ed8`, source request revision3. SHA-256 `0cf9eceddf4700111c1edf44ea6dd4f4d388dfc3fe62a783ebce20a45e08db64`.
- Clip:1280×720,16:9,72frames,24fps,3.000seconds,no audio. No reference images or additional control pass required.
- Task: transform the full rendered beauty video. Workflow: original Previs Kling O1 edit graph (`LoadVideo`→`KlingOmniProEditVideoNode`→`SaveVideo`). Model:`kling-video-o1`; resolution720p; keep_original_sound=false; seed0 (cache input, not a deterministic output promise); MP4/H.264 save.
- Backend: Comfy Cloud. The user's local gitignored `.env` credential passed read-only authentication and live schema validation on2026-10-22. The app's Setup page and video-workflow picker both confirmed3810 live node schemas. No upload or submission occurred; paid execution remains disabled.
- Exact app-prepared request: `1c706a23-064a-4dcc-9f4e-2c6ec6ed8a3b`, project revision18; fingerprint `cf392a0f0eabb1eab205d32c8bb2a31301a36f1e2d19dc37ee5f64e4ad04b515`. Schema-compatible with no issues. This binds the original source asset and prompt below; source capture revision3 is retained separately. Any relevant project, graph, asset, backend or schema change requires fresh review/approval.

Exact prompt:

> Transform the blue ceramic sphere into a luminous amber glass planet with swirling golden clouds. Keep the gold orbital ring, pedestal, camera dolly, perspective, framing, object positions and background parallax from the source video. Cinematic studio lighting, stable geometry, consistent materials, no added camera motion, no cuts, no text.

The [official Partner Node pricing](https://docs.comfy.org/tutorials/partner-nodes/pricing) lists26.59credits/second for O1 video editing at720p:79.77credits for3seconds. The inspected [official node implementation](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_api_nodes/nodes_kling.py) exposes a USD badge of0.126/second: **$0.378 partner estimate**. These are pricing evidence, not a verified total. Cloud execution overhead, account credit conversion/taxes and provider-billed output duration remain unknown. Proposed allowance after validation: **$1 USD for one explicitly approved request, including acknowledged unknown charges; zero automatic retries.** An allowance is not a provider-enforced charge cap. If the unknown total cannot be bounded acceptably, do not execute. Current paid kill switch remains off.

Judge the full camera trajectory and parallax, composition/object positions, motion, temporal consistency, requested amber-glass appearance, and actual output duration/FPS/framing/audio. Full-video editing conditions on the clip; camera preservation remains an empirical review criterion, not a guarantee. A first-frame model is a different task and cannot establish preservation of the camera-motion clip.

Alternative: [Wan VACE1.3B](https://docs.comfy.org/tutorials/video/wan/vace) uses Canny-derived control frames plus prompt. It has lower model size than14B and supports480p; it requires local compute rather than the Kling partner service. Speed and hardware behavior have not been benchmarked here. Missing files: `wan2.1_vace_1.3B_fp16.safetensors`, `umt5_xxl_fp8_e4m3fn_scaled.safetensors`, `wan_2.1_vae.safetensors`. The example requests832×480,73frames/24fps and requires explicit timing/framing acknowledgment. No automatic downloads or substitutions. Local electricity/hardware and any Cloud runtime charges are unqualified.

## Verification and release blockers

Commands: `pnpm check`, `pnpm test`, `git diff --check`; clean checkout uses `pnpm install --offline --frozen-lockfile`. Final committed gates and clean-install evidence are recorded in the local checkpoint and report. Existing Three.js chunk-size warning remains unchanged. The project MCP facade must read the same final project/asset/job state as the UI.

Release blockers: Cloud upload/execution/output qualification and deprecated-v1 adapter migration decision; explicit paid approval followed by a real collected AI result and its visual review; inherited source ownership confirmation before distribution; final concise walkthrough recording. Live Cloud authentication/schema compatibility now passes; this does not qualify execution. T3 screenshot and recording attempts timed out; Chrome fallback completed functional and visual checks, including Cloud setup and quote preparation. No successful new walkthrough recording is claimed.

Public distribution additionally needs separate publication approval. Depth/pose passes, general world editing, broad asset conversion, physics and phone/gamepad hardware qualification remain deferred. See standalone-previs.md for exact loader, parameter, endpoint, media and recovery limits.
