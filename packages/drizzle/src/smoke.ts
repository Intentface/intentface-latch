import { createClient } from "@libsql/client";
import type { AppMessage } from "@intentface/latch-core";
import { migrate } from "./migrate.js";
import { createSqliteAdapter } from "./adapter.js";

/** A real run against an in-memory libsql DB: persistence + tenant isolation + run/usage. */
async function main() {
  const client = createClient({ url: ":memory:" });
  await migrate(client);
  const store = createSqliteAdapter(client);

  const chat = await store.createChat({
    orgId: "org_a",
    userId: "user_1",
    agent: "support",
  });

  const userMsg: AppMessage = {
    id: "msg_1",
    role: "user",
    parts: [{ type: "text", text: "hello" }],
    metadata: { visibility: "user", createdAt: Date.now() },
  };
  const asstMsg: AppMessage = {
    id: "msg_2",
    role: "assistant",
    parts: [{ type: "text", text: "hi!" }],
    metadata: {
      visibility: "user",
      model: "mock",
      usage: { inputTokens: 5, outputTokens: 3 },
    },
  };
  await store.appendMessages(chat.id, [userMsg, asstMsg]);

  const loaded = await store.loadMessages(
    { orgId: "org_a", userId: "user_1" },
    chat.id,
  );
  assert(loaded.length === 2, "loads 2 messages");
  assert(
    loaded[0]!.id === "msg_1" && loaded[1]!.id === "msg_2",
    "ordered by seq",
  );
  assert(
    (loaded[1]!.parts[0] as { type: "text"; text: string }).text === "hi!",
    "parts round-trip through JSON",
  );

  // Tenant isolation: a different org cannot read org_a's chat.
  const otherOrg = await store.loadMessages({ orgId: "org_b" }, chat.id);
  assert(otherOrg.length === 0, "tenant isolation (org_b sees nothing)");

  // Run + usage.
  const run = await store.createRun({ chatId: chat.id, agent: "support" });
  await store.updateRun(run.id, {
    status: "completed",
    usageInputTokens: 5,
    usageOutputTokens: 3,
    endedAt: Date.now(),
  });
  await store.recordUsage({
    orgId: "org_a",
    userId: "user_1",
    runId: run.id,
    model: "mock",
    inputTokens: 5,
    outputTokens: 3,
    cost: 0.0001,
  });
  const gotRun = await store.getRun(run.id);
  assert(gotRun?.status === "completed", "run updated to completed");

  console.log(
    "✅ smoke passed — persistence + tenant isolation + run/usage all work",
  );
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

main().catch((e) => {
  console.error("❌ smoke failed:", e);
  throw e; // unhandled rejection → non-zero exit
});
