import type { ModelInfo } from "../types.js";

export type QwenAccess = "token_plan" | "payg";

export const QWEN_PAYG_BASE_URL = "https://maas.qianwenaiapi.com/compatible-mode/v1";
export const QWEN_TOKEN_PLAN_BASE_URL = "https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1";

export type QwenThinkingControl = "enable_thinking" | "none";

export interface QwenModelInfo extends ModelInfo {
  /** Vendor family; decides how thinking/reasoning parameters are spelled. */
  family: string;
  /** Whether the gateway honours enable_thinking for this model. */
  thinkingControl: QwenThinkingControl;
  /** Codex-facing effort -> upstream accepted value. Absent = never send it. */
  effortMap?: Record<string, string>;
}

const BOTH: QwenAccess[] = ["token_plan", "payg"];
const PLAN_ONLY: QwenAccess[] = ["token_plan"];
const PAYG_ONLY: QwenAccess[] = ["payg"];

const QWEN_EFFORT: Record<string, string> = {
  minimal: "low", low: "low", medium: "medium", high: "high",
  xhigh: "xhigh", max: "xhigh", ultra: "xhigh",
};
const HIGH_MAX_EFFORT: Record<string, string> = {
  minimal: "high", low: "high", medium: "high", high: "high",
  xhigh: "max", max: "max", ultra: "max",
};
const LOW_HIGH_MAX_EFFORT: Record<string, string> = {
  minimal: "low", low: "low", medium: "high", high: "high",
  xhigh: "max", max: "max", ultra: "max",
};
const DEEPSEEK_SNAPSHOT_EFFORT: Record<string, string> = {
  minimal: "low", low: "low", medium: "high", high: "high",
  xhigh: "high", max: "max", ultra: "max",
};

function model(entry: QwenModelInfo & { namespaced?: boolean }): ModelInfo & QwenModelInfo {
  const namespaced = "qwen/" + entry.id;
  const aliases = [namespaced, ...(entry.aliases ?? [])];
  const hosted = entry.family !== "qwen" && entry.family !== "router";
  return {
    ...entry,
    displayName: entry.displayName ?? entry.id,
    // Third-party ids hosted by the Qwen gateway must never win plain model-name
    // routing, otherwise selecting glm-5.3 would silently leave the Zhipu key.
    claim: hosted ? false : undefined,
    aliases: hosted ? aliases : [namespaced],
    access: entry.access ?? BOTH,
  };
}

