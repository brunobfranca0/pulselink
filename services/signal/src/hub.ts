import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { WsClientMessage, WsServerMessage } from "@pulselink/protocol";
import type { Store } from "./db.js";

type Client = { ws: WebSocket; deviceId: string };

/**
 * WebSocket hub: pushes session/host events to devices and relays WebRTC signaling between
 * members of the same session (local mode, when not signed in to the cloud).
 */
export function createHub(server: Server, store: Store) {
  const clients = new Set<Client>();

  const send = (ws: WebSocket, msg: WsServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  const isMember = (sessionId: string, deviceId: string) =>
    store.participantDeviceIds(sessionId).includes(deviceId);

  const broadcastAll = (msg: WsServerMessage) => {
    for (const c of clients) send(c.ws, msg);
  };

  /** Delivers only to current members (participants not removed, plus the host owner). */
  const broadcastSession = (sessionId: string, msg: WsServerMessage, excludeDeviceId?: string) => {
    const members = new Set(store.participantDeviceIds(sessionId));
    for (const c of clients) {
      if (c.deviceId === excludeDeviceId) continue;
      if (members.has(c.deviceId)) send(c.ws, msg);
    }
  };

  const sendToDevice = (deviceId: string, msg: WsServerMessage) => {
    for (const c of clients) if (c.deviceId === deviceId) send(c.ws, msg);
  };

  const wss = new WebSocketServer({ server, path: "/v1/ws", maxPayload: 256 * 1024 });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const device = store.deviceByToken(url.searchParams.get("token") ?? "");
    if (!device) {
      send(ws, { type: "error", message: "Unauthorized" });
      ws.close();
      return;
    }
    const client: Client = { ws, deviceId: device.id };
    clients.add(client);
    send(ws, { type: "hello", deviceId: device.id });

    ws.on("message", (raw) => {
      let msg: WsClientMessage;
      try {
        msg = JSON.parse(String(raw)) as WsClientMessage;
      } catch {
        send(ws, { type: "error", message: "JSON inválido" });
        return;
      }
      if (msg.type === "ping") {
        send(ws, { type: "pong" });
        return;
      }
      // Every session-scoped message requires membership; otherwise any device could
      // eavesdrop on or inject into other people's sessions.
      if (!("sessionId" in msg) || !isMember(msg.sessionId, device.id)) {
        send(ws, { type: "error", message: "Forbidden" });
        return;
      }

      switch (msg.type) {
        case "subscribe":
          return;
        case "media.endpoint": {
          const session = store.getSession(msg.sessionId);
          const host = session ? store.getHost(session.hostId) : null;
          if (!host || host.ownerDeviceId !== device.id) {
            send(ws, { type: "error", message: "Somente o host define endpoint" });
            return;
          }
          store.patchHost(host.id, { mediaEndpoint: msg.endpoint });
          broadcastSession(msg.sessionId, msg);
          return;
        }
        case "signal.ready":
          broadcastSession(msg.sessionId, { ...msg, fromDeviceId: device.id }, device.id);
          return;
        case "signal.offer":
        case "signal.answer":
          broadcastSession(
            msg.sessionId,
            { type: msg.type, sessionId: msg.sessionId, sdp: msg.sdp, fromDeviceId: device.id },
            device.id,
          );
          return;
        case "signal.candidate":
          broadcastSession(
            msg.sessionId,
            {
              type: "signal.candidate",
              sessionId: msg.sessionId,
              candidate: msg.candidate,
              fromDeviceId: device.id,
            },
            device.id,
          );
          return;
      }
    });

    ws.on("close", () => clients.delete(client));
  });

  return { broadcastAll, broadcastSession, sendToDevice };
}

export type Hub = ReturnType<typeof createHub>;
