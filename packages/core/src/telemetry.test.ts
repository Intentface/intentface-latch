import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream } from "ai";
import { createRuntime } from "./runtime.js";
import { defineContext } from "./context.js";
import { defineAgent } from "./agent.js";
import { staticPricing } from "./pricing.js";
import type { AppMessage } from "./message.js";
import type { ChatRecord, RunRecord, StorageAdapter } from "./storage.js";
import type { TelemetryRunMeta, TelemetryRunOutcome, TelemetryStep } from "./telemetry.js";

/**
 * The telemetry seam as the single observation point: `onStep` per generation
 * step, `onRunFinished` per turn with status/usage/cost/trigger, hooks that
 * throw never break the turn, and a `telemetryFor` that returns undefined
 * silences every hook for that run. (Ported from the observability smoke when
 * the two seams became one.)
 */

type P = { orgId: string };
const principal: P = { orgId: "org_a" };

/** A mock model streaming one text answer per call; 7 input / 3 output tokens. */
const mockModel = () =>
  new MockLanguageModelV4({
    modelId: "mock-model",
    doStream: (async () => ({
      stream: simulateReadableStream({
        initialDelayInMs: 0,
        chunkDelayInMs: 0,
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "0" },
          { type: "text-delta", id: "0", delta: "Hello, world!" },
          { type: "text-end", id: "0" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: { inputTokens: { total: 7 }, outputTokens: { total: 3 } },
          },
        ],
      }),
    })) as never,
  });

/** A model whose stream fails mid-answer. */
const failingModel = () =>
  new MockLanguageModelV4({
    modelId: "mock-model",
    doStream: (async () => ({
      stream: new ReadableStream({
        start(c) {
          c.enqueue({ type: "stream-start", warnings: [] });
          c.enqueue({ type: "text-start", id: "0" });
          c.error(new Error("provider exploded"));
        },
      }),
    })) as never,
  });

