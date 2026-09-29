import { describe, expect, it } from "vitest";
import { selectProviderCandidates } from "../src/router.js";

const runtime = {
  mimo: { baseUrl: "https://mimo.example/v1", apiKey: "tp-test-key" },
  qwen: { baseUrl: "https://qwen.example/v1", apiKey: "sk-test-key" },
};

describe("proxy-controlled routing", () => {
  it("ignores the Codex model alias and uses the configured primary", () => {
    const routes = selectProviderCandidates(
      { model: "anyway2codex-auto", input: [] } as any,
      runtime,
      "mimo",
      "mimo",
      "mimo-v2.6-flash",
      {
        proxyControlsModel: true,
        primaryProviderId: "qwen",
        primaryModel: "qwen3.8-max",
      },
    );
    expect(routes[0]).toMatchObject({
      provider: expect.objectContaining({ id: "qwen" }),
      upstreamModel: "qwen3.8-max",
      fallback: false,
    });
    expect(routes[1]).toMatchObject({
      provider: expect.objectContaining({ id: "mimo" }),
      upstreamModel: "mimo-v2.6-flash",
      fallback: true,
    });
  });

  it("keeps model-based routing when proxy control is disabled", () => {
    const routes = selectProviderCandidates(
      { model: "mimo-v2.6-flash", input: [] } as any,
      runtime,
      "qwen",
      "qwen",
      "qwen3.8-flash",
      {
        proxyControlsModel: false,
        primaryProviderId: "qwen",
        primaryModel: "qwen3.8-max",
      },
    );
    expect(routes[0]).toMatchObject({
      provider: expect.objectContaining({ id: "mimo" }),
      upstreamModel: "mimo-v2.6-flash",
      fallback: false,
    });
    expect(routes[1]).toMatchObject({
      provider: expect.objectContaining({ id: "qwen" }),
      upstreamModel: "qwen3.8-flash",
      fallback: true,
    });
  });
});
