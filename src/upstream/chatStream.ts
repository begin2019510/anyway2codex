import { createParser } from "eventsource-parser";
import { log } from "../util/log.js";

export async function* iterChatStreamChunks(response: any, signal?: AbortSignal): AsyncGenerator<any> {
  if (!response.body) {
    throw new Error("upstream returned empty body for streaming response");
  }
  const queue: any[] = [];

  const parser = createParser({
    onEvent(event: any) {
      const data = event.data;
      if (!data || data === "[DONE]") return;
      try {
        queue.push(JSON.parse(data));
      } catch (err: any) {
        log.warn("failed to parse upstream SSE chunk; skipping", {
          error: err.message,
          data: data.slice(0, 200),
        });
      }
    },
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");

  try {
    while (true) {
      while (queue.length > 0) {
        yield queue.shift()!;
      }
      const { value, done } = await reader.read();
      if (done) return;
      parser.feed(decoder.decode(value, { stream: true }));
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}