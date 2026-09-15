/**
 * Truncation, which like `tool_result` generally WRITES history: an untrimmed
 * blob is not just an expensive turn, it is in the conversation forever and
 * re-sent on every later step.
 */
import { describe, it, expect } from "vitest";
import {
  MockLanguageModelV4,
  convertArrayToReadableStream,
  convertReadableStreamToArray,
} from "ai/test";
import { tool, type UIMessage } from "ai";
import { z } from "zod";
import { runAgentLoop } from "./loop.js";
import { truncateToolOutput, isTruncated } from "./truncate.js";
import { defineExtension, type Extension } from "./extension.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
} as never;

let prompts: unknown[] = [];
const huge = "x".repeat(30_000);
const tools = { dump: tool({ inputSchema: z.object({}), execute: async () => huge }) };

const callsDump = () => {
  let n = 0;
  return new MockLanguageModelV4({
    doStream: async (o) => {
      prompts.push(o.prompt);
      return n++ === 0
        ? {
            stream: convertArrayToReadableStream([
              { type: "stream-start", warnings: [] },
              { type: "response-metadata", id: "0", modelId: "m", timestamp: new Date(0) },
              { type: "tool-call", toolCallId: "c1", toolName: "dump", input: "{}" },
              { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
            ] as never),
          }
        : {
            stream: convertArrayToReadableStream([
              { type: "stream-start", warnings: [] },
              { type: "response-metadata", id: "1", modelId: "m", timestamp: new Date(0) },
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: "ok" },
              { type: "text-end", id: "t" },
              { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
            ] as never),
          };
    },
  });
};

const messages: UIMessage[] = [{ id: "u1", role: "user", parts: [{ type: "text", text: "dump" }] }];
const capture = (fn: (m: UIMessage[]) => void): Extension =>
  defineExtension("cap", (ext) => ext.on("agent_end", ({ messages: m }) => fn(m))) as Extension;

describe("truncation", () => {
  it("cuts a huge result and TELLS the model it was cut", async () => {
    prompts = [];
    let stored: UIMessage[] = [];
    await convertReadableStreamToArray(
      await runAgentLoop({
        model: callsDump(),
        tools,
        messages,
        extensions: [truncateToolOutput({ maxChars: 500 }), capture((m) => (stored = m))],
      }),
    );

    const part = (stored[1]!.parts as Array<{ type: string; output?: unknown }>).find(
      (p) => p.type === "tool-dump",
    )!;
    expect(isTruncated(part.output)).toBe(true);
    // Without the warning the model reports a partial answer as a whole one.
    expect(JSON.stringify(prompts[1])).toContain("NOT the whole result");
    expect(JSON.stringify(part.output)).not.toContain("x".repeat(1000));
  });

  it("leaves a small result alone", async () => {
    const small = { dump: tool({ inputSchema: z.object({}), execute: async () => "tiny" }) };
    let stored: UIMessage[] = [];
    await convertReadableStreamToArray(
      await runAgentLoop({
        model: callsDump(),
        tools: small,
        messages,
        extensions: [truncateToolOutput({ maxChars: 500 }), capture((m) => (stored = m))],
      }),
    );
    const part = (stored[1]!.parts as Array<{ type: string; output?: unknown }>).find(
      (p) => p.type === "tool-dump",
    )!;
    expect(part.output).toBe("tiny");
  });

  it("respects an exemption", async () => {
    let stored: UIMessage[] = [];
    await convertReadableStreamToArray(
      await runAgentLoop({
        model: callsDump(),
        tools,
        messages,
        extensions: [
          truncateToolOutput({ maxChars: 500, exempt: ["dump"] }),
          capture((m) => (stored = m)),
        ],
      }),
    );
    const kept = (stored[1]!.parts as Array<{ type: string; output?: unknown }>).find(
      (p) => p.type === "tool-dump",
    )!;
    expect(String(kept.output).length).toBe(30_000);
  });
});
