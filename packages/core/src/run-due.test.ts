import { describe, expect, it } from "vitest";
import { createRuntime } from "./runtime.js";
import { defineContext } from "./context.js";
import type { ScheduleRecord, StorageAdapter } from "./storage.js";
import type { AppMessage } from "./message.js";

/**
 * The occurrence-consumption contract of `runDue`, which is what stands
 * between a scheduled agent and a duplicate paid turn:
 *
 *   claim → CONSUME (completeSchedule advances nextRunAt) → fire
 *
 * The schedule claim lease is stamped once and never renewed, so during a fire
 * longer than the lease TTL the row would still read as due — any concurrent
 * claimer (second node, deploy overlap, the POST /cron/run backstop, this same
 * instance's next tick) would fire the same occurrence again. Consuming it
 * before the fire is the only thing that prevents that; these tests pin the
 * ordering so a refactor can't quietly move the advance back into a `finally`.
 *
 * `runSchedule` hosts the fire so no model or chat machinery is needed.
 */

type P = { orgId: string };

const SCHEDULE: ScheduleRecord = {
  id: "sch_1",
  owner: "org_a",
  agent: "digest",
  identity: { orgId: "org_a" },
  cron: "0 8 * * *",
  prompt: "daily digest",
  nextRunAt: 0,
  enabled: true,
  createdAt: 0,
};

/** A storage stub that throws on anything runDue shouldn't touch. */
function stubStorage(overrides: Partial<StorageAdapter<P>>): {
  storage: StorageAdapter<P>;
  calls: string[];
} {
  const calls: string[] = [];
  const base = new Proxy({} as StorageAdapter<P>, {
    get(_t, prop: string) {
      if (prop in overrides) {
        return (...args: unknown[]) => {
          calls.push(prop);
          return (overrides[prop as keyof StorageAdapter<P>] as (...a: unknown[]) => unknown)(
            ...args,
          );
        };
      }
      return () => {
        throw new Error(`storage.${prop} should not be called by this path`);
      };
    },
  });
  return { storage: base, calls };
}

function runtimeWith(
  storage: StorageAdapter<P>,
  opts: {
    cron?: (expr: string, afterMs: number) => number | null;
    runSchedule?: (input: {
      schedule: ScheduleRecord;
      principal: P;
    }) => Promise<boolean | { handled: boolean; chatId?: string; parked?: boolean }>;
  },
) {
  return createRuntime<P>({
    storage,
    context: defineContext<P, unknown>({ build: async () => ({}) }),
    agents: {},
    cron: opts.cron,
    runSchedule: opts.runSchedule,
  });
}

