import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream } from "ai";
import { createRuntime, resumeShapeOf, trimTrailingAssistantPrefill } from "./runtime.js";
import { defineContext } from "./context.js";
import { defineAgent } from "./agent.js";
import { toModelMessages } from "./projections.js";
import type { AppMessage } from "./message.js";
import type { RunRecord, StorageAdapter } from "./storage.js";

/**
 * Crash recovery, for the window nobody sees until it bites: the per-step
 * checkpoint is fire-and-forget at each step's end, while the run row only
 * becomes `completed` in `onFinish`. Die in between and the reaper picks up a
 * run whose work is DONE and whose answer is already in history.
 *
 * Two things must hold there.
 *
 *   1. Don't pay twice. Re-running the model regenerates an answer that is
 *      already stored — and because the SDK reuses the message id, the second
 *      copy lands in the same message as the first.
 *   2. Never hand the model an assistant prefill. Models that reject one fail
 *      on the request shape, so every identical retry fails identically until
 *      `maxAttempts` is spent: a poisoned run, not a recovered one.
 *
 * The tool-free shape is the trap. `[step-start, text]` has no `tool-*` part
 * for `trimTrailingAssistantPrefill` to anchor on, so the plain trim is a
 * no-op there and a fix tested only against the tool-bearing shape would look
 * green while that path stayed broken.
 */

type P = { orgId: string };
const principal: P = { orgId: "org_a" };

const msg = (
  role: "user" | "assistant",
  parts: Array<{ type: string } & Record<string, unknown>>,
): AppMessage => ({ id: `m_${role}`, role, parts }) as AppMessage;

const USER = msg("user", [{ type: "text", text: "what is it?" }]);

describe("resumeShapeOf", () => {
  it("a tool-free turn that finished is finished, even with no tool part to read", () => {
    // The whole answer is on disk; only the row never heard about it.
    const history = [USER, msg("assistant", [{ type: "step-start" }, { type: "text", text: "It is 4." }])];
    expect(resumeShapeOf(history)).toBe("loop-finished");
  });

  it("a final step that called no tool is finished, whatever earlier steps did", () => {
    const history = [
      USER,
      msg("assistant", [
        { type: "step-start" },
        { type: "text", text: "Looking it up." },
        { type: "tool-web_fetch", toolCallId: "c1", state: "output-available", input: { url: "u" }, output: { text: "…" } },
        { type: "step-start" },
        { type: "text", text: "Based on the page, it is 42." },
      ]),
    ];
    expect(resumeShapeOf(history)).toBe("loop-finished");
  });

  it("a final step that called a tool has work left", () => {
    const history = [
      USER,
      msg("assistant", [
        { type: "step-start" },
        { type: "text", text: "Looking it up." },
        { type: "tool-web_fetch", toolCallId: "c1", state: "output-available", input: { url: "u" }, output: { text: "…" } },
      ]),
    ];
    expect(resumeShapeOf(history)).toBe("continue");
  });

  it("a tool that never returned has work left", () => {
    const history = [
      USER,
      msg("assistant", [
        { type: "step-start" },
        { type: "tool-web_fetch", toolCallId: "c1", state: "input-available", input: { url: "u" } },
      ]),
    ];
    expect(resumeShapeOf(history)).toBe("continue");
  });

  it("trailing narration after a tool call still has work left — the loop went round again", () => {
    const history = [
      USER,
      msg("assistant", [
        { type: "step-start" },
        { type: "tool-web_fetch", toolCallId: "c1", state: "output-available", input: { url: "u" }, output: { text: "…" } },
        { type: "text", text: "Now let me check the other one." },
      ]),
    ];
    expect(resumeShapeOf(history)).toBe("continue");
  });

  it("an undecided gate outranks the tail's shape", () => {
    // Narration after the gated call would otherwise read as `loop-finished`,
    // which would settle the run as completed and strand the human's decision.
    const history = [
      USER,
      msg("assistant", [
        { type: "tool-create_page", toolCallId: "c2", state: "approval-requested", input: {}, approval: { approvalId: "apv_1" } },
        { type: "step-start" },
        { type: "text", text: "Ready to create it once you approve." },
      ]),
    ];
    expect(resumeShapeOf(history)).toBe("decision-pending");
  });

  it("a step that opened and produced nothing has work left", () => {
    const history = [USER, msg("assistant", [{ type: "text", text: "hi" }, { type: "step-start" }])];
    expect(resumeShapeOf(history)).toBe("continue");
  });

  it("nothing checkpointed yet → run the model", () => {
    expect(resumeShapeOf([USER])).toBe("continue");
    expect(resumeShapeOf([])).toBe("continue");
  });

  describe("whose tail is it", () => {
    const ours = (parts: Array<{ type: string } & Record<string, unknown>>, runId: string) =>
      ({ ...msg("assistant", parts), metadata: { runId } }) as AppMessage;

    it("a finished tail that belongs to a LATER run means we were superseded", () => {
      // The chat moved on while this run sat reaped: another turn ran and
      // completed. Settling that turn as ours, or re-running over it, are both
      // wrong — and the second appends to the later turn's message.
      const history = [
        USER,
        ours([{ type: "step-start" }, { type: "text", text: "partial" }], "run_1"),
        msg("user", [{ type: "text", text: "actually, something else" }]),
        ours([{ type: "step-start" }, { type: "text", text: "Sure." }], "run_2"),
      ];
      expect(resumeShapeOf(history, "run_1")).toBe("superseded");
    });

    it("superseded outranks a pending gate that is not ours", () => {
      const history = [
        USER,
        ours(
          [{ type: "tool-create_page", toolCallId: "c9", state: "approval-requested", input: {}, approval: { approvalId: "apv_9" } }],
          "run_2",
        ),
      ];
      // Without correlation this would settle run_1 as awaiting a decision that
      // belongs to run_2 — a human's answer would then land on the wrong run.
      expect(resumeShapeOf(history, "run_1")).toBe("superseded");
      // The run the gate actually belongs to still reads as pending.
      expect(resumeShapeOf(history, "run_2")).toBe("decision-pending");
    });

    it("our own tail classifies as before", () => {
      const history = [USER, ours([{ type: "step-start" }, { type: "text", text: "It is 4." }], "run_1")];
      expect(resumeShapeOf(history, "run_1")).toBe("loop-finished");
    });

    it("a tail with no run id recorded is treated as ours — the legacy shape", () => {
      const history = [USER, msg("assistant", [{ type: "step-start" }, { type: "text", text: "It is 4." }])];
      expect(resumeShapeOf(history, "run_1")).toBe("loop-finished");
    });

    it("without a run id to compare, correlation is skipped", () => {
      const history = [USER, ours([{ type: "step-start" }, { type: "text", text: "It is 4." }], "run_2")];
      expect(resumeShapeOf(history)).toBe("loop-finished");
    });
  });
});

