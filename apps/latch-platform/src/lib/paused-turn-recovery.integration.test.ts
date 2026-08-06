import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { jsonSchema, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { beforeEach, describe, expect, it } from "vitest";
import { createRuntime, defineAgent, defineContext } from "@intentface/latch-core";
import type { Runtime } from "@intentface/latch-core";
import { createSqliteAdapter, migrate, schema } from "@intentface/latch-drizzle";

/**
 * Regressions for two ways a chat could get PERMANENTLY wedged — both reported
 * from Telegram, both caused by scanning all of history for a pause that only
 * ever lives on the last message.
 *
 * 1. An undecided approval buried by a later turn made `handleChat` throw
 *    `PendingApprovalError` on every subsequent message, AND made `applyApproval`
 *    return an empty 200 without resuming — so no button press could clear it.
 * 2. An abandoned `askUser` call left `input-available` in history made every
 *    later `applyToolResult` in that chat return an empty 200 with no
 *    continuation: the user answers the questionnaire and the agent never
 *    resumes.
 *
 * …plus the third way out, for a pause the user can't satisfy at all (a
 * `connect_<name>` gate for a broken connection): a new message declines the
 * pending approval and runs, rather than being refused and dropped.
 */

type P = { orgId: string; userId: string };
const principal: P = { orgId: "org", userId: "user" };

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

const streamFrom = (parts: unknown[]) =>
  new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.close();
    },
  });

const meta = (id: string) => ({
  type: "response-metadata",
  id,
  modelId: "mock",
  timestamp: new Date(0),
});

/** What the model should do on each successive call, queued by the test. */
let script: (() => unknown[])[] = [];
const model = new MockLanguageModelV3({
  doStream: async () => {
    const next = script.shift() ?? (() => sayText("Nothing left to do."));
    return { stream: streamFrom(next()) };
  },
});

const sayText = (text: string) => [
  { type: "stream-start", warnings: [] },
  meta("r_text"),
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  { type: "finish", finishReason: "stop", usage },
];

const callAskUser = (toolCallId: string, question: string) => [
  { type: "stream-start", warnings: [] },
  meta("r_ask"),
  {
    type: "tool-call",
    toolCallId,
    toolName: "askUser",
    input: JSON.stringify({
      questions: [{ question, options: [{ label: "Yes", description: "y" }] }],
    }),
  },
  { type: "finish", finishReason: "tool-calls", usage },
];

/** Two parked client-tool calls in ONE step — only the second submit may resume. */
const callAskUserTwice = () => [
  { type: "stream-start", warnings: [] },
  meta("r_ask2"),
  {
    type: "tool-call",
    toolCallId: "call_a",
    toolName: "askUser",
    input: JSON.stringify({ questions: [{ question: "A?", options: [{ label: "Yes", description: "y" }] }] }),
  },
  {
    type: "tool-call",
    toolCallId: "call_b",
    toolName: "askUser",
    input: JSON.stringify({ questions: [{ question: "B?", options: [{ label: "Yes", description: "y" }] }] }),
  },
  { type: "finish", finishReason: "tool-calls", usage },
];

const callGated = (toolCallId: string) => [
  { type: "stream-start", warnings: [] },
  meta("r_gate"),
  { type: "tool-call", toolCallId, toolName: "gated", input: JSON.stringify({ n: 1 }) },
  { type: "finish", finishReason: "tool-calls", usage },
];

/** `askUser` has no execute — the SDK parks the call and the turn pauses. */
const agent = defineAgent<P>({
  model: model as never,
  instructions: "test agent",
  tools: {
    askUser: tool({
      description: "ask the user",
      inputSchema: jsonSchema<{ questions: unknown[] }>({
        type: "object",
        properties: { questions: { type: "array" } },
        required: ["questions"],
      }),
    }),
    gated: tool({
      description: "needs approval",
      inputSchema: z.object({ n: z.number() }),
      execute: async ({ n }) => ({ ok: n }),
    }),
  },
  toolApproval: { gated: "user-approval" },
});

