/**
 * Multi-tenancy without a `<P>` type parameter.
 *
 * The shape is declared once by augmenting `Principal`, so nothing in any
 * signature carries a generic. Latch threads `<P>` through 23 exported symbols
 * and several carry two; every helper an application writes inherits that.
 * This buys the same safety for one `declare module`.
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
import { defineExtension, type Extension, type StepContext } from "./extension.js";

// The one declaration an application writes. From here on `principal` is typed
// everywhere, with no generics at any call site.
declare module "./extension.js" {
  interface Principal {
    orgId: string;
    userId: string;
  }
}

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
} as never;

const callsTool = () => {
  let n = 0;
  return new MockLanguageModelV4({
    doStream: async () =>
      n++ === 0
        ? {
            stream: convertArrayToReadableStream([
              { type: "stream-start", warnings: [] },
              { type: "response-metadata", id: "0", modelId: "m", timestamp: new Date(0) },
              { type: "tool-call", toolCallId: "c1", toolName: "whoami", input: "{}" },
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

const messages: UIMessage[] = [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }];
const principal = { orgId: "org_a", userId: "u_1" };

describe("the principal", () => {
  it("reaches every moment, so extensions cannot disagree about identity", async () => {
    const seen: Record<string, unknown> = {};
    const spy = defineExtension("spy", (ext) => {
      ext.on("step_start", (ctx: StepContext) => {
        // Typed by the augmentation: `orgId` exists without a cast.
        seen.stepStart = ctx.principal.orgId;
        return undefined;
      });
      ext.on("step_end", (_m, info) => {
        seen.stepEnd = info.principal.userId;
        return undefined;
      });
      ext.on("agent_end", ({ principal: p }) => void (seen.agentEnd = p.orgId));
    }) as Extension;

    await convertReadableStreamToArray(
      await runAgentLoop({ model: callsTool(), tools: {}, messages, principal, extensions: [spy] }),
    );

    expect(seen).toEqual({ stepStart: "org_a", stepEnd: "u_1", agentEnd: "org_a" });
  });

  it("reaches tools through the SDK's own context, with no second copy to pass", async () => {
    let seen: unknown;
    const tools = {
      whoami: tool({
        inputSchema: z.object({}),
        execute: async (_i, o: { context: { principal: { orgId: string } } }) => {
          seen = o.context.principal;
          return { org: o.context.principal.orgId };
        },
      }),
    };

    await convertReadableStreamToArray(
      await runAgentLoop({ model: callsTool(), tools, messages, principal }),
    );
    expect(seen).toEqual(principal);
  });

  it("still merges with an explicit toolContext", async () => {
    let seen: Record<string, unknown> | undefined;
    const tools = {
      whoami: tool({
        inputSchema: z.object({}),
        execute: async (_i, o: { context: Record<string, unknown> }) => {
          seen = o.context;
          return { ok: true };
        },
      }),
    };

    await convertReadableStreamToArray(
      await runAgentLoop({
        model: callsTool(),
        tools,
        messages,
        principal,
        toolContext: { db: "handle" },
      }),
    );
    expect(seen).toEqual({ principal, db: "handle" });
  });

  it("rejects a principal missing a declared field", () => {
    // @ts-expect-error userId is required by the augmentation
    const bad: import("./extension.js").Principal = { orgId: "org_a" };
    expect(bad).toBeTruthy();
  });
});

describe("every moment sees identity", () => {
  it("including the ones that only carry a part or a tool", async () => {
    const seen: Record<string, string> = {};
    const everywhere = defineExtension("everywhere", (ext) => {
      ext.on("input", (_i, run) => void (seen.input = run.principal.orgId));
      ext.on("register_tools", (t, run) => {
        seen.register_tools = run.principal.orgId;
        return t;
      });
      ext.on("tool_call", (_i, run) => void (seen.tool_call = run.principal.orgId));
      ext.on("tool_result", (_i, run) => void (seen.tool_result = run.principal.orgId));
      ext.on("data_part", (_p, run) => void (seen.data_part = run.principal.orgId));
      ext.on("before_agent_start", (_m, run) => void (seen.before_agent_start = run.principal.orgId));
      ext.on("step_start", (ctx) => void (seen.step_start = ctx.principal.orgId));
      ext.on("step_end", (_m, info) => void (seen.step_end = info.principal.orgId));
      ext.on("agent_end", ({ principal: p }) => void (seen.agent_end = p.orgId));
    }) as Extension;

    const tools = {
      whoami: tool({ inputSchema: z.object({}), execute: async () => ({ ok: true }) }),
    };
    const withData: UIMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "data-note", data: "x" }, { type: "text", text: "hi" }] },
    ];

    await convertReadableStreamToArray(
      await runAgentLoop({
        model: callsTool(),
        tools,
        messages: withData,
        principal,
        extensions: [everywhere],
      }),
    );

    // Every one of these would previously have had no way to know the tenant,
    // which is what made per-tenant policy impossible to write as an extension.
    expect(seen).toEqual({
      input: "org_a",
      register_tools: "org_a",
      tool_call: "org_a",
      tool_result: "org_a",
      data_part: "org_a",
      before_agent_start: "org_a",
      step_start: "org_a",
      step_end: "org_a",
      agent_end: "org_a",
    });
  });

  it("a per-tenant veto is now expressible", async () => {
    let ran = false;
    const tools = {
      whoami: tool({
        inputSchema: z.object({}),
        execute: async () => {
          ran = true;
          return { ok: true };
        },
      }),
    };
    const tenantPolicy = defineExtension("policy", (ext) =>
      ext.on("tool_call", (_info, run) =>
        run.principal.orgId === "org_a" ? { block: true, reason: "not on this plan" } : undefined,
      ),
    ) as Extension;

    await convertReadableStreamToArray(
      await runAgentLoop({ model: callsTool(), tools, messages, principal, extensions: [tenantPolicy] }),
    );
    expect(ran).toBe(false);
  });
});
