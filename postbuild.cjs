const fs = require("fs");
const path = require("path");
const root = __dirname;
const dst = path.join(root, "dist");
const candidates = [
  process.env.MIMO2CODEX_DIST,
  path.join(root, "node_modules", "mimo2codex", "dist"),
  "C:/Program Files/mimo2codex/resources/sidecar/dist",
].filter(Boolean);
const src = candidates.find((dir) => fs.existsSync(path.join(dir, "translate", "streamToSse.js")));
if (!src) {
  console.error("mimo2codex sidecar not found. Run `npm install` (pinned mimo2codex 0.5.29) or set MIMO2CODEX_DIST.");
  process.exit(1);
}
console.log("Using mimo2codex sidecar:", src);
const files = [
  ["translate/streamToSse.js", "translate/streamToSse.js"],
  ["translate/reqToChat.js", "translate/reqToChat.js"],
  ["translate/respToResponses.js", "translate/respToResponses.js"],
  ["translate/minimaxCompat.js", "translate/minimaxCompat.js"],
  ["upstream/chatStream.js", "upstream/chatStream.js"],
  ["translate/autoCompact.js", "translate/autoCompact.js"],
];
for (const [s, d] of files) {
  try { fs.copyFileSync(src + "/" + s, dst + "/" + d); console.log("Copied", s); }
  catch (e) { console.error("Failed:", s, e.message); }
}

// Patch 1: respToResponses.js
let resp = fs.readFileSync(dst + "/translate/respToResponses.js", "utf8");
resp = resp.replace("export function respToResponses(chat, req, opts) {", "export function respToResponses(chat, req, opts = {}) {");
fs.writeFileSync(dst + "/translate/respToResponses.js", resp, "utf8");
console.log("Patched respToResponses.js");

// Patch 2: streamToSse.js
let stream = fs.readFileSync(dst + "/translate/streamToSse.js", "utf8");
stream = stream.replace("constructor(req, opts) {", "constructor(req, opts = {}) {");
// Codex sends a placeholder model name when the proxy controls routing, so the
// sidecar must report the routed upstream model in its SSE snapshots.
stream = stream.replace("this.model = req.model;", "this.model = opts.model || req.model;");
if (!stream.includes("this.model = opts.model || req.model;")) {
  throw new Error("Failed to patch streamToSse.js upstream model reporting");
}
fs.writeFileSync(dst + "/translate/streamToSse.js", stream, "utf8");
console.log("Patched streamToSse.js");

// Patch 3: chatStream.js - abort-aware reader with graceful exit
let chat = fs.readFileSync(dst + "/upstream/chatStream.js", "utf8");
chat = chat.replace(
  'export async function* iterChatStreamChunks(response) {',
  'export async function* iterChatStreamChunks(response, signal) {'
);
// Add body cancel on abort
chat = chat.replace(
  '    const reader = response.body.getReader();',
  '    const reader = response.body.getReader();\n    if (signal) {\n      signal.addEventListener("abort", () => {\n        try { response.body.cancel(); } catch {}\n        try { reader.cancel(); } catch {}\n      }, { once: true });\n    }'
);
// Wrap reader.read() with abort handling and graceful exit
chat = chat.replace(
  '            const { value, done: rDone } = await reader.read();',
  `            let value, rDone;
            try {
              const readPromise = reader.read();
              const abortPromise = signal ? new Promise((_, reject) => {
                signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
              }) : null;
              const result = abortPromise
                ? await Promise.race([readPromise, abortPromise])
                : await readPromise;
              value = result.value;
              rDone = result.done;
            } catch (e) {
              if (e.name === "AbortError") { done = true; return; }
              throw e;
            }`
);
fs.writeFileSync(dst + "/upstream/chatStream.js", chat, "utf8");
console.log("Patched chatStream.js");

// Patch 4: keep the routed upstream model when translating Responses -> Chat.
let reqToChat = fs.readFileSync(dst + "/translate/reqToChat.js", "utf8");
reqToChat = reqToChat.replace("        model: req.model,\n        messages,", "        model: effectiveModel,\n        messages,");

// The sidecar translator predates current multimodal model IDs. Keep its
// robust history/tool handling, but let the provider registry decide whether
// the selected upstream can receive images.
const visionCapabilityPatch =
  "        supportsImages: opts.supportsImages === undefined ? modelSupportsImages(effectiveModel) : opts.supportsImages,";
