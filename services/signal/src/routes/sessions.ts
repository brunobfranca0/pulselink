import type { WsServerMessage } from "@pulselink/protocol";
import type { Router } from "../http.js";
import { requireSessionMember, type AppDeps } from "./context.js";

export function registerSessionRoutes(r: Router, { store, hub }: AppDeps) {
  r.get("/v1/sessions/pending", ({ device }) =>
    store.listPendingForHost(device.id).map((d) => d.session),
  );
  r.get("/v1/sessions/pending-details", ({ device }) => store.listPendingForHost(device.id));
  r.get("/v1/sessions/active", ({ device }) => store.listActiveSessionsForDevice(device.id));

  r.get("/v1/sessions/:id/details", ({ device, params }) => {
    requireSessionMember(store, params.id!, device.id);
    return store.getSessionDetails(params.id!);
  });

  r.get("/v1/sessions/:id", ({ device, params }) => {
    requireSessionMember(store, params.id!, device.id);
    return store.getSession(params.id!);
  });

  r.post("/v1/sessions/:id/approve", ({ device, params }) => {
    const id = params.id!;
    const result = store.approveSession(id, device.id);
    hub.broadcastSession(id, {
      type: "session.approved",
      session: result.session,
      mediaEndpoint: result.host.mediaEndpoint,
    });
    if (result.permissions) {
      hub.broadcastSession(id, { type: "permissions.updated", sessionId: id, permissions: result.permissions });
    }
    return result.session;
  });

  r.post("/v1/sessions/:id/deny", ({ device, params }) => {
    const session = store.denySession(params.id!, device.id);
    hub.broadcastSession(params.id!, { type: "session.denied", session });
    return session;
  });

  r.post("/v1/sessions/:id/end", ({ device, params }) => {
    const session = store.endSession(params.id!, device.id);
    hub.broadcastSession(params.id!, { type: "session.ended", session });
    return session;
  });

  r.put("/v1/sessions/:id/participants/:pid/permissions", async ({ device, params, body }) => {
    const b = await body<{ keyboard?: boolean; mouse?: boolean; gamepad?: boolean }>();
    const permissions = store.setPermissions(params.id!, params.pid!, device.id, {
      keyboard: !!b.keyboard,
      mouse: !!b.mouse,
      gamepad: !!b.gamepad,
    });
    hub.broadcastSession(params.id!, { type: "permissions.updated", sessionId: params.id!, permissions });
    return permissions;
  });

  r.post("/v1/sessions/:id/participants/:pid/kick", ({ device, params }) => {
    const removed = store.kickParticipant(params.id!, params.pid!, device.id);
    const msg: WsServerMessage = { type: "participant.kicked", sessionId: params.id!, participantId: removed.id };
    hub.broadcastSession(params.id!, msg);
    // The kicked device is no longer a member, so notify it directly.
    hub.sendToDevice(removed.deviceId, msg);
    return removed;
  });
}
