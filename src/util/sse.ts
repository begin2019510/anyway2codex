import type { ServerResponse } from "node:http";

export interface Sink {
  write(event: string, data: unknown): void;
  comment(text: string): void;
  end(): void;
  closed(): boolean;
}

export function makeServerResponseSink(res: ServerResponse): Sink {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  let isClosed = false;
  res.on("close", () => { isClosed = true; });

  return {
    write(event: string, data: unknown) {
      if (isClosed) return;
      const payload = typeof data === "string" ? data : JSON.stringify(data);
      try { res.write("event: " + event + "\ndata: " + payload + "\n\n"); } catch {}
    },
    comment(text: string) {
      if (isClosed) return;
      res.write(": " + text + "\n\n");
    },
    end() {
      if (isClosed) return;
      isClosed = true;
      res.end();
    },
    closed() { return isClosed; },
  };
}

export function makeMemorySink(): Sink & { events: { event: string; data: unknown }[] } {
  const events: { event: string; data: unknown }[] = [];
  let isClosed = false;
  return {
    events,
    write(event: string, data: unknown) { if (!isClosed) events.push({ event, data }); },
    comment(_text: string) {},
    end() { isClosed = true; },
    closed() { return isClosed; },
  };
}
