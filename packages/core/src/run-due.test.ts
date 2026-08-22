import { describe, expect, it } from "vitest";
import { createRuntime } from "./runtime.js";
import { defineContext } from "./context.js";
import type { ScheduleRecord, StorageAdapter } from "./storage.js";

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
    runSchedule?: (input: { schedule: ScheduleRecord; principal: P }) => Promise<boolean>;
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
    expect(res).toEqual({ fired: 1, errors: 0 });
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
    expect(res).toEqual({ fired: 0, errors: 1 });
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

    expect(res).toEqual({ fired: 0, errors: 1 });
    expect(consumed).toBe(1); // consumed exactly once — never re-written after the failure
  });
});
