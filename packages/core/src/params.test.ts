import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream, tool } from "ai";
import { z } from "zod";
import { createRuntime } from "./runtime.js";
import { defineAgent, isInvalidParamsError, isParamsFixedError, MAX_PARAMS_BYTES } from "./agent.js";
import type { ToolContext } from "./context.js";
import { isInvalidMessageError, type AppMessage } from "./message.js";
import { memoryStorage } from "./__tests__/memory-storage.js";

/**
 * Params say what a chat is about. They arrive with the chat's first message,
 * are checked against the agent's schema and saved on the chat, and every later
 * turn (a new message, the continuation after an approval, a background run)
 * gets them without anyone sending them again.
 */

type P = { orgId: string };
const principal: P = { orgId: "org_a" };

const finish = (reason: string) => ({
  type: "finish",
  finishReason: { unified: reason, raw: reason },
  usage: { inputTokens: { total: 5 }, outputTokens: { total: 3 } },
});

const textStep = (text: string) => ({
  stream: simulateReadableStream({
    initialDelayInMs: 0,
    chunkDelayInMs: 0,
    chunks: [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "0" },
      { type: "text-delta", id: "0", delta: text },
      { type: "text-end", id: "0" },
      finish("stop"),
    ],
  }),
});

const says = (text: string) => new MockLanguageModelV4({ modelId: "mock", doStream: (async () => textStep(text)) as never });

/** Calls `name` once, then answers; per run. */
function callsThenSays(name: string, input: string) {
  let n = 0;
  return new MockLanguageModelV4({
    modelId: "mock-tools",
    doStream: (async () =>
      n++ % 2 === 0
        ? {
            stream: simulateReadableStream({
              initialDelayInMs: 0,
              chunkDelayInMs: 0,
              chunks: [
                { type: "stream-start", warnings: [] },
                { type: "tool-input-start", id: "call_1", toolName: name },
                { type: "tool-input-delta", id: "call_1", delta: input },
                { type: "tool-input-end", id: "call_1" },
                { type: "tool-call", toolCallId: "call_1", toolName: name, input },
                finish("tool-calls"),
              ],
            }),
          }
        : textStep("done")) as never,
  });
}

const user = (id: string, text: string): AppMessage => ({ id, role: "user", parts: [{ type: "text", text }] });

const Ticket = z.object({ ticketId: z.string() });
type Ticket = z.infer<typeof Ticket>;

function setup(agentModel = says("ok")) {
  const mem = memoryStorage();
  const seen: { agent: unknown[]; tool: unknown[] } = { agent: [], tool: [] };
  const close_ticket = tool({
    description: "Close the ticket",
    inputSchema: z.object({ reason: z.string() }),
    execute: async (_input, { context }) => {
      seen.tool.push((context as ToolContext<P, unknown, Ticket>).params);
      return { closed: true };
    },
  });
  const rt = createRuntime<P>({
    storage: mem.storage,
    context: ({ principal: p }) => ({ org: p.orgId }),
    agents: {
      support: defineAgent<P, { org: string }, Ticket>(
        ({ params }) => {
          seen.agent.push(params);
          return {
            model: agentModel,
            instructions: `Ticket ${params.ticketId}`,
            tools: { close_ticket },
            toolApproval: { close_ticket: "user-approval" },
          };
        },
        { params: Ticket },
      ),
      plain: defineAgent({ model: says("plain") }),
    },
  });
  return { mem, rt, seen };
}

async function refusal(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e;
  }
}

