import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream, tool } from "ai";
import { z } from "zod";
import { createRuntime } from "./runtime.js";
import { defineContext } from "./context.js";
import { defineAgent } from "./agent.js";
import type { AppMessage } from "./message.js";
import type { ChatRecord, RunRecord, StorageAdapter } from "./storage.js";

/**
 * The single non-streaming turn path (`runToCompletion`) as seen through its
 * public callers: `runAgent` and `runDue`. Pins what the consolidation must
 * preserve — a fresh `sub_` thread when no id is given, continuation of an
 * existing thread, the internal chat kind, autonomous runs waiving gates while
 * scheduled fires keep them (and report `parked`), and the trigger stamp.
 */

type P = { orgId: string };
const principal: P = { orgId: "org_a" };

/** A mock model that streams `text` (or a tool call first, then `text`). */
function model(text: string, toolCall?: { name: string; input: string }) {
  const finish = (reason: string) => ({
    type: "finish",
    finishReason: reason,
    usage: { inputTokens: { total: 5 }, outputTokens: { total: 3 } },
  });
  const textStep = {
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
  };
  if (!toolCall) return new MockLanguageModelV4({ modelId: "mock", doStream: textStep as never });
  const callStep = {
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
  };
  return new MockLanguageModelV4({ modelId: "mock-tools", doStream: [callStep, textStep] as never });
}

/**
 * In-memory storage: just enough of the adapter for a turn to run and persist.
 * `appendMessages` upserts by message id like the real adapters (composite
 * (chat_id, id) key): the finish hook re-sends the turn's user message.
 */
