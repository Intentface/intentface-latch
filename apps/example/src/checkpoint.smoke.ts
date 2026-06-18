import { createClient } from "@libsql/client";
import {
  createRuntime,
  defineAgent,
  defineContext,
  type AppMessage,
  type Principal,
  type StorageAdapter,
} from "@intentface/latch-core";
import { createSqliteAdapter, migrate } from "@intentface/latch-drizzle";
import { assert, toolCallMock } from "./setup.js";
import { tools } from "./tools.js";

/**
 * Per-step checkpointing: with durability on, the UI-stream `onStepEnd` hook
 * persists the in-progress assistant message after each step — so a crash
 * mid-turn leaves completed tool results on the row. We prove the *mechanism*:
 * a durable 2-step tool turn writes the assistant message multiple times
 * (checkpoints + final); a T1 turn writes it once (final only).
 *
 * (A mock can't prove the model skips a checkpointed tool call on resume — that
 * needs a real model reading history. This verifies the persistence behaviour.)
 */
async function countAssistantAppends(durable: boolean): Promise<number> {
  const client = createClient({ url: ":memory:" });
  await migrate(client);
  const base = createSqliteAdapter(client);

  // Spy: count appendMessages calls that include an assistant message.
  let assistantAppends = 0;
  const storage: StorageAdapter = {
    ...base,
    appendMessages: (chatId, msgs) => {
      if (msgs.some((m) => m.role === "assistant")) assistantAppends++;
      return base.appendMessages(chatId, msgs);
    },
  };

  const context = defineContext<{ orgId: string }>({
    build: ({ principal }) => ({ orgId: principal.orgId }),
  });
  const agents = {
    clock: defineAgent<{ orgId: string }>(() => ({
      model: toolCallMock(),
      instructions: "Call getCurrentTime for the time.",
      tools,
    })),
  };
  const runtime = createRuntime({
    storage,
    context,
    agents,
    durability: durable ? { enabled: true } : undefined,
  });

  const principal: Principal = { orgId: "org_a", userId: "user_1" };
  const chat = await storage.createChat({ orgId: "org_a", userId: "user_1", agent: "clock" });
  const userMessage: AppMessage = {
    id: "msg_user_1",
    role: "user",
    parts: [{ type: "text", text: "What time is it in Tokyo?" }],
    metadata: { visibility: "user", createdAt: Date.now() },
  };
  await (
    await runtime.handleChat({ agent: "clock", chatId: chat.id, principal, message: userMessage })
  ).text();
  await new Promise((r) => setTimeout(r, 50));
  return assistantAppends;
}

async function main() {
  const durable = await countAssistantAppends(true);
  const t1 = await countAssistantAppends(false);

  // T1: assistant persisted once (onFinish only).
  assert(t1 === 1, `T1 writes the assistant message once (got ${t1})`);
  // Durable: per-step checkpoints (2 steps) + final → strictly more writes.
  assert(
    durable >= 2,
    `durable turn checkpoints the assistant message per step (got ${durable})`,
  );
  assert(durable > t1, `durable checkpoints more than T1 (${durable} > ${t1})`);

  console.log(
    `✅ checkpoint smoke passed — per-step persistence on (durable=${durable} vs T1=${t1} assistant writes)`,
  );
}

main().catch((e) => {
  console.error("❌ checkpoint smoke failed:", e);
  throw e;
});
