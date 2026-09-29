import type { IncomingMessage, ServerResponse } from "node:http";
import { listProviders } from "./providers.js";
import { handleModeSwitch, getModeStatus } from "./mode.js";
import { handleBackupRoutes } from "./backup.js";
import { handleLogRoutes, handleLogDetail, handleConversationList, handleConversationDetail } from "./logs.js";
import { handleKeyRoutes } from "./keys.js";
import { getFallbackSettings, handleFallbackSettings } from "./fallback.js";
import { getRoutingSettings, handleRoutingSettings } from "./routing.js";
import { getVisionFallbackSettings, handleVisionFallbackSettings } from "./visionFallback.js";
import type { AppConfig } from "../../config.js";

function sendJson(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

export function registerAdminRoutes(req: IncomingMessage, res: ServerResponse, dataDir: string, cfg: AppConfig): boolean {
  const rawUrl = req.url || "";
  const url = rawUrl.split("?")[0];
  const qs = rawUrl.includes("?") ? rawUrl.split("?")[1] : "";
  const params = new URLSearchParams(qs);
  const method = req.method || "GET";
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (method === "OPTIONS") { res.writeHead(204); res.end(); return true; }
  if (url === "/admin/api/health") { sendJson(res, 200, { ok: true, version: "0.1.0" }); return true; }
  if (url === "/admin/api/providers" && method === "GET") { sendJson(res, 200, listProviders()); return true; }
  if (url === "/admin/api/mode" && method === "GET") { sendJson(res, 200, getModeStatus(cfg)); return true; }
  if (url === "/admin/api/mode/switch" && method === "POST") {
    readBody(req).then((body) => { sendJson(res, 200, handleModeSwitch(JSON.parse(body), dataDir, cfg)); }); return true;
  }
  if (url.startsWith("/admin/api/backups")) { handleBackupRoutes(req, res, dataDir); return true; }
  if (url === "/admin/api/logs" && method === "GET") { sendJson(res, 200, handleLogRoutes({limit:parseInt(params.get("limit")||"200"),offset:parseInt(params.get("offset")||"0")})); return true; }
  if (url.startsWith("/admin/api/logs/") && method === "GET") { const id = parseInt(url.split("/").pop() || "0"); sendJson(res, 200, handleLogDetail(id)); return true; }
  if (url === "/admin/api/fallback" && method === "GET") { sendJson(res, 200, getFallbackSettings(cfg)); return true; }
  if (url === "/admin/api/fallback" && method === "POST") {
    readBody(req).then((body) => { sendJson(res, 200, handleFallbackSettings(JSON.parse(body), cfg)); }); return true;
  }
  if (url === "/admin/api/routing" && method === "GET") { sendJson(res, 200, getRoutingSettings(cfg)); return true; }
  if (url === "/admin/api/routing" && method === "POST") {
    readBody(req).then((body) => { sendJson(res, 200, handleRoutingSettings(JSON.parse(body), cfg)); }); return true;
  }
  if (url === "/admin/api/vision-fallback" && method === "GET") { sendJson(res, 200, getVisionFallbackSettings(cfg)); return true; }
  if (url === "/admin/api/vision-fallback" && method === "POST") {
    readBody(req).then((body) => { sendJson(res, 200, handleVisionFallbackSettings(JSON.parse(body))); }); return true;
  }
  if (url === "/admin/api/keys" && method === "GET") { sendJson(res, 200, handleKeyRoutes("list", dataDir)); return true; }
  if (url === "/admin/api/keys" && method === "POST") {
    readBody(req).then((body) => { sendJson(res, 200, handleKeyRoutes("save", dataDir, JSON.parse(body))); }); return true;
  }
  if (url === "/admin/api/conversations" && method === "GET") { sendJson(res, 200, handleConversationList({limit:parseInt(params.get("limit")||"50"),offset:parseInt(params.get("offset")||"0")})); return true; }
  if (url.startsWith("/admin/api/conversations/") && method === "GET") { const tid = decodeURIComponent(url.split("/admin/api/conversations/")[1] || ""); sendJson(res, 200, handleConversationDetail(tid)); return true; }
  sendJson(res, 404, { error: "not found" }); return true;
}
