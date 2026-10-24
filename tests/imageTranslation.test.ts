import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { reqToChat } from "../src/translate/reqToChat.js";
import type { ResponsesRequest } from "../src/translate/types.js";

const imageRequest: ResponsesRequest = {
  model: "anyway2codex-auto",
  input: [{
    type: "message",
    role: "user",
    content: [
      { type: "input_text", text: "看这张图" },
      { type: "input_image", image_url: "https://example.com/image.png", detail: "high" },
    ],
  }],
};

describe("Responses image translation", () => {
  it("keeps images when the routed provider metadata enables vision", () => {
    const chat = reqToChat(imageRequest, {
      supportsImages: true,
      upstreamModel: "mimo-v2.6-flash",
    });

    const parts = chat.messages.flatMap((message) =>
      Array.isArray(message.content) ? message.content : [],
    );
    expect(parts.filter((part) => part.type === "image_url")).toEqual([{
      type: "image_url",
      image_url: { url: "https://example.com/image.png", detail: "high" },
    }]);
    expect(chat.model).toBe("mimo-v2.6-flash");
  });

  it("does not inject OCR guidance for a vision-capable routed model", () => {
    const chat = reqToChat(imageRequest, {
      supportsImages: true,
      upstreamModel: "mimo-v2.6-flash",
    });

    expect(JSON.stringify(chat.messages)).not.toContain("OCR");
    expect(JSON.stringify(chat.messages)).not.toContain("image attachment");
  });

  it("still omits images for a non-vision routed model", () => {
    const chat = reqToChat(imageRequest, {
      supportsImages: false,
      upstreamModel: "mimo-v2.6-pro",
    });

    const serialized = JSON.stringify(chat.messages);
    expect(serialized).not.toContain('"type":"image_url"');
    expect(serialized).toContain("image attachment");
  });
});

const builtTranslatorPath = fileURLToPath(
  new URL("../dist/translate/reqToChat.js", import.meta.url),
);
const builtTranslatorIt = existsSync(builtTranslatorPath) ? it : it.skip;

describe("built sidecar image translation", () => {
  builtTranslatorIt("preserves images returned inside tool output", async () => {
    const { reqToChat: builtReqToChat } = await import("../dist/translate/reqToChat.js");
    const request: ResponsesRequest = {
      model: "anyway2codex-auto",
      input: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "正在查看截图" }],
        },
        {
          type: "function_call",
          call_id: "call_image",
          name: "screenshot",
          arguments: "{}",
        } as never,
        {
          type: "function_call_output",
          call_id: "call_image",
          output: [
            { type: "input_text", text: "截图结果" },
            { type: "input_image", image_url: "https://example.com/tool.png", detail: "high" },
          ],
        } as never,
      ],
    };

    const chat = builtReqToChat(request, {
      supportsImages: true,
      upstreamModel: "mimo-v2.6-flash",
    });
    const toolIndex = chat.messages.findIndex((message) => message.role === "tool");
    const imageMessage = chat.messages[toolIndex + 1];

    expect(chat.messages[toolIndex].content).toBe("截图结果");
    expect(imageMessage).toMatchObject({
      role: "user",
      content: expect.arrayContaining([
        { type: "image_url", image_url: { url: "https://example.com/tool.png", detail: "high" } },
      ]),
    });
    expect(JSON.stringify(chat.messages)).not.toContain("image attachment omitted");
    expect(JSON.stringify(chat.messages)).not.toContain("OCR");
  });
});
