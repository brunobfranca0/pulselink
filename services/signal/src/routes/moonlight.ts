import type { StreamProfile } from "@pulselink/protocol";
import { httpError, type Router } from "../http.js";
import type { AppDeps } from "./context.js";

export function registerMoonlightRoutes(r: Router, { moonlight }: AppDeps) {
  const owned = (id: string, deviceId: string) => {
    const host = moonlight.get(id);
    if (!host) throw httpError(404, "Host Moonlight não encontrado");
    if (host.ownerDeviceId !== deviceId) throw httpError(403, "Forbidden");
    return host;
  };

  r.get("/v1/moonlight/client", () => moonlight.client());
  r.get("/v1/moonlight/hosts", ({ device }) => moonlight.list(device.id));
  r.post("/v1/moonlight/scan", ({ device }) => moonlight.scan(device.id));

  r.post(
    "/v1/moonlight/hosts",
    async ({ device, body }) => {
      const b = await body<{ name?: string; address?: string; port?: number }>();
      if (!b.address?.trim()) throw httpError(400, "Endereço IP ou hostname é obrigatório");
      return moonlight.add(device.id, { name: b.name, address: b.address, port: b.port });
    },
    { status: 201 },
  );

  r.get("/v1/moonlight/hosts/:id", ({ device, params }) => owned(params.id!, device.id));

  r.post("/v1/moonlight/hosts/:id/pair", ({ device, params }) => {
    owned(params.id!, device.id);
    return moonlight.startPairing(params.id!);
  });

  r.post("/v1/moonlight/hosts/:id/pair-cancel", ({ device, params }) => {
    owned(params.id!, device.id);
    return moonlight.cancelPairing(params.id!);
  });

  r.post("/v1/moonlight/hosts/:id/unpair", ({ device, params }) => {
    owned(params.id!, device.id);
    return moonlight.unpair(params.id!);
  });

  r.post("/v1/moonlight/hosts/:id/apps", ({ device, params }) => {
    owned(params.id!, device.id);
    return moonlight.refreshApps(params.id!);
  });

  r.post("/v1/moonlight/hosts/:id/wake", ({ device, params }) => {
    owned(params.id!, device.id);
    return moonlight.wake(params.id!);
  });

  r.post("/v1/moonlight/hosts/:id/launch", async ({ device, params, body }) => {
    owned(params.id!, device.id);
    const b = await body<{ appTitle?: string; streamProfile?: Partial<StreamProfile> }>();
    return moonlight.launch(params.id!, b.appTitle ?? "Desktop", b.streamProfile ?? {});
  });

  r.delete("/v1/moonlight/hosts/:id", ({ device, params }) => {
    owned(params.id!, device.id);
    moonlight.remove(params.id!);
    return { ok: true };
  });
}
