# Local temporal qualification proposal — approval required

No weights were downloaded, nodes installed, settings changed or temporal inference run. The existing SD1.5 framewise output remains quality-rejected. This plan is for one later, separately approved test; the expired October 22 Desktop window grants no access tonight.

## Exact bounded test

Use the original video-lab VACE edge-control graph, copied into [API JSON](../examples/wan-vace-local-49f.api.json) and a [versioned definition](../examples/wan-vace-local-49f.definition.json). These are unexecuted examples, not another built-in qualified workflow. Nodes: `LoadVideo`, `GetVideoComponents`, `ImageScale`, `Canny`, `UNETLoader`, `CLIPLoader`, `VAELoader`, two `CLIPTextEncode`, `WanVaceToVideo`, `ModelSamplingSD3`, `KSampler`, `TrimVideoLatent`, `VAEDecode`, `CreateVideo`, `SaveVideo`. No custom nodes, Partner/API nodes, reference image or LoRA are inserted.

Source: preserve original asset `f3d8d325-b6d0-4f0a-9cec-454c3391eb3e`, SHA-256 `0cf9eceddf4700111c1edf44ea6dd4f4d388dfc3fe62a783ebce20a45e08db64`. After approval, make a **new first-49-frame derivative**, frames 1–49 of 72, retaining 1280×720, 24 fps, no audio, duration **49/24 = 2.041667 seconds**. This deliberate excerpt omits source frames 50–72; retain its own hash, parent hash, exact selection and timing. Do not replace or relabel the original three-second source. Probe and visually review the derivative before binding it. The graph refuses a source with a different frame count/FPS/duration.

All 49 supplied frames become Canny guides after declared bilinear scaling to **512×288, 16:9**, with crop disabled. `WanVaceToVideo`: 49 frames (4n+1), batch 1, strength 1. `ModelSamplingSD3`: shift 8. `KSampler`: seed 42, 20 steps, CFG 6, `uni_pc`, `simple`, denoise 1. `CreateVideo`: 24 fps. Output: silent MP4/H.264, exactly 49 frames / 2.041667 s, only declared node 16 collected. No temporal resampling, reference-frame padding or automatic timing fit is intended. This lower-than-480p test is a hardware/conditioning probe; quality at this resolution is unqualified.

