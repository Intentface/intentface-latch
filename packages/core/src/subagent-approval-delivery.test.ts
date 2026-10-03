import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream, tool } from "ai";
import { z } from "zod";
import { createRuntime } from "./runtime.js";
import { defineContext } from "./context.js";
import { defineAgent } from "./agent.js";
import type { AppMessage } from "./message.js";
import { memoryStorage } from "./__tests__/memory-storage.js";

/**
 * What the CLIENT receives when a bubbled subagent approval is decided. The
 * decision resumes the sub thread before anything else can happen, so the
 * `applyApproval` response is the only channel through which the host learns
 * what that resume did — a second gate, progress, or the folded answer.
 * Storage being right is not enough: a web chat, a Slack thread or a Telegram
 * chat already showing the paused message only ever sees what is streamed.
 */

type P = { orgId: string };
const principal: P = { orgId: "org_a" };

const finish = (reason: string) => ({
  type: "finish",
  finishReason: { unified: reason, raw: reason },
  usage: { inputTokens: { total: 5 }, outputTokens: { total: 3 } },
});

const textStep = (text: string) => ({
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

const callStep = (id: string, toolName: string, input: string) => ({
  stream: simulateReadableStream({
    initialDelayInMs: 0,
    chunkDelayInMs: 0,
    chunks: [
      { type: "stream-start", warnings: [] },
      { type: "tool-input-start", id, toolName },
      { type: "tool-input-delta", id, delta: input },
      { type: "tool-input-end", id },
      { type: "tool-call", toolCallId: id, toolName, input },
      finish("tool-calls"),
    ],
  }),
});

/** A model that answers `text` on every call. */
const says = (text: string) =>
  new MockLanguageModelV4({ modelId: "mock", doStream: (async () => textStep(text)) as never });

/** A model that calls `toolName` on EVERY call (fresh call id each time). */
function alwaysCalls(toolName: string, input: string) {
  let n = 0;
  return new MockLanguageModelV4({
    modelId: "mock-calls",
    doStream: (async () => callStep(`call_${++n}`, toolName, input)) as never,
  });
}

const write_thing = tool({
  description: "writes something",
  inputSchema: z.object({ what: z.string() }),
  execute: async ({ what }) => ({ wrote: what }),
});

/** The UI-message chunks of an SSE response body. */
async function chunks(res: Response): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of (await res.text()).split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice("data: ".length);
    if (payload === "[DONE]") continue;
    out.push(JSON.parse(payload));
  }
  return out;
}

function runtime(mem: ReturnType<typeof memoryStorage>, models: { lead: MockLanguageModelV4; writer: MockLanguageModelV4 }) {
  return createRuntime<P>({
    storage: mem.storage,
    context: defineContext<P, unknown>({ build: async () => ({}) }),
    agents: {
      lead: defineAgent({ model: models.lead, instructions: "delegate", subagents: ["writer"] }),
      writer: defineAgent({
        model: models.writer,
        instructions: "write",
        tools: { write_thing },
        toolApproval: { write_thing: "user-approval" },
      }),
    },
  });
}

/** A parent turn holding a bubbled approval for `sub_1`, itself paused on a gated write. */
async function pausedDelegation(mem: ReturnType<typeof memoryStorage>) {
  await mem.storage.createChat(principal, { id: "sub_1", agent: "writer", kind: "internal", parentAgent: "lead" });
  await mem.storage.appendMessages("sub_1", [
    { id: "su1", role: "user", parts: [{ type: "text", text: "write x" }], metadata: { visibility: "user" } },
    {
      id: "sa1",
      role: "assistant",
      parts: [
        { type: "step-start" },
        { type: "tool-write_thing", toolCallId: "wc1", state: "approval-requested", input: { what: "x" }, approval: { id: "apv_1" } },
      ],
      metadata: { visibility: "user" },
    } as unknown as AppMessage,
  ]);
  await mem.storage.createChat(principal, { id: "c_parent", agent: "lead" });
  await mem.storage.appendMessages("c_parent", [
    { id: "pu1", role: "user", parts: [{ type: "text", text: "get x written" }], metadata: { visibility: "user" } },
    {
      id: "pa1",
      role: "assistant",
      parts: [
        { type: "step-start" },
        {
          type: "tool-spawn_agent",
          toolCallId: "tc1",
          state: "output-available",
          input: { agent: "writer", prompt: "write x" },
          output: { status: "awaiting_approval", threadId: "sub_1" },
        },
        {
          type: "data-subagent-approval",
          id: "sapv_1",
          data: { approvalId: "sapv_1", subChatId: "sub_1", subApprovalIds: ["apv_1"], spawnToolCallId: "tc1", summaries: ["write_thing"] },
        },
      ],
      metadata: { visibility: "user" },
    } as unknown as AppMessage,
  ]);
}

