/**
 * Compaction shrinks the MODEL's view, not the person's.
 *
 * So the assertions come in pairs: what the model reads, and what is still in
 * storage. An earlier version of this extension replaced history outright and
 * every test still passed — because none of them checked that the original
 * turns survived.
 */
import { describe, it, expect } from "vitest";
import {
  MockLanguageModelV4,
  convertArrayToReadableStream,
  convertReadableStreamToArray,
} from "ai/test";
import type { UIMessage } from "ai";
import { runAgentLoop } from "./loop.js";
import {
  compaction,
  compactionPlan,
  lastSummaryIndex,
  SUMMARY_PART,
  type CompactionInfo,
} from "./compaction.js";
import { defineExtension, type Extension } from "./extension.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
} as never;

let prompts: unknown[] = [];

const replies = (delta: string) =>
  new MockLanguageModelV4({
    doStream: async (o) => {
      prompts.push(o.prompt);
      return {
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "response-metadata", id: "1", modelId: "m", timestamp: new Date(0) },
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta },
          { type: "text-end", id: "t" },
          { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
        ] as never),
      };
    },
  });

const summariser = (text = "They agreed on Tuesday.") =>
  new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text }],
      finishReason: "stop",
      usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
      warnings: [],
    }),
  } as never);

/** Distinguishable turns, so "is it still there" is answerable. */
const history = (n: number): UIMessage[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    parts: [{ type: "text" as const, text: `turn-${i}` }],
  }));

const capture = (fn: (m: UIMessage[]) => void): Extension =>
  defineExtension("cap", (ext) => ext.on("agent_end", ({ messages }) => fn(messages))) as Extension;

describe("what the reader keeps", () => {
  it("every original turn survives; the summary is INSERTED, not substituted", async () => {
    prompts = [];
    let info: CompactionInfo | undefined;
    let stored: UIMessage[] = [];

    await convertReadableStreamToArray(
      await runAgentLoop({
        model: replies("ok"),
        tools: {},
        messages: history(24),
        extensions: [
          compaction({
            model: summariser(),
            afterMessages: 10,
            keepLast: 4,
            onCompact: (i) => void (info = i),
          }),
          capture((m) => (stored = m)),
        ],
      }),
    );

    expect(info).toMatchObject({ summarised: 20, kept: 4 });

    // The point of the rewrite: nothing was thrown away.
    const text = JSON.stringify(stored);
    for (const i of [0, 5, 12, 19]) expect(text).toContain(`turn-${i}`);
    // 24 originals + the summary, with the reply merged into the trailing turn.
    expect(stored.length).toBe(25);
    expect(stored.filter((m) => m.parts.some((p) => p.type === SUMMARY_PART))).toHaveLength(1);
  });

  it("the summary prose is never in the transcript — only a marker", async () => {
    let stored: UIMessage[] = [];
    await convertReadableStreamToArray(
      await runAgentLoop({
        model: replies("ok"),
        tools: {},
        messages: history(24),
        extensions: [
          compaction({ model: summariser("They agreed on Tuesday."), afterMessages: 10, keepLast: 4 }),
          capture((m) => (stored = m)),
        ],
      }),
    );

    const marker = stored.find((m) => m.parts.some((p) => p.type === SUMMARY_PART))!;
    // One part, carrying data. A reader gets a divider, not a paragraph
    // restating what is already above it.
    expect(marker.parts).toHaveLength(1);
    expect(marker.parts[0]!.type).toBe(SUMMARY_PART);
    const data = (marker.parts[0] as { data: { summarised: number; kept: number } }).data;
    expect(data).toMatchObject({ summarised: 20, kept: 4 });

    // The prose exists nowhere a reader would see it as a message.
    const readable = stored.flatMap((m) =>
      (m.parts as Array<{ type: string; text?: string }>)
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? ""),
    );
    expect(readable.join(" ")).not.toContain("They agreed on Tuesday");
  });

  it("the model reads only from the summary onward", async () => {
    prompts = [];
    await convertReadableStreamToArray(
      await runAgentLoop({
        model: replies("ok"),
        tools: {},
        messages: history(24),
        extensions: [compaction({ model: summariser(), afterMessages: 10, keepLast: 4 })],
      }),
    );

    const seen = JSON.stringify(prompts[0]);
    expect(seen).toContain("They agreed on Tuesday");
    // The recent tail is verbatim…
    expect(seen).toContain("turn-23");
    // …and the summarised head is not sent again.
    expect(seen).not.toContain("turn-0");
    expect(seen).not.toContain("turn-12");
  });
});

