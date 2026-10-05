import type { AppMessage } from "../message.js";
import { isChatBusyError, type RunFence, type RunRecord, type StorageAdapter } from "../storage.js";

/**
 * The `StorageAdapter` guarantees the runtime relies on, as runnable checks:
 * tenant scoping, message ordering and upserts, one active run per chat, and
 * the lease / heartbeat / reaper / fencing rules that make a run continue on
 * exactly one node. An adapter that passes these can back a multi-node,
 * durable deployment; one that only "works" in normal use can still let a
 * crashed run resume twice, or a zombie node write into a chat it lost.
 *
 * Runner-agnostic: pass your runner's `describe` and `it` (Vitest, Jest,
 * `node:test`):
 *
 * ```ts
 * import { describe, it } from "vitest";
 * import { registerStorageConformance } from "@intentface/latch-core/testing";
 *
 * registerStorageConformance({ describe, it }, "my adapter", async () => {
 *   const db = await openTestDatabase();
 *   return {
 *     store: createMyAdapter(db, { owner: (p) => [p.org] }),
 *     principals: [{ org: "a" }, { org: "b" }],
 *     close: () => db.close(),
 *   };
 * });
 * ```
 *
 * Every check opens a fresh target, so they may run in any order.
 */
export interface ConformanceRunner {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => Promise<void>, timeoutMs?: number) => void;
}

export interface ConformanceTarget<P> {
  store: StorageAdapter<P>;
  /** Two principals the adapter maps to DIFFERENT owners. */
  principals: [P, P];
  close?: () => Promise<void> | void;
}

export interface ConformanceCheck<P> {
  name: string;
  run: (t: ConformanceTarget<P>) => Promise<void>;
}

class ConformanceError extends Error {}

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new ConformanceError(msg);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Long enough past a 1 ms lease for any clock to agree it expired. */
const EXPIRE = 25;

const msg = (id: string, text = id, role: AppMessage["role"] = "user"): AppMessage => ({
  id,
  role,
  parts: [{ type: "text", text }],
  metadata: { visibility: "user", createdAt: Date.now() },
});

const textOf = (m: AppMessage | undefined) =>
  (m?.parts[0] as { text?: string } | undefined)?.text;

async function busy(fn: () => Promise<unknown>): Promise<number | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    if (isChatBusyError(e)) return e.retryAfterMs;
    throw e;
  }
}

const fenceOf = (run: RunRecord, owner: string): RunFence => ({
  runId: run.id,
  owner,
  fencingToken: run.fencingToken ?? 1,
});

