import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Server as HttpsServer } from "node:https";
import { validPhoneMessage } from "./phone-protocol";
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
export function attachRelay(httpServer: HttpServer | Http2SecureServer) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  const viewers = new Set<WebSocket>();
  let phone: WebSocket | null = null;
  // [director-phone] The viewer that sent "claim" is the only one whose rig/ping reaches the phone.
  let owner: WebSocket | null = null;

  const presence = (viewer?: WebSocket): string => JSON.stringify({ t: "presence", controller: phone !== null, ...(owner ? { owner: owner === viewer } : {}) });
  const broadcastPresence = (): void => {
    for (const viewer of viewers) viewer.send(presence(viewer));
  };

  console.log(`[vcam] relay attached at ${RELAY_PATH}`);

  const attach = (target: HttpServer | Http2SecureServer | HttpsServer, authorize?: (request: IncomingMessage) => boolean) => target.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    // Vite's HMR socket shares this server, so anything else must fall through
    // to its own upgrade listener untouched.
    if (url.pathname !== RELAY_PATH) { if(authorize)socket.destroy(); return; }
    if(authorize && (!authorize(request) || url.searchParams.get("role")!=="phone")){socket.destroy();return;}
    if(!authorize && !request.headers.host?.match(/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/)){socket.destroy();return;}

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
        ws.send(presence(ws));
      }

      let messages=0,windowAt=Date.now();
      ws.on("message", (raw) => {
        if(Date.now()-windowAt>=1000){messages=0;windowAt=Date.now();}
        if(++messages>240){ws.close(4003,"Input rate exceeded");return;}
        const text = raw.toString();
        if (isPhone) {
          if(phone!==ws || !validPhoneMessage(text))return;
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
        // [director-phone] claim ownership; once owned, other viewers no longer steer the phone.
        if (parseKind(text) === "claim") { owner = ws; broadcastPresence(); return; }
        if (owner && owner !== ws) return;
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
          if (owner === ws) { owner = null; broadcastPresence(); } // [director-phone]
        }
      });
    });
  });
  attach(httpServer);
  return {
    attachPhoneServer: (target: HttpsServer, authorize: (request: IncomingMessage) => boolean) => attach(target,authorize),
    revoke: () => {phone?.close(EVICTED_BY_VIEWER,'Pairing revoked');phone=null;broadcastPresence();},
    close: () => {for(const ws of wss.clients)ws.close();wss.close();},
  };
}
