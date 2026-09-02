import type { AppMessage } from "@intentface/latch-core";
import { assert, makeDurableRuntime, type Principal } from "./setup.js";

/**
 * T2 durability primitives, end to end:
 *  - claimRun takes a single-writer lease (owner + fencingToken).
 *  - heartbeatRun extends it for the owner; a non-owner can't.
 *  - tick() (the reaper) reclaims a run whose lease expired: errored, owner
 *    cleared, fencing token bumped — and a stale owner's guarded write no-ops.
 *  - a normal durable turn still completes through handleChat.
 */
async function main() {
  const { runtime, storage, client } = await makeDurableRuntime();

  // --- claim + heartbeat -------------------------------------------------
  const run = await storage.claimRun({
    principal: { orgId: "t" },
    chatId: "c1",
    agent: "echo",
    owner: "node_A",
    ttlMs: 30_000,
  });
  assert(run.status === "active", "claimed run is active");
  assert(run.leaseOwner === "node_A", "lease owned by claimant");
  assert(run.fencingToken === 1, "fencing token starts at 1");

  assert(
    await storage.heartbeatRun(run.id, "node_A", 30_000, 1),
    "owner heartbeat succeeds",
  );
  assert(
    !(await storage.heartbeatRun(run.id, "node_B", 30_000, 1)),
    "non-owner heartbeat fails (someone else can't steal the lease)",
  );
  assert(
    !(await storage.heartbeatRun(run.id, "node_A", 30_000, 99)),
    "stale fencing token can't extend the lease",
  );

  // --- reaper reclaims an expired lease ----------------------------------
  // Reap as if the clock is well past the lease expiry (no real waiting).
  const future = Date.now() + 60_000;
  const reaped = await storage.reapExpiredRuns(future);
  assert(reaped.length === 1, `reaper reclaimed the expired run (got ${reaped.length})`);
  assert(reaped[0]!.id === run.id, "reaped the right run");

  const after = await storage.getRun(run.id);
  assert(after?.status === "errored", "reaped run marked errored");
  assert(after?.leaseOwner == null, "reaped run owner cleared");
  assert(after?.fencingToken === 2, `fencing token bumped on reap (got ${after?.fencingToken})`);

  // --- fencing: a zombie holding the OLD lease can't write --------------
  await storage.updateRun(
    run.id,
    { status: "completed", error: null },
    { owner: "node_A", fencingToken: 1 }, // stale lease
  );
  const fenced = await storage.getRun(run.id);
  assert(fenced?.status === "errored", "stale-owner guarded write was fenced out (still errored)");

  // a second reaper tick finds nothing (the run is no longer active)
  const second = await storage.reapExpiredRuns(future);
  assert(second.length === 0, "second reap finds nothing (idempotent)");

  // --- a normal durable turn still completes -----------------------------
  const principal: Principal = { orgId: "org_a", userId: "user_1" };
  const chat = await storage.createChat(principal, { agent: "echo" });
  const userMessage: AppMessage = {
    id: "msg_user_1",
    role: "user",
    parts: [{ type: "text", text: "hi" }],
    metadata: { visibility: "user", createdAt: Date.now() },
  };
  await (
    await runtime.handleChat({ agent: "echo", chatId: chat.id, principal, message: userMessage })
  ).text();
  await new Promise((r) => setTimeout(r, 50));

  const rows = await client.execute(
    "SELECT status, lease_owner, fencing_token FROM latch_runs WHERE chat_id = ?",
    [chat.id],
  );
  assert(rows.rows.length === 1, "durable turn opened exactly one run");
  assert(rows.rows[0]?.status === "completed", "durable turn completed");
  assert(Number(rows.rows[0]?.fencing_token) === 1, "completed run kept its lease token");

  console.log("✅ durability smoke passed — lease + heartbeat + reaper + fencing");
}

main().catch((e) => {
  console.error("❌ durability smoke failed:", e);
  throw e;
});
