export type Quat = [number, number, number, number]; // world-space camera orientation x,y,z,w (three.js convention: camera looks down -Z)
export interface AimSource { id: string; label: string; connected(): boolean; status(): string; orientation(): Quat | null; rezero?(): void; lensMm?(): number | null; onButton?(cb: (b: 'record' | 'rezero') => void): () => void; dispose(): void }
const registry = new Map<string, () => AimSource>();
export function registerAimSource(id: string, factory: () => AimSource) { registry.set(id, factory); }
export function aimSources() { return [...registry.keys()]; }
export function createAimSource(id: string) { return registry.get(id)?.(); }
