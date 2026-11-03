# License scope and third-party notices

The standalone Comfy Previs original code and documentation contributed by Steven Bobyn are MIT licensed under LICENSE, following the owner's explicit October 22, 2026 instruction. Package metadata describes that license. This grant does not replace any third-party copyright or license.

## Inherited material requiring provenance confirmation

The three-vcam baseline b37ebb01d1232165f48a718673f9d6b4cf2836be contains no tracked license. Its recent commits identify sbobyn as author, but that alone does not establish ownership of every contribution. Our new additions and modifications are MIT; any third-party portions in the following inherited files retain their original rights. Confirm these files are wholly Steven-owned, or identify and retain their actual third-party grants before distribution. They have not silently been relicensed by this change.

- `.gitignore`
- `README.md`
- `index.html`
- `package.json`
- `phone-solo.html`
- `phone.html`
- `pnpm-lock.yaml`
- `server/relay.ts`
- `src/demos.ts`
- `src/dom.ts`
- `src/flight.ts`
- `src/gamepad.ts`
- `src/lens.ts`
- `src/main.ts`
- `src/orientation.ts`
- `src/phone-solo.ts`
- `src/phone.ts`
- `src/protocol.ts`
- `src/scene.ts`
- `src/smoothing.ts`
- `src/take.ts`
- `tsconfig.json`
- `vite.config.ts`

**Precise owner question before distribution:** Steven, are the inherited portions of all 23 baseline paths above wholly yours to grant under MIT? If any portion originated elsewhere, identify its upstream source, author and applicable license/permission so the correct grant and attribution can be retained. Git authorship alone does not answer this question.

The original README is retained in docs/three-vcam-history.md with the same provenance caveat. No Otter/FSL code was copied into this standalone project. No Story Studio files were copied. Generated user projects, imported workflows/models/LoRAs, and media are not automatically licensed under this project's MIT grant.

## Dependencies and external programs

Dependencies retain their own licenses. Installed package license text is preserved in dependencies and selected shipped runtime notices are copied into third-party-licenses/. Keep notices with redistributed bundles. The lockfile records exact resolved dependency versions.

- Three.js 0.187.0, including examples/OrbitControls, and for 3D model import (docs/import.md) the GLTF, FBX, OBJ/MTL, STL, PLY and USD loaders, GLTFExporter and SkeletonUtils, which the server also runs: MIT, three.js authors. FBX and USDZ decoding uses the fflate 0.8.3 copy three.js ships in examples/jsm/libs: MIT, Arjun Barrett.
- ws 8.21.3: MIT, Einar Otto Stangvik and contributors.
- TypeScript: Apache-2.0; Vite: MIT; @types packages: MIT; Prettier: MIT. Build-only dependencies retain upstream notices when redistributed.
- Blender MCP: ahujasid/mcp-for-blender 2.2.2, pinned 5a3618fccb2d982d0dd61e7a1879912c3100073b, MIT. External process; retain upstream license if bundled.
- Blender, ComfyUI and FFmpeg/FFprobe are external programs, not bundled or relicensed. Their licenses and those of custom nodes/models/LoRAs apply independently. No model weights or copied upstream Python code ship with this app.