describe("runDue consumes the occurrence before firing", () => {
  it("advances nextRunAt via completeSchedule BEFORE the fire, keeping the cron alive", async () => {
    const NEXT = 1_000_000;
    let advanced: { nextRunAt: number; enabled: boolean } | undefined;
    const order: string[] = [];
    const { storage } = stubStorage({
      claimDueSchedules: async () => [SCHEDULE],
      completeSchedule: async (_id, patch) => {
        order.push("consume");
        advanced = patch as typeof advanced;
      },
    });
    const rt = runtimeWith(storage, {
      cron: () => NEXT,
      runSchedule: async () => {
        order.push("fire");
        return true;
      },
    });

    const res = await rt.runDue({ now: 100 });

    expect(order).toEqual(["consume", "fire"]);
    expect(advanced).toEqual({ nextRunAt: NEXT, lastRunAt: 100, enabled: true });
    expect(res).toEqual({ fired: 1, errors: 0, skipped: 0, parked: 0 });
  });

  it("disables a one-shot (cron: null) at consume time", async () => {
    let advanced: { enabled: boolean } | undefined;
    const { storage } = stubStorage({
      claimDueSchedules: async () => [{ ...SCHEDULE, cron: null }],
      completeSchedule: async (_id, patch) => {
        advanced = patch as typeof advanced;
      },
    });
    const rt = runtimeWith(storage, { runSchedule: async () => true });

    await rt.runDue({ now: 100 });

    expect(advanced?.enabled).toBe(false);
  });

  it("does NOT fire when the occurrence cannot be consumed", async () => {
    // Firing anyway would leave the row due — every subsequent tick would
    // fire it again. Skip, count the error, let the next tick retry cleanly.
    let firedHook = false;
    const { storage } = stubStorage({
      claimDueSchedules: async () => [SCHEDULE],
      completeSchedule: async () => {
        throw new Error("db down");
      },
    });
    const rt = runtimeWith(storage, {
      cron: () => 1_000_000,
      runSchedule: async () => {
        firedHook = true;
        return true;
      },
    });

    const res = await rt.runDue({ now: 100 });

    expect(firedHook).toBe(false);
    expect(res).toEqual({ fired: 0, errors: 1, skipped: 0, parked: 0 });
  });

  it("stamps the fire's chat via noteScheduleFire so the next occurrence can see it", async () => {
    // The default path errors later (agent "digest" isn't registered), but the
    // stamp happens between createChat and the turn — assert it regardless.
    const stamps: unknown[] = [];
    const { storage } = stubStorage({
      claimDueSchedules: async () => [SCHEDULE],
      completeSchedule: async () => {},
      createChat: async () => ({
        id: "chat_new",
        owner: "org_a",
        agent: "digest",
        createdAt: 0,
        updatedAt: 0,
      }),
      noteScheduleFire: async (id: string, patch: unknown) => {
        stamps.push([id, patch]);
      },
    });
    const rt = runtimeWith(storage, { cron: () => 1_000_000, runSchedule: async () => false });

    await rt.runDue({ now: 100 });

    // firedAt = the lastRunAt completeSchedule wrote (the runDue `now`), so
    // the adapter can fence the stamp to THIS occurrence.
    expect(stamps).toEqual([["sch_1", { lastChatId: "chat_new", firedAt: 100 }]]);
  });

  it("a failed fire is an error, but the occurrence stays consumed (no repeat)", async () => {
    let consumed = 0;
    const { storage } = stubStorage({
      claimDueSchedules: async () => [SCHEDULE],
      completeSchedule: async () => {
        consumed++;
      },
      // runSchedule returns false → default path → createChat blows up.
      createChat: async () => {
        throw new Error("chat create failed");
      },
    });
    const rt = runtimeWith(storage, {
      cron: () => 1_000_000,
      runSchedule: async () => false,
    });

    const res = await rt.runDue({ now: 100 });

    expect(res).toEqual({ fired: 0, errors: 1, skipped: 0, parked: 0 });
    expect(consumed).toBe(1); // consumed exactly once — never re-written after the failure
  });
});

