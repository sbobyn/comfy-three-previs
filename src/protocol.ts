export const RELAY_PATH = "/vcam";

/**
 * Sent to a phone that a newer one has taken over from. The displaced client must
 * not reconnect: two auto-reconnecting controllers would each evict the other
 * about once a second, and the viewer would see a stuttering, half-dead stream.
 */
export const REPLACED_BY_NEWER = 4000;

/** Sent when the viewer deliberately clears the controller slot. */
export const EVICTED_BY_VIEWER = 4001;

export type PhoneMessage =
  | { t: "q"; q: [number, number, number, number] }
  | { t: "lens"; mm: number }
  | { t: "pong"; id: number };

/**
 * What a viewer receives: the phone's own messages, plus controller presence
 * from the relay. Presence cannot be inferred from sample flow — a controller
 * that holds the slot without enabling its sensors sends nothing at all, which
 * is precisely when the viewer needs to know it is there.
 */
export type ViewerInbound = PhoneMessage | { t: "presence"; controller: boolean };

import type { SmoothingSettings } from "./smoothing";

/**
 * Rig state the phone cannot know on its own. Orientation, zoom and the
 * smoothing chain all stay local to the device, so its viewfinder never waits on
 * the network; only the dolly, the chosen demo, the delivery format and the
 * smoothing parameters have to travel.
 */
export type ViewerMessage =
  | { t: "ping"; id: number }
  | { t: "kick" }
  | {
      t: "rig";
      /** World position, sent outright so any source works — path or flown. */
      pos: [number, number, number];
      /** Set while the desktop owns aiming, as when piloting; null hands aiming
       *  back to the device's own sensor. */
      aim: [number, number, number, number] | null;
      format: number | null;
      settings: SmoothingSettings;
    };

export function relayUrl(role: "phone" | "viewer"): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}${RELAY_PATH}?role=${role}`;
}
