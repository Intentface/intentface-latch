import type { AppMessage } from "../message.js";
import {
  decodeOwnerKey,
  isChatBusyError,
  isOwnerKeyMismatchError,
  ChatConflictError,
  type RunFence,
  type RunRecord,
  type ScheduleRecord,
  type StorageAdapter,
} from "../storage.js";

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
  /**
   * The adapter returns `ownerKey` on every run record and refuses an id-only
   * call carrying another owner's key (`OwnerScope`). Turns on the owner-key
   * checks; leave it off for an adapter that ignores owner keys.
   */
  checksOwnerKey?: boolean;
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

/** Whether `fn` was refused with OwnerKeyMismatchError. */
async function mismatched(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (e) {
    if (isOwnerKeyMismatchError(e)) return true;
    throw e;
  }
}

async function busy(fn: () => Promise<unknown>): Promise<number | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    if (isChatBusyError(e)) return e.retryAfterMs;
    throw e;
  }
}

/** A schedule due now, owned by `p`. */
const dueSchedule = <P>(store: StorageAdapter<P>, p: P, cron: string | null = "0 9 * * *") =>
  store.createSchedule(p, { agent: "a", cron, prompt: "brief", nextRunAt: 0 });

/** Which of `claimed` is schedule `id`. */
const claimedOne = (claimed: ScheduleRecord[], id: string) => claimed.filter((s) => s.id === id);

