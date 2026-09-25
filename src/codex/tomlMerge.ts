// Surgical TOML merge - only touch the keys we manage
const MANAGED_ROOT_KEYS = ["model", "model_provider", "model_context_window", "model_max_output_tokens"];

export interface TomlPatch {
  model: string;
  modelProvider: string;
  modelContextWindow?: number;
  modelMaxOutputTokens?: number;
  providerKey: string;
  providerBlock: string;
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start++;
  while (end > start && lines[end - 1].trim() === "") end--;
  return lines.slice(start, end);
}

function removeProviderTable(lines: string[], providerKey: string): string[] {
  const exact = "[model_providers." + providerKey + "]";
  const subPrefix = "[model_providers." + providerKey + ".";
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const isHeader = /^\s*\[/.test(line);
    if (isHeader) {
      const norm = line.trim().replace(/\s+/g, "");
      skipping = norm === exact || norm.startsWith(subPrefix);
    }
    if (!skipping) out.push(line);
  }
  return out;
}

function managedBlock(patch: TomlPatch): string[] {
  const block = [
    'model = "' + patch.model + '"',
    'model_provider = "' + patch.modelProvider + '"',
  ];
  if (patch.modelContextWindow != null) block.push("model_context_window = " + patch.modelContextWindow);
  if (patch.modelMaxOutputTokens != null) block.push("model_max_output_tokens = " + patch.modelMaxOutputTokens);
  return block;
}

// Merge patch into existing config.toml content
export function mergeCodexProviderToml(existing: string | null, patch: TomlPatch): string {
  const managed = managedBlock(patch);
  if (!existing || existing.trim() === "") {
    return [...managed, "", patch.providerBlock.trimEnd()].join("\n") + "\n";
  }
  const lines = existing.replace(/\r\n/g, "\n").split("\n");
  let firstHeader = lines.findIndex((l) => /^\s*\[/.test(l));
  if (firstHeader === -1) firstHeader = lines.length;
  const rootLines = lines.slice(0, firstHeader);
  const sectionLines = lines.slice(firstHeader);
  const managedRe = new RegExp("^\\s*(" + MANAGED_ROOT_KEYS.join("|") + ")\\s*=");
  const keptRoot = trimBlankEdges(rootLines.filter((l) => !managedRe.test(l)));
  const cleanedSections = trimBlankEdges(removeProviderTable(sectionLines, patch.providerKey));
  const out = [...managed];
  if (keptRoot.length) out.push("", ...keptRoot);
  if (cleanedSections.length) out.push("", ...cleanedSections);
  out.push("", patch.providerBlock.trimEnd());
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
