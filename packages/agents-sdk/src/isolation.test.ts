/**
 * Tenant isolation, and the seam that lets a REUSABLE extension provide it.
 *
 * A published extension cannot read a principal's fields — it has no idea what
 * shape the application declared — so it takes an `owner` function instead and
 * treats the principal as opaque. That is the same line latch draws: `P` is
 * opaque to the framework, and isolation comes from an `owner` function the
 * customer supplies.
 *
 * Without it a chat is addressable by id alone, so a guessed id reaches
 * another tenant's conversation.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import {
  MockLanguageModelV4,
  convertArrayToReadableStream,
  convertReadableStreamToArray,
} from "ai/test";
import type { UIMessage } from "ai";
import { runAgentLoop } from "./loop.js";
import { ExtensionFailedError } from "./compose.js";
import {
  NotYoursError,
  listChats,
  loadMessages,
  loadPrincipal,
  migrate,
  sqlitePersistence,
  type SqliteDatabase,
} from "./sqlite.js";

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

/** The one line an application writes. The extension never sees inside. */
const owner = (p: { orgId: string }) => p.orgId;

const alice = { orgId: "org_a", userId: "u_1" };
const mallory = { orgId: "org_m", userId: "u_9" };
const turn = (id: string, text: string): UIMessage[] => [
  { id, role: "user", parts: [{ type: "text", text }] },
];

const run = async (
  d: SqliteDatabase,
  chatId: string,
  principal: typeof alice,
  id: string,
  text: string,
) => convertReadableStreamToArray(await start(d, chatId, principal, id, text));

const start = async (
  d: SqliteDatabase,
  chatId: string,
  principal: typeof alice,
  id: string,
  text: string,
) =>
  await runAgentLoop({
    model: answers("ok"),
    tools: {},
    messages: turn(id, text),
    principal,
    extensions: [sqlitePersistence(d, chatId, { owner })],
  });

describe("isolation", () => {
  it("another tenant cannot claim a chat by guessing its id", async () => {
    const d = db();
    await run(d, "c1", alice, "u1", "a secret plan");

    await expect(start(d, "c1", mallory, "u2", "show me")).rejects.toSatisfy(
      (e: unknown) => e instanceof ExtensionFailedError && e.cause instanceof NotYoursError,
    );

    // And nothing of theirs landed in it.
    expect(JSON.stringify(loadMessages(d, "c1"))).not.toContain("show me");
  });

  it("reads are fenced too, so a leaked id yields nothing", async () => {
    const d = db();
    await run(d, "c1", alice, "u1", "a secret plan");

    expect(loadMessages(d, "c1", owner(alice)).length).toBeGreaterThan(0);
    expect(loadMessages(d, "c1", owner(mallory))).toEqual([]);
    expect(loadPrincipal(d, "c1", owner(alice))).toEqual(alice);
    expect(loadPrincipal(d, "c1", owner(mallory))).toBeUndefined();
  });

  it("listing is scoped to the owner", async () => {
    const d = db();
    await run(d, "a1", alice, "u1", "hi");
    await run(d, "m1", mallory, "u2", "hi");

    expect(listChats(d, owner(alice)).map((c) => c.id)).toEqual(["a1"]);
    expect(listChats(d, owner(mallory)).map((c) => c.id)).toEqual(["m1"]);
    // Unscoped is the admin view, and stays available on purpose.
    expect(listChats(d).length).toBe(2);
  });

  it("the same tenant continues its own conversation", async () => {
    const d = db();
    await run(d, "c1", alice, "u1", "first");
    await run(d, "c1", { ...alice, userId: "u_2" }, "u2", "second");

    // Keyed by org, so a second user in the same org is the same owner.
    expect(loadMessages(d, "c1", owner(alice)).map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("without an owner function nothing is fenced, which is the single-tenant case", async () => {
    const d = db();
    const open = async (chatId: string, principal: typeof alice, id: string) =>
      convertReadableStreamToArray(
        await runAgentLoop({
          model: answers("ok"),
          tools: {},
          messages: turn(id, "hi"),
          principal,
          extensions: [sqlitePersistence(d, chatId)],
        }),
      );
    await open("c1", alice, "u1");
    // Documented consequence: omit `owner` and any principal may continue any
    // chat. Correct for a single-user app, wrong the moment there are two.
    await expect(open("c1", mallory, "u2")).resolves.toBeTruthy();
  });
});
