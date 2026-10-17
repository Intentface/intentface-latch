import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream } from "ai";
import { createRuntime } from "./runtime.js";
import { defineContext } from "./context.js";
import { defineAgent } from "./agent.js";
import { staticPricing } from "./pricing.js";
import {
  DAY_MS,
  LimitExceededError,
  MINUTE_MS,
  exceededPolicy,
  isLimitExceededError,
  remainingTokens,
  usageKey,
  windowRef,
  windowStartOf,
  type LatchLimits,
  type LimitPolicy,
  type LimitStore,
  type LimitUsage,
  type LimitWindowRef,
} from "./limits.js";
import type { AppMessage } from "./message.js";
import type { ChatRecord, RunRecord, StorageAdapter } from "./storage.js";

/**
 * The limits seam end to end: admission refuses with a stable code and a
 * retry-after, the turn itself is counted at admission, tokens + cost settle on
 * finish, a resume settles without counting a turn, and the mid-turn stop ends
 * the tool loop at the tightest token budget.
 */

type P = { orgId: string; userId?: string };
const principal: P = { orgId: "org_a", userId: "u1" };

/** 7 input / 3 output tokens per call, one text answer. */
const mockModel = () =>
  new MockLanguageModelV4({
    modelId: "mock-model",
    doStream: (async () => ({
      stream: simulateReadableStream({
        initialDelayInMs: 0,
        chunkDelayInMs: 0,
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "0" },
          { type: "text-delta", id: "0", delta: "Hello!" },
          { type: "text-end", id: "0" },
          { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 7 }, outputTokens: { total: 3 } } },
        ],
      }),
    })) as never,
  });

function memoryStorage(): StorageAdapter<P> {
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
  };
  return impl as StorageAdapter<P>;
}

/** An in-memory LimitStore with the real per-row add semantics. */
function memoryLimitStore(): LimitStore & { rows: Map<string, LimitUsage>; adds: number } {
  const rows = new Map<string, LimitUsage>();
  const store = {
    rows,
    adds: 0,
    async read(refs: LimitWindowRef[]) {
      const out: Record<string, LimitUsage> = {};
      for (const r of refs) {
        const u = rows.get(usageKey(r));
        if (u) out[usageKey(r)] = u;
      }
      return out;
    },
    async add(entries: (LimitWindowRef & { usage: Partial<LimitUsage> })[]) {
      store.adds++;
      // Yield first, like a real round trip — so concurrent admissions interleave
      // and only the atomic increment-and-return keeps them apart.
      await new Promise((r) => setTimeout(r, 1));
      const out: Record<string, LimitUsage> = {};
      for (const e of entries) {
        const k = usageKey(e);
        const u = rows.get(k) ?? { turns: 0, tokens: 0, cost: 0 };
        const next = {
          turns: u.turns + (e.usage.turns ?? 0),
          tokens: u.tokens + (e.usage.tokens ?? 0),
          cost: u.cost + (e.usage.cost ?? 0),
        };
        rows.set(k, next);
        out[k] = next;
      }
      return out;
    },
  };
  return store;
}

const userMessage = (id = "m1"): AppMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text: "hi" }],
  metadata: { visibility: "user", createdAt: Date.now() },
});

function build(policies: LimitPolicy[], extra: Partial<LatchLimits<P>> = {}) {
  const store = memoryLimitStore();
  const limits: LatchLimits<P> = { store, limitsFor: () => policies, ...extra };
  const rt = createRuntime<P>({
    storage: memoryStorage(),
    context: defineContext<P, unknown>({ build: async () => ({}) }),
    agents: { echo: defineAgent({ model: mockModel(), instructions: "hi" }) },
    // 1 unit per token → 10 per turn.
    pricing: staticPricing({ "mock-model": { inputPer1M: 1_000_000, outputPer1M: 1_000_000 } }),
    limits,
  });
  return { rt, store };
}

const settled = () => new Promise((r) => setTimeout(r, 30));

