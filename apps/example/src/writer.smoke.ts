import { createClient } from "@libsql/client";
import { tool } from "ai";
import { z } from "zod";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import {
  createRuntime,
  defineAgent,
  defineContext,
  type AppMessage,
  type Principal,
} from "@intentface/latch-core";
import { createSqliteAdapter, migrate } from "@intentface/latch-drizzle";
import { assert } from "./setup.js";

/**
 * The writer is exposed to tools via `toolsContext` → a tool reads
 * `context.writer` and streams custom data parts. Persistent parts land on the
 * assistant message (and would render on reload); transient parts reach the
 * client live but are NOT persisted.
 */
function toolThenText() {
  const step = (chunks: unknown[]) => ({
    stream: simulateReadableStream({ initialDelayInMs: 0, chunkDelayInMs: 0, chunks }),
  });
  return new MockLanguageModelV4({
    modelId: "mock-writer",
    doStream: [
      step([
        { type: "stream-start", warnings: [] },
        { type: "tool-input-start", id: "c1", toolName: "annotate" },
        { type: "tool-input-delta", id: "c1", delta: "{}" },
        { type: "tool-input-end", id: "c1" },
        { type: "tool-call", toolCallId: "c1", toolName: "annotate", input: "{}" },
        { type: "finish", finishReason: "tool-calls", usage: { inputTokens: { total: 4 }, outputTokens: { total: 2 } } },
      ]),
      step([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "0" },
        { type: "text-delta", id: "0", delta: "annotated." },
        { type: "text-end", id: "0" },
        { type: "finish", finishReason: "stop", usage: { inputTokens: { total: 5 }, outputTokens: { total: 3 } } },
      ]),
    ] as never,
  });
}

async function main() {
  const client = createClient({ url: ":memory:" });
  await migrate(client);
  const storage = createSqliteAdapter(client);
  const context = defineContext<{ orgId: string }>({ build: ({ principal }) => ({ orgId: principal.orgId }) });

  // What the tool observed from its context — proves user + run + writer all arrive.
  let seen: { orgId?: unknown; runId?: unknown; hasWriter?: boolean } = {};

  // A tool that streams data parts via the writer it gets from tool context.
  const annotate = tool({
    description: "Attach a note to the response.",
    inputSchema: z.object({}),
    execute: async (_input, opts) => {
      const ctx = (opts as {
        context?: {
          orgId?: unknown;
          principal?: { orgId?: unknown };
          run?: { id?: unknown };
          writer?: { write: (p: unknown) => void };
        };
      }).context;
      seen = {
        orgId: ctx?.orgId ?? ctx?.principal?.orgId,
        runId: ctx?.run?.id,
        hasWriter: typeof ctx?.writer?.write === "function",
      };
      ctx?.writer?.write({ type: "data-note", id: "n1", data: { note: "from-tool" } }); // persistent
      ctx?.writer?.write({ type: "data-status", data: { s: "working" }, transient: true }); // ephemeral
      return { ok: true };
    },
  });

  const agents = {
    noted: defineAgent<{ orgId: string }>(() => ({
      model: toolThenText(),
      instructions: "Use the annotate tool.",
      tools: { annotate },
    })),
  };
  const runtime = createRuntime({ storage, context, agents });

  const principal: Principal = { orgId: "org_a", userId: "u1" };
  const chat = await storage.createChat({ orgId: "org_a", userId: "u1", agent: "noted" });
  const userMessage: AppMessage = {
    id: "m1",
    role: "user",
    parts: [{ type: "text", text: "annotate this" }],
    metadata: { visibility: "user", createdAt: Date.now() },
  };
  await (await runtime.handleChat({ agent: "noted", chatId: chat.id, principal, message: userMessage })).text();
  await new Promise((r) => setTimeout(r, 50));

  const loaded = await storage.loadMessages({ orgId: "org_a", userId: "u1" }, chat.id);
  const parts = (loaded.find((m) => m.role === "assistant")?.parts ?? []) as { type: string; data?: { note?: string } }[];
  const types = parts.map((p) => p.type);

  const note = parts.find((p) => p.type === "data-note");
  assert(!!note, `tool's persistent data part is on the message (parts: ${types.join(", ")})`);
  assert(note?.data?.note === "from-tool", "persistent data part carries the tool's payload");
  assert(!types.includes("data-status"), "transient data part was NOT persisted");
  assert(types.includes("text"), "the model's own text is still there");

  // the tool also received user + run context (not just the writer)
  assert(seen.hasWriter === true, "tool received the writer via context");
  assert(seen.orgId === "org_a", `tool received user context (orgId, got ${String(seen.orgId)})`);
  assert(typeof seen.runId === "string" && seen.runId.length > 0, "tool received run context (run.id)");

  console.log("✅ writer smoke passed — tool got writer + user + run context; persistent kept, transient dropped");
}

main().catch((e) => {
  console.error("❌ writer smoke failed:", e);
  throw e;
});
