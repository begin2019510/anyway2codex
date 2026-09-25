import { switchToDomesticMode, switchToOpenAIMode, getCurrentMode } from "../../codex/modeSwitch.js";
import { createBackup } from "../../backup/manager.js";
import { PROVIDERS } from "../../providers/registry.js";

export function getModeStatus() { return getCurrentMode(); }

export function handleModeSwitch(body: any, dataDir: string) {
  const { action, providerId, modelId, openaiKey } = body;
  createBackup(dataDir, "before_switch_to_" + action);
  if (action === "domestic") {
    const provider = PROVIDERS[providerId];
    if (!provider) return { success: false, message: "Unknown provider: " + providerId };
    return switchToDomesticMode(providerId, modelId || provider.defaultModel, String(process.env.ANYWAY_PORT || 8800), provider.displayName);
  }
  if (action === "openai") {
    if (!openaiKey) return { success: false, message: "OpenAI API key required" };
    return switchToOpenAIMode(openaiKey, modelId || "gpt-5.6-sol");
  }
  return { success: false, message: "Unknown action: " + action };
}
