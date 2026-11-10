import type { Host } from "@pulselink/protocol";
import { httpError, type Router } from "../http.js";
import { requireHostOwner, type AppDeps } from "./context.js";

export function registerHostRoutes(r: Router, { store, hub }: AppDeps) {
  r.get("/v1/hosts", ({ device }) => store.listHosts(device.id));

  r.post(
    "/v1/hosts",
    async ({ device, body }) => {
      const b = await body<{
        name?: string;
        capabilities?: Record<string, unknown>;
        mediaEndpoint?: string | null;
      }>();
      const host = store.createHost(device.id, b.name ?? device.displayName, b.capabilities ?? {}, b.mediaEndpoint ?? null);
      hub.broadcastAll({ type: "host.updated", host });
      return host;
    },
    { status: 201 },
  );

  r.patch("/v1/hosts/:id", async ({ device, params, body }) => {
    requireHostOwner(store, params.id!, device.id);
    const patch = await body<{
      status?: Host["status"];
      mediaEndpoint?: string | null;
      name?: string;
      capabilities?: Record<string, unknown>;
    }>();
    if (patch.status && !["offline", "online", "busy"].includes(patch.status)) {
      throw httpError(400, "status inválido");
    }
    const updated = store.patchHost(params.id!, patch);
    if (updated) hub.broadcastAll({ type: "host.updated", host: updated });
    return updated;
  });

  r.post(
    "/v1/hosts/:id/connect",
    async ({ device, params, body }) => {
      const { streamProfile } = await body<{ streamProfile?: Record<string, unknown> }>();
      const result = store.connectHostDirect(params.id!, device.id, streamProfile ?? {});
      if (!result.isOwner) {
        hub.broadcastSession(result.session.id, {
          type: "session.pending",
          session: result.session,
          participant: result.participant,
        });
      }
      return result;
    },
    { status: 201 },
  );

  // --- Invitations (share links) ---
  r.get("/v1/invitations", ({ device, query }) => {
    const hostId = query.get("hostId") ?? "";
    if (!hostId) return [];
    requireHostOwner(store, hostId, device.id);
    return store.listInvitationsForHost(hostId);
  });

  r.post(
    "/v1/invitations",
    async ({ device, body }) => {
      const b = await body<{ hostId?: string; maxUses?: number; expiresInSeconds?: number }>();
      if (!b.hostId) throw httpError(400, "hostId obrigatório");
      requireHostOwner(store, b.hostId, device.id);
      const maxUses = Math.min(Math.max(Number(b.maxUses) || 5, 1), 50);
      const ttl = Math.min(Math.max(Number(b.expiresInSeconds) || 7200, 60), 7 * 24 * 3600);
      return store.createInvitation(b.hostId, maxUses, ttl);
    },
    { status: 201 },
  );

  r.post(
    "/v1/invitations/:code/redeem",
    async ({ device, params }) => {
      const result = store.redeemInvitation(params.code!, device.id);
      hub.broadcastSession(result.session.id, {
        type: "session.pending",
        session: result.session,
        participant: result.participant,
      });
      return {
        session: result.session,
        participant: result.participant,
        permissions: result.permissions,
        host: result.host,
      };
    },
    { status: 201 },
  );
}
