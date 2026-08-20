import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { AppMessage } from "@intentface/latch-core";
import { migratePostgres } from "./migrate.pg.js";
import { createPostgresAdapter } from "./adapter.pg.js";
import { createPostgresMemoryJobStore } from "./memory-job-store.pg.js";
import { memoryJobStoreSmoke } from "./memory-job-store.smoke.shared.js";
import { scheduleSmoke } from "./schedule.smoke.shared.js";
import * as schema from "./schema.pg.js";

/** Same checks as the SQLite smoke, against in-memory Postgres (PGlite, WASM). */
type P = { org: string; user?: string };

async function main() {
  const pg = new PGlite();
  const db = drizzle(pg, { schema });
  await migratePostgres(db);
  const store = createPostgresAdapter<P>(db, {
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
    "parts round-trip through jsonb",
  );

  const otherOrg = await store.loadMessages({ org: "org_b" }, chat.id);
  assert(otherOrg.length === 0, "owner isolation (org_b sees nothing)");

  const run = await store.createRun(me, { chatId: chat.id, agent: "support", kind: "turn" });
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

  // Schedules: the opaque delivery blob and the owner-fenced "run now" bump.
  // Worth running on BOTH dialects — `delivery` is jsonb here and json-in-text
  // on sqlite, so a round trip is the only proof they agree.
  await scheduleSmoke({ store, me, other: { org: "org_b", user: "user_2" }, assert });

  // Memory job store: extraction/consolidation state machine + usage.
  await memoryJobStoreSmoke({
    jobs: createPostgresMemoryJobStore(db),
    store,
    principal: me,
    assert,
  });

  console.log("✅ pg smoke passed — same StorageAdapter, Postgres dialect (PGlite)");
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

main().catch((e) => {
  console.error("❌ pg smoke failed:", e);
  throw e;
});
