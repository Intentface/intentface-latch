/**
 * Client-side tools: declared for the model, executed by the browser.
 *
 * They need no mechanism of their own. A tool with no server `execute` leaves
 * its call unanswered, which ends the run — the same rule approvals follow.
 * The answer arrives in the next request and the run continues.
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
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
  inputTokenDetails: {},
  outputTokenDetails: {},
} as never;

let prompts: Array<Array<{ role: string }>> = [];

const asks = () =>
  new MockLanguageModelV4({
    doStream: async (o) => {
      prompts.push(o.prompt as Array<{ role: string }>);
      return {
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "response-metadata", id: "0", modelId: "mock", timestamp: new Date(0) },
          { type: "tool-call", toolCallId: "c1", toolName: "getTimezone", input: "{}" },
          { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
        ] as never),
      };
    },
  });

const answers = () =>
  new MockLanguageModelV4({
    doStream: async (o) => {
      prompts.push(o.prompt as Array<{ role: string }>);
      return {
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "response-metadata", id: "1", modelId: "mock", timestamp: new Date(0) },
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "Helsinki then." },
          { type: "text-end", id: "t" },
          { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
        ] as never),
      };
    },
  });

/** No `execute`: the browser runs it. */
const tools = { getTimezone: tool({ description: "Read the browser timezone.", inputSchema: z.object({}) }) };
const messages: UIMessage[] = [{ id: "u1", role: "user", parts: [{ type: "text", text: "what time is it for me?" }] }];
const capture = (fn: (m: UIMessage[]) => void): Extension =>
  defineExtension("cap", (ext) => ext.on("agent_end", ({ messages: m }) => fn(m))) as Extension;

type ToolPart = { type: string; state?: string; output?: unknown };
const answered = (stored: UIMessage[], output: unknown): UIMessage[] => {
  const copy = structuredClone(stored);
  for (const p of copy[1]!.parts as ToolPart[]) {
    if (!p.type.startsWith("tool-")) continue;
    p.state = "output-available";
    p.output = output;
  }
  return copy;
};

describe("client-side tools", () => {
  it("the run ends with the call unanswered, and the next run continues it", async () => {
    prompts = [];
    let r1: UIMessage[] = [];
    await convertReadableStreamToArray(
      await runAgentLoop({ model: asks(), tools, messages, extensions: [capture((m) => (r1 = m))] }),
    );

    const part = (r1[1]!.parts as ToolPart[]).find((p) => p.type === "tool-getTimezone")!;
    expect(part.state).toBe("input-available");

    let r2: UIMessage[] = [];
    await convertReadableStreamToArray(
      await runAgentLoop({
        model: answers(),
        tools,
        messages: answered(r1, { tz: "Europe/Helsinki" }),
        extensions: [capture((m) => (r2 = m))],
      }),
    );

    expect(prompts[1]!.some((m) => m.role === "tool")).toBe(true);
    expect(JSON.stringify(prompts[1])).toContain("Europe/Helsinki");
    // One assistant message across the suspension, same as an approval.
    expect(r2[1]!.id).toBe(r1[1]!.id);
  });

  it("tool_result fires with source 'client' when the browser's output arrives", async () => {
    const seen: Array<{ source: string; output: unknown }> = [];
    const watch = defineExtension("watch", (ext) =>
      ext.on("tool_result", ({ source, output }) => {
        seen.push({ source, output });
        return undefined;
      }),
    ) as Extension;

    let r1: UIMessage[] = [];
    await convertReadableStreamToArray(
      await runAgentLoop({ model: asks(), tools, messages, extensions: [watch, capture((m) => (r1 = m))] }),
    );
    expect(seen).toEqual([]); // nothing ran on the server

    await convertReadableStreamToArray(
      await runAgentLoop({
        model: answers(),
        tools,
        messages: answered(r1, { tz: "Europe/Helsinki" }),
        extensions: [watch],
      }),
    );
    expect(seen).toEqual([{ source: "client", output: { tz: "Europe/Helsinki" } }]);
  });

  it("an override from tool_result reaches the model", async () => {
    prompts = [];
    const redact = defineExtension("redact", (ext) =>
      ext.on("tool_result", ({ source }) =>
        source === "client" ? { output: { tz: "[redacted]" } } : undefined,
      ),
    ) as Extension;

    let r1: UIMessage[] = [];
    await convertReadableStreamToArray(
      await runAgentLoop({ model: asks(), tools, messages, extensions: [capture((m) => (r1 = m))] }),
    );
    await convertReadableStreamToArray(
      await runAgentLoop({
        model: answers(),
        tools,
        messages: answered(r1, { tz: "Europe/Helsinki" }),
        extensions: [redact],
      }),
    );

    expect(JSON.stringify(prompts[1])).toContain("[redacted]");
    expect(JSON.stringify(prompts[1])).not.toContain("Europe/Helsinki");
  });

  it("does not re-fire an output an earlier run already handled", async () => {
    const seen: string[] = [];
    const watch = defineExtension("watch", (ext) =>
      ext.on("tool_result", ({ source }) => {
        seen.push(source);
        return undefined;
      }),
    ) as Extension;

    let r1: UIMessage[] = [];
    await convertReadableStreamToArray(
      await runAgentLoop({ model: asks(), tools, messages, extensions: [capture((m) => (r1 = m))] }),
    );
    let r2: UIMessage[] = [];
    await convertReadableStreamToArray(
      await runAgentLoop({
        model: answers(),
        tools,
        messages: answered(r1, { tz: "Europe/Helsinki" }),
        extensions: [watch, capture((m) => (r2 = m))],
      }),
    );
    expect(seen).toEqual(["client"]);

    // A further turn: the old output is behind an earlier step-start now.
    await convertReadableStreamToArray(
      await runAgentLoop({
        model: answers(),
        tools,
        messages: [...r2, { id: "u2", role: "user", parts: [{ type: "text", text: "thanks" }] }],
        extensions: [watch],
      }),
    );
    expect(seen).toEqual(["client"]);
  });
});
