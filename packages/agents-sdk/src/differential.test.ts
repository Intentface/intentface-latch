/**
 * The gate. Our loop against `streamText({ stopWhen })` on identical scripted
 * model responses. If the UI chunk streams match, every "same as vanilla"
 * claim holds by construction rather than by reading the SDK's source.
 *
 * The SDK's continuation predicate is private and has already changed shape
 * once inside v7 (7.0.2 computes `(A && B) || C`, 7.0.99 computes
 * `B && (A || C)`), with no type change to catch it. This test is what turns
 * that from a silent behaviour change into a red build.
 *
 * Two runs, not one: an empty extension list proves the loop, and a no-op
 * extension on every moment proves that dispatch itself changes nothing.
 */
import { describe, it, expect } from "vitest";
import {
  MockLanguageModelV4,
  convertArrayToReadableStream,
  convertReadableStreamToArray,
} from "ai/test";
import {
  streamText,
  isStepCount,
  tool,
  toUIMessageStream,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { z } from "zod";
import { runAgentLoop } from "./loop.js";
import { defineExtension, type Extension } from "./extension.js";

const usage = {
  inputTokens: 3,
  outputTokens: 10,
  totalTokens: 13,
  inputTokenDetails: {},
  outputTokenDetails: {},
} as never;

/** Step 0 calls a tool, step 1 answers with text. */
function scriptedModel() {
  let n = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      switch (n++) {
        case 0:
          return {
            stream: convertArrayToReadableStream([
              { type: "stream-start", warnings: [] },
              { type: "response-metadata", id: "id-0", modelId: "mock", timestamp: new Date(0) },
              { type: "reasoning-start", id: "r0" },
              { type: "reasoning-delta", id: "r0", delta: "thinking" },
              { type: "reasoning-end", id: "r0" },
              { type: "tool-call", toolCallId: "call-1", toolName: "weather", input: '{"city":"Turku"}' },
              { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
            ] as never),
          };
        default:
          return {
            stream: convertArrayToReadableStream([
              { type: "stream-start", warnings: [] },
              { type: "response-metadata", id: "id-1", modelId: "mock", timestamp: new Date(0) },
              { type: "text-start", id: "t1" },
              { type: "text-delta", id: "t1", delta: "Sleet, 3°C." },
              { type: "text-end", id: "t1" },
              { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
            ] as never),
          };
      }
    },
  });
}

const tools = {
  weather: tool({
    inputSchema: z.object({ city: z.string() }),
    execute: async ({ city }) => ({ city, tempC: 3 }),
  }),
};

const messages: UIMessage[] = [{ id: "u1", role: "user", parts: [{ type: "text", text: "weather?" }] }];

/** Strip what legitimately differs: generated ids and per-message metadata. */
const normalize = (chunks: UIMessageChunk[]) =>
  chunks.map((c) => {
    const { messageId, messageMetadata, ...rest } = c as Record<string, unknown>;
    return rest;
  });

async function vanillaChunks() {
  const v = streamText({
    model: scriptedModel(),
    messages: [{ role: "user", content: "weather?" }],
    tools,
    stopWhen: isStepCount(5),
  });
  return convertReadableStreamToArray(toUIMessageStream({ stream: v.stream, tools }));
}

async function ourChunks(extensions: Extension[]) {
  return convertReadableStreamToArray(
    await runAgentLoop({ model: scriptedModel(), tools, messages, extensions }),
  );
}

/** Listens to every moment and returns nothing from all of them. */
const noop = defineExtension("noop", (ext) => {
  ext.on("session_start", () => undefined);
  ext.on("before_agent_start", () => undefined);
  ext.on("step_start", () => undefined);
  ext.on("instructions", () => undefined);
  ext.on("context", () => undefined);
  ext.on("data_part", () => undefined);
  ext.on("render", () => undefined);
  ext.on("register_tools", (t) => t);
  ext.on("tool_result", () => undefined);
  ext.on("step_end", () => undefined);
  ext.on("steer", () => undefined);
  ext.on("follow_up", () => undefined);
  ext.on("agent_end", () => undefined);
}) as Extension;

describe("runAgentLoop vs streamText({ stopWhen })", () => {
  it("emits the same UI chunk sequence for a two-step tool run", async () => {
    expect(normalize(await ourChunks([]))).toEqual(normalize(await vanillaChunks()));
  });

  it("stays identical with an extension listening to every moment", async () => {
    expect(normalize(await ourChunks([noop]))).toEqual(normalize(await vanillaChunks()));
  });
});
