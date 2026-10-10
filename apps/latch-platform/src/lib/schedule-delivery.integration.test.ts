import { createClient } from "@libsql/client";
import type { Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime, ScheduleRecord } from "@intentface/latch-core";
import { tool } from "ai";
import { z } from "zod";
import { createRuntime, defineAgent, defineContext } from "@intentface/latch-core";
import { createSqliteAdapter, migrate, schema } from "@intentface/latch-drizzle";

/**
 * The cron → channel seam, end to end over real sqlite: `runDue` offers each
 * fire to the host's `runSchedule` hook, and only falls back to its own
 * fresh-chat run when the host declines. Everything channel-specific is the
 * host's business, so the hook here is a spy.
 */

type P = { orgId: string; userId: string };
const principal: P = { orgId: "org", userId: "user" };
const other: P = { orgId: "org", userId: "someone-else" };

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const textStream = (text: string) =>
  new ReadableStream({
    start(c) {
      for (const p of [
        { type: "stream-start", warnings: [] },
        { type: "response-metadata", id: "r", modelId: "mock", timestamp: new Date(0) },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: text },
        { type: "text-end", id: "t1" },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
      ])
        c.enqueue(p);
      c.close();
    },
  });

let client: Client;

/**
 * A runtime whose agent always calls an approval-gated tool — so a scheduled
 * fire runs, spends its tokens, and stops waiting on a human. This is finding
 * 1.1's remaining half: the turn "completed" as far as the stream is
 * concerned, but no answer was produced and nobody is there to approve.
 */
function buildParking(telemetry?: Record<string, unknown>) {
  const gateStream = () =>
    new ReadableStream({
      start(c) {
        for (const p of [
          { type: "stream-start", warnings: [] },
          { type: "response-metadata", id: "r", modelId: "mock", timestamp: new Date(0) },
          {
            type: "tool-call",
            toolCallId: "tc_1",
            toolName: "gated",
            input: JSON.stringify({ n: 1 }),
          },
          { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage },
        ])
          c.enqueue(p);
        c.close();
      },
    });
  const model = new MockLanguageModelV3({ doStream: async () => ({ stream: gateStream() }) });
  const db = drizzle(client, { schema });
  return createRuntime<P, { orgId: string }>({
    storage: createSqliteAdapter<P>(db, { owner: (p) => [p.orgId, p.userId] }),
    context: defineContext<P, { orgId: string }>({
      build: ({ principal: p }) => ({ orgId: p.orgId }),
    }),
    agents: {
      briefer: defineAgent<P>({
        model: model as never,
        instructions: "test agent",
        tools: {
          gated: tool({
            description: "needs approval",
            inputSchema: z.object({ n: z.number() }),
            execute: async ({ n }) => ({ ok: n }),
          }),
        },
        toolApproval: { gated: "user-approval" },
      }),
    },
    cron: (_expr, afterMs) => afterMs + 15 * 60 * 1000,
    telemetry: telemetry as never,
  });
}

/** A runtime whose only interesting seam is `runSchedule`. */
function build(runSchedule?: (i: { schedule: ScheduleRecord; principal: P }) => Promise<boolean>) {
  const model = new MockLanguageModelV3({
    doStream: async () => ({ stream: textStream("done") }),
  });
  const db = drizzle(client, { schema });
  const runtime: Runtime<P> = createRuntime<P, { orgId: string }>({
    storage: createSqliteAdapter<P>(db, { owner: (p) => [p.orgId, p.userId] }),
    context: defineContext<P, { orgId: string }>({
      build: ({ principal: p }) => ({ orgId: p.orgId }),
    }),
    agents: { briefer: defineAgent<P>({ model: model as never }) },
    // Every 15 minutes, so "recurring" schedules advance to a real next time.
    cron: (_expr, afterMs) => afterMs + 15 * 60 * 1000,
    runSchedule,
  });
  return runtime;
}

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await migrate(client);
});

afterEach(() => {
  client.close();
  vi.restoreAllMocks();
});

