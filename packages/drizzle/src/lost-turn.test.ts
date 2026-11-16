import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { jsonSchema, simulateReadableStream, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createRuntime, defineAgent, defineContext, type AppMessage } from "@intentface/latch-core";
import { createSqliteAdapter } from "./adapter.js";
import { migrate } from "./migrate.js";
import * as schema from "./schema.js";

/**
 * LAT-57, as reported: with crash recovery on, a tool returned a value that
 * held a function, in the same step as a question for the user. The run ended
 * errored, the step was never stored, and the answer to the question got an
 * empty 200.
 */

type P = { orgId: string; userId: string };
const me: P = { orgId: "o1", userId: "u1" };
const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };

function askingModel() {
  let n = 0;
  return new MockLanguageModelV4({
    modelId: "mock",
    doStream: (async () => {
      const chunks: unknown[] =
        n++ === 0
          ? [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "c1", toolName: "work", input: "{}" },
              { type: "tool-call", toolCallId: "c2", toolName: "askUser", input: "{}" },
              { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage },
            ]
          : [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: "done" },
              { type: "text-end", id: "t" },
              { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
            ];
      return { stream: simulateReadableStream({ initialDelayInMs: 0, chunkDelayInMs: 0, chunks }) };
    }) as never,
  });
}

const chunksOf = async (res: Response) =>
  (await res.text())
    .split("\n\n")
    .filter((l) => l.startsWith("data: {"))
    .map((l) => JSON.parse(l.slice(6)) as { type: string; delta?: string; errorText?: string });

describe("a tool result holding a function, with crash recovery on", () => {
  it("is stored with its step, and the question asked beside it can be answered", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const storage = createSqliteAdapter<P>(drizzle(client, { schema }), { owner: (p) => [p.orgId, p.userId] });
    const runtime = createRuntime<P>({
      storage,
      durability: { enabled: true, heartbeatMs: 5, leaseTtlMs: 60_000 },
      context: defineContext<P, unknown>({ build: async () => ({}) }),
      agents: {
        a: defineAgent<P>({
          model: askingModel(),
          instructions: "Be brief.",
          tools: {
            work: tool({ description: "Work.", inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }), execute: (async () => ({ ok: true, close: () => 1 })) as never }),
            askUser: tool({ description: "Ask the user.", inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }) }),
          },
        }),
      },
    });
    const message = { id: "u1", role: "user", parts: [{ type: "text", text: "go" }], metadata: { visibility: "user" } } as AppMessage;
    const first = await chunksOf(await runtime.handleChat({ agent: "a", principal: me, chatId: "c1", message }));
    expect(first.filter((c) => c.type === "error")).toEqual([]);

    const runs = await storage.listRuns(me, { limit: 5, chatId: "c1" });
    expect(runs.map((r) => [r.status, r.error ?? null])).toEqual([["completed", null]]);
    const stored = (await storage.loadMessages(me, "c1")).at(-1)!;
    const tools = (stored.parts as Array<{ type: string; state?: string; output?: unknown }>).filter((p) => p.type.startsWith("tool-"));
    expect(tools.map((p) => [p.type, p.state, p.output])).toEqual([
      ["tool-work", "output-available", { ok: true }],
      ["tool-askUser", "input-available", undefined],
    ]);

    const answered = await runtime.applyToolResult({ chatId: "c1", principal: me, toolCallId: "c2", output: "yes" });
    expect((await chunksOf(answered)).filter((c) => c.type === "text-delta").map((c) => c.delta)).toEqual(["done"]);
  });
});
