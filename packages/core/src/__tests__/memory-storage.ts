import type { AppMessage } from "../message.js";
import { ChatBusyError, type ChatRecord, type QueuedInput, type RunRecord, type StorageAdapter } from "../storage.js";

/**
 * In-memory storage: just enough of the adapter for a turn to run and persist.
 * `appendMessages` upserts by message id like the real adapters (composite
 * (chat_id, id) key): the finish hook re-sends the turn's user message.
 *
 * Shared by the tests that drive a whole turn through `createRuntime`. Kept
 * out of `dist` by the build tsconfig's `src/__tests__` exclusion.
 */
// Process-wide, not per instance: real adapters mint random ids, so two stores
// never share a run id. A per-instance counter would let two runtimes in one
// test both open `run_1` and collide on anything keyed by run id.
let seq = 0;

export function memoryStorage<P = { orgId: string }>() {
  const chats = new Map<string, ChatRecord>();
  const messages = new Map<string, AppMessage[]>();
  const runs = new Map<string, RunRecord>();
  const queued = new Map<string, QueuedInput[]>();
  const n = { get next() { return ++seq; } };
  const impl: Partial<StorageAdapter<P>> = {
    async createChat(_p, input) {
      const chat: ChatRecord = {
        id: input.id ?? `chat_${n.next}`,
        owner: "org_a",
        agent: input.agent,
        title: input.title,
        kind: input.kind ?? "user",
        ...(input.parentAgent ? { parentAgent: input.parentAgent } : {}),
        ...(input.params !== undefined ? { params: input.params } : {}),
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
      // One live turn per chat, as the shipped adapters enforce it.
      for (const r of runs.values()) {
        if (r.chatId === input.chatId && r.status === "active") throw new ChatBusyError(input.chatId, 1000);
      }
      const run: RunRecord = {
        id: `run_${n.next}`,
        chatId: input.chatId,
        agent: input.agent,
        status: "active",
        startedAt: Date.now(),
        kind: input.kind,
        ...(input.settings ? { settings: input.settings } : {}),
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
    async listRuns(_p, opts) {
      return [...runs.values()].filter((r) => !opts?.chatId || r.chatId === opts.chatId).reverse();
    },
    async enqueueInput(p, chatId, message, { cap }) {
      if (!chats.has(chatId)) return false;
      const list = queued.get(chatId) ?? [];
      const at = list.findIndex((q) => q.message.id === message.id);
      if (at >= 0) list[at] = { ...list[at]!, message };
      else if (list.length >= cap) return false;
      else list.push({ message, identity: p, createdAt: Date.now() });
      queued.set(chatId, list);
      return true;
    },
    async listQueuedInputs(_p, chatId) {
      return [...(queued.get(chatId) ?? [])];
    },
    async listChatsWithQueuedInputs({ heldBefore, limit }) {
      return [...queued.entries()]
        .filter(([, list]) => list.some((q) => q.createdAt < heldBefore))
        .slice(0, limit)
        .map(([chatId, list]) => ({ chatId, identity: list[0]!.identity }));
    },
    async removeQueuedInputs(chatId, ids) {
      const list = queued.get(chatId) ?? [];
      queued.set(chatId, list.filter((q) => !ids.includes(q.message.id)));
      return list.filter((q) => ids.includes(q.message.id)).map((q) => q.message.id);
    },
  };
  const storage = impl as StorageAdapter<P>;
  return { storage, chats, messages, runs, queued };
}
