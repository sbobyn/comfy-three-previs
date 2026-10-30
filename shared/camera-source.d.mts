export type CameraSource = 'blockout' | 'keyframes' | 'still';
export const CAMERA_SOURCES: CameraSource[];
export function motionInput(definition: { inputs?: Record<string, unknown> } | null | undefined): string | null;
export function cameraSourceOf(definition: { inputs?: Record<string, unknown> } | null | undefined, assetBindings?: Record<string, unknown> | null): CameraSource;
export const CAMERA_LINES: Record<CameraSource, string>;
export function cameraLine(source: CameraSource | string | null | undefined): string;
export const CAMERA_SOURCE_LABELS: Record<CameraSource, string>;
export const CAMERA_SOURCE_GLYPHS: Record<CameraSource, string>;
export function withCameraLine(text: string, source: CameraSource | string | null | undefined): string;
