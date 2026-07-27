import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { createRuntime, defineAgent, defineContext } from "@intentface/latch-core";
import type { ConnectionRegistry, OpenToolSet, Runtime } from "@intentface/latch-core";
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

describe("memory pipeline (integration)", () => {
  it("extracts an idle chat, consolidates the index, and injects it next turn", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const db = drizzle(client, { schema });
    const { registry, files } = fakeLoredex();

    const memoryJobs = createMemoryJobStore(db);
    const memoryStore = createLoredexStore<Principal>({ connections: registry });
    const memoryProvider = createMemoryProvider<Principal>({
      store: memoryStore,
      scopeOf: ({ principal: p, agent, memory }) =>
        scopeRefOf({ agent, memory, userId: p.userId }),
      recordUsage: (k, ids) => memoryJobs.recordUsage(k, ids, Date.now()),
      cacheTtlMs: 0, // every turn re-reads — the test asserts fresh injection
    });

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

    const runtime = createRuntime<Principal, { orgId: string }>({
      storage: createSqliteAdapter<Principal>(db, {
        owner: (p) => (p.userId ? [p.orgId, p.userId] : [p.orgId]),
      }),
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
              model: extractorModel as never,
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
});
