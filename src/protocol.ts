export const RELAY_PATH = "/vcam";

/**
 * Sent to a phone that a newer one has taken over from. The displaced client must
 * not reconnect: two auto-reconnecting controllers would each evict the other
 * about once a second, and the viewer would see a stuttering, half-dead stream.
 */
export const REPLACED_BY_NEWER = 4000;

export type PhoneMessage =
  | { t: "q"; q: [number, number, number, number] }
  | { t: "pong"; id: number };

export type ViewerMessage = { t: "ping"; id: number };

export function relayUrl(role: "phone" | "viewer"): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}${RELAY_PATH}?role=${role}`;
}
