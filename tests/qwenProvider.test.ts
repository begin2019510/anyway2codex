import { describe, expect, it } from "vitest";
import { qwen, normalizeQwenBody } from "../src/providers/builtin/qwen.js";
import { findQwenModel, qwenModelsForAccess } from "../src/providers/builtin/qwenModels.js";
import { byClientModel } from "../src/providers/registry.js";
import { MIXED_MODE_REASONING_PLACEHOLDER } from "../src/translate/reqToChat.js";
import type { ChatRequest } from "../src/translate/types.js";

function body(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: "qwen3.8-max",
    messages: [{ role: "user", content: "hi" }],
    ...overrides,
  };
}

function normalized(modelId: string, overrides: Partial<ChatRequest> = {}): ChatRequest {
  const chat = body({ model: modelId, ...overrides });
  normalizeQwenBody(chat, findQwenModel(modelId));
  return chat;
}

describe("Qwen catalog", () => {
  it("resolves canonical ids and qwen/ namespaced aliases to the upstream id", () => {
    expect(findQwenModel("glm-5.3")?.id).toBe("glm-5.3");
    expect(findQwenModel("qwen/glm-5.3")?.id).toBe("glm-5.3");
    expect(findQwenModel("qwen/deepseek-v4.1-flash")?.id).toBe("deepseek-v4.1-flash");
    expect(findQwenModel("nope-9")).toBeNull();
  });

  it("keeps a hosted model owned by its native provider during name routing", () => {
    expect(byClientModel("glm-5.3")?.id).toBe("zhipu");
    expect(byClientModel("deepseek-v4-pro")?.id).toBe("deepseek");
    expect(byClientModel("kimi-k3")?.id).toBe("kimi");
    // The namespaced alias is the only way to force the Qwen copy.
    expect(qwen.resolveModel("qwen/glm-5.3")?.id).toBe("glm-5.3");
  });

  it("separates Token Plan and pay-as-you-go availability", () => {
    const plan = qwenModelsForAccess("token_plan").map((m) => m.id);
    const payg = qwenModelsForAccess("payg").map((m) => m.id);
    expect(plan).toContain("deepseek-v4-pro");
    expect(plan).toContain("glm-5.3");
    expect(plan).toContain("auto");
    expect(plan).not.toContain("kimi-k3");
    expect(plan).not.toContain("qwen3.7-flash");
    expect(payg).toContain("kimi-k3");
    expect(payg).toContain("MiniMax-M2.5");
    expect(payg).not.toContain("auto");
  });

  it("lists only models usable by the active credential through listModels", () => {
    const plan = qwen.listModels!({ baseUrl: "https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1", apiKey: "sk-sp-x" });
    const payg = qwen.listModels!({ baseUrl: "https://maas.qianwenaiapi.com/compatible-mode/v1", apiKey: "sk-ws-x" });
    expect(qwen.detectAccess!({ baseUrl: "https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1", apiKey: "sk-sp-x" })).toBe("token_plan");
    expect(qwen.detectAccess!({ baseUrl: "https://maas.qianwenaiapi.com/compatible-mode/v1", apiKey: "sk-ws-x" })).toBe("payg");
    expect(plan.map((m) => m.id)).toContain("deepseek-v4.1-flash");
    expect(plan.map((m) => m.id)).not.toContain("kimi-k2.7-code");
    expect(payg.map((m) => m.id)).toContain("MiniMax-M2.5");
    // Hidden router model stays resolvable but out of the picker.
    expect(plan.map((m) => m.id)).not.toContain("auto");
    expect(qwen.resolveModel("auto")).not.toBeNull();
  });

  it("records documented vision support per vendor", () => {
    const vision = qwenModelsForAccess("token_plan").filter((m) => m.supportsImages).map((m) => m.id);
    expect(vision).toContain("deepseek-v4.1-flash");
    expect(vision).toContain("qwen3.8-max");
    expect(vision).not.toContain("qwen3.7-max");
    expect(vision).not.toContain("glm-5.3");
    expect(vision).not.toContain("deepseek-v4-pro");
  });
});

