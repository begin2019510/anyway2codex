import { getDb } from "./index.js";
import type { AppConfig } from "../config.js";
import type { Provider } from "../providers/types.js";
import { PROVIDERS } from "../providers/registry.js";
import {
  resolveProviderRuntime,
  type ProviderRuntimeCredentials,
} from "../providerRuntime.js";
import { setSetting } from "./settings.js";
import { decrypt, encrypt } from "../util/crypto.js";

const MASTER_KEY = process.env.ANYWAY2CODEX_MASTER_KEY || "default-dev-key-change-in-production";

export interface ProviderCredentialHistory {
  id: number;
  providerId: string;
  baseUrl: string;
  apiKeyMasked: string;
  hasApiKey: boolean;
  apiKeyLength: number;
  source: string;
  changedAt: number;
  isActive: boolean;
  apiKey?: string;
}

export interface ProviderCredentialCurrent {
  providerId: string;
  baseUrl: string;
  apiKeyMasked: string;
  hasApiKey: boolean;
  apiKeyLength: number;
  baseUrlSource: string;
  apiKeySource: string;
  updatedAt: number;
  historyId: number;
  apiKey?: string;
}

interface CredentialRow {
  id: number;
  provider_id: string;
  base_url: string;
  api_key_encrypted: string | null;
  api_key_hint: string | null;
  source: string;
  changed_at: number;
  is_active: number;
}

function validProviderId(providerId: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}$/.test(providerId);
}

export function maskApiKey(apiKey: string): string {
  if (!apiKey) return "";
  if (apiKey.length <= 8) return "*".repeat(apiKey.length);
  return apiKey.slice(0, 4) + "…" + apiKey.slice(-4);
}

function encryptApiKey(apiKey: string | null): string | null {
  if (!apiKey) return null;
  return JSON.stringify(encrypt(apiKey, MASTER_KEY));
}

function decryptApiKey(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return decrypt(parsed.ciphertext, parsed.iv, parsed.tag, MASTER_KEY);
  } catch {
    return null;
  }
}

function rowToHistory(row: CredentialRow, reveal: boolean): ProviderCredentialHistory {
  const apiKey = row.api_key_encrypted ? decryptApiKey(row.api_key_encrypted) : null;
  const result: ProviderCredentialHistory = {
    id: row.id,
    providerId: row.provider_id,
    baseUrl: row.base_url,
    apiKeyMasked: row.api_key_hint || "",
    hasApiKey: !!apiKey,
    apiKeyLength: apiKey?.length || 0,
    source: row.source,
    changedAt: row.changed_at,
    isActive: row.is_active === 1,
  };
  if (reveal && apiKey) result.apiKey = apiKey;
  return result;
}

function rowToCurrent(
  row: CredentialRow,
  runtime: ProviderRuntimeCredentials,
  reveal: boolean,
): ProviderCredentialCurrent {
  const apiKey = row.api_key_encrypted ? decryptApiKey(row.api_key_encrypted) : null;
  const result: ProviderCredentialCurrent = {
    providerId: row.provider_id,
    baseUrl: runtime.baseUrl,
    apiKeyMasked: apiKey ? maskApiKey(apiKey) : "",
    hasApiKey: !!apiKey,
    apiKeyLength: apiKey?.length || 0,
    baseUrlSource: runtime.baseUrlSource,
    apiKeySource: runtime.apiKeySource,
    updatedAt: row.changed_at,
    historyId: row.id,
  };
  if (reveal && apiKey) result.apiKey = apiKey;
  return result;
}

function writeHistory(
  dataDir: string,
  providerId: string,
  baseUrl: string,
  apiKey: string | null,
  source: string,
  changedAt: number,
): CredentialRow {
  const db = getDb(dataDir);
  const insert = db.prepare(`
    INSERT INTO provider_credentials
      (provider_id, base_url, api_key_encrypted, api_key_hint, source, changed_at, is_active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `);
  const update = db.prepare("UPDATE provider_credentials SET is_active = 0 WHERE provider_id = ?");
  return db.transaction(() => {
    update.run(providerId);
    const info = insert.run(
      providerId,
      baseUrl,
      encryptApiKey(apiKey),
      apiKey ? maskApiKey(apiKey) : null,
      source,
      changedAt,
    );
    return db.prepare("SELECT * FROM provider_credentials WHERE id = ?").get(info.lastInsertRowid) as CredentialRow;
  })();
}

function getActiveRow(dataDir: string, providerId: string): CredentialRow | undefined {
  const db = getDb(dataDir);
  return db.prepare(
    "SELECT * FROM provider_credentials WHERE provider_id = ? AND is_active = 1 ORDER BY changed_at DESC, id DESC LIMIT 1",
  ).get(providerId) as CredentialRow | undefined;
}

function ensureCurrentHistory(
  dataDir: string,
  cfg: AppConfig,
  providerId: string,
  provider: Provider | undefined,
): { row: CredentialRow; runtime: ProviderRuntimeCredentials } {
  const runtime = resolveProviderRuntime(cfg, providerId, provider);
  let row = getActiveRow(dataDir, providerId);
  const activeApiKey = row?.api_key_encrypted ? decryptApiKey(row.api_key_encrypted) : null;
  const matches = !!row &&
    row.base_url === runtime.baseUrl &&
    (activeApiKey || "") === (runtime.apiKey || "");

  if (!matches) {
    const source = row
      ? "external-update:" + runtime.baseUrlSource + "+" + runtime.apiKeySource
      : "initial:" + runtime.baseUrlSource + "+" + runtime.apiKeySource;
    row = writeHistory(
      dataDir,
      providerId,
      runtime.baseUrl,
      runtime.apiKey || null,
      source,
      Date.now(),
    );
  }
  if (!row) throw new Error("Unable to initialize provider credential history");
  return { row, runtime };
}

