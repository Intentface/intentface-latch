import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { createRuntime } from "./runtime.js";
import { defineContext } from "./context.js";
import { defineAgent } from "./agent.js";
import type { AppMessage } from "./message.js";
import type { ReconstructPrincipal } from "./principal.js";
import type { RunRecord, ScheduleRecord, StorageAdapter } from "./storage.js";

/**
 * `reconstructPrincipal` returning `null` REFUSES a stored identity — the user
 * was removed from the tenant, or their account is gone, since the run or
 * schedule was created. The replay paths make that terminal:
 *
 *   - cron fire → not fired, and the schedule is DISABLED in the same write that
 *     consumes the occurrence (a schedule that can never run again must stop,
 *     not refuse silently on every tick);
 *   - resume → the run ends `errored`, without anything running as the refused
 *     identity, and `sweep` carries on with the next run.
 *
 * A THROW keeps meaning "transient failure": an error for that occurrence, and
 * the schedule stays live.
 */

type P = { userId: string };

const REVOKED = "u_removed";
/** The host's validating hook: one identity is no longer allowed to act. */
const refuseRevoked: ReconstructPrincipal<P> = async (identity) =>
  (identity as P).userId === REVOKED ? null : (identity as P);

/** Storage that throws on anything the path under test shouldn't touch. */
function stubStorage(overrides: Partial<StorageAdapter<P>>): {
  storage: StorageAdapter<P>;
  calls: string[];
} {
  const calls: string[] = [];
  const storage = new Proxy({} as StorageAdapter<P>, {
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
  return { storage, calls };
}

const schedule = (id: string, userId: string): ScheduleRecord => ({
  id,
  owner: userId,
  agent: "digest",
  identity: { userId },
  cron: "0 8 * * *",
  prompt: "daily digest",
  nextRunAt: 0,
  enabled: true,
  createdAt: 0,
});

describe("runDue: a refused principal", () => {
  function cronRuntime(
    schedules: ScheduleRecord[],
    reconstructPrincipal: ReconstructPrincipal<P>,
  ) {
    const consumed = new Map<string, { nextRunAt: number; enabled: boolean }>();
    const fired: Array<{ id: string; principal: P }> = [];
    const { storage } = stubStorage({
      claimDueSchedules: async () => schedules,
      completeSchedule: async (id, patch) => {
        consumed.set(id, patch);
      },
    });
    const runtime = createRuntime<P>({
      storage,
      context: defineContext<P, unknown>({ build: async () => ({}) }),
      agents: {},
      cron: () => 1_000_000,
      reconstructPrincipal,
      runSchedule: async ({ schedule: s, principal }) => {
        fired.push({ id: s.id, principal });
        return true;
      },
    });
    return { runtime, consumed, fired };
  }

  it("is not fired, and its schedule is disabled in the consuming write", async () => {
    const { runtime, consumed, fired } = cronRuntime(
      [schedule("sch_revoked", REVOKED)],
      refuseRevoked,
    );

    const res = await runtime.runDue({ now: 100 });

    expect(fired).toEqual([]);
    // Still consumed (nextRunAt advanced), but no longer enabled: a cron that
    // would otherwise live forever stops here.
    expect(consumed.get("sch_revoked")).toEqual({
      nextRunAt: 1_000_000,
      lastRunAt: 100,
      enabled: false,
    });
    // Its own counter, not an error: nothing broke.
    expect(res).toEqual({ fired: 0, errors: 0, skipped: 0, parked: 0, rejected: 1 });
  });

  it("does not stop the other schedules in the same tick", async () => {
    const { runtime, consumed, fired } = cronRuntime(
      [schedule("sch_revoked", REVOKED), schedule("sch_ok", "u_member")],
      refuseRevoked,
    );

    const res = await runtime.runDue({ now: 100 });

    expect(fired).toEqual([{ id: "sch_ok", principal: { userId: "u_member" } }]);
    expect(consumed.get("sch_ok")?.enabled).toBe(true);
    expect(res).toMatchObject({ fired: 1, rejected: 1, errors: 0 });
  });

  it("a refused one-shot is spent, not fired", async () => {
    const { runtime, consumed, fired } = cronRuntime(
      [{ ...schedule("sch_once", REVOKED), cron: null }],
      refuseRevoked,
    );

    const res = await runtime.runDue({ now: 100 });

    expect(fired).toEqual([]);
    expect(consumed.get("sch_once")).toEqual({ nextRunAt: 100, lastRunAt: 100, enabled: false });
    expect(res).toMatchObject({ fired: 0, rejected: 1, errors: 0 });
  });

  it("a hook that THROWS stays transient: an error, the occurrence consumed, the schedule live", async () => {
    const { runtime, consumed, fired } = cronRuntime([schedule("sch_1", "u_member")], () => {
      throw new Error("identity lookup unavailable");
    });

    const res = await runtime.runDue({ now: 100 });

    expect(fired).toEqual([]);
    expect(consumed.get("sch_1")).toEqual({ nextRunAt: 1_000_000, lastRunAt: 100, enabled: true });
    expect(res).toEqual({ fired: 0, errors: 1, skipped: 0, parked: 0, rejected: 0 });
  });
});

describe("resumeRun / sweep: a refused principal", () => {
  const msg = (
    role: "user" | "assistant",
    parts: Array<{ type: string } & Record<string, unknown>>,
  ): AppMessage => ({ id: `m_${role}`, role, parts }) as AppMessage;
  /** A finished turn: resuming it settles the row without calling the model. */
  const FINISHED = [
    msg("user", [{ type: "text", text: "what is it?" }]),
    msg("assistant", [{ type: "step-start" }, { type: "text", text: "It is 4." }]),
  ];
  const forbiddenModel = () =>
    new MockLanguageModelV4({
      modelId: "mock-model",
      doStream: (async () => {
        throw new Error("no model call is expected on this path");
      }) as never,
    });
  const run = (id: string, userId: string): RunRecord => ({
    id,
    chatId: `chat_${id}`,
    agent: "assistant",
    status: "active",
    identity: { userId },
    fencingToken: 3,
    attempt: 2,
    startedAt: 1000,
  });

  function resumeRuntime(runs: RunRecord[], reconstructPrincipal = refuseRevoked) {
    const rows = new Map(runs.map((r) => [r.id, { ...r }]));
    const patches: Array<{ id: string; patch: Partial<RunRecord>; guard: unknown }> = [];
    const loadedAs: P[] = [];
    const { storage } = stubStorage({
      reapExpiredRuns: async () => runs,
      reclaimRun: async (id) => rows.get(id) ?? null,
      getRun: async (id) => rows.get(id) ?? null,
      listRuns: async () => [...rows.values()],
      loadMessages: async (principal) => {
        loadedAs.push(principal);
        return structuredClone(FINISHED);
      },
      updateRun: async (id, patch, guard) => {
        patches.push({ id, patch, guard });
        rows.set(id, { ...rows.get(id)!, ...patch });
        return true;
      },
    });
    const runtime = createRuntime<P, Record<string, never>>({
      storage,
      context: defineContext<P, Record<string, never>>({ build: () => ({}) }),
      agents: {
        assistant: defineAgent(() => ({ model: forbiddenModel(), instructions: "be brief" })),
      },
      reconstructPrincipal,
      durability: { enabled: true, instanceId: "node_a" },
    });
    return { runtime, patches, loadedAs };
  }

  it("ends the run errored, fenced, without reading anything as the refused identity", async () => {
    const { runtime, patches, loadedAs } = resumeRuntime([run("run_revoked", REVOKED)]);

    const outcome = await runtime.resume("run_revoked");

    expect(outcome).toEqual({ runId: "run_revoked", status: "errored", attempt: 2 });
    expect(patches).toEqual([
      {
        id: "run_revoked",
        patch: {
          status: "errored",
          error: expect.stringContaining("principal rejected"),
          endedAt: expect.any(Number),
          // Terminal: the reclaim's lease is released, so the row can't be
          // reclaimed (and re-refused) once it would have lapsed.
          leaseOwner: null,
          leaseExpiresAt: null,
        },
        // Fenced like every terminal write: a newer owner of the lease decides.
        guard: { owner: "node_a", fencingToken: 3 },
      },
    ]);
    expect(loadedAs).toEqual([]);
  });

  it("does not abort the sweep: the next reaped run still resumes", async () => {
    const { runtime, loadedAs } = resumeRuntime([
      run("run_revoked", REVOKED),
      run("run_ok", "u_member"),
    ]);

    const { resumed } = await runtime.sweep();

    expect(resumed).toEqual([
      { runId: "run_revoked", status: "errored", attempt: 2 },
      { runId: "run_ok", status: "completed", attempt: 2 },
    ]);
    expect(loadedAs).toEqual([{ userId: "u_member" }]);
  });

  it("a hook that THROWS on one run does not strand the rest of the sweep", async () => {
    // The reaper marks the whole batch `errored` in one write and never selects
    // those rows again, so an escaping throw would leave every later run
    // unrecovered. The run that threw stays reclaimed (active, leased) and is
    // retried once that lease lapses.
    const { runtime, loadedAs, patches } = resumeRuntime(
      [run("run_blip", "u_blip"), run("run_ok", "u_member")],
      async (identity) => {
        if ((identity as P).userId === "u_blip") throw new Error("membership lookup unavailable");
        return identity as P;
      },
    );

    const { resumed } = await runtime.sweep();

    expect(resumed).toEqual([{ runId: "run_ok", status: "completed", attempt: 2 }]);
    expect(loadedAs).toEqual([{ userId: "u_member" }]);
    // Transient, not terminal: nothing wrote the blipped run off.
    expect(patches.filter((p) => p.id === "run_blip")).toEqual([]);
  });
});
