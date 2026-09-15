export const RELAY_PATH = "/vcam";

export type PhoneMessage =
  | { t: "q"; q: [number, number, number, number] }
  | { t: "pong"; id: number };

export type ViewerMessage = { t: "ping"; id: number };

export function relayUrl(role: "phone" | "viewer"): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}${RELAY_PATH}?role=${role}`;
}
