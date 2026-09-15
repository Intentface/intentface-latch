/**
 * The persistence extension against a real SQLite database in memory.
 *
 * The interesting assertions are the failure ones. This extension is
 * `critical`, so a database problem must stop the run rather than be reported
 * and skipped — which is what the prototype this came from got wrong.
 *
 * Where the failure surfaces depends on when it happens, and that distinction
 * is deliberate:
 *
 *   before the first chunk   the promise rejects, so a route can answer 409
 *   after the first chunk    the run stops and the reason is streamed in-band,
 *                            because sent bytes cannot be recalled
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
  ChatBusyError,
  listChats,
  loadMessages,
  migrate,
  sqlitePersistence,
  type SqliteDatabase,
} from "./sqlite.js";

const usage = {
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
  inputTokenDetails: {},
  outputTokenDetails: {},
} as never;

const answers = (text = "hello") =>
  new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: "stream-start", warnings: [] },
        { type: "response-metadata", id: "1", modelId: "mock", timestamp: new Date(0) },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: text },
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
      ] as never),
    }),
  });

const db = () => new Database(":memory:") as unknown as SqliteDatabase;
const user = (id: string, text: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

/** A database whose matching statement always throws. */
const breakOn = (d: SqliteDatabase, match: string): SqliteDatabase => ({
  prepare: (sql: string) => {
    if (sql.includes(match)) throw new Error("disk I/O error");
    return d.prepare(sql);
  },
  transaction: ((fn: never) => d.transaction(fn)) as SqliteDatabase["transaction"],
  exec: (sql: string) => d.exec(sql),
});

const run = async (d: SqliteDatabase, chatId: string, messages: UIMessage[], text = "hello") =>
  convertReadableStreamToArray(
    await runAgentLoop({
      model: answers(text),
      tools: {},
      messages,
      extensions: [sqlitePersistence(d, chatId)],
    }),
  );

