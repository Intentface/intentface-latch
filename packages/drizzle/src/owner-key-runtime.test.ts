import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { jsonSchema, simulateReadableStream, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import {
  createRuntime,
  defineAgent,
  isOwnerKeyMismatchError,
  OwnerKeyMismatchError,
  type AppMessage,
  type RunRecord,
  type StorageAdapter,
} from "@intentface/latch-core";
import { createSqliteAdapter } from "./adapter.js";
import { migrate } from "./migrate.js";
import * as schema from "./schema.js";

/**
 * The runtime passes the owner key on EVERY id-only storage call (see
 * `OwnerScope`), on every path: a turn, its heartbeats and checkpoints, an
 * approval's continuation, crash recovery, and a schedule firing. An adapter
 * that keeps each tenant in its own schema routes by that key, so a single
 * call without it is a call it can't serve. Driven through the real SQLite
 * adapter, which also checks the key.
 */

type P = { orgId: string; userId: string };
const me: P = { orgId: "o1", userId: "u1" };
const KEY = "o1/u1";

/** Where each id-only method takes its `scope` argument. */
const SCOPE_AT = {
  appendMessages: 3,
  updateRun: 3,
  getRun: 1,
  heartbeatRun: 4,
  reclaimRun: 3,
  completeSchedule: 4,
  noteScheduleFire: 2,
} as const;
type IdOnly = keyof typeof SCOPE_AT;

/** The real adapter, recording the scope of every id-only call. */
function recorded(store: StorageAdapter<P>) {
  const calls: { method: IdOnly; scope: { ownerKey?: string; principal?: P } | undefined }[] = [];
  const proxy = new Proxy(store, {
    get(target, prop: string) {
      const value = (target as unknown as Record<string, unknown>)[prop];
      if (typeof value !== "function") return value;
      if (prop in SCOPE_AT) {
        return (...args: unknown[]) => {
          calls.push({ method: prop as IdOnly, scope: args[SCOPE_AT[prop as IdOnly]] as never });
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  });
  return { store: proxy, calls };
}

async function sqlite() {
  const client = createClient({ url: ":memory:" });
  await migrate(client);
  return createSqliteAdapter<P>(drizzle(client, { schema }), { owner: (p) => [p.orgId, p.userId] });
}

const finish = (reason: string) => ({
  type: "finish",
  finishReason: { unified: reason, raw: reason },
  usage: { inputTokens: { total: 5 }, outputTokens: { total: 3 } },
});

/** Answers in a few slow chunks, so heartbeats fire during the turn. */
const slowText = (text: string) => ({
  stream: simulateReadableStream({
    initialDelayInMs: 0,
    chunkDelayInMs: 15,
    chunks: [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      ...text.split(" ").map((w) => ({ type: "text-delta", id: "t", delta: `${w} ` })),
      { type: "text-end", id: "t" },
      finish("stop"),
    ],
  }),
});

/** First call: the `refund` tool. Every call after: an answer. */
function refundThenAnswer() {
  let n = 0;
  return new MockLanguageModelV4({
    modelId: "mock",
    doStream: (async () =>
      n++ === 0
        ? {
            stream: simulateReadableStream({
              initialDelayInMs: 0,
              chunkDelayInMs: 0,
              chunks: [
                { type: "stream-start", warnings: [] },
                { type: "tool-input-start", id: "call_1", toolName: "refund" },
                { type: "tool-input-delta", id: "call_1", delta: "{}" },
                { type: "tool-input-end", id: "call_1" },
                { type: "tool-call", toolCallId: "call_1", toolName: "refund", input: "{}" },
                finish("tool-calls"),
              ],
            }),
          }
        : slowText("refunded it for you")) as never,
  });
}

const refund = tool({ description: "Refund the order", inputSchema: jsonSchema({ type: "object", properties: {} }), execute: async () => ({ ok: true }) });

function runtimeOver(store: StorageAdapter<P>, extra: Partial<Parameters<typeof createRuntime<P>>[0]> = {}) {
  return createRuntime<P>({
    storage: store,
    agents: {
      support: defineAgent<P>({ model: refundThenAnswer(), tools: { refund }, toolApproval: { refund: "user-approval" } }),
      plain: defineAgent<P>({ model: new MockLanguageModelV4({ modelId: "mock", doStream: (async () => slowText("here is the brief")) as never }) }),
    },
    durability: { enabled: true, heartbeatMs: 5, leaseTtlMs: 60_000 },
    ...extra,
  });
}

const user = (id: string, text: string): AppMessage => ({ id, role: "user", parts: [{ type: "text", text }] });

describe("owner keys on id-only calls", () => {
  it("are on every call: a turn, its approval, crash recovery and a schedule", async () => {
    const base = await sqlite();
    const { store, calls } = recorded(base);
    const rt = runtimeOver(store);

    // A turn that stops for an approval, then its continuation.
    await (await rt.handleChat({ agent: "support", chatId: "c1", principal: me, message: user("u1", "refund my order") })).text();
    const parts = (await base.loadMessages(me, "c1")).flatMap((m) => m.parts) as { type: string; approval?: { id: string } }[];
    const approvalId = parts.find((p) => p.type === "tool-refund")?.approval?.id;
    expect(approvalId).toBeDefined();
    await (await rt.applyApproval({ chatId: "c1", principal: me, decisions: [{ approvalId: approvalId!, approved: true }] })).text();

    // A crashed turn: a run whose node died mid-answer, recovered by cron().
    const crashed = await base.createChat(me, { agent: "plain" });
    await base.openTurn!(me, { chatId: crashed.id, agent: "plain", messages: [user("u2", "brief me")], lease: { owner: "dead-node", ttlMs: 1 } });
    await new Promise((r) => setTimeout(r, 25));

    // A schedule firing in the same tick.
    await rt.schedule({ principal: me, agent: "plain", cron: null, prompt: "daily brief" });
    const tick = await rt.cron();
    expect(tick.errors).toEqual([]);
    expect(tick.resumed.map((r) => r.status)).toEqual(["completed"]);
    expect(tick.due.fired).toBe(1);

    // Every id-only method the runtime has, used at least once.
    const used = new Set(calls.map((c) => c.method));
    for (const method of ["appendMessages", "updateRun", "getRun", "heartbeatRun", "reclaimRun", "completeSchedule", "noteScheduleFire"] as const) {
      expect(used, `${method} was exercised`).toContain(method);
    }
    // ...and every call carried the key.
    const missing = calls.filter((c) => c.scope?.ownerKey !== KEY);
    expect(missing).toEqual([]);
  });

  it("asks for a run by person, not key, when it holds no record yet", async () => {
    const base = await sqlite();
    const { store, calls } = recorded(base);
    const rt = runtimeOver(store);
    const chat = await base.createChat(me, { agent: "plain" });
    const run = await base.createRun(me, { chatId: chat.id, agent: "plain" });

    expect((await rt.getRun({ principal: me, runId: run.id }))?.id).toBe(run.id);
    expect(await rt.getRun({ principal: { orgId: "o2", userId: "u9" }, runId: run.id })).toBeNull();
    expect(calls.filter((c) => c.method === "getRun").every((c) => c.scope?.principal !== undefined)).toBe(true);
  });

  it("a mismatch during recovery is reported, not retried, and the run is left alone", async () => {
    const base = await sqlite();
    // The reaper hands back a run carrying someone else's key: the adapter
    // refuses the reclaim that follows.
    const tampered = new Proxy(base, {
      get(target, prop: string) {
        const value = (target as unknown as Record<string, unknown>)[prop];
        if (prop === "reapExpiredRuns") {
          return async (...args: unknown[]) =>
            ((await (value as (...a: unknown[]) => Promise<RunRecord[]>).apply(target, args)) as RunRecord[]).map((r) => ({ ...r, ownerKey: "o2/u9" }));
        }
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const onOwnerKeyMismatch = vi.fn();
    const rt = runtimeOver(tampered, { onOwnerKeyMismatch });
    const chat = await base.createChat(me, { agent: "plain" });
    const crashed = await base.openTurn!(me, { chatId: chat.id, agent: "plain", messages: [user("u1", "brief me")], lease: { owner: "dead-node", ttlMs: 1 } });
    await new Promise((r) => setTimeout(r, 25));

    const first = await rt.cron();
    expect(first.resumed).toEqual([]);
    expect(first.errors).toHaveLength(1);
    expect(first.errors[0]).toContain(crashed.id);
    expect(onOwnerKeyMismatch).toHaveBeenCalledOnce();
    const event = onOwnerKeyMismatch.mock.calls[0]![0];
    expect(isOwnerKeyMismatchError(event.error)).toBe(true);
    expect(event).toMatchObject({ during: "resume", runId: crashed.id });

    // Not retried: the run stays as the reaper left it, and the next tick doesn't touch it.
    expect((await base.getRun(crashed.id))?.status).toBe("errored");
    const second = await rt.cron();
    expect(second.errors).toEqual([]);
    expect(onOwnerKeyMismatch).toHaveBeenCalledOnce();
  });

  it("a mismatch inside a turn stops it at once and is reported", async () => {
    const base = await sqlite();
    const refusing = new Proxy(base, {
      get(target, prop: string) {
        if (prop === "heartbeatRun") return async (id: string) => Promise.reject(new OwnerKeyMismatchError(`run ${id}`));
        const value = (target as unknown as Record<string, unknown>)[prop];
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const onOwnerKeyMismatch = vi.fn();
    const rt = runtimeOver(refusing, { onOwnerKeyMismatch });

    await (await rt.handleChat({ agent: "plain", chatId: "c1", principal: me, message: user("u1", "brief me") })).text();

    expect(onOwnerKeyMismatch).toHaveBeenCalledOnce();
    expect(onOwnerKeyMismatch.mock.calls[0]![0]).toMatchObject({ during: "turn" });
    const run = (await base.listRuns(me))[0]!;
    expect(run.status).toBe("errored");
  });
});