async function drain(res: Response) {
  if (res.body) for await (const _ of res.body as unknown as AsyncIterable<unknown>) void _;
}

const isStream = (res: Response) =>
  (res.headers.get("content-type") ?? "").includes("text/event-stream");

const send = (runtime: Runtime<P>, chatId: string, text: string) =>
  runtime.handleChat({
    agent: "t",
    chatId,
    principal,
    message: { id: `u_${text}`, role: "user", parts: [{ type: "text", text }] } as never,
  });

describe("recovering a chat parked on a stale pause", () => {
  let runtime: Runtime<P>;

  beforeEach(async () => {
    script = [];
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    runtime = createRuntime<P, { orgId: string }>({
      storage: createSqliteAdapter<P>(drizzle(client, { schema }), {
        owner: (p) => [p.orgId, p.userId],
      }),
      context: defineContext<P, { orgId: string }>({
        build: ({ principal: p }) => ({ orgId: p.orgId }),
      }),
      agents: { t: agent },
    });
  });

  it("an abandoned askUser call does not stop a LATER questionnaire from resuming", async () => {
    const chatId = "chat_ask";
    // Turn 1 parks on askUser…
    script = [() => callAskUser("call_abandoned", "First?")];
    await drain(await send(runtime, chatId, "hello"));

    // …the user ignores it and just says something else, burying the parked call.
    script = [() => callAskUser("call_live", "Second?"), () => sayText("Thanks!")];
    await drain(await send(runtime, chatId, "never mind, something else"));

    const history = await runtime.loadHistory({ chatId, principal });
    const parked = (history.at(-1)!.parts as Record<string, unknown>[]).find(
      (p) => p.type === "tool-askUser" && p.state === "input-available",
    );
    expect(parked).toMatchObject({ toolCallId: "call_live" });

    // Answering the live questionnaire must RESUME, not return an empty 200 —
    // the abandoned call from turn 1 is still input-available in history.
    const res = await runtime.applyToolResult({
      chatId,
      principal,
      toolCallId: "call_live",
      output: { "Second?": "Yes" },
    });
    expect(isStream(res)).toBe(true);
    await drain(res);
  });

  it("answering an unknown or already-answered call is a no-op, not a spurious turn", async () => {
    const chatId = "chat_ask_idem";
    script = [() => callAskUser("call_1", "Q?"), () => sayText("Done.")];
    await drain(await send(runtime, chatId, "hi"));

    await drain(
      await runtime.applyToolResult({
        chatId,
        principal,
        toolCallId: "call_1",
        output: { "Q?": "Yes" },
      }),
    );
    const after = (await runtime.loadHistory({ chatId, principal })).length;

    // A redelivered submit (or a double-tapped button) must change nothing.
    const dup = await runtime.applyToolResult({
      chatId,
      principal,
      toolCallId: "call_1",
      output: { "Q?": "Yes" },
    });
    expect(isStream(dup)).toBe(false);
    const unknown = await runtime.applyToolResult({
      chatId,
      principal,
      toolCallId: "no_such_call",
      output: {},
    });
    expect(isStream(unknown)).toBe(false);
    expect((await runtime.loadHistory({ chatId, principal })).length).toBe(after);
  });

  it("answering an ABANDONED call is a no-op, not a spurious turn", async () => {
    // A stale button (or a redelivered submit) for a question buried turns ago
    // must not mutate dead history and must not resume an obsolete turn.
    const chatId = "chat_stale_submit";
    script = [() => callAskUser("call_dead", "Old?")];
    await drain(await send(runtime, chatId, "hi"));

    script = [() => sayText("Moving on.")];
    await drain(await send(runtime, chatId, "never mind"));
    const before = await runtime.loadHistory({ chatId, principal });

    const res = await runtime.applyToolResult({
      chatId,
      principal,
      toolCallId: "call_dead",
      output: { "Old?": "Yes" },
    });
    expect(isStream(res)).toBe(false);

    const after = await runtime.loadHistory({ chatId, principal });
    expect(after.length).toBe(before.length); // no extra assistant turn
    const dead = (after[1].parts as Record<string, unknown>[]).find(
      (p) => p.toolCallId === "call_dead",
    )!;
    expect(dead.state).toBe("input-available"); // untouched in stored history
  });

  it("with two parked calls in one step, only the second submit resumes", async () => {
    // `hasPendingToolResult` is scoped to the messages just touched, so a SIBLING
    // still awaiting a result must hold the resume — otherwise the re-run throws
    // MissingToolResultsError on the unanswered tool_use.
    const chatId = "chat_two_calls";
    script = [() => callAskUserTwice(), () => sayText("Both answered.")];
    await drain(await send(runtime, chatId, "hi"));

    const first = await runtime.applyToolResult({
      chatId,
      principal,
      toolCallId: "call_a",
      output: { "A?": "Yes" },
    });
    expect(isStream(first)).toBe(false); // sibling call_b still pending

    const second = await runtime.applyToolResult({
      chatId,
      principal,
      toolCallId: "call_b",
      output: { "B?": "Yes" },
    });
    expect(isStream(second)).toBe(true);
    await drain(second);
  });

  it("a new message supersedes a LIVE approval instead of being dropped", async () => {
    // Reported for a `connect_<name>` gate whose OAuth could never complete:
    // refusing the message left the chat with no way out at all — the user
    // could neither satisfy the gate nor talk past it, and every message they
    // typed was rejected before it was persisted, so it vanished on reload.
    const chatId = "chat_gate_live";
    script = [() => callGated("call_gate")];
    await drain(await send(runtime, chatId, "do the thing"));

    script = [() => sayText("Fine, doing it another way.")];
    const res = await send(runtime, chatId, "forget that, do it another way");
    expect(isStream(res)).toBe(true);
    await drain(res);

    const history = await runtime.loadHistory({ chatId, principal });
    // The gate is closed as declined — not left live, and not silently executed.
    const gate = history
      .flatMap((m) => m.parts as Record<string, unknown>[])
      .find((p) => p.type === "tool-gated")!;
    expect(gate.state).toBe("approval-responded");
    expect(gate.approval).toMatchObject({ approved: false });
    expect(String((gate.approval as { reason?: string }).reason)).toContain("Superseded");
    // …and the message that superseded it actually made it into history.
    expect(
      history.some(
        (m) =>
          m.role === "user" &&
          (m.parts as { text?: string }[]).some((p) => p.text === "forget that, do it another way"),
      ),
    ).toBe(true);
  });

  it("denying a live approval resumes the turn (the Dismiss button's path)", async () => {
    const chatId = "chat_gate_denied";
    script = [() => callGated("call_gate"), () => sayText("Okay, skipping that.")];
    await drain(await send(runtime, chatId, "do the thing"));

    const history = await runtime.loadHistory({ chatId, principal });
    const part = (history.at(-1)!.parts as Record<string, unknown>[]).find(
      (p) => p.type === "tool-gated",
    )!;
    const approvalId = (part.approval as { id: string }).id;

    const res = await runtime.applyApproval({
      chatId,
      principal,
      decisions: [{ approvalId, approved: false }],
    });
    expect(isStream(res)).toBe(true);
    await drain(res);

    // The chat is unblocked: a follow-up message runs as a normal turn.
    script = [() => sayText("Sure.")];
    const after = await send(runtime, chatId, "try something else");
    expect(isStream(after)).toBe(true);
    await drain(after);
  });

  it("a live approval resumes normally when decided", async () => {
    const chatId = "chat_gate_ok";
    script = [() => callGated("call_gate"), () => sayText("Approved and done.")];
    await drain(await send(runtime, chatId, "do the thing"));

    const history = await runtime.loadHistory({ chatId, principal });
    const part = (history.at(-1)!.parts as Record<string, unknown>[]).find(
      (p) => p.type === "tool-gated",
    )!;
    const approvalId = (part.approval as { id: string }).id;

    const res = await runtime.applyApproval({
      chatId,
      principal,
      decisions: [{ approvalId, approved: true }],
    });
    expect(isStream(res)).toBe(true);
    await drain(res);
  });
});
