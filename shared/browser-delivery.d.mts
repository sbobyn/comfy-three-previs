export type BrowserDelivery = { width: number; height: number; fps: number; aspect: string };
export function browserDelivery(input?: Partial<BrowserDelivery>): BrowserDelivery;
export function browserVideoPlan(frames: { t: number }[], input?: Partial<BrowserDelivery>): BrowserDelivery & { frameCount: number; duration: number; recordedDuration: number; sampledEndTime: number };