describe("trimTrailingAssistantPrefill — unanchored", () => {
  const toolFree = [USER, msg("assistant", [{ type: "step-start" }, { type: "text", text: "It is 4." }])];

  it("without the option, the tool-free shape is left as an assistant prefill", async () => {
    expect(trimTrailingAssistantPrefill(toolFree)).toBe(toolFree); // same identity: a no-op
    const model = await toModelMessages(toolFree, { tools: {} });
    expect(model[model.length - 1].role).toBe("assistant");
  });

  it("with the option, the message empties out of the projection", async () => {
    const trimmed = trimTrailingAssistantPrefill(toolFree, { unanchored: true });
    expect((trimmed[1].parts ?? []).map((p) => p.type)).toEqual([]);
    const model = await toModelMessages(trimmed, { tools: {} });
    // Ends on the user turn, so the model generates a fresh continuation
    // instead of being asked to continue its own sentence.
    expect(model.map((m) => m.role)).toEqual(["user"]);
  });

  it("the option does not change the anchored behaviour the decision paths rely on", () => {
    const withTool = [
      USER,
      msg("assistant", [
        { type: "tool-askUser", toolCallId: "c3", state: "output-available", input: {}, output: {} },
        { type: "text", text: "narration" },
      ]),
    ];
    const a = trimTrailingAssistantPrefill(withTool);
    const b = trimTrailingAssistantPrefill(withTool, { unanchored: true });
    expect((a[1].parts ?? []).map((p) => p.type)).toEqual(["tool-askUser"]);
    expect((b[1].parts ?? []).map((p) => p.type)).toEqual(["tool-askUser"]);
  });
});

