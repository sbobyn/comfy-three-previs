import type { DirectorProject, Shot } from './director.mjs';
export function viewportSummary(project: DirectorProject, shot: Shot, o?: { t?: number; selected?: string[]; view?: 'set' | 'camera' }): string;
