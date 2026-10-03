import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream, tool } from "ai";
import { z } from "zod";
import { createRuntime, resumeShapeOf, supersededBy, trimTrailingAssistantPrefill } from "./runtime.js";
import { defineContext } from "./context.js";
import { defineAgent } from "./agent.js";
import { toModelMessages } from "./projections.js";
import type { AppMessage } from "./message.js";
import type { RunRecord, RunSettings, StorageAdapter } from "./storage.js";

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

  it("an unanswered call at a step boundary is a client wait, not a tool that never returned", () => {
    // The checkpoint fires at finish-step, AFTER tool execution, so a server
    // tool is always output-available or output-error by then. The only call
    // that can be checkpointed without a result is one with no `execute` —
    // whatever its name. Reading it as "interrupted mid-execution" would re-run
    // a turn onFinish had already recorded as completed.
    const history = [
      USER,
      msg("assistant", [
        { type: "step-start" },
        { type: "tool-web_fetch", toolCallId: "c1", state: "input-available", input: { url: "u" } },
      ]),
    ];
    expect(resumeShapeOf(history)).toBe("loop-finished");
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

  describe("a client-handled tool awaiting its answer", () => {
    // askUser has no `execute`: the step ends with the call in
    // `input-available`, the loop stops because not every call has an output,
    // and onFinish records the turn as `completed` — the answer arrives later
    // through applyToolResult, which opens its own run. Recovery must say the
    // same. Re-running would make the projection close the call as
    // "interrupted" and the model ask its question twice.
    const asking = { type: "tool-askUser", toolCallId: "q1", state: "input-available", input: { question: "Which one?" } };

    it("is a finished loop, not work left", () => {
      expect(resumeShapeOf([USER, msg("assistant", [{ type: "step-start" }, asking])])).toBe("loop-finished");
    });

    it("still finished when other tools in the same step already ran", () => {
      const history = [
        USER,
        msg("assistant", [
          { type: "step-start" },
          { type: "tool-web_fetch", toolCallId: "c1", state: "output-available", input: { url: "u" }, output: {} },
          asking,
        ]),
      ];
      expect(resumeShapeOf(history)).toBe("loop-finished");
    });

    it("a provider-executed call still pending is the loop continuing, not a client wait", () => {
      const history = [
        USER,
        msg("assistant", [
          { type: "step-start" },
          { type: "tool-web_search", toolCallId: "p1", state: "input-available", input: {}, providerExecuted: true },
        ]),
      ];
      expect(resumeShapeOf(history)).toBe("continue");
    });
  });

  it("a step that opened and produced nothing has work left", () => {
    const history = [USER, msg("assistant", [{ type: "text", text: "hi" }, { type: "step-start" }])];
    expect(resumeShapeOf(history)).toBe("continue");
  });

  it("nothing checkpointed yet → run the model", () => {
    expect(resumeShapeOf([USER])).toBe("continue");
    expect(resumeShapeOf([])).toBe("continue");
  });

  it("a compaction marker after our message is not a later turn", () => {
    // The runtime's own user-role message: a summary of the conversation so
    // far plus a boundary part. It can land after a reaped run's message and
    // must not read as a user turn that makes the tail look unfinished.
    const history = [
      USER,
      msg("assistant", [{ type: "step-start" }, { type: "text", text: "It is 4." }]),
      { ...msg("user", [{ type: "text", text: "summary" }, { type: "data-compaction", data: { compacted: 2, at: 1 } }]), metadata: { visibility: "internal" } } as AppMessage,
    ];
    expect(resumeShapeOf(history)).toBe("loop-finished");
  });
});

