import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream, tool } from "ai";
import { z } from "zod";
import { createRuntime, type DynamicAgentResolveContext } from "./runtime.js";
import { defineContext } from "./context.js";
import { defineAgent } from "./agent.js";
import type { AppMessage } from "./message.js";
import { memoryStorage } from "./__tests__/memory-storage.js";

/**
 * `parentAgent` reaches `DynamicAgentStore.resolve` on EVERY path a subagent's
 * thread can take — not just the first turn. A host shapes a subagent per
 * parent (Loredex limits a connector's tools by which agent spawned it); a
 * path that resolved without it would silently hand the subagent everything.
 */

type P = { orgId: string };
const principal: P = { orgId: "org_a" };

function model(text: string, toolCall?: { name: string; input: string }) {
  const finish = (reason: string) => ({
    type: "finish",
    finishReason: { unified: reason, raw: reason },
    usage: { inputTokens: { total: 5 }, outputTokens: { total: 3 } },
  });
  const textStep = () => ({
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
  if (!toolCall) return new MockLanguageModelV4({ modelId: "mock", doStream: (async () => textStep()) as never });
  const callStep = () => ({
    stream: simulateReadableStream({
      initialDelayInMs: 0,
      chunkDelayInMs: 0,
      chunks: [
        { type: "stream-start", warnings: [] },
        { type: "tool-input-start", id: "call_1", toolName: toolCall.name },
        { type: "tool-input-delta", id: "call_1", delta: toolCall.input },
        { type: "tool-input-end", id: "call_1" },
        { type: "tool-call", toolCallId: "call_1", toolName: toolCall.name, input: toolCall.input },
        finish("tool-calls"),
      ],
    }),
  });
  // Tool-call step, then the answer — per RUN (two calls each), repeatable.
  let n = 0;
  return new MockLanguageModelV4({
    modelId: "mock-tools",
    doStream: (async () => (n++ % 2 === 0 ? callStep() : textStep())) as never,
  });
}


const user = (text: string): AppMessage => ({ id: `m_${Math.random().toString(36).slice(2)}`, role: "user", parts: [{ type: "text", text }] });

function setup() {
  const mem = memoryStorage();
  const seen: (DynamicAgentResolveContext | undefined)[] = [];
  const rt = createRuntime<P>({
    storage: mem.storage,
    context: defineContext<P, unknown>({ build: async () => ({}) }),
    agents: {
      lead: defineAgent({
        model: model("delegated.", { name: "spawn_agent", input: '{"agent":"writer","prompt":"write x"}' }),
        instructions: "delegate",
        subagents: ["writer"],
      }),
    },
    // The subagent is a DYNAMIC agent: that is where a host shapes it per parent.
    dynamicAgents: {
      list: () => [{ name: "writer" }],
      resolve: (name, _p, ctx) => {
        if (name !== "writer") return undefined;
        seen.push(ctx);
        return { model: model("written."), instructions: "write" };
      },
    },
  });
  return { mem, rt, seen };
}

describe("parentAgent on every resolve of a subagent's thread", () => {
  it("is persisted when spawn_agent creates the thread, and handed to the first sub-turn", async () => {
    const { mem, rt, seen } = setup();
    await rt.runAgent({ principal, agent: "lead", prompt: "go" });
    const sub = [...mem.chats.values()].find((c) => c.agent === "writer")!;
    expect(sub.parentAgent).toBe("lead");
    expect(seen.at(-1)).toMatchObject({ parentAgent: "lead", autoApprove: true });
  });

  it("is read off the thread when it is continued — by runAgent, through the chat surface, or compacted", async () => {
    const { mem, rt, seen } = setup();
    await rt.runAgent({ principal, agent: "lead", prompt: "go" });
    const sub = [...mem.chats.values()].find((c) => c.agent === "writer")!;

    // runAgent({ threadId }) — the caller does not say who the parent was.
    seen.length = 0;
    await rt.runAgent({ principal, agent: "writer", prompt: "more", threadId: sub.id });
    expect(seen.at(-1)?.parentAgent).toBe("lead");

    // The chat surface (a host opening the sub-thread).
    seen.length = 0;
    await (await rt.handleChat({ agent: "writer", chatId: sub.id, principal, message: user("and more") })).text();
    expect(seen.at(-1)?.parentAgent).toBe("lead");

    // Compaction resolves the agent too (for its model).
    seen.length = 0;
    await rt.compactChat({ chatId: sub.id, principal }).catch(() => undefined);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)?.parentAgent).toBe("lead");
  });

  it("is absent on a thread nobody spawned", async () => {
    const { rt, seen } = setup();
    await (await rt.handleChat({ agent: "writer", principal, message: user("hi") })).text();
    expect(seen.at(-1)?.parentAgent).toBeUndefined();
  });
});

