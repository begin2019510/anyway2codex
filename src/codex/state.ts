import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function codexDir(): string {
  return join(homedir(), ".codex");
}

export function configTomlPath(): string {
  return join(codexDir(), "config.toml");
}

export function authJsonPath(): string {
  return join(codexDir(), "auth.json");
}

export function readConfigTomlIfExists(): string | null {
  const p = configTomlPath();
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf-8");
}

export function readAuthJsonIfExists(): Record<string, string> | null {
  const p = authJsonPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch { return null; }
}

export function writeConfigToml(content: string) {
  const dir = codexDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(configTomlPath(), content, "utf-8");
}

export function writeAuthJson(data: Record<string, string>) {
  const dir = codexDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(authJsonPath(), JSON.stringify(data, null, 2) + "\n", "utf-8");
}

export function detectAuthJsonOwner(): string {
  const auth = readAuthJsonIfExists();
  if (!auth) return "missing";
  if (auth.OPENAI_API_KEY === "anyway2codex-local") return "anyway2codex";
  return "external";
}
