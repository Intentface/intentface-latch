/**
 * Runs end, they do not pause.
 *
 * A run that needs a human ends. The unanswered tool call in the transcript is
 * the suspended state, and resuming is a new run over a longer message list.
 * There is no `awaiting` status, no lease held across a human's lunch break,
 * and nothing to recover after a restart: all the state is the messages.
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
  inputTokens: 3,
  outputTokens: 10,
  totalTokens: 13,
  inputTokenDetails: {},
  outputTokenDetails: {},
} as never;

let lastPrompt: Array<{ role: string }> = [];

const callsDangerous = () =>
  new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: "stream-start", warnings: [] },
        { type: "response-metadata", id: "0", modelId: "mock", timestamp: new Date(0) },
        { type: "tool-call", toolCallId: "c1", toolName: "deleteRepo", input: '{"name":"api"}' },
        { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
      ] as never),
    }),
  });

const answers = () =>
  new MockLanguageModelV4({
    doStream: async (o) => {
      lastPrompt = o.prompt as Array<{ role: string }>;
      return {
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "response-metadata", id: "1", modelId: "mock", timestamp: new Date(0) },
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "done" },
          { type: "text-end", id: "t" },
          { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
        ] as never),
      };
    },
  });

const messages: UIMessage[] = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "delete the repo" }] },
];

const capture = (fn: (m: UIMessage[]) => void): Extension =>
  defineExtension("capture", (ext) => ext.on("agent_end", ({ messages: m }) => fn(m))) as Extension;

/** Policy lives in an extension: it sets `needsApproval` on the toolset. */
const requireApproval = (predicate: (toolName: string, input: unknown) => boolean): Extension =>
  defineExtension("requireApproval", (ext) =>
    ext.on("register_tools", (ts) =>
      Object.fromEntries(
        Object.entries(ts).map(([n, t]) => [
          n,
          { ...t, needsApproval: (input: unknown) => predicate(n, input) },
        ]),
      ),
    ),
  ) as Extension;

describe("suspension at the tool boundary", () => {
  it("the run yields, the transcript is the state, and a new run resumes it", async () => {
    const executed: string[] = [];
    const tools = {
      deleteRepo: tool({
        inputSchema: z.object({ name: z.string() }),
        execute: async ({ name }) => {
          executed.push(name);
          return { deleted: name };
        },
      }),
    };

    let r1: UIMessage[] = [];
    const chunks = await convertReadableStreamToArray(
      await runAgentLoop({
        model: callsDangerous(),
        tools,
        messages,
        extensions: [
          requireApproval((n, i) => n === "deleteRepo" && (i as { name: string }).name === "api"),
          capture((m) => {
            r1 = m;
          }),
        ],
      }),
    );

    expect(executed).toEqual([]);
    expect((chunks.find((c) => c.type === "finish") as { finishReason: string }).finishReason).toBe(
      "tool-calls",
    );
    const part = r1[1]!.parts.find((p) => p.type === "tool-deleteRepo") as {
      state: string;
      approval: { id: string };
    };
    expect(part.state).toBe("approval-requested");
    expect(part.approval.id).toBeTruthy();

    // Process restarts, time passes. All the state is r1. A human approves,
    // which is exactly what useChat's addToolApprovalResponse writes.
    const approved = structuredClone(r1);
    const p = approved[1]!.parts.find((x) => x.type === "tool-deleteRepo") as {
      state: string;
      approval: Record<string, unknown>;
    };
    p.state = "approval-responded";
    p.approval = { ...p.approval, approved: true };

    let r2: UIMessage[] = [];
    await convertReadableStreamToArray(
      await runAgentLoop({
        model: answers(),
        tools,
        messages: approved,
        extensions: [
          requireApproval(() => true),
          capture((m) => {
            r2 = m;
          }),
        ],
      }),
    );

    expect(executed).toEqual(["api"]);
    // Same assistant message across the suspension: one run, one message.
    expect(r2[1]!.id).toBe(r1[1]!.id);
    const done = r2[1]!.parts.find((x) => x.type === "tool-deleteRepo") as {
      state: string;
      output: unknown;
    };
    expect(done.state).toBe("output-available");
    expect(done.output).toEqual({ deleted: "api" });
    expect(lastPrompt.some((m) => m.role === "tool")).toBe(true);
  });

  it("a denial executes nothing and the model is told why", async () => {
    const executed: string[] = [];
    const tools = {
      deleteRepo: tool({
        inputSchema: z.object({ name: z.string() }),
        needsApproval: true,
        execute: async ({ name }) => {
          executed.push(name);
          return {};
        },
      }),
    };

    let r1: UIMessage[] = [];
    await convertReadableStreamToArray(
      await runAgentLoop({
        model: callsDangerous(),
        tools,
        messages,
        extensions: [
          capture((m) => {
            r1 = m;
          }),
        ],
      }),
    );

    const denied = structuredClone(r1);
    const p = denied[1]!.parts.find((x) => x.type === "tool-deleteRepo") as {
      state: string;
      approval: Record<string, unknown>;
    };
    p.state = "approval-responded";
    p.approval = { ...p.approval, approved: false, reason: "not today" };

    await convertReadableStreamToArray(
      await runAgentLoop({ model: answers(), tools, messages: denied }),
    );

    expect(executed).toEqual([]);
    const toolMsg = lastPrompt.find((m) => m.role === "tool");
    expect(JSON.stringify(toolMsg)).toContain("execution-denied");
    expect(JSON.stringify(toolMsg)).toContain("not today");
  });
});
