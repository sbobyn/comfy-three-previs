import type { DirectorProject, Shot, Asset, Reference, EditClip } from './director.mjs';
export type TakeCost = { usd: number | null; status: 'billed' | 'estimate' | 'free' | 'unknown' };
export type Grade =
  | { status: 'graded'; score: number; overall: number; camera: number | null; headings: number | null; why: string; method: string }
  | { status: 'match' | 'differs'; frames: number; seconds: number | null; take: { frames: number; fps: number | null; duration: number | null }; blockout: { frames: number; fps: number | null; duration: number | null }; note: string }
  | { status: 'not-graded' | 'not-assessed' | 'not-applicable' | 'unknown'; note: string };
export type TakeGrades = { layout: Grade; identity: Grade; timing: Grade };
export type TakeInput = { role: string; label: string };
type TakeBase = { id: string; shotId: string; number: number; label: string; model: string; modelId: string | null; backend: string | null; settings: Record<string, string | number | boolean | null>; seed: number | null; cost: TakeCost; inputs: TakeInput[]; prompt: string; promptLength: number; stale: boolean; grades: TakeGrades; createdAt: string; elapsedSeconds: number | null; winner: boolean };
export type VideoTake = TakeBase & { kind: 'video'; cameraSource: string | null; source: { assetId: string; version: number } | null; media: { width: number | null; height: number | null; fps: number | null; frames: number | null; duration: number | null }; inCut: boolean };
export type StillTake = TakeBase & { kind: 'still'; moment: string; name: string; file: string };
export type Take = VideoTake | StillTake;
export type StillMoment = { key: string; t: number | null; label: string; inUse: string | null; takes: StillTake[] };
export type Ledger = Record<string, { state: string; costUsd: number | null; expectedUsd: number | null; costStatus?: string }>;
export type TakeOptions = { jobs?: any[]; stillJobs?: any[]; ledger?: Ledger; prices?: Record<string, number | null | undefined> };
export function videoResults(project: DirectorProject, shot: Shot): Asset[];
export function blockoutClips(project: DirectorProject, shot: Shot): Asset[];
export function cutClip(project: DirectorProject, shot: Shot): EditClip | null;
export function winnerOf(project: DirectorProject, shot: Shot): { assetId: string; from: 'winner' | 'cut' } | null;
export function cutAsset(project: DirectorProject, shot: Shot, clip?: EditClip | null): Asset | null;
export function winnerOps(project: DirectorProject, shot: Shot, assetId: string | null): { redo: unknown[]; undo: unknown[]; inCut: boolean };
export function stillTime(shot: Pick<Shot, 'duration'>, ref: Pick<Reference, 'note'>): number | null;
export function stillMoments(shot: Shot): { key: string; t: number | null; label: string; takes: Reference[] }[];
export function videoTakes(project: DirectorProject, shot: Shot, opts?: TakeOptions): VideoTake[];
export function stillTakes(project: DirectorProject, shot: Shot, opts?: TakeOptions): StillMoment[];
export function takeDifferences(takes: Take[]): string[];
export function shotTakes(project: DirectorProject, shot: Shot, opts?: TakeOptions): {
  shot: { id: string; number: number; title: string; duration: number };
  winner: { video: { takeId: string; label: string | undefined; from: 'winner' | 'cut' } | null; stills: { moment: string; takeId: string | null; label: string | undefined }[] };
  cut: { inCut: boolean; takeId: string | null; kind: 'blockout' | 'video' | null; follows: 'chosen version' | 'winner' | 'newest' };
  blockouts: { assetId: string; version: number; frames: number | null; duration: number | null }[];
  videos: VideoTake[]; stills: StillMoment[]; differences: string[];
};