function memoryStorage(): { storage: StorageAdapter<P>; runs: Map<string, RunRecord> } {
  const chats = new Map<string, ChatRecord>();
  const messages = new Map<string, AppMessage[]>();
  const runs = new Map<string, RunRecord>();
  let n = 0;
  const impl: Partial<StorageAdapter<P>> = {
    async createChat(_p, input) {
      const chat: ChatRecord = {
        id: input.id ?? `chat_${++n}`,
        owner: "org_a",
        agent: input.agent,
        title: input.title,
        kind: input.kind ?? "user",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      chats.set(chat.id, chat);
      messages.set(chat.id, []);
      return chat;
    },
    async getChat(_p, id) {
      return chats.get(id) ?? null;
    },
    async loadMessages(_p, chatId) {
      return [...(messages.get(chatId) ?? [])];
    },
    async appendMessages(chatId, msgs) {
      const list = [...(messages.get(chatId) ?? [])];
      for (const m of msgs) {
        const i = list.findIndex((x) => x.id === m.id);
        if (i >= 0) list[i] = m;
        else list.push(m);
      }
      messages.set(chatId, list);
    },
    async createRun(_p, input) {
      const run = { id: `run_${++n}`, chatId: input.chatId, agent: input.agent, status: "active", agentVersion: input.agentVersion ?? null, startedAt: Date.now() } as RunRecord;
      runs.set(run.id, run);
      return run;
    },
    async updateRun(id, patch) {
      const r = runs.get(id);
      if (r) runs.set(id, { ...r, ...patch } as RunRecord);
      return true;
    },
    async getRun(id) {
      return runs.get(id) ?? null;
    },
    async recordUsage() {},
  };
  return { storage: impl as StorageAdapter<P>, runs };
}

let lastRuns: Map<string, RunRecord>;

const userMessage = (): AppMessage => ({
  id: "m1",
  role: "user",
  parts: [{ type: "text", text: "hi" }],
  metadata: { visibility: "user", createdAt: Date.now() },
});

function build(
  telemetry: Record<string, unknown>,
  agentModel: MockLanguageModelV4 = mockModel(),
  /** Stand-in for a store-resolved agent, which carries its record's version. */
  configVersion?: number,
) {
  const mem = memoryStorage();
  lastRuns = mem.runs;
  return createRuntime<P>({
    storage: mem.storage,
    context: defineContext<P, unknown>({ build: async () => ({}) }),
    agents: { echo: defineAgent({ model: agentModel, instructions: "hi", configVersion }) },
    // 1 unit per token → turn cost = 7 + 3 = 10.
    pricing: staticPricing({ "mock-model": { inputPer1M: 1_000_000, outputPer1M: 1_000_000 } }),
    telemetry: telemetry as never,
  });
}

describe("LatchTelemetry as the observation seam", () => {
  it("onStep fires per step with usage; onRunFinished once with status, totals, cost and trigger", async () => {
    const steps: { run: TelemetryRunMeta<P>; step: TelemetryStep }[] = [];
    const finished: { run: TelemetryRunMeta<P>; outcome: TelemetryRunOutcome }[] = [];
    const rt = build({
      onStep: (run: TelemetryRunMeta<P>, step: TelemetryStep) => void steps.push({ run, step }),
      onRunFinished: (run: TelemetryRunMeta<P>, outcome: TelemetryRunOutcome) =>
        void finished.push({ run, outcome }),
    });
    await (await rt.handleChat({ agent: "echo", principal, message: userMessage() })).text();
    await new Promise((r) => setTimeout(r, 20));

    expect(steps.length).toBeGreaterThanOrEqual(1);
    expect(steps[0]!.run.agent).toBe("echo");
    expect(steps[0]!.run.depth).toBe(0);
    expect(steps[0]!.run.trigger).toBe("chat");
    expect(steps.some((s) => (s.step.usage?.inputTokens ?? 0) > 0)).toBe(true);

    expect(finished).toHaveLength(1);
    const { run, outcome } = finished[0]!;
    expect(outcome.status).toBe("completed");
    expect(run.runId.length).toBeGreaterThan(0);
    expect(run.chatId).toBe(steps[0]!.run.chatId);
    expect(outcome.usage.inputTokens).toBe(7);
    expect(outcome.cost).toBe(10);
    expect((outcome.messages as AppMessage[]).some((m) => m.role === "assistant")).toBe(true);
  });

  it("carries the agent's stored version onto the run meta and the run row", async () => {
    const seen: TelemetryRunMeta<P>[] = [];
    const rt = build(
      { onRunFinished: (run: TelemetryRunMeta<P>) => void seen.push(run) },
      mockModel(),
      8,
    );
    await (await rt.handleChat({ agent: "echo", principal, message: userMessage() })).text();
    await new Promise((r) => setTimeout(r, 20));

    // The tracer needs it to tag the trace...
    expect(seen).toHaveLength(1);
    expect(seen[0]!.agentVersion).toBe(8);
    // ...and it is persisted AT OPEN, so a run that errors or crashes before any
    // terminal update still says which version it ran.
    const row = [...lastRuns.values()].at(-1)!;
    expect(row.agentVersion).toBe(8);
  });

  it("leaves the version unset for a code-declared agent", async () => {
    const seen: TelemetryRunMeta<P>[] = [];
    const rt = build({ onRunFinished: (run: TelemetryRunMeta<P>) => void seen.push(run) });
    await (await rt.handleChat({ agent: "echo", principal, message: userMessage() })).text();
    await new Promise((r) => setTimeout(r, 20));

    // No stored record, so no version to claim — null rather than a fake 1,
    // which would be indistinguishable from a real first version.
    expect(seen[0]!.agentVersion).toBeUndefined();
    expect([...lastRuns.values()].at(-1)!.agentVersion).toBeNull();
  });

  it("a throwing hook never breaks the turn", async () => {
    let calls = 0;
    const rt = build({
      onStep: () => {
        calls++;
        throw new Error("boom");
      },
      onRunFinished: async () => {
        calls++;
        throw new Error("boom");
      },
    });
    const res = await rt.handleChat({ agent: "echo", principal, message: userMessage() });
    const body = await res.text();
    expect(body).toContain("Hello, world!");
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("telemetryFor returning undefined opts the run out of every hook", async () => {
    let fired = 0;
    const rt = build({
      telemetryFor: () => undefined,
      onStep: () => void fired++,
      onRunFinished: () => void fired++,
    });
    await (await rt.handleChat({ agent: "echo", principal, message: userMessage() })).text();
    await new Promise((r) => setTimeout(r, 20));
    expect(fired).toBe(0);
  });

  it("an erroring model stream reports onRunFinished exactly once, as errored", async () => {
    const finished: TelemetryRunOutcome[] = [];
    const rt = build(
      { onRunFinished: (_run: TelemetryRunMeta<P>, outcome: TelemetryRunOutcome) => void finished.push(outcome) },
      failingModel(),
    );
    await (await rt.handleChat({ agent: "echo", principal, message: userMessage() })).text();
    await new Promise((r) => setTimeout(r, 50));
    expect(finished.map((o) => o.status)).toEqual(["errored"]);
    expect(finished[0]!.error).toContain("provider exploded");
    // …and the run row agrees (it used to be settled as "completed").
    const rows = [...lastRuns.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("errored");
    expect(rows[0]!.error).toContain("provider exploded");
  });

  it("an errored run still records the agent version it ran", async () => {
    const rt = build({}, failingModel(), 8);
    await (await rt.handleChat({ agent: "echo", principal, message: userMessage() })).text();
    await new Promise((r) => setTimeout(r, 50));

    // "Which version produced these failures" is the question most worth
    // answering, and a failing run never reaches a terminal update — so the
    // version has to be stamped when the run is opened, not when it settles.
    const row = [...lastRuns.values()][0]!;
    expect(row.status).toBe("errored");
    expect(row.agentVersion).toBe(8);
  });

  it("stamps the trigger for programmatic runs", async () => {
    const triggers: string[] = [];
    const rt = build({ onRunFinished: (run: TelemetryRunMeta<P>) => void triggers.push(run.trigger) });
    await rt.runAgent({ principal, agent: "echo", prompt: "x" });
    await rt.runAgent({ principal, agent: "echo", prompt: "y", trigger: "chat" });
    expect(triggers).toEqual(["programmatic", "chat"]);
  });
});
