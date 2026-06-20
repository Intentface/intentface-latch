import { createIntervalScheduler, type AppMessage } from "@intentface/latch-core";
import { assert, makeDurableRuntime } from "./setup.js";

/**
 * Scheduler + sweep: a run is left stuck (claimed, never finished, short lease).
 * An interval scheduler firing `runtime.sweep()` reaps it and resumes it to
 * completion — no manual intervention. This is the cron/reaper loop a
 * long-running node would run; serverless points a platform cron at the same
 * `sweep()` instead.
 */
async function main() {
  // Short lease so the stuck run becomes reapable quickly (no long waits).
  const { runtime, storage } = await makeDurableRuntime({ leaseTtlMs: 60 });
  const scope = { orgId: "org_a", userId: "user_1" };
  const chat = await storage.createChat(scope, { agent: "echo" });

  // A doomed turn: user message persisted, run claimed by a node that then died.
  await storage.appendMessages(chat.id, [
    {
      id: "msg_user_1",
      role: "user",
      parts: [{ type: "text", text: "hi" }],
      metadata: { visibility: "user", createdAt: Date.now() },
    } satisfies AppMessage,
  ]);
  const stuck = await storage.claimRun({
    principal: scope,
    chatId: chat.id,
    agent: "echo",
    owner: "dead_node",
    ttlMs: 60,
  });
  assert(stuck.status === "active", "run starts active (stuck)");

  // Drive the reaper on a cadence. The scheduler is the only thing acting now.
  let sweeps = 0;
  const scheduler = createIntervalScheduler({
    intervalMs: 25,
    onTick: async () => {
      sweeps++;
      await runtime.sweep();
    },
    onError: (e) => console.error("sweep error", e),
  });
  scheduler.start();

  // Wait until the scheduler has reaped + resumed the run (poll, bounded).
  let final = await storage.getRun(stuck.id);
  for (let i = 0; i < 40 && final?.status !== "completed"; i++) {
    await new Promise((r) => setTimeout(r, 25));
    final = await storage.getRun(stuck.id);
  }
  await scheduler.stop();

  assert(final?.status === "completed", `scheduler drove the run to completed (got ${final?.status})`);
  assert((final?.attempt ?? 0) >= 2, `run was resumed at least once (attempt ${final?.attempt})`);
  assert(sweeps >= 1, "scheduler fired at least one sweep");

  const messages = await storage.loadMessages(scope, chat.id);
  assert(messages.length === 2, `assistant reply produced by the sweep (got ${messages.length})`);

  // Idempotent: another sweep finds nothing to do.
  const { reaped, resumed } = await runtime.sweep();
  assert(reaped.length === 0 && resumed.length === 0, "a clean sweep is a no-op");

  console.log("✅ scheduler smoke passed — interval sweep reaped + resumed a stuck run");
}

main().catch((e) => {
  console.error("❌ scheduler smoke failed:", e);
  throw e;
});
