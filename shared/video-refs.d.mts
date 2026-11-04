export const REFERENCE_INPUTS: Record<string, { mode: 'batch' | 'slots'; input: string; max: number }>;
export function referenceTarget(definition: any): { nodeId: string; spec: { mode: 'batch' | 'slots'; input: string; max: number } } | null;
export function maxReferences(definition: any): number;
export function withReferenceImages<T>(definition: T, count: number): T;