/** A far-future time: "not due again". */
const LATER = Date.now() + 365 * 24 * 3_600_000;

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

    // ── chats ─────────────────────────────────────────────────────────────
    {
      name: "a chat keeps the params it was created with",
      async run({ store, principals: [me] }) {
        const params = { ticketId: "T-9", tags: ["a", "b"], nested: { n: 1 } };
        const chat = await store.createChat(me, { agent: "a", params });
        const read = await store.getChat(me, chat.id);
        // Key order may change on the way through (Postgres JSONB reorders), so compare sorted.
        const sorted = (v: unknown) =>
          JSON.stringify(v ?? null, (_k, x) =>
            x && typeof x === "object" && !Array.isArray(x)
              ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]]))
              : x,
          );
        check(sorted(read?.params) === sorted(params), `params round-trip: ${JSON.stringify(read?.params)}`);
        const plain = await store.createChat(me, { agent: "a" });
        check((await store.getChat(me, plain.id))?.params === undefined, "a chat created without params has none");
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
        const run = await store.claimRun({ principal: me, chatId: chat.id, agent: "a", owner: "n1", ttlMs: 60_000 });
        const first = fenceOf(run, "n1");
        check((await store.appendMessages(chat.id, [msg("a1", "draft", "assistant")], first)) === true, "the holder's write lands (returns true)");

        // Only now let the lease run out: the first write must not depend on
        // whether an adapter's fence also checks expiry.
        check(await store.heartbeatRun(run.id, "n1", 1, first.fencingToken), "the holder shortens its lease");
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

    // ── chats ─────────────────────────────────────────────────────────────
    {
      name: "a chat id that's taken is refused with ChatConflictError, for any owner",
      async run({ store, principals: [me, other] }) {
        await store.createChat(me, { id: "chat_fixed", agent: "a" });
        for (const p of [other, me]) {
          let err: unknown;
          try {
            await store.createChat(p, { id: "chat_fixed", agent: "a" });
          } catch (e) {
            err = e;
          }
          check(err instanceof ChatConflictError || (err as { code?: string })?.code === "chat_conflict", `a duplicate id is a ChatConflictError (${String(err)})`);
        }
        check((await store.getChat(other, "chat_fixed")) === null, "the other owner still can't see it");
      },
    },
    {
      name: "listChats filters by kind, and lists every kind without one",
      async run({ store, principals: [me] }) {
        const user = await store.createChat(me, { agent: "a" });
        const sub = await store.createChat(me, { agent: "a", kind: "sub" });
        const userOnly = (await store.listChats(me, { kind: "user" })).map((c) => c.id);
        check(userOnly.includes(user.id) && !userOnly.includes(sub.id), "kind 'user' leaves the sub-thread out");
        const all = (await store.listChats(me)).map((c) => c.id);
        check(all.includes(user.id) && all.includes(sub.id), "no kind lists both");
      },
    },
    {
      name: "listRuns shows only the caller's runs",
      async run({ store, principals: [me, other] }) {
        const mine = await store.createChat(me, { agent: "a" });
        const run = await store.createRun(me, { chatId: mine.id, agent: "a" });
        check((await store.listRuns(me)).some((r) => r.id === run.id), "the owner sees the run");
        check(!(await store.listRuns(other)).some((r) => r.id === run.id), "another owner doesn't");
      },
    },

    // ── schedules ─────────────────────────────────────────────────────────
    {
      name: "racing claims take each due occurrence exactly once",
      async run({ store, principals: [me] }) {
        const s = await dueSchedule(store, me);
        const race = await Promise.all(["n1", "n2", "n3", "n4"].map((owner) => store.claimDueSchedules(Date.now(), 60_000, owner)));
        const winners = race.filter((claimed) => claimedOne(claimed, s.id).length === 1).length;
        check(winners === 1, `exactly one claimer gets it (${winners})`);
        const won = race.flatMap((c) => claimedOne(c, s.id))[0]!;
        check(won.owner === s.owner, "the claim carries the schedule's owner");
        check(JSON.stringify(won.identity) === JSON.stringify(s.identity), "and its stored identity");
      },
    },
    {
      name: "a live claim isn't claimed again; a lapsed one is",
      async run({ store, principals: [me] }) {
        const s = await dueSchedule(store, me);
        check(claimedOne(await store.claimDueSchedules(Date.now(), 1, "n1"), s.id).length === 1, "n1 claims it");
        await sleep(EXPIRE);
        check(claimedOne(await store.claimDueSchedules(Date.now(), 60_000, "n2"), s.id).length === 1, "after the lease lapses, n2 claims it");
        check(claimedOne(await store.claimDueSchedules(Date.now(), 60_000, "n3"), s.id).length === 0, "while n2's lease is live, n3 doesn't");
      },
    },
    {
      name: "completing a stale claim is refused, by holder and by claim",
      async run({ store, principals: [me] }) {
        const s = await dueSchedule(store, me);
        const first = claimedOne(await store.claimDueSchedules(Date.now(), 1, "n1"), s.id)[0]!;
        await sleep(EXPIRE);
        const second = claimedOne(await store.claimDueSchedules(Date.now(), 60_000, "n2"), s.id)[0]!;
        const patch = { nextRunAt: LATER, lastRunAt: Date.now(), enabled: true };
        check((await store.completeSchedule(s.id, patch, "n1", { leaseExpiresAt: first.leaseExpiresAt! })) === false, "the old holder's completion returns false");
        check((await store.completeSchedule(s.id, patch, "n2", { leaseExpiresAt: second.leaseExpiresAt! })) !== false, "the current holder's applies");

        // The same holder twice (two passes sharing an instance id): the claim fence tells them apart.
        const t = await dueSchedule(store, me);
        const early = claimedOne(await store.claimDueSchedules(Date.now(), 1, "n1"), t.id)[0]!;
        await sleep(EXPIRE);
        const late = claimedOne(await store.claimDueSchedules(Date.now(), 60_000, "n1"), t.id)[0]!;
        check((await store.completeSchedule(t.id, patch, "n1", { leaseExpiresAt: early.leaseExpiresAt! })) === false, "the earlier claim by the same holder is refused");
        check((await store.completeSchedule(t.id, patch, "n1", { leaseExpiresAt: late.leaseExpiresAt! })) !== false, "the later claim applies");
      },
    },
    {
      name: "a completed occurrence isn't due again, and a fired one-shot stays off",
      async run({ store, principals: [me] }) {
        const cron = await dueSchedule(store, me);
        const oneShot = await dueSchedule(store, me, null);
        const claimed = await store.claimDueSchedules(Date.now(), 60_000, "n1");
        const now = Date.now();
        for (const c of claimed.filter((x) => x.id === cron.id || x.id === oneShot.id)) {
          await store.completeSchedule(c.id, { nextRunAt: c.id === cron.id ? LATER : now, lastRunAt: now, enabled: c.id === cron.id }, "n1", { leaseExpiresAt: c.leaseExpiresAt! });
        }
        const again = await store.claimDueSchedules(Date.now(), 60_000, "n2");
        check(claimedOne(again, cron.id).length === 0, "the cron schedule isn't due until its next run");
        check(claimedOne(again, oneShot.id).length === 0, "the one-shot isn't claimed again");
        check((await store.bumpSchedule(me, oneShot.id)) === false, "bumping a fired one-shot does nothing (returns false)");
        check(claimedOne(await store.claimDueSchedules(Date.now(), 60_000, "n3"), oneShot.id).length === 0, "and it still isn't claimed");
      },
    },
    {
      name: "bump arms only the caller's enabled schedules",
      async run({ store, principals: [me, other] }) {
        const s = await store.createSchedule(me, { agent: "a", cron: "0 9 * * *", prompt: "brief", nextRunAt: LATER });
        check((await store.bumpSchedule(other, s.id)) === false, "another owner can't bump it");
        check((await store.bumpSchedule(me, "sch_missing")) === false, "an unknown id returns false");
        check(claimedOne(await store.claimDueSchedules(Date.now(), 60_000, "n1"), s.id).length === 0, "not due before the bump");
        check((await store.bumpSchedule(me, s.id)) === true, "the owner's bump returns true");
        check(claimedOne(await store.claimDueSchedules(Date.now(), 60_000, "n1"), s.id).length === 1, "and makes it due now");
      },
    },
    {
      name: "bumping a claimed schedule doesn't let a second node fire it",
      async run({ store, principals: [me] }) {
        const s = await dueSchedule(store, me);
        check(claimedOne(await store.claimDueSchedules(Date.now(), 60_000, "n1"), s.id).length === 1, "n1 holds the claim");
        await store.bumpSchedule(me, s.id);
        check(claimedOne(await store.claimDueSchedules(Date.now(), 60_000, "n2"), s.id).length === 0, "n2 can't claim it while n1's claim is live");
      },
    },
    {
      name: "a schedule deleted mid-fire isn't brought back by the fire's completion",
      async run({ store, principals: [me] }) {
        const s = await dueSchedule(store, me);
        const c = claimedOne(await store.claimDueSchedules(Date.now(), 60_000, "n1"), s.id)[0]!;
        await store.deleteSchedule(me, s.id);
        await store.completeSchedule(s.id, { nextRunAt: LATER, lastRunAt: Date.now(), enabled: true }, "n1", { leaseExpiresAt: c.leaseExpiresAt! });
        check(!(await store.listSchedules(me)).some((x) => x.id === s.id), "it stays deleted");
        check(claimedOne(await store.claimDueSchedules(Date.now(), 60_000, "n2"), s.id).length === 0, "and is never claimed");
      },
    },
    {
      name: "schedules are scoped to their owner",
      async run({ store, principals: [me, other] }) {
        const s = await store.createSchedule(me, { agent: "a", cron: "0 9 * * *", prompt: "brief", nextRunAt: LATER });
        check(!(await store.listSchedules(other)).some((x) => x.id === s.id), "another owner doesn't list it");
        await store.deleteSchedule(other, s.id);
        check((await store.listSchedules(me)).some((x) => x.id === s.id), "another owner can't delete it");
      },
    },
    {
      name: "a stamp from an older fire doesn't overwrite a newer fire's chat",
      async run({ store, principals: [me] }) {
        if (!store.noteScheduleFire) return;
        const s = await dueSchedule(store, me);
        const fire = async (owner: string, at: number) => {
          const c = claimedOne(await store.claimDueSchedules(Date.now(), 60_000, owner), s.id)[0]!;
          await store.completeSchedule(s.id, { nextRunAt: LATER, lastRunAt: at, enabled: true }, owner, { leaseExpiresAt: c.leaseExpiresAt! });
        };
        await fire("n1", 1_000);
        await store.noteScheduleFire(s.id, { lastChatId: "chat_first", firedAt: 1_000 });
        await store.bumpSchedule(me, s.id);
        await fire("n2", 2_000);
        // The first fire's stamp, delayed until after the second consumed.
        await store.noteScheduleFire(s.id, { lastChatId: "chat_late", firedAt: 1_000 });
        const row = (await store.listSchedules(me)).find((x) => x.id === s.id);
        check(row?.lastChatId === "chat_first", `the delayed stamp is a no-op (${row?.lastChatId})`);
        await store.noteScheduleFire(s.id, { lastChatId: "chat_second", firedAt: 2_000 });
        check((await store.listSchedules(me)).find((x) => x.id === s.id)?.lastChatId === "chat_second", "the current fire's stamp lands");
      },
    },

    // ── owner keys on id-only calls (checksOwnerKey) ─────────────────────
    {
      name: "runs carry their chat's owner key, through reaping and reclaiming",
      async run({ store, principals: [me], checksOwnerKey }) {
        if (!checksOwnerKey) return;
        const chat = await store.createChat(me, { agent: "a" });
        const plain = await store.createRun(me, { chatId: chat.id, agent: "a" });
        check(plain.ownerKey === chat.owner, `createRun stamps the chat's key (${plain.ownerKey})`);
        await store.updateRun(plain.id, { status: "completed" });
        const leased = await store.claimRun({ principal: me, chatId: chat.id, agent: "a", owner: "n1", ttlMs: 1 });
        check(leased.ownerKey === chat.owner, "claimRun stamps it");
        await sleep(EXPIRE);
        const reaped = (await store.reapExpiredRuns()).find((r) => r.id === leased.id);
        check(reaped?.ownerKey === chat.owner, "a reaped run still carries it");
        const back = await store.reclaimRun(leased.id, "n2", 60_000, { ownerKey: chat.owner });
        check(back?.ownerKey === chat.owner, "and so does the reclaimed one");
        check((await store.getRun(leased.id, { ownerKey: chat.owner }))?.ownerKey === chat.owner, "getRun returns it");
        if (store.openTurn) {
          const other = await store.createChat(me, { agent: "a" });
          const opened = await store.openTurn(me, { chatId: other.id, agent: "a", messages: [msg("u1")] });
          check(opened.ownerKey === other.owner, "openTurn stamps it");
        }
      },
    },
    {
      name: "an id-only call carrying another owner's key is refused and changes nothing",
      async run({ store, principals: [me, other], checksOwnerKey }) {
        if (!checksOwnerKey) return;
        const chat = await store.createChat(me, { agent: "a" });
        const theirs = (await store.createChat(other, { agent: "a" })).owner;
        const wrong = { ownerKey: theirs };
        const run = await store.claimRun({ principal: me, chatId: chat.id, agent: "a", owner: "n1", ttlMs: 60_000 });
        const token = run.fencingToken ?? 1;

        check(await mismatched(() => store.appendMessages(chat.id, [msg("x")], undefined, wrong)), "appendMessages is refused");
        check((await store.loadMessages(me, chat.id)).length === 0, "and wrote nothing");
        check(await mismatched(() => store.updateRun(run.id, { status: "completed" }, undefined, wrong)), "updateRun is refused");
        check((await store.getRun(run.id))?.status === "active", "and changed nothing");
        check(await mismatched(() => store.heartbeatRun(run.id, "n1", 60_000, token, wrong)), "heartbeatRun is refused");
        check(await mismatched(() => store.getRun(run.id, wrong)), "getRun by key is refused");
        check((await store.getRun(run.id, { principal: other })) === null, "getRun for another person finds nothing");
        check((await store.getRun(run.id, { principal: me }))?.id === run.id, "getRun for its owner finds it");

        const dead = await store.claimRun({ principal: me, chatId: (await store.createChat(me, { agent: "a" })).id, agent: "a", owner: "n1", ttlMs: 1 });
        await sleep(EXPIRE);
        await store.reapExpiredRuns();
        check(await mismatched(() => store.reclaimRun(dead.id, "n2", 60_000, wrong)), "reclaimRun is refused");
        check((await store.getRun(dead.id))?.status === "errored", "and the run stays as the reaper left it");

        const s = await dueSchedule(store, me);
        const c = claimedOne(await store.claimDueSchedules(Date.now(), 60_000, "n1"), s.id)[0]!;
        const patch = { nextRunAt: LATER, lastRunAt: Date.now(), enabled: true };
        check(await mismatched(() => store.completeSchedule(s.id, patch, "n1", { leaseExpiresAt: c.leaseExpiresAt! }, wrong)), "completeSchedule is refused");
        if (store.noteScheduleFire) {
          check(await mismatched(() => store.noteScheduleFire!(s.id, { lastChatId: "x", firedAt: 1 }, wrong)), "noteScheduleFire is refused");
        }
        check((await store.completeSchedule(s.id, patch, "n1", { leaseExpiresAt: c.leaseExpiresAt! }, { ownerKey: s.owner })) !== false, "the right key applies");
      },
    },

    // ── deletion (deleteChat / purgeOwner, when the adapter has them) ─────
    {
      name: "deleteChats removes the caller's chats with everything under them, and only those",
      async run({ store, principals: [me, other] }) {
        if (!store.deleteChats) return;
        const chat = await store.createChat(me, { agent: "a" });
        await store.appendMessages(chat.id, [msg("m1"), msg("m2", "answer", "assistant")]);
        const run = await store.createRun(me, { chatId: chat.id, agent: "a" });
        await store.updateRun(run.id, { status: "completed" });
        const keep = await store.createChat(me, { agent: "a" });
        await store.appendMessages(keep.id, [msg("k1")]);
        const theirs = await store.createChat(other, { agent: "a" });

        check((await store.deleteChats(other, [chat.id])).length === 0, "another owner can't delete it");
        check((await store.getChat(me, chat.id)) !== null, "and it's still there");
        const deleted = await store.deleteChats(me, [chat.id, theirs.id]);
        check(deleted.join() === chat.id, `only the caller's id is deleted (${deleted.join()})`);
        check((await store.getChat(me, chat.id)) === null, "it's gone by id");
        check(!(await store.listChats(me)).some((c) => c.id === chat.id), "and from the list");
        check((await store.loadMessages(me, chat.id)).length === 0, "its messages are gone");
        check((await store.getRun(run.id)) === null, "its runs are gone");
        check((await store.loadMessages(me, keep.id)).length === 1, "the owner's other chat is untouched");
        check((await store.getChat(other, theirs.id)) !== null, "another owner's chat is untouched");
        check((await store.deleteChats(me, [chat.id])).length === 0, "deleting again deletes nothing");
      },
    },
    {
      name: "deleteChats is all or nothing: one chat with an answer running keeps them all",
      async run({ store, principals: [me] }) {
        if (!store.deleteChats) return;
        const idle = await store.createChat(me, { agent: "a" });
        await store.appendMessages(idle.id, [msg("i1")]);
        const live = await store.createChat(me, { agent: "a" });
        const run = await store.claimRun({ principal: me, chatId: live.id, agent: "a", owner: "n1", ttlMs: 60_000 });
        const retry = await busy(() => store.deleteChats!(me, [idle.id, live.id]));
        check(retry !== null && retry > 0, `refused with ChatBusyError (${retry})`);
        check((await store.getChat(me, idle.id)) !== null && (await store.loadMessages(me, idle.id)).length === 1, "the idle chat wasn't touched either");
        check((await store.getChat(me, live.id)) !== null, "nor the live one");
        await store.updateRun(run.id, { status: "completed" });
        check((await store.deleteChats(me, [idle.id, live.id])).length === 2, "once the answer is done, both go");
      },
    },
    {
      name: "a deleted chat can't be written to: no run, message or usage lands for it",
      async run({ store, principals: [me] }) {
        if (!store.deleteChats) return;
        const chat = await store.createChat(me, { agent: "a" });
        const done = await store.createRun(me, { chatId: chat.id, agent: "a" });
        await store.updateRun(done.id, { status: "completed" });
        await store.deleteChats(me, [chat.id]);
        let usageErr: unknown;
        try {
          await store.recordUsage(me, { runId: done.id, model: "m", inputTokens: 1, outputTokens: 1, cost: 0 });
        } catch (e) {
          usageErr = e;
        }
        check(usageErr !== undefined, "recording usage for its deleted run fails");
        let runErr: unknown;
        try {
          await store.createRun(me, { chatId: chat.id, agent: "a" });
        } catch (e) {
          runErr = e;
        }
        check(runErr !== undefined, "opening a run in it fails");
        let wrote: unknown = "threw";
        try {
          wrote = await store.appendMessages(chat.id, [msg("late")]);
        } catch {
          // a refusal by throwing is fine too
        }
        check(wrote !== undefined && wrote !== true, `a message for it doesn't land (${String(wrote)})`);
        check((await store.loadMessages(me, chat.id)).length === 0, "and nothing is stored under its id");
      },
    },
    {
      name: "purgeOwner removes everything for an owner, in passes, and nothing else",
      async run({ store, principals: [me, other] }) {
        if (!store.purgeOwner) return;
        const mine = [];
        for (let i = 0; i < 3; i++) {
          const c = await store.createChat(me, { agent: "a" });
          await store.appendMessages(c.id, [msg(`m${i}`)]);
          const r = await store.createRun(me, { chatId: c.id, agent: "a" });
          await store.updateRun(r.id, { status: "completed" });
          mine.push(c);
        }
        await store.createSchedule(me, { agent: "a", cron: "0 9 * * *", prompt: "brief", nextRunAt: LATER });
        const theirs = await store.createChat(other, { agent: "a" });
        await store.appendMessages(theirs.id, [msg("t1")]);
        const theirSchedule = await store.createSchedule(other, { agent: "a", cron: "0 9 * * *", prompt: "brief", nextRunAt: LATER });

        const segments = decodeOwnerKey(mine[0]!.owner);
        const first = await store.purgeOwner(segments, { batchSize: 2, usage: "delete" });
        check(first.done === false, "a pass stops at its batch size and says so");
        let chats = first.removed.chats ?? 0;
        for (let pass = 0; pass < 10; pass++) {
          const next = await store.purgeOwner(segments, { batchSize: 2, usage: "delete" });
          chats += next.removed.chats ?? 0;
          if (next.done) break;
        }
        check(chats === 3, `every chat removed once across passes (${chats})`);
        check((await store.listChats(me)).length === 0, "the owner has no chats left");
        check((await store.listSchedules(me)).length === 0, "or schedules");
        for (const c of mine) check((await store.loadMessages(me, c.id)).length === 0, "or messages");
        check((await store.loadMessages(other, theirs.id)).length === 1, "another owner's chat is untouched");
        check((await store.listSchedules(other)).some((x) => x.id === theirSchedule.id), "and their schedule");
        const again = await store.purgeOwner(segments, { usage: "delete" });
        check(again.done && Object.values(again.removed).every((n) => n === 0), "running it again removes nothing");
      },
    },
    {
      name: "a purge fences out a run that's still going",
      async run({ store, principals: [me] }) {
        if (!store.purgeOwner) return;
        const chat = await store.createChat(me, { agent: "a" });
        const run = await store.claimRun({ principal: me, chatId: chat.id, agent: "a", owner: "n1", ttlMs: 60_000 });
        const fence = fenceOf(run, "n1");
        for (let pass = 0; pass < 10; pass++) if ((await store.purgeOwner(decodeOwnerKey(chat.owner), { usage: "delete" })).done) break;
        check((await store.appendMessages(chat.id, [msg("late", "late", "assistant")], fence)) === false, "the worker's next write is refused");
        check(!(await store.heartbeatRun(run.id, "n1", 60_000, fence.fencingToken)), "and so is its heartbeat");
        check((await store.loadMessages(me, chat.id)).length === 0, "nothing came back");
      },
    },

    // ── held inputs (the queue, when the adapter has it) ──────────────────
    {
      name: "held inputs are kept apart from the conversation, oldest first, and leave by id",
      async run({ store, principals: [me, other] }) {
        if (!store.enqueueInput || !store.listQueuedInputs || !store.removeQueuedInputs) return;
        const chat = await store.createChat(me, { agent: "a" });
        const cap = { cap: 5 };
        // Ids that sort against arrival, held in the same instant: arrival wins.
        check(await store.enqueueInput(me, chat.id, msg("q1", "z"), cap), "the first is held");
        check(await store.enqueueInput(me, chat.id, msg("a0", "a"), cap), "and the second");
        check((await store.removeQueuedInputs(chat.id, ["a0"], { ownerKey: chat.owner })).join() === "a0", "one taken back");
        check(await store.enqueueInput(me, chat.id, msg("q2"), cap), "and another held");
        check((await store.loadMessages(me, chat.id)).length === 0, "the conversation doesn't have them");
        const held = await store.listQueuedInputs(me, chat.id);
        check(held.map((q) => q.message.id).join() === "q1,q2", `in the order they arrived (${held.map((q) => q.message.id).join()})`);
        check(held[0]!.message.role === "user" && (held[0]!.message.parts[0] as { text?: string }).text === "z", "the message comes back as given");
        check(held[0]!.identity !== undefined, "with the principal that sent it");

        check(await store.enqueueInput(me, chat.id, msg("q1", "again"), cap), "a retry of one held is accepted");
        const after = await store.listQueuedInputs(me, chat.id);
        check(after.map((q) => q.message.id).join() === "q1,q2", "and keeps its place, held once");

        check(!(await store.enqueueInput(other, chat.id, msg("x1"), cap)), "another owner can't add to it");
        check((await store.listQueuedInputs(other, chat.id)).length === 0, "or read it");

        const gone = await store.removeQueuedInputs(chat.id, ["q1", "nope"], { ownerKey: chat.owner });
        check(gone.join() === "q1", `only what was held is reported removed (${gone.join()})`);
        check((await store.listQueuedInputs(me, chat.id)).map((q) => q.message.id).join() === "q2", "the rest stays");
      },
    },
    {
      name: "chats with inputs held for a while are listed for the cron tick, longest-waiting first",
      async run({ store, principals: [me, other] }) {
        if (!store.enqueueInput || !store.listChatsWithQueuedInputs || !store.removeQueuedInputs) return;
        const first = await store.createChat(me, { agent: "a" });
        const second = await store.createChat(other, { agent: "a" });
        await store.enqueueInput(me, first.id, msg("q1"), { cap: 5 });
        await new Promise((r) => setTimeout(r, 5));
        await store.enqueueInput(me, first.id, msg("q2"), { cap: 5 });
        await store.enqueueInput(other, second.id, msg("q3"), { cap: 5 });
        const later = Date.now() + 1000;
        const held = await store.listChatsWithQueuedInputs({ heldBefore: later, limit: 10 });
        check(held.map((h) => h.chatId).join() === [first.id, second.id].join(), "one row per chat, across owners, oldest first");
        check(held[0]!.identity !== undefined, "with the identity of its oldest input");
        const many = await store.createChat(me, { agent: "a" });
        for (let i = 0; i < 6; i++) await store.enqueueInput(me, many.id, msg(`m${i}`), { cap: 10 });
        const all = await store.listChatsWithQueuedInputs({ heldBefore: later, limit: 3 });
        check(all.length === 3, `limit counts chats, however many inputs each holds (${all.length})`);
        await store.removeQueuedInputs(many.id, ["m0", "m1", "m2", "m3", "m4", "m5"], { ownerKey: many.owner });
        check((await store.listChatsWithQueuedInputs({ heldBefore: 1, limit: 10 })).length === 0, "nothing held before then");
        // Each call marks what it returned as looked at, so a chat that can't
        // start a turn (waiting on a person) never keeps the others out.
        const turns = [
          (await store.listChatsWithQueuedInputs({ heldBefore: later, limit: 1 }))[0]?.chatId,
          (await store.listChatsWithQueuedInputs({ heldBefore: later, limit: 1 }))[0]?.chatId,
        ];
        check(new Set(turns).size === 2, `two calls of one chat each reach both chats (${turns.join()})`);
        await store.removeQueuedInputs(first.id, ["q1", "q2"], { ownerKey: first.owner });
        const rest = await store.listChatsWithQueuedInputs({ heldBefore: later, limit: 10 });
        check(rest.map((h) => h.chatId).join() === second.id, "a chat with nothing held is not listed");
      },
    },
    {
      name: "a run takes everything held in one step, and what it took is no longer waiting",
      async run({ store, principals: [me] }) {
        if (!store.enqueueInput || !store.listQueuedInputs || !store.removeQueuedInputs) return;
        if (!store.takeQueuedInputs || !store.returnQueuedInputs || !store.finishQueuedInputs) return;
        const chat = await store.createChat(me, { agent: "a" });
        const scope = { ownerKey: chat.owner };
        await store.enqueueInput(me, chat.id, msg("q1"), { cap: 2 });
        await store.enqueueInput(me, chat.id, msg("q2"), { cap: 2 });
        await store.enqueueInput(me, chat.id, msg("q2", "revised"), { cap: 2 });

        const taken = await store.takeQueuedInputs(chat.id, "run_1", scope);
        check(taken.map((q) => q.message.id).join() === "q1,q2", `everything held, in arrival order (${taken.map((q) => q.message.id).join()})`);
        check((taken[1]!.message.parts[0] as { text?: string }).text === "revised", "as last replaced");
        check((await store.listQueuedInputs(me, chat.id)).every((q) => q.takenBy === "run_1"), "listed as taken by that run");
        check((await store.removeQueuedInputs(chat.id, ["q1"], scope)).length === 0, "one being answered can't be taken back");
        check(await store.enqueueInput(me, chat.id, msg("q2", "too late"), { cap: 2 }), "a retry of one being answered is accepted");
        check(await store.enqueueInput(me, chat.id, msg("q3"), { cap: 2 }), "and there is room again: taken ones don't count");
        check(await store.enqueueInput(me, chat.id, msg("q4"), { cap: 2 }), "up to the cap");
        check(!(await store.enqueueInput(me, chat.id, msg("q5"), { cap: 2 })), "and no further");

        await store.finishQueuedInputs(chat.id, "run_1", scope);
        const left = await store.listQueuedInputs(me, chat.id);
        check(left.map((q) => q.message.id).join() === "q3,q4" && left.every((q) => !q.takenBy), "finishing removes what the run took, and only that");

        // A turn that could not start gives them back, in their places.
        await store.takeQueuedInputs(chat.id, "run_2", scope);
        await store.returnQueuedInputs(chat.id, "run_2", scope);
        const back = await store.listQueuedInputs(me, chat.id);
        check(back.map((q) => q.message.id).join() === "q3,q4" && back.every((q) => !q.takenBy), "returned inputs wait again, in order");
        check((await store.removeQueuedInputs(chat.id, ["q3"], scope)).join() === "q3", "and can be taken back again");

        // A run that died holding some: the next run to take gets them too.
        await store.takeQueuedInputs(chat.id, "run_dead", scope);
        const next = await store.takeQueuedInputs(chat.id, "run_3", scope);
        check(next.map((q) => q.message.id).join() === "q4" && next[0]!.takenBy === "run_3", "a later run takes what a dead one held");
      },
    },
    {
      name: "a chat never holds more inputs than the cap",
      async run({ store, principals: [me] }) {
        if (!store.enqueueInput || !store.listQueuedInputs) return;
        const chat = await store.createChat(me, { agent: "a" });
        check(await store.enqueueInput(me, chat.id, msg("q1"), { cap: 2 }), "one");
        check(await store.enqueueInput(me, chat.id, msg("q2"), { cap: 2 }), "two");
        check(!(await store.enqueueInput(me, chat.id, msg("q3"), { cap: 2 })), "the third is refused");
        check((await store.listQueuedInputs(me, chat.id)).length === 2, "and not stored");
        check(await store.enqueueInput(me, chat.id, msg("q2", "again"), { cap: 2 }), "a retry of one held still fits");
        // Many at once for the places left: never one too many, none lost.
        const busy = await store.createChat(me, { agent: "a" });
        const results = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => store.enqueueInput!(me, busy.id, msg(`c${i}`), { cap: 3 })));
        const kept = await store.listQueuedInputs(me, busy.id);
        check(kept.length <= 3, `the cap holds under concurrent calls (${kept.length})`);
        check(kept.length === results.filter(Boolean).length, "and every call told accepted is held");
        // The same new id twice at once, for the last place: both are told it is held.
        const last = await store.createChat(me, { agent: "a" });
        await store.enqueueInput(me, last.id, msg("l1"), { cap: 2 });
        const twice = await Promise.all([0, 1].map(() => store.enqueueInput!(me, last.id, msg("l2"), { cap: 2 })));
        check(twice.every(Boolean), `a retry racing its first call is accepted, not refused as full (${twice.join()})`);
        check((await store.listQueuedInputs(me, last.id)).length === 2, "and held once");
        check(await store.enqueueInput(me, last.id, msg("l2", "again"), { cap: 2 }), "a retry of one held is accepted on a full queue");
      },
    },
    {
      name: "deleting a chat removes its held inputs",
      async run({ store, principals: [me] }) {
        if (!store.enqueueInput || !store.listQueuedInputs || !store.deleteChats) return;
        const chat = await store.createChat(me, { agent: "a" });
        await store.enqueueInput(me, chat.id, msg("q1"), { cap: 5 });
        await store.deleteChats(me, [chat.id]);
        const again = await store.createChat(me, { id: chat.id, agent: "a" });
        check((await store.listQueuedInputs(me, again.id)).length === 0, "a new chat under the same id starts with none");
        await store.deleteChats(me, [again.id]);
        check(!(await store.enqueueInput(me, chat.id, msg("q2"), { cap: 5 })), "nothing is held for a chat that is gone");
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
