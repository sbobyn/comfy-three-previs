import type { Server as HttpServer } from "node:http";
import type { Http2SecureServer } from "node:http2";
import { WebSocketServer, type WebSocket } from "ws";
import { RELAY_PATH, REPLACED_BY_NEWER } from "../src/protocol";

/**
 * Attaches to Vite's own HTTP server so the phone page and the socket share one
 * origin and one port — a single tunnel then covers both, with no CORS and no
 * hardcoded LAN address.
 */
export function attachRelay(httpServer: HttpServer | Http2SecureServer): void {
  const wss = new WebSocketServer({ noServer: true });
  const viewers = new Set<WebSocket>();
  let phone: WebSocket | null = null;

  console.log(`[vcam] relay attached at ${RELAY_PATH}`);

  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    // Vite's HMR socket shares this server, so anything else must fall through
    // to its own upgrade listener untouched.
    if (url.pathname !== RELAY_PATH) return;

    wss.handleUpgrade(request, socket, head, (ws) => {
      const isPhone = url.searchParams.get("role") === "phone";

      if (isPhone) {
        phone?.close(REPLACED_BY_NEWER, "replaced by a newer controller");
        phone = ws;
      } else {
        viewers.add(ws);
      }

      ws.on("message", (raw) => {
        const text = raw.toString();
        if (isPhone) {
          for (const viewer of viewers) viewer.send(text);
        } else {
          phone?.send(text);
        }
      });

      ws.on("close", () => {
        if (isPhone) {
          if (phone === ws) phone = null;
        } else {
          viewers.delete(ws);
        }
      });
    });
  });
}
