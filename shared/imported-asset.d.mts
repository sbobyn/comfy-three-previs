import type { RigProfile } from './rig.mjs';
export type ImportFormat = 'glb' | 'gltf' | 'fbx' | 'obj' | 'stl' | 'ply' | 'usdz' | 'image';
export type ImportedSource = { file: string; format: ImportFormat; url?: string; licence: string; attribution: string; triangles?: number; bytes?: number; units?: string; clips?: { name: string; duration: number }[]; skinned?: true; rig?: RigProfile };
export type PerformKey = { t: number; clip: string | null; offset: number; speed: number };
export type Perform = { clip: string | null; offset: number; speed: number; loop?: false; inPlace?: false; keys?: PerformKey[] };
export const IMPORT_FORMATS: readonly ImportFormat[];
export function normalizeSource(s: unknown): ImportedSource | undefined;
export function normalizePerform(p: unknown, source: ImportedSource | undefined): Perform | undefined;
export function normalizeStandIn(v: unknown): 'neutral' | undefined;
