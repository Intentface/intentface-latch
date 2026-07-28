import { createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { createRuntime, defineAgent, defineContext } from "@intentface/latch-core";
import type { AppMessage, ConnectionRegistry, OpenToolSet, Runtime } from "@intentface/latch-core";
import { createMemoryJobStore, createSqliteAdapter, migrate, schema } from "@intentface/latch-drizzle";
import {
  createLoredexStore,
  createMemoryProvider,
  memoryReadEpisodesTool,
  memoryReadIndexTool,
  memoryWriteEpisodeTool,
  memoryWriteIndexTool,
  scopeRefOf,
} from "@intentface/latch-memory";
import type { MemoryJobStore, MemoryStore } from "@intentface/latch-memory";
import type { Principal } from "../session";
import { asMemoryConsolidationContext, asMemoryExtractionContext } from "./turn-context";
import { memorySweep } from "./sweep";

/**
 * End-to-end memory pipeline against a fake Loredex connection and mock
 * models: chat → idle → extraction (episode file) → consolidation (MEMORY.md)
 * → next turn gets the compiled index injected + memory tools.
 *
 * The sweep resolves its services via `getLatch()`; the mock below hands it
 * this test's isolated runtime instead of the app composition root. The job
 * agents are test doubles with scripted models but the REAL scope-locked tool
 * bindings — the real agent files hardcode live Anthropic models.
 */

const state = vi.hoisted(() => ({
  latch: undefined as unknown as {
    runtime: Runtime<Principal>;
    agentStore: unknown;
    memoryJobs: MemoryJobStore;
    memoryStore: MemoryStore<Principal>;
  },
}));

vi.mock("../latch", () => ({
  getLatch: async () => state.latch,
  ownerTagOf: (p: Principal) =>
    (p.userId ? [p.orgId, p.userId] : [p.orgId]).map(encodeURIComponent).join("/"),
}));

// ---------- fake Loredex connection (in-memory file map, MCP-shaped) ----------
function fakeLoredex() {
  const files = new Map<string, string>();
  const ok = (text: string) => ({ content: [{ type: "text", text }] });
  const err = (text: string) => ({ content: [{ type: "text", text }], isError: true });
  const tools: Record<string, unknown> = {
    loredex_read_file: {
      execute: async (i: { fileId: string }) =>
        files.has(i.fileId) ? ok(files.get(i.fileId)!) : err(`not found: ${i.fileId}`),
    },
    loredex_create: {
      execute: async (i: Record<string, unknown>) => {
        const path = [i.type === "folder" ? i.parentId : i.folderId, i.name]
          .filter(Boolean)
          .join("/");
        if (i.type === "folder") return ok(`folder ${path}`);
        if (files.has(path)) return err(`already exists: ${path}`);
        files.set(path, String(i.content ?? ""));
        return ok(`created ${path}`);
      },
    },
    loredex_edit_file: {
      execute: async (i: {
        fileId: string;
        replacements: Array<{ oldContent: string; newContent: string }>;
      }) => {
        const cur = files.get(i.fileId);
        if (cur === undefined) return err("not found");
        let next = cur;
        for (const r of i.replacements) {
          if (!next.includes(r.oldContent)) return err("oldContent not found");
          next = next.replace(r.oldContent, r.newContent);
        }
        files.set(i.fileId, next);
        return ok("edited");
      },
    },
    loredex_search: {
      execute: async (i: { query: string; folderId?: string }) => {
        const hits = Array.from(files.entries())
          .filter(([p]) => !i.folderId || p.startsWith(i.folderId))
          .filter(([, text]) => text.toLowerCase().includes(i.query.toLowerCase()))
          .slice(0, 6)
          .map(([path, text]) => ({ path, snippet: text.slice(0, 200) }));
        return ok(JSON.stringify({ results: hits }));
      },
    },
  };
  const registry: ConnectionRegistry<Principal> = {
    hostFor: () => ({
      open: async (): Promise<OpenToolSet> => ({ tools, close: async () => {} }),
    }),
  };
  return { registry, files };
}

// ---------- scripted models ----------
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const streamFrom = (parts: unknown[]) =>
  new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.close();
    },
  });
const meta = { type: "response-metadata", id: "r", modelId: "mock", timestamp: new Date(0) };
const textStream = (text: string) =>
  streamFrom([
    { type: "stream-start", warnings: [] },
    meta,
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: "stop", usage },
  ]);
