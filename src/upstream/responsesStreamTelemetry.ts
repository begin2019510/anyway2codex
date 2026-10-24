import { StringDecoder } from "node:string_decoder";
import { createParser, type EventSourceMessage } from "eventsource-parser";
import { estimateAnyResponse, normalizeUsage, type TokenUsageBreakdown } from "../util/tokenEstimate.js";

export interface ResponsesStreamTelemetryResult {
  usage: TokenUsageBreakdown;
  estimated_completion_tokens: number;
  status?: string;
  error?: {
    code?: string;
    message?: string;
  } | null;
}

export class ResponsesStreamTelemetry {
  private readonly decoder = new StringDecoder("utf8");
  private readonly finalItems = new Map<string, any>();
  private readonly deltaItems = new Map<string, any>();
  private finalResponse: any = null;
  private readonly parser = createParser({
    onEvent: (event) => this.handleEvent(event),
    onError: () => {},
  });

  feed(chunk: Uint8Array | string): void {
    const text = typeof chunk === "string" ? chunk : this.decoder.write(Buffer.from(chunk));
    if (text) this.parser.feed(text);
  }

  private handleEvent(message: EventSourceMessage): void {
    let data: any;
    try { data = JSON.parse(message.data); } catch { return; }
    const type = data?.type || message.event;
    if (
      type === "response.completed"
      || type === "response.incomplete"
      || type === "response.failed"
    ) {
      if (data.response && typeof data.response === "object") this.finalResponse = data.response;
      return;
    }
    if (type === "response.output_item.added" || type === "response.output_item.done") {
      const item = data.item;
      if (item?.id && item.type) this.finalItems.set(item.id, item);
      if (type === "response.output_item.added") this.deltaItems.set(item?.id || data.item_id, structuredClone(item));
      return;
    }
    if (type === "response.output_text.delta") {
      this.appendDelta(data.item_id, "message", data.delta, "text");
    } else if (type === "response.reasoning_summary_text.delta") {
      this.appendDelta(data.item_id, "reasoning", data.delta, "summary");
    } else if (type === "response.function_call_arguments.delta") {
      this.appendDelta(data.item_id, "function_call", data.delta, "arguments");
    }
  }

  private appendDelta(itemId: string, itemType: string, delta: string, field: string): void {
    if (!itemId || typeof delta !== "string") return;
    let item = this.deltaItems.get(itemId);
    if (!item) {
      item = { id: itemId, type: itemType };
      if (itemType === "message") item.content = [{ type: "output_text", text: "" }];
      if (itemType === "reasoning") item.summary = [];
      if (itemType === "function_call") item.arguments = "";
      this.deltaItems.set(itemId, item);
    }
    if (itemType === "message") {
      const part = item.content?.[0] || (item.content = [{ type: "output_text", text: "" }])[0];
      part.text = (part.text || "") + delta;
    } else if (itemType === "reasoning") {
      const part = item.summary?.[0] || (item.summary = [{ type: "summary_text", text: "" }])[0];
      part.text = (part.text || "") + delta;
    } else if (field === "arguments") {
      item.arguments = (item.arguments || "") + delta;
    }
  }

  result(): ResponsesStreamTelemetryResult {
    const output = this.finalResponse?.output;
    let resolvedOutput = Array.isArray(output) && output.length ? output : null;
    if (!resolvedOutput) {
      const items = new Map(this.deltaItems);
      for (const [id, item] of this.finalItems) items.set(id, item);
      resolvedOutput = Array.from(items.values()).filter(Boolean);
    }
    const usage = normalizeUsage(this.finalResponse?.usage);
    return {
      usage,
      estimated_completion_tokens: estimateAnyResponse({ output: resolvedOutput }),
      status: this.finalResponse?.status,
      error: this.finalResponse?.error,
    };
  }
}
