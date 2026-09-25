// @ts-nocheck
import type { Sink } from "../util/sse.js";
import { newFunctionCallId, newMessageId, newReasoningId, newResponseId } from "../util/ids.js";
import type { ResponsesRequest } from "./types.js";
import { log } from "../util/log.js";

class StreamState {
    responseId = newResponseId();
    createdAt = Math.floor(Date.now() / 1000);
    model;
    outputIndex = 0;
    sequenceNumber = 0;
    activeKind = null;
    activeItemId = null;
    activeBuffer = "";
    activeAnnotations = [];
    toolCalls = new Map();
    finalOutput = [];
    finishReason = null;
    usage = null;
    exposeReasoning;
    req;
    // minimax-compat: 流式 <think>...</think> 切分器。null 时本路径关闭，
    // delta.content 原样进 message 通道（既有行为）。
    thinkSplitter = null;
    namespaceMap;
    constructor(req, opts = {}) {
        this.req = req;
        this.model = req.model;
        this.exposeReasoning = opts.exposeReasoning;
        this.namespaceMap = opts.namespaceMap;
        if (opts.extractInlineThink) {
            this.thinkSplitter = null
        }
    }
    nextSeq() {
        return this.sequenceNumber++;
    }
}
// Each Responses SSE event MUST include `type` in the JSON payload (in addition
// to the SSE `event:` line) — the Codex client parses events from the data field,
// not the SSE event header. Missing `type` leads to "stream disconnected before
// completion" errors because the client never recognizes response.completed.
function emit(sink, state, event, data) {
    sink.write(event, { type: event, ...data, sequence_number: state.nextSeq() });
}
function buildResponseSnapshot(state, status) {
    return {
        id: state.responseId,
        object: "response",
        created_at: state.createdAt,
        status,
        model: state.model,
        output: state.finalOutput,
        usage: state.usage,
        parallel_tool_calls: state.req.parallel_tool_calls ?? true,
        tool_choice: state.req.tool_choice ?? "auto",
        reasoning: {
            effort: state.req.reasoning?.effort ?? null,
            summary: state.req.reasoning?.summary ?? null,
        },
        text: state.req.text?.format
            ? { format: state.req.text.format }
            : { format: { type: "text" } },
        incomplete_details: state.finishReason === "length" ? { reason: "max_output_tokens" } : null,
        error: null,
        metadata: state.req.metadata ?? null,
        previous_response_id: state.req.previous_response_id ?? null,
        instructions: state.req.instructions ?? null,
        temperature: state.req.temperature ?? null,
        top_p: state.req.top_p ?? null,
        max_output_tokens: state.req.max_output_tokens ?? null,
        tools: state.req.tools ?? [],
        truncation: "disabled",
    };
}
function openReasoning(sink, state) {
    finalizeActive(sink, state);
    state.activeKind = "reasoning";
    state.activeItemId = newReasoningId();
    state.activeBuffer = "";
    const idx = state.outputIndex++;
    emit(sink, state, "response.output_item.added", {
        output_index: idx,
        item: {
            id: state.activeItemId,
            type: "reasoning",
            summary: [],
            encrypted_content: null,
            status: "in_progress",
        },
    });
    // Only open the visible summary text slot when reasoning is being
    // streamed to the user. Under --no-reasoning we still create the item
    // (so finalizeActive can pin encrypted_content for round-trip) but skip
    // the summary slot entirely so Codex doesn't render a placeholder.
    if (state.exposeReasoning) {
        emit(sink, state, "response.reasoning_summary_part.added", {
            item_id: state.activeItemId,
            output_index: idx,
            summary_index: 0,
            part: { type: "summary_text", text: "" },
        });
    }
}
function openMessage(sink, state) {
    finalizeActive(sink, state);
    state.activeKind = "message";
    state.activeItemId = newMessageId();
    state.activeBuffer = "";
    state.activeAnnotations = [];
    const idx = state.outputIndex++;
    emit(sink, state, "response.output_item.added", {
        output_index: idx,
        item: {
            id: state.activeItemId,
            type: "message",
            role: "assistant",
            status: "in_progress",
            content: [],
        },
    });
    emit(sink, state, "response.content_part.added", {
        item_id: state.activeItemId,
        output_index: idx,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
    });
}
function translateAnnotation(a) {
    return {
        type: a.type ?? "url_citation",
        url: a.url ?? "",
        title: a.title ?? "",
        ...(a.summary !== undefined ? { snippet: a.summary } : {}),
    };
}
function openToolCall(sink, state, index, id, name) {
    finalizeActive(sink, state);
    const itemId = newFunctionCallId();
    const outputIndex = state.outputIndex++;
    const callId = id ?? `call_${itemId.slice(3)}`;
    const tc = {
        itemId,
        outputIndex,
        callId,
        name: name ?? "",
        argsBuffer: "",
        argsEmitted: false,
    };
    state.toolCalls.set(index, tc);
    const addedItem = {
        id: itemId,
        type: "function_call",
        call_id: callId,
        name: tc.name,
        arguments: "",
        status: "in_progress",
    };
    const ns = tc.name ? state.namespaceMap?.get(tc.name) : undefined;
    if (ns)
        addedItem.namespace = ns;
    emit(sink, state, "response.output_item.added", {
        output_index: outputIndex,
        item: addedItem,
    });
    return tc;
}
function finalizeActive(sink: Sink, state: StreamState) {
    if (state.activeKind === null)
        return;
    const itemId = state.activeItemId;
    const buffer = state.activeBuffer;
    const outputIndex = state.outputIndex - 1;
    if (state.activeKind === "reasoning") {
        // Under --no-reasoning we skipped the summary delta events — also
        // skip the summary .done events here so Codex doesn't suddenly
        // display the whole reasoning trace at stream end. The full text
        // still survives the round-trip via `encrypted_content` below.
        if (state.exposeReasoning) {
            emit(sink, state, "response.reasoning_summary_text.done", {
                item_id: itemId,
                output_index: outputIndex,
                summary_index: 0,
                text: buffer,
            });
            emit(sink, state, "response.reasoning_summary_part.done", {
                item_id: itemId,
                output_index: outputIndex,
                summary_index: 0,
                part: { type: "summary_text", text: buffer },
            });
        }
        const finalItem = {
            id: itemId,
            type: "reasoning",
            summary: state.exposeReasoning ? [{ type: "summary_text", text: buffer }] : [],
            // Always pin full reasoning here — see processChunk comment for why
            // this is required for MiMo multi-turn tool quality.
            encrypted_content: buffer,
            status: "completed",
        };
        state.finalOutput.push(finalItem);
        emit(sink, state, "response.output_item.done", {
            output_index: outputIndex,
            item: finalItem,
        });
    }
    else if (state.activeKind === "message") {
        const annotations = state.activeAnnotations;
        emit(sink, state, "response.output_text.done", {
            item_id: itemId,
            output_index: outputIndex,
            content_index: 0,
            text: buffer,
        });
        emit(sink, state, "response.content_part.done", {
            item_id: itemId,
            output_index: outputIndex,
            content_index: 0,
            part: { type: "output_text", text: buffer, annotations },
        });
        const finalItem = {
            id: itemId,
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: buffer, annotations }],
        };
        state.finalOutput.push(finalItem);
        emit(sink, state, "response.output_item.done", {
            output_index: outputIndex,
            item: finalItem,
        });
    }
    state.activeKind = null;
    state.activeItemId = null;
    state.activeBuffer = "";
    state.activeAnnotations = [];
}
// Validate the accumulated tool-call arguments buffer is parseable JSON
// before we emit it back to Codex. If the upstream truncated mid-stream
// (finish_reason="length", thinking-budget exhaustion, network cancel …)
// the buffer ends in invalid JSON. Persisting a broken `arguments` string
// poisons the Codex session: every subsequent request carries it in
// history and strict upstreams 400 on
//   "unexpected end of data: line 1 column N (char N-1)"
// when they re-parse the field. Salvage to "{}" and emit a clear warning;
// reqToChat's outbound sanitizer is the secondary safety net for sessions
// where this layer was bypassed (older proxy versions, etc.).
function salvageToolCallArguments(raw, ctx) {
    if (raw.length === 0)
        return raw;
    try {
        JSON.parse(raw);
        return raw;
    }
    catch (err) {
        const reason = ctx.finishReason === "length"
            ? "stream truncated by length limit — try raising max_completion_tokens or shrinking the conversation"
            : ctx.finishReason
                ? `stream finished with finish_reason="${ctx.finishReason}" before arguments completed`
                : "stream ended before arguments completed";
        log.warn(`tool_call arguments not valid JSON; salvaged to "{}" — name="${ctx.name}" call_id="${ctx.callId}" ` +
            `len=${raw.length} parse_err="${err.message}" cause: ${reason}. ` +
            `preview=${JSON.stringify(raw.slice(0, 80))}`);
        return "{}";
    }
}
function finalizeToolCalls(sink: Sink, state: StreamState) {
    // Emit done events for tool calls in the order they were opened.
    const ordered = Array.from(state.toolCalls.entries()).sort((a, b) => a[0] - b[0]);
    for (const [, tc] of ordered) {
        const safeArgs = salvageToolCallArguments(tc.argsBuffer, {
            name: tc.name,
            callId: tc.callId,
            finishReason: state.finishReason,
        });
        emit(sink, state, "response.function_call_arguments.done", {
            item_id: tc.itemId,
            output_index: tc.outputIndex,
            arguments: safeArgs,
        });
        const finalItem = {
            id: tc.itemId,
            type: "function_call",
            call_id: tc.callId,
            name: tc.name,
            arguments: safeArgs,
            status: "completed",
        };
        const ns = tc.name ? state.namespaceMap?.get(tc.name) : undefined;
        if (ns)
            finalItem.namespace = ns;
        state.finalOutput.push(finalItem);
        emit(sink, state, "response.output_item.done", {
            output_index: tc.outputIndex,
            item: finalItem,
        });
    }
}
function processChunk(sink: Sink, state: StreamState, chunk: any) {
    if (chunk.usage) {
        state.usage = {
            input_tokens: chunk.usage.prompt_tokens,
            output_tokens: chunk.usage.completion_tokens,
            total_tokens: chunk.usage.total_tokens,
        };
        if (chunk.usage.prompt_tokens_details?.cached_tokens !== undefined) {
            state.usage.input_tokens_details = {
                cached_tokens: chunk.usage.prompt_tokens_details.cached_tokens,
            };
        }
        if (chunk.usage.completion_tokens_details?.reasoning_tokens !== undefined) {
            state.usage.output_tokens_details = {
                reasoning_tokens: chunk.usage.completion_tokens_details.reasoning_tokens,
            };
        }
    }
    const choice = chunk.choices?.[0];
    if (!choice)
        return;
    const delta = choice.delta;
    // minimax-compat: 把 inline <think>...</think> 从 content 切到 reasoning_content。
    // 这里就地构造一个本 chunk 的有效 delta（局部变量，不修改原 delta），让下面的
    // reasoning_content / content 两个分支按平常逻辑跑即可。
    let effContent = delta.content;
    let effReasoningContent = delta.reasoning_content;
    
    if (effReasoningContent) {
        // ALWAYS buffer reasoning_content — finalizeActive pins it into
        // `encrypted_content` so Codex echoes it back on the next turn,
        // which is what MiMo's "passing back reasoning_content" spec requires
        // for stable multi-turn tool calling. The user-visible streaming
        // (summary deltas) is gated by exposeReasoning — --no-reasoning hides
        // it from the terminal but does NOT break the round-trip.
        if (state.activeKind !== "reasoning")
            openReasoning(sink, state);
        state.activeBuffer += effReasoningContent;
        if (state.exposeReasoning) {
            emit(sink, state, "response.reasoning_summary_text.delta", {
                item_id: state.activeItemId,
                output_index: state.outputIndex - 1,
                summary_index: 0,
                delta: effReasoningContent,
            });
        }
    }
    if (effContent) {
        if (state.activeKind !== "message")
            openMessage(sink, state);
        state.activeBuffer += effContent;
        emit(sink, state, "response.output_text.delta", {
            item_id: state.activeItemId,
            output_index: state.outputIndex - 1,
            content_index: 0,
            delta: effContent,
        });
    }
    // MiMo's web_search returns citations in the first streaming chunk's
    // `delta.annotations`. Buffer them and emit per-annotation events so Codex
    // can show inline citations live.
    if (delta.annotations && delta.annotations.length > 0) {
        if (state.activeKind !== "message")
            openMessage(sink, state);
        for (const a of delta.annotations) {
            const translated = translateAnnotation(a);
            const annotationIndex = state.activeAnnotations.length;
            state.activeAnnotations.push(translated);
            emit(sink, state, "response.output_text.annotation.added", {
                item_id: state.activeItemId,
                output_index: state.outputIndex - 1,
                content_index: 0,
                annotation_index: annotationIndex,
                annotation: translated,
            });
        }
    }
    if (delta.tool_calls) {
        for (const tcDelta of delta.tool_calls) {
            let tc = state.toolCalls.get(tcDelta.index);
            if (!tc) {
                tc = openToolCall(sink, state, tcDelta.index, tcDelta.id, tcDelta.function?.name);
            }
            else if (tcDelta.function?.name && !tc.name) {
                tc.name = tcDelta.function.name;
            }
            if (tcDelta.function?.arguments) {
                tc.argsBuffer += tcDelta.function.arguments;
                tc.argsEmitted = true;
                emit(sink, state, "response.function_call_arguments.delta", {
                    item_id: tc.itemId,
                    output_index: tc.outputIndex,
                    delta: tcDelta.function.arguments,
                });
            }
        }
    }
    if (choice.finish_reason) {
        state.finishReason = choice.finish_reason;
    }
}
// minimax-compat: stream 结束时把 splitter 内残留的 carry 文本 flush 出去。
// 半截 `<think>` 或 `</think>` 标签按字面文本处理（carry 不为空时一定是真的
// 残留——见 null
function flushThinkSplitter(sink, state) {
    if (!state.thinkSplitter)
        return;
    const { content, reasoning } = state.thinkSplitter.flush();
    if (reasoning) {
        if (state.activeKind !== "reasoning")
            openReasoning(sink, state);
        state.activeBuffer += reasoning;
        if (state.exposeReasoning) {
            emit(sink, state, "response.reasoning_summary_text.delta", {
                item_id: state.activeItemId,
                output_index: state.outputIndex - 1,
                summary_index: 0,
                delta: reasoning,
            });
        }
    }
    if (content) {
        if (state.activeKind !== "message")
            openMessage(sink, state);
        state.activeBuffer += content;
        emit(sink, state, "response.output_text.delta", {
            item_id: state.activeItemId,
            output_index: state.outputIndex - 1,
            content_index: 0,
            delta: content,
        });
    }
}
export async function pipeChatStreamToResponses(sink, source, req, opts) {
    const state = new StreamState(req, opts);
    emit(sink, state, "response.created", {
        response: buildResponseSnapshot(state, "in_progress"),
    });
    emit(sink, state, "response.in_progress", {
        response: buildResponseSnapshot(state, "in_progress"),
    });
    try {
        for await (const chunk of source.chunks) {
            if (sink.closed()) {
                return {
                    usage: state.usage,
                    response: buildResponseSnapshot(state, "incomplete"),
                    toolCallCount: state.toolCalls.size,
                };
            }
            processChunk(sink, state, chunk);
        }
    }
    catch (err) {
        flushThinkSplitter(sink, state);
        finalizeActive(sink, state);
        finalizeToolCalls(sink, state);
        const message = err instanceof Error ? err.message : String(err);
        const failedSnapshot = buildResponseSnapshot(state, "failed");
        failedSnapshot.error = { type: "upstream_error", message };
        emit(sink, state, "response.failed", { response: failedSnapshot });
        sink.end();
        return {
            usage: state.usage,
            response: failedSnapshot,
            toolCallCount: state.toolCalls.size,
        };
    }
    flushThinkSplitter(sink, state);
    finalizeActive(sink, state);
    finalizeToolCalls(sink, state);
    const completed = buildResponseSnapshot(state, "completed");
    emit(sink, state, "response.completed", { response: completed });
    sink.end();
    return {
        usage: state.usage,
        response: completed,
        toolCallCount: state.toolCalls.size,
    };
}
//# sourceMappingURL=streamToSse.js.map