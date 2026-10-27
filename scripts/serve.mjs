import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "site");
const port = Number(process.env.PORT || 4173);
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/atom+xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json"
};

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    const rawPath = decodeURIComponent(requestUrl.pathname);
    const relative = rawPath === "/" ? "index.html" : rawPath.replace(/^\/+/, "");
    const filePath = path.resolve(ROOT, relative);
    if (!filePath.startsWith(`${ROOT}${path.sep}`) && filePath !== ROOT) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("Not a file");
    const content = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    response.end(content);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`UAV PLS Radar: http://127.0.0.1:${port}`);
});
