# Video release checkpoint — in progress

Baseline 0ad0cde; topic feat/previs-video-workflows. Real AI video generation is essential for release. Native passthrough proves transport only. Next checkpoint must provide a playable camera-controlled input, separate Task / Workflow / Backend choices, validated bindings and a complete quote before approval. Release additionally requires an approved AI result collected and visually reviewed in the app.

Both Comfy Cloud and ordinary user-configured local ComfyUI are required. API workflows remain intact across backend selection. Local custom models and LoRAs are selected through live graph schemas, not a model-name registry. Unsupported loaders/types/formats must name their limitation. Local execution can contain paid nodes; unknown cost never means free.

Original standalone code is MIT; third-party and inherited provenance exceptions are in THIRD_PARTY_NOTICES.md. No push/publication, model downloads or paid runs authorized. Parent owns runtime/browser/Blender/GPU; scoped modules have separate owners. Existing Blender/project/uncertainty behavior must be retained.

Gates: pnpm check; pnpm test; git diff --check. Real UI and stdio MCP must share the same final project state. Simulated recovery evidence is labeled separately.
