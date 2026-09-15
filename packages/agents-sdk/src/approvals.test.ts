/**
 * Approvals end to end, through persistence — the flow the lab app exercises.
 *
 * The first test here is a regression. Asking to delete two files produced two
 * approval cards; denying both failed the next run with "Tool results are
 * missing for tool calls …". The cause was the store's merge: a decision
 * arrives as an UPDATE to the trailing assistant message, and a dedupe by
 * message id threw it away, so the tool calls stayed unanswered. See
 * `reconcile.ts`.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import {
  MockLanguageModelV4,
  convertArrayToReadableStream,
  convertReadableStreamToArray,
} from "ai/test";
import { tool, type UIMessage } from "ai";
import { z } from "zod";
import { runAgentLoop } from "./loop.js";
import { reconcile } from "./reconcile.js";
import { loadMessages, sqlitePersistence, type SqliteDatabase } from "./sqlite.js";

const usage = {
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
  inputTokenDetails: {},
  outputTokenDetails: {},
} as never;

let prompts: Array<Array<{ role: string }>> = [];

/** One step, two gated calls: what "delete a.md and b.md" produces. */
const callsTwo = () =>
  new MockLanguageModelV4({
    doStream: async (o) => {
      prompts.push(o.prompt as Array<{ role: string }>);
      return {
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "response-metadata", id: "0", modelId: "mock", timestamp: new Date(0) },
          { type: "tool-call", toolCallId: "toolu_A", toolName: "deleteFile", input: '{"name":"a.md"}' },
          { type: "tool-call", toolCallId: "toolu_B", toolName: "deleteFile", input: '{"name":"b.md"}' },
          { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
        ] as never),
      };
    },
  });

const answers = () =>
  new MockLanguageModelV4({
    doStream: async (o) => {
      prompts.push(o.prompt as Array<{ role: string }>);
      return {
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "response-metadata", id: "1", modelId: "mock", timestamp: new Date(0) },
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "done" },
          { type: "text-end", id: "t" },
          { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
        ] as never),
      };
    },
  });

const deleted: string[] = [];
const tools = {
  deleteFile: tool({
    inputSchema: z.object({ name: z.string() }),
    needsApproval: true,
    execute: async ({ name }) => {
      deleted.push(name);
      return { deleted: name };
    },
  }),
};

const db = () => new Database(":memory:") as unknown as SqliteDatabase;
const ask: UIMessage[] = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "delete a.md and b.md" }] },
];

type ToolPart = { type: string; toolCallId?: string; state?: string; approval?: Record<string, unknown> };

/** What the browser writes when someone answers the cards. */
function decide(messages: UIMessage[], answersById: Record<string, boolean>): UIMessage[] {
  const copy = structuredClone(messages);
  for (const p of copy[1]!.parts as ToolPart[]) {
    if (!p.type.startsWith("tool-") || !p.toolCallId) continue;
    const approved = answersById[p.toolCallId];
    if (approved === undefined) continue;
    p.state = "approval-responded";
    p.approval = { ...p.approval, approved, ...(approved ? {} : { reason: "Declined from the lab UI." }) };
  }
  return copy;
}

const startRun = async (d: SqliteDatabase) => {
  deleted.length = 0;
  prompts = [];
  await convertReadableStreamToArray(
    await runAgentLoop({
      model: callsTwo(),
      tools,
      messages: ask,
      extensions: [sqlitePersistence(d, "c1")],
    }),
  );
  return loadMessages(d, "c1");
};

/** The lab posts only the trailing message, which is where decisions live. */
const resume = async (d: SqliteDatabase, decided: UIMessage[]) =>
  convertReadableStreamToArray(
    await runAgentLoop({
      model: answers(),
      tools,
      messages: [decided[1]!],
      extensions: [sqlitePersistence(d, "c1")],
    }),
  );