export const QWEN_CATALOG: Array<ModelInfo & QwenModelInfo> = [
  model({
    id: "qwen3.8-max", family: "qwen", displayName: "Qwen 3.8 Max",
    thinkingControl: "enable_thinking", effortMap: QWEN_EFFORT,
    supportsImages: true, supportsReasoning: true,
    contextWindow: 1_000_000, maxInputTokens: 991_000, maxOutputTokens: 131_072,
    access: BOTH, note: "视觉理解 + 视频输入，思考模式默认开启",
  }),
  model({
    id: "qwen3.8-flash", family: "qwen", displayName: "Qwen 3.8 Flash",
    thinkingControl: "enable_thinking", effortMap: QWEN_EFFORT,
    supportsImages: true, supportsReasoning: true,
    contextWindow: 1_000_000, maxInputTokens: 991_000, maxOutputTokens: 131_072,
    access: BOTH, note: "思考预算上限 256K",
  }),
  model({
    id: "qwen3.7-max", family: "qwen", displayName: "Qwen 3.7 Max",
    thinkingControl: "enable_thinking", effortMap: QWEN_EFFORT,
    supportsImages: false, supportsReasoning: true,
    contextWindow: 1_000_000, maxInputTokens: 991_000, maxOutputTokens: 131_072,
    access: BOTH, note: "纯文本，不支持图片输入",
  }),
  model({
    id: "qwen3.7-plus", family: "qwen", displayName: "Qwen 3.7 Plus",
    thinkingControl: "enable_thinking", effortMap: QWEN_EFFORT,
    supportsImages: true, supportsReasoning: true,
    contextWindow: 1_000_000, maxInputTokens: 991_000, maxOutputTokens: 131_072,
    access: BOTH,
  }),
  model({
    id: "qwen3.7-flash", family: "qwen", displayName: "Qwen 3.7 Flash",
    thinkingControl: "enable_thinking", effortMap: QWEN_EFFORT,
    supportsImages: true, supportsReasoning: true,
    contextWindow: 1_000_000, maxInputTokens: 991_000, maxOutputTokens: 131_072,
    access: PAYG_ONLY, note: "仅按量付费，不在个人版 Token Plan 清单",
  }),
  model({
    id: "qwen3.6-flash", family: "qwen", displayName: "Qwen 3.6 Flash",
    thinkingControl: "enable_thinking", effortMap: QWEN_EFFORT,
    supportsImages: true, supportsReasoning: true,
    contextWindow: 1_000_000, maxInputTokens: 991_000, maxOutputTokens: 65_536,
    access: BOTH, note: "思考预算上限 128K",
  }),
  model({
    id: "qwen3.8-omni-flash", family: "qwen", displayName: "Qwen 3.8 Omni Flash",
    thinkingControl: "enable_thinking", effortMap: QWEN_EFFORT,
    supportsImages: true, supportsReasoning: true,
    contextWindow: 1_000_000, maxInputTokens: 991_000, maxOutputTokens: 131_072,
    access: PAYG_ONLY, note: "全模态（视觉+音频+视频），按量付费",
  }),
  model({
    id: "glm-5.3", family: "glm", displayName: "GLM-5.3 (via Qwen)",
    thinkingControl: "enable_thinking", effortMap: LOW_HIGH_MAX_EFFORT,
    supportsImages: false, supportsReasoning: true,
    contextWindow: 1_000_000, maxInputTokens: 1_000_000, maxOutputTokens: 131_072,
    access: BOTH, thinkingMode: "always",
    note: "仅思考模型：enable_thinking 传 false 会 400",
  }),
  model({
    id: "glm-5.2", family: "glm", displayName: "GLM-5.2 (via Qwen)",
    thinkingControl: "enable_thinking", effortMap: HIGH_MAX_EFFORT,
    supportsImages: false, supportsReasoning: true,
    contextWindow: 1_000_000, maxInputTokens: 1_000_000, maxOutputTokens: 131_072,
    access: BOTH, thinkingMode: "hybrid",
  }),
  model({
    id: "deepseek-v4-pro", family: "deepseek", displayName: "DeepSeek V4 Pro (via Qwen)",
    thinkingControl: "enable_thinking", effortMap: HIGH_MAX_EFFORT,
    supportsImages: false, supportsReasoning: true,
    contextWindow: 1_000_000, maxInputTokens: 1_000_000, maxOutputTokens: 393_216,
    access: BOTH, thinkingMode: "hybrid",
  }),
  model({
    id: "deepseek-v4-pro-0813", family: "deepseek", displayName: "DeepSeek V4 Pro 0813 (via Qwen)",
    thinkingControl: "enable_thinking", effortMap: DEEPSEEK_SNAPSHOT_EFFORT,
    supportsImages: false, supportsReasoning: true,
    contextWindow: 1_000_000, maxInputTokens: 1_000_000, maxOutputTokens: 393_216,
    access: BOTH, thinkingMode: "hybrid",
    note: "快照版；不出现在 /models 清单但可调用",
  }),
  model({
    id: "deepseek-v4-flash-0731", family: "deepseek", displayName: "DeepSeek V4 Flash 0731 (via Qwen)",
    thinkingControl: "enable_thinking", effortMap: DEEPSEEK_SNAPSHOT_EFFORT,
    supportsImages: false, supportsReasoning: true,
    contextWindow: 1_000_000, maxInputTokens: 1_000_000, maxOutputTokens: 393_216,
    access: BOTH, thinkingMode: "hybrid",
  }),
  model({
    id: "deepseek-v4.1-flash", family: "deepseek", displayName: "DeepSeek V4.1 Flash (via Qwen)",
    thinkingControl: "enable_thinking", effortMap: DEEPSEEK_SNAPSHOT_EFFORT,
    supportsImages: true, supportsReasoning: true,
    contextWindow: 1_000_000, maxInputTokens: 1_000_000, maxOutputTokens: 393_216,
    access: BOTH, thinkingMode: "hybrid",
    note: "原生多模态，支持图片输入",
  }),
  model({
    id: "kimi-k3", family: "kimi", displayName: "Kimi K3 (via Qwen)",
    thinkingControl: "enable_thinking", effortMap: LOW_HIGH_MAX_EFFORT,
    supportsImages: true, supportsReasoning: true,
    contextWindow: 1_000_000, maxInputTokens: 1_000_000, maxOutputTokens: 1_000_000,
    access: PAYG_ONLY, thinkingMode: "hybrid",
    note: "按量付费；不支持 thinking_budget",
  }),
  model({
    id: "kimi-k2.7-code", family: "kimi", displayName: "Kimi K2.7 Code (via Qwen)",
    thinkingControl: "enable_thinking", effortMap: undefined,
    supportsImages: true, supportsReasoning: true,
    contextWindow: 262_144, maxInputTokens: 229_000, maxOutputTokens: 16_384,
    access: PAYG_ONLY, thinkingMode: "always",
    note: "仅思考模型；团队版 Token Plan 也包含",
  }),
  model({
    id: "MiniMax-M2.5", family: "minimax", displayName: "MiniMax M2.5 (via Qwen)",
    thinkingControl: "none", effortMap: undefined,
    supportsImages: false, supportsReasoning: true,
    contextWindow: 204_800, maxInputTokens: 196_000, maxOutputTokens: 32_768,
    access: PAYG_ONLY, thinkingMode: "always",
    note: "纯推理模式，不传 enable_thinking；团队版 Token Plan 也包含",
  }),
  model({
    id: "auto", family: "router", displayName: "Qwen Auto (Token Plan)",
    thinkingControl: "none", effortMap: undefined,
    supportsImages: true, supportsReasoning: true,
    contextWindow: 1_000_000, maxInputTokens: 991_000, maxOutputTokens: 131_072,
    access: PLAN_ONLY, hidden: true,
    note: "平台自动选路，思考参数与结果模型不保证生效，故面板默认不列出",
  }),
];

export function detectQwenAccess(runtime: { baseUrl: string; apiKey: string }): QwenAccess | null {
  const baseUrl = (runtime.baseUrl || "").toLowerCase();
  const apiKey = (runtime.apiKey || "").trim();
  if (baseUrl.includes("token-plan")) return "token_plan";
  if (apiKey.startsWith("sk-sp")) return "token_plan";
  if (baseUrl.includes("maas.qianwenaiapi.com") || baseUrl.includes("dashscope")) return "payg";
  if (apiKey.startsWith("sk-")) return "payg";
  return null;
}

export function qwenModelsForAccess(access: QwenAccess | null): Array<ModelInfo & QwenModelInfo> {
  if (!access) return QWEN_CATALOG;
  return QWEN_CATALOG.filter((m) => (m.access ?? BOTH).includes(access));
}

export function findQwenModel(clientModel: string): (ModelInfo & QwenModelInfo) | null {
  const norm = clientModel.trim();
  const stripped = norm.startsWith("qwen/") ? norm.slice(5) : norm;
  for (const m of QWEN_CATALOG) {
    if (m.id === norm || m.id === stripped) return m;
    if (m.aliases?.includes(norm) || m.aliases?.includes(stripped)) return m;
  }
  return null;
}