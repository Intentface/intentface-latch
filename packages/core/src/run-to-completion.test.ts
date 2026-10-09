import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream, tool } from "ai";
import { z } from "zod";
import { createRuntime } from "./runtime.js";
import { defineContext, type ToolContext } from "./context.js";
import { defineAgent } from "./agent.js";
import type { AppMessage } from "./message.js";
import { memoryStorage } from "./__tests__/memory-storage.js";
import { defineExtension, type Extension } from "./extensions/extension.js";

/**
 * The single non-streaming turn path (`runToCompletion`) as seen through its
 * public callers: `runAgent` and `runDue`. Pins what the consolidation must
 * preserve — a fresh `sub_` thread when no id is given, continuation of an
 * existing thread, the internal chat kind, autonomous runs waiving gates while
 * scheduled fires keep them (and report `parked`), and the trigger stamp.
 */

type P = { orgId: string };
const principal: P = { orgId: "org_a" };

/**
 * A mock model that streams `text` (or a tool call first, then `text`). Streams
 * are built PER CALL — a ReadableStream is single-use, so a model reused across
 * runs must not hand out the same instance twice.
 */
function model(text: string, toolCall?: { name: string; input: string }) {
  const finish = (reason: string) => ({
    type: "finish",
    finishReason: { unified: reason, raw: reason },
    usage: { inputTokens: { total: 5 }, outputTokens: { total: 3 } },
  });
  const textStep = () => ({
    stream: simulateReadableStream({
      initialDelayInMs: 0,
      chunkDelayInMs: 0,
      chunks: [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "0" },
        { type: "text-delta", id: "0", delta: text },
        { type: "text-end", id: "0" },
        finish("stop"),
      ],
    }),
  });
  if (!toolCall) return new MockLanguageModelV4({ modelId: "mock", doStream: (async () => textStep()) as never });
  const callStep = () => ({
    stream: simulateReadableStream({
      initialDelayInMs: 0,
      chunkDelayInMs: 0,
      chunks: [
        { type: "stream-start", warnings: [] },
        { type: "tool-input-start", id: "call_1", toolName: toolCall.name },
        { type: "tool-input-delta", id: "call_1", delta: toolCall.input },
        { type: "tool-input-end", id: "call_1" },
        { type: "tool-call", toolCallId: "call_1", toolName: toolCall.name, input: toolCall.input },
        finish("tool-calls"),
      ],
    }),
  });
  // Tool-call step, then the answer — per RUN (two calls each), repeatable.
  let n = 0;
  return new MockLanguageModelV4({
    modelId: "mock-tools",
    doStream: (async () => (n++ % 2 === 0 ? callStep() : textStep())) as never,
  });
}

const gatedTool = tool({
  description: "writes something",
  inputSchema: z.object({ what: z.string() }),
  execute: async ({ what }) => ({ wrote: what }),
});

function runtimeWith(mem: ReturnType<typeof memoryStorage>, agentModel: MockLanguageModelV4, triggers: string[] = []) {
  return createRuntime<P>({
    storage: mem.storage,
    context: defineContext<P, unknown>({ build: async () => ({}) }),
    agents: {
      writer: defineAgent({
        model: agentModel,
        instructions: "write",
        tools: { write_thing: gatedTool },
        toolApproval: { write_thing: "user-approval" },
      }),
    },
    // The trigger stamp rides on the telemetry run meta.
    telemetry: { onRunFinished: (run) => void triggers.push(run.trigger) },
  });
}

