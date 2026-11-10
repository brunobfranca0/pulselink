// Bundles the signal server (and all its dependencies) into a single ESM file that the
// installed app runs with Electron's own Node (ELECTRON_RUN_AS_NODE), so end users don't
// need Node.js installed. Output: apps/desktop/build/signal/{signal.mjs, replica/*.sql}
import { build } from "esbuild";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, "..");
const repo = path.resolve(desktop, "..", "..");
const out = path.join(desktop, "build", "signal");

rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, "replica"), { recursive: true });

await build({
  entryPoints: [path.join(repo, "services", "signal", "src", "index.ts")],
  outfile: path.join(out, "signal.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: true,
  legalComments: "none",
  // pg's optional native binding is never used.
  external: ["pg-native"],
  // CommonJS dependencies bundled into ESM still call require() for Node built-ins.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: "warning",
});

for (const file of ["schema.sql"]) {
  copyFileSync(path.join(repo, "replica", file), path.join(out, "replica", file));
}
console.log(`signal bundled → ${path.relative(repo, out)}`);
