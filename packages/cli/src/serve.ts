/**
 * Minimal static file server for composition projects. Renders and previews
 * are served over HTTP because ES modules and asset fetches don't work from
 * file:// URLs.
 */
import { createServer, type Server } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".hdr": "application/octet-stream",
  ".exr": "application/octet-stream",
  ".bin": "application/octet-stream",
  ".ktx2": "application/octet-stream",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

export interface ServeHandle {
  server: Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}

export function serveProject(projectDir: string, fixedPort = 0): Promise<ServeHandle> {
  const root = resolve(projectDir);
  const server = createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
    if (urlPath === "/favicon.ico") {
      // Browsers auto-request this; a 404 would pollute console-error checks.
      res.writeHead(204).end();
      return;
    }
    const rel = normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
    let filePath = join(root, rel);
    if (!filePath.startsWith(root)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    if (existsSync(filePath) && statSync(filePath).isDirectory()) {
      filePath = join(filePath, "index.html");
    }
    if (!existsSync(filePath)) {
      res.writeHead(404).end(`not found: ${urlPath}`);
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    createReadStream(filePath).pipe(res);
  });

  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(fixedPort, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : fixedPort;
      resolvePromise({
        server,
        port,
        url: `http://127.0.0.1:${port}/`,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}
