import { APP_VERSION } from "@pulselink/protocol";
import { httpError, type Router } from "../http.js";
import type { AppDeps } from "./context.js";

// Simple fixed-window rate limit for unauthenticated device registration.
const registrations = new Map<string, { count: number; resetAt: number }>();
function allowRegistration(ip: string): boolean {
  const now = Date.now();
  const entry = registrations.get(ip);
  if (!entry || entry.resetAt < now) {
    registrations.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  entry.count += 1;
  return entry.count <= 10;
}

export function registerSystemRoutes(r: Router, { store }: AppDeps) {
  r.get("/health", () => ({ ok: true, service: "pulselink-signal", version: APP_VERSION }), { public: true });

  r.post(
    "/v1/devices",
    async ({ req, body }) => {
      if (!allowRegistration(req.socket.remoteAddress ?? "unknown")) {
        throw httpError(429, "Muitas requisições, tente novamente em instantes");
      }
      const { displayName } = await body<{ displayName?: string }>();
      return store.registerDevice(displayName ?? "Device");
    },
    { public: true, status: 201 },
  );

  r.patch("/v1/devices/me", async ({ device, body }) => {
    const { displayName } = await body<{ displayName?: string }>();
    return store.updateDeviceName(device.id, displayName ?? device.displayName);
  });
}
