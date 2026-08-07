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
  splitFrontmatter,
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
/**
 * Live `read_file` returns a JSON envelope with every line of `content`
 * numbered — never the bare body. The store decodes it; returning the body
 * here would skip that path and let a broken decode pass the pipeline test.
 */
function readEnvelope(fileId: string, body: string): string {
  return JSON.stringify({
    file: { id: `file_${fileId}`, name: fileId.split("/").pop(), type: ".md", version: 1 },
    content: body
      .split("\n")
      .map((line, i) => `${i + 1}|${line}`)
      .join("\n"),
    totalLines: body.split("\n").length,
    rangeRequested: false,
  });
}

function fakeLoredex(opts?: {
  /** Reject every create/edit whose target path matches — a write-side outage. */
  failWritesTo?: RegExp;
}) {
  const files = new Map<string, string>();
  const ok = (text: string) => ({ content: [{ type: "text", text }] });
  const err = (text: string) => ({ content: [{ type: "text", text }], isError: true });
  const writeBlocked = (path: string) => opts?.failWritesTo?.test(path) ?? false;
  const tools: Record<string, unknown> = {
    loredex_read_file: {
      execute: async (i: { fileId: string }) =>
        files.has(i.fileId)
          ? ok(readEnvelope(i.fileId, files.get(i.fileId)!))
          : err(`not found: ${i.fileId}`),
    },
    loredex_create: {
      execute: async (i: Record<string, unknown>) => {
        const path = [i.type === "folder" ? i.parentId : i.folderId, i.name]
          .filter(Boolean)
          .join("/");
        if (i.type === "folder") return ok(`folder ${path}`);
        if (files.has(path)) return err(`already exists: ${path}`);
        if (writeBlocked(path)) return err(`write refused: ${path}`);
        // Live Loredex injects `summary` into the stored `.md` file's YAML
        // frontmatter, so the bytes on disk are not the content we passed.
        const content = String(i.content ?? "");
        files.set(
          path,
          String(i.name).endsWith(".md") && i.summary
            ? `---\nsummary: ${i.summary}\n---\n${content}`
            : content,
        );
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
        if (writeBlocked(i.fileId)) return err(`write refused: ${i.fileId}`);
        // Replacements run against the BODY alone — frontmatter is split off
        // first and reattached after. Matching the whole file here would let a
        // rewrite pass that live Loredex rejects on every consolidation.
        const { frontmatter, body } = splitFrontmatter(cur);
        let next = body;
        for (const r of i.replacements) {
          if (!next.includes(r.oldContent)) return err("oldContent not found");
          next = next.replace(r.oldContent, r.newContent);
        }
        files.set(i.fileId, frontmatter ? `${frontmatter}\n${next}` : next);
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

/**
 * Scripted model: call `toolName` once, then finish with text as soon as that
 * result is back — decided from the CONVERSATION, not a call counter.
 *
 * A counter couples every run to how many steps the previous ones took: reuse
 * the model across two sweep runs and any extra step (a retried write, which
 * the consolidator's instructions now ask for) shifts the parity so the next
 * run opens on the text branch and never calls the tool at all.
 */
function toolThenText(toolName: string, inputOf: () => unknown, done: string) {
  return new MockLanguageModelV3({
    doStream: async (options) => {
      // A tool result in the prompt means this run already made its call.
      // Matched on the serialized prompt so it survives message-shape changes.
      const alreadyCalled = JSON.stringify(options.prompt ?? null).includes("tool-result");
      return alreadyCalled
        ? { stream: textStream(done) }
        : { stream: toolCallStream(toolName, inputOf()) };
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
async function makeHarness(
  models: {
    coach?: MockLanguageModelV3;
    extractor: MockLanguageModelV3;
    consolidator?: MockLanguageModelV3;
  },
  loredex?: { failWritesTo?: RegExp },
) {
  const client = createClient({ url: ":memory:" });
  await migrate(client);
  const db = drizzle(client, { schema });
  const { registry, files } = fakeLoredex(loredex);

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
                // Mirrors the real agent: the sweep needs write outcomes to
                // tell "nothing to store" from "the store refused".
                onWriteAttempt: tc.onWriteAttempt,
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
              memory_write_index: memoryWriteIndexTool(bound, {
                onWriteAttempt: tc.onWriteAttempt,
              }),
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
    // Auto-extracted episodes carry the trust mark; explicit saves would not.
    expect(episode).toContain("status: unverified");

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

  // Both pin forms, since the candidate query has to carry both variants and a
  // half-done normalization would otherwise pass on the one that was covered.
  it.each(["org:coach", "user:coach"])(
    "extracts a %s chat into the agent's one canonical scope",
    async (pinnedRef) => {
      // A channel binding stores its pin verbatim, so `chats.agent` is pinned.
      // Two bugs met here: the candidate query matches that column exactly
      // against bare names, so the chat was never even a candidate; and `seg()`
      // turned the surviving `:` into a second scope root, so anything that DID
      // get written (an in-turn memory_save) landed in a store the web chat
      // could not see.
      const extractorModel = toolThenText(
        "memory_write_episode",
        () => ({
          slug: "channel-note",
          summary: "From a channel",
          facts: [{ text: "Races on trails", provenance: "user-said" }],
        }),
        "stored one episode",
      );
      const { files, memoryJobs, storage } = await makeHarness({ extractor: extractorModel });
      const scope = scopeRefOf({ agent: "coach", memory: MEM, userId: "user" })!;

      const chat = await storage.createChat(principal, { agent: pinnedRef });
      await storage.appendMessages(chat.id, [message("m1", "user", "I race on trails.")]);
      await storage.createRun(principal, { chatId: chat.id, agent: pinnedRef });

      const swept = await memorySweep({ now: Date.now() + 2 * HOUR });
      expect(swept.extractions).toBe(1);
      expect(swept.errors).toBe(0);

      // The episode lands under the BARE agent segment, not `org-coach-<hash>`.
      const episodePaths = Array.from(files.keys()).filter((p) => p.includes("/episodes/"));
      expect(episodePaths).toHaveLength(1);
      expect(episodePaths[0]!.startsWith(`${scope.root}/episodes/`)).toBe(true);
      expect(episodePaths[0]).not.toContain("-coach-");
      // The scope row the consolidation job keys off is the canonical one, and
      // it is FUNCTIONAL, not merely present: this sweep queued the episode
      // against it and consolidated it through (the harness's default
      // consolidator answers "no changes", which legitimately consumes the
      // episode — hence the watermark rather than a pendingEpisodes check).
      const state = await memoryJobs.scopeState(scope.key);
      expect(state?.agent).toBe("coach");
      expect(swept.consolidations).toBe(1);
      expect(state?.consolidationWatermark).toBe(episodePaths[0]!.split("/").pop());
      expect(state?.pendingEpisodes).toEqual([]);
      // The episode's own frontmatter names the agent without the pin.
      expect(files.get(episodePaths[0]!)).toContain("agent: coach");
    },
  );

  it("keeps episodes pending when the consolidator answers without writing", async () => {
    // The failure this pipeline used to lose memories to: memory_write_index
    // errors, the model gives up and still answers a tidy summary, and the
    // sweep — trusting the answer — consumed the pending episodes. Nothing was
    // ever folded into MEMORY.md and nothing was left to retry.
    const scope = scopeRefOf({ agent: "coach", memory: MEM, userId: "user" })!;
    const extractorModel = toolThenText(
      "memory_write_episode",
      () => ({
        slug: "wrist",
        summary: "Wrist inflammation",
        facts: [{ text: "Wrist inflamed after cycling", provenance: "user-said" }],
      }),
      "stored one episode",
    );
    const indexContent = [
      "# Memory — coach · u-user",
      "",
      "## Health",
      `- [m-3q7f4] (2026-08-06, user-said) Wrist inflamed after cycling. ← ${scope.root}/episodes/x.md`,
      "",
      "## Archive",
      "",
    ].join("\n");
    // Every run: attempt the write, then answer as if it had worked — the
    // give-up behaviour that used to be read as success.
    const consolidatorModel = toolThenText(
      "memory_write_index",
      () => ({ content: indexContent }),
      "folded 2 episodes in",
    );

    const outage: { failWritesTo?: RegExp } = { failWritesTo: /MEMORY\.md$/ };
    const { files, memoryJobs, storage } = await makeHarness(
      { extractor: extractorModel, consolidator: consolidatorModel },
      outage,
    );
    const chat = await storage.createChat(principal, { agent: "coach" });
    await storage.appendMessages(chat.id, [message("m1", "user", "My wrist hurts.")]);
    await storage.createRun(principal, { chatId: chat.id, agent: "coach" });

    const t1 = Date.now() + 2 * HOUR;
    const first = await memorySweep({ now: t1 });
    expect(first.extractions).toBe(1);
    // The run answered, but the write never landed: counted as a failure.
    expect(first.consolidations).toBe(0);
    expect(first.errors).toBe(1);
    expect(files.get(`${scope.root}/MEMORY.md`)).toBeUndefined();

    const episodePath = Array.from(files.keys()).find((p) =>
      p.startsWith(`${scope.root}/episodes/`),
    );
    expect(episodePath).toBeDefined();
    // The whole point: the episode is still queued, so it gets another chance.
    const afterFail = await memoryJobs.scopeState(scope.key);
    expect(afterFail?.pendingEpisodes).toEqual([episodePath]);
    expect(afterFail?.hasNew).toBe(true);
    expect(afterFail?.consolidationWatermark).toBeFalsy();
    // …on the escalating schedule, persisted: first failure = the base 2h.
    expect(afterFail?.failures).toBe(1);
    expect(afterFail?.nextEligibleAt).toBe(t1 + 2 * HOUR);

    // And the schedule is HONORED, not just recorded: a sweep inside the
    // backoff window must not re-run the consolidator on the same input.
    const tooSoon = await memorySweep({ now: t1 + 1 * HOUR });
    expect(tooSoon.consolidations).toBe(0);
    expect(tooSoon.errors).toBe(0);
    expect((await memoryJobs.scopeState(scope.key))?.failures).toBe(1);

    // Store recovers; past the backoff the same episode is folded in for real.
    outage.failWritesTo = undefined;
    const second = await memorySweep({ now: t1 + 3 * HOUR });
    expect(second.consolidations).toBe(1);
    expect(second.errors).toBe(0);
    expect(files.get(`${scope.root}/MEMORY.md`)).toContain("[m-3q7f4]");
    const afterRetry = await memoryJobs.scopeState(scope.key);
    expect(afterRetry?.pendingEpisodes).toEqual([]);
    expect(afterRetry?.hasNew).toBe(false);
  });
});
