// Real remote-input injection for the host (Windows).
//
// A long-lived PowerShell process compiles a tiny C# helper (Add-Type) that calls SendInput.
// Commands are sent one per line over stdin. Keys are sent as hardware scancodes so they work in
// games (DirectInput/Raw Input) and follow the host's keyboard layout (e.g. ABNT2).
import { spawn } from "node:child_process";

export const CSHARP = String.raw`
using System;
using System.Runtime.InteropServices;

public static class PulseLinkInput {
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public int mouseData; public uint dwFlags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }

  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);

  static void Send(INPUT input) { SendInput(1, new [] { input }, Marshal.SizeOf(typeof(INPUT))); }

  static void Mouse(int dx, int dy, int data, uint flags) {
    var i = new INPUT { type = 0 };
    i.u.mi = new MOUSEINPUT { dx = dx, dy = dy, mouseData = data, dwFlags = flags };
    Send(i);
  }

  static void MoveTo(double x, double y) {
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
    int ax = (int)Math.Round((x - vx) * 65535.0 / Math.Max(1, vw - 1));
    int ay = (int)Math.Round((y - vy) * 65535.0 / Math.Max(1, vh - 1));
    Mouse(ax, ay, 0, 0x0001 | 0x8000 | 0x4000); // MOVE | ABSOLUTE | VIRTUALDESK
  }

  static double Clamp01(double v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  public static void Run() {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch {} // per-monitor v2: physical pixels
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      try {
        var p = line.Split(' ');
        switch (p[0]) {
          case "A": { // A left top width height nx ny  (physical rect of a monitor)
            double l = double.Parse(p[1]), t = double.Parse(p[2]), w = double.Parse(p[3]), h = double.Parse(p[4]);
            MoveTo(l + Clamp01(double.Parse(p[5], System.Globalization.CultureInfo.InvariantCulture)) * (w - 1),
                   t + Clamp01(double.Parse(p[6], System.Globalization.CultureInfo.InvariantCulture)) * (h - 1));
            break;
          }
          case "W": { // W hwnd nx ny  (captured window)
            RECT r;
            if (!GetWindowRect(new IntPtr(long.Parse(p[1])), out r)) break;
            MoveTo(r.Left + Clamp01(double.Parse(p[2], System.Globalization.CultureInfo.InvariantCulture)) * (r.Right - r.Left - 1),
                   r.Top + Clamp01(double.Parse(p[3], System.Globalization.CultureInfo.InvariantCulture)) * (r.Bottom - r.Top - 1));
            break;
          }
          case "B": { // B button down(1|0)
            int b = int.Parse(p[1]); bool down = p[2] == "1";
            if (b == 0) Mouse(0, 0, 0, down ? 0x0002u : 0x0004u);
            else if (b == 1) Mouse(0, 0, 0, down ? 0x0020u : 0x0040u);
            else if (b == 2) Mouse(0, 0, 0, down ? 0x0008u : 0x0010u);
            else if (b == 3 || b == 4) Mouse(0, 0, b == 3 ? 1 : 2, down ? 0x0080u : 0x0100u);
            break;
          }
          case "S": { // S dx dy  (wheel, in WHEEL_DELTA units)
            int dx = int.Parse(p[1]), dy = int.Parse(p[2]);
            if (dy != 0) Mouse(0, 0, dy, 0x0800);
            if (dx != 0) Mouse(0, 0, dx, 0x1000);
            break;
          }
          case "K": { // K scancode down(1|0) extended(1|0)
            var i = new INPUT { type = 1 };
            uint flags = 0x0008; // SCANCODE
            if (p[3] == "1") flags |= 0x0001; // EXTENDEDKEY
            if (p[2] == "0") flags |= 0x0002; // KEYUP
            i.u.ki = new KEYBDINPUT { wVk = 0, wScan = ushort.Parse(p[1]), dwFlags = flags };
            Send(i);
            break;
          }
        }
      } catch {}
    }
  }
}
`;

