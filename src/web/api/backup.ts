import type { IncomingMessage, ServerResponse } from "node:http";
import { createBackup, listBackups, restoreBackup, deleteBackup } from "../../backup/manager.js";

function sendJson(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export function handleBackupRoutes(req: IncomingMessage, res: ServerResponse, dataDir: string) {
  const url = req.url || "";
  const method = req.method || "GET";
  if (url === "/admin/api/backups" && method === "GET") { sendJson(res, 200, listBackups(dataDir)); return; }
  if (url === "/admin/api/backups" && method === "POST") { sendJson(res, 200, createBackup(dataDir, "manual")); return; }
  const restoreMatch = url.match(/^\/admin\/api\/backups\/(\d+)\/restore$/);
  if (restoreMatch && method === "POST") { sendJson(res, 200, { success: restoreBackup(dataDir, parseInt(restoreMatch[1])) }); return; }
  const deleteMatch = url.match(/^\/admin\/api\/backups\/(\d+)$/);
  if (deleteMatch && method === "DELETE") { sendJson(res, 200, { success: deleteBackup(dataDir, parseInt(deleteMatch[1])) }); return; }
  sendJson(res, 404, { error: "not found" });
}