describe("two approvals in one step", () => {
  it("denying both resumes cleanly and tells the model why", async () => {
    const d = db();
    const stored = await startRun(d);
    expect((stored[1]!.parts as ToolPart[]).filter((p) => p.state === "approval-requested")).toHaveLength(2);

    const chunks = await resume(d, decide(stored, { toolu_A: false, toolu_B: false }));

    expect(chunks.filter((c) => c.type === "error")).toEqual([]);
    expect(deleted).toEqual([]);
    const toolMsg = JSON.stringify(prompts[1]!.filter((m) => m.role === "tool"));
    expect(toolMsg).toContain("execution-denied");
    expect(toolMsg).toContain("Declined from the lab UI.");
  });

  it("approving both executes both", async () => {
    const d = db();
    const stored = await startRun(d);
    const chunks = await resume(d, decide(stored, { toolu_A: true, toolu_B: true }));

    expect(chunks.filter((c) => c.type === "error")).toEqual([]);
    expect(deleted.sort()).toEqual(["a.md", "b.md"]);
  });

  it("a mixed answer runs one and refuses the other", async () => {
    const d = db();
    const stored = await startRun(d);
    const chunks = await resume(d, decide(stored, { toolu_A: true, toolu_B: false }));

    expect(chunks.filter((c) => c.type === "error")).toEqual([]);
    expect(deleted).toEqual(["a.md"]);
    expect(JSON.stringify(prompts[1]!.filter((m) => m.role === "tool"))).toContain("execution-denied");
  });

  it("the decisions are persisted, so a reload shows them", async () => {
    const d = db();
    const stored = await startRun(d);
    await resume(d, decide(stored, { toolu_A: false, toolu_B: false }));

    const after = loadMessages(d, "c1");
    const states = (after[1]!.parts as ToolPart[])
      .filter((p) => p.type.startsWith("tool-"))
      .map((p) => p.state);
    expect(states.every((s) => s !== "approval-requested")).toBe(true);
  });
});

describe("reconcile", () => {
  const storedMsgs: UIMessage[] = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
    {
      id: "a1",
      role: "assistant",
      parts: [
        { type: "text", text: "what the assistant actually said" },
        { type: "tool-deleteFile", toolCallId: "t1", state: "approval-requested", approval: { id: "ap1" } },
      ] as never,
    },
  ];

  it("takes the client's answer to an open tool call", () => {
    const sent: UIMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "tampered" },
          { type: "tool-deleteFile", toolCallId: "t1", state: "approval-responded", approval: { id: "ap1", approved: false } },
        ] as never,
      },
    ];
    const out = reconcile(storedMsgs, sent);
    const part = (out[1]!.parts as ToolPart[])[1]!;
    expect(part.state).toBe("approval-responded");
    expect(part.approval).toMatchObject({ approved: false });
  });

  it("does not let the client rewrite what the assistant said", () => {
    const sent: UIMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "tampered" },
          { type: "tool-deleteFile", toolCallId: "t1", state: "approval-responded", approval: { approved: true } },
        ] as never,
      },
    ];
    const out = reconcile(storedMsgs, sent);
    expect((out[1]!.parts as Array<{ text?: string }>)[0]!.text).toBe("what the assistant actually said");
  });

  it("does not flip a decision the store already recorded", () => {
    const settled: UIMessage[] = [
      storedMsgs[0]!,
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "tool-deleteFile", toolCallId: "t1", state: "approval-responded", approval: { approved: false } },
        ] as never,
      },
    ];
    const sent: UIMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "tool-deleteFile", toolCallId: "t1", state: "approval-responded", approval: { approved: true } },
        ] as never,
      },
    ];
    const part = (reconcile(settled, sent)[1]!.parts as ToolPart[])[0]!;
    expect(part.approval).toMatchObject({ approved: false });
  });

  it("still appends genuinely new messages", () => {
    const sent: UIMessage[] = [{ id: "u2", role: "user", parts: [{ type: "text", text: "and again" }] }];
    expect(reconcile(storedMsgs, sent).map((m) => m.id)).toEqual(["u1", "a1", "u2"]);
  });

  it("an empty store takes the client's messages as-is", () => {
    expect(reconcile([], storedMsgs)).toEqual(storedMsgs);
  });
});
