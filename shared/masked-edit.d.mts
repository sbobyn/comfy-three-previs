import type { Asset, DirectorProject } from './director.mjs';

export const MASKED_EDIT_VERSION: 1;
export const MASK_ALGORITHM_VERSION: string;
export const COMPOSITE_VERSION: string;
export const MASKED_EDIT_WORKFLOW: string;
export const ELIGIBLE_WIDTH: 1280;
export const ELIGIBLE_HEIGHT: 720;
export const ELIGIBLE_FPS: 24;
export const ELIGIBLE_FRAMES: readonly number[];
export const DEFAULT_FEATHER_PX: number;
export const CROP_CONTEXT_PAD: number;
export const CROP_ALIGN: number;
export const CROP_MIN_DIM: number;
export const CROP_MIN_AREA: number;
export const CROP_MAX_FRAME_FRAC: number;
export const MAX_PROMPT_CHARS: number;
export const MAX_NEGATIVE_PROMPT_CHARS: number;
export const MAX_STROKES: number;
export const MAX_STROKE_POINTS: number;
export const MAX_MASK_JSON_BYTES: number;

export type MaskStroke =
  | { type: 'rect'; x: number; y: number; w: number; h: number; erase?: boolean }
  | { type: 'brush' | 'erase'; points: [number, number][]; radius: number };

export type FixedMask = {
  v: 1;
  mode: 'fixed';
  width: number;
  height: number;
  coordinateSpace: 'source-pixels';
  featherPx: number;
  strokes: MaskStroke[];
};

export type CropRect = { x: number; y: number; w: number; h: number; frac?: number; area?: number; warnings?: { code: string; text: string }[]; contains?: { minX: number; minY: number; maxX: number; maxY: number } };

export type MaskedEditProvenance = {
  v: 1;
  editId: string;
  parentAssetId: string;
  parentSha256: string;
  rootAssetId: string;
  maskMode: 'fixed';
  maskHash: string;
  maskAlgorithmVersion: string;
  featherPx: number;
  cropRect: { x: number; y: number; w: number; h: number };
  sourceTiming: { width?: number | null; height?: number | null; fps?: number | null; frameCount?: number | null; duration?: number | null };
  prompt: string;
  negativePrompt: string;
  seed: number;
  definitionHash: string | null;
  schemaHash: string | null;
  modelIdentifiers: unknown;
  parameters: unknown;
  patchJobId: string | null;
  patchResultId: string | null;
  patchSha256: string | null;
  compositeSha256: string;
  compositeVersion: string;
  encodeSettings: Record<string, unknown>;
  inputKey: string;
  quoteFingerprint: string | null;
  estimateUsd: number | null;
  reservationId: string | null;
  costStatus: string;
  preservationReportId: string | null;
  reviewId: string | null;
  acceptedAt: string;
};

export function hashBytes(bytes: Buffer | Uint8Array): string;
export function hashText(text: string): string;
export function sourceEligible(media?: { width?: number; height?: number; fps?: number; frameCount?: number; audio?: boolean; variableRate?: boolean }): { ok: boolean; issues: string[]; width: number; height: number; fps: number; frameCount: number };
export function isMaskedEditAsset(asset: Asset | null | undefined): boolean;
export function maskedEditLineage(project: DirectorProject, asset: Asset, opts?: { limit?: number }): string[];
export function rootAssetId(project: DirectorProject, asset: Asset): string | null;
export function normalizeMask(input: unknown, opts?: { width?: number; height?: number }): FixedMask;
export function rasterizeSupport(mask: FixedMask): Uint8Array;
export function featherInside(support: Uint8Array, width: number, height: number, featherPx: number): Uint8Array;
export function rasterizeFixedMask(maskInput: unknown, opts?: { width?: number; height?: number }): { mask: FixedMask; support: Uint8Array; alpha: Uint8Array; nonzero: number; full: number; maskHash: string };
export function cropFromMask(alpha: Uint8Array, width: number, height: number, opts?: { pad?: number }): CropRect;
export function validateCropEnvelope(crop: CropRect | null | undefined, width?: number, height?: number): { ok: boolean; issues: string[] };
export function compositeFrame(sourceRgb: Buffer | Uint8Array, patchRgb: Buffer | Uint8Array, alpha: Uint8Array, width: number, height: number, crop: { x: number; y: number; w: number; h: number }): Buffer;
export function verifyOutsideExact(sourceRgb: Buffer | Uint8Array, compositeRgb: Buffer | Uint8Array, alpha: Uint8Array): { ok: boolean; checked: number; index?: number };
export function validatePromptFields(input?: { prompt?: string; negativePrompt?: string; seed?: number }): { prompt: string; negativePrompt: string; seed: number };
export function composeInputKey(parts: Record<string, unknown>): string;
export function offlineQuoteEnvelope(input?: { frameCount?: number; crop?: { w?: number; h?: number }; steps?: number }): { currency: 'USD'; status: 'unknown'; amount: null; estimate: number | null; providerEnforcedCap: false; basis: Record<string, unknown>; lineItems: Record<string, number> };
export function validateAcceptanceState(input?: Record<string, unknown>): { ok: boolean; issues: string[] };
export function buildMaskedEditProvenance(input?: Record<string, unknown>): MaskedEditProvenance;
export function assertUuid(id: string, name?: string): string;