describe("runAgent (autonomous)", () => {
  it("mints an internal sub_ thread, persists the exchange, returns the answer", async () => {
    const mem = memoryStorage();
    const rt = runtimeWith(mem, model("done."));
    const res = await rt.runAgent({ principal, agent: "writer", prompt: "go" });
    expect(res.threadId).toMatch(/^sub_/);
    expect(res.answer).toBe("done.");
    expect(mem.chats.get(res.threadId)?.kind).toBe("internal");
    const msgs = mem.messages.get(res.threadId)!;
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect([...mem.runs.values()][0]!.status).toBe("completed");
  });

  it("says why a turn failed: the provider's refusal comes back as `error`, not a silent empty answer", async () => {
    const mem = memoryStorage();
    const refusing = new MockLanguageModelV4({
      doStream: () => Promise.reject(new Error("'claude-haiku-4-5' does not support programmatic tool calling.")),
    });
    const res = await runtimeWith(mem, refusing).runAgent({ principal, agent: "writer", prompt: "go" });
    expect(res.answer).toBe("");
    expect(res.error).toContain("does not support programmatic tool calling");
  });

  it("continues an existing thread with its history; an empty threadId mints a fresh one", async () => {
    const mem = memoryStorage();
    const rt = runtimeWith(mem, model("again."));
    const first = await rt.runAgent({ principal, agent: "writer", prompt: "one" });
    const second = await rt.runAgent({ principal, agent: "writer", prompt: "two", threadId: first.threadId });
    expect(second.threadId).toBe(first.threadId);
    expect(mem.messages.get(first.threadId)!.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    const blank = await rt.runAgent({ principal, agent: "writer", prompt: "three", threadId: "  " });
    expect(blank.threadId).not.toBe(first.threadId);
    expect(blank.threadId).toMatch(/^sub_/);
  });

  it("a thread parked on an undecided approval is un-wedged: the stale gate is declined, this turn answers", async () => {
    const mem = memoryStorage();
    const rt = runtimeWith(mem, model("fresh answer"));
    // A previous turn ended awaiting a decision nobody gave (same shape handleChat guards against).
    const chat = await mem.storage.createChat(principal, { id: "sub_wedged", agent: "writer", kind: "internal" });
    await mem.storage.appendMessages(chat.id, [
      { id: "u1", role: "user", parts: [{ type: "text", text: "earlier" }], metadata: { visibility: "user" } },
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-write_thing",
            toolCallId: "call_old",
            state: "approval-requested",
            input: { what: "old" },
            approval: { id: "apv_old" },
          } as never,
        ],
        metadata: { visibility: "user" },
      } as AppMessage,
    ]);
    const res = await rt.runAgent({ principal, agent: "writer", prompt: "move on", threadId: chat.id });
    expect(res.answer).toBe("fresh answer");
    const stored = mem.messages.get(chat.id)!;
    const oldPart = stored.find((m) => m.id === "a1")!.parts[0] as { state: string; approval: { approved?: boolean } };
    expect(oldPart.state).toBe("approval-responded");
    expect(oldPart.approval.approved).toBe(false);
    expect(stored.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("blockGated (default) stubs the gated tool so a test run has no side effects", async () => {
    const mem = memoryStorage();
    const rt = runtimeWith(mem, model("did it.", { name: "write_thing", input: '{"what":"x"}' }));
    const res = await rt.runAgent({ principal, agent: "writer", prompt: "write" });
    expect(res.answer).toBe("did it.");
    const parts = mem.messages.get(res.threadId)!.flatMap((m) => m.parts) as Array<{
      type: string;
      output?: { __blocked?: boolean };
    }>;
    const toolPart = parts.find((p) => p.type === "tool-write_thing");
    expect(toolPart?.output?.__blocked).toBe(true);
  });

  it("stamps the trigger (programmatic by default, overridable)", async () => {
    const triggers: string[] = [];
    const mem = memoryStorage();
    const rt = runtimeWith(mem, model("ok"), triggers);
    await rt.runAgent({ principal, agent: "writer", prompt: "a" });
    await rt.runAgent({ principal, agent: "writer", prompt: "b", trigger: "chat" });
    expect(triggers).toEqual(["programmatic", "chat"]);
  });
});

describe("scheduled fire (runDue → runToCompletion)", () => {
  const schedule = {
    id: "sch_1",
    owner: "org_a",
    agent: "writer",
    identity: { orgId: "org_a" },
    cron: null,
    prompt: "do the write",
    nextRunAt: 0,
    enabled: true,
    createdAt: 0,
  };

  function withSchedules(mem: ReturnType<typeof memoryStorage>) {
    const s = mem.storage as unknown as Record<string, unknown>;
    s.claimDueSchedules = async () => [schedule];
    s.completeSchedule = async () => {};
    s.noteScheduleFire = async () => {};
    return mem;
  }

  it("keeps HITL gates: a gated tool parks the fire, which is reported", async () => {
    const triggers: string[] = [];
    const mem = withSchedules(memoryStorage());
    const rt = runtimeWith(mem, model("never reached", { name: "write_thing", input: '{"what":"x"}' }), triggers);
    const out = await rt.runDue();
    expect(out).toEqual({ fired: 1, errors: 0, skipped: 0, parked: 1, rejected: 0 });
    expect(triggers).toEqual(["schedule"]);
    // The fire ran in a USER-kind chat the scheduler created, not an internal sub_ thread.
    const chat = [...mem.chats.values()][0]!;
    expect(chat.kind).toBe("user");
    expect(chat.id).not.toMatch(/^sub_/);
    expect([...mem.runs.values()][0]!.status).toBe("awaiting_input");
  });

  it("an un-gated fire completes and is not parked", async () => {
    const mem = withSchedules(memoryStorage());
    const rt = runtimeWith(mem, model("report ready"));
    expect(await rt.runDue()).toEqual({ fired: 1, errors: 0, skipped: 0, parked: 0, rejected: 0 });
    const chat = [...mem.chats.values()][0]!;
    expect(mem.messages.get(chat.id)!.map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});

describe("options.context carries the runtime", () => {
  it("a tool can reach the runtime it runs under", async () => {
    let seen: unknown;
    const mem = memoryStorage();
    const rt = createRuntime<P>({
      storage: mem.storage,
      context: defineContext<P, unknown>({ build: async () => ({ flag: 1 }) }),
      agents: {
        probe: defineAgent({
          model: model("ok", { name: "probe", input: "{}" }),
          instructions: "probe",
          tools: {
            probe: tool({
              description: "probe",
              inputSchema: z.object({}),
              execute: async (_i, options) => {
                seen = (options as { context?: Record<string, unknown> }).context;
                return { ok: true };
              },
            }),
          },
        }),
      },
    });
    await rt.runAgent({ principal, agent: "probe", prompt: "x", blockGated: false });
    const ctx = seen as ToolContext<P, { flag: number }>;
    expect(ctx.flag).toBe(1);
    expect(ctx.principal).toEqual(principal);
    expect(ctx.run.agent).toBe("probe");
    expect(typeof ctx.run.id).toBe("string");
    expect(typeof ctx.run.chatId).toBe("string");
    expect(typeof ctx.writer.write).toBe("function");
    expect(ctx.runtime).toBe(rt);
  });
});

/**
 * Execution restrictions travel down a delegation AS A SET. A parent test run
 * (autoApprove + blockGated) stubs its own gated tools; the child it spawns
 * must be a test run too, or the "side-effect-free" trial writes for real one
 * level down.
 */
describe("delegation inherits the parent's restrictions", () => {
  it("a blockGated test run spawns a blockGated child: the child's gated tool is stubbed, never executed", async () => {
    const mem = memoryStorage();
    let executed = 0;
    const writeThing = tool({
      description: "writes something",
      inputSchema: z.object({ what: z.string() }),
      execute: async ({ what }) => {
        executed++;
        return { wrote: what };
      },
    });
    const rt = createRuntime<P>({
      storage: mem.storage,
      context: defineContext<P, unknown>({ build: async () => ({}) }),
      agents: {
        lead: defineAgent({
          model: model("delegated.", { name: "spawn_agent", input: '{"agent":"writer","prompt":"write x"}' }),
          instructions: "delegate",
          subagents: ["writer"],
        }),
        writer: defineAgent({
          model: model("did it.", { name: "write_thing", input: '{"what":"x"}' }),
          instructions: "write",
          tools: { write_thing: writeThing },
          toolApproval: { write_thing: "user-approval" },
        }),
      },
    });
    // runAgent = autonomous test run: autoApprove + blockGated (default true).
    const res = await rt.runAgent({ principal, agent: "lead", prompt: "go" });
    expect(res.answer).toBe("delegated.");
    expect(executed).toBe(0);
    // The child's tool part carries the stub marker, like the parent's would.
    const subChat = [...mem.chats.values()].find((c) => c.id !== res.threadId)!;
    const parts = mem.messages.get(subChat.id)!.flatMap((m) => m.parts) as Array<{
      type: string;
      output?: { __blocked?: boolean };
    }>;
    expect(parts.find((p) => p.type === "tool-write_thing")?.output?.__blocked).toBe(true);
  });
});

describe("runAgent says why a turn failed", () => {
  it("a turn that fails while it is set up returns the error and settles the run", async () => {
    const mem = memoryStorage();
    const rt = createRuntime<P>({
      storage: mem.storage,
      context: defineContext<P, unknown>({ build: async () => ({}) }),
      agents: {
        writer: defineAgent({
          model: model("written."),
          instructions: "write",
          toolSources: [{ open: async () => { throw new Error("mcp server down"); } }],
        }),
      },
    });
    const res = await rt.runAgent({ principal, agent: "writer", prompt: "go" });
    expect(res.error).toContain("mcp server down");
    expect(res.answer).toBe("");
    const run = [...mem.runs.values()].at(-1)!;
    expect(run.status).toBe("errored");
    expect(run.error).toContain("mcp server down");
  });

  it("says so when the failed run couldn't be settled either", async () => {
    const mem = memoryStorage();
    const storage = { ...mem.storage, updateRun: async () => { throw new Error("db down"); } };
    const rt = createRuntime<P>({
      storage,
      context: defineContext<P, unknown>({ build: async () => ({}) }),
      agents: {
        writer: defineAgent({
          model: model("written."),
          instructions: "write",
          toolSources: [{ open: async () => { throw new Error("mcp server down"); } }],
        }),
      },
    });
    const res = await rt.runAgent({ principal, agent: "writer", prompt: "go" });
    expect(res.error).toContain("mcp server down");
    expect(res.error).toContain("could not be marked failed: db down");
  });

  it("says so when the lease guard refuses the settlement", async () => {
    const mem = memoryStorage();
    const storage = { ...mem.storage, updateRun: async () => false };
    const rt = createRuntime<P>({
      storage,
      context: defineContext<P, unknown>({ build: async () => ({}) }),
      agents: {
        writer: defineAgent({
          model: model("written."),
          instructions: "write",
          toolSources: [{ open: async () => { throw new Error("mcp server down"); } }],
        }),
      },
    });
    const res = await rt.runAgent({ principal, agent: "writer", prompt: "go" });
    expect(res.error).toContain("could not be marked failed: its lease is held elsewhere");
  });

  it("a failure with no error chunk in the stream is read off the run", async () => {
    const mem = memoryStorage();
    const rt = createRuntime<P>({
      storage: mem.storage,
      context: defineContext<P, unknown>({ build: async () => ({}) }),
      // A critical extension failing at the last step ends the run errored in
      // onFinish — after the stream has nothing more to say.
      extensions: [
        defineExtension(
          "db",
          (ext) =>
            ext.on("step_end", () => {
              throw new Error("connection reset");
            }),
          { critical: true },
        ) as Extension,
      ],
      agents: { writer: defineAgent({ model: model("written."), instructions: "write" }) },
    });
    const res = await rt.runAgent({ principal, agent: "writer", prompt: "go" });
    expect([...mem.runs.values()].at(-1)!.status).toBe("errored");
    expect(res.error).toContain("connection reset");
  });
});

describe("run settings", () => {
  it("an unattended run records how it ran, so recovery can resume it the same way; a chat turn records nothing", async () => {
    const mem = memoryStorage();
    const rt = runtimeWith(mem, model("done."));
    await rt.runAgent({ principal, agent: "writer", prompt: "go", blockGated: "simulate-success", memory: false });
    const chatTurn = await rt.handleChat({ agent: "writer", principal, message: { id: "u_chat", role: "user", parts: [{ type: "text", text: "hi" }] } });
    await chatTurn.text();
    const [unattended, attended] = [...mem.runs.values()];
    expect(unattended!.settings).toEqual({ autoApprove: true, blockGated: "simulate-success", memory: false });
    expect(attended!.settings).toBeUndefined();
  });
});

describe("delegation inherits memory off", () => {
  it("runAgent({ memory: false }) spawns a child with memory off too: no recall, no memory tools", async () => {
    const mem = memoryStorage();
    const asked: string[] = [];
    const rt = createRuntime<P>({
      storage: mem.storage,
      context: defineContext<P, unknown>({ build: async () => ({}) }),
      memory: {
        instructionsFor: async ({ agent }) => (asked.push(agent), "remembered things"),
        toolsFor: ({ agent }) => (asked.push(`${agent}:tools`), {}),
      },
      agents: {
        lead: defineAgent({
          model: model("delegated.", { name: "spawn_agent", input: '{"agent":"writer","prompt":"write x"}' }),
          instructions: "delegate",
          subagents: ["writer"],
          memory: { scope: "agent-user", connection: "mem" } as never,
        }),
        writer: defineAgent({
          model: model("did it."),
          instructions: "write",
          memory: { scope: "agent-user", connection: "mem" } as never,
        }),
      },
    });
    const res = await rt.runAgent({ principal, agent: "lead", prompt: "go", memory: false });
    expect(res.answer).toBe("delegated.");
    expect(asked).toEqual([]);
  });
});

/**
 * Every continuation path re-runs the model over history whose last message is
 * the assistant turn that paused. `applyApproval` and `applyToolResult` trim
 * that turn's trailing narration first (see trim-prefill.test.ts); the subagent
 * resume that `applyApproval` routes a bubbled decision to must do the same, or
 * the sub's half-written sentence reaches ITS model as an assistant prefill.
 */
describe("subagent approval resume", () => {
  it("does not hand the sub's model its own trailing narration", async () => {
    const mem = memoryStorage();
    const prompts: Array<Array<{ role: string }>> = [];
    const capturingWriter = new MockLanguageModelV4({
      modelId: "mock-writer",
      doStream: (async ({ prompt }: { prompt: Array<{ role: string }> }) => {
        prompts.push(prompt);
        return {
          stream: simulateReadableStream({
            initialDelayInMs: 0,
            chunkDelayInMs: 0,
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "0" },
              { type: "text-delta", id: "0", delta: "written." },
              { type: "text-end", id: "0" },
              { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 5 }, outputTokens: { total: 2 } } },
            ],
          }),
        };
      }) as never,
    });
    const rt = createRuntime<P>({
      storage: mem.storage,
      context: defineContext<P, unknown>({ build: async () => ({}) }),
      agents: {
        lead: defineAgent({ model: model("all done."), instructions: "delegate", subagents: ["writer"] }),
        writer: defineAgent({
          model: capturingWriter,
          instructions: "write",
          tools: { write_thing: gatedTool },
          toolApproval: { write_thing: "user-approval" },
        }),
      },
    });
    // The sub thread, paused on its gated write — and narrating after it, the
    // way a model does ("Let me also ch…" cut off by the pause).
    await mem.storage.createChat(principal, { id: "sub_1", agent: "writer", kind: "internal" });
    await mem.storage.appendMessages("sub_1", [
      { id: "su1", role: "user", parts: [{ type: "text", text: "write x" }], metadata: { visibility: "user" } },
      {
        id: "sa1",
        role: "assistant",
        parts: [
          { type: "step-start" },
          { type: "tool-write_thing", toolCallId: "wc1", state: "approval-requested", input: { what: "x" }, approval: { id: "apv_1" } },
          { type: "step-start" },
          { type: "text", text: "Let me also ch" },
        ],
        metadata: { visibility: "user" },
      } as unknown as AppMessage,
    ]);
    // The parent, holding the bubbled approval for that sub.
    await mem.storage.createChat(principal, { id: "c_parent", agent: "lead" });
    await mem.storage.appendMessages("c_parent", [
      { id: "pu1", role: "user", parts: [{ type: "text", text: "get x written" }], metadata: { visibility: "user" } },
      {
        id: "pa1",
        role: "assistant",
        parts: [
          { type: "step-start" },
          { type: "tool-spawn_agent", toolCallId: "tc1", state: "output-available", input: { agent: "writer", prompt: "write x" }, output: { status: "awaiting_approval" } },
          {
            type: "data-subagent-approval",
            data: { approvalId: "sapv_1", subChatId: "sub_1", subApprovalIds: ["apv_1"], spawnToolCallId: "tc1", summaries: ["write_thing"] },
          },
        ],
        metadata: { visibility: "user" },
      } as unknown as AppMessage,
    ]);

    const res = await rt.applyApproval({ chatId: "c_parent", principal, decisions: [{ approvalId: "sapv_1", approved: true }] });
    await res.text();

    expect(prompts.length).toBeGreaterThanOrEqual(1);
    const sent = prompts[0]!;
    expect(sent[sent.length - 1]!.role).not.toBe("assistant");
    expect(JSON.stringify(sent)).not.toContain("Let me also ch");
    // The decision did flow through: the sub answered and the parent folded it in.
    const parent = mem.messages.get("c_parent")!.find((m) => m.id === "pa1")!;
    const spawn = parent.parts.find((p) => p.type === "tool-spawn_agent") as { output?: { answer?: string } };
    expect(spawn.output?.answer).toBe("written.");
  });
});

