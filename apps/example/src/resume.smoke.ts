import type { AppMessage } from "@intentface/latch-core";
import { assert, makeDurableRuntime } from "./setup.js";

/**
 * T2 resume: a turn dies after persisting the user message but before
 * answering. The reaper marks it errored; resume re-claims it (exactly-once,
 * attempt++), re-runs from persisted history, and completes it server-side.
 */
async function main() {
  const { runtime, storage, client } = await makeDurableRuntime();
  const scope = { orgId: "org_a", userId: "user_1" };
  const chat = await storage.createChat(scope, { agent: "echo" });

  // The doomed original turn: it persisted the user message and claimed a run...
  const user: AppMessage = {
    id: "msg_user_1",
    role: "user",
    parts: [{ type: "text", text: "hi" }],
    metadata: { visibility: "user", createdAt: Date.now() },
  };
  await storage.appendMessages(chat.id, [user]);
  // A real, short lease: `reclaimRun` checks expiry against the wall clock
  // (a reaped run keeps its expired leaseExpiresAt), so advancing only the
  // reaper's clock would reap the run but leave it un-reclaimable.
  const original = await storage.claimRun({
    principal: scope,
    chatId: chat.id,
    agent: "echo",
    owner: "dead_node",
    ttlMs: 20,
  });

  // ...then the process died. Once the lease has lapsed, the reaper reclaims it.
  await new Promise((r) => setTimeout(r, 40));
  await storage.reapExpiredRuns(Date.now());
  const reaped = await storage.getRun(original.id);
  assert(reaped?.status === "errored", "original run was reaped (errored)");
  const before = await storage.loadMessages(scope, chat.id);
  assert(before.length === 1, "only the user message persisted (died before answering)");

  // Resume it.
  const result = await runtime.resume(original.id);
  assert(result !== null, "resume returned a result");
  assert(result?.status === "completed", `resumed run completed (got ${result?.status})`);
  assert(result?.attempt === 2, `attempt incremented on resume (got ${result?.attempt})`);

  const after = await storage.loadMessages(scope, chat.id);
  assert(after.length === 2, `resume produced the assistant reply (got ${after.length})`);
  const text = (after.find((m) => m.role === "assistant")?.parts ?? [])
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
  assert(text === "Hello, world!", `assistant reply persisted by resume (got "${text}")`);

  const row = await client.execute("SELECT status, attempt FROM latch_runs WHERE id = ?", [
    original.id,
  ]);
  assert(row.rows[0]?.status === "completed", "run row marked completed");
  assert(Number(row.rows[0]?.attempt) === 2, "run row attempt = 2");

  // Resuming a completed run is a no-op (not reclaimable).
  const again = await runtime.resume(original.id);
  assert(again === null, "second resume is a no-op (run already completed)");

  console.log("✅ resume smoke passed — reaped run re-claimed, re-run, completed (exactly once)");
}

main().catch((e) => {
  console.error("❌ resume smoke failed:", e);
  throw e;
});
