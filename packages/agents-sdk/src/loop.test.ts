/**
 * The loop with extensions attached: the moments the prototype had defined but
 * never wired to a running loop.
 */
import { describe, it, expect } from "vitest";
import {
  MockLanguageModelV4,
  convertArrayToReadableStream,
  convertReadableStreamToArray,
} from "ai/test";
import { tool, type UIMessage } from "ai";
import { z } from "zod";
import { runAgentLoop, renderTranscript } from "./loop.js";
import { defineExtension, type Extension, type Part } from "./extension.js";

// The PROVIDER shape is nested; the SDK flattens it into `inputTokens` plus
// `inputTokenDetails`. A flat fixture here parses but yields zero tokens.
const usage = {
  inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
} as never;

let prompts: Array<Array<{ role: string; content: unknown }>> = [];

const answers = (text = "hello") =>
  new MockLanguageModelV4({
    doStream: async (o) => {
      prompts.push(o.prompt as Array<{ role: string; content: unknown }>);
      return {
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "response-metadata", id: "1", modelId: "mock", timestamp: new Date(0) },
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: text },
          { type: "text-end", id: "t" },
          { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
        ] as never),
      };
    },
  });

const callsTool = (toolName: string, input: string) => {
  let n = 0;
  return new MockLanguageModelV4({
    doStream: async (o) => {
      prompts.push(o.prompt as Array<{ role: string; content: unknown }>);
      if (n++ === 0)
        return {
          stream: convertArrayToReadableStream([
            { type: "stream-start", warnings: [] },
            { type: "response-metadata", id: "0", modelId: "mock", timestamp: new Date(0) },
            { type: "tool-call", toolCallId: "c1", toolName, input },
            { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
          ] as never),
        };
      return {
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "response-metadata", id: "1", modelId: "mock", timestamp: new Date(0) },
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "ok" },
          { type: "text-end", id: "t" },
          { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
        ] as never),
      };
    },
  });
};

const messages: UIMessage[] = [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }];
const capture = (fn: (m: UIMessage[]) => void): Extension =>
  defineExtension("capture", (ext) => ext.on("agent_end", ({ messages: m }) => fn(m))) as Extension;

const run = async (opts: Parameters<typeof runAgentLoop>[0]) =>
  convertReadableStreamToArray(await runAgentLoop(opts));

describe("session-scoped context", () => {
  it("does not fuse with the assistant message the model streams into", async () => {
    prompts = [];
    const wx = defineExtension("wx", (ext) =>
      ext.context(async () => "Weather: sunny", { scope: "session" }),
    ) as Extension;

    let stored: UIMessage[] = [];
    await run({
      model: answers(),
      tools: {},
      messages,
      extensions: [
        wx,
        capture((m) => {
          stored = m;
        }),
      ],
    });

    const carrier = stored.find((m) => m.parts.some((p) => p.type === "data-ctx-wx"))!;
    expect(carrier).toBeTruthy();
    // The defect this guards: the injected message becoming the response
    // anchor, so the reply merges into the context message.
    expect(carrier.parts.map((p) => p.type)).not.toContain("text");
    expect(stored.at(-1)!.role).toBe("assistant");
    expect(stored.at(-1)!.parts.some((p) => p.type === "text")).toBe(true);

    // The model still sees it, prepended to the latest user turn.
    expect(JSON.stringify(prompts[0])).toContain("Weather: sunny");
  });

  it("is hidden from the customer by renderTranscript", async () => {
    const wx = defineExtension("wx", (ext) =>
      ext.context(async () => "Weather: sunny", { scope: "session" }),
    ) as Extension;
    let stored: UIMessage[] = [];
    await run({
      model: answers(),
      tools: {},
      messages,
      extensions: [
        wx,
        capture((m) => {
          stored = m;
        }),
      ],
    });
    const shown = renderTranscript([wx], stored);
    expect(JSON.stringify(shown)).not.toContain("Weather: sunny");
    expect(JSON.stringify(shown)).toContain("hello");
  });
});

describe("commands", () => {
  it("a handled command answers without calling the model", async () => {
    prompts = [];
    const stats = defineExtension("stats", (ext) =>
      ext.registerCommand("stats", { description: "show stats", handler: async () => "42 turns" }),
    ) as Extension;

    let stored: UIMessage[] = [];
    const chunks = await run({
      model: answers(),
      tools: {},
      messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "/stats" }] }],
      extensions: [
        stats,
        capture((m) => {
          stored = m;
        }),
      ],
    });

    expect(prompts).toHaveLength(0);
    expect(chunks.some((c) => c.type === "text-delta" && (c as { delta: string }).delta === "42 turns")).toBe(true);
    expect(stored.at(-1)!.role).toBe("assistant");
  });

  it("an expanding command rewrites the prompt and lets the model run", async () => {
    prompts = [];
    const report = defineExtension("report", (ext) =>
      ext.registerCommand("report", {
        description: "weekly report",
        expand: async (args) => `Write the ${args} report.`,
      }),
    ) as Extension;

    await run({
      model: answers(),
      tools: {},
      messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "/report weekly" }] }],
      extensions: [report],
    });

    expect(prompts).toHaveLength(1);
    expect(JSON.stringify(prompts[0])).toContain("Write the weekly report.");
    expect(JSON.stringify(prompts[0])).not.toContain("/report");
  });
});

