# Historical standalone transport checkpoint

Historical baseline through 0ad0cde, October 22, 2026. The corrected video release requirements and current qualification are in [video-checkpoint.md](video-checkpoint.md). The standalone app is the product; future Otter integration would be a separate consumer. Preserved Otter work remains on hold.

## Working and exercised

| Journey | Evidence | Boundary |
| --- | --- | --- |
| Blender inspect → exact camera/frame → preview → saved/recovered shot | Actual upstream MCP 2.2.2 and official addon, Blender 4.5.4 GUI, disposable project | Raw 640×360 beauty PNG; source file unchanged; render settings, camera markers and frame/subframe restored |
| Browser subject placement → camera operation/record → save/reopen/replay | Real app UI, saved 58 motion samples, exact capture pose restored and final playback pose checked | Fixed camera-study set; each save creates a new shot; phone/gamepad not hardware-qualified |
| Saved render → explicit workflow binding → local Comfy → returned output | Real native LoadImage→SaveImage on local Comfy 0.38.0; declared output saved at request revision 5 and recovered after restart | Passthrough, not AI generation; 640×360 RGB pixels matched source; alpha/file metadata need not match |
| Browser camera → new Blender scene | Actual MCP, first/middle/last frames 1/44/87 and optical projections checked; original file unchanged | Camera only, 24 fps, geometry omitted, target scene remains unsaved until operator saves Blender file |
| Error/recovery paths | Automated simulated MCP/HTTP faults plus real Blender stale-binding refusals | Simulations are labeled; no claim of hardware qualification |

Automated gates cover optimistic revisions/save conflicts, project restart, HTTP origin boundaries, missing/stale bindings, durable Blender uncertainty after interrupted dispatch, failed journal writes, repeated Comfy requests after lost acceptance, request UUID case, declared-output collection, immutable provenance after rebind, and camera projection/endpoint handling. `pnpm check` includes typecheck and both builds; `pnpm test` runs the suite. The inherited large Three.js chunk warning is retained.

## Release boundaries

- Browser-only, Blender-only and deliberate camera-transfer paths have independent ownership. Blender remains authoritative for Blender-authored data.
- This baseline did not include AI/cloud/custom workflow execution. The current release requires real AI video and both Cloud/local backends; see the video checkpoint. No paid run or model download is authorized automatically.
- No depth/pose guide passes, generic world editor, broad geometry/material conversion, physics, world generation/import or round-trip synchronization.
- No phone/gamepad qualification, installers, cross-platform packaging or unattended Blender installation. Setup names exact prerequisites and does not edit global agent config.
- Blender transfer persists a project receipt and target binding, but saving the actual `.blend` remains the operator's explicit action.
- Uncertain jobs preserve identity and block blind retries. Closing an uncertain receipt does not claim cancellation or a known outcome.

## Publication decisions

The inherited three-vcam source has no tracked source license. Steven has chosen MIT for original standalone code. Ownership/provenance of inherited portions still needs confirmation before redistribution. A separate publication approval is still required. No license grant has been invented. Dependency/upstream notices must be retained as applicable; upstream Blender MCP is MIT and remains a pinned external dependency. These decisions do not block private use or implementation.

A separate committed checkout passed frozen offline installation with pnpm 10.18.0 on Node 22.23.2 (28 cached packages, zero downloads), typecheck/build and all 14 tests. It started independently and displayed the expected missing-Blender setup guidance. pnpm reported ignored esbuild lifecycle scripts; the installed platform binary built successfully. Final candidate identity and recording are recorded with local evidence and in the morning report. No push, publication, paid calls or live project changes are part of this checkpoint.
