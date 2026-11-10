import type { IncomingMessage, ServerResponse } from "node:http";
import type { Device } from "@pulselink/protocol";

export const MAX_BODY_BYTES = 64 * 1024;

export function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (c: Buffer) => {
      if (tooLarge) return; // keep draining so the 413 response can still be delivered
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        reject(httpError(413, "Payload muito grande"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function readJson<T>(req: IncomingMessage): Promise<T> {
  const raw = await readBody(req);
  try {
    return JSON.parse(raw || "{}") as T;
  } catch {
    throw httpError(400, "JSON inválido");
  }
}

/** Only the desktop app (file:// → "null", or the Vite dev server) may call the API from a browser. */
export function corsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = req.headers.origin;
  const allowed =
    origin === "null" || (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
  if (!allowed || !origin) return {};
  return {
    "access-control-allow-origin": origin,
    vary: "Origin",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  };
}

export function sendJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...corsHeaders(req) });
  res.end(JSON.stringify(body));
}

export type RouteContext = {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  /** Authenticated device (always set unless the route was registered with `public: true`). */
  device: Device;
  body: <T>() => Promise<T>;
};

type Handler = (ctx: RouteContext) => Promise<unknown> | unknown;

type Route = {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
  isPublic: boolean;
  status: number;
};

/**
 * Minimal router: "/v1/hosts/:id/connect" style patterns, JSON responses, auth by default.
 * Handlers return the response body; throw httpError() for error statuses.
 */
export class Router {
  private routes: Route[] = [];

  constructor(private authenticate: (req: IncomingMessage) => Device | null) {}

  add(
    method: string,
    path: string,
    handler: Handler,
    opts: { public?: boolean; status?: number } = {},
  ) {
    const keys: string[] = [];
    const pattern = new RegExp(
      "^" +
        path.replace(/:([a-zA-Z]+)/g, (_m, key: string) => {
          keys.push(key);
          return "([^/]+)";
        }) +
        "$",
    );
    this.routes.push({
      method,
      pattern,
      keys,
      handler,
      isPublic: !!opts.public,
      status: opts.status ?? 200,
    });
  }

  get = (p: string, h: Handler, o?: { public?: boolean; status?: number }) => this.add("GET", p, h, o);
  post = (p: string, h: Handler, o?: { public?: boolean; status?: number }) => this.add("POST", p, h, o);
  put = (p: string, h: Handler, o?: { public?: boolean; status?: number }) => this.add("PUT", p, h, o);
  patch = (p: string, h: Handler, o?: { public?: boolean; status?: number }) => this.add("PATCH", p, h, o);
  delete = (p: string, h: Handler, o?: { public?: boolean; status?: number }) =>
    this.add("DELETE", p, h, o);

  async handle(req: IncomingMessage, res: ServerResponse) {
    const method = req.method ?? "GET";
    if (method === "OPTIONS") {
      res.writeHead(204, corsHeaders(req));
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      for (const route of this.routes) {
        if (route.method !== method) continue;
        const m = route.pattern.exec(url.pathname);
        if (!m) continue;
        const params: Record<string, string> = {};
        route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1] ?? "")));
        const device = this.authenticate(req);
        if (!route.isPublic && !device) throw httpError(401, "Unauthorized");
        const result = await route.handler({
          req,
          res,
          params,
          query: url.searchParams,
          device: device as Device,
          body: <T>() => readJson<T>(req),
        });
        if (!res.headersSent) sendJson(req, res, route.status, result ?? { ok: true });
        return;
      }
      sendJson(req, res, 404, { error: "Not found" });
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      const message = err instanceof Error ? err.message : "Erro interno";
      if (status >= 500) console.error("[signal]", err);
      if (!res.headersSent) sendJson(req, res, status, { error: message });
    }
  }
}