describe("Qwen thinking parameter normalization", () => {
  it("maps Qwen efforts to the documented low/medium/xhigh tiers", () => {
    expect(normalized("qwen3.8-max", { reasoning_effort: "low" }).reasoning_effort).toBe("low");
    expect(normalized("qwen3.8-max", { reasoning_effort: "high" }).reasoning_effort).toBe("high");
    expect(normalized("qwen3.8-max", { reasoning_effort: "max" }).reasoning_effort).toBe("xhigh");
    expect(normalized("qwen3.8-flash", { reasoning_effort: "ultra" }).reasoning_effort).toBe("xhigh");
  });

  it("maps GLM and DeepSeek to the tiers that actually exist upstream", () => {
    expect(normalized("glm-5.2", { reasoning_effort: "xhigh" }).reasoning_effort).toBe("max");
    expect(normalized("glm-5.2", { reasoning_effort: "medium" }).reasoning_effort).toBe("high");
    expect(normalized("glm-5.3", { reasoning_effort: "xhigh" }).reasoning_effort).toBe("max");
    expect(normalized("glm-5.3", { reasoning_effort: "minimal" }).reasoning_effort).toBe("low");
    expect(normalized("deepseek-v4-pro", { reasoning_effort: "low" }).reasoning_effort).toBe("high");
    expect(normalized("deepseek-v4-flash-0731", { reasoning_effort: "xhigh" }).reasoning_effort).toBe("high");
  });

  it("never disables thinking for models that 400 on enable_thinking=false", () => {
    for (const id of ["glm-5.3", "kimi-k2.7-code"]) {
      const chat = normalized(id, { thinking: { type: "disabled" } });
      expect(chat.enable_thinking).toBe(true);
    }
  });

  it("honours enable_thinking toggling for hybrid models", () => {
    expect(normalized("qwen3.8-max", { thinking: { type: "disabled" } }).enable_thinking).toBe(false);
    expect(normalized("qwen3.8-max", { thinking: { type: "disabled" }, reasoning_effort: "high" }).reasoning_effort).toBeUndefined();
    expect(normalized("deepseek-v4-pro").enable_thinking).toBe(true);
  });

  it("sends no thinking switch for models that expose none", () => {
    const chat = normalized("MiniMax-M2.5", { reasoning_effort: "high" });
    expect(chat.enable_thinking).toBeUndefined();
    expect(chat.reasoning_effort).toBeUndefined();
    const auto = normalized("auto", { reasoning_effort: "high" });
    expect(auto.enable_thinking).toBeUndefined();
  });

  it("keeps MiMo-style fields out of Qwen requests", () => {
    const chat = body({ thinking: { type: "disabled" }, thinking_budget: 4096, reasoning_effort: "high" });
    normalizeQwenBody(chat, findQwenModel("qwen3.8-max"));
    expect(chat.thinking).toBeUndefined();
    expect(chat.thinking_budget).toBeUndefined();
  });

  it("drops the MiMo placeholder reasoning instead of feeding fake thinking to Qwen", () => {
    const chat = body({
      messages: [
        { role: "assistant", content: "done", reasoning_content: MIXED_MODE_REASONING_PLACEHOLDER },
        { role: "user", content: "next" },
      ],
    });
    normalizeQwenBody(chat, findQwenModel("qwen3.8-max"));
    expect(chat.messages[0].reasoning_content).toBeUndefined();
  });

  it("keeps real reasoning content and merges duplicate system messages", () => {
    const chat = body({
      messages: [
        { role: "system", content: "a" },
        { role: "system", content: "b" },
        { role: "assistant", content: "x", reasoning_content: "real thinking" },
      ],
    });
    normalizeQwenBody(chat, findQwenModel("glm-5.2"));
    expect(chat.messages.filter((m) => m.role === "system")).toHaveLength(1);
    expect(chat.messages[1].reasoning_content).toBe("real thinking");
  });

  it("clears non-standard tool_choice", () => {
    const chat = body({ tool_choice: "auto" });
    normalizeQwenBody(chat, findQwenModel("qwen3.8-max"));
    expect(chat.tool_choice).toBeUndefined();
  });

  it("omits a forced tool_choice while thinking is enabled", () => {
    const chat = normalized("qwen3.8-max", { tool_choice: "required" });
    expect(chat.enable_thinking).toBe(true);
    expect(chat.tool_choice).toBeUndefined();

    const bound = normalized("glm-5.3", { tool_choice: { type: "function", function: { name: "get_weather" } } });
    expect(bound.tool_choice).toBeUndefined();
  });

  it("keeps a forced tool_choice when thinking is actually disabled", () => {
    const chat = normalized("qwen3.7-plus", { thinking: { type: "disabled" }, tool_choice: "required" });
    expect(chat.enable_thinking).toBe(false);
    expect(chat.tool_choice).toBe("required");
  });

  it("omits a forced tool_choice for models with no thinking switch", () => {
    const chat = normalized("MiniMax-M2.5", { tool_choice: "required" });
    expect(chat.enable_thinking).toBeUndefined();
    expect(chat.tool_choice).toBeUndefined();
  });
});