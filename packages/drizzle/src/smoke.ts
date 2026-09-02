import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import type { AppMessage } from "@intentface/latch-core";
import { migrate } from "./migrate.js";
import { createSqliteAdapter } from "./adapter.js";
import { createMemoryJobStore } from "./memory-job-store.js";
import { memoryJobStoreSmoke } from "./memory-job-store.smoke.shared.js";
import { scheduleSmoke } from "./schedule.smoke.shared.js";
import { limitStoreSmoke } from "./limit-store.smoke.shared.js";
import { runLeaseSmoke } from "./run-lease.smoke.shared.js";
import { createSqliteLimitStore } from "./limit-store.js";
import * as schema from "./schema.js";

/** A real run against an in-memory libsql DB: persistence + owner isolation + run/usage. */
type P = { org: string; user?: string };

async function main() {
  const client = createClient({ url: ":memory:" });
  await migrate(client);
  const db = drizzle(client, { schema });
  const store = createSqliteAdapter<P>(db, {
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
  const run = await store.createRun(me, { chatId: chat.id, agent: "support", kind: "turn" });
  assert(
    JSON.stringify(run.identity) === JSON.stringify(me),
    "run stores the identity blob (for resume)",
  );
  await store.updateRun(run.id, {
    status: "completed",
    usageInputTokens: 5,
    usageOutputTokens: 3,
    toolsHash: "cafebabecafebabe",
    endedAt: Date.now(),
  });
  await store.recordUsage(me, {
    runId: run.id,
    model: "mock",
    inputTokens: 5,
    outputTokens: 3,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
    cost: 0.0001,
  });
  const gotRun = await store.getRun(run.id);
  assert(gotRun?.status === "completed", "run updated to completed");
  assert(gotRun?.kind === "turn", "run kind persisted");
  assert(gotRun?.toolsHash === "cafebabecafebabe", "run toolsHash persisted");

  // listChats projects the LATEST run's status onto each chat (lastRunStatus).
  const listed = await store.listChats(me);
  assert(
    listed[0]?.lastRunStatus === "completed",
    "listChats projects the latest run's status",
  );
  // A strictly later startedAt — "latest" must not tie with the first run.
  await new Promise((r) => setTimeout(r, 2));
  const parked = await store.createRun(me, { chatId: chat.id, agent: "support", kind: "turn" });
  await store.updateRun(parked.id, { status: "awaiting_input" });
  const listedParked = await store.listChats(me);
  assert(
    listedParked[0]?.lastRunStatus === "awaiting_input",
    "a parked latest run surfaces awaiting_input on the chat list",
  );
  // Equal startedAt (ms precision can tie): the id-desc tie-break must pick
  // the same row on every read and on both dialects.
  const tieAt = Date.now() + 60_000;
  await db.insert(schema.runs).values([
    { id: "run_tie_a", chatId: chat.id, agent: "support", status: "completed", startedAt: tieAt },
    { id: "run_tie_b", chatId: chat.id, agent: "support", status: "errored", startedAt: tieAt },
  ]);
  const listedTied = await store.listChats(me);
  assert(
    listedTied[0]?.lastRunStatus === "errored",
    "started_at ties break deterministically by id desc",
  );

  // Schedules: the opaque delivery blob and the owner-fenced "run now" bump.
  await scheduleSmoke({ store, me, other: { org: "org_b", user: "user_2" }, assert });

  // Memory job store: extraction/consolidation state machine + usage.
  await runLeaseSmoke({ store, principal: me, assert });
  await limitStoreSmoke({ limits: createSqliteLimitStore(db), assert });
  await memoryJobStoreSmoke({
    jobs: createMemoryJobStore(db),
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
