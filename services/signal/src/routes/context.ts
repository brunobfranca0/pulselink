import type { DatabaseSync } from "node:sqlite";
import type { Store } from "../db.js";
import { httpError } from "../http.js";
import type { Hub } from "../hub.js";
import type { MoonlightService } from "../moonlight.js";

export type AppDeps = {
  db: DatabaseSync;
  store: Store;
  hub: Hub;
  moonlight: MoonlightService;
};

export function requireSessionMember(store: Store, sessionId: string, deviceId: string) {
  if (!store.getSession(sessionId)) throw httpError(404, "Sessão não encontrada");
  if (!store.participantDeviceIds(sessionId).includes(deviceId)) throw httpError(403, "Forbidden");
}

export function requireHostOwner(store: Store, hostId: string, deviceId: string) {
  const host = store.getHost(hostId);
  if (!host) throw httpError(404, "Host não encontrado");
  if (host.ownerDeviceId !== deviceId) throw httpError(403, "Forbidden");
  return host;
}