describe("when it runs at all", () => {
  it("leaves a short conversation alone", async () => {
    let ran = false;
    await convertReadableStreamToArray(
      await runAgentLoop({
        model: replies("ok"),
        tools: {},
        messages: history(6),
        extensions: [
          compaction({ model: summariser(), afterMessages: 30, onCompact: () => void (ran = true) }),
        ],
      }),
    );
    expect(ran).toBe(false);
  });

  it("counts only what has happened since the last summary", async () => {
    const seen: number[] = [];
    const ext = () =>
      compaction({
        model: summariser(),
        afterMessages: 10,
        keepLast: 4,
        onCompact: (i) => void seen.push(i.summarised),
      });

    let stored: UIMessage[] = [];
    await convertReadableStreamToArray(
      await runAgentLoop({
        model: replies("ok"),
        tools: {},
        messages: history(24),
        extensions: [ext(), capture((m) => (stored = m))],
      }),
    );
    expect(seen).toHaveLength(1);

    // One more turn on top: far short of another 10 since the boundary.
    await convertReadableStreamToArray(
      await runAgentLoop({
        model: replies("ok"),
        tools: {},
        messages: [...stored, { id: "new", role: "user", parts: [{ type: "text", text: "more" }] }],
        extensions: [ext()],
      }),
    );
    expect(seen).toHaveLength(1);
  });

  it("never puts the boundary past an unanswered tool call", async () => {
    // The model must keep seeing the call it is waiting to have answered.
    const pending: UIMessage[] = [
      ...history(14),
      {
        id: "pending",
        role: "assistant",
        parts: [
          { type: "tool-deleteFile", toolCallId: "c1", state: "approval-requested", approval: { id: "ap1" } },
        ] as never,
      },
      ...history(6).map((m) => ({ ...m, id: `tail-${m.id}` })),
    ];

    let info: CompactionInfo | undefined;
    let stored: UIMessage[] = [];
    await convertReadableStreamToArray(
      await runAgentLoop({
        model: replies("ok"),
        tools: {},
        messages: pending,
        extensions: [
          compaction({
            model: summariser(),
            afterMessages: 10,
            keepLast: 1,
            onCompact: (i) => void (info = i),
          }),
          capture((m) => (stored = m)),
        ],
      }),
    );

    expect(info?.summarised).toBe(14);
    const i = lastSummaryIndex(stored);
    const open = stored.findIndex((m) =>
      (m.parts as Array<{ state?: string }>).some((p) => p.state === "approval-requested"),
    );
    // The boundary sits BEFORE the open call, so the model still reads it.
    expect(i).toBeLessThan(open);
  });
});

describe("the /compact command", () => {
  it("summarises a conversation the threshold would have left alone", async () => {
    let info: CompactionInfo | undefined;
    let stored: UIMessage[] = [];

    const chunks = await convertReadableStreamToArray(
      await runAgentLoop({
        model: replies("never called"),
        tools: {},
        messages: [
          ...history(7),
          { id: "cmd", role: "user", parts: [{ type: "text", text: "/compact" }] },
        ],
        extensions: [
          compaction({ model: summariser(), afterMessages: 30, onCompact: (i) => void (info = i) }),
          capture((m) => (stored = m)),
        ],
      }),
    );

    expect(info).toBeDefined();
    // A command, so the model was never called, and the reply says what really
    // happened rather than a fixed reassurance.
    expect(JSON.stringify(chunks)).toContain("still here to read");
    expect(chunks.some((c) => c.type === "data-compacted")).toBe(true);
    // Originals intact.
    for (const i of [0, 3, 6]) expect(JSON.stringify(stored)).toContain(`turn-${i}`);
  });

  it("refuses honestly when there is nothing behind us", async () => {
    // Three messages: the case a screenshot caught claiming success on a no-op.
    let ran = false;
    const chunks = await convertReadableStreamToArray(
      await runAgentLoop({
        model: replies("never called"),
        tools: {},
        messages: [
          { id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] },
          { id: "a1", role: "assistant", parts: [{ type: "text", text: "hi" }] },
          { id: "cmd", role: "user", parts: [{ type: "text", text: "/compact" }] },
        ],
        extensions: [
          compaction({ model: summariser(), afterMessages: 30, onCompact: () => void (ran = true) }),
        ],
      }),
    );
    expect(ran).toBe(false);
    expect(JSON.stringify(chunks)).toContain("Nothing to summarise yet");
    expect(chunks.some((c) => c.type === "data-compacted")).toBe(false);
  });

  it("can be turned off", async () => {
    let ran = false;
    const chunks = await convertReadableStreamToArray(
      await runAgentLoop({
        model: replies("model answered"),
        tools: {},
        messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "/compact" }] }],
        extensions: [
          compaction({
            model: summariser(),
            command: false,
            afterMessages: 30,
            onCompact: () => void (ran = true),
          }),
        ],
      }),
    );
    expect(ran).toBe(false);
    expect(JSON.stringify(chunks)).toContain("model answered");
  });

  it("the command and the moment agree, because one function decides", () => {
    expect(compactionPlan(history(3), { keepLast: 10, force: true })).toBeUndefined();
    expect(compactionPlan(history(20), { keepLast: 10, force: true })?.at).toBe(16);
    expect(compactionPlan(history(20), { keepLast: 10, force: false })?.at).toBe(10);
  });
});