function memoryStorage() {
  const chats = new Map<string, ChatRecord>();
  const messages = new Map<string, AppMessage[]>();
  const runs = new Map<string, RunRecord>();
  let n = 0;
  const impl: Partial<StorageAdapter<P>> = {
    async createChat(_p, input) {
      const chat: ChatRecord = {
        id: input.id ?? `chat_${++n}`,
        owner: "org_a",
        agent: input.agent,
        title: input.title,
        kind: input.kind ?? "user",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      chats.set(chat.id, chat);
      messages.set(chat.id, []);
      return chat;
    },
    async getChat(_p, id) {
      return chats.get(id) ?? null;
    },
    async loadMessages(_p, chatId) {
      return [...(messages.get(chatId) ?? [])];
    },
    async appendMessages(chatId, msgs) {
      const list = [...(messages.get(chatId) ?? [])];
      for (const m of msgs) {
        const i = list.findIndex((x) => x.id === m.id);
        if (i >= 0) list[i] = m;
        else list.push(m);
      }
      messages.set(chatId, list);
    },
    async createRun(_p, input) {
      const run: RunRecord = {
        id: `run_${++n}`,
        chatId: input.chatId,
        agent: input.agent,
        status: "active",
        startedAt: Date.now(),
        kind: input.kind,
      } as RunRecord;
      runs.set(run.id, run);
      return run;
    },
    async updateRun(id, patch) {
      const r = runs.get(id);
      if (r) runs.set(id, { ...r, ...patch } as RunRecord);
      return true;
    },
    async getRun(id) {
      return runs.get(id) ?? null;
    },
    async recordUsage() {},
  };
  const storage = impl as StorageAdapter<P>;
  return { storage, chats, messages, runs };
}

const gatedTool = tool({
  description: "writes something",
  inputSchema: z.object({ what: z.string() }),
  execute: async ({ what }) => ({ wrote: what }),
});

function runtimeWith(mem: ReturnType<typeof memoryStorage>, agentModel: MockLanguageModelV4, triggers: string[] = []) {
  return createRuntime<P>({
    storage: mem.storage,
    context: defineContext<P, unknown>({ build: async () => ({}) }),
    agents: {
      writer: defineAgent({
        model: agentModel,
        instructions: "write",
        tools: { write_thing: gatedTool },
        toolApproval: { write_thing: "user-approval" },
      }),
    },
    // The trigger stamp is observable on the finish event.
    observability: { onFinish: (e) => void triggers.push(e.trigger) },
  });
}

describe("runAgent (autonomous)", () => {
  it("mints an internal sub_ thread, persists the exchange, returns the answer", async () => {
    const mem = memoryStorage();
    const rt = runtimeWith(mem, model("done."));
    const res = await rt.runAgent({ principal, agent: "writer", prompt: "go" });
    expect(res.threadId).toMatch(/^sub_/);
    expect(res.answer).toBe("done.");
    expect(mem.chats.get(res.threadId)?.kind).toBe("internal");
    const msgs = mem.messages.get(res.threadId)!;
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect([...mem.runs.values()][0]!.status).toBe("completed");
  });

  it("continues an existing thread with its history; an empty threadId mints a fresh one", async () => {
    const mem = memoryStorage();
    const rt = runtimeWith(mem, model("again."));
    const first = await rt.runAgent({ principal, agent: "writer", prompt: "one" });
    const second = await rt.runAgent({ principal, agent: "writer", prompt: "two", threadId: first.threadId });
    expect(second.threadId).toBe(first.threadId);
    expect(mem.messages.get(first.threadId)!.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    const blank = await rt.runAgent({ principal, agent: "writer", prompt: "three", threadId: "  " });
    expect(blank.threadId).not.toBe(first.threadId);
    expect(blank.threadId).toMatch(/^sub_/);
  });

  it("blockGated (default) stubs the gated tool so a test run has no side effects", async () => {
    const mem = memoryStorage();
    const rt = runtimeWith(mem, model("did it.", { name: "write_thing", input: '{"what":"x"}' }));
    const res = await rt.runAgent({ principal, agent: "writer", prompt: "write" });
    expect(res.answer).toBe("did it.");
    const parts = mem.messages.get(res.threadId)!.flatMap((m) => m.parts) as Array<{
      type: string;
      output?: { __blocked?: boolean };
    }>;
    const toolPart = parts.find((p) => p.type === "tool-write_thing");
    expect(toolPart?.output?.__blocked).toBe(true);
  });

  it("stamps the trigger (programmatic by default, overridable)", async () => {
    const triggers: string[] = [];
    const mem = memoryStorage();
    const rt = runtimeWith(mem, model("ok"), triggers);
    await rt.runAgent({ principal, agent: "writer", prompt: "a" });
    await rt.runAgent({ principal, agent: "writer", prompt: "b", trigger: "chat" });
    expect(triggers).toEqual(["programmatic", "chat"]);
  });
});

describe("scheduled fire (runDue → runToCompletion)", () => {
  const schedule = {
    id: "sch_1",
    owner: "org_a",
    agent: "writer",
    identity: { orgId: "org_a" },
    cron: null,
    prompt: "do the write",
    nextRunAt: 0,
    enabled: true,
    createdAt: 0,
  };

  function withSchedules(mem: ReturnType<typeof memoryStorage>) {
    const s = mem.storage as unknown as Record<string, unknown>;
    s.claimDueSchedules = async () => [schedule];
    s.completeSchedule = async () => {};
    s.noteScheduleFire = async () => {};
    return mem;
  }

  it("keeps HITL gates: a gated tool parks the fire, which is reported", async () => {
    const triggers: string[] = [];
    const mem = withSchedules(memoryStorage());
    const rt = runtimeWith(mem, model("never reached", { name: "write_thing", input: '{"what":"x"}' }), triggers);
    const out = await rt.runDue();
    expect(out).toEqual({ fired: 1, errors: 0, skipped: 0, parked: 1 });
    expect(triggers).toEqual(["schedule"]);
    // The fire ran in a USER-kind chat the scheduler created, not an internal sub_ thread.
    const chat = [...mem.chats.values()][0]!;
    expect(chat.kind).toBe("user");
    expect(chat.id).not.toMatch(/^sub_/);
    expect([...mem.runs.values()][0]!.status).toBe("awaiting_input");
  });

  it("an un-gated fire completes and is not parked", async () => {
    const mem = withSchedules(memoryStorage());
    const rt = runtimeWith(mem, model("report ready"));
    expect(await rt.runDue()).toEqual({ fired: 1, errors: 0, skipped: 0, parked: 0 });
    const chat = [...mem.chats.values()][0]!;
    expect(mem.messages.get(chat.id)!.map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});

describe("options.context carries the runtime", () => {
  it("a tool can reach the runtime it runs under", async () => {
    let seen: unknown;
    const mem = memoryStorage();
    const rt = createRuntime<P>({
      storage: mem.storage,
      context: defineContext<P, unknown>({ build: async () => ({ flag: 1 }) }),
      agents: {
        probe: defineAgent({
          model: model("ok", { name: "probe", input: "{}" }),
          instructions: "probe",
          tools: {
            probe: tool({
              description: "probe",
              inputSchema: z.object({}),
              execute: async (_i, options) => {
                seen = (options as { context?: Record<string, unknown> }).context;
                return { ok: true };
              },
            }),
          },
        }),
      },
    });
    await rt.runAgent({ principal, agent: "probe", prompt: "x", blockGated: false });
    const ctx = seen as { flag: number; principal: P; runtime: unknown; run: { agent: string } };
    expect(ctx.flag).toBe(1);
    expect(ctx.principal).toEqual(principal);
    expect(ctx.run.agent).toBe("probe");
    expect(ctx.runtime).toBe(rt);
  });
});
