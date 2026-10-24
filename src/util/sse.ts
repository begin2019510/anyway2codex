import type { ServerResponse } from "node:http";

export interface Sink {
  write(event: string, data: unknown): void;
  comment(text: string): void;
  heartbeat(): void;
  end(): void;
  closed(): boolean;
}

export function writeSseHeartbeat(res: ServerResponse): void {
  if (res.writableEnded) return;
  try {
    // Codex ignores response.in_progress, but its parser still yields the
    // event and resets the client's SSE idle timer.
    res.write('event: response.in_progress\ndata: {"type":"response.in_progress"}\n\n');
  } catch {}
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
    heartbeat() {
      if (isClosed) return;
      writeSseHeartbeat(res);
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
    heartbeat() {},
    end() { isClosed = true; },
    closed() { return isClosed; },
  };
}
