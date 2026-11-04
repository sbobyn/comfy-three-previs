export const BLOCKOUT_MODELS: Readonly<Record<string, string>>;
export function blockoutModel(e: { shape: string; model?: string | null }): string | null;

export function projectMesh(model: unknown): string | null;
export function isDecalMaterial(name: unknown): boolean;
export const DECAL_POLYGON_OFFSET: Readonly<{ factor: number; units: number }>;