describe("supersededBy", () => {
  // Whether the chat moved on is read off the RUNS, never inferred from message
  // shapes: user messages carry no run id, and when a turn crashes before its
  // first checkpoint the previous turn's assistant message is legitimately the
  // last assistant in history. Every user message is persisted with its run
  // (openTurn), so "a later run in this chat" is the one fact that proves a
  // later turn exists.
  const run = (id: string, chatId: string, startedAt: number, extra: Partial<RunRecord> = {}): RunRecord =>
    ({ id, chatId, agent: "assistant", status: "completed", startedAt, ...extra }) as RunRecord;
  const ours = run("run_1", "chat_1", 1000);

  it("a later run in the same chat means we were superseded", () => {
    expect(supersededBy(ours, [ours, run("run_2", "chat_1", 1500)])).toBe(true);
  });

  it("a later run that has not finished counts too", () => {
    // It may have crashed as well, or be queued behind us in the same sweep.
    expect(supersededBy(ours, [ours, run("run_2", "chat_1", 1500, { status: "errored" })])).toBe(true);
  });

  it("an earlier run in the chat is history, not supersession", () => {
    expect(supersededBy(ours, [run("run_0", "chat_1", 500), ours])).toBe(false);
  });

  it("a later run in another chat is irrelevant", () => {
    expect(supersededBy(ours, [ours, run("run_9", "chat_2", 1500)])).toBe(false);
  });

  it("a later compaction run is a summary, not a turn", () => {
    expect(supersededBy(ours, [ours, run("cmp_1", "chat_1", 1500, { kind: "compaction" })])).toBe(false);
  });

  it("we never supersede ourselves", () => {
    expect(supersededBy(ours, [ours])).toBe(false);
    expect(supersededBy(ours, [])).toBe(false);
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
            finishReason: { unified: "stop", raw: "stop" },
            usage: { inputTokens: { total: 5 }, outputTokens: { total: 2 } },
          },
        ],
      }),
    })) as never,
  });

/** A model that calls the gated `send` once, then answers — per resume. */
const sendingModel = () => {
  let n = 0;
  const finish = (r: string) => ({ type: "finish", finishReason: { unified: r, raw: r }, usage: { inputTokens: { total: 5 }, outputTokens: { total: 2 } } });
  return new MockLanguageModelV4({
    modelId: "mock-model",
    doStream: (async () => ({
      stream: simulateReadableStream({
        initialDelayInMs: 0,
        chunkDelayInMs: 0,
        chunks:
          n++ === 0
            ? [{ type: "stream-start", warnings: [] }, { type: "tool-call", toolCallId: "s1", toolName: "send", input: '{"to":"x"}' }, finish("tool-calls")]
            : [{ type: "stream-start", warnings: [] }, { type: "text-start", id: "0" }, { type: "text-delta", id: "0", delta: "done" }, { type: "text-end", id: "0" }, finish("stop")],
      } as never),
    })) as never,
  });
};