describe("persistence", () => {
  it("a second request continues the stored conversation", async () => {
    const d = db();
    await run(d, "c1", [user("u1", "hi")], "first");

    // The client sends only the new turn; the store supplies the history.
    await run(d, "c1", [user("u2", "again")], "second");

    const stored = loadMessages(d, "c1");
    expect(stored.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(JSON.stringify(stored)).toContain("first");
    expect(JSON.stringify(stored)).toContain("second");
  });

  it("a client replaying an old transcript does not duplicate it", async () => {
    const d = db();
    await run(d, "c1", [user("u1", "hi")]);
    const asClientSees = loadMessages(d, "c1");

    // A tab that reloaded and posts the whole thing back plus one new turn.
    await run(d, "c1", [...asClientSees, user("u2", "again")]);

    const stored = loadMessages(d, "c1");
    expect(stored.filter((m) => m.role === "user").map((m) => m.id)).toEqual(["u1", "u2"]);
  });

  it("chats are listed newest first", async () => {
    const d = db();
    await run(d, "a", [user("u1", "hi")]);
    await run(d, "b", [user("u2", "hi")]);
    expect(listChats(d).map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("an unknown chat reads as empty rather than throwing", () => {
    const d = db();
    migrate(d);
    expect(loadMessages(d, "nope")).toEqual([]);
  });
});

describe("the lease", () => {
  it("refuses a second concurrent run, before a single chunk is sent", async () => {
    const d = db();
    migrate(d);

    // Another worker is mid-run on this chat: it holds an unexpired lease.
    d.prepare(
      `INSERT INTO chats (id, messages, epoch, lease_owner, lease_until, updated_at)
         VALUES (?, '[]', 1, 'other-worker', ?, ?)`,
    ).run("c1", Date.now() + 30_000, Date.now());

    // The claim happens before the stream exists, so this rejects rather than
    // opening a stream that immediately apologises. A route answers 409 here.
    await expect(
      runAgentLoop({
        model: answers(),
        tools: {},
        messages: [user("u2", "hi")],
        extensions: [sqlitePersistence(d, "c1")],
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ExtensionFailedError && e.cause instanceof ChatBusyError,
    );
  });

  it("is released after a normal run, so the next request proceeds", async () => {
    const d = db();
    await run(d, "c1", [user("u1", "hi")]);
    const row = d.prepare(`SELECT lease_owner, lease_until FROM chats WHERE id = ?`).get("c1") as {
      lease_owner: string | null;
      lease_until: number | null;
    };
    expect(row.lease_owner).toBeNull();
    expect(row.lease_until).toBeNull();
    await expect(run(d, "c1", [user("u2", "again")])).resolves.toBeTruthy();
  });

  it("is released after a failed run, so the chat is not locked out", async () => {
    const d = db();
    migrate(d);
    await convertReadableStreamToArray(
      await runAgentLoop({
        model: answers(),
        tools: {},
        messages: [user("u1", "hi")],
        extensions: [sqlitePersistence(breakOn(d, "UPDATE chats SET messages"), "c1")],
      }),
    );
    // The `error` moment releases, so the next request is not blocked for a
    // whole lease period by a run that already died.
    await expect(run(d, "c1", [user("u2", "again")])).resolves.toBeTruthy();
  });
});

describe("fencing", () => {
  it("a superseded run stops instead of writing over a newer one", async () => {
    const d = db();
    await run(d, "c1", [user("u1", "hi")]);
    const before = loadMessages(d, "c1");

    const chunks = await convertReadableStreamToArray(
      await runAgentLoop({
        model: answers("should never be stored"),
        tools: {},
        messages: [user("u2", "hi")],
        extensions: [
          sqlitePersistence(d, "c1"),
          {
            name: "interleave",
            commands: [],
            hooks: {
              // Between the claim and the first step, another worker takes over.
              step_start: [
                () => {
                  d.prepare(
                    `UPDATE chats SET epoch = epoch + 1, lease_owner = 'other', lease_until = ? WHERE id = ?`,
                  ).run(Date.now() + 30_000, "c1");
                  return undefined;
                },
              ],
            },
          },
        ],
      }),
    );

    // The run stopped, the reason is in-band, and the newer state is intact.
    expect(chunks.some((c) => c.type === "error")).toBe(true);
    expect(JSON.stringify(chunks)).toContain("claimed by a newer run");
    expect(loadMessages(d, "c1")).toEqual(before);
  });
});

describe("failing closed", () => {
  it("a failed save stops the run rather than losing the step quietly", async () => {
    const d = db();
    migrate(d);

    const chunks = await convertReadableStreamToArray(
      await runAgentLoop({
        model: answers(),
        tools: {},
        messages: [user("u1", "hi")],
        extensions: [sqlitePersistence(breakOn(d, "UPDATE chats SET messages"), "c1")],
      }),
    );

    // This is the defect the `critical` flag exists for. Fail-open would have
    // reported to the console, returned no effect, and let the loop carry on
    // with every later step also unsaved.
    expect(chunks.some((c) => c.type === "error")).toBe(true);
    expect(JSON.stringify(chunks)).toContain("disk I/O error");
    expect(loadMessages(d, "c1")).toEqual([]);
  });

  it("a claim that throws never proceeds without a lease", async () => {
    const d = db();
    migrate(d);
    await expect(
      runAgentLoop({
        model: answers(),
        tools: {},
        messages: [user("u1", "hi")],
        extensions: [sqlitePersistence(breakOn(d, "epoch = epoch + 1"), "c1")],
      }),
    ).rejects.toBeInstanceOf(ExtensionFailedError);

    // Nothing ran, nothing was written, and no lease was left behind.
    expect(loadMessages(d, "c1")).toEqual([]);
    const row = d.prepare(`SELECT lease_owner FROM chats WHERE id = ?`).get("c1") as
      | { lease_owner: string | null }
      | undefined;
    expect(row?.lease_owner ?? null).toBeNull();
  });
});
