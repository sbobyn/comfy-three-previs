export type V3 = [number, number, number];
export type XForm = { position: V3; rotation: number; scale: V3 };
export type ModalMode = 'translate' | 'rotate' | 'scale';
export type ModalState = { mode: ModalMode; axis: 'x' | 'y' | 'z' | null; numeric: string; snap?: boolean; step?: number };
export class Selection {
  readonly primary: string | null; readonly ids: string[]; readonly size: number;
  has(id: string): boolean; click(id: string | null): void; add(id: string): void; toggle(id: string): void;
  addMany(ids: string[]): void; set(ids: string[], primary?: string | null): void; clear(): void; retain(valid: Set<string>): void;
  subscribe(fn: (s: Selection) => void): () => void;
}
export const CLICK_SLOP: number; export const RIGHT_CLICK_SLOP: number;
export function isDrag(a: { x: number; y: number }, b: { x: number; y: number }, slop?: number): boolean;
export function marqueeRect(a: { x: number; y: number }, b: { x: number; y: number }): { left: number; top: number; right: number; bottom: number };
export function inRect(p: { x: number; y: number }, r: { left: number; top: number; right: number; bottom: number }): boolean;
export function modalAxes(mode: ModalMode): ('x' | 'y' | 'z')[];
export function computeModal(input: { mode: ModalMode; axis: 'x' | 'y' | 'z' | null; start: XForm; startPointer: { x: number; y: number }; pointer: { x: number; y: number }; unitsPerPixel: number; cameraRight: V3; cameraUp: V3 }): XForm;
export function computeModalNumeric(mode: ModalMode, axis: 'x' | 'y' | 'z' | null, start: XForm, value: number): XForm;
export function modalKey(state: ModalState, key: string): { handled: boolean; commit?: boolean; cancel?: boolean };
export function modalHud(state: ModalState): string;
export function rigidApply(primaryStart: XForm, primaryNow: XForm, others: XForm[]): XForm[];
export function gridStep(unitsPerPixel: number, targetPx?: number): number;
export function unitsPerPixel(distance: number, fovDeg: number, viewportHeight: number): number;
export function snapActive(persisted: boolean, ctrl: boolean): boolean;
export function snap(value: number, step: number): number;
export function snapDelta(delta: number[], step: number, axes?: boolean[]): number[];
export function framingDistance(radius: number, fovDeg: number, aspect: number): number;
export function targetConsumesKey(target: EventTarget | null, key: string): boolean;
export type UndoEntry = { label: string; redo: unknown[]; undo: unknown[]; select?: string[] };
export class UndoStack { constructor(limit?: number); push(e: UndoEntry): void; takeUndo(): UndoEntry | null; takeRedo(): UndoEntry | null; restore(e: UndoEntry, wasUndo: boolean): void; readonly canUndo: boolean; readonly canRedo: boolean; peekUndo(): UndoEntry | null; peekRedo(): UndoEntry | null; }
export function recreateOps(entity: unknown, project: unknown): unknown[];
