import type { Object3D } from 'three';
export type Pose = Record<string, [number, number, number]>;
export const POSE_JOINTS: readonly string[];
export function normalizePose(value: unknown): Pose | undefined;
export function keyEase(key: { ease?: string }, u: number): number;
export function blendPose(a: Pose | undefined, b: Pose | undefined, u: number): Pose;
export function applyBlockoutPose(root: Object3D, pose?: Pose): void;