const approve = (rt: ReturnType<typeof runtime>) =>
  rt.applyApproval({ chatId: "c_parent", principal, decisions: [{ approvalId: "sapv_1", approved: true }] });

describe("deciding a bubbled subagent approval", () => {
  it("streams the approval the resumed subagent pauses on next", async () => {
    const mem = memoryStorage();
    // The resumed writer runs the approved write, then asks for ANOTHER one.
    const rt = runtime(mem, { lead: says("all done."), writer: alwaysCalls("write_thing", '{"what":"y"}') });
    await pausedDelegation(mem);

    const sent = await chunks(await approve(rt));

    const rebubbled = sent.filter((c) => c.type === "data-subagent-approval");
    expect(rebubbled).toHaveLength(1);
    const data = rebubbled[0]!.data as { approvalId: string; subChatId: string; spawnToolCallId: string };
    expect(data.approvalId).not.toBe("sapv_1");
    expect(data.subChatId).toBe("sub_1");
    expect(data.spawnToolCallId).toBe("tc1");
    // Streamed with its id, so a client reconciles it into the paused message.
    expect(rebubbled[0]!.id).toBe(data.approvalId);
    // And it is the same part storage holds — what a reload would show.
    const stored = mem.messages.get("c_parent")!.find((m) => m.id === "pa1")!;
    const storedIds = stored.parts
      .filter((p) => p.type === "data-subagent-approval")
      .map((p) => (p as { data: { approvalId: string } }).data.approvalId);
    expect(storedIds).toEqual(["sapv_1", data.approvalId]);
    // The parent did not continue: it is waiting on the new decision.
    expect(sent.some((c) => c.type === "text-delta")).toBe(false);
  });

  it("streams the subagent's progress while it resumes", async () => {
    const mem = memoryStorage();
    const rt = runtime(mem, { lead: says("all done."), writer: says("written.") });
    await pausedDelegation(mem);

    const sent = await chunks(await approve(rt));

    // The same part id `spawn_agent` streamed live under, so the client
    // updates the delegation it is already showing instead of adding one.
    const progress = sent.filter((c) => c.type === "data-subagent-progress");
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every((c) => c.id === "subagent_tc1")).toBe(true);
    expect(progress[0]!.data).toMatchObject({ toolCallId: "tc1", agent: "writer", threadId: "sub_1" });
  });

  it("streams the folded spawn_agent result, then the parent's continuation", async () => {
    const mem = memoryStorage();
    const rt = runtime(mem, { lead: says("all done."), writer: says("written.") });
    await pausedDelegation(mem);

    const sent = await chunks(await approve(rt));

    const folded = sent.findIndex((c) => c.type === "tool-output-available" && c.toolCallId === "tc1");
    expect(folded).toBeGreaterThanOrEqual(0);
    expect(sent[folded]!.output).toEqual({ threadId: "sub_1", answer: "written." });
    const answer = sent.findIndex((c) => c.type === "text-delta" && c.delta === "all done.");
    expect(answer).toBeGreaterThan(folded);
    // One assistant message: the continuation extends the paused one.
    const starts = sent.filter((c) => c.type === "start");
    expect(starts).toHaveLength(1);
    expect(starts[0]!.messageId).toBe("pa1");
  });
});

describe("a parent turn whose subagent paused for approval", () => {
  it("stops instead of delegating again", async () => {
    const mem = memoryStorage();
    // A lead that would spawn on every step if the loop let it.
    const lead = alwaysCalls("spawn_agent", '{"agent":"writer","prompt":"write x"}');
    const rt = runtime(mem, { lead, writer: alwaysCalls("write_thing", '{"what":"x"}') });

    const sent = await chunks(
      await rt.handleChat({
        agent: "lead",
        principal,
        chatId: "c_lead",
        message: { id: "u1", role: "user", parts: [{ type: "text", text: "get x written" }], metadata: { visibility: "user" } },
      }),
    );

    expect(sent.filter((c) => c.type === "data-subagent-approval")).toHaveLength(1);
    const stored = mem.messages.get("c_lead")!.at(-1)!;
    expect(stored.parts.filter((p) => p.type === "tool-spawn_agent")).toHaveLength(1);
    expect(lead.doStreamCalls).toHaveLength(1);
  });
});