/** Storage that throws on anything this path shouldn't touch. */
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
          return (overrides[prop as keyof StorageAdapter<P>] as (...a: unknown[]) => unknown)(...args);
        };
      }
      return () => {
        throw new Error(`storage.${prop} should not be called by this path`);
      };
    },
  });
  return { storage, calls };
}

const RUN: RunRecord = {
  id: "run_1",
  chatId: "chat_1",
  agent: "assistant",
  status: "active",
  identity: { orgId: "org_a" },
  fencingToken: 3,
  attempt: 2,
  startedAt: 1000,
};

/** A model that fails the test if the resume path calls it. */
const forbiddenModel = () =>
  new MockLanguageModelV4({
    modelId: "mock-model",
    doStream: (async () => {
      throw new Error("the model must not be called when the loop had already finished");
    }) as never,
  });

const workingModel = () =>
  new MockLanguageModelV4({
    modelId: "mock-model",
    doStream: (async () => ({
      stream: simulateReadableStream({
        initialDelayInMs: 0,
        chunkDelayInMs: 0,
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "0" },
          { type: "text-delta", id: "0", delta: "continued" },
          { type: "text-end", id: "0" },
          {
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: { total: 5 }, outputTokens: { total: 2 } },
          },
        ],
      }),
    })) as never,
  });

function runtimeOver(history: AppMessage[], model: ReturnType<typeof workingModel>) {
  const patches: Array<Record<string, unknown>> = [];
  const appended: AppMessage[][] = [];
  let row: RunRecord = { ...RUN };
  const { storage, calls } = stubStorage({
    async reclaimRun() {
      return row;
    },
    async loadMessages() {
      return structuredClone(history);
    },
    async updateRun(_id, patch) {
      patches.push(patch as Record<string, unknown>);
      row = { ...row, ...(patch as Partial<RunRecord>) };
      return true;
    },
    async getRun() {
      return row;
    },
    async appendMessages(_chatId, msgs) {
      appended.push(msgs as AppMessage[]);
    },
    async heartbeatRun() {
      return true;
    },
    async recordUsage() {},
  });
  const runtime = createRuntime<P, Record<string, never>>({
    storage,
    context: defineContext<P, Record<string, never>>({ build: () => ({}) }),
    agents: { assistant: defineAgent(() => ({ model, instructions: "be brief" })) },
    reconstructPrincipal: (identity) => identity as P,
    durability: { enabled: true, instanceId: "node_a" },
  });
  return { runtime, patches, appended, calls };
}

