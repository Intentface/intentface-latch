import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { AppMessage } from "@intentface/latch-core";
import { migratePostgres } from "./migrate.pg.js";
import { createPostgresAdapter } from "./adapter.pg.js";
import { createPostgresMemoryJobStore } from "./memory-job-store.pg.js";
import { memoryJobStoreSmoke } from "./memory-job-store.smoke.shared.js";
import { scheduleSmoke } from "./schedule.smoke.shared.js";
import { limitStoreSmoke } from "./limit-store.smoke.shared.js";
import { runLeaseSmoke } from "./run-lease.smoke.shared.js";
import { createPostgresLimitStore } from "./limit-store.pg.js";
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

  // A sub-thread remembers who spawned it — every later resolve reads it back.
  const sub = await store.createChat(me, { agent: "writer", kind: "internal", parentAgent: "support" });
  if ((await store.getChat(me, sub.id))?.parentAgent !== "support") throw new Error("parentAgent did not round-trip");
  if ((await store.getChat(me, chat.id))?.parentAgent !== undefined) throw new Error("a top-level chat has no parentAgent");

  // A run remembers how it was asked to run, so recovery resumes it the same way.
  const unattended = await store.createRun(me, { chatId: sub.id, agent: "writer", settings: { autoApprove: true, blockGated: "simulate-success", memory: false } });
  const back = await store.getRun(unattended.id);
  // Key order isn't preserved (Postgres jsonb reorders); the values are what count.
  const st = back?.settings;
  if (st?.autoApprove !== true || st.blockGated !== "simulate-success" || st.memory !== false || Object.keys(st).length !== 3)
    throw new Error(`run settings did not round-trip: ${JSON.stringify(st)}`);
  await store.updateRun(unattended.id, { status: "completed", endedAt: Date.now() });

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
  // Worth running on BOTH dialects — `delivery` is jsonb here and json-in-text
  // on sqlite, so a round trip is the only proof they agree.
  await scheduleSmoke({ store, me, other: { org: "org_b", user: "user_2" }, assert });

  // Memory job store: extraction/consolidation state machine + usage.
  await runLeaseSmoke({ store, principal: me, assert });
  await limitStoreSmoke({ limits: createPostgresLimitStore(db), assert });
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
