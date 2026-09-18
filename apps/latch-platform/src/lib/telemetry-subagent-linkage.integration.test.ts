import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createRuntime, defineAgent, defineContext } from "@intentface/latch-core";
import type { LatchTelemetry, TelemetryRunMeta } from "@intentface/latch-core";
import { createSqliteAdapter, migrate, schema } from "@intentface/latch-drizzle";

type P = { orgId: string; userId: string };
const principal: P = { orgId: "org", userId: "user" };

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const streamFrom = (parts: unknown[]) =>
  new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } });
const textStream = (text: string) =>
  streamFrom([
    { type: "stream-start", warnings: [] },
    { type: "response-metadata", id: "r", modelId: "mock", timestamp: new Date(0) },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
  ]);
const spawnStream = (input: unknown) =>
  streamFrom([
    { type: "stream-start", warnings: [] },
    { type: "response-metadata", id: "r", modelId: "mock", timestamp: new Date(0) },
    { type: "tool-call", toolCallId: "c1", toolName: "spawn_agent", input: JSON.stringify(input) },
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage },
  ]);

let parentCalls = 0;
const parentModel = new MockLanguageModelV3({
  doStream: async () => {
    parentCalls += 1;
    return parentCalls === 1
      ? { stream: spawnStream({ agent: "helper", prompt: "do a side job" }) }
      : { stream: textStream("done") };
  },
});
const helperModel = new MockLanguageModelV3({ doStream: async () => ({ stream: textStream("side job done") }) });

describe("subagent telemetry linkage", () => {
  it("threads depth / parentRunId / rootChatId into telemetry metas", async () => {
    const seen: TelemetryRunMeta<P>[] = [];
    const telemetry: LatchTelemetry<P> = {
      // Capture the meta the runtime builds for each turn (top-level + subagent).
      async withRunSpan(run, fn) {
        seen.push(run);
        return fn();
      },
    };
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const db = drizzle(client, { schema });
    const runtime = createRuntime<P, { orgId: string }>({
      storage: createSqliteAdapter<P>(db, { owner: (p) => [p.orgId, p.userId] }),
      context: defineContext<P, { orgId: string }>({ build: ({ principal: p }) => ({ orgId: p.orgId }) }),
      agents: {
        parent: defineAgent<P>({ model: parentModel as never, instructions: "x", subagents: ["helper"] }),
        helper: defineAgent<P>({ model: helperModel as never, instructions: "x" }),
      },
      telemetry,
    });

    const chatId = "chat_link";
    const res = await runtime.handleChat({
      agent: "parent",
      chatId,
      principal,
      message: { id: "u1", role: "user", parts: [{ type: "text", text: "go" }] } as never,
    });
    if (res.body) for await (const _ of res.body as unknown as AsyncIterable<unknown>) void _;

    const top = seen.find((m) => m.depth === 0);
    const sub = seen.find((m) => m.depth === 1);
    expect(top, "a top-level turn was traced").toBeTruthy();
    expect(sub, "a subagent turn was traced").toBeTruthy();

    // Top-level: its own root, no parent.
    expect(top!.parentRunId).toBeUndefined();
    expect(top!.rootChatId).toBe(chatId);

    // Subagent: nested under the parent run, sharing the parent conversation as root.
    expect(sub!.parentRunId).toBe(top!.runId);
    expect(sub!.rootChatId).toBe(chatId);
    expect(sub!.chatId).toMatch(/^sub_/); // its own thread differs from the root
  });
});