// KeyboardEvent.code → [set-1 scancode, extended]
const SCANCODES = (() => {
  const m = {
    Escape: [0x01], Minus: [0x0c], Equal: [0x0d], Backspace: [0x0e], Tab: [0x0f],
    BracketLeft: [0x1a], BracketRight: [0x1b], Enter: [0x1c], ControlLeft: [0x1d],
    Semicolon: [0x27], Quote: [0x28], Backquote: [0x29], ShiftLeft: [0x2a], Backslash: [0x2b],
    Comma: [0x33], Period: [0x34], Slash: [0x35], ShiftRight: [0x36], NumpadMultiply: [0x37],
    AltLeft: [0x38], Space: [0x39], CapsLock: [0x3a], NumLock: [0x45], ScrollLock: [0x46],
    Numpad7: [0x47], Numpad8: [0x48], Numpad9: [0x49], NumpadSubtract: [0x4a], Numpad4: [0x4b],
    Numpad5: [0x4c], Numpad6: [0x4d], NumpadAdd: [0x4e], Numpad1: [0x4f], Numpad2: [0x50],
    Numpad3: [0x51], Numpad0: [0x52], NumpadDecimal: [0x53], IntlBackslash: [0x56], F11: [0x57],
    F12: [0x58], IntlRo: [0x73], NumpadComma: [0x7e],
    NumpadEnter: [0x1c, 1], ControlRight: [0x1d, 1], NumpadDivide: [0x35, 1], PrintScreen: [0x37, 1],
    AltRight: [0x38, 1], Home: [0x47, 1], ArrowUp: [0x48, 1], PageUp: [0x49, 1], ArrowLeft: [0x4b, 1],
    ArrowRight: [0x4d, 1], End: [0x4f, 1], ArrowDown: [0x50, 1], PageDown: [0x51, 1], Insert: [0x52, 1],
    Delete: [0x53, 1], MetaLeft: [0x5b, 1], MetaRight: [0x5c, 1], ContextMenu: [0x5d, 1],
  };
  "1234567890".split("").forEach((d, i) => (m[`Digit${d}`] = [0x02 + i]));
  const rows = [
    ["QWERTYUIOP", 0x10],
    ["ASDFGHJKL", 0x1e],
    ["ZXCVBNM", 0x2c],
  ];
  for (const [letters, start] of rows) letters.split("").forEach((l, i) => (m[`Key${l}`] = [start + i]));
  for (let f = 1; f <= 10; f++) m[`F${f}`] = [0x3a + f];
  return m;
})();

export function createInputInjector() {
  /** @type {import("node:child_process").ChildProcess | null} */
  let proc = null;
  let enabled = false;
  /** @type {{ kind: "screen"; rect: { x: number; y: number; width: number; height: number } } | { kind: "window"; hwnd: string } | null} */
  let target = null;
  const pressedKeys = new Set();
  const pressedButtons = new Set();

  function ensureProcess() {
    if (process.platform !== "win32") return null;
    if (proc && proc.exitCode === null) return proc;
    const script = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n${CSHARP}\n'@; [PulseLinkInput]::Run()`;
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
      windowsHide: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
    proc.on("exit", () => {
      proc = null;
    });
    return proc;
  }

  function write(line) {
    const p = ensureProcess();
    if (p?.stdin?.writable) p.stdin.write(`${line}\n`);
  }

  function releaseAll() {
    for (const code of pressedKeys) {
      const sc = SCANCODES[code];
      if (sc) write(`K ${sc[0]} 0 ${sc[1] ? 1 : 0}`);
    }
    for (const b of pressedButtons) write(`B ${b} 0`);
    pressedKeys.clear();
    pressedButtons.clear();
  }

  function moveTo(x, y) {
    if (!target || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const nx = Math.min(1, Math.max(0, x)).toFixed(5);
    const ny = Math.min(1, Math.max(0, y)).toFixed(5);
    if (target.kind === "screen") {
      const r = target.rect;
      write(`A ${Math.round(r.x)} ${Math.round(r.y)} ${Math.round(r.width)} ${Math.round(r.height)} ${nx} ${ny}`);
    } else {
      write(`W ${target.hwnd} ${nx} ${ny}`);
    }
  }

  return {
    get supported() {
      return process.platform === "win32";
    },
    get enabled() {
      return enabled;
    },
    setEnabled(next) {
      enabled = !!next && process.platform === "win32";
      if (enabled) ensureProcess();
      else releaseAll();
    },
    setTarget(next) {
      releaseAll();
      target = next;
    },
    /** @param {import("@pulselink/protocol").RemoteInputPayload} input */
    inject(input) {
      if (!enabled || !input || typeof input !== "object") return;
      switch (input.kind) {
        case "mousemove":
          moveTo(input.x, input.y);
          break;
        case "mousedown":
        case "mouseup": {
          const button = Number(input.button);
          if (!Number.isInteger(button) || button < 0 || button > 4) return;
          moveTo(input.x, input.y);
          const down = input.kind === "mousedown";
          if (down) pressedButtons.add(button);
          else pressedButtons.delete(button);
          write(`B ${button} ${down ? 1 : 0}`);
          break;
        }
        case "wheel": {
          // DOM deltas are ~100 per notch (pixels); Windows expects 120 per notch, positive = up.
          const dy = Math.round(-Number(input.dy) * 1.2);
          const dx = Math.round(Number(input.dx) * 1.2);
          if (Number.isFinite(dx) && Number.isFinite(dy)) {
            write(`S ${Math.max(-1200, Math.min(1200, dx))} ${Math.max(-1200, Math.min(1200, dy))}`);
          }
          break;
        }
        case "keydown":
        case "keyup": {
          const sc = SCANCODES[input.code];
          if (!sc) return;
          const down = input.kind === "keydown";
          if (down) pressedKeys.add(input.code);
          else pressedKeys.delete(input.code);
          write(`K ${sc[0]} ${down ? 1 : 0} ${sc[1] ? 1 : 0}`);
          break;
        }
        case "releaseAll":
          releaseAll();
          break;
      }
    },
    dispose() {
      releaseAll();
      proc?.stdin?.end();
      proc?.kill();
      proc = null;
    },
  };
}