export function getProviderCredentialCurrent(
  dataDir: string,
  cfg: AppConfig,
  providerId: string,
  reveal = false,
): ProviderCredentialCurrent {
  if (!validProviderId(providerId)) throw new Error("Invalid provider id");
  const provider = PROVIDERS[providerId];
  const { row, runtime } = ensureCurrentHistory(dataDir, cfg, providerId, provider);
  return rowToCurrent(row, runtime, reveal);
}

export function getProviderCredentialHistory(
  dataDir: string,
  cfg: AppConfig,
  providerId: string,
  reveal = false,
): ProviderCredentialHistory[] {
  if (!validProviderId(providerId)) throw new Error("Invalid provider id");
  ensureCurrentHistory(dataDir, cfg, providerId, PROVIDERS[providerId]);
  const db = getDb(dataDir);
  const rows = db.prepare(
    "SELECT * FROM provider_credentials WHERE provider_id = ? ORDER BY changed_at DESC, id DESC",
  ).all(providerId) as CredentialRow[];
  return rows.map((row) => rowToHistory(row, reveal));
}

export function saveProviderCredentials(
  dataDir: string,
  cfg: AppConfig,
  providerId: string,
  body: {
    baseUrl?: string;
    apiKey?: string;
    source?: string;
  },
): ProviderCredentialCurrent {
  if (!validProviderId(providerId)) throw new Error("Invalid provider id");
  const provider = PROVIDERS[providerId];
  const current = ensureCurrentHistory(dataDir, cfg, providerId, provider);
  let baseUrl = current.runtime.baseUrl;
  let apiKey = current.runtime.apiKey || null;
  let changed = false;
  let source = body.source || "panel";

  if (typeof body.baseUrl === "string" && body.baseUrl.trim()) {
    const candidate = body.baseUrl.trim();
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Base URL must use http or https");
    }
    if (candidate !== current.runtime.baseUrl) {
      baseUrl = candidate;
      changed = true;
    }
  }

  if (typeof body.apiKey === "string" && body.apiKey.trim()) {
    const candidate = body.apiKey.trim();
    if (candidate !== (current.runtime.apiKey || "")) {
      apiKey = candidate;
      changed = true;
    }
  }

  if (!changed) {
    return rowToCurrent(current.row, current.runtime, false);
  }

  if (apiKey) {
    const encrypted = encrypt(apiKey, MASTER_KEY);
    setSetting("key_" + providerId, JSON.stringify({ ...encrypted, updatedAt: Date.now() }));
    setSetting("key_length_" + providerId, String(apiKey.length));
  }
  setSetting("provider_base_url_" + providerId, baseUrl);

  const row = writeHistory(dataDir, providerId, baseUrl, apiKey, source, Date.now());
  const runtime = resolveProviderRuntime(cfg, providerId, provider);
  return rowToCurrent(row, runtime, false);
}

/**
 * Point a provider at one of its stored credentials. Panel settings are the
 * source of truth for routing, so both the settings row and the history
 * is_active flag must move together, otherwise the next read would treat the
 * flipped row as drift and append a duplicate history entry.
 */
export function activateProviderCredential(
  dataDir: string,
  cfg: AppConfig,
  providerId: string,
  historyId: number,
): ProviderCredentialCurrent {
  if (!validProviderId(providerId)) throw new Error("Invalid provider id");
  const db = getDb(dataDir);
  const row = db.prepare(
    "SELECT * FROM provider_credentials WHERE id = ? AND provider_id = ?",
  ).get(historyId, providerId) as CredentialRow | undefined;
  if (!row) throw new Error("No such credential history entry: " + historyId);
  const apiKey = row.api_key_encrypted ? decryptApiKey(row.api_key_encrypted) : null;
  if (!apiKey) throw new Error("该历史记录没有可用的 API Key，无法切换");

  const encrypted = encrypt(apiKey, MASTER_KEY);
  setSetting("key_" + providerId, JSON.stringify({ ...encrypted, updatedAt: Date.now() }));
  setSetting("key_length_" + providerId, String(apiKey.length));
  setSetting("provider_base_url_" + providerId, row.base_url);

  db.transaction(() => {
    db.prepare("UPDATE provider_credentials SET is_active = 0 WHERE provider_id = ?").run(providerId);
    db.prepare("UPDATE provider_credentials SET is_active = 1 WHERE id = ?").run(row.id);
  })();

  return getProviderCredentialCurrent(dataDir, cfg, providerId);
}

export function recordLegacyKeySave(dataDir: string, providerId: string, apiKey: string, changedAt = Date.now()): void {
  if (!validProviderId(providerId)) return;
  const db = getDb(dataDir);
  const base = (db.prepare(
    "SELECT value FROM settings WHERE key = ?",
  ).get("provider_base_url_" + providerId) as { value?: string } | undefined)?.value;
  const runtime = resolveProviderRuntime(
    { providers: {}, dataDir: "", host: "", port: 0, verbose: false, defaultProviderId: providerId } as AppConfig,
    providerId,
    PROVIDERS[providerId],
  );
  writeHistory(dataDir, providerId, base || runtime.baseUrl, apiKey, "legacy-key-api", changedAt);
}
