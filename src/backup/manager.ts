import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { codexDir, configTomlPath, authJsonPath } from "../codex/state.js";
import { log } from "../util/log.js";

const MAX_BACKUPS = 20;

export interface BackupEntry {
  timestamp: number;
  configToml?: string;
  authJson?: string;
  note?: string;
}

function backupsDir(dataDir: string): string {
  const dir = join(dataDir, "backups");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

// Create a backup of current Codex config
export function createBackup(dataDir: string, note?: string): BackupEntry {
  const ts = Date.now();
  const dir = backupsDir(dataDir);
  const entry: BackupEntry = { timestamp: ts, note };

  const tomlPath = configTomlPath();
  const authPath = authJsonPath();

  if (existsSync(tomlPath)) {
    entry.configToml = readFileSync(tomlPath, "utf-8");
  }
  if (existsSync(authPath)) {
    entry.authJson = readFileSync(authPath, "utf-8");
  }

  const backupPath = join(dir, ts + ".json");
  writeFileSync(backupPath, JSON.stringify(entry, null, 2), "utf-8");

  log.info("backup created: " + backupPath);
  pruneOldBackups(dataDir);
  return entry;
}

// Restore a backup
export function restoreBackup(dataDir: string, timestamp: number): boolean {
  const dir = backupsDir(dataDir);
  const backupPath = join(dir, timestamp + ".json");
  if (!existsSync(backupPath)) {
    log.warn("backup not found: " + backupPath);
    return false;
  }

  const entry: BackupEntry = JSON.parse(readFileSync(backupPath, "utf-8"));
  const tomlDir = codexDir();
  if (!existsSync(tomlDir)) mkdirSync(tomlDir, { recursive: true });

  if (entry.configToml !== undefined) {
    writeFileSync(configTomlPath(), entry.configToml, "utf-8");
  }
  if (entry.authJson !== undefined) {
    writeFileSync(authJsonPath(), entry.authJson, "utf-8");
  }

  log.info("backup restored: " + backupPath);
  return true;
}

// List all backups
export function listBackups(dataDir: string): BackupEntry[] {
  const dir = backupsDir(dataDir);
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort((a, b) => b.localeCompare(a));
  return files.map((f) => {
    try {
      return JSON.parse(readFileSync(join(dir, f), "utf-8")) as BackupEntry;
    } catch {
      return null;
    }
  }).filter((e): e is BackupEntry => e !== null).slice(0, MAX_BACKUPS);
}

// Delete a backup
export function deleteBackup(dataDir: string, timestamp: number): boolean {
  const dir = backupsDir(dataDir);
  const backupPath = join(dir, timestamp + ".json");
  if (!existsSync(backupPath)) return false;
  unlinkSync(backupPath);
  log.info("backup deleted: " + backupPath);
  return true;
}

// Prune old backups beyond MAX_BACKUPS
function pruneOldBackups(dataDir: string) {
  const dir = backupsDir(dataDir);
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  while (files.length > MAX_BACKUPS) {
    const oldest = files.shift()!;
    unlinkSync(join(dir, oldest));
  }
}
