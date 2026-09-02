import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream } from "ai";
import { createRuntime } from "./runtime.js";
import { defineContext } from "./context.js";
import { defineAgent } from "./agent.js";
import { ChatBusyError, isChatBusyError } from "./storage.js";
import type { AppMessage } from "./message.js";
import type { ChatRecord, RunRecord, StorageAdapter } from "./storage.js";

/**
 * One active run per chat is a STORAGE invariant (the shipped adapters enforce
 * it with a partial unique index; the drizzle smoke proves the racing cases).
 * What core owes on top: the refusal surfaces unchanged with its stable code,
 * and a refused message is NOT persisted — the client retries it.
 */

type P = { orgId: string };
const principal: P = { orgId: "org_a" };

const slowModel = () =>
  new MockLanguageModelV4({
    modelId: "mock-model",
    doStream: (async () => ({
      stream: simulateReadableStream({
        initialDelayInMs: 0,
        chunkDelayInMs: 20,
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "0" },
          { type: "text-delta", id: "0", delta: "Hello!" },
          { type: "text-end", id: "0" },
          { type: "finish", finishReason: "stop", usage: { inputTokens: { total: 7 }, outputTokens: { total: 3 } } },
        ],
      }),
    })) as never,
  });

/** In-memory storage that enforces one active run per chat, as the adapters do. */
function busyAwareStorage() {
  const chats = new Map<string, ChatRecord>();
  const messages = new Map<string, AppMessage[]>();
  const runs = new Map<string, RunRecord>();
  let n = 0;
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
      for (const r of runs.values()) {
        if (r.chatId === input.chatId && r.status === "active") throw new ChatBusyError(input.chatId, 4200);
      }
      const run = { id: `run_${++n}`, chatId: input.chatId, agent: input.agent, status: "active", startedAt: Date.now() } as RunRecord;
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
    // The atomic path the shipped adapters offer: nothing persists on refusal.
    async openTurn(p, input) {
      const run = await impl.createRun!(p, { chatId: input.chatId, agent: input.agent });
      await impl.appendMessages!(input.chatId, [input.message]);
      return run;
    },
  };
  return { storage: impl as StorageAdapter<P>, messages };
}

const userMessage = (id: string): AppMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text: id }],
  metadata: { visibility: "user", createdAt: Date.now() },
});

describe("one active run per chat", () => {
  it("a second message while a turn is live is refused with chat_busy and never persisted", async () => {
    const { storage, messages } = busyAwareStorage();
    const rt = createRuntime<P>({
      storage,
      context: defineContext<P, unknown>({ build: async () => ({}) }),
      agents: { echo: defineAgent({ model: slowModel(), instructions: "hi" }) },
    });
    const first = await rt.handleChat({ agent: "echo", principal, chatId: "c1", message: userMessage("a") });
    const err = await rt.handleChat({ agent: "echo", principal, chatId: "c1", message: userMessage("b") }).catch((e) => e);
    expect(isChatBusyError(err)).toBe(true);
    expect((err as ChatBusyError).retryAfterMs).toBe(4200);
    expect((messages.get("c1") ?? []).map((m) => m.id)).toEqual(["a"]);
    await first.text();
    await new Promise((r) => setTimeout(r, 30));
    // Once the first turn settled, the retry goes through.
    await (await rt.handleChat({ agent: "echo", principal, chatId: "c1", message: userMessage("b") })).text();
  });
});
