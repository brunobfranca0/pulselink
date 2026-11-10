// Applies supabase/migrations/*.sql to your Supabase project. Developer-only: it needs the
// database URL (root .env DATABASE_URL), which must never ship inside the app.
//
//   npm run cloud:migrate
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function envValue(key) {
  if (process.env[key]) return process.env[key];
  const file = path.join(root, ".env");
  if (!existsSync(file)) return undefined;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && m[1] === key) return m[2].replace(/^["']|["']$/g, "");
  }
  return undefined;
}

const url = envValue("DATABASE_URL");
if (!url) {
  console.error("DATABASE_URL não encontrado (defina no .env da raiz ou no ambiente).");
  process.exit(1);
}

const caPath = envValue("DATABASE_SSL_CA");
const ssl = caPath && existsSync(caPath) ? { ca: readFileSync(caPath, "utf8") } : { rejectUnauthorized: false };

const dir = path.join(root, "supabase", "migrations");
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

const client = new pg.Client({ connectionString: url, ssl });
await client.connect();
try {
  for (const file of files) {
    process.stdout.write(`→ ${file} … `);
    await client.query("begin");
    try {
      await client.query(readFileSync(path.join(dir, file), "utf8"));
      await client.query("commit");
      console.log("ok");
    } catch (err) {
      await client.query("rollback");
      console.log("falhou");
      throw err;
    }
  }
  console.log("Migração concluída.");
} finally {
  await client.end();
}
