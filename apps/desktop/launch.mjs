import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

// Ensure Electron binary is extracted if npm allowScripts skipped postinstall
const electronInstallScript = path.join(repoRoot, "node_modules", "electron", "install.js");
const electronPathTxt = path.join(repoRoot, "node_modules", "electron", "path.txt");
if (existsSync(electronInstallScript) && !existsSync(electronPathTxt)) {
  console.log("[PulseLink] Inicializando binário do Electron...");
  execFileSync(process.execPath, [electronInstallScript], {
    cwd: path.join(repoRoot, "node_modules", "electron"),
    stdio: "inherit",
  });
}

const electronPath = require("electron");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, [path.join(__dirname, "electron", "main.mjs")], {
  cwd: __dirname,
  env,
  stdio: "inherit",
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
