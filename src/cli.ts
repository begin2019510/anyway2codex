import { buildConfig } from "./config.js";

// Suppress EPIPE errors on stdout/stderr (async errors bypass try-catch)
process.stderr.on("error", (err: any) => { if (err.code !== "EPIPE") console.error(err); });
process.stdout.on("error", (err: any) => { if (err.code !== "EPIPE") console.error(err); });
import { createServer_ } from "./server.js";
import { log } from "./util/log.js";
import { loadGenericProviders } from "./providers/genericLoader.js";
import { registerProvider } from "./providers/registry.js";
import { mkdirSync } from "node:fs";
import { getDb } from "./db/index.js";

const args = process.argv;

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
anyway2codex - Universal Codex Model Proxy

Usage:
  anyway2codex [options]

Options:
  --port, -p <port>     Port (default: 8788)
  --host <host>         Host (default: 127.0.0.1)
  --data-dir <dir>      Data directory (default: ~/.anyway2codex)
  --provider <id>       Default provider (default: mimo)
  --fallback-provider   Fallback provider (default: qwen)
  --fallback-model      Fallback model (default: qwen3.8-flash)
  --no-fallback         Disable automatic provider fallback
  --vision-fallback     Temporarily route image requests to a vision model
  --no-vision-fallback  Disable image fallback
  --vision-fallback-provider  Vision fallback provider (default: mimo)
  --vision-fallback-model      Vision fallback model (default: mimo-v2.6-flash)
  --proxy-controls-model  Let the proxy choose the primary model
  --no-proxy-controls-model  Route by the model sent by Codex
  --primary-provider    Proxy primary provider
  --primary-model       Proxy primary model
  --verbose, -v         Verbose logging
  --help, -h            Show help
  --version, -V         Show version
  `);
  process.exit(0);
}

if (args.includes("--version") || args.includes("-V")) {
  console.log("anyway2codex v0.1.0");
}

const cfg = buildConfig(args);
process.env.ANYWAY_PORT = String(cfg.port);
mkdirSync(cfg.dataDir, { recursive: true });

// Initialize database
getDb(cfg.dataDir);

// Global crash handlers - write to crash.log for diagnostics
import { appendFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
const crashLogPath = pathJoin(cfg.dataDir, "crash.log");
function writeCrashLog(label: string, err: any) {
  const msg = "[" + new Date().toISOString() + "] " + label + ": " + (err?.stack || err) + "\n";
  try { appendFileSync(crashLogPath, msg); } catch {}
  try { log.error(label + ": " + (err?.stack || err)); } catch {}
}
process.on("uncaughtException", (err) => {
  writeCrashLog("UNCAUGHT EXCEPTION", err);
});
process.on("unhandledRejection", (reason) => {
  writeCrashLog("UNHANDLED REJECTION", reason);
});

// Load generic providers
const genericProviders = loadGenericProviders(cfg.dataDir);
for (const p of genericProviders) {
  try { registerProvider(p); } catch {}
}

import { Agent, setGlobalDispatcher } from 'undici';

// Global undici Agent with 10-minute timeouts (prevents 'stream disconnected before completion')
const agent = new Agent({
  headersTimeout: 600_000,
  bodyTimeout: 600_000,
});
setGlobalDispatcher(agent);
log.info('undici agent configured: headersTimeout=600s bodyTimeout=600s');

const server = createServer_(cfg);

process.on("SIGINT", () => { log.info("shutting down..."); server.close(() => process.exit(0)); });
process.on("SIGTERM", () => { log.info("shutting down..."); server.close(() => process.exit(0)); });
