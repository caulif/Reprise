import { createReadStream } from "node:fs";
import { access, constants, lstat, realpath } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { pathContainedBy, asPosixPath } from "../core/paths.js";

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".xhtml": "application/xhtml+xml",
  ".svg": "image/svg+xml",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
};

const BLOCKED_BASENAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  "auth.json",
  "credentials.json",
  "harness-model.json",
]);

export type BundleStaticServer = {
  origin: string;
  close(): Promise<void>;
};

export type BundlePathResolution =
  | { ok: true; absolute: string }
  | { ok: false; status: 400 | 403 | 404; message: string };

/** Decode, normalize, and contain a request path under bundleRoot (no I/O). */
export function resolveBundleRequestPath(bundleRoot: string, requestPath: string): BundlePathResolution {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return { ok: false, status: 400, message: "invalid path" };
  }
  if (decoded.includes("\0")) return { ok: false, status: 400, message: "invalid path" };
  const relative = asPosixPath(decoded).replace(/^\/+/, "");
  if (!relative || relative.endsWith("/")) {
    return { ok: false, status: 403, message: "directory listing disabled" };
  }
  const segments = relative.split("/");
  if (segments.some((segment) => segment === ".." || segment === ".")) {
    return { ok: false, status: 403, message: "path escape rejected" };
  }
  const normalized = normalize(segments.join(sep));
  if (
    normalized.startsWith("..")
    || normalized === ".."
    || normalized.includes(`${sep}..${sep}`)
    || normalized.includes(`${sep}..`)
  ) {
    return { ok: false, status: 403, message: "path escape rejected" };
  }
  const absolute = join(bundleRoot, normalized);
  if (!pathContainedBy(bundleRoot, absolute)) {
    return { ok: false, status: 403, message: "path escape rejected" };
  }
  const base = asPosixPath(absolute).split("/").pop()?.toLowerCase() ?? "";
  if (BLOCKED_BASENAMES.has(base) || base.startsWith(".env")) {
    return { ok: false, status: 403, message: "blocked file" };
  }
  return { ok: true, absolute };
}

export async function startBundleStaticServer(bundleRoot: string): Promise<BundleStaticServer> {
  const rootReal = await realpath(bundleRoot);
  const server = createServer((req, res) => {
    void handleRequest(rootReal, req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("bundle static server failed to bind 127.0.0.1");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  };
}

async function handleRequest(rootReal: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (req.method !== "GET" && req.method !== "HEAD") {
      send(res, 405, "text/plain; charset=utf-8", "method not allowed");
      return;
    }
    const rawUrl = req.url ?? "/";
    const pathOnly = rawUrl.split("?")[0] ?? "/";
    const resolved = resolveBundleRequestPath(rootReal, pathOnly);
    if (!resolved.ok) {
      send(res, resolved.status, "text/plain; charset=utf-8", resolved.message);
      return;
    }
    let targetReal: string;
    try {
      const linkInfo = await lstat(resolved.absolute);
      if (linkInfo.isSymbolicLink()) {
        send(res, 403, "text/plain; charset=utf-8", "symlink rejected");
        return;
      }
      targetReal = await realpath(resolved.absolute);
    } catch {
      send(res, 404, "text/plain; charset=utf-8", "not found");
      return;
    }
    if (!pathContainedBy(rootReal, targetReal)) {
      send(res, 403, "text/plain; charset=utf-8", "path escape rejected");
      return;
    }
    const info = await lstat(targetReal);
    if (!info.isFile()) {
      send(res, 403, "text/plain; charset=utf-8", "not a file");
      return;
    }
    await access(targetReal, constants.R_OK);
    const mime = MIME_BY_EXT[extname(targetReal).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": mime,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(targetReal).pipe(res);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!res.headersSent) send(res, 500, "text/plain; charset=utf-8", message);
    else res.end();
  }
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
