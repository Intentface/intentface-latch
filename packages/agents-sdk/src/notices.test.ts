/**
 * Notices: parts an extension appends at `step_end`.
 *
 * They must go BOTH to the live stream and to storage. Storing alone means a
 * per-step notice only shows up after a reload, which defeats the point; and
 * streaming alone means it vanishes on reload. Getting one of the two wrong is
 * hard to notice by hand, so both halves are asserted here, along with the
 * count, because a part that is stored and then re-streamed on the next step
 * would show up twice.
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
import { defineExtension, type Extension } from "./extension.js";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
} as never;

let prompts: unknown[] = [];

/** Step 0 calls a tool, step 1 answers: two steps, so two notices. */
const twoSteps = () => {
  let n = 0;
  return new MockLanguageModelV4({
    doStream: async (o) => {
      prompts.push(o.prompt);
      if (n++ === 0)
        return {
          stream: convertArrayToReadableStream([
            { type: "stream-start", warnings: [] },
            { type: "response-metadata", id: "0", modelId: "m", timestamp: new Date(0) },
            { type: "tool-call", toolCallId: "c1", toolName: "ping", input: "{}" },
            { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
          ] as never),
        };
      return {
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "response-metadata", id: "1", modelId: "m", timestamp: new Date(0) },
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "done" },
          { type: "text-end", id: "t" },
          { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
        ] as never),
      };
    },
  });
};

const tools = { ping: tool({ inputSchema: z.object({}), execute: async () => ({ ok: true }) }) };
const messages: UIMessage[] = [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }];

describe("notices", () => {
  it("reach the live stream as well as storage", async () => {
    prompts = [];
    let stored: UIMessage[] = [];
    const notes = defineExtension("n", (ext) =>
      ext.notify((info) => `step ${info.stepNumber}`),
    ) as Extension;

    const chunks = await convertReadableStreamToArray(
      await runAgentLoop({
        model: twoSteps(),
        tools,
        messages,
        extensions: [
          notes,
          {
            name: "cap",
            commands: [],
            hooks: { agent_end: [({ messages: m }) => void (stored = m)] },
          },
        ],
      }),
    );

    const streamed = chunks.filter((c) => c.type === "data-notice-n");
    const inStorage = (stored.at(-1)!.parts as Array<{ type: string; data?: unknown }>).filter(
      (p) => p.type === "data-notice-n",
    );

    // Two steps, two notices — each exactly once on both sides.
    expect(streamed.map((c) => (c as { data: unknown }).data)).toEqual(["step 0", "step 1"]);
    expect(inStorage.map((p) => p.data)).toEqual(["step 0", "step 1"]);

    // And the model is never told about any of it.
    expect(JSON.stringify(prompts)).not.toContain("step 0");
  });

  it("a notice from the first step is not re-streamed on the second", async () => {
    const notes = defineExtension("once", (ext) =>
      ext.notify((info) => (info.stepNumber === 0 ? "only once" : undefined)),
    ) as Extension;

    const chunks = await convertReadableStreamToArray(
      await runAgentLoop({ model: twoSteps(), tools, messages, extensions: [notes] }),
    );
    expect(chunks.filter((c) => c.type === "data-once")).toHaveLength(0);
    expect(chunks.filter((c) => c.type === "data-notice-once")).toHaveLength(1);
  });

  it("the cost line streams too", async () => {
    const { costTracking } = await import("./cost.js");
    const chunks = await convertReadableStreamToArray(
      await runAgentLoop({
        model: twoSteps(),
        tools,
        messages,
        extensions: [costTracking({ pricing: { m: { input: 3, output: 15 } }, notify: true })],
      }),
    );
    const cost = chunks.filter((c) => c.type === "data-cost");
    expect(cost).toHaveLength(2);
    expect(String((cost[1] as { data: unknown }).data)).toContain("2 steps");
  });
});

describe("view rules apply live, not only on load", () => {
  it("a hidden notice never reaches the stream but is still stored", async () => {
    const secret = defineExtension("secret", (ext) => {
      ext.notify(() => "internal only");
      ext.registerRenderer((p) => (p.type === "data-notice-secret" ? { hide: true } : undefined));
    }) as Extension;

    let stored: UIMessage[] = [];
    const chunks = await convertReadableStreamToArray(
      await runAgentLoop({
        model: twoSteps(),
        tools,
        messages,
        extensions: [
          secret,
          {
            name: "cap",
            commands: [],
            hooks: { agent_end: [({ messages: m }) => void (stored = m)] },
          },
        ],
      }),
    );

    expect(JSON.stringify(chunks)).not.toContain("internal only");
    // The store keeps it: `render` is a view, not a redaction.
    expect(JSON.stringify(stored)).toContain("internal only");
  });

  it("a replacement is what streams", async () => {
    const masked = defineExtension("masked", (ext) => {
      ext.notify(() => "raw value");
      ext.registerRenderer((p) =>
        p.type === "data-notice-masked" ? { replace: { type: "data-notice-masked", data: "•••" } } : undefined,
      );
    }) as Extension;

    const chunks = await convertReadableStreamToArray(
      await runAgentLoop({ model: twoSteps(), tools, messages, extensions: [masked] }),
    );
    expect(JSON.stringify(chunks)).toContain("•••");
    expect(JSON.stringify(chunks)).not.toContain("raw value");
  });
});
