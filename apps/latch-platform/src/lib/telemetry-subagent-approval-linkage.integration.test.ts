import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { createRuntime, defineAgent, defineContext } from "@intentface/latch-core";
import type { AppMessage, LatchTelemetry, Runtime, TelemetryRunMeta } from "@intentface/latch-core";
import { createSqliteAdapter, migrate, schema } from "@intentface/latch-drizzle";

/**
 * Regression: a subagent that PAUSES on a gated tool and then RESUMES after the
 * user approves must keep its telemetry linkage. Before the fix,
 * `resumeSubagentApproval` re-entered `buildTurn` without `parentRunId`/
 * `rootChatId`, so the resumed turn defaulted its root to the `sub_…` chat and
 * dropped the parent run — splitting the trace/session after the round-trip.
 */

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
    { type: "finish", finishReason: "stop", usage },
  ]);
const spawnStream = (input: unknown) =>
  streamFrom([
    { type: "stream-start", warnings: [] },
    { type: "response-metadata", id: "r", modelId: "mock", timestamp: new Date(0) },
    { type: "tool-call", toolCallId: "c1", toolName: "spawn_agent", input: JSON.stringify(input) },
    { type: "finish", finishReason: "tool-calls", usage },
  ]);
const gatedToolStream = () =>
  streamFrom([
    { type: "stream-start", warnings: [] },
    { type: "response-metadata", id: "r", modelId: "mock", timestamp: new Date(0) },
    { type: "tool-call", toolCallId: "g1", toolName: "gated_tool", input: JSON.stringify({}) },
    { type: "finish", finishReason: "tool-calls", usage },
  ]);

let parentCalls = 0;
const parentModel = new MockLanguageModelV3({
  doStream: async () => {
    parentCalls += 1;
    return parentCalls === 1
      ? { stream: spawnStream({ agent: "helper", prompt: "do a gated side job" }) }
      : { stream: textStream("done") };
  },
});
let helperCalls = 0;
const helperModel = new MockLanguageModelV3({
  doStream: async () => {
    helperCalls += 1;
    // Turn 1 → ask for the gated tool (pauses); turn 2 (after approval) → answer.
    return helperCalls === 1
      ? { stream: gatedToolStream() }
      : { stream: textStream("side job done") };
  },
});

async function drain(res: Response) {
  if (res.body) for await (const _ of res.body as unknown as AsyncIterable<unknown>) void _;
}

describe("subagent telemetry linkage across an approval resume", () => {
  it("keeps depth/parentRunId/rootChatId on the resumed sub-turn", async () => {
    const seen: TelemetryRunMeta<P>[] = [];
    const telemetry: LatchTelemetry<P> = {
      async withRunSpan(run, fn) {
        seen.push(run);
        return fn();
      },
    };
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const db = drizzle(client, { schema });
    const runtime: Runtime<P> = createRuntime<P, { orgId: string }>({
      storage: createSqliteAdapter<P>(db, { owner: (p) => [p.orgId, p.userId] }),
      context: defineContext<P, { orgId: string }>({ build: ({ principal: p }) => ({ orgId: p.orgId }) }),
      agents: {
        parent: defineAgent<P>({ model: parentModel as never, instructions: "x", subagents: ["helper"] }),
        helper: defineAgent<P>({
          model: helperModel as never,
          instructions: "x",
          tools: {
            gated_tool: tool({
              description: "a gated side effect",
              inputSchema: z.object({}),
              execute: async () => ({ ok: true }),
            }),
          },
          toolApproval: { gated_tool: "user-approval" },
        }),
      },
      telemetry,
    });

    const chatId = "chat_appr_link";
    // Turn 1: parent spawns helper → helper pauses on the gated tool → the
    // approval bubbles up and the parent turn ends awaiting_input.
    await drain(
      await runtime.handleChat({
        agent: "parent",
        chatId,
        principal,
        message: { id: "u1", role: "user", parts: [{ type: "text", text: "go" }] } as never,
      }),
    );

    // The bubbled decision id lives on the parent's data-subagent-approval part.
    const history = await runtime.loadHistory({ chatId, principal });
    const approvalId = history
      .flatMap((m: AppMessage) => (m.parts ?? []) as { type?: string; data?: { approvalId?: string } }[])
      .find((p) => p.type === "data-subagent-approval")?.data?.approvalId;
    expect(approvalId, "the subagent approval bubbled to the parent").toBeTruthy();

    const before = seen.length;
    // Approve → resumes the sub thread (helper turn 2) then continues the parent.
    await drain(
      await runtime.applyApproval({
        chatId,
        principal,
        decisions: [{ approvalId: approvalId!, approved: true }],
      }),
    );
    expect(helperCalls, "the helper resumed after approval").toBe(2);

    const top = seen.find((m) => m.depth === 0);
    expect(top, "a top-level turn was traced").toBeTruthy();

    // The RESUMED subagent turn — traced during applyApproval (after `before`).
    const resumedSub = seen.slice(before).find((m) => m.depth === 1);
    expect(resumedSub, "the resumed subagent turn was traced").toBeTruthy();

    // The whole point: it stays nested under the parent run + conversation,
    // instead of defaulting its root to its own sub_… chat.
    expect(resumedSub!.rootChatId).toBe(chatId);
    expect(resumedSub!.parentRunId).toBe(top!.runId);
    expect(resumedSub!.chatId).toMatch(/^sub_/);

    // And every subagent turn (initial + resumed) shares that linkage.
    for (const sub of seen.filter((m) => m.depth === 1)) {
      expect(sub.rootChatId).toBe(chatId);
      expect(sub.parentRunId).toBe(top!.runId);
    }
  });
});
