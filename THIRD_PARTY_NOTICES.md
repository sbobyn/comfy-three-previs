# License scope and third-party notices

The standalone Comfy Previs original code and documentation contributed by Steven Bobyn are MIT licensed under LICENSE, following the owner's explicit October 22, 2026 instruction. Package metadata describes that license. This grant does not replace any third-party copyright or license.

## Inherited three-vcam material

This project grew out of the three-vcam baseline b37ebb01d1232165f48a718673f9d6b4cf2836be, which had no tracked license. Steven Bobyn confirmed on 2026-11-03 that he owns that code and grants it under this project's MIT license.

The original README is retained in docs/three-vcam-history.md under the same MIT grant. No Otter/FSL code was copied into this standalone project. No Story Studio files were copied. Generated user projects, imported workflows/models/LoRAs, and media are not automatically licensed under this project's MIT grant.

## Dependencies and external programs

Dependencies retain their own licenses. Installed package license text is preserved in dependencies and selected shipped runtime notices are copied into third-party-licenses/. Keep notices with redistributed bundles. The lockfile records exact resolved dependency versions.

- Three.js 0.187.0, including examples/OrbitControls, and for 3D model import (docs/import.md) the GLTF, FBX, OBJ/MTL, STL, PLY and USD loaders, GLTFExporter and SkeletonUtils, which the server also runs: MIT, three.js authors. FBX and USDZ decoding uses the fflate 0.8.3 copy three.js ships in examples/jsm/libs: MIT, Arjun Barrett.
- ws 8.21.3: MIT, Einar Otto Stangvik and contributors.
- TypeScript: Apache-2.0; Vite: MIT; @types packages: MIT; Prettier: MIT. Build-only dependencies retain upstream notices when redistributed.
- Blender MCP: ahujasid/mcp-for-blender 2.2.2, pinned 5a3618fccb2d982d0dd61e7a1879912c3100073b, MIT. External process; retain upstream license if bundled.
- Blender, ComfyUI and FFmpeg/FFprobe are external programs, not bundled or relicensed. Their licenses and those of custom nodes/models/LoRAs apply independently. No model weights or copied upstream Python code ship with this app.