describe("params", () => {
  it("are saved by the first message and given to every later turn", async () => {
    const { mem, rt, seen } = setup();
    await (await rt.handleChat({ agent: "support", chatId: "c1", principal, message: user("u1", "hi"), params: { ticketId: "T-9" } })).text();
    expect(mem.chats.get("c1")?.params).toEqual({ ticketId: "T-9" });

    // Later messages send neither the agent nor the params.
    await (await rt.handleChat({ chatId: "c1", principal, message: user("u2", "and now?") })).text();
    expect(seen.agent).toEqual([{ ticketId: "T-9" }, { ticketId: "T-9" }]);
  });

  it("reach tools, and survive the pause for an approval", async () => {
    const { mem, rt, seen } = setup(callsThenSays("close_ticket", '{"reason":"fixed"}'));
    await (await rt.handleChat({ agent: "support", chatId: "c1", principal, message: user("u1", "close it"), params: { ticketId: "T-9" } })).text();
    // Paused at the gated tool: find its approval id in the stored answer.
    const parts = (mem.messages.get("c1") ?? []).flatMap((m) => m.parts) as { type: string; approval?: { id: string } }[];
    const approvalId = parts.find((p) => p.type === "tool-close_ticket")?.approval?.id;
    expect(approvalId).toBeDefined();

    // The approval carries no params; the continuation still has them.
    await (await rt.applyApproval({ chatId: "c1", principal, decisions: [{ approvalId: approvalId!, approved: true }] })).text();
    expect(seen.tool).toEqual([{ ticketId: "T-9" }]);
    expect(seen.agent.at(-1)).toEqual({ ticketId: "T-9" });
  });

  it("can be sent again unchanged, but not changed", async () => {
    const { rt } = setup();
    await (await rt.handleChat({ agent: "support", chatId: "c1", principal, message: user("u1", "hi"), params: { ticketId: "T-9" } })).text();
    await (await rt.handleChat({ chatId: "c1", principal, message: user("u2", "again"), params: { ticketId: "T-9" } })).text();
    const e = await refusal(rt.handleChat({ chatId: "c1", principal, message: user("u3", "other"), params: { ticketId: "T-10" } }));
    expect(isParamsFixedError(e)).toBe(true);
  });

  it("are refused before anything is saved when they don't match the schema", async () => {
    const { mem, rt } = setup();
    const missing = await refusal(rt.handleChat({ agent: "support", chatId: "c1", principal, message: user("u1", "hi") }));
    expect(isInvalidParamsError(missing)).toBe(true);
    const wrong = await refusal(rt.handleChat({ agent: "support", chatId: "c1", principal, message: user("u1", "hi"), params: { ticketId: 9 } }));
    expect(isInvalidParamsError(wrong)).toBe(true);
    expect(mem.chats.has("c1")).toBe(false);
  });

  it("are refused by an agent that declares none", async () => {
    const { mem, rt } = setup();
    const e = await refusal(rt.handleChat({ agent: "plain", chatId: "c1", principal, message: user("u1", "hi"), params: { x: 1 } }));
    expect(isInvalidParamsError(e)).toBe(true);
    expect(mem.chats.has("c1")).toBe(false);
  });

  it("must be plain JSON and not too large", async () => {
    const { rt } = setup();
    const big = await refusal(
      rt.handleChat({ agent: "support", chatId: "c1", principal, message: user("u1", "hi"), params: { ticketId: "x".repeat(MAX_PARAMS_BYTES) } }),
    );
    expect(isInvalidParamsError(big)).toBe(true);
  });

  it("are saved on a background run's thread", async () => {
    const { mem, rt, seen } = setup();
    const r = await rt.runAgent({ principal, agent: "support", prompt: "summarize", params: { ticketId: "T-1" } });
    expect(mem.chats.get(r.threadId)?.params).toEqual({ ticketId: "T-1" });
    expect(seen.agent).toEqual([{ ticketId: "T-1" }]);
  });
});

describe("a continuing chat", () => {
  it("uses its own agent when none is given; a new chat needs one", async () => {
    const { rt, seen } = setup();
    await (await rt.handleChat({ agent: "support", chatId: "c1", principal, message: user("u1", "hi"), params: { ticketId: "T-9" } })).text();
    await (await rt.handleChat({ chatId: "c1", principal, message: user("u2", "more") })).text();
    expect(seen.agent).toHaveLength(2);
    const e = await refusal(rt.handleChat({ chatId: "c2", principal, message: user("u1", "hi") }));
    expect(isInvalidMessageError(e)).toBe(true);
  });
});

describe("context as a plain function", () => {
  it("is built from the principal and reaches the agent", async () => {
    const mem = memoryStorage();
    let built: unknown;
    const rt = createRuntime<P>({
      storage: mem.storage,
      context: ({ principal: p }) => ({ org: p.orgId }),
      agents: {
        a: defineAgent<P, { org: string }>(({ context }) => {
          built = context;
          return { model: says("ok") };
        }),
      },
    });
    await (await rt.handleChat({ agent: "a", chatId: "c1", principal, message: user("u1", "hi") })).text();
    expect(built).toEqual({ org: "org_a" });
  });

  it("can be left out", async () => {
    const mem = memoryStorage();
    const rt = createRuntime<P>({ storage: mem.storage, agents: { a: defineAgent({ model: says("ok") }) } });
    const text = await (await rt.handleChat({ agent: "a", chatId: "c1", principal, message: user("u1", "hi") })).text();
    expect(text).toContain("ok");
  });
});
