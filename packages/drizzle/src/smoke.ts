import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import type { AppMessage } from "@intentface/latch-core";
import { migrate } from "./migrate.js";
import { createSqliteAdapter } from "./adapter.js";
import { createMemoryJobStore } from "./memory-job-store.js";
import { memoryJobStoreSmoke } from "./memory-job-store.smoke.shared.js";
import * as schema from "./schema.js";

/** A real run against an in-memory libsql DB: persistence + owner isolation + run/usage. */
type P = { org: string; user?: string };

async function main() {
  const client = createClient({ url: ":memory:" });
  await migrate(client);
  const store = createSqliteAdapter<P>(drizzle(client, { schema }), {
    owner: (p) => (p.user ? [p.org, p.user] : [p.org]),
  });

  const me: P = { org: "org_a", user: "user_1" };
  const chat = await store.createChat(me, { agent: "support" });

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

  const loaded = await store.loadMessages(me, chat.id);
  assert(loaded.length === 2, "loads 2 messages");
  assert(
    loaded[0]!.id === "msg_1" && loaded[1]!.id === "msg_2",
    "ordered by seq",
  );
  assert(
    (loaded[1]!.parts[0] as { type: "text"; text: string }).text === "hi!",
    "parts round-trip through JSON",
  );

  // Owner isolation: a different tenant cannot read org_a's chat.
  const otherOrg = await store.loadMessages({ org: "org_b" }, chat.id);
  assert(otherOrg.length === 0, "owner isolation (org_b sees nothing)");

  // Run + identity + usage.
  const run = await store.createRun(me, { chatId: chat.id, agent: "support" });
  assert(
    JSON.stringify(run.identity) === JSON.stringify(me),
    "run stores the identity blob (for resume)",
  );
  await store.updateRun(run.id, {
    status: "completed",
    usageInputTokens: 5,
    usageOutputTokens: 3,
    endedAt: Date.now(),
  });
  await store.recordUsage(me, {
    runId: run.id,
    model: "mock",
    inputTokens: 5,
    outputTokens: 3,
    cost: 0.0001,
  });
  const gotRun = await store.getRun(run.id);
  assert(gotRun?.status === "completed", "run updated to completed");

  // Memory job store: extraction/consolidation state machine + usage.
  await memoryJobStoreSmoke({
    jobs: createMemoryJobStore(drizzle(client, { schema })),
    store,
    principal: me,
    assert,
  });

  console.log(
    "✅ smoke passed — persistence + owner isolation + run/identity/usage + memory jobs all work",
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
