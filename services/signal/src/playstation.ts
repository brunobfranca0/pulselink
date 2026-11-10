/**
 * PlayStation 4 / 5 Remote Play.
 *
 * Consoles cannot run host software, so PulseLink drives the open-source Remote Play client
 * chiaki-ng (https://streetpea.github.io/chiaki-ng/). PulseLink discovers consoles on the LAN
 * with Sony's discovery protocol, reads which consoles are registered in chiaki-ng
 * (`chiaki list`) and starts streams with `chiaki stream <nickname> <host>`.
 * Registering a console (PSN account ID + PIN from the console) happens once in chiaki-ng.
 */
import { spawn } from "node:child_process";
import dgram from "node:dgram";
import { existsSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import {
  CHIAKI_DOWNLOAD_URL,
  type PlayStationClientInfo,
  type PlayStationConsole,
} from "@pulselink/protocol";

const PORTS = [
  { port: 987, version: "00020020" }, // PS4
  { port: 9302, version: "00030010" }, // PS5
];
const LOCAL_PORT_MIN = 9303;
const LOCAL_PORT_MAX = 9319;
const ADDRESS_RE = /^(\d{1,3}\.){3}\d{1,3}$|^[a-zA-Z0-9][\w.-]{0,252}$/;

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

// ------------------------------------------------------------------ client detection

export function findChiaki(): string | null {
  const fromEnv = process.env.CHIAKI_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const dirs = [
    process.env.ProgramFiles && join(process.env.ProgramFiles, "chiaki-ng"),
    process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], "chiaki-ng"),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs", "chiaki-ng"),
    join(os.homedir(), "scoop", "apps", "chiaki-ng", "current"),
  ].filter((d): d is string => Boolean(d));
  for (const dir of dirs) {
    for (const exe of ["chiaki-ng.exe", "chiaki.exe"]) {
      const p = join(dir, exe);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

function requireChiaki(): string {
  const exe = findChiaki();
  if (!exe) {
    throw httpError(412, "chiaki-ng não encontrado. Instale-o ou defina CHIAKI_PATH no .env.");
  }
  return exe;
}

/** Nicknames of consoles registered in chiaki-ng (output lines look like "Host: MyPS4"). */
async function registeredNicknames(): Promise<string[]> {
  const exe = findChiaki();
  if (!exe) return [];
  return new Promise((resolve) => {
    const child = spawn(exe, ["list"], { windowsHide: true });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString("utf8")));
    const timer = setTimeout(() => child.kill(), 8000);
    const done = () => {
      clearTimeout(timer);
      resolve(
        out
          .split(/\r?\n/)
          .map((l) => /^Host:\s*(.+)$/.exec(l.trim())?.[1]?.trim())
          .filter((n): n is string => Boolean(n)),
      );
    };
    child.on("close", done);
    child.on("error", () => {
      clearTimeout(timer);
      resolve([]);
    });
  });
}

export async function chiakiInfo(): Promise<PlayStationClientInfo> {
  const path = findChiaki();
  return {
    installed: !!path,
    path,
    registered: path ? await registeredNicknames() : [],
    downloadUrl: CHIAKI_DOWNLOAD_URL,
  };
}

// ------------------------------------------------------------------ discovery protocol

/** Parses a discovery reply: an HTTP-like status line followed by "key:value" headers. */
export function parseDiscoveryReply(text: string, address: string): Omit<PlayStationConsole, "registered"> | null {
  const lines = text.split(/\r?\n/);
  const status = /^HTTP\/1\.1\s+(\d{3})/.exec(lines[0] ?? "")?.[1];
  if (!status) return null;
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const i = line.indexOf(":");
    if (i > 0) headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  const type = (headers.get("host-type") ?? "").toUpperCase();
  return {
    address,
    hostId: headers.get("host-id") ?? address,
    name: headers.get("host-name") ?? address,
    type: type.startsWith("PS5") ? "PS5" : "PS4",
    state: status === "200" ? "ready" : status === "620" ? "standby" : "unknown",
    systemVersion: headers.get("system-version") ?? null,
    runningApp: headers.get("running-app-name") ?? null,
  };
}

function bindDiscoverySocket(): Promise<dgram.Socket> {
  return new Promise((resolve, reject) => {
    const tryPort = (port: number) => {
      const socket = dgram.createSocket({ type: "udp4", reuseAddr: false });
      socket.once("error", (err) => {
        socket.close();
        if (port < LOCAL_PORT_MAX) tryPort(port + 1);
        else reject(err);
      });
      socket.bind(port, () => {
        socket.removeAllListeners("error");
        socket.on("error", () => {});
        socket.setBroadcast(true);
        resolve(socket);
      });
    };
    tryPort(LOCAL_PORT_MIN);
  });
}

/**
 * Broadcasts a search on the LAN (and unicasts to any extra addresses, e.g. a console on
 * another subnet) and collects replies for `durationMs`.
 */
export async function discoverConsoles(
  extraAddresses: string[] = [],
  durationMs = 1800,
): Promise<PlayStationConsole[]> {
  const targets = ["255.255.255.255", ...extraAddresses.filter((a) => ADDRESS_RE.test(a)).slice(0, 16)];
  const found = new Map<string, Omit<PlayStationConsole, "registered">>();
  const socket = await bindDiscoverySocket();
  socket.on("message", (msg, rinfo) => {
    const parsed = parseDiscoveryReply(msg.toString("utf8"), rinfo.address);
    if (parsed) found.set(parsed.hostId, parsed);
  });
  const send = () => {
    for (const { port, version } of PORTS) {
      const packet = Buffer.from(`SRCH * HTTP/1.1\ndevice-discovery-protocol-version:${version}\n`, "utf8");
      for (const target of targets) socket.send(packet, port, target, () => {});
    }
  };
  send();
  const resend = setTimeout(send, durationMs / 2); // UDP is lossy; ask twice
  await new Promise((r) => setTimeout(r, durationMs));
  clearTimeout(resend);
  socket.close();

  const registered = new Set((await registeredNicknames()).map((n) => n.toLowerCase()));
  return [...found.values()]
    .map((c) => ({ ...c, registered: registered.has(c.name.toLowerCase()) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ------------------------------------------------------------------ launching

export async function launchStream(input: {
  nickname: string;
  address: string;
  fullscreen?: boolean;
}): Promise<{ ok: true }> {
  const exe = requireChiaki();
  if (!ADDRESS_RE.test(input.address)) throw httpError(400, "Endereço inválido");
  const registered = await registeredNicknames();
  const nickname = registered.find((n) => n.toLowerCase() === input.nickname.toLowerCase());
  if (!nickname) {
    throw httpError(409, "Console não registrado no chiaki-ng. Registre-o uma vez no chiaki-ng (PIN do console).");
  }
  // Options must come before the command for chiaki-ng's parser.
  const args = [...(input.fullscreen ? ["--fullscreen"] : []), "--exit-app-on-stream-exit", "stream", nickname, input.address];
  spawn(exe, args, { detached: true, stdio: "ignore" }).unref();
  return { ok: true };
}

/** Opens chiaki-ng's own window (used once to register a console with its PIN). */
export function openClient(): { ok: true } {
  spawn(requireChiaki(), [], { detached: true, stdio: "ignore" }).unref();
  return { ok: true };
}
