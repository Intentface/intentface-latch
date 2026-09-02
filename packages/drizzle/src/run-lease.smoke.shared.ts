import type { StorageAdapter } from "@intentface/latch-core";
import { isChatBusyError } from "@intentface/latch-core";

/**
 * Dialect-shared smoke for the one-active-run-per-chat invariant: a live run
 * refuses a second (durable and non-durable), an expired lease is superseded by
 * the next turn, a paused run doesn't block, and a superseded crash can't be
 * reclaimed by the sweep.
 */
export async function runLeaseSmoke<P>(args: {
  store: StorageAdapter<P>;
  principal: P;
  assert: (cond: boolean, msg: string) => void;
}): Promise<void> {
  const { store, principal: me, assert } = args;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const busy = async (fn: () => Promise<unknown>): Promise<number | null> => {
    try {
      await fn();
      return null;
    } catch (e) {
      return isChatBusyError(e) ? e.retryAfterMs : -1;
    }
  };

  // Durable: a live lease refuses a second claim, with the lease's remaining time.
  const chat = await store.createChat(me, { agent: "lease" });
  const live = await store.claimRun({ principal: me, chatId: chat.id, agent: "lease", owner: "n1", ttlMs: 60_000 });
  const retry = await busy(() => store.claimRun({ principal: me, chatId: chat.id, agent: "lease", owner: "n2", ttlMs: 60_000 }));
  assert(retry !== null && retry > 0 && retry <= 60_000, `run lease: second claim refused with retryAfterMs (${retry})`);
  assert((await busy(() => store.createRun(me, { chatId: chat.id, agent: "lease" }))) !== null, "run lease: T1 createRun refused too");

  // Paused (awaiting_input) does not block: a decision opens a new run.
  await store.updateRun(live.id, { status: "awaiting_input" });
  const next = await store.claimRun({ principal: me, chatId: chat.id, agent: "lease", owner: "n1", ttlMs: 60_000 });
  assert(next.id !== live.id, "run lease: a paused run does not block the chat");
  await store.updateRun(next.id, { status: "completed", endedAt: Date.now() });

  // Expired lease: the next turn supersedes the crashed run (errored, token bumped) instead of waiting.
  const crashed = await store.claimRun({ principal: me, chatId: chat.id, agent: "lease", owner: "n1", ttlMs: 1 });
  await sleep(5);
  const fresh = await store.claimRun({ principal: me, chatId: chat.id, agent: "lease", owner: "n2", ttlMs: 60_000 });
  const old = (await store.getRun(crashed.id))!;
  assert(old.status === "errored" && /superseded/.test(old.error ?? ""), "run lease: expired lease superseded by the next turn");
  assert((old.fencingToken ?? 0) > (crashed.fencingToken ?? 0), "run lease: superseded run's fencing token bumped");
  // …and the sweep can no longer reclaim it while the chat has a newer live run.
  assert((await store.reclaimRun(crashed.id, "n3", 60_000)) === null, "run lease: superseded run is not reclaimable");
  await store.updateRun(fresh.id, { status: "completed", endedAt: Date.now() });

  // Another chat is unaffected.
  const other = await store.createChat(me, { agent: "lease" });
  assert((await busy(() => store.createRun(me, { chatId: other.id, agent: "lease" }))) === null, "run lease: other chats unaffected");
}
