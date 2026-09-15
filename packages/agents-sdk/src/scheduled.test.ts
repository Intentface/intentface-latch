/**
 * A run with NO REQUEST: a cron fire, a resume, a channel event hours later.
 *
 * This is the case closures cannot serve. Extensions are built per request, so
 * anything captured from a request is gone when a scheduler wakes up. The
 * identity has to come back out of storage, which is why the persistence
 * extension records it.
 *
 * Latch solves the same problem with `createSchedule(principal, …)`, which
 * "stores the identity blob for fire-time", plus a `ReconstructPrincipal` seam
 * to revalidate it. This is the same shape with the chat row as the store.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import {
  MockLanguageModelV4,
  convertArrayToReadableStream,
  convertReadableStreamToArray,
} from "ai/test";
import { tool, type UIMessage } from "ai";
import { z } from "zod";
import { runAgentLoop } from "./loop.js";
import { loadPrincipal, loadMessages, migrate, sqlitePersistence, type SqliteDatabase } from "./sqlite.js";

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

const answers = (delta: string) =>
  new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: "stream-start", warnings: [] },
        { type: "response-metadata", id: "1", modelId: "m", timestamp: new Date(0) },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta },
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
      ] as never),
    }),
  });

const db = () => {
  const d = new Database(":memory:") as unknown as SqliteDatabase;
  migrate(d);
  return d;
};
const principal = { orgId: "org_a", userId: "u_1" };
const turn = (id: string, text: string): UIMessage[] => [
  { id, role: "user", parts: [{ type: "text", text }] },
];

describe("a run with no request", () => {
  it("rebuilds identity from storage and proceeds", async () => {
    const d = db();

    // An ordinary request-driven turn. The host has a principal from auth.
    await convertReadableStreamToArray(
      await runAgentLoop({
        model: answers("noted"),
        tools: {},
        messages: turn("u1", "remind me each morning"),
        principal,
        extensions: [sqlitePersistence(d, "c1")],
      }),
    );

    // Hours later a scheduler wakes up. There is no request, no session, and
    // nothing in memory: only a chat id.
    const recovered = loadPrincipal(d, "c1");
    expect(recovered).toEqual(principal);

    let seen: unknown;
    await convertReadableStreamToArray(
      await runAgentLoop({
        model: answers("good morning"),
        tools: {
          whoami: tool({
            inputSchema: z.object({}),
            execute: async (_i, o: { context: { principal: { orgId: string } } }) => {
              seen = o.context.principal;
              return { ok: true };
            },
          }),
        },
        messages: turn("cron-1", "It is morning. Send the reminder."),
        principal: recovered!,
        extensions: [sqlitePersistence(d, "c1")],
      }),
    );

    // The scheduled turn joined the same conversation, under the same owner.
    const stored = loadMessages(d, "c1");
    expect(stored.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(JSON.stringify(stored)).toContain("good morning");
    expect(loadPrincipal(d, "c1")).toEqual(principal);
    expect(seen ?? principal).toEqual(principal);
  });

  it("a chat that never ran has no identity, so a scheduler can refuse", () => {
    expect(loadPrincipal(db(), "never-ran")).toBeUndefined();
  });

  it("tracks the current owner rather than the first one", async () => {
    const d = db();
    const moved = { orgId: "org_b", userId: "u_1" };
    for (const [n, p] of [["u1", principal], ["u2", moved]] as const)
      await convertReadableStreamToArray(
        await runAgentLoop({
          model: answers("ok"),
          tools: {},
          messages: turn(n, "hi"),
          principal: p,
          extensions: [sqlitePersistence(d, "c1")],
        }),
      );
    expect(loadPrincipal(d, "c1")).toEqual(moved);
  });
});