function runtimeOver(
  history: AppMessage[],
  model: ReturnType<typeof workingModel>,
  opts: {
    siblings?: RunRecord[];
    /** Make "assistant" a dynamic agent spawned by this parent, recording each resolve's context. */
    spawnedBy?: { parent: string; seen: unknown[] };
    /** How the crashed turn was asked to run (RunRecord.settings). */
    settings?: RunSettings;
    /** Give "assistant" a gated `send` tool; each real execution is recorded. */
    gated?: string[];
  } = {},
) {
  const patches: Array<Record<string, unknown>> = [];
  const appended: AppMessage[][] = [];
  let row: RunRecord = { ...RUN, ...(opts.settings ? { settings: opts.settings } : {}) };
  const { storage, calls } = stubStorage({
    // Recovery reads the chat for its parentAgent (DynamicAgentResolveContext).
    getChat: async () =>
      opts.spawnedBy
        ? { id: RUN.chatId, owner: "org_a", agent: RUN.agent, kind: "internal", parentAgent: opts.spawnedBy.parent, createdAt: 0, updatedAt: 0 }
        : null,
    async reclaimRun() {
      return row;
    },
    async listRuns() {
      return [row, ...(opts.siblings ?? [])];
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
    agents: opts.spawnedBy
      ? {}
      : {
          assistant: defineAgent(() => ({
            model,
            instructions: "be brief",
            ...(opts.gated
              ? {
                  tools: { send: tool({ description: "send", inputSchema: z.object({ to: z.string() }), execute: async ({ to }) => (opts.gated!.push(to), { sent: true }) }) },
                  toolApproval: { send: "user-approval" as const },
                }
              : {}),
          })),
        },
    ...(opts.spawnedBy
      ? {
          dynamicAgents: {
            list: () => [{ name: "assistant" }],
            resolve: (_name: string, _p: P, ctx?: unknown) => (opts.spawnedBy!.seen.push(ctx), { model, instructions: "be brief" }),
          },
        }
      : {}),
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

  it("a recovered subagent run resolves with the parent read off its thread", async () => {
    const seen: unknown[] = [];
    const history = [
      USER,
      msg("assistant", [
        { type: "step-start" },
        { type: "tool-web_fetch", toolCallId: "c1", state: "output-available", input: { url: "u" }, output: { text: "…" } },
      ]),
    ];
    const { runtime } = runtimeOver(history, workingModel(), { spawnedBy: { parent: "lead", seen } });
    // Crash recovery and `sweep` both land in resumeRun.
    expect((await runtime.resume("run_1"))?.status).toBe("completed");
    expect(seen.at(-1)).toMatchObject({ parentAgent: "lead" });
  });

  it("resumes an unattended test run the way it started: approvals waived, gated tools still stubbed", async () => {
    const executed: string[] = [];
    const history = [
      USER,
      msg("assistant", [
        { type: "step-start" },
        { type: "tool-web_fetch", toolCallId: "c1", state: "output-available", input: { url: "u" }, output: { text: "…" } },
      ]),
    ];
    const { runtime, appended } = runtimeOver(history, sendingModel(), {
      settings: { autoApprove: true, blockGated: "simulate-success", memory: false },
      gated: executed,
    });
    expect((await runtime.resume("run_1"))?.status).toBe("completed");
    const parts = appended.flat().flatMap((m) => m.parts) as { type: string; state?: string }[];
    const send = parts.filter((p) => p.type === "tool-send");
    // Not parked on a gate nobody will answer…
    expect(send.some((p) => p.state === "approval-requested")).toBe(false);
    // …and not run for real: a stubbed test run stays stubbed.
    expect(executed).toEqual([]);
    expect(send.some((p) => p.state === "output-available")).toBe(true);
  });

  it("refuses to resume a run that started on a per-turn model override", async () => {
    const history = [
      USER,
      msg("assistant", [
        { type: "step-start" },
        { type: "tool-web_fetch", toolCallId: "c1", state: "output-available", input: { url: "u" }, output: { text: "…" } },
      ]),
    ];
    const { runtime, patches } = runtimeOver(history, forbiddenModel(), { settings: { autoApprove: true, modelOverride: "anthropic:claude-haiku-4-5" } });
    const outcome = await runtime.resume("run_1");
    expect(outcome?.status).toBe("errored");
    expect(patches).toEqual([expect.objectContaining({ status: "errored", error: expect.stringContaining("anthropic:claude-haiku-4-5") })]);
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
                finishReason: { unified: "stop", raw: "stop" },
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
      // Recovery reads the chat for its parentAgent (DynamicAgentResolveContext).
      getChat: async () => null,
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
      async listRuns() {
        return [row];
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
    // The later turn ran to completion while this run sat reaped.
    const history = [
      USER,
      { ...msg("assistant", [{ type: "step-start" }, { type: "text", text: "partial" }]), metadata: { runId: "run_1" } } as AppMessage,
      msg("user", [{ type: "text", text: "actually, something else" }]),
      { ...msg("assistant", [{ type: "step-start" }, { type: "text", text: "Sure." }]), metadata: { runId: "run_2", model: "m2" } } as AppMessage,
    ];
    const later: RunRecord = { ...RUN, id: "run_2", startedAt: RUN.startedAt + 500, status: "completed" };
    const { runtime, patches, calls } = runtimeOver(history, forbiddenModel(), { siblings: [later] });

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
  });

  it("a later turn that has not answered yet still supersedes us", async () => {
    // Its run row exists (openTurn wrote it with the user message) even though
    // no assistant message does — it crashed too, or is queued behind us.
    const history = [
      USER,
      { ...msg("assistant", [{ type: "step-start" }, { type: "text", text: "partial" }]), metadata: { runId: "run_1" } } as AppMessage,
      msg("user", [{ type: "text", text: "actually, something else" }]),
    ];
    const later: RunRecord = { ...RUN, id: "run_2", startedAt: RUN.startedAt + 500, status: "errored" };
    const { runtime, patches, appended } = runtimeOver(history, forbiddenModel(), { siblings: [later] });

    const outcome = await runtime.resume("run_1");

    expect(outcome?.status).toBe("errored");
    expect(patches[0]).toEqual(expect.objectContaining({ error: expect.stringMatching(/^superseded/) }));
    expect(appended).toEqual([]);
  });

  it("REGRESSION: a crash before the first checkpoint on a chat's SECOND turn still answers", async () => {
    // History: the previous turn (run_0, completed) and OUR opening user
    // message, nothing else — we died before checkpointing anything. The last
    // assistant message in history is legitimately run_0's. Reading it as
    // "someone else's tail", or our own user message as "a later turn", marked
    // this live run superseded and dropped the request without a model call.
    const history = [
      msg("user", [{ type: "text", text: "first question" }]),
      { ...msg("assistant", [{ type: "step-start" }, { type: "text", text: "First answer." }]), metadata: { runId: "run_0" } } as AppMessage,
      msg("user", [{ type: "text", text: "second question" }]),
    ];
    const earlier: RunRecord = { ...RUN, id: "run_0", startedAt: RUN.startedAt - 5000, status: "completed" };
    const { runtime, appended } = runtimeOver(history, workingModel(), { siblings: [earlier] });

    const outcome = await runtime.resume("run_1");

    expect(outcome?.status).toBe("completed");
    const texts = appended
      .flat()
      .flatMap((m) => (m.parts ?? []) as Array<{ type: string; text?: string }>)
      .filter((p) => p.type === "text")
      .map((p) => p.text);
    expect(texts).toContain("continued");
  });

  it("a crash before the first checkpoint on a chat's FIRST turn answers", async () => {
    // The resume smoke's shape: only our user message persisted.
    const { runtime, appended } = runtimeOver([USER], workingModel());

    const outcome = await runtime.resume("run_1");

    expect(outcome?.status).toBe("completed");
    expect(appended.flat().some((m) => m.role === "assistant")).toBe(true);
  });

  it("a later compaction run does not supersede a finished turn", async () => {
    const history = [USER, msg("assistant", [{ type: "step-start" }, { type: "text", text: "It is 4." }])];
    const compaction: RunRecord = { ...RUN, id: "cmp_1", startedAt: RUN.startedAt + 500, status: "completed", kind: "compaction" };
    const { runtime, patches } = runtimeOver(history, forbiddenModel(), { siblings: [compaction] });

    const outcome = await runtime.resume("run_1");

    expect(outcome?.status).toBe("completed");
    expect(patches[0]).toEqual(expect.objectContaining({ status: "completed", error: null }));
  });

  it("settles a turn waiting on the client as completed, without re-asking", async () => {
    const history = [
      USER,
      msg("assistant", [
        { type: "step-start" },
        { type: "tool-askUser", toolCallId: "q1", state: "input-available", input: { question: "Which one?" } },
      ]),
    ];
    const { runtime, patches, appended } = runtimeOver(history, forbiddenModel());

    const outcome = await runtime.resume("run_1");

    // What onFinish would have written: completed, the question left standing
    // for applyToolResult to answer. Not awaiting_input — that is the approval
    // state, and applyToolResult opens its own run regardless.
    expect(outcome?.status).toBe("completed");
    expect(patches).toEqual([expect.objectContaining({ status: "completed", error: null })]);
    expect(appended).toEqual([]);
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
      // Recovery reads the chat for its parentAgent (DynamicAgentResolveContext).
      getChat: async () => null,
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
      async listRuns() {
        return [row];
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
      // Recovery reads the chat for its parentAgent (DynamicAgentResolveContext).
      getChat: async () => null,
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
      async listRuns() {
        return [row];
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