describe("resumeRun", () => {
  it("settles a finished-but-unrecorded turn without calling the model", async () => {
    const history = [USER, msg("assistant", [{ type: "step-start" }, { type: "text", text: "It is 4." }])];
    const { runtime, patches, appended, calls } = runtimeOver(history, forbiddenModel());

    const outcome = await runtime.resume("run_1");

    expect(outcome?.status).toBe("completed");
    // The reaper's "lease expired" has to be cleared, or the row reads as a
    // failure forever even though the turn succeeded.
    expect(patches).toEqual([
      expect.objectContaining({ status: "completed", error: null, endedAt: expect.any(Number) }),
    ]);
    // Nothing rewritten: the stored answer is the answer.
    expect(appended).toEqual([]);
    expect(calls).not.toContain("recordUsage");
  });

  it("settles a turn that crashed with a gate pending as awaiting_input", async () => {
    const history = [
      USER,
      msg("assistant", [
        { type: "tool-create_page", toolCallId: "c2", state: "approval-requested", input: {}, approval: { approvalId: "apv_1" } },
      ]),
    ];
    const { runtime, patches } = runtimeOver(history, forbiddenModel());

    const outcome = await runtime.resume("run_1");

    expect(outcome?.status).toBe("awaiting_input");
    // The reaper stamped an `endedAt` on the way in, and a paused turn is not
    // over — `onFinish` leaves it unset for one, so this must clear it. `null`
    // rather than `undefined`, which the adapters drop from the patch.
    expect(patches[0]).toEqual({ status: "awaiting_input", error: null, endedAt: null });
  });

  it("still re-runs the model when work is genuinely left", async () => {
    const history = [
      USER,
      msg("assistant", [
        { type: "step-start" },
        { type: "tool-web_fetch", toolCallId: "c1", state: "output-available", input: { url: "u" }, output: { text: "…" } },
      ]),
    ];
    const { runtime, appended } = runtimeOver(history, workingModel());

    const outcome = await runtime.resume("run_1");

    expect(outcome?.status).toBe("completed");
    // It generated: the continuation was persisted.
    const texts = appended
      .flat()
      .flatMap((m) => (m.parts ?? []) as Array<{ type: string; text?: string }>)
      .filter((p) => p.type === "text")
      .map((p) => p.text);
    expect(texts).toContain("continued");
  });

  it("never hands the model its own half-written sentence", async () => {
    // Trailing narration AFTER a tool call: the loop went round again, so there
    // is work left — and the tail is the turn's own unfinished text. Without
    // the trim this reaches the model as an assistant prefill, which is a hard
    // rejection on models that refuse one.
    const history = [
      USER,
      msg("assistant", [
        { type: "step-start" },
        { type: "tool-web_fetch", toolCallId: "c1", state: "output-available", input: { url: "u" }, output: { text: "…" } },
        { type: "text", text: "Now let me check the ot" },
      ]),
    ];
    const prompts: Array<Array<{ role: string }>> = [];
    const capturingModel = new MockLanguageModelV4({
      modelId: "mock-model",
      doStream: (async ({ prompt }: { prompt: Array<{ role: string }> }) => {
        prompts.push(prompt);
        return {
          stream: simulateReadableStream({
            initialDelayInMs: 0,
            chunkDelayInMs: 0,
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "0" },
              { type: "text-delta", id: "0", delta: "done" },
              { type: "text-end", id: "0" },
              {
                type: "finish",
                finishReason: "stop",
                usage: { inputTokens: { total: 5 }, outputTokens: { total: 2 } },
              },
            ],
          }),
        };
      }) as never,
    });
    const { runtime } = runtimeOver(history, capturingModel);

    await runtime.resume("run_1");

    expect(prompts).toHaveLength(1);
    const sent = prompts[0];
    expect(sent[sent.length - 1].role).not.toBe("assistant");
    // The half-written sentence is gone from what the model saw.
    expect(JSON.stringify(sent)).not.toContain("Now let me check the ot");
  });

  it("a stale writer settles nothing and reports nothing", async () => {
    // Our lease was reaped again mid-flight: the fenced update does not apply,
    // so the new owner decides this run's end state. Reporting here would emit
    // a second terminal event for one run.
    const history = [USER, msg("assistant", [{ type: "step-start" }, { type: "text", text: "It is 4." }])];
    const finished: string[] = [];
    let row: RunRecord = { ...RUN };
    const { storage } = stubStorage({
      async reclaimRun() {
        return row;
      },
      async loadMessages() {
        return structuredClone(history);
      },
      async updateRun() {
        return false; // fenced out
      },
      async getRun() {
        return row;
      },
    });
    const runtime = createRuntime<P, Record<string, never>>({
      storage,
      context: defineContext<P, Record<string, never>>({ build: () => ({}) }),
      agents: { assistant: defineAgent(() => ({ model: forbiddenModel(), instructions: "be brief" })) },
      reconstructPrincipal: (identity) => identity as P,
      durability: { enabled: true, instanceId: "node_a" },
      telemetry: {
        onRunFinished: (_run, outcome) => {
          finished.push(outcome.status);
        },
      },
    });

    const outcome = await runtime.resume("run_1");

    expect(finished).toEqual([]);
    // The outcome reflects the row as it stands, not what we wanted to write.
    expect(outcome?.status).toBe("active");
  });

  it("a run superseded by a later turn settles as errored, and never re-runs", async () => {
    const history = [
      USER,
      { ...msg("assistant", [{ type: "step-start" }, { type: "text", text: "partial" }]), metadata: { runId: "run_1" } } as AppMessage,
      msg("user", [{ type: "text", text: "actually, something else" }]),
      { ...msg("assistant", [{ type: "step-start" }, { type: "text", text: "Sure." }]), metadata: { runId: "run_2", model: "m2" } } as AppMessage,
    ];
    const finished: Array<{ status: string; error?: string }> = [];
    let row: RunRecord = { ...RUN };
    const patches: Array<Record<string, unknown>> = [];
    const { storage, calls } = stubStorage({
      async reclaimRun() {
        return row;
      },
      async loadMessages() {
        return structuredClone(history);
      },
      async updateRun(_id, patch) {
        patches.push(patch as Record<string, unknown>);
        row = { ...row, ...(patch as Partial<RunRecord>) };
        return true;
      },
      async getRun() {
        return row;
      },
    });
    const runtime = createRuntime<P, Record<string, never>>({
      storage,
      context: defineContext<P, Record<string, never>>({ build: () => ({}) }),
      agents: { assistant: defineAgent(() => ({ model: forbiddenModel(), instructions: "be brief" })) },
      reconstructPrincipal: (identity) => identity as P,
      durability: { enabled: true, instanceId: "node_a" },
      telemetry: {
        onRunFinished: (_run, outcome) => {
          finished.push({ status: outcome.status, error: outcome.error });
        },
      },
    });

    const outcome = await runtime.resume("run_1");

    expect(outcome?.status).toBe("errored");
    // The same outcome openTurn records for a stale run a fresh message
    // supersedes, so it reads identically however it got there.
    expect(patches).toEqual([
      expect.objectContaining({
        status: "errored",
        error: expect.stringMatching(/^superseded/),
        endedAt: expect.any(Number),
      }),
    ]);
    expect(calls).not.toContain("appendMessages");
    expect(finished).toEqual([{ status: "errored", error: expect.stringMatching(/^superseded/) }]);
  });

  it("settles a finished turn whose agent no longer exists", async () => {
    // Dynamic agents are rows: one can be deleted between the crash and the
    // sweep. Resolving it would throw — and that throw used to abort the whole
    // sweep loop, holding up recovery for every other run. A turn whose answer
    // is already stored must reconcile without it.
    const history = [
      USER,
      msg("assistant", [{ type: "step-start" }, { type: "text", text: "It is 4." }]),
    ];
    (history[1] as AppMessage).metadata = { model: "anthropic/claude-sonnet-4-6" };
    const reported: string[] = [];
    let row: RunRecord = { ...RUN, agent: "deleted_agent" };
    const { storage } = stubStorage({
      async reclaimRun() {
        return row;
      },
      async loadMessages() {
        return structuredClone(history);
      },
      async updateRun(_id, patch) {
        row = { ...row, ...(patch as Partial<RunRecord>) };
        return true;
      },
      async getRun() {
        return row;
      },
    });
    const runtime = createRuntime<P, Record<string, never>>({
      storage,
      context: defineContext<P, Record<string, never>>({ build: () => ({}) }),
      agents: {}, // the agent is gone
      reconstructPrincipal: (identity) => identity as P,
      durability: { enabled: true, instanceId: "node_a" },
      telemetry: {
        onRunFinished: (run, outcome) => {
          reported.push(`${outcome.status}:${run.modelId}`);
        },
      },
    });

    const outcome = await runtime.resume("run_1");

    expect(outcome?.status).toBe("completed");
    // Telemetry names the model that actually ran, read off the message it
    // produced — there is no agent left to ask.
    expect(reported).toEqual(["completed:anthropic/claude-sonnet-4-6"]);
  });

  it("reports the settled turn to telemetry, so a host watching for the end sees one", async () => {
    const history = [USER, msg("assistant", [{ type: "step-start" }, { type: "text", text: "It is 4." }])];
    const finished: Array<{ status: string; cost?: number }> = [];
    let row: RunRecord = { ...RUN };
    const { storage } = stubStorage({
      async reclaimRun() {
        return row;
      },
      async loadMessages() {
        return structuredClone(history);
      },
      async updateRun(_id, patch) {
        row = { ...row, ...(patch as Partial<RunRecord>) };
        return true;
      },
      async getRun() {
        return row;
      },
    });
    const runtime = createRuntime<P, Record<string, never>>({
      storage,
      context: defineContext<P, Record<string, never>>({ build: () => ({}) }),
      agents: { assistant: defineAgent(() => ({ model: forbiddenModel(), instructions: "be brief" })) },
      reconstructPrincipal: (identity) => identity as P,
      durability: { enabled: true, instanceId: "node_a" },
      telemetry: {
        onRunFinished: (_run, outcome) => {
          finished.push({ status: outcome.status, cost: outcome.cost });
        },
      },
    });

    await runtime.resume("run_1");

    // Zero cost, matching the row: the process that spent those tokens died
    // before recording them, so there is no honest number to report.
    expect(finished).toEqual([{ status: "completed", cost: 0 }]);
  });
});