Suggested prompt: “A luminous amber glass planet with swirling golden clouds inside a gold orbital ring, white display pedestal, cinematic studio lighting, same composition.” Negative: “distortion, flicker, camera shake.” Edge control supplies structure/motion, not the RGB appearance of the source; requested appearance and camera adherence still require visual judgment. The [official VACE tutorial](https://docs.comfy.org/tutorials/video/wan/vace) distinguishes the 1.3B 480p model from the larger 14B option. The [native node documentation](https://github.com/Comfy-Org/embedded-docs/blob/main/comfyui_embedded_docs/docs/WanVaceToVideo/en.md) describes truncation/neutral padding, which is why this plan requires exactly 49 control frames.

## Installed versus missing

Read-only checks refreshed on October 24 found ComfyUI 0.38.0, 971 live schemas, MPS, PyTorch 2.10.0.dev20250919, 128 GiB unified memory. All required node classes are present; validation reports **exactly these three missing model selections**, with no node-install requirement:

| File | Destination under `models/` | Bytes |
| --- | --- | ---: |
| `wan2.1_vace_1.3B_fp16.safetensors` | `diffusion_models/` | 4,309,519,800 |
| `umt5_xxl_fp8_e4m3fn_scaled.safetensors` | `text_encoders/` | 6,735,906,897 |
| `wan_2.1_vae.safetensors` | `vae/` | 253,815,318 |

The exact sizes come from prior read-only [Comfy-Org weight metadata](https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/tree/main/split_files), not approximate tutorial labels. Total installed weights: **11,299,242,015 bytes = 11.30 GB / 10.52 GiB**. With a separate complete download cache, budget another 11.30 GB; reserve at least 2 GB for frames, receipts and outputs: **about 25 GB free disk**. A direct-download strategy may avoid duplication but needs its own integrity/provenance plan. No disk reservation or download has been made. Runtime memory is not inferred from file size.

The October 24 audit checked live loader choices and configured model directories: no suitable installed temporal video/control weights were found. The installed SD1.5 and Qwen image/edit weights cannot substitute for this model family. Existing Qwen LoRAs are unrelated; do not insert them. Filenames and graph remain intact if validation fails.

## Pinned provenance and licenses

The old repository alias now resolves to **Comfy-Org/Wan-2.1**, revision `123acf1cc74bccbb9bfff8ac1ee72edc08c2341d`. The [exact-file manifest](../examples/wan-vace-local-weights.json) records each publisher path, byte count and metadata SHA-256. These are read-only metadata checks; no weight bytes have been downloaded or locally verified.

[Comfy-Org's card](https://huggingface.co/Comfy-Org/Wan-2.1/blob/123acf1cc74bccbb9bfff8ac1ee72edc08c2341d/README.md) declares **Apache-2.0**, identifies the original Wan repositories, and has no separately tracked LICENSE/NOTICE or reproducible conversion recipe in the inspected package. The upstream [Wan-AI VACE LICENSE.txt](https://huggingface.co/Wan-AI/Wan2.1-VACE-1.3B/blob/574e6a744642ce3bee319afc31496b88bde8aac4/LICENSE.txt) is Apache-2.0. The [Google UMT5 card](https://huggingface.co/google/umt5-xxl/blob/66cb9e7e85526fe440a945569e42c72fb6cbc0ad/README.md) also declares Apache-2.0. Keep these sources/notices with any later acquisition or redistribution; the app's MIT grant does not relicense the weights. Publisher lineage is documented; conversion fidelity was not independently reproduced.

This probe intentionally omits **23 of the original 72 frames** and runs below the model's recommended 480p. Even success would qualify only the declared 49-frame/512×288 probe, not the complete three-second/720p trajectory. Full-path temporal qualification remains a later test with explicitly reviewed frame handling.

## Mac evidence and uncertainty

[ComfyUI supports Apple Silicon through PyTorch MPS](https://docs.comfy.org/installation/system_requirements). The installed backend reports MPS and exposes the exact VACE nodes. Those facts establish a plausible test path, **not inference compatibility**. No VACE weights have loaded here. FP16 diffusion/VAE kernels, memory pressure, text-encoder conversion and temporal output quality remain untested.

The proposal deliberately selects `CLIPLoader.device = cpu` to avoid requiring FP8 text-encoder computation directly on MPS. Whether this exact scaled-FP8 checkpoint dequantizes/executes successfully in the installed CPU loader is still unknown. Failures must be recorded; do not silently substitute an FP16 encoder, change backend flags or update PyTorch/nodes. Those would require a new dependency/approval review. General reports about other Wan/MPS model variants do not qualify this graph.

## Approval, ownership and stop conditions

Approval must separately cover downloading the three exact files (11.30 GB, up to ~25 GB working/cache budget) and **one** local 49-frame test using this definition. No Cloud execution or paid nodes. The app may still quote unknown local cost for unqualified model nodes; inspect that exact receipt and acknowledge only the intended local execution. Hardware/electricity remain unpriced. No automatic retry, alternative model or second quality pass is included.

Before any approved run: coordinate a fresh parent-only Desktop/GPU window, GET the queue immediately before dispatch and yield if any other job appears. Preserve graph/asset hashes, prompt, parameters, live schema, backend identity and job receipt. Start only with at least 32 GiB system-reported free memory, normal memory pressure and at least 25 GB free disk; these are conservative operator stop rules, not measured model requirements.

Watch system memory/pressure and job progress every 15 seconds. Stop the owned test on sustained warning/critical pressure, free memory below 16 GiB, swap growth above 4 GiB, allocation/NaN/unsupported-kernel errors, no progress for five minutes, or a 20-minute wall-clock limit. Use only a coordinated cancellation after verifying the currently running job is this request; Comfy's interrupt can affect the active queue globally. If ownership is ambiguous, do not interrupt another job or restart the service. Report uncertainty and retain the receipt/files. Never claim cancellation until the backend confirms idle/termination. There is no fallback retry.

Success requires both successful collection and visual acceptance: a recognizable requested amber appearance, coherent knot/orb/ring/pedestal geometry across frames, no cuts/flicker/neutral final frame, smooth source-aligned landmark parallax, stable composition, and exact reported output timing/dimensions/audio. Compare source/result at aligned seconds plus first/middle/last and quarter-second samples. Save an honest review against the exact output, reopen it and verify persistence. A completed job or matching FFprobe metadata alone is insufficient.
