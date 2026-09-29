import { describe, expect, it } from "vitest";
import { applyVisionFallback, selectProviderCandidates } from "../src/router.js";
import {
  chatRequestContainsImages,
  responsesRequestContainsImages,
} from "../src/translate/imageDetection.js";
import type { ChatRequest, ResponsesRequest } from "../src/translate/types.js";

const runtime = {
  mimo: { baseUrl: "https://mimo.example/v1", apiKey: "tp-test-key" },
  qwen: { baseUrl: "https://qwen.example/v1", apiKey: "sk-test-key" },
  deepseek: { baseUrl: "https://deepseek.example/v1", apiKey: "sk-test-key" },
};

const enabledVision = {
  enabled: true,
  providerId: "mimo",
  model: "mimo-v2.6-flash",
};

function routesFor(model: string) {
  return selectProviderCandidates(
    { model, input: [] } as ResponsesRequest,
    runtime,
    "mimo",
  );
}

describe("image detection", () => {
  it("detects an input image in a Responses message", () => {
    const request: ResponsesRequest = {
      model: "mimo-v2.6-pro",
      input: [{
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "read this" },
          { type: "input_image", image_url: "data:image/png;base64,AAAA" },
        ],
      }],
    };
    expect(responsesRequestContainsImages(request)).toBe(true);
  });

  it("detects an image returned by a Responses tool", () => {
    const request = {
      model: "mimo-v2.6-pro",
      input: [{
        type: "function_call_output",
        call_id: "call_1",
        output: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }],
      }],
    } as unknown as ResponsesRequest;
    expect(responsesRequestContainsImages(request)).toBe(true);
  });

  it("detects an image_url in a Chat request", () => {
    const request: ChatRequest = {
      model: "mimo-v2.6-pro",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "read this" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      }],
    };
    expect(chatRequestContainsImages(request)).toBe(true);
  });

  it("does not trigger on text-only requests", () => {
    expect(responsesRequestContainsImages({
      model: "mimo-v2.6-pro",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
    })).toBe(false);
    expect(chatRequestContainsImages({
      model: "mimo-v2.6-pro",
      messages: [{ role: "user", content: "hello" }],
    })).toBe(false);
  });
});

describe("vision fallback routing", () => {
  it("uses MiMo Flash only for an image request and restores Pro on the next text request", () => {
    const imageRoutes = applyVisionFallback(routesFor("mimo-v2.6-pro"), runtime, enabledVision, true);
    expect(imageRoutes[0]).toMatchObject({
      provider: expect.objectContaining({ id: "mimo" }),
      upstreamModel: "mimo-v2.6-flash",
      visionFallback: true,
    });

    const textRoutes = applyVisionFallback(routesFor("mimo-v2.6-pro"), runtime, enabledVision, false);
    expect(textRoutes[0].upstreamModel).toBe("mimo-v2.6-pro");
    expect(textRoutes[0].visionFallback).toBeUndefined();
  });

  it("can fall back across providers using the vision provider's own credentials", () => {
    const routes = applyVisionFallback(routesFor("deepseek-v4-pro"), runtime, enabledVision, true);
    expect(routes[0]).toMatchObject({
      provider: expect.objectContaining({ id: "mimo" }),
      upstreamModel: "mimo-v2.6-flash",
      apiKey: "tp-test-key",
      baseUrl: "https://mimo.example/v1",
    });
  });

  it("does not rewrite when disabled or when the primary already supports images", () => {
    const disabled = applyVisionFallback(
      routesFor("mimo-v2.6-pro"),
      runtime,
      { ...enabledVision, enabled: false },
      true,
    );
    expect(disabled[0].upstreamModel).toBe("mimo-v2.6-pro");

    const alreadyVision = applyVisionFallback(routesFor("mimo-v2.6-flash"), runtime, enabledVision, true);
    expect(alreadyVision[0].visionFallback).toBeUndefined();
  });

  it("keeps the original route when the configured target is not actually vision-capable", () => {
    const routes = applyVisionFallback(
      routesFor("mimo-v2.6-pro"),
      runtime,
      { ...enabledVision, model: "mimo-v2.6-pro" },
      true,
    );
    expect(routes[0].upstreamModel).toBe("mimo-v2.6-pro");
    expect(routes[0].visionFallback).toBeUndefined();
  });
});