describe("limits — pure helpers", () => {
  it("windows are fixed and epoch-aligned", () => {
    expect(windowStartOf(DAY_MS + 5, DAY_MS)).toBe(DAY_MS);
    expect(windowRef({ key: "k", windowMs: MINUTE_MS, max: {} }, 61_000)).toEqual({ key: "k", windowStart: 60_000, windowMs: MINUTE_MS });
  });

  it("exceededPolicy counts the next turn and reports the window's end", () => {
    const p: LimitPolicy = { key: "user:u1", windowMs: MINUTE_MS, max: { turns: 2, tokens: 100 } };
    const at = 60_000 + 10_000;
    const key = usageKey(windowRef(p, at));
    expect(exceededPolicy([p], { [key]: { turns: 1, tokens: 0, cost: 0 } }, at, { nextTurn: true })).toBeNull();
    const over = exceededPolicy([p], { [key]: { turns: 2, tokens: 0, cost: 0 } }, at, { nextTurn: true });
    expect(over?.retryAfterMs).toBe(50_000);
    // A resume (no new turn) is fine on turns, but an exhausted token budget still refuses.
    expect(exceededPolicy([p], { [key]: { turns: 2, tokens: 0, cost: 0 } }, at, { nextTurn: false })).toBeNull();
    expect(exceededPolicy([p], { [key]: { turns: 0, tokens: 100, cost: 0 } }, at, { nextTurn: false })).not.toBeNull();
    expect(remainingTokens([p], { [key]: { turns: 0, tokens: 60, cost: 0 } }, at)).toBe(40);
    expect(remainingTokens([{ ...p, max: { turns: 5 } }], {}, at)).toBeUndefined();
  });

  it("the error carries a stable code and a readable message", () => {
    const e = new LimitExceededError({ key: "org:o1", windowMs: DAY_MS, max: { tokens: 1 }, label: "your organization's daily token budget" }, { turns: 0, tokens: 1, cost: 0 }, 3_600_000);
    expect(isLimitExceededError(e)).toBe(true);
    expect(e.message).toBe("Limit reached: your organization's daily token budget. Try again in 60 min.");
    expect(new LimitExceededError({ key: "user:u1", windowMs: MINUTE_MS, max: { turns: 1 } }, { turns: 1, tokens: 0, cost: 0 }, 12_000).message).toMatch(
      /the per-minute limit for user:u1\. Try again in 12s/,
    );
  });
});

describe("limits — in the runtime", () => {
  it("counts the turn at admission, settles tokens + cost on finish", async () => {
    const policy: LimitPolicy = { key: "org:org_a", windowMs: DAY_MS, max: { tokens: 1000 } };
    const { rt, store } = build([policy]);
    await (await rt.handleChat({ agent: "echo", principal, message: userMessage() })).text();
    await settled();
    const u = store.rows.get(usageKey(windowRef(policy, Date.now())))!;
    expect(u).toEqual({ turns: 1, tokens: 10, cost: 10 });
  });

  it("refuses the turn that would exceed a turn cap — before anything is persisted", async () => {
    const onRefused = vi.fn();
    // A day window, not a minute: windows are aligned to the clock, and two
    // turns either side of a minute boundary would land in different windows.
    const { rt } = build([{ key: "user:u1", windowMs: DAY_MS, max: { turns: 1 }, label: "your daily turn limit" }], { onRefused });
    await (await rt.handleChat({ agent: "echo", principal, message: userMessage("a") })).text();
    await settled();
    const err = await rt.handleChat({ agent: "echo", principal, chatId: "chat_1", message: userMessage("b") }).catch((e) => e);
    expect(isLimitExceededError(err)).toBe(true);
    expect((err as LimitExceededError).retryAfterMs).toBeGreaterThan(0);
    expect((err as LimitExceededError).retryAfterMs).toBeLessThanOrEqual(DAY_MS);
    expect(onRefused).toHaveBeenCalledWith(expect.objectContaining({ agent: "echo", trigger: "chat" }));
    // The refused message never reached history.
    expect((await rt.loadHistory({ chatId: "chat_1", principal })).map((m) => m.id)).toEqual(expect.not.arrayContaining(["b"]));
  });

  it("refuses once a token budget is spent, and programmatic runs are gated too", async () => {
    const { rt, store } = build([{ key: "org:org_a", windowMs: DAY_MS, max: { tokens: 15 } }]);
    await rt.runAgent({ principal, agent: "echo", prompt: "one" }); // 10 tokens — admitted
    await settled();
    await expect(rt.runAgent({ principal, agent: "echo", prompt: "two" })).resolves.toBeDefined(); // 10 < 15 at admission
    await settled();
    await expect(rt.runAgent({ principal, agent: "echo", prompt: "three" })).rejects.toThrow(/Limit reached/);
    expect([...store.rows.values()][0]!.turns).toBe(2);
  });

  it("admits exactly one of N concurrent turns against a one-turn cap, and the losers release their reservation", async () => {
    const policy: LimitPolicy = { key: "user:u1", windowMs: DAY_MS, max: { turns: 1 } }; // day: see above
    const { rt, store } = build([policy]);
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => rt.runAgent({ principal, agent: "echo", prompt: `p${i}` })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((r) => r.status === "rejected")) {
      expect(isLimitExceededError((r as PromiseRejectedResult).reason)).toBe(true);
    }
    await settled();
    // The window counts admitted turns only: the four refused reservations were released.
    expect(store.rows.get(usageKey(windowRef(policy, Date.now())))!.turns).toBe(1);
  });

  it("with no matching policies nothing is counted", async () => {
    const { rt, store } = build([]);
    await (await rt.handleChat({ agent: "echo", principal, message: userMessage() })).text();
    await settled();
    expect(store.adds).toBe(0);
  });

  it("without the seam the runtime is unchanged", async () => {
    const rt = createRuntime<P>({
      storage: memoryStorage(),
      context: defineContext<P, unknown>({ build: async () => ({}) }),
      agents: { echo: defineAgent({ model: mockModel(), instructions: "hi" }) },
    });
    const body = await (await rt.handleChat({ agent: "echo", principal, message: userMessage() })).text();
    expect(body).toContain("Hello!");
  });
});