const toolCallStream = (toolName: string, input: unknown) =>
  streamFrom([
    { type: "stream-start", warnings: [] },
    meta,
    { type: "tool-call", toolCallId: "c1", toolName, input: JSON.stringify(input) },
    { type: "finish", finishReason: "tool-calls", usage },
  ]);

/** First call emits one tool call, second call finishes with text. */
function toolThenText(toolName: string, inputOf: () => unknown, done: string) {
  let calls = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      calls += 1;
      return calls === 1
        ? { stream: toolCallStream(toolName, inputOf()) }
        : { stream: textStream(done) };
    },
  });
}

const principal: Principal = { orgId: "org", userId: "user" } as Principal;
const MEM = { scope: "agent-user" as const, connection: "loredex" };

/**
 * Build the full isolated pipeline (db, fake Loredex, runtime with the coach
 * plus job-agent test doubles) and point the mocked `getLatch()` at it. The
 * job agents use scripted models but the REAL scope-locked tool bindings.
 */
async function makeHarness(models: {
  coach?: MockLanguageModelV3;
  extractor: MockLanguageModelV3;
  consolidator?: MockLanguageModelV3;
}) {
  const client = createClient({ url: ":memory:" });
  await migrate(client);
  const db = drizzle(client, { schema });
  const { registry, files } = fakeLoredex();

  const memoryJobs = createMemoryJobStore(db);
  const memoryStore = createLoredexStore<Principal>({ connections: registry });
  const memoryProvider = createMemoryProvider<Principal>({
    store: memoryStore,
    scopeOf: ({ principal: p, agent, memory }) => scopeRefOf({ agent, memory, userId: p.userId }),
    recordUsage: (k, ids) => memoryJobs.recordUsage(k, ids, Date.now()),
    cacheTtlMs: 0, // every turn re-reads — tests assert fresh injection
  });

  const coachModel =
    models.coach ??
    new MockLanguageModelV3({ doStream: async () => ({ stream: textStream("ok!") }) });
  const consolidatorModel =
    models.consolidator ??
    new MockLanguageModelV3({ doStream: async () => ({ stream: textStream("no changes") }) });

  const storage = createSqliteAdapter<Principal>(db, {
    owner: (p) => (p.userId ? [p.orgId, p.userId] : [p.orgId]),
  });
  const runtime = createRuntime<Principal, { orgId: string }>({
    storage,
    context: defineContext<Principal, { orgId: string }>({
      build: ({ principal: p }) => ({ orgId: p.orgId }),
    }),
    memory: memoryProvider,
    agents: {
      coach: defineAgent<Principal>({
        model: coachModel as never,
        instructions: "You are a running coach.",
        memory: MEM,
      }),
      // Test doubles for the job agents: scripted models, REAL tool bindings.
      "memory-extractor": defineAgent<Principal, { orgId: string }>(
        ({ principal: p, turnContext }) => {
          const tc = asMemoryExtractionContext(turnContext)!;
          const bound = { store: memoryStore, principal: p, scope: tc.scope };
          return {
            model: models.extractor as never,
            instructions: "extract",
            tools: {
              memory_read_index: memoryReadIndexTool(bound),
              memory_write_episode: memoryWriteEpisodeTool(bound, {
                agent: tc.targetAgent,
                chatId: tc.chatId,
                onEpisodeWritten: ({ path }) =>
                  memoryJobs.touchScope(
                    {
                      scopeKey: tc.scope.key,
                      owner: "org/user",
                      agent: tc.targetAgent,
                      connection: tc.scope.connection,
                      identity: p,
                      episodePath: path,
                    },
                    { cooldownMs: 0, now: Date.now() },
                  ),
              }),
            },
          };
        },
      ),
      "memory-consolidator": defineAgent<Principal, { orgId: string }>(
        ({ principal: p, turnContext }) => {
          const tc = asMemoryConsolidationContext(turnContext)!;
          const bound = { store: memoryStore, principal: p, scope: tc.scope };
          return {
            model: consolidatorModel as never,
            instructions: "consolidate",
            tools: {
              memory_read_index: memoryReadIndexTool(bound),
              memory_read_episodes: memoryReadEpisodesTool(bound),
              memory_write_index: memoryWriteIndexTool(bound),
            },
          };
        },
      ),
    },
  });

  // The sweep discovers "coach" as a UI agent whose record carries memory.
  state.latch = {
    runtime,
    memoryJobs,
    memoryStore,
    agentStore: {
      listMemoryEnabledNames: async () => ["coach"],
      getRecord: async (_p: Principal, name: string) =>
        name === "coach" ? { exec: { memory: MEM } } : undefined,
    },
  };
  return { db, files, memoryJobs, memoryStore, storage, runtime };
}

