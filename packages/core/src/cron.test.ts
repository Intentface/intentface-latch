import { describe, expect, it } from "vitest";
import { createRuntime } from "./runtime.js";
import { defineContext } from "./context.js";
import type { RunRecord, StorageAdapter } from "./storage.js";

/**
 * `cron()` = runDue, then (durability on) sweep — phases isolated, failures
 * reported not thrown. These pin the composition without a model: the
 * storage stub answers the scheduling and reaping queries and nothing else.
 */

type P = { orgId: string };

function stub(overrides: Partial<StorageAdapter<P>>, calls: string[]): StorageAdapter<P> {
  return new Proxy({} as StorageAdapter<P>, {
    get(_t, prop: string) {
      if (prop in overrides) {
        return (...args: unknown[]) => {
          calls.push(prop);
          return (overrides[prop as keyof StorageAdapter<P>] as (...a: unknown[]) => unknown)(...args);
        };
      }
      return () => {
        throw new Error(`storage.${prop} should not be called by this path`);
      };
    },
  });
}

const reapedRun: RunRecord = {
  id: "run_dead",
  chatId: "chat_1",
  agent: "digest",
  status: "errored",
  startedAt: 0,
  attempt: 9, // ≥ maxAttempts → sweep reaps but does not resume
} as RunRecord;

describe("runtime.cron()", () => {
  it("runs runDue then sweep, and returns both results", async () => {
    const calls: string[] = [];
    const storage = stub(
      {
        claimDueSchedules: async () => [],
        reapExpiredRuns: async () => [reapedRun],
      },
      calls,
    );
    const rt = createRuntime<P>({
      storage,
      context: defineContext<P, unknown>({ build: async () => ({}) }),
      agents: {},
      durability: { enabled: true },
    });
    const out = await rt.cron({ maxAttempts: 5 });
    expect(out.due).toEqual({ fired: 0, errors: 0, skipped: 0, parked: 0, rejected: 0 });
    expect(out.reaped).toEqual([reapedRun]);
    expect(out.resumed).toEqual([]); // poison cap: attempt 9 ≥ 5
    expect(out.errors).toEqual([]);
    expect(calls).toEqual(["claimDueSchedules", "reapExpiredRuns"]);
  });

  it("without durability there is nothing to sweep", async () => {
    const calls: string[] = [];
    const storage = stub({ claimDueSchedules: async () => [] }, calls);
    const rt = createRuntime<P>({
      storage,
      context: defineContext<P, unknown>({ build: async () => ({}) }),
      agents: {},
    });
    const out = await rt.cron();
    expect(out).toEqual({ due: { fired: 0, errors: 0, skipped: 0, parked: 0, rejected: 0 }, reaped: [], resumed: [], errors: [] });
    expect(calls).toEqual(["claimDueSchedules"]);
  });

  it("a failing phase is reported and does not stop the other", async () => {
    const calls: string[] = [];
    const storage = stub(
      {
        claimDueSchedules: async () => {
          throw new Error("db down");
        },
        reapExpiredRuns: async () => [],
      },
      calls,
    );
    const rt = createRuntime<P>({
      storage,
      context: defineContext<P, unknown>({ build: async () => ({}) }),
      agents: {},
      durability: { enabled: true },
    });
    const out = await rt.cron();
    expect(out.errors).toEqual(["runDue: db down"]);
    expect(out.reaped).toEqual([]);
    expect(calls).toEqual(["claimDueSchedules", "reapExpiredRuns"]);
  });

  it("tick is gone; runDue, sweep and resume remain as the halves", () => {
    const rt = createRuntime<P>({
      storage: stub({}, []),
      context: defineContext<P, unknown>({ build: async () => ({}) }),
      agents: {},
    });
    expect((rt as unknown as Record<string, unknown>).tick).toBeUndefined();
    expect((rt as unknown as Record<string, unknown>).runTurnStream).toBeUndefined();
    expect(typeof rt.runDue).toBe("function");
    expect(typeof rt.sweep).toBe("function");
    expect(typeof rt.resume).toBe("function");
  });
});
