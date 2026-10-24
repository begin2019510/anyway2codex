import type { ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { writeSseHeartbeat } from "../src/util/sse.js";

describe("SSE heartbeat", () => {
  it("writes an event Codex can parse and ignore", () => {
    const writes: string[] = [];
    const response = {
      writableEnded: false,
      write(chunk: string) {
        writes.push(chunk);
        return true;
      },
    } as unknown as ServerResponse;

    writeSseHeartbeat(response);

    expect(writes).toEqual([
      'event: response.in_progress\ndata: {"type":"response.in_progress"}\n\n',
    ]);
  });

  it("does not write after the response has ended", () => {
    const writes: string[] = [];
    const response = {
      writableEnded: true,
      write(chunk: string) {
        writes.push(chunk);
        return true;
      },
    } as unknown as ServerResponse;

    writeSseHeartbeat(response);

    expect(writes).toEqual([]);
  });
});
