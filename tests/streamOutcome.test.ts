import { describe, expect, it } from "vitest";
import { classifyStreamOutcome } from "../src/translate/streamOutcome.js";

describe("stream outcome classification", () => {
  it("keeps a completed response as HTTP 200", () => {
    expect(classifyStreamOutcome({ response: { status: "completed" } })).toEqual({
      statusCode: 200,
    });
  });

  it("records a failed translated stream as an upstream failure", () => {
    expect(classifyStreamOutcome({
      response: {
        status: "failed",
        error: { code: "upstream_error", message: "terminated" },
      },
    })).toEqual({
      statusCode: 502,
      errorCode: "upstream_error",
      errorMessage: "terminated",
    });
  });

  it("distinguishes a client disconnect", () => {
    expect(classifyStreamOutcome({ response: { status: "incomplete" } })).toEqual({
      statusCode: 499,
      errorCode: "client_disconnected",
      errorMessage: "client closed the response stream before completion",
    });
  });

  it("treats a stream without a terminal event as failed", () => {
    expect(classifyStreamOutcome(undefined)).toMatchObject({
      statusCode: 502,
      errorCode: "stream_incomplete",
    });
  });

  it("keeps thrown stream errors distinct", () => {
    expect(classifyStreamOutcome(undefined, new Error("reader failed"))).toEqual({
      statusCode: 500,
      errorCode: "stream_error",
      errorMessage: "reader failed",
    });
  });
});
