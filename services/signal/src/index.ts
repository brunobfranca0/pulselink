import { createServer } from "node:http";
import { DEFAULT_SIGNAL_PORT } from "@pulselink/protocol";
import { createStore, openDb } from "./db.js";
import { Router } from "./http.js";
import { createHub } from "./hub.js";
import { createMoonlightService } from "./moonlight.js";
import type { AppDeps } from "./routes/context.js";
import { registerFriendRoutes } from "./routes/friends.js";
import { registerHostRoutes } from "./routes/hosts.js";
import { registerMoonlightRoutes } from "./routes/moonlight.js";
import { registerPlayStationRoutes } from "./routes/playstation.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerSystemRoutes } from "./routes/system.js";

const db = openDb();
const store = createStore(db);
const moonlight = createMoonlightService(db);
const port = Number(process.env.PORT ?? DEFAULT_SIGNAL_PORT);

// --- HTTP + WebSocket ---------------------------------------------------------------------
const router = new Router((req) => {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return token ? store.deviceByToken(token) : null;
});

const server = createServer((req, res) => void router.handle(req, res));
const hub = createHub(server, store);

const deps: AppDeps = {
  db,
  store,
  hub,
  moonlight,
};

registerSystemRoutes(router, deps);
registerHostRoutes(router, deps);
registerSessionRoutes(router, deps);
registerFriendRoutes(router, deps);
registerMoonlightRoutes(router, deps);
registerPlayStationRoutes(router);

// Loopback by default: the desktop app talks to its own local signal server.
// Set SIGNAL_HOST=0.0.0.0 only if you deliberately want to expose it to the LAN.
const bindHost = process.env.SIGNAL_HOST ?? "127.0.0.1";
server.listen(port, bindHost, () => {
  console.log(`PulseLink signal em http://${bindHost}:${port}`);
});
