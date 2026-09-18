import { createClient } from "@libsql/client";
import { tool } from "ai";
import { z } from "zod";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import {
  createRuntime,
  defineAgent,
  defineContext,
  type AppMessage,
} from "@intentface/latch-core";
import { createSqliteAdapter, migrate } from "@intentface/latch-drizzle";
import { assert, latchDb, owner, type Principal } from "./setup.js";

/**
 * Subagent HITL (C-native): a gated tool INSIDE a subagent pauses, and the
 * approval bubbles up to the PARENT turn (`awaiting_input`) — no auto-approve,
 * no in-memory tokens. `applyApproval` on the parent routes the decision to the
 * sub thread, resumes the sub (the approved tool executes), folds the digest
 * back into the `spawn_agent` result, and resumes the parent.
 */

const step = (chunks: unknown[]) => ({
  stream: simulateReadableStream({ initialDelayInMs: 0, chunkDelayInMs: 0, chunks }),
});
const finish = (reason: string) => ({
  type: "finish",
  finishReason: { unified: reason, raw: reason },
  usage: { inputTokens: { total: 5 }, outputTokens: { total: 2 } },
});

/** Main agent: step 1 delegates via spawn_agent; later steps just emit text. */
function mainMock() {
  return new MockLanguageModelV4({
    modelId: "mock-main",
    doStream: [
      step([
        { type: "stream-start", warnings: [] },
        { type: "tool-input-start", id: "c1", toolName: "spawn_agent" },
        { type: "tool-input-delta", id: "c1", delta: '{"agent":"crm","prompt":"update the deal"}' },
        { type: "tool-input-end", id: "c1" },
        { type: "tool-call", toolCallId: "c1", toolName: "spawn_agent", input: '{"agent":"crm","prompt":"update the deal"}' },
        finish("tool-calls"),
      ]),
      step([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "0" },
        { type: "text-delta", id: "0", delta: "Requested your approval." },
        { type: "text-end", id: "0" },
        finish("stop"),
      ]),
      step([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "1" },
        { type: "text-delta", id: "1", delta: "Done — the deal was updated." },
        { type: "text-end", id: "1" },
        finish("stop"),
      ]),
    ] as never,
  });
}

/** CRM subagent: step 1 calls the gated write; after approval, emits a digest. */
function subMock() {
  return new MockLanguageModelV4({
    modelId: "mock-sub",
    doStream: [
      step([
        { type: "stream-start", warnings: [] },
        { type: "tool-input-start", id: "s1", toolName: "update_deal" },
        { type: "tool-input-delta", id: "s1", delta: '{"deal":"acme"}' },
        { type: "tool-input-end", id: "s1" },
        { type: "tool-call", toolCallId: "s1", toolName: "update_deal", input: '{"deal":"acme"}' },
        finish("tool-calls"),
      ]),
      step([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "0" },
        { type: "text-delta", id: "0", delta: "Updated deal acme." },
        { type: "text-end", id: "0" },
        finish("stop"),
      ]),
    ] as never,
  });
}

const scope: Principal = { orgId: "org_a", userId: "user_1" };

async function runScenario(approved: boolean) {
  const client = createClient({ url: ":memory:" });
  await migrate(client);
  const storage = createSqliteAdapter<Principal>(latchDb(client), { owner });
  const context = defineContext<Principal, { orgId: string }>({
    build: ({ principal }) => ({ orgId: principal.orgId }),
  });

  let execCount = 0;
  const update_deal = tool({
    description: "Update a CRM deal (sensitive write).",
    inputSchema: z.object({ deal: z.string() }),
    execute: async ({ deal }) => {
      execCount++;
      return { ok: true, deal };
    },
  });

  // Shared across turns so each mock's `doStream` advances (the factory runs
  // per turn — recreating the mock would reset it to step 1).
  const mainModel = mainMock();
  const subModel = subMock();
  const agents = {
    assistant: defineAgent<Principal, { orgId: string }>(() => ({
      model: mainModel,
      instructions: "Delegate CRM work to the crm subagent.",
      subagents: ["crm"],
    })),
    crm: defineAgent<Principal, { orgId: string }>(() => ({
      model: subModel,
      instructions: "Use update_deal for writes.",
      tools: { update_deal },
      toolApproval: { update_deal: "user-approval" },
    })),
  };
  const runtime = createRuntime<Principal, { orgId: string }>({ storage, context, agents });

  const chat = await storage.createChat(scope, { agent: "assistant" });
  const userMessage: AppMessage = {
    id: "msg_user_1",
    role: "user",
    parts: [{ type: "text", text: "update the acme deal" }],
    metadata: { visibility: "user", createdAt: Date.now() },
  };

  // Turn 1: main delegates → sub hits the gated write → bubbles up → parent pauses.
  await (await runtime.handleChat({ agent: "assistant", chatId: chat.id, principal: scope, message: userMessage })).text();
  await new Promise((r) => setTimeout(r, 50));

  const afterTurn1 = await storage.loadMessages(scope, chat.id);
  const dataPart = afterTurn1
    .flatMap((m) => m.parts ?? [])
    .find((p) => (p as { type?: string }).type === "data-subagent-approval") as
    | { data?: { approvalId: string } }
    | undefined;
  const approvalId = dataPart?.data?.approvalId;
  const execBefore = execCount;
  const parentStatuses = (await client.execute({
    sql: "SELECT status FROM latch_runs r JOIN latch_chats c ON r.chat_id=c.id WHERE c.id=?",
    args: [chat.id],
  })).rows.map((r) => String(r.status));

  if (!approvalId) {
    return { approvalId: undefined, execBefore, execAfter: execCount, parentStatuses, blob: "", client };
  }

  await (await runtime.applyApproval({ chatId: chat.id, principal: scope, decisions: [{ approvalId, approved }] })).text();
  await new Promise((r) => setTimeout(r, 50));

  const final = await storage.loadMessages(scope, chat.id);
  return { approvalId, execBefore, execAfter: execCount, parentStatuses, blob: JSON.stringify(final), client };
}

async function main() {
  // --- approve ---
  const a = await runScenario(true);
  assert(!!a.approvalId, "subagent's gated write bubbled up to the parent (data-subagent-approval part)");
  assert(a.execBefore === 0, "sub write did NOT execute before approval");
  assert(a.parentStatuses.includes("awaiting_input"), "PARENT run is awaiting_input while the sub write awaits approval");
  assert(a.execAfter === 1, "approved sub write executed exactly once");
  assert(a.blob.includes("Done — the deal was updated"), "parent resumed with its final answer after approval");

  // --- deny ---
  const d = await runScenario(false);
  assert(!!d.approvalId, "deny: still bubbled up");
  assert(d.execAfter === 0, "denied sub write NEVER executed");

  console.log("✅ subagent-approval smoke passed — sub gate bubbles to parent → approve-runs / deny-blocks");
}

main().catch((e) => {
  console.error("❌ subagent-approval smoke failed:", e);
  throw e;
});
