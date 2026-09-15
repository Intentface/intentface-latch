/**
 * Handing tools a principal, a database handle or a secret resolver.
 *
 * The SDK's `toolsContext` is keyed BY TOOL NAME: it looks up
 * `toolsContext[toolName]`, so one flat object gives every tool `undefined`
 * with no error anywhere. That is the kind of mistake you find in production
 * rather than in a type check, so the loop takes a single `toolContext` and
 * fans it out, and these tests pin both halves.
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
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
} as never;

const calls = (...names: string[]) => {
  let n = 0;
  return new MockLanguageModelV4({
    doStream: async () =>
      n++ === 0
        ? {
            stream: convertArrayToReadableStream([
              { type: "stream-start", warnings: [] },
              { type: "response-metadata", id: "0", modelId: "m", timestamp: new Date(0) },
              ...names.map((toolName, i) => ({
                type: "tool-call",
                toolCallId: `c${i}`,
                toolName,
                input: "{}",
              })),
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
          },
  });
};

/** The shape a multi-tenant app threads: opaque to the framework, read by tools. */
interface Principal {
  orgId: string;
  userId: string;
}

const messages: UIMessage[] = [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }];
const principal: Principal = { orgId: "org_a", userId: "u_1" };

describe("toolContext", () => {
  it("reaches every tool's execute, not just the first", async () => {
    const seen: Record<string, unknown> = {};
    const mk = (name: string) =>
      tool({
        inputSchema: z.object({}),
        execute: async (_i, o: { context: { principal: Principal } }) => {
          seen[name] = o.context?.principal;
          return { ok: true };
        },
      });

    await convertReadableStreamToArray(
      await runAgentLoop({
        model: calls("alpha", "beta"),
        tools: { alpha: mk("alpha"), beta: mk("beta") },
        messages,
        toolContext: { principal },
      }),
    );

    // The bug this guards: fanning out only over the first tool, or passing the
    // flat object straight through and getting undefined everywhere.
    expect(seen).toEqual({ alpha: principal, beta: principal });
  });

  it("a per-tool entry wins over the shared one", async () => {
    const seen: Record<string, unknown> = {};
    const mk = (name: string) =>
      tool({
        inputSchema: z.object({}),
        execute: async (_i, o: { context: Record<string, unknown> }) => {
          seen[name] = o.context;
          return { ok: true };
        },
      });

    await convertReadableStreamToArray(
      await runAgentLoop({
        model: calls("alpha", "beta"),
        tools: { alpha: mk("alpha"), beta: mk("beta") },
        messages,
        toolContext: { principal, scope: "shared" },
        toolsContext: { beta: { scope: "just-beta" } },
      }),
    );

    expect(seen.alpha).toEqual({ principal, scope: "shared" });
    expect(seen.beta).toEqual({ principal, scope: "just-beta" });
  });

  it("covers a tool an extension added, not only the ones passed in", async () => {
    let seen: unknown;
    const late = defineExtension("late", (ext) =>
      ext.registerTool(
        "added",
        tool({
          inputSchema: z.object({}),
          execute: async (_i, o: { context: { principal: Principal } }) => {
            seen = o.context?.principal;
            return { ok: true };
          },
        }) as never,
      ),
    ) as Extension;

    await convertReadableStreamToArray(
      await runAgentLoop({
        model: calls("added"),
        tools: {},
        messages,
        extensions: [late],
        toolContext: { principal },
      }),
    );

    // The fan-out happens after `register_tools`, so a tool that did not exist
    // when the caller built the options still gets the context.
    expect(seen).toEqual(principal);
  });

  it("is absent when nothing was passed", async () => {
    let seen: unknown = "untouched";
    await convertReadableStreamToArray(
      await runAgentLoop({
        model: calls("alpha"),
        tools: {
          alpha: tool({
            inputSchema: z.object({}),
            execute: async (_i, o: { context?: unknown }) => {
              seen = o.context;
              return { ok: true };
            },
          }),
        },
        messages,
      }),
    );
    expect(seen).toBeUndefined();
  });
});
