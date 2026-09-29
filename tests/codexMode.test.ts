import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { switchToDomesticMode, switchToOpenAIMode } from "../src/codex/modeSwitch.js";

const originalCodeXHome = process.env.CODEX_HOME;
let codexHome = "";
let authBefore = "";

describe.sequential("Codex mode switching", () => {
  beforeAll(() => {
    codexHome = mkdtempSync(join(tmpdir(), "anyway2codex-test-"));
    process.env.CODEX_HOME = codexHome;
    authBefore = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        id_token: "id",
        access_token: "access",
        refresh_token: "refresh",
        account_id: "account",
      },
      last_refresh: "2026-09-29T00:00:00.000Z",
    }, null, 2);
    writeFileSync(join(codexHome, "auth.json"), authBefore, "utf8");
    writeFileSync(join(codexHome, "config.toml"), [
      'model = "old-model"',
      'model_provider = "old-provider"',
      'openai_base_url = "https://old.example/v1"',
      "",
      "[model_providers.openai]",
      'base_url = "https://old.example/v1"',
      "",
      "[model_providers.anyway2codex-qwen]",
      'base_url = "http://127.0.0.1:8800/v1"',
    ].join("\n"), "utf8");
  });

  afterAll(() => {
    if (originalCodeXHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodeXHome;
    rmSync(codexHome, { recursive: true, force: true });
  });

  it("switches to official OpenAI without changing auth.json", () => {
    const result = switchToOpenAIMode("gpt-5.6-sol");
    expect(result.success).toBe(true);
    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain('model_provider = "openai"');
    expect(config).toContain('model = "gpt-5.6-sol"');
    expect(config).not.toContain("openai_base_url");
    expect(config).not.toContain("[model_providers.openai]");
    expect(readFileSync(join(codexHome, "auth.json"), "utf8")).toBe(authBefore);
  });

  it("switches back to the stable proxy placeholder without changing auth.json", () => {
    const result = switchToDomesticMode("qwen", "qwen3.8-max", 8800, "Qwen", true);
    expect(result.success).toBe(true);
    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain('model = "anyway2codex-auto"');
    expect(config).toContain('model_provider = "anyway2codex-proxy"');
    expect(config).toContain("[model_providers.anyway2codex-proxy]");
    expect(readFileSync(join(codexHome, "auth.json"), "utf8")).toBe(authBefore);
  });
});