if (reqToChat.includes("        supportsImages: modelSupportsImages(effectiveModel),")) {
  reqToChat = reqToChat.replace(
    "        supportsImages: modelSupportsImages(effectiveModel),",
    visionCapabilityPatch,
  );
}
if (!reqToChat.includes(visionCapabilityPatch)) {
  throw new Error("Failed to patch sidecar vision capability handling");
}

// Chat Completions tool messages must remain strings, but image-returning
// tools still need vision-capable models to see their output. Preserve image
// parts and emit them as a synthetic multimodal user message after the tool
// result group instead of dropping them or asking the agent to OCR them.
reqToChat = reqToChat.replace(
  "function toolOutputToString(output) {",
  "function toolOutputToString(output, preserveImages = false) {",
);
reqToChat = reqToChat.replace(
  "        else if (p.type === \"input_image\") {\n            droppedImages++;\n        }",
  "        else if (p.type === \"input_image\") {\n            if (!preserveImages)\n                droppedImages++;\n        }",
);
const inputItemsMarker = "function inputItemsToMessages(items, ctx) {";
const toolImageHelpers = [
  "function collectToolImages(output, ctx, destination) {",
  "    if (!ctx.supportsImages || !Array.isArray(output))",
  "        return;",
  "    for (const part of output) {",
  "        if (part?.type === \"input_image\" && typeof part.image_url === \"string\") {",
  "            destination.push({",
  "                type: \"image_url\",",
  "                image_url: { url: part.image_url, detail: part.detail },",
  "            });",
  "        }",
  "    }",
  "}",
  inputItemsMarker,
].join("\n");
if (!reqToChat.includes(inputItemsMarker)) {
  throw new Error("Cannot patch tool image preservation: input translator not found");
}
reqToChat = reqToChat.replace(inputItemsMarker, toolImageHelpers);
reqToChat = reqToChat.replace(
  "        pendingAssistantText: null,\n    };",
  "        pendingAssistantText: null,\n        pendingToolImages: [],\n    };",
);
reqToChat = reqToChat.replace(
  "    for (const rawItem of items) {",
  [
    "    const flushPendingToolImages = () => {",
    "        if (state.pendingToolImages.length === 0)",
    "            return;",
    "        out.push({",
    "            role: \"user\",",
    "            content: [",
    "                { type: \"text\", text: \"Image result returned by the preceding tool call:\" },",
    "                ...state.pendingToolImages,",
    "            ],",
    "        });",
    "        state.pendingToolImages = [];",
    "    };",
    "    for (const rawItem of items) {",
  ].join("\n"),
);
reqToChat = reqToChat.replace(
  "        switch (item.type) {",
  "        if (item.type !== \"function_call_output\")\n            flushPendingToolImages();\n        switch (item.type) {",
);
reqToChat = reqToChat.replace(
  "            case \"function_call_output\": {\n                flushAssistant(out, state);\n                out.push({",
  "            case \"function_call_output\": {\n                flushAssistant(out, state);\n                collectToolImages(item.output, ctx, state.pendingToolImages);\n                out.push({",
);
reqToChat = reqToChat.replace(
  "                    content: toolOutputToString(item.output),",
  "                    content: toolOutputToString(item.output, ctx.supportsImages),",
);
reqToChat = reqToChat.replace(
  "    flushAssistant(out, state);\n    removeOrphanToolMessages(out);",
  "    flushPendingToolImages();\n    flushAssistant(out, state);\n    removeOrphanToolMessages(out);",
);
for (const required of [
  "function collectToolImages(",
  "pendingToolImages: [],",
  "flushPendingToolImages();",
  "toolOutputToString(item.output, ctx.supportsImages)",
]) {
  if (!reqToChat.includes(required)) {
    throw new Error("Failed to patch sidecar tool image preservation: " + required);
  }
}
fs.writeFileSync(dst + "/translate/reqToChat.js", reqToChat, "utf8");
console.log("Patched reqToChat.js upstream model");

console.log("Postbuild complete");
// Copy frontend
try { fs.copyFileSync(path.join(root, "src/web/frontend/index.html"), path.join(dst, "web/frontend/index.html")); console.log("Copied frontend"); }
catch (e) { console.error("Failed frontend:", e.message); }
