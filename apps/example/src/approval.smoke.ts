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
 * HITL tool approval — no suspension machinery, just message round-trips.
 * A gated tool ends turn 1 with an `approval-requested` part (the tool does NOT
 * run; the run is `awaiting_input`). `applyApproval` records the decision and
 * continues: approved → the tool executes; denied → it never runs.
 */

/** Shared 2-step mock: step 1 proposes the gated tool; step 2 (post-decision) answers. */
function approvalMock() {
  const step = (chunks: unknown[]) => ({
    stream: simulateReadableStream({ initialDelayInMs: 0, chunkDelayInMs: 0, chunks }),
  });
  return new MockLanguageModelV4({
    modelId: "mock-approval",
    doStream: [
      step([
        { type: "stream-start", warnings: [] },
        { type: "tool-input-start", id: "call_1", toolName: "dangerousAction" },
        { type: "tool-input-delta", id: "call_1", delta: '{"target":"data"}' },
        { type: "tool-input-end", id: "call_1" },
        { type: "tool-call", toolCallId: "call_1", toolName: "dangerousAction", input: '{"target":"data"}' },
        { type: "finish", finishReason: "tool-calls", usage: { inputTokens: { total: 5 }, outputTokens: { total: 2 } } },
      ]),
      step([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "0" },
        { type: "text-delta", id: "0", delta: "Done." },
        { type: "text-end", id: "0" },
        { type: "finish", finishReason: "stop", usage: { inputTokens: { total: 6 }, outputTokens: { total: 3 } } },
      ]),
    ] as never,
  });
}

const scope = { orgId: "org_a", userId: "user_1" };
const principal: Principal = scope;

async function runScenario(approved: boolean) {
  const client = createClient({ url: ":memory:" });
  await migrate(client);
  const storage = createSqliteAdapter(client);
  const context = defineContext<{ orgId: string }>({ build: ({ principal }) => ({ orgId: principal.orgId }) });

  let execCount = 0;
  const dangerousAction = tool({
    description: "A sensitive action that must be approved.",
    inputSchema: z.object({ target: z.string() }),
    execute: async ({ target }) => {
      execCount++;
      return { ok: true, target: target.toUpperCase() };
    },
  });
  const model = approvalMock(); // shared across both turns → doStream advances
  const agents = {
    guarded: defineAgent<{ orgId: string }>(() => ({
      model,
      instructions: "Use tools when asked.",
      tools: { dangerousAction },
      toolApproval: { dangerousAction: "user-approval" },
    })),
  };
  const runtime = createRuntime({ storage, context, agents });

  const chat = await storage.createChat({ orgId: "org_a", userId: "user_1", agent: "guarded" });
  const userMessage: AppMessage = {
    id: "msg_user_1",
    role: "user",
    parts: [{ type: "text", text: "do the dangerous thing" }],
    metadata: { visibility: "user", createdAt: Date.now() },
  };

  // Turn 1: should pause for approval (tool NOT executed).
  await (await runtime.handleChat({ agent: "guarded", chatId: chat.id, principal, message: userMessage })).text();
  await new Promise((r) => setTimeout(r, 50));

  const afterTurn1 = await storage.loadMessages(scope, chat.id);
  const part = (afterTurn1.find((m) => m.role === "assistant")?.parts ?? []).find(
    (p) => (p as { state?: string }).state === "approval-requested",
  ) as { approval?: { id: string } } | undefined;
  const approvalId = part?.approval?.id;
  const execBefore = execCount;
  const statuses = (await client.execute("SELECT status FROM latch_runs")).rows.map((r) => String(r.status));

  // Decision → continue.
  if (!approvalId) throw new Error("no approval request was produced");
  await (
    await runtime.applyApproval({ chatId: chat.id, principal, decisions: [{ approvalId, approved }] })
  ).text();
  await new Promise((r) => setTimeout(r, 50));

  const final = await storage.loadMessages(scope, chat.id);
  return { approvalId, execBefore, execAfter: execCount, statuses, blob: JSON.stringify(final), client };
}

async function main() {
  // --- approve ---
  const a = await runScenario(true);
  assert(!!a.approvalId, "gated tool produced an approval request");
  assert(a.execBefore === 0, "tool did NOT execute before approval");
  assert(a.statuses.includes("awaiting_input"), "paused run marked awaiting_input (reaper leaves it alone)");
  assert(a.execAfter === 1, "approved tool executed exactly once");
  assert(a.blob.includes("DATA"), "executed tool's result persisted (target uppercased)");
  const aRuns = (await a.client.execute("SELECT status FROM latch_runs WHERE status='completed'")).rows.length;
  assert(aRuns >= 1, "continuation run completed");

  // --- deny ---
  const d = await runScenario(false);
  assert(d.execBefore === 0, "tool did NOT execute before decision (deny case)");
  assert(d.execAfter === 0, "denied tool NEVER executed");

  console.log("✅ approval smoke passed — gate → await → approve-runs / deny-blocks (message round-trip)");
}

main().catch((e) => {
  console.error("❌ approval smoke failed:", e);
  throw e;
});
