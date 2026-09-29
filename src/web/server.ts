import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { registerAdminRoutes } from "./api/index.js";
import type { AppConfig } from "../config.js";

function sendJson(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function serveStatic(res: ServerResponse, filePath: string) {
  if (!existsSync(filePath)) { res.writeHead(404); res.end("Not found"); return; }
  const ext = filePath.split(".").pop() || "";
  const types: Record<string, string> = {
    html: "text/html; charset=utf-8", js: "application/javascript; charset=utf-8",
    css: "text/css; charset=utf-8", json: "application/json",
  };
  res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
  res.end(readFileSync(filePath, "utf-8"));
}

export function handleWebRequest(req: IncomingMessage, res: ServerResponse, dataDir: string, cfg: AppConfig): boolean {
  const url = req.url || "/";
  const path = url.split("?")[0];
  if (path.startsWith("/admin/api/")) return registerAdminRoutes(req, res, dataDir, cfg);
  const frontendDir = join(import.meta.dirname || __dirname, "frontend");
  if (path === "/" || path === "/admin") { serveStatic(res, join(frontendDir, "index.html")); return true; }
  if (path.startsWith("/admin/")) {
    const rel = path.replace("/admin/", "").replace(/\/$/, "");
    if (!rel || rel === "index") { serveStatic(res, join(frontendDir, "index.html")); return true; }
    const staticPath = join(frontendDir, rel);
    if (existsSync(staticPath)) { serveStatic(res, staticPath); return true; }
    serveStatic(res, join(frontendDir, "index.html")); return true;
  }
  return false;
}