/**
 * An unattended run waives the agent's own approval policy — that is what makes
 * it autonomous. It must not waive the gates a TOOL SOURCE contributed: those
 * are the end user's choice about a connector, or the host's about a harness
 * tool, and executing them with nobody watching is exactly what they were set
 * to prevent.
 */
describe("unattended runs and source-contributed gates", () => {
  /** A tool source that gates its own tool, the way an MCP connection does. */
  const gatedSource = (executed: string[]) => ({
    async open() {
      return {
        tools: {
          crm_delete: tool({
            description: "delete a record",
            inputSchema: z.object({ id: z.string() }),
            execute: async ({ id }: { id: string }) => {
              executed.push(id);
              return { deleted: id };
            },
          }),
        },
        toolApproval: { crm_delete: "user-approval" },
        async close() {},
      };
    },
  });

  function runtimeFor(mem: ReturnType<typeof memoryStorage>, executed: string[], model: MockLanguageModelV4) {
    return createRuntime<P>({
      storage: mem.storage,
      context: defineContext<P, unknown>({ build: async () => ({}) }),
      agents: {
        writer: defineAgent({
          model,
          instructions: "write",
          toolSources: [gatedSource(executed) as never],
        }),
      },
    });
  }

  it("a real autonomous run parks on a connection's gate instead of executing it", async () => {
    const executed: string[] = [];
    const mem = memoryStorage();
    const rt = runtimeFor(mem, executed, model("never reached", { name: "crm_delete", input: '{"id":"c_1"}' }));

    // `blockGated: false` — the caller asked for a real end-to-end run. That
    // waives the AGENT's policy, not the end user's per-connector choice.
    await rt.runAgent({ principal, agent: "writer", prompt: "clean up", blockGated: false });

    expect(executed).toEqual([]);
    expect([...mem.runs.values()].at(-1)!.status).toBe("awaiting_input");
  });

  it("a trial run still stubs them and completes, rather than parking", async () => {
    const executed: string[] = [];
    const mem = memoryStorage();
    const rt = runtimeFor(mem, executed, model("did it.", { name: "crm_delete", input: '{"id":"c_1"}' }));

    // The default. `blockGated` has already neutralized the tool, so gating it
    // as well would park a run whose whole point is to finish.
    const res = await rt.runAgent({ principal, agent: "writer", prompt: "clean up" });

    expect(executed).toEqual([]);
    expect(res.answer).toBe("did it.");
    expect([...mem.runs.values()].at(-1)!.status).toBe("completed");
  });
});
