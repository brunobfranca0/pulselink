// Integration tests for the signal server's authorization rules.
// Runs the built server (dist/) on a random port with an isolated SQLite database and no cloud sync.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const dataDir = mkdtempSync(join(tmpdir(), "pulselink-test-"));
let server;

async function call(method, path, token, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data, headers: res.headers };
}

const register = async (name) => (await call("POST", "/v1/devices", null, { displayName: name })).data;

before(async () => {
  server = spawn(process.execPath, [join(here, "..", "dist", "index.js")], {
    env: {
      ...process.env,
      PORT: String(port),
      PULSELINK_DATA_DIR: dataDir,
      // Point cloud settings at nothing so the test never touches a real Supabase project.
      SUPABASE_URL: "https://supabase-not-configured.invalid",
      SUPABASE_SERVICE_ROLE_KEY: "test",
      SUPABASE_ANON_KEY: "test",
      DATABASE_URL: "",
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
});

after(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise((res) => server.once("exit", res));
    server.kill();
    await exited;
  }
  // SQLite may hold the file briefly on Windows; cleanup is best-effort.
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
});

describe("hosts, invitations and sessions", () => {
  let a, b, c, host, invite, sessionId;

  before(async () => {
    a = await register("OwnerA");
    b = await register("GuestB");
    c = await register("IntruderC");
    host = (await call("POST", "/v1/hosts", a.token, { name: "Host-A" })).data;
    invite = (await call("POST", "/v1/invitations", a.token, { hostId: host.id })).data;
    sessionId = (await call("POST", `/v1/invitations/${invite.code}/redeem`, b.token)).data.session.id;
  });

  test("other users' hosts are not listed", async () => {
    const r = await call("GET", "/v1/hosts", c.token);
    assert.equal(r.status, 200);
    assert.equal(r.data.availableHosts.length, 0);
  });

  test("registering a host with the same name does not take over the original", async () => {
    await call("POST", "/v1/hosts", c.token, { name: "Host-A" });
    await call("PATCH", "/v1/devices/me", c.token, { displayName: "Host-A" });
    await call("GET", "/v1/hosts", c.token);
    const r = await call("GET", "/v1/hosts", a.token);
    assert.equal(r.data.myHosts[0].id, host.id);
    assert.equal(r.data.myHosts[0].ownerDeviceId, a.device.id);
  });

  test("only the owner lists invite codes", async () => {
    assert.equal((await call("GET", `/v1/invitations?hostId=${host.id}`, c.token)).status, 403);
    const own = await call("GET", `/v1/invitations?hostId=${host.id}`, a.token);
    assert.equal(own.status, 200);
    assert.equal(own.data.length, 1);
  });

  test("only members read a session; members receive its key", async () => {
    assert.equal((await call("GET", `/v1/sessions/${sessionId}/details`, c.token)).status, 403);
    assert.equal((await call("GET", `/v1/sessions/${sessionId}`, c.token)).status, 403);
    const guest = await call("GET", `/v1/sessions/${sessionId}`, b.token);
    assert.equal(guest.status, 200);
    assert.match(guest.data.sessionKey, /^[0-9a-f]{64}$/);
    assert.equal((await call("GET", `/v1/sessions/${sessionId}/details`, a.token)).status, 200);
  });

  test("wildcard Peer ID redeem is rejected", async () => {
    const r = await call("POST", `/v1/invitations/${encodeURIComponent("%")}/redeem`, c.token);
    assert.equal(r.status, 404);
  });

  test("WebSocket: non-members cannot subscribe, signal or receive events", async () => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/v1/ws?token=${c.token}`);
    const msgs = [];
    await new Promise((res) => ws.addEventListener("open", res));
    ws.addEventListener("message", (e) => msgs.push(JSON.parse(e.data)));
    ws.send(JSON.stringify({ type: "subscribe", sessionId }));
    ws.send(JSON.stringify({ type: "signal.offer", sessionId, sdp: "x" }));
    await new Promise((res) => setTimeout(res, 250));
    await call("POST", `/v1/sessions/${sessionId}/approve`, a.token);
    await new Promise((res) => setTimeout(res, 250));
    ws.close();
    assert.equal(msgs.filter((m) => m.type === "error" && m.message === "Forbidden").length, 2);
    assert.ok(!msgs.some((m) => m.type?.startsWith("session.")));
  });

  test("approval alone grants no remote control to a non-friend", async () => {
    const details = (await call("GET", `/v1/sessions/${sessionId}/details`, a.token)).data;
    assert.equal(details.session.status, "active");
    const guest = details.participants.find((p) => p.role === "guest");
    assert.equal(guest.permissions.keyboard, false);
    assert.equal(guest.permissions.mouse, false);
  });

  test("kicked participants lose access", async () => {
    const details = (await call("GET", `/v1/sessions/${sessionId}/details`, a.token)).data;
    const guest = details.participants.find((p) => p.role === "guest");
    assert.equal((await call("POST", `/v1/sessions/${sessionId}/participants/${guest.id}/kick`, a.token)).status, 200);
    assert.equal((await call("GET", `/v1/sessions/${sessionId}`, b.token)).status, 403);
  });
});

describe("moonlight", () => {
  test("hosts are private to their owner", async () => {
    const a = await register("MlOwner");
    const c = await register("MlIntruder");
    // 192.0.2.0/24 is TEST-NET-1: never routable, so the probe fails fast and offline.
    const mh = (await call("POST", "/v1/moonlight/hosts", a.token, { address: "192.0.2.10" })).data;
    assert.equal(mh.status, "offline");
    assert.equal((await call("GET", "/v1/moonlight/hosts", c.token)).data.length, 0);
    for (const action of ["pair", "pair-cancel", "unpair", "apps", "wake", "launch"]) {
      const r = await call("POST", `/v1/moonlight/hosts/${mh.id}/${action}`, c.token, {});
      assert.equal(r.status, 403, action);
    }
    assert.equal((await call("DELETE", `/v1/moonlight/hosts/${mh.id}`, c.token)).status, 403);
    assert.equal((await call("GET", `/v1/moonlight/hosts/${mh.id}`, a.token)).status, 200);
  });

  test("rejects invalid addresses", async () => {
    const a = await register("MlOwner2");
    const r = await call("POST", "/v1/moonlight/hosts", a.token, { address: "evil host; rm" });
    assert.equal(r.status, 400);
  });
});

describe("hardening", () => {
  test("invalid JSON → 400, oversized body → 413", async () => {
    const a = await register("Hard");
    assert.equal((await call("PATCH", "/v1/devices/me", a.token, "{bad")).status, 400);
    const big = JSON.stringify({ displayName: "x".repeat(70_000) });
    assert.equal((await call("PATCH", "/v1/devices/me", a.token, big)).status, 413);
  });

  test("CORS only for the app's own origins", async () => {
    const evil = await call("GET", "/health", null, undefined, { origin: "https://evil.example" });
    assert.equal(evil.headers.get("access-control-allow-origin"), null);
    const app = await call("GET", "/health", null, undefined, { origin: "null" });
    assert.equal(app.headers.get("access-control-allow-origin"), "null");
  });

  test("unauthenticated API calls are rejected", async () => {
    assert.equal((await call("GET", "/v1/hosts")).status, 401);
  });

  test("device registration is rate limited", async () => {
    let limited = false;
    for (let i = 0; i < 12; i++) {
      if ((await call("POST", "/v1/devices", null, { displayName: "spam" })).status === 429) limited = true;
    }
    assert.ok(limited);
  });
});
