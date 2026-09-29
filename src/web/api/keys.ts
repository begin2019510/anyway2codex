import { getSetting, setSetting } from "../../db/settings.js";
import { encrypt, decrypt } from "../../util/crypto.js";

const MASTER_KEY = process.env.ANYWAY2CODEX_MASTER_KEY || "default-dev-key-change-in-production";

interface KeyEntry { providerId: string; hasKey: boolean; keyPrefix: string; updatedAt?: number; }

export function handleKeyRoutes(action: string, _dataDir: string, body?: any): any {
  if (action === "list") {
    return ["openai", "mimo", "deepseek", "qwen", "zhipu", "kimi"].map((id) => {
      const stored = getSetting("key_" + id);
      if (stored) {
        try {
          const p = JSON.parse(stored);
          const dec = decrypt(p.ciphertext, p.iv, p.tag, MASTER_KEY);
          return { providerId: id, hasKey: true, keyPrefix: dec.slice(0, 8) + "...", updatedAt: p.updatedAt };
        } catch { return { providerId: id, hasKey: false, keyPrefix: "" }; }
      }
      return { providerId: id, hasKey: false, keyPrefix: "" };
    });
  }
  if (action === "save" && body) {
    const { providerId, apiKey } = body;
    if (!providerId || !apiKey) return { success: false, message: "providerId and apiKey required" };
    const enc = encrypt(apiKey, MASTER_KEY);
    setSetting("key_" + providerId, JSON.stringify({ ...enc, updatedAt: Date.now() }));
    setSetting("key_length_" + providerId, String(apiKey.length));
    return { success: true, message: "Key saved for " + providerId };
  }
  return { success: false, message: "unknown action" };
}

export function getApiKey(providerId: string): string | null {
  const stored = getSetting("key_" + providerId);
  if (!stored) return null;
  try { const p = JSON.parse(stored); return decrypt(p.ciphertext, p.iv, p.tag, MASTER_KEY); }
  catch { return null; }
}
