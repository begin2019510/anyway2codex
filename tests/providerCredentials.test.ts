import { describe, expect, it } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AppConfig } from "../src/config.js";
import type { Provider } from "../src/providers/types.js";
import {
  resolveProviderRuntimeWith,
} from "../src/providerRuntime.js";
import {
  activateProviderCredential,
  getProviderCredentialCurrent,
  getProviderCredentialHistory,
  maskApiKey,
  saveProviderCredentials,
} from "../src/db/providerCredentials.js";

function config(providers: AppConfig["providers"] = {}): AppConfig {
  return {
    host: "127.0.0.1",
    port: 8800,
    dataDir: "D:/temp",
    verbose: false,
    defaultProviderId: "test",
    providers,
  };
}

const provider = {
  id: "test",
  shortcut: "test",
  displayName: "Test",
  defaultBaseUrl: "https://default.example/v1",
  baseUrlEnv: "TEST_BASE_URL",
  envKeys: ["TEST_API_KEY"],
  defaultModel: "test-model",
  builtinModels: [],
  detectFlags: () => ({}),
  inferBaseUrlFromKey: (key: string) => key.startsWith("tp-") ? "https://inferred.example/v1" : null,
  resolveModel: () => null,
  preprocessResponses: (request) => request as any,
  preprocessChat: (request) => request as any,
  enhanceError: () => null,
} as Provider;

describe("provider runtime credentials", () => {
  it("panel credentials override config and environment values", () => {
    const previousBaseUrl = process.env.TEST_BASE_URL;
    const previousApiKey = process.env.TEST_API_KEY;
    process.env.TEST_BASE_URL = "https://env.example/v1";
    process.env.TEST_API_KEY = "env-key";
    try {
      const result = resolveProviderRuntimeWith(
        config({ test: { baseUrl: "https://config.example/v1", apiKey: "config-key" } }),
        "test",
        provider,
        { baseUrl: "https://panel.example/v1", apiKey: "panel-key" },
      );
      expect(result.baseUrl).toBe("https://panel.example/v1");
      expect(result.apiKey).toBe("panel-key");
      expect(result.baseUrlSource).toBe("panel");
      expect(result.apiKeySource).toBe("panel");
    } finally {
      restoreEnv("TEST_BASE_URL", previousBaseUrl);
      restoreEnv("TEST_API_KEY", previousApiKey);
    }
  });

  it("falls back to config, environment, inferred URL, and provider default", () => {
    const previousBaseUrl = process.env.TEST_BASE_URL;
    const previousApiKey = process.env.TEST_API_KEY;
    delete process.env.TEST_BASE_URL;
    delete process.env.TEST_API_KEY;
    try {
      const configured = resolveProviderRuntimeWith(
        config({ test: { baseUrl: "https://config.example/v1", apiKey: "config-key" } }),
        "test",
        provider,
        { baseUrl: "", apiKey: "" },
      );
      expect(configured.baseUrl).toBe("https://config.example/v1");
      expect(configured.apiKey).toBe("config-key");

      const inferred = resolveProviderRuntimeWith(
        config(),
        "test",
        provider,
        { baseUrl: "", apiKey: "tp-inferred" },
      );
      expect(inferred.baseUrl).toBe("https://inferred.example/v1");

      const defaults = resolveProviderRuntimeWith(
        config(),
        "test",
        provider,
        { baseUrl: "", apiKey: "" },
      );
      expect(defaults.baseUrl).toBe("https://default.example/v1");
    } finally {
      restoreEnv("TEST_BASE_URL", previousBaseUrl);
      restoreEnv("TEST_API_KEY", previousApiKey);
    }
  });

  it("masks API keys without returning them in normal responses", () => {
    expect(maskApiKey("")).toBe("");
    expect(maskApiKey("short")).toBe("*****");
    expect(maskApiKey("sk-abcdefghijklmnop")).toBe("sk-a…mnop");
  });
});


describe("Qwen-style credential switching from the panel", () => {
  const dir = join(tmpdir(), "anyway2codex-credentials-test");
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  mkdirSync(dir, { recursive: true });
  const appConfig = config();

  const keyedRows = () => getProviderCredentialHistory(dir, appConfig, "test").filter((row) => row.hasApiKey);

  it("stores every credential the panel saves as a selectable history entry", () => {
    saveProviderCredentials(dir, appConfig, "test", { baseUrl: "https://token-plan.example/v1", apiKey: "sk-sp-plan-plan-plan" });
    expect(getProviderCredentialCurrent(dir, appConfig, "test").baseUrl).toBe("https://token-plan.example/v1");

    saveProviderCredentials(dir, appConfig, "test", { baseUrl: "https://payg.example/v1", apiKey: "sk-ws-pay-pay-pay" });
    const rows = keyedRows();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.isActive)?.baseUrl).toBe("https://payg.example/v1");
  });

  it("re-activates the Token Plan entry and keeps routing on it", () => {
    const planRow = keyedRows().find((row) => row.baseUrl === "https://token-plan.example/v1");
    expect(planRow).toBeTruthy();

    const activated = activateProviderCredential(dir, appConfig, "test", planRow!.id);
    expect(activated.baseUrl).toBe("https://token-plan.example/v1");
    expect(activated.apiKeyMasked).toBe(maskApiKey("sk-sp-plan-plan-plan"));
    expect(activated.apiKeySource).toBe("panel");

    // An activation must not look like user drift on the next read.
    expect(keyedRows()).toHaveLength(2);
    expect(keyedRows().find((row) => row.isActive)?.baseUrl).toBe("https://token-plan.example/v1");
  });

  it("rejects unknown history ids", () => {
    expect(() => activateProviderCredential(dir, appConfig, "test", 424242)).toThrow(/No such credential/);
  });
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
