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

  // Body read timeout: 120s of no data = abort.
  // The 120s fetch timeout only covers headers; this protects body streaming.
  const bodyTimeoutAc = new AbortController();
  const bodyTimeoutId = setTimeout(() => bodyTimeoutAc.abort(), 120_000);
  const allSignals: AbortSignal[] = [bodyTimeoutAc.signal];
  if (signal) allSignals.push(signal);
  const mergedSignal = allSignals.length === 1 ? allSignals[0] : AbortSignal.any(allSignals);

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");

  // On abort: cancel body + reader to release TCP connection back to pool.
  mergedSignal.addEventListener("abort", () => {
    clearTimeout(bodyTimeoutId);
    try { response.body.cancel(); } catch {}
    try { reader.cancel(); } catch {}
  }, { once: true });

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
    clearTimeout(bodyTimeoutId);
    try { reader.cancel(); } catch {}
    try { reader.releaseLock(); } catch {}
  }
}
