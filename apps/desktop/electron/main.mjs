import { app, BrowserWindow, desktopCapturer, ipcMain, screen, session, shell } from "electron";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInputInjector } from "./input-injector.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");

// Avoid Chromium cache "access denied" (0x5) errors on Windows when restarting quickly
// or running several instances side by side.
// Installed app: data lives in %APPDATA%/PulseLink. Running from the repo: in .data/.
const runtimeCacheDir = path.join(os.tmpdir(), `pulselink-runtime-${process.pid}`);
try {
  mkdirSync(runtimeCacheDir, { recursive: true });
  if (!app.isPackaged) {
    const devUserData = path.join(repoRoot, ".data", "desktop-userdata");
    mkdirSync(devUserData, { recursive: true });
    app.setPath("userData", devUserData);
  }
  app.setPath("sessionData", runtimeCacheDir);
} catch {
  /* keep defaults */
}

// One instance per user, like other desktop streaming apps: a second launch focuses the window.
if (app.isPackaged && !app.requestSingleInstanceLock()) {
  app.quit();
}
app.on("second-instance", () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});
app.commandLine.appendSwitch("disable-http-cache");
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
app.commandLine.appendSwitch("log-level", "3");

let signalProcess = null;
let selectedCaptureSourceId = null;
let guestCounter = 1;
const injector = createInputInjector();

const devUrl = process.env.PULSELINK_DEV_URL || null;

function isTrustedAppUrl(rawUrl) {
  if (!rawUrl) return false;
  try {
    const u = new URL(rawUrl);
    if (u.protocol === "file:") {
      // A bare "file://" security origin carries no path; navigation is locked to dist/,
      // so any file: frame here is our own bundle.
      if (!u.pathname || u.pathname === "/") return rawUrl.startsWith("file://");
      return path
        .resolve(fileURLToPath(u))
        .toLowerCase()
        .startsWith(path.join(desktopRoot, "dist").toLowerCase());
    }
    if (devUrl) return u.origin === new URL(devUrl).origin;
  } catch {
    /* fall through */
  }
  return false;
}

function getLanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "127.0.0.1";
}

// ------------------------------------------------------------------ local signal server

async function isSignalRunning() {
  try {
    return (await fetch("http://127.0.0.1:8787/health")).ok;
  } catch {
    return false;
  }
}

/**
 * Starts the local signal server with Electron's own Node runtime (ELECTRON_RUN_AS_NODE),
 * so the installed app needs no separate Node.js install.
 */
async function ensureSignalServer() {
  if (await isSignalRunning()) return;
  const env = { ...process.env, PORT: "8787", ELECTRON_RUN_AS_NODE: "1", NODE_NO_WARNINGS: "1" };
  let entry;
  let cwd;
  if (app.isPackaged) {
    const bundleDir = path.join(process.resourcesPath, "signal");
    entry = path.join(bundleDir, "signal.mjs");
    cwd = bundleDir;
    const dataDir = path.join(app.getPath("userData"), "data");
    mkdirSync(dataDir, { recursive: true });
    Object.assign(env, {
      PULSELINK_ROOT: bundleDir,
      PULSELINK_DATA_DIR: dataDir,
    });
  } else {
    const built = path.join(repoRoot, "services", "signal", "dist", "index.js");
    entry = existsSync(built) ? built : path.join(desktopRoot, "build", "signal", "signal.mjs");
    cwd = repoRoot;
  }
  signalProcess = spawn(process.execPath, [entry], { cwd, stdio: "ignore", windowsHide: true, env });
  for (let i = 0; i < 30; i++) {
    if (await isSignalRunning()) break;
    await new Promise((r) => setTimeout(r, 150));
  }
}

// ------------------------------------------------------------------ capture + input target

async function pickCaptureSource() {
  const sources = await desktopCapturer.getSources({ types: ["screen", "window"] });
  return (
    (selectedCaptureSourceId && sources.find((s) => s.id === selectedCaptureSourceId)) ||
    sources.find((s) => s.id.startsWith("screen:")) ||
    sources[0] ||
    null
  );
}

/** Maps the captured source to where injected input must land (physical pixels). */
async function refreshInputTarget() {
  const source = await pickCaptureSource().catch(() => null);
  if (!source) {
    injector.setTarget(null);
    return;
  }
  if (source.id.startsWith("window:")) {
    const hwnd = source.id.split(":")[1];
    injector.setTarget(/^\d+$/.test(hwnd ?? "") ? { kind: "window", hwnd } : null);
    return;
  }
  const displays = screen.getAllDisplays();
  const display =
    displays.find((d) => String(d.id) === String(source.display_id)) ?? screen.getPrimaryDisplay();
  const rect =
    process.platform === "win32" ? screen.dipToScreenRect(null, display.bounds) : display.bounds;
  injector.setTarget({ kind: "screen", rect });
}

function setupDisplayCapture(ses) {
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const requester = request.frame?.url ?? request.securityOrigin;
      if (!isTrustedAppUrl(requester)) {
        callback({});
        return;
      }
      const chosen = await pickCaptureSource();
      if (!chosen) {
        callback({});
        return;
      }
      // "loopback" captures the system audio mix on Windows.
      const wantsAudio = request.audioRequested && process.platform === "win32";
      callback(wantsAudio ? { video: chosen, audio: "loopback" } : { video: chosen });
    } catch {
      callback({});
    }
  });
}

// ------------------------------------------------------------------ windows

function createAppWindow({ isGuest = false } = {}) {
  const partition = isGuest ? `persist:pulselink-guest-${guestCounter++}` : "persist:pulselink-main";
  setupDisplayCapture(session.fromPartition(partition));

  const win = new BrowserWindow({
    width: isGuest ? 1180 : 1400,
    height: isGuest ? 760 : 880,
    minWidth: 960,
    minHeight: 640,
    frame: false,
    titleBarStyle: "hidden",
    backgroundColor: "#07090b",
    title: isGuest ? "PulseLink — Convidado" : "PulseLink",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      partition,
    },
  });

  const notifyState = () => {
    if (!win.isDestroyed()) {
      win.webContents.send("window:state", {
        isMaximized: win.isMaximized(),
        isFullScreen: win.isFullScreen(),
      });
    }
  };
  for (const ev of ["maximize", "unmaximize", "enter-full-screen", "leave-full-screen"]) {
    win.on(ev, notifyState);
  }

  const search = isGuest ? `role=guest&guestId=${guestCounter - 1}` : "";
  if (devUrl) void win.loadURL(`${devUrl}${search ? `?${search}` : ""}`);
  else void win.loadFile(path.join(desktopRoot, "dist", "index.html"), { search });

  win.once("ready-to-show", () => {
    if (!win.isDestroyed()) {
      win.show();
      win.focus();
    }
  });
  return win;
}

// ------------------------------------------------------------------ IPC

const fromSender = (e) => BrowserWindow.fromWebContents(e.sender);

ipcMain.handle("window:minimize", (e) => fromSender(e)?.minimize());
ipcMain.handle("window:maximize", (e) => {
  const win = fromSender(e);
  if (!win) return false;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
  return win.isMaximized();
});
ipcMain.handle("window:close", (e) => fromSender(e)?.close());
ipcMain.handle("window:fullscreen", (e) => {
  const win = fromSender(e);
  if (!win) return false;
  win.setFullScreen(!win.isFullScreen());
  return win.isFullScreen();
});
ipcMain.handle("window:is-maximized", (e) => fromSender(e)?.isMaximized() ?? false);
ipcMain.handle("window:open-guest", () => {
  createAppWindow({ isGuest: true });
  return { ok: true };
});

ipcMain.handle("system:info", () => {
  const cpus = os.cpus();
  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()} (${os.arch()})`,
    cpuModel: cpus[0]?.model?.trim() ?? "CPU",
    cpuCores: cpus.length,
    totalMemGb: Math.round(os.totalmem() / 1024 ** 3),
    lanIp: getLanIp(),
    physicalDisplaysCount: screen.getAllDisplays().length,
    inputInjectionSupported: injector.supported,
  };
});

ipcMain.handle("desktop:displays", () =>
  screen.getAllDisplays().map((d, idx) => ({
    id: `screen:${d.id}:0`,
    displayId: String(d.id),
    name: d.label || `Monitor ${idx + 1}`,
    width: Math.round(d.bounds.width * (d.scaleFactor || 1)),
    height: Math.round(d.bounds.height * (d.scaleFactor || 1)),
    refreshRate: d.displayFrequency || 60,
    scaleFactor: d.scaleFactor || 1,
    isPrimary: d.id === screen.getPrimaryDisplay().id,
  })),
);

ipcMain.handle("desktop:sources", async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 320, height: 180 },
    });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.id.startsWith("screen:") ? "screen" : "window",
      thumbnailDataUrl: s.thumbnail.toDataURL(),
    }));
  } catch {
    return [];
  }
});

ipcMain.handle("desktop:select-source", async (_e, sourceId) => {
  selectedCaptureSourceId = typeof sourceId === "string" ? sourceId : null;
  await refreshInputTarget();
  return { ok: true, selectedCaptureSourceId };
});

// Remote control: the host renderer enables injection only while it is hosting an active
// session, and forwards inputs it already checked against the guest's permissions.
ipcMain.handle("input:set-enabled", async (_e, enabled) => {
  if (enabled) await refreshInputTarget();
  injector.setEnabled(!!enabled);
  return { enabled: injector.enabled, supported: injector.supported };
});
ipcMain.on("input:inject", (_e, payload) => injector.inject(payload));

ipcMain.handle("shell:open-external", async (_e, url) => {
  try {
    const u = new URL(String(url));
    if (u.protocol !== "https:") return false;
    await shell.openExternal(u.toString());
    return true;
  } catch {
    return false;
  }
});

// ------------------------------------------------------------------ lifecycle

app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event, url) => {
    if (!isTrustedAppUrl(url)) event.preventDefault();
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
});

app.whenReady().then(async () => {
  await ensureSignalServer();
  setupDisplayCapture(session.defaultSession);
  createAppWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createAppWindow();
  });
});

app.on("window-all-closed", () => {
  injector.dispose();
  try {
    signalProcess?.kill();
  } catch {
    /* ignore */
  }
  if (process.platform !== "darwin") app.quit();
});