/** A sub-thread `lead` spawned, paused on its gated write. */
async function pausedSub(mem: ReturnType<typeof memoryStorage>) {
  await mem.storage.createChat(principal, { id: "sub_1", agent: "writer", kind: "internal", parentAgent: "lead" });
  await mem.storage.appendMessages("sub_1", [
    { id: "su1", role: "user", parts: [{ type: "text", text: "write x" }], metadata: { visibility: "user" } },
    {
      id: "sa1",
      role: "assistant",
      parts: [
        { type: "step-start" },
        { type: "tool-write_thing", toolCallId: "wc1", state: "approval-requested", input: { what: "x" }, approval: { id: "apv_1" } },
      ],
      metadata: { visibility: "user" },
    } as unknown as AppMessage,
  ]);
}

function gatedSetup() {
  const mem = memoryStorage();
  const seen: (DynamicAgentResolveContext | undefined)[] = [];
  const writeThing = tool({ description: "writes", inputSchema: z.object({ what: z.string() }), execute: async () => ({ ok: true }) });
  const rt = createRuntime<P>({
    storage: mem.storage,
    context: defineContext<P, unknown>({ build: async () => ({}) }),
    agents: { lead: defineAgent({ model: model("all done."), instructions: "delegate", subagents: ["writer"] }) },
    dynamicAgents: {
      list: () => [{ name: "writer" }],
      resolve: (name, _p, ctx) => {
        if (name !== "writer") return undefined;
        seen.push(ctx);
        return { model: model("written."), instructions: "write", tools: { write_thing: writeThing }, toolApproval: { write_thing: "user-approval" } };
      },
    },
  });
  return { mem, rt, seen };
}

describe("parentAgent on approval resumes", () => {
  it("reaches the subagent when a person approves the bubbled gate on the parent", async () => {
    const { mem, rt, seen } = gatedSetup();
    await pausedSub(mem);
    await mem.storage.createChat(principal, { id: "c_parent", agent: "lead" });
    await mem.storage.appendMessages("c_parent", [
      { id: "pu1", role: "user", parts: [{ type: "text", text: "get x written" }], metadata: { visibility: "user" } },
      {
        id: "pa1",
        role: "assistant",
        parts: [
          { type: "step-start" },
          { type: "tool-spawn_agent", toolCallId: "tc1", state: "output-available", input: { agent: "writer", prompt: "write x" }, output: { status: "awaiting_approval" } },
          { type: "data-subagent-approval", data: { approvalId: "sapv_1", subChatId: "sub_1", subApprovalIds: ["apv_1"], spawnToolCallId: "tc1", summaries: ["write_thing"] } },
        ],
        metadata: { visibility: "user" },
      } as unknown as AppMessage,
    ]);
    await (await rt.applyApproval({ chatId: "c_parent", principal, decisions: [{ approvalId: "sapv_1", approved: true }] })).text();
    expect(seen.at(-1)).toMatchObject({ parentAgent: "lead", autoApprove: false });
  });

  it("reaches the subagent when its own thread is approved directly", async () => {
    const { mem, rt, seen } = gatedSetup();
    await pausedSub(mem);
    await (await rt.applyApproval({ chatId: "sub_1", principal, decisions: [{ approvalId: "apv_1", approved: true }] })).text();
    expect(seen.at(-1)?.parentAgent).toBe("lead");
  });
});