describe("runDue reports a fire that parked on a human", () => {
  it("counts it in `parked` (and in `fired` — the turn did run)", async () => {
    const runtime = buildParking();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runtime.schedule({ principal, agent: "briefer", cron: null, prompt: "how many?" });

    // fired: the turn happened and was paid for. parked: it produced no
    // answer and is waiting on someone. A one-shot has no later occurrence
    // to reveal that, so this tick has to say it.
    expect(await runtime.runDue()).toEqual({ fired: 1, errors: 0, skipped: 0, parked: 1, rejected: 0 });
    expect(warn.mock.calls.some(([m]) => String(m).includes("fire parked waiting on a human"))).toBe(
      true,
    );

    // And the chat it parked in is discoverable through the ordinary list —
    // lastRunStatus is the operator-facing half of the same signal.
    const chats = await runtime.listChats({ principal });
    expect(chats).toHaveLength(1);
    expect(chats[0]!.lastRunStatus).toBe("awaiting_input");
  });
});

describe("telemetry marks WHO set the turn off", () => {
  it('stamps trigger: "schedule" on a fire, so a park is distinguishable from an interactive one', async () => {
    const finished: { status: string; trigger: string; chatId: string }[] = [];
    const runtime = buildParking({
      onRunFinished: (run: { trigger: string; chatId: string }, outcome: { status: string }) => {
        finished.push({ status: outcome.status, trigger: run.trigger, chatId: run.chatId });
      },
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await runtime.schedule({ principal, agent: "briefer", cron: null, prompt: "how many?" });
    await runtime.runDue();

    // The run meta already carries principal/chatId/runId — `trigger` is what
    // makes it actionable: awaiting_input + schedule = nobody can answer this,
    // push it. The same status under "chat" is a gate in front of a live user.
    expect(finished).toHaveLength(1);
    expect(finished[0]!.status).toBe("awaiting_input");
    expect(finished[0]!.trigger).toBe("schedule");
  });

  it('stamps trigger: "chat" on a user-driven turn — same agent, same gate', async () => {
    const triggers: string[] = [];
    const runtime = buildParking({
      onRunFinished: (run: { trigger: string }) => void triggers.push(run.trigger),
    });
    const res = await runtime.handleChat({
      principal,
      agent: "briefer",
      chatId: "chat_interactive",
      message: {
        id: "m1",
        role: "user",
        parts: [{ type: "text", text: "hi" }],
        metadata: { visibility: "user", createdAt: 0 },
      },
    } as never);
    await res.text();
    // Parks on the very same gate as the scheduled fire above — only the
    // trigger tells the two apart, which is the whole point.
    expect(triggers).toEqual(["chat"]);
  });
});

describe("runDue → runSchedule hook", () => {
  it("hands the fire to the host, with the schedule's delivery and principal", async () => {
    const seen: { schedule: ScheduleRecord; principal: P }[] = [];
    const runtime = build(async (i) => {
      seen.push(i);
      return true;
    });

    await runtime.schedule({
      principal,
      agent: "briefer",
      cron: null,
      prompt: "morning brief",
      delivery: { kind: "telegram", botId: "bot-1" },
    });

    expect(await runtime.runDue()).toEqual({ fired: 1, errors: 0, skipped: 0, parked: 0, rejected: 0 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.principal).toEqual(principal);
    expect(seen[0]!.schedule.prompt).toBe("morning brief");
    // Opaque to core, handed back verbatim.
    expect(seen[0]!.schedule.delivery).toEqual({ kind: "telegram", botId: "bot-1" });

    // Handled means core did NOT also run it into a chat of its own.
    expect(await runtime.listChats({ principal })).toHaveLength(0);
  });

  it("falls back to a fresh chat when the host declines", async () => {
    const runtime = build(async () => false);
    await runtime.schedule({ principal, agent: "briefer", cron: null, prompt: "brief me" });

    expect(await runtime.runDue()).toEqual({ fired: 1, errors: 0, skipped: 0, parked: 0, rejected: 0 });
    const chats = await runtime.listChats({ principal });
    expect(chats).toHaveLength(1);
    expect(chats[0]!.agent).toBe("briefer");
  });

  it("counts a throwing hook as an error and doesn't run it again in a chat", async () => {
    // The hook may have run the agent before it threw (delivery failed, say):
    // a fallback chat would be a second paid turn. Declining is `return false`.
    const runtime = build(async () => {
      throw new Error("delivery failed after the turn ran");
    });
    await runtime.schedule({ principal, agent: "briefer", cron: null, prompt: "brief me" });

    expect(await runtime.runDue()).toEqual({ fired: 0, errors: 1, skipped: 0, parked: 0, rejected: 0 });
    expect(await runtime.listChats({ principal })).toHaveLength(0);
  });

  it("advances nextRunAt on every path, so nothing hot-loops", async () => {
    const runtime = build(async () => true);
    await runtime.schedule({
      principal,
      agent: "briefer",
      cron: "*/15 * * * *",
      prompt: "recurring",
    });
    const before = (await runtime.listSchedules({ principal }))[0]!;
    // A recurring schedule's first fire is its first cron occurrence, not now.
    const due = before.nextRunAt;

    expect(await runtime.runDue({ now: due })).toEqual({ fired: 1, errors: 0, skipped: 0, parked: 0, rejected: 0 });
    const after = (await runtime.listSchedules({ principal }))[0]!;
    expect(after.nextRunAt).toBeGreaterThan(before.nextRunAt);
    expect(after.enabled).toBe(true);
    expect(after.lastRunAt).toBeTruthy();

    // A second tick at the same instant finds nothing due — it advanced past it.
    expect(await runtime.runDue({ now: due })).toEqual({ fired: 0, errors: 0, skipped: 0, parked: 0, rejected: 0 });
  });

  it("a one-shot is spent after firing", async () => {
    const runtime = build(async () => true);
    await runtime.schedule({ principal, agent: "briefer", cron: null, prompt: "once" });
    await runtime.runDue();
    expect((await runtime.listSchedules({ principal }))[0]!.enabled).toBe(false);
    expect(await runtime.runDue()).toEqual({ fired: 0, errors: 0, skipped: 0, parked: 0, rejected: 0 });
  });
});

describe("delivery persistence", () => {
  it("round-trips through create → list → claim", async () => {
    const delivery = { kind: "slack", appId: "A1", channel: "C1" };
    const runtime = build(async () => true);
    const created = await runtime.schedule({
      principal,
      agent: "briefer",
      cron: null,
      prompt: "p",
      delivery,
    });
    expect(created.delivery).toEqual(delivery);
    expect((await runtime.listSchedules({ principal }))[0]!.delivery).toEqual(delivery);

    // And survives the claim that `runDue` reads it back through.
    let claimed: unknown;
    const claiming = build(async ({ schedule }) => {
      claimed = schedule.delivery;
      return true;
    });
    await claiming.runDue();
    expect(claimed).toEqual(delivery);
  });

  it("a schedule with no delivery stays undefined", async () => {
    const runtime = build(async () => false);
    const created = await runtime.schedule({
      principal,
      agent: "briefer",
      cron: null,
      prompt: "p",
    });
    expect(created.delivery).toBeUndefined();
  });
});

describe("runScheduleNow", () => {
  it("arms the schedule for the next tick, through the real fire path", async () => {
    const fired: string[] = [];
    const runtime = build(async ({ schedule }) => {
      fired.push(schedule.id);
      return true;
    });
    // First occurrence is 15 min out, so an immediate tick skips it.
    const created = await runtime.schedule({
      principal,
      agent: "briefer",
      cron: "*/15 * * * *",
      prompt: "later",
    });
    expect(await runtime.runDue()).toEqual({ fired: 0, errors: 0, skipped: 0, parked: 0, rejected: 0 });

    expect(await runtime.runScheduleNow({ principal, id: created.id })).toBe(true);
    expect(await runtime.runDue()).toEqual({ fired: 1, errors: 0, skipped: 0, parked: 0, rejected: 0 });
    expect(fired).toEqual([created.id]);
  });

  it("reports false rather than success when nothing was armed", async () => {
    const runtime = build(async () => true);
    // Unknown id — the caller must be able to tell this from "queued".
    expect(await runtime.runScheduleNow({ principal, id: "sch_nope" })).toBe(false);
  });

  it("is owner-fenced — another principal's id does nothing", async () => {
    const runtime = build(async () => true);
    const created = await runtime.schedule({
      principal,
      agent: "briefer",
      cron: "*/15 * * * *",
      prompt: "later",
    });
    expect(await runtime.runScheduleNow({ principal: other, id: created.id })).toBe(false);
    expect(await runtime.runDue()).toEqual({ fired: 0, errors: 0, skipped: 0, parked: 0, rejected: 0 });
  });

  it("won't resurrect a spent one-shot", async () => {
    const runtime = build(async () => true);
    const created = await runtime.schedule({
      principal,
      agent: "briefer",
      cron: null,
      prompt: "once",
    });
    await runtime.runDue();
    expect((await runtime.listSchedules({ principal }))[0]!.enabled).toBe(false);

    expect(await runtime.runScheduleNow({ principal, id: created.id })).toBe(false);
    expect(await runtime.runDue()).toEqual({ fired: 0, errors: 0, skipped: 0, parked: 0, rejected: 0 });
  });
});
