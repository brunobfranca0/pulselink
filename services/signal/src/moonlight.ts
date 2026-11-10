/**
 * Moonlight / Sunshine integration.
 *
 * PulseLink does not reimplement the GameStream protocol. It manages hosts (discovery via mDNS,
 * status via the unauthenticated /serverinfo endpoint, Wake-on-LAN) and drives the official
 * Moonlight client (moonlight-qt) through its command line for pairing, app listing and streaming.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import dgram from "node:dgram";
import { existsSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Bonjour } from "bonjour-service";
import {
  MOONLIGHT_DOWNLOAD_URL,
  type MoonlightApp,
  type MoonlightClientInfo,
  type MoonlightHost,
  type StreamProfile,
} from "@pulselink/protocol";

const DEFAULT_PORT = 47989;
const PAIR_TIMEOUT_MS = 3 * 60_000;

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------- client detection

export function findMoonlightClient(): string | null {
  const fromEnv = process.env.MOONLIGHT_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const candidates = [
    process.env.ProgramFiles && join(process.env.ProgramFiles, "Moonlight Game Streaming", "Moonlight.exe"),
    process.env["ProgramFiles(x86)"] &&
      join(process.env["ProgramFiles(x86)"], "Moonlight Game Streaming", "Moonlight.exe"),
    process.env.LOCALAPPDATA &&
      join(process.env.LOCALAPPDATA, "Programs", "Moonlight Game Streaming", "Moonlight.exe"),
    join(os.homedir(), "scoop", "apps", "moonlight", "current", "Moonlight.exe"),
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => existsSync(p)) ?? null;
}

export function moonlightClientInfo(): MoonlightClientInfo {
  const path = findMoonlightClient();
  return { installed: !!path, path, downloadUrl: MOONLIGHT_DOWNLOAD_URL };
}

function requireClient(): string {
  const path = findMoonlightClient();
  if (!path) {
    throw httpError(
      412,
      "Cliente Moonlight não encontrado. Instale em moonlight-stream.org ou defina MOONLIGHT_PATH.",
    );
  }
  return path;
}

function runClient(
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const exe = requireClient();
  return new Promise((resolve) => {
    const child = spawn(exe, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr || err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------- host probing

type ServerInfo = {
  hostname: string | null;
  mac: string | null;
  version: string | null;
  gpu: string | null;
};

function xmlTag(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`, "i").exec(xml);
  const value = m?.[1]?.trim();
  return value ? value : null;
}

/** Reads the public (HTTP, unpaired) GameStream /serverinfo document. */
export async function probeServerInfo(address: string, port: number): Promise<ServerInfo | null> {
  try {
    const res = await fetch(`http://${address}:${port}/serverinfo`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    const xml = await res.text();
    const mac = xmlTag(xml, "mac");
    return {
      hostname: xmlTag(xml, "hostname"),
      mac: mac && mac !== "00:00:00:00:00:00" ? mac.toUpperCase() : null,
      version: xmlTag(xml, "appversion") ?? xmlTag(xml, "GfeVersion"),
      gpu: xmlTag(xml, "gputype"),
    };
  } catch {
    return null;
  }
}

function discoverMdns(durationMs = 2500): Promise<{ name: string; address: string; port: number }[]> {
  return new Promise((resolve) => {
    const found = new Map<string, { name: string; address: string; port: number }>();
    let bonjour: Bonjour | null = null;
    try {
      bonjour = new Bonjour();
      bonjour.find({ type: "nvstream", protocol: "tcp" }, (svc) => {
        const ipv4 = (svc.addresses ?? []).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
        const address = ipv4 ?? svc.referer?.address;
        if (!address) return;
        found.set(`${address}:${svc.port}`, { name: svc.name, address, port: svc.port });
      });
    } catch {
      resolve([]);
      return;
    }
    setTimeout(() => {
      bonjour?.destroy();
      resolve([...found.values()]);
    }, durationMs);
  });
}

function sendMagicPacket(mac: string): Promise<void> {
  const hex = mac.replace(/[^0-9a-f]/gi, "");
  if (hex.length !== 12) return Promise.reject(httpError(400, "Endereço MAC inválido"));
  const macBuf = Buffer.from(hex, "hex");
  const packet = Buffer.alloc(6 + 16 * 6, 0xff);
  for (let i = 0; i < 16; i++) macBuf.copy(packet, 6 + i * 6);

  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    socket.once("error", (err) => {
      socket.close();
      reject(err);
    });
    socket.bind(() => {
      socket.setBroadcast(true);
      let pending = 2;
      const done = () => {
        if (--pending === 0) {
          socket.close();
          resolve();
        }
      };
      socket.send(packet, 9, "255.255.255.255", done);
      socket.send(packet, 7, "255.255.255.255", done);
    });
  });
}

// ---------------------------------------------------------------- service