describe("tool vetoes", () => {
  const tools = {
    deleteRepo: tool({
      inputSchema: z.object({ name: z.string() }),
      execute: async ({ name }) => ({ deleted: name }),
    }),
  };

  it("a blocked call never executes and the model is told why", async () => {
    prompts = [];
    let executed = false;
    const gated = {
      deleteRepo: tool({
        inputSchema: z.object({ name: z.string() }),
        execute: async ({ name }) => {
          executed = true;
          return { deleted: name };
        },
      }),
    };
    const gate = defineExtension("gate", (ext) =>
      ext.on("tool_call", ({ toolName }) =>
        toolName === "deleteRepo" ? { block: true, reason: "production is protected" } : undefined,
      ),
    ) as Extension;

    await run({
      model: callsTool("deleteRepo", '{"name":"api"}'),
      tools: gated,
      messages,
      extensions: [gate],
    });

    expect(executed).toBe(false);
    // The reason reaches the model as a result, not a masked error.
    expect(JSON.stringify(prompts[1])).toContain("production is protected");
  });

  it("tool_result rewrites what is stored and what the model reads", async () => {
    prompts = [];
    const redact = defineExtension("redact", (ext) =>
      ext.on("tool_result", () => ({ output: { deleted: "[redacted]" } })),
    ) as Extension;

    let stored: UIMessage[] = [];
    await run({
      model: callsTool("deleteRepo", '{"name":"api"}'),
      tools,
      messages,
      extensions: [
        redact,
        capture((m) => {
          stored = m;
        }),
      ],
    });

    expect(JSON.stringify(stored)).toContain("[redacted]");
    expect(JSON.stringify(prompts[1])).toContain("[redacted]");

    // Known limit, asserted so it cannot change silently: `tool_result`
    // overrides the OUTPUT. The call's arguments stay in the transcript, so a
    // secret passed as a tool argument is not redacted by this moment.
    const part = stored[1]!.parts.find((p) => p.type === "tool-deleteRepo") as { input: unknown };
    expect(part.input).toEqual({ name: "api" });
  });
});

describe("step control", () => {
  it("step_start stop ends the run before the model is called", async () => {
    prompts = [];
    const budget = defineExtension("budget", (ext) =>
      ext.on("step_start", () => ({ stop: true })),
    ) as Extension;
    await run({ model: answers(), tools: {}, messages, extensions: [budget] });
    expect(prompts).toHaveLength(0);
  });

  it("notify appends a part the model never sees", async () => {
    prompts = [];
    const notices = defineExtension("cost", (ext) =>
      ext.notify((info) => `step ${info.stepNumber}: ${info.usage.totalTokens} tokens`),
    ) as Extension;

    let stored: UIMessage[] = [];
    await run({
      model: answers(),
      tools: {},
      messages,
      extensions: [
        notices,
        capture((m) => {
          stored = m;
        }),
      ],
    });

    expect(JSON.stringify(stored)).toContain("step 0: 17 tokens");
    expect(JSON.stringify(prompts[0])).not.toContain("17 tokens");
  });

  it("follow_up revives a run that was about to end", async () => {
    prompts = [];
    let revived = false;
    const again = defineExtension("again", (ext) =>
      ext.on("follow_up", () => {
        if (revived) return;
        revived = true;
        return {
          messages: [
            { id: "u2", role: "user", parts: [{ type: "text", text: "and again" }] } as UIMessage,
          ],
        };
      }),
    ) as Extension;

    await run({ model: answers(), tools: {}, messages, extensions: [again] });
    expect(prompts).toHaveLength(2);
    expect(JSON.stringify(prompts[1])).toContain("and again");
  });
});

describe("streaming tools", () => {
  it("progress chunks survive when only tool_result listens", async () => {
    const seen: unknown[] = [];
    const streaming = {
      ticker: tool({
        inputSchema: z.object({}),
        async *execute() {
          yield { step: 1 };
          yield { step: 2 };
          yield { step: 3 };
        },
      }),
    };
    const watch = defineExtension("watch", (ext) =>
      ext.on("tool_result", ({ output }) => {
        seen.push(output);
        return undefined;
      }),
    ) as Extension;

    let stored: UIMessage[] = [];
    await run({
      model: callsTool("ticker", "{}"),
      tools: streaming,
      messages,
      extensions: [
        watch,
        capture((m) => {
          stored = m;
        }),
      ],
    });

    // The hook fires once, on the final yield — not on every progress value.
    expect(seen).toEqual([{ step: 3 }]);
    const part = stored[1]!.parts.find((p) => p.type === "tool-ticker") as { output: unknown };
    expect(part.output).toEqual({ step: 3 });
  });
});

describe("renderTranscript", () => {
  it("drops a message that is left with no parts", () => {
    const hide = defineExtension("hide", (ext) =>
      ext.registerRenderer((p) => (p.type === "data-secret" ? { hide: true } : undefined)),
    ) as Extension;
    const stored: UIMessage[] = [
      { id: "a", role: "assistant", parts: [{ type: "data-secret", data: "x" } as Part] },
      { id: "b", role: "assistant", parts: [{ type: "text", text: "kept" }] },
    ];
    expect(renderTranscript([hide], stored).map((m) => m.id)).toEqual(["b"]);
  });
});
