const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;
let currentLevel: Level = (process.env.ANYWAY2CODEX_LOG_LEVEL as Level) || "info";
function ts(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}
function emit(level: Level, msg: string, meta?: Record<string, unknown>) {
  if (LEVELS[level] < LEVELS[currentLevel]) return;
  const prefix = "[" + ts() + "] [" + level.toUpperCase() + "]";
  const metaStr = meta ? " " + JSON.stringify(meta) : "";
  const line = prefix + " " + msg + metaStr + "\n";
  try {
    if (level === "error") process.stderr.write(line);
    else process.stdout.write(line);
  } catch {}
}
export const log = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit("debug", msg, meta),
  info:  (msg: string, meta?: Record<string, unknown>) => emit("info", msg, meta),
  warn:  (msg: string, meta?: Record<string, unknown>) => emit("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit("error", msg, meta),
  setLevel: (l: Level) => { currentLevel = l; },
};