type Row = {
  id: string;
  ownerDeviceId: string | null;
  name: string;
  address: string;
  port: number;
  macAddress: string;
  status: MoonlightHost["status"];
  paired: number;
  gpuModel: string;
  hostVersion: string;
  appsJson: string;
  lastSeenAt: string;
  createdAt: string;
};

type PairingJob = { pin: string; proc: ChildProcess | null; state: "pairing" | "failed"; error: string | null };

const SELECT = `select id, owner_device_id as ownerDeviceId, name, address, port,
  mac_address as macAddress, status, paired, gpu_model as gpuModel,
  host_version as hostVersion, apps_json as appsJson,
  last_seen_at as lastSeenAt, created_at as createdAt
  from moonlight_hosts`;

export function createMoonlightService(db: DatabaseSync) {
  const pairing = new Map<string, PairingJob>();

  const map = (row: Row): MoonlightHost => {
    const job = pairing.get(row.id);
    let apps: MoonlightApp[] = [];
    try {
      const parsed = JSON.parse(row.appsJson) as Partial<MoonlightApp>[];
      apps = parsed
        .filter((a) => typeof a.title === "string")
        .map((a) => ({ id: String(a.id ?? a.title), title: a.title!, hdrSupported: !!a.hdrSupported }));
    } catch {
      apps = [];
    }
    return {
      id: row.id,
      ownerDeviceId: row.ownerDeviceId,
      name: row.name,
      address: row.address,
      port: row.port,
      macAddress: row.macAddress || null,
      status: row.status,
      paired: !!row.paired,
      pendingPin: job?.state === "pairing" ? job.pin : null,
      pairingState: job?.state ?? "idle",
      lastError: job?.error ?? null,
      gpuModel: row.gpuModel || null,
      hostVersion: row.hostVersion || null,
      apps,
      lastSeenAt: row.lastSeenAt,
      createdAt: row.createdAt,
    };
  };

  const get = (id: string): MoonlightHost | null => {
    const row = db.prepare(`${SELECT} where id = ?`).get(id) as Row | undefined;
    return row ? map(row) : null;
  };

  const list = (deviceId: string): MoonlightHost[] =>
    (db.prepare(`${SELECT} where owner_device_id = ? order by created_at asc`).all(deviceId) as Row[]).map(
      map,
    );

  const hostArg = (h: Pick<MoonlightHost, "address" | "port">) =>
    h.port === DEFAULT_PORT ? h.address : `${h.address}:${h.port}`;

  const applyProbe = (id: string, info: ServerInfo | null) => {
    if (!info) {
      db.prepare(`update moonlight_hosts set status = 'offline' where id = ?`).run(id);
      return;
    }
    db.prepare(
      `update moonlight_hosts
       set status = 'online', last_seen_at = ?,
           mac_address = coalesce(?, mac_address),
           host_version = coalesce(?, host_version),
           gpu_model = coalesce(?, gpu_model)
       where id = ?`,
    ).run(nowIso(), info.mac, info.version, info.gpu, id);
  };

  const add = async (
    deviceId: string,
    input: { name?: string; address: string; port?: number },
  ): Promise<MoonlightHost> => {
    const address = input.address.trim();
    if (!/^[\w.-]+$/.test(address)) throw httpError(400, "Endereço inválido");
    const port = Number(input.port) || DEFAULT_PORT;
    const existing = db
      .prepare(`select id from moonlight_hosts where owner_device_id = ? and address = ? and port = ?`)
      .get(deviceId, address, port) as { id: string } | undefined;
    const info = await probeServerInfo(address, port);
    if (existing) {
      applyProbe(existing.id, info);
      return get(existing.id)!;
    }
    const id = randomUUID();
    const now = nowIso();
    db.prepare(
      `insert into moonlight_hosts
        (id, owner_device_id, name, address, port, mac_address, status, paired, pending_pin,
         server_cert_fingerprint, gpu_model, host_version, apps_json, last_seen_at, created_at)
       values (?, ?, ?, ?, ?, ?, ?, 0, null, null, ?, ?, '[]', ?, ?)`,
    ).run(
      id,
      deviceId,
      input.name?.trim() || info?.hostname || address,
      address,
      port,
      info?.mac ?? "",
      info ? "online" : "offline",
      info?.gpu ?? "",
      info?.version ?? "",
      now,
      now,
    );
    return get(id)!;
  };

  /** Asks the Moonlight client for the host's app list. Succeeds only when the host is paired. */
  const refreshApps = async (id: string): Promise<MoonlightHost> => {
    const host = get(id);
    if (!host) throw httpError(404, "Host Moonlight não encontrado");
    const res = await runClient(["list", hostArg(host), "--csv"], 20_000);
    if (res.code !== 0) {
      db.prepare(`update moonlight_hosts set paired = 0 where id = ?`).run(id);
      return get(id)!;
    }
    const apps: MoonlightApp[] = [];
    for (const line of res.stdout.split(/\r?\n/)) {
      const cols = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)?.map((c) =>
        c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"').trim(),
      );
      if (!cols || !cols[0] || /^name$/i.test(cols[0])) continue;
      apps.push({ id: cols[1] || cols[0], title: cols[0], hdrSupported: /true|1/i.test(cols[2] ?? "") });
    }
    if (apps.length === 0) apps.push({ id: "Desktop", title: "Desktop", hdrSupported: false });
    db.prepare(`update moonlight_hosts set paired = 1, apps_json = ?, last_seen_at = ? where id = ?`).run(
      JSON.stringify(apps),
      nowIso(),
      id,
    );
    return get(id)!;
  };

  const startPairing = (id: string): MoonlightHost => {
    const host = get(id);
    if (!host) throw httpError(404, "Host Moonlight não encontrado");
    const exe = requireClient();
    pairing.get(id)?.proc?.kill();

    const pin = String(randomInt(1000, 10000));
    const job: PairingJob = { pin, proc: null, state: "pairing", error: null };
    pairing.set(id, job);

    const proc = spawn(exe, ["pair", hostArg(host), "--pin", pin], { windowsHide: false });
    job.proc = proc;
    let output = "";
    proc.stdout?.on("data", (d: Buffer) => (output += d.toString("utf8")));
    proc.stderr?.on("data", (d: Buffer) => (output += d.toString("utf8")));
    const timer = setTimeout(() => proc.kill(), PAIR_TIMEOUT_MS);
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (pairing.get(id) !== job) return; // superseded or cancelled
      if (code === 0) {
        pairing.delete(id);
        db.prepare(`update moonlight_hosts set paired = 1 where id = ?`).run(id);
        void refreshApps(id).catch(() => {});
      } else {
        job.state = "failed";
        job.proc = null;
        const lastLine = output.trim().split(/\r?\n/).pop();
        job.error = lastLine || "Pareamento não concluído (PIN não confirmado no Sunshine?)";
      }
    });
    proc.on("error", (err) => {
      job.state = "failed";
      job.error = err.message;
    });
    return get(id)!;
  };

  const cancelPairing = (id: string): MoonlightHost | null => {
    pairing.get(id)?.proc?.kill();
    pairing.delete(id);
    return get(id);
  };

  /** Forgets the pairing locally. The client certificate must also be removed in Sunshine's web UI. */
  const unpair = (id: string): MoonlightHost | null => {
    cancelPairing(id);
    db.prepare(`update moonlight_hosts set paired = 0, apps_json = '[]' where id = ?`).run(id);
    return get(id);
  };

  const wake = async (id: string): Promise<MoonlightHost> => {
    const host = get(id);
    if (!host) throw httpError(404, "Host Moonlight não encontrado");
    if (!host.macAddress) {
      throw httpError(409, "MAC do host desconhecido. Conecte-se uma vez com o host ligado.");
    }
    await sendMagicPacket(host.macAddress);
    return host;
  };

  const launch = (id: string, appTitle: string, profile: Partial<StreamProfile>): MoonlightHost => {
    const host = get(id);
    if (!host) throw httpError(404, "Host Moonlight não encontrado");
    if (!host.paired) throw httpError(409, "Pareie com o host antes de transmitir");
    const exe = requireClient();
    const args = ["stream", hostArg(host), appTitle || "Desktop"];
    if (profile.resolution) args.push("--resolution", profile.resolution);
    if (profile.fps) args.push("--fps", String(profile.fps));
    if (profile.bitrateMbps) args.push("--bitrate", String(Math.round(profile.bitrateMbps * 1000)));
    const codec = { h264: "H.264", hevc: "HEVC", av1: "AV1" }[profile.codec as string];
    if (codec) args.push("--video-codec", codec);
    const child = spawn(exe, args, { detached: true, stdio: "ignore" });
    child.unref();
    return host;
  };

  const remove = (id: string) => {
    cancelPairing(id);
    db.prepare(`delete from moonlight_hosts where id = ?`).run(id);
  };

  /** Discovers Sunshine hosts via mDNS (and localhost), then refreshes status of all saved hosts. */
  const scan = async (deviceId: string): Promise<MoonlightHost[]> => {
    const discovered = await discoverMdns();
    const local = await probeServerInfo("127.0.0.1", DEFAULT_PORT);
    if (local) discovered.push({ name: local.hostname ?? os.hostname(), address: "127.0.0.1", port: DEFAULT_PORT });
    for (const d of discovered) {
      await add(deviceId, { name: d.name, address: d.address, port: d.port });
    }
    await Promise.all(
      list(deviceId).map(async (h) => applyProbe(h.id, await probeServerInfo(h.address, h.port))),
    );
    return list(deviceId);
  };

  return {
    client: moonlightClientInfo,
    get,
    list,
    add,
    scan,
    refreshApps,
    startPairing,
    cancelPairing,
    unpair,
    wake,
    launch,
    remove,
  };
}

export type MoonlightService = ReturnType<typeof createMoonlightService>;
