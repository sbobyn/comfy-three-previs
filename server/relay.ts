import type { Server as HttpServer } from "node:http";
import type { Http2SecureServer } from "node:http2";
import { WebSocketServer, type WebSocket } from "ws";
import { EVICTED_BY_VIEWER, RELAY_PATH, REPLACED_BY_NEWER } from "../src/protocol";

function parseKind(text: string): string | null {
  try {
    return (JSON.parse(text) as { t?: string }).t ?? null;
  } catch {
    return null;
  }
}

/**
 * Attaches to Vite's own HTTP server so the phone page and the socket share one
 * origin and one port — a single tunnel then covers both, with no CORS and no
 * hardcoded LAN address.
 */
export function attachRelay(httpServer: HttpServer | Http2SecureServer): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  const viewers = new Set<WebSocket>();
  let phone: WebSocket | null = null;

  const presence = (): string => JSON.stringify({ t: "presence", controller: phone !== null });
  const broadcastPresence = (): void => {
    const text = presence();
    for (const viewer of viewers) viewer.send(text);
  };

  console.log(`[vcam] relay attached at ${RELAY_PATH}`);

  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    // Vite's HMR socket shares this server, so anything else must fall through
    // to its own upgrade listener untouched.
    if (url.pathname !== RELAY_PATH) return;

    if (request.headers.origin) {
      try {
        if (new URL(request.headers.origin).host !== request.headers.host) { socket.destroy(); return; }
      } catch { socket.destroy(); return; }
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const isPhone = url.searchParams.get("role") === "phone";

      if (isPhone) {
        phone?.close(REPLACED_BY_NEWER, "replaced by a newer controller");
        phone = ws;
        broadcastPresence();
      } else {
        viewers.add(ws);
        ws.send(presence());
      }

      ws.on("message", (raw) => {
        const text = raw.toString();
        if (isPhone) {
          for (const viewer of viewers) viewer.send(text);
          return;
        }
        // The relay is otherwise a dumb pipe, but a kick has to be acted on here
        // rather than forwarded — the point is to hang up on a controller that
        // may already be unresponsive.
        if (parseKind(text) === "kick") {
          phone?.close(EVICTED_BY_VIEWER, "disconnected from the viewer");
          phone = null;
          broadcastPresence();
          return;
        }
        phone?.send(text);
      });

      ws.on("close", () => {
        if (isPhone) {
          if (phone === ws) {
            phone = null;
            broadcastPresence();
          }
        } else {
          viewers.delete(ws);
        }
      });
    });
  });
}