function checks<P>(): ConformanceCheck<P>[] {
  return [
    // ── messages ──────────────────────────────────────────────────────────
    {
      name: "messages load in append order and upsert by id in place",
      async run({ store, principals: [me] }) {
        const chat = await store.createChat(me, { agent: "a" });
        await store.appendMessages(chat.id, [msg("m1"), msg("m2", "m2", "assistant")]);
        await store.appendMessages(chat.id, [msg("m3")]);
        await store.appendMessages(chat.id, [msg("m2", "edited", "assistant")]);
        const loaded = await store.loadMessages(me, chat.id);
        check(loaded.map((m) => m.id).join() === "m1,m2,m3", `order: ${loaded.map((m) => m.id).join()}`);
        check(textOf(loaded[1]) === "edited", "an upsert updates the message in place");
      },
    },
    {
      name: "the same message id in two chats is two messages",
      async run({ store, principals: [me] }) {
        const a = await store.createChat(me, { agent: "a" });
        const b = await store.createChat(me, { agent: "a" });
        await store.appendMessages(a.id, [msg("same", "in a")]);
        await store.appendMessages(b.id, [msg("same", "in b")]);
        check(textOf((await store.loadMessages(me, a.id))[0]) === "in a", "chat a keeps its own message");
        check(textOf((await store.loadMessages(me, b.id))[0]) === "in b", "chat b keeps its own message");
      },
    },
    {
      name: "concurrent appends to one chat all land, each with its own position",
      async run({ store, principals: [me] }) {
        const chat = await store.createChat(me, { agent: "a" });
        const ids = Array.from({ length: 8 }, (_, i) => `c${i}`);
        await Promise.all(ids.map((id) => store.appendMessages(chat.id, [msg(id)])));
        const loaded = await store.loadMessages(me, chat.id);
        check(loaded.length === ids.length, `all appends landed (${loaded.length}/${ids.length})`);
        check(new Set(loaded.map((m) => m.id)).size === ids.length, "no message lost or duplicated");
      },
    },

    // ── tenancy ───────────────────────────────────────────────────────────
    {
      name: "another owner can't see a chat, its messages, or it in a list",
      async run({ store, principals: [me, other] }) {
        const chat = await store.createChat(me, { agent: "a" });
        await store.appendMessages(chat.id, [msg("secret")]);
        check((await store.getChat(other, chat.id)) === null, "getChat is scoped");
        check((await store.loadMessages(other, chat.id)).length === 0, "loadMessages is scoped");
        check(!(await store.listChats(other)).some((c) => c.id === chat.id), "listChats is scoped");
        check((await store.getChat(me, chat.id))?.id === chat.id, "the owner still sees it");
      },
    },

    // ── one active run per chat ──────────────────────────────────────────
    {
      name: "a live run refuses a second run in its chat, with the time left",
      async run({ store, principals: [me] }) {
        const chat = await store.createChat(me, { agent: "a" });
        await store.claimRun({ principal: me, chatId: chat.id, agent: "a", owner: "n1", ttlMs: 60_000 });
        const retry = await busy(() =>
          store.claimRun({ principal: me, chatId: chat.id, agent: "a", owner: "n2", ttlMs: 60_000 }),
        );
        check(retry !== null && retry > 0 && retry <= 60_000, `second claim refused with retryAfterMs (${retry})`);
        check((await busy(() => store.createRun(me, { chatId: chat.id, agent: "a" }))) !== null, "a non-durable run is refused too");
        const other = await store.createChat(me, { agent: "a" });
        check((await busy(() => store.createRun(me, { chatId: other.id, agent: "a" }))) === null, "other chats are unaffected");
      },
    },
    {
      name: "racing claims on one chat: exactly one wins",
      async run({ store, principals: [me] }) {
        const chat = await store.createChat(me, { agent: "a" });
        const race = await Promise.allSettled(
          ["n1", "n2", "n3", "n4"].map((owner) =>
            store.claimRun({ principal: me, chatId: chat.id, agent: "a", owner, ttlMs: 60_000 }),
          ),
        );
        const won = race.filter((r) => r.status === "fulfilled").length;
        check(won === 1, `exactly one claim wins (${won})`);
        for (const r of race) if (r.status === "rejected") check(isChatBusyError(r.reason), `losers get ChatBusyError (${r.reason})`);
      },
    },
    {
      name: "a run paused for a human doesn't block the chat",
      async run({ store, principals: [me] }) {
        const chat = await store.createChat(me, { agent: "a" });
        const paused = await store.claimRun({ principal: me, chatId: chat.id, agent: "a", owner: "n1", ttlMs: 60_000 });
        await store.updateRun(paused.id, { status: "awaiting_input" });
        const next = await store.claimRun({ principal: me, chatId: chat.id, agent: "a", owner: "n1", ttlMs: 60_000 });
        check(next.id !== paused.id, "a decision opens a new run");
      },
    },
    {
      name: "an expired lease is superseded by the next turn, and can't be reclaimed",
      async run({ store, principals: [me] }) {
        const chat = await store.createChat(me, { agent: "a" });
        const crashed = await store.claimRun({ principal: me, chatId: chat.id, agent: "a", owner: "n1", ttlMs: 1 });
        await sleep(EXPIRE);
        await store.claimRun({ principal: me, chatId: chat.id, agent: "a", owner: "n2", ttlMs: 60_000 });
        const old = await store.getRun(crashed.id);
        check(old?.status === "errored", `the crashed run is settled (${old?.status})`);
        check((old?.fencingToken ?? 0) > (crashed.fencingToken ?? 0), "its fencing token is bumped");
        check((await store.reclaimRun(crashed.id, "n3", 60_000)) === null, "a superseded run is not reclaimable");
      },
    },
    {
      name: "openTurn opens the run and its message together, or neither",
      async run({ store, principals: [me] }) {
        if (!store.openTurn) return;
        const chat = await store.createChat(me, { agent: "a" });
        const run = await store.openTurn(me, {
          chatId: chat.id,
          agent: "a",
          messages: [msg("u1")],
          lease: { owner: "n1", ttlMs: 60_000 },
        });
        check(run.status === "active" && run.leaseOwner === "n1", "opens a leased run");
        check((await busy(() => store.openTurn!(me, { chatId: chat.id, agent: "a", messages: [msg("u2")] }))) !== null, "a busy chat is refused");
        const ids = (await store.loadMessages(me, chat.id)).map((m) => m.id);
        check(ids.join() === "u1", `a refused turn persists nothing (${ids.join()})`);

        const racy = await store.createChat(me, { agent: "a" });
        const race = await Promise.allSettled(
          ["a", "b", "c"].map((id) => store.openTurn!(me, { chatId: racy.id, agent: "a", messages: [msg(id)] })),
        );
        const won = race.filter((r) => r.status === "fulfilled").length;
        const persisted = (await store.loadMessages(me, racy.id)).length;
        check(won === 1 && persisted === 1, `one of three racing turns wins, one message lands (${won}/${persisted})`);
      },
    },

    // ── leases, heartbeats, the reaper ───────────────────────────────────
    {
      name: "a heartbeat renews only the current holder's lease",
      async run({ store, principals: [me] }) {
        const chat = await store.createChat(me, { agent: "a" });
        const run = await store.claimRun({ principal: me, chatId: chat.id, agent: "a", owner: "n1", ttlMs: 60_000 });
        const token = run.fencingToken ?? 1;
        check(await store.heartbeatRun(run.id, "n1", 60_000, token), "the holder renews");
        check(!(await store.heartbeatRun(run.id, "n2", 60_000, token)), "another owner can't");
        check(!(await store.heartbeatRun(run.id, "n1", 60_000, token + 1)), "a wrong token can't");
        await store.updateRun(run.id, { status: "completed" });
        check(!(await store.heartbeatRun(run.id, "n1", 60_000, token)), "a finished run can't be renewed");
      },
    },
    {
      name: "the reaper settles expired leases once and fences out their holder",
      async run({ store, principals: [me] }) {
        const chat = await store.createChat(me, { agent: "a" });
        const live = await store.claimRun({ principal: me, chatId: chat.id, agent: "a", owner: "n1", ttlMs: 60_000 });
        const other = await store.createChat(me, { agent: "a" });
        const dead = await store.claimRun({ principal: me, chatId: other.id, agent: "a", owner: "n2", ttlMs: 1 });
        await sleep(EXPIRE);
        // No `now`: the adapter's own clock decides.
        const reaped = await store.reapExpiredRuns();
        check(reaped.some((r) => r.id === dead.id), "an expired lease is reaped");
        check(!reaped.some((r) => r.id === live.id), "a live lease is not");
        check(!(await store.reapExpiredRuns()).some((r) => r.id === dead.id), "a reaped run isn't reaped twice");
        const zombie = { owner: "n2", fencingToken: dead.fencingToken ?? 1 };
        check(!(await store.heartbeatRun(dead.id, zombie.owner, 60_000, zombie.fencingToken)), "its holder can't renew");
        check(!(await store.updateRun(dead.id, { status: "completed" }, zombie)), "its holder can't settle it");
      },
    },
    {
      name: "racing reclaims of a dead run: exactly one wins",
      async run({ store, principals: [me] }) {
        const chat = await store.createChat(me, { agent: "a" });
        const dead = await store.claimRun({ principal: me, chatId: chat.id, agent: "a", owner: "n1", ttlMs: 1 });
        await sleep(EXPIRE);
        await store.reapExpiredRuns();
        const race = await Promise.all(["n2", "n3", "n4"].map((owner) => store.reclaimRun(dead.id, owner, 60_000)));
        const winners = race.filter((r) => r !== null);
        check(winners.length === 1, `exactly one reclaim wins (${winners.length})`);
        check((winners[0]!.fencingToken ?? 0) > (dead.fencingToken ?? 0), "the winner holds a newer token");
        check(winners[0]!.status === "active", "the reclaimed run is active again");
      },
    },
    {
      name: "reclaim refuses live, finished and never-leased runs",
      async run({ store, principals: [me] }) {
        const a = await store.createChat(me, { agent: "a" });
        const live = await store.claimRun({ principal: me, chatId: a.id, agent: "a", owner: "n1", ttlMs: 60_000 });
        check((await store.reclaimRun(live.id, "n2", 60_000)) === null, "a live lease is not taken over");
        const b = await store.createChat(me, { agent: "a" });
        const done = await store.claimRun({ principal: me, chatId: b.id, agent: "a", owner: "n1", ttlMs: 1 });
        await store.updateRun(done.id, { status: "completed" });
        await sleep(EXPIRE);
        check((await store.reclaimRun(done.id, "n2", 60_000)) === null, "a completed run is not resumed");
        const c = await store.createChat(me, { agent: "a" });
        const t1 = await store.createRun(me, { chatId: c.id, agent: "a" });
        check((await store.reclaimRun(t1.id, "n2", 60_000)) === null, "a never-leased run is not seized");
      },
    },
    {
      name: "a guarded run update applies only for the current holder",
      async run({ store, principals: [me] }) {
        const chat = await store.createChat(me, { agent: "a" });
        const run = await store.claimRun({ principal: me, chatId: chat.id, agent: "a", owner: "n1", ttlMs: 1 });
        await sleep(EXPIRE);
        await store.reapExpiredRuns();
        const back = (await store.reclaimRun(run.id, "n2", 60_000))!;
        check(!(await store.updateRun(run.id, { status: "completed" }, { owner: "n1", fencingToken: run.fencingToken ?? 1 })), "the old holder is refused");
        check(await store.updateRun(run.id, { status: "completed" }, { owner: "n2", fencingToken: back.fencingToken ?? 1 }), "the new holder applies");
      },
    },

    // ── fenced message writes ────────────────────────────────────────────
    {
      name: "fenced message writes land for the holder and are refused for a zombie",
      async run({ store, principals: [me] }) {
        const chat = await store.createChat(me, { agent: "a" });
        const run = await store.claimRun({ principal: me, chatId: chat.id, agent: "a", owner: "n1", ttlMs: 1 });
        const first = fenceOf(run, "n1");
        check((await store.appendMessages(chat.id, [msg("a1", "draft", "assistant")], first)) === true, "the holder's write lands (returns true)");

        await sleep(EXPIRE);
        await store.reapExpiredRuns();
        const back = (await store.reclaimRun(run.id, "n2", 60_000))!;

        // The zombie wakes up: a new message and an edit of an existing one.
        const refused = await store.appendMessages(chat.id, [msg("a1", "zombie edit", "assistant"), msg("z1", "zombie")], first);
        check(refused === false, `the zombie's write is refused (returned ${String(refused)})`);
        const after = await store.loadMessages(me, chat.id);
        check(after.map((m) => m.id).join() === "a1", `nothing of the refused write landed (${after.map((m) => m.id).join()})`);
        check(textOf(after[0]) === "draft", "an existing message is not overwritten by the zombie");

        check((await store.appendMessages(chat.id, [msg("a2", "new owner", "assistant")], fenceOf(back, "n2"))) === true, "the new holder writes");
      },
    },
    {
      name: "a fenced write still lands after its run is settled by its holder",
      async run({ store, principals: [me] }) {
        // The runtime settles the run row FIRST, then writes the final message
        // with the same lease: settling must not invalidate the holder's fence.
        const chat = await store.createChat(me, { agent: "a" });
        const run = await store.claimRun({ principal: me, chatId: chat.id, agent: "a", owner: "n1", ttlMs: 60_000 });
        const fence = fenceOf(run, "n1");
        check(await store.updateRun(run.id, { status: "completed", endedAt: Date.now() }, fence), "the holder settles");
        check((await store.appendMessages(chat.id, [msg("final", "answer", "assistant")], fence)) === true, "the final message lands");
      },
    },
  ];
}

/** The checks as a plain list, for runners `registerStorageConformance` doesn't fit. */
export function storageConformanceChecks<P>(): ReadonlyArray<ConformanceCheck<P>> {
  return checks<P>();
}

/** Register every check as one test under `describe(name)`. */
export function registerStorageConformance<P>(
  runner: ConformanceRunner,
  name: string,
  open: () => Promise<ConformanceTarget<P>>,
  opts?: { timeoutMs?: number },
): void {
  runner.describe(`${name}: storage conformance`, () => {
    for (const c of checks<P>()) {
      runner.it(
        c.name,
        async () => {
          const target = await open();
          try {
            await c.run(target);
          } finally {
            await target.close?.();
          }
        },
        opts?.timeoutMs ?? 30_000,
      );
    }
  });
}