describe("memory pipeline (integration)", () => {
  it("extracts an idle chat, consolidates the index, and injects it next turn", async () => {
    // Capture what the coach model actually receives per call.
    const coachSeen: unknown[] = [];
    const coachModel = new MockLanguageModelV3({
      doStream: async (options) => {
        coachSeen.push(options);
        return { stream: textStream("ok!") };
      },
    });

    const extractorModel = toolThenText(
      "memory_write_episode",
      () => ({
        slug: "running-prefs",
        summary: "Running preferences",
        happened: "User talked about their routine.",
        facts: [{ text: "Prefers morning runs before work", provenance: "user-said" }],
      }),
      "stored one episode",
    );
    const scope = scopeRefOf({ agent: "coach", memory: MEM, userId: "user" })!;
    const consolidatorModel = toolThenText(
      "memory_write_index",
      () => ({
        content: [
          "# Memory — coach · u-user",
          "",
          "## Identity & preferences",
          `- [m-1a2b3c] (2026-07-27, user-said) Prefers morning runs before work. ← ${scope.root}/episodes/x.md`,
          "",
          "## Archive",
          "",
        ].join("\n"),
      }),
      "folded 1 episode in",
    );

    const { files, memoryJobs, runtime } = await makeHarness({
      coach: coachModel,
      extractor: extractorModel,
      consolidator: consolidatorModel,
    });

    // ---- turn 1: a normal chat (no memories yet) ----
    const res = await runtime.handleChat({
      agent: "coach",
      chatId: "chat_mem",
      principal,
      message: {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "I prefer running in the morning before work." }],
      } as never,
    });
    if (res.body) for await (const _ of res.body as unknown as AsyncIterable<unknown>) void _;

    const firstTurn = JSON.stringify(coachSeen[0]);
    expect(firstTurn).toContain("(no memories stored yet)");
    expect(firstTurn).toContain("memory_search");
    expect(firstTurn).toContain("memory_save");

    // ---- sweep (2h later): extraction + consolidation in one pass ----
    const swept = await memorySweep({ now: Date.now() + 2 * 3_600_000 });
    expect(swept.errors).toBe(0);
    expect(swept.extractions).toBe(1);
    expect(swept.consolidations).toBe(1);

    const episodePath = Array.from(files.keys()).find((p) =>
      p.startsWith(`${scope.root}/episodes/`),
    );
    expect(episodePath, "episode file written").toBeDefined();
    const episode = files.get(episodePath!)!;
    expect(episode).toContain("chat: chat_mem");
    expect(episode).toContain("agent: coach");
    expect(episode).toContain("(user-said) Prefers morning runs before work");

    const index = files.get(`${scope.root}/MEMORY.md`);
    expect(index, "compiled index written").toBeDefined();
    expect(index).toContain("[m-1a2b3c]");

    const scopeState = await memoryJobs.scopeState(scope.key);
    expect(scopeState?.hasNew).toBe(false);
    expect(scopeState?.pendingEpisodes).toEqual([]);
    expect(scopeState?.consolidationWatermark).toBe(episodePath!.split("/").pop());

    // A second sweep finds nothing new.
    const again = await memorySweep({ now: Date.now() + 3 * 3_600_000 });
    expect(again.extractions).toBe(0);
    expect(again.consolidations).toBe(0);

    // ---- turn 2: the compiled index is injected ----
    const res2 = await runtime.handleChat({
      agent: "coach",
      chatId: "chat_mem",
      principal,
      message: { id: "u2", role: "user", parts: [{ type: "text", text: "plan my week" }] } as never,
    });
    if (res2.body) for await (const _ of res2.body as unknown as AsyncIterable<unknown>) void _;

    const secondTurn = JSON.stringify(coachSeen.at(-1));
    expect(secondTurn).toContain("<memory>");
    expect(secondTurn).toContain("Prefers morning runs before work");
  });

  // ---- extraction idempotency (item: content-hash keys + tombstones) ----

  const HOUR = 3_600_000;
  const message = (id: string, role: "user" | "assistant", text: string): AppMessage =>
    ({
      id,
      role,
      parts: [{ type: "text", text }],
      metadata: { visibility: "user", createdAt: Date.now() },
    }) as AppMessage;

  /** One idle chat with a recorded run identity, ready for the sweep. */
  async function seedChat(storage: Awaited<ReturnType<typeof makeHarness>>["storage"]) {
    const chat = await storage.createChat(principal, { agent: "coach" });
    await storage.appendMessages(chat.id, [message("m1", "user", "I like green tea.")]);
    await storage.createRun(principal, { chatId: chat.id, agent: "coach" });
    return chat;
  }

  async function chatStateOf(db: Awaited<ReturnType<typeof makeHarness>>["db"], chatId: string) {
    const rows = await db
      .select()
      .from(schema.memoryChatState)
      .where(eq(schema.memoryChatState.chatId, chatId));
    return rows[0]!;
  }

  it("tombstones a zero-yield run and never re-extracts an unchanged window", async () => {
    let extractorCalls = 0;
    const extractorModel = new MockLanguageModelV3({
      // Completes without writing an episode — a paid run that found nothing.
      doStream: async () => {
        extractorCalls++;
        return { stream: textStream("nothing to store") };
      },
    });
    const { db, storage } = await makeHarness({ extractor: extractorModel });
    const chat = await seedChat(storage);

    const t1 = Date.now() + 2 * HOUR;
    const first = await memorySweep({ now: t1 });
    expect(first.extractions).toBe(1);
    expect(first.errors).toBe(0);
    expect(extractorCalls).toBe(1);

    // Zero memories extracted, but the run COMPLETED: key recorded (tombstone)
    // and the watermark advanced — this window is done.
    const afterFirst = await chatStateOf(db, chat.id);
    expect(afterFirst.lastExtractedKey).toMatch(/^x\d+:[0-9a-f]{16}$/);
    expect(afterFirst.lastExtractedSeq).toBe(0);

    // Simulate watermark loss (state reset/backfill): the chat becomes a
    // candidate again, but the unchanged content must not buy a second run.
    await db
      .update(schema.memoryChatState)
      .set({ lastExtractedSeq: -1, nextEligibleAt: 0 })
      .where(eq(schema.memoryChatState.chatId, chat.id));
    const second = await memorySweep({ now: t1 + 3 * HOUR });
    expect(second.extractions).toBe(0);
    expect(second.errors).toBe(0);
    expect(extractorCalls).toBe(1); // no second paid run
    const afterSecond = await chatStateOf(db, chat.id);
    expect(afterSecond.lastExtractedSeq).toBe(0); // advanced for free
    expect(afterSecond.lastExtractedKey).toBe(afterFirst.lastExtractedKey);

    // NEW material keys differently and pays for a fresh run.
    await storage.appendMessages(chat.id, [message("m2", "user", "Actually, oolong now.")]);
    const third = await memorySweep({ now: t1 + 6 * HOUR });
    expect(third.extractions).toBe(1);
    expect(extractorCalls).toBe(2);
    const afterThird = await chatStateOf(db, chat.id);
    expect(afterThird.lastExtractedSeq).toBe(1);
    expect(afterThird.lastExtractedKey).not.toBe(afterFirst.lastExtractedKey);
  });

  it("failed runs do not tombstone — the same window is retried after backoff", async () => {
    let extractorCalls = 0;
    const extractorModel = new MockLanguageModelV3({
      doStream: async () => {
        extractorCalls++;
        if (extractorCalls === 1) throw new Error("LLM down");
        return { stream: textStream("nothing to store") };
      },
    });
    const { db, storage } = await makeHarness({ extractor: extractorModel });
    const chat = await seedChat(storage);

    const t1 = Date.now() + 2 * HOUR;
    const first = await memorySweep({ now: t1 });
    expect(first.extractions).toBe(0);
    expect(first.errors).toBe(1);
    expect(extractorCalls).toBe(1);

    // Failure: no key, no watermark — the window stays retryable.
    const afterFail = await chatStateOf(db, chat.id);
    expect(afterFail.lastExtractedKey).toBeNull();
    expect(afterFail.lastExtractedSeq).toBe(-1);
    expect(afterFail.failures).toBe(1);

    // Past the failure backoff, the SAME content is retried (no tombstone).
    const second = await memorySweep({ now: t1 + 3 * HOUR });
    expect(second.extractions).toBe(1);
    expect(second.errors).toBe(0);
    expect(extractorCalls).toBe(2);
    const afterRetry = await chatStateOf(db, chat.id);
    expect(afterRetry.lastExtractedKey).toMatch(/^x\d+:[0-9a-f]{16}$/);
    expect(afterRetry.lastExtractedSeq).toBe(0);
    expect(afterRetry.failures).toBe(0);
  });
});
