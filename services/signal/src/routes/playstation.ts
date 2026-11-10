import { httpError, type Router } from "../http.js";
import { chiakiInfo, discoverConsoles, launchStream, openClient } from "../playstation.js";

export function registerPlayStationRoutes(r: Router) {
  r.get("/v1/playstation/client", () => chiakiInfo());

  r.post("/v1/playstation/discover", async ({ body }) => {
    const { addresses } = await body<{ addresses?: unknown }>();
    const list = Array.isArray(addresses) ? addresses.filter((a): a is string => typeof a === "string") : [];
    return discoverConsoles(list);
  });

  r.post("/v1/playstation/launch", async ({ body }) => {
    const b = await body<{ nickname?: string; address?: string; fullscreen?: boolean }>();
    if (!b.nickname || !b.address) throw httpError(400, "nickname e address são obrigatórios");
    return launchStream({ nickname: b.nickname, address: b.address, fullscreen: !!b.fullscreen });
  });

  r.post("/v1/playstation/open-client", () => openClient());
}
