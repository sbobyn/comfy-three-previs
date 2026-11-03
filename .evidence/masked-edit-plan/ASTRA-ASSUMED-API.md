# Astra assumed API — shared/masked-edit (foundation not landed in this checkout)

Date: 2026-11-03 · Branch: `feat/masked-edit-ui-quote-20261103`

`shared/masked-edit.mjs` / `shared/masked-edit.d.mts` and `server/previs/masked-edit.mjs` are **Sol-owned** and missing here. Astra did **not** copy or edit those files. UI geometry/eligibility live in `src/director-masked-edit.ts`; Cloud quote/generation wiring lives in Astra-owned presets/workflows/generation*. Parent merges after Sol lands.

Assumed signatures (aligned with INTEGRATION.md and a read-only peek at Sol’s in-progress sibling module — not imported):

```ts
// shared/masked-edit.mjs (Sol)
export const MASKED_EDIT_VERSION = 1;
export const MASK_ALGORITHM_VERSION: string; // e.g. 'fixed-feather-inside-v1'
export const COMPOSITE_VERSION: string;
export const MASKED_EDIT_WORKFLOW = 'masked-video-edit';
export const ELIGIBLE_WIDTH = 1280;
export const ELIGIBLE_HEIGHT = 720;
export const ELIGIBLE_FPS = 24;
export const ELIGIBLE_FRAMES: readonly number[]; // [81, 89, 113]
export const DEFAULT_FEATHER_PX = 8;
export const CROP_CONTEXT_PAD = 32;
export const CROP_ALIGN = 16;
export const CROP_MIN_DIM = 320;
export const CROP_MIN_AREA = 153_600;
export const CROP_MAX_FRAME_FRAC = 0.6;

export type FixedMask = {
  v: 1; mode: 'fixed'; width: number; height: number;
  coordinateSpace: 'source-pixels'; featherPx: number;
  strokes: Array<
    | { type: 'rect'; x: number; y: number; w: number; h: number; erase?: boolean }
    | { type: 'brush' | 'erase'; points: [number, number][]; radius: number }
  >;
};

export function sourceEligible(media?: { width?: number; height?: number; fps?: number; frameCount?: number; audio?: boolean; variableRate?: boolean }): { ok: boolean; issues: string[]; width: number; height: number; fps: number; frameCount: number };
export function isMaskedEditAsset(asset: unknown): boolean;
export function normalizeMask(input: unknown, opts?: { width?: number; height?: number }): FixedMask;
export function rasterizeFixedMask(maskInput: unknown, opts?: { width?: number; height?: number }): { mask: FixedMask; support: Uint8Array; alpha: Uint8Array; nonzero: number; full: number; maskHash: string };
export function cropFromMask(alpha: Uint8Array, width: number, height: number, opts?: { pad?: number }): { x: number; y: number; w: number; h: number; frac?: number };
export function offlineQuoteEnvelope(input?: { frameCount?: number; crop?: { w?: number; h?: number }; steps?: number }): { currency: 'USD'; status: 'unknown'; amount: null; estimate: number | null; providerEnforcedCap: false; basis: Record<string, unknown> };
export function composeInputKey(parts: Record<string, unknown>): string;
export function validateAcceptanceState(input?: Record<string, unknown>): { ok: boolean; issues: string[] };
export function buildMaskedEditProvenance(input?: Record<string, unknown>): Record<string, unknown>;
```

```ts
// server/previs/masked-edit.mjs (Sol) — HTTP facade; Astra does not call provider from UI
// POST /api/director/masked-edit/prepare|submit|review|accept
// GET  /api/director/masked-edit/status?projectId&editId
// prepare returns: editId, draftRevision, maskHash, sourceSha256, effectiveMask URL, cropRect, quote{fingerprint,estimate,reservationRequiredUsd,...}
```

## Astra ↔ Sol contracts this branch relies on

| Concern | Astra (this branch) | Expected from Sol |
| --- | --- | --- |
| Workflow task | `masked-video-edit` + `maskVideo` semantic | Same task string on provenance / accept |
| Patch purpose | `MASKED_EDIT_PURPOSE = 'masked-edit-patch'` | Accept composites from quarantined candidate, never treat patch as take |
| Trusted estimate | `estimateMaskedVaceCost` basis **399_360** px (832×480) × 248.2 GPU s (INTEGRATION.md) | `offlineQuoteEnvelope` should use the same basis (sibling snapshot used 320×480 — **merge risk**) |
| Cut eligibility | Not edited (`automaticCutEligible` is Sol) | Exclude `source.maskedEdit` from implicit newest |
| UI mask strokes | Client uses `{ tool, size, points:[{x,y}] }` + optional `rect` | Sol `normalizeMask` prefers `{ type:'rect'\|'brush'\|'erase', … }`; prepare route must accept/map UI shape |
| syncResults | `generation.listForSync()` wired as `engineJobs` | Keep skipping `purpose === masked-edit-patch` |

## Calibration note

Planning USD for 320×480×81 ≈ **$0.120** (95.5 GPU s × 0.266 / 211). Not an invoice; `providerEnforcedCap: false`.