describe("onParked: the parked-predecessor guard", () => {
  /** A chat whose last message carries an undecided approval — a parked turn. */
  const PARKED_MESSAGES = [
    { id: "m1", role: "user", parts: [{ type: "text", text: "daily digest" }] },
    {
      id: "m2",
      role: "assistant",
      parts: [
        {
          type: "tool-execute_tool",
          toolCallId: "tc_1",
          state: "approval-requested",
          approval: { id: "ap_1" },
        },
      ],
    },
  ] as unknown as AppMessage[];
  const PARKED_SCHEDULE = { ...SCHEDULE, lastChatId: "chat_prev" };

  it("skips the occurrence (consumed, not fired) while the last fire's chat is parked", async () => {
    let consumed = 0;
    const { storage } = stubStorage({
      claimDueSchedules: async () => [PARKED_SCHEDULE],
      completeSchedule: async () => {
        consumed++;
      },
      loadMessages: async () => PARKED_MESSAGES,
    });
    let firedHook = false;
    const rt = runtimeWith(storage, {
      cron: () => 1_000_000,
      runSchedule: async () => {
        firedHook = true;
        return true;
      },
    });

    const res = await rt.runDue({ now: 100 });

    expect(res).toEqual({ fired: 0, errors: 0, skipped: 1, parked: 0 });
    expect(firedHook).toBe(false); // the host hook is skipped too — nothing runs
    expect(consumed).toBe(1); // the occurrence is spent, so the row isn't hot-looped
  });

  it('onParked: "fire" opts out — never even reads the previous chat', async () => {
    // loadMessages is NOT stubbed: the Proxy throws if the check runs at all.
    const { storage } = stubStorage({
      claimDueSchedules: async () => [{ ...PARKED_SCHEDULE, onParked: "fire" as const }],
      completeSchedule: async () => {},
    });
    const rt = runtimeWith(storage, { cron: () => 1_000_000, runSchedule: async () => true });

    const res = await rt.runDue({ now: 100 });

    expect(res).toEqual({ fired: 1, errors: 0, skipped: 0, parked: 0 });
  });

  it("a settled predecessor fires normally", async () => {
    const { storage } = stubStorage({
      claimDueSchedules: async () => [PARKED_SCHEDULE],
      completeSchedule: async () => {},
      // The approval was decided — the fold says "not pending".
      loadMessages: async () =>
        [
          {
            id: "m2",
            role: "assistant",
            parts: [
              {
                type: "tool-execute_tool",
                toolCallId: "tc_1",
                state: "approval-requested",
                approval: { id: "ap_1", approved: true },
              },
            ],
          },
        ] as unknown as AppMessage[],
    });
    const rt = runtimeWith(storage, { cron: () => 1_000_000, runSchedule: async () => true });

    const res = await rt.runDue({ now: 100 });

    expect(res).toEqual({ fired: 1, errors: 0, skipped: 0, parked: 0 });
  });

  it("a failed parked-check never blocks the fire", async () => {
    const { storage } = stubStorage({
      claimDueSchedules: async () => [PARKED_SCHEDULE],
      completeSchedule: async () => {},
      loadMessages: async () => {
        throw new Error("db hiccup");
      },
    });
    const rt = runtimeWith(storage, { cron: () => 1_000_000, runSchedule: async () => true });

    const res = await rt.runDue({ now: 100 });

    expect(res).toEqual({ fired: 1, errors: 0, skipped: 0, parked: 0 });
  });
});

describe("a runSchedule host can join the same accounting", () => {
  it("stamps the host's chatId and counts its parked fire", async () => {
    const stamps: unknown[] = [];
    const { storage } = stubStorage({
      claimDueSchedules: async () => [SCHEDULE],
      completeSchedule: async () => {},
      noteScheduleFire: async (id: string, patch: unknown) => {
        stamps.push([id, patch]);
      },
    });
    const rt = runtimeWith(storage, {
      cron: () => 1_000_000,
      // The host owns the channel conversation, so it is the only one that can
      // report which chat this fire ran in and whether it stopped for a human.
      runSchedule: async () => ({ handled: true, chatId: "chat_slack_thread", parked: true }),
    });

    const res = await rt.runDue({ now: 100 });

    expect(res).toEqual({ fired: 1, errors: 0, skipped: 0, parked: 1 });
    expect(stamps).toEqual([["sch_1", { lastChatId: "chat_slack_thread", firedAt: 100 }]]);
  });

  it("a bare `true` is still handled — and simply isn't accounted", async () => {
    // storage.noteScheduleFire is NOT stubbed: the Proxy throws if core tries
    // to stamp a chat the host never told it about.
    const { storage } = stubStorage({
      claimDueSchedules: async () => [SCHEDULE],
      completeSchedule: async () => {},
    });
    const rt = runtimeWith(storage, { cron: () => 1_000_000, runSchedule: async () => true });

    expect(await rt.runDue({ now: 100 })).toEqual({
      fired: 1,
      errors: 0,
      skipped: 0,
      parked: 0,
    });
  });

  it("{ handled: false } falls through to the default path, like `false`", async () => {
    let created = 0;
    const { storage } = stubStorage({
      claimDueSchedules: async () => [SCHEDULE],
      completeSchedule: async () => {},
      createChat: async () => {
        created++;
        throw new Error("stop here — reaching createChat proves the fall-through");
      },
    });
    const rt = runtimeWith(storage, {
      cron: () => 1_000_000,
      runSchedule: async () => ({ handled: false }),
    });

    await rt.runDue({ now: 100 });
    expect(created).toBe(1);
  });
});
