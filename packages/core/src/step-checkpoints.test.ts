import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream, tool } from "ai";
import { z } from "zod";
import { createRuntime } from "./runtime.js";
import { defineContext } from "./context.js";
import { defineAgent } from "./agent.js";
import type { AppMessage } from "./message.js";
import type { ChatRecord, RunRecord, StorageAdapter } from "./storage.js";

/**
 * Per-step checkpoints (durability on) are fire-and-forget for the stream, but
 * they must COMMIT in step order, and the finish handler's final write must be
 * the row's last write. Each checkpoint replaces the message wholesale, so an
 * unordered slow write would roll the row back to an older step — and, racing
 * `onFinish`, clobber the usage/cost metadata only the finish handler stamps.
 *
 * The storage double here commits a write only when its promise settles, and
 * holds the FIRST assistant write for a while; the turn's other writes are
 * immediate. Without the ordering, the held write lands last.
 */

type P = { orgId: string };
const principal: P = { orgId: "org_a" };

/** Two steps: a tool call, then the answer. Streams are built per call. */
function twoStepModel() {
  const finish = (reason: string) => ({
    type: "finish",
    finishReason: { unified: reason, raw: reason },
    usage: { inputTokens: { total: 5 }, outputTokens: { total: 3 } },
  });
  const step = (chunks: unknown[]) => ({
    stream: simulateReadableStream({ initialDelayInMs: 0, chunkDelayInMs: 0, chunks: [{ type: "stream-start", warnings: [] }, ...chunks] }),
  });
  let n = 0;
  return new MockLanguageModelV4({
    modelId: "mock-tools",
    doStream: (async () =>
      n++ === 0
        ? step([
            { type: "tool-input-start", id: "call_1", toolName: "lookup" },
            { type: "tool-input-delta", id: "call_1", delta: '{"q":"x"}' },
            { type: "tool-input-end", id: "call_1" },
            { type: "tool-call", toolCallId: "call_1", toolName: "lookup", input: '{"q":"x"}' },
            finish("tool-calls"),
          ])
        : step([
            { type: "text-start", id: "0" },
            { type: "text-delta", id: "0", delta: "found it" },
            { type: "text-end", id: "0" },
            finish("stop"),
          ])) as never,
  });
}

/**
 * Durable in-memory storage that records the ORDER assistant writes commit in,
 * and delays the first one. A write commits when its promise resolves — like a
 * database, not when the call is issued.
 */
function slowFirstWriteStorage(holdMs: number) {
  const chats = new Map<string, ChatRecord>();
  const messages = new Map<string, AppMessage[]>();
  const runs = new Map<string, RunRecord>();
  const committed: AppMessage[] = [];
  let assistantWrites = 0;
  let n = 0;
  const apply = (chatId: string, msgs: AppMessage[]) => {
    const list = [...(messages.get(chatId) ?? [])];
    for (const m of msgs) {
      const i = list.findIndex((x) => x.id === m.id);
      if (i >= 0) list[i] = structuredClone(m);
      else list.push(structuredClone(m));
      if (m.role === "assistant") committed.push(structuredClone(m));
    }
    messages.set(chatId, list);
  };
  const lease = { owner: "node_a", fencingToken: 1 };
  const impl: Partial<StorageAdapter<P>> = {
    async createChat(_p, input) {
      const chat: ChatRecord = { id: input.id ?? `chat_${++n}`, owner: "org_a", agent: input.agent, title: input.title, kind: input.kind ?? "user", createdAt: Date.now(), updatedAt: Date.now() };
      chats.set(chat.id, chat);
      messages.set(chat.id, []);
      return chat;
    },
    async getChat(_p, id) {
      return chats.get(id) ?? null;
    },
    async loadMessages(_p, chatId) {
      return structuredClone(messages.get(chatId) ?? []);
    },
    async appendMessages(chatId, msgs) {
      if (msgs.some((m) => m.role === "assistant") && assistantWrites++ === 0) {
        await new Promise((r) => setTimeout(r, holdMs));
      }
      apply(chatId, msgs);
    },
    async claimRun(input) {
      const run = { id: `run_${++n}`, chatId: input.chatId, agent: input.agent, status: "active", startedAt: Date.now(), leaseOwner: lease.owner, fencingToken: lease.fencingToken, leaseExpiresAt: Date.now() + input.ttlMs } as RunRecord;
      runs.set(run.id, run);
      return run;
    },
    async openTurn(_p, input) {
      const run = await impl.claimRun!({ principal, chatId: input.chatId, agent: input.agent, owner: input.lease?.owner ?? "t1", ttlMs: input.lease?.ttlMs ?? 0 });
      apply(input.chatId, input.messages);
      return run;
    },
    async heartbeatRun() {
      return true;
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
  return { storage: impl as StorageAdapter<P>, messages, runs, committed };
}

const lookup = tool({
  description: "look something up",
  inputSchema: z.object({ q: z.string() }),
  execute: async ({ q }) => ({ hit: q }),
});

describe("step checkpoints", () => {
  it("commit in step order, and the finished message is the row's last write", async () => {
    const mem = slowFirstWriteStorage(60);
    const rt = createRuntime<P>({
      storage: mem.storage,
      context: defineContext<P, unknown>({ build: async () => ({}) }),
      agents: { finder: defineAgent({ model: twoStepModel(), instructions: "find", tools: { lookup } }) },
      durability: { enabled: true, instanceId: "node_a" },
    });
    const res = await rt.handleChat({
      principal,
      agent: "finder",
      chatId: "c1",
      message: { id: "u1", role: "user", parts: [{ type: "text", text: "find x" }], metadata: { visibility: "user", createdAt: Date.now() } },
    });
    await res.text();
    // Wait for every write to land, not a fixed delay: all three commits (two
    // checkpoints and the final message, the only one stamped with usage) and
    // the settled run. Waiting for the final write alone would return before a
    // slow early checkpoint lands, which is the very bug this test pins.
    await vi.waitFor(
      () => {
        expect(mem.committed.length).toBeGreaterThanOrEqual(3);
        expect(mem.committed.some((m) => m.metadata?.usage !== undefined)).toBe(true);
        expect([...mem.runs.values()][0]!.status).toBe("completed");
      },
      { timeout: 2_000, interval: 10 },
    );

    // Two checkpoints (tool step, text step) and the final write.
    expect(mem.committed.length).toBeGreaterThanOrEqual(3);
    // Never rolled back: each commit carries at least the parts of the one before.
    const sizes = mem.committed.map((m) => m.parts.length);
    expect([...sizes].sort((a, b) => a - b)).toEqual(sizes);
    // Last write = onFinish's: it alone stamps usage and cost.
    const last = mem.committed[mem.committed.length - 1]!;
    expect(last.metadata?.usage).toEqual({ inputTokens: 10, outputTokens: 6 });
    // What a reload shows is that final message, not a stale checkpoint.
    const stored = mem.messages.get("c1")!.find((m) => m.role === "assistant")!;
    expect(stored.metadata?.usage).toEqual({ inputTokens: 10, outputTokens: 6 });
    expect(stored.parts.some((p) => p.type === "text" && (p as { text: string }).text === "found it")).toBe(true);
    expect([...mem.runs.values()][0]!.status).toBe("completed");
  });
});
