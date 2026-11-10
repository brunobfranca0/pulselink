import { httpError, type Router } from "../http.js";
import type { AppDeps } from "./context.js";

export function registerFriendRoutes(r: Router, { store }: AppDeps) {
  r.get("/v1/friends", ({ device }) => store.listFriendships(device.id));

  r.post(
    "/v1/friends",
    async ({ device, body }) => {
      const { friendInput } = await body<{ friendInput?: string }>();
      if (!friendInput?.trim()) throw httpError(400, "Informe um usuário ou Peer ID");
      return store.addFriendship(device.id, friendInput);
    },
    { status: 201 },
  );

  r.patch("/v1/friends/:id", async ({ device, params, body }) => {
    const patch = await body<{ keyboard?: boolean; mouse?: boolean; gamepad?: boolean; autoConnect?: boolean }>();
    const updated = store.updateFriendship(device.id, params.id!, patch);
    if (!updated) throw httpError(404, "Amizade não encontrada");
    return updated;
  });

  r.delete("/v1/friends/:id", ({ device, params }) => {
    store.deleteFriendship(device.id, params.id!);
    return { ok: true };
  });
}
