import { createClient } from "@libsql/client";
import { jsonSchema, parseJsonEventStream } from "ai";
import type { UIMessageChunk } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { beforeAll, describe, expect, it } from "vitest";
import { createRuntime, defineAgent, defineContext } from "@intentface/latch-core";
import type { Runtime, SubagentProgressData } from "@intentface/latch-core";
import { createSqliteAdapter, migrate } from "@intentface/latch-drizzle";

/**
 * The delegation rails the builder ⇄ eval-author pair rides, over the REAL
 * runtime with mock models: `subagents` config injects spawn_agent, the
 * subagent's plain-text answer (the JSON contract) round-trips back in the
 * tool result, and passing the returned threadId continues the SAME subagent
 * thread with its prior context intact (the diagnose-after-author flow).
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

const textStream = (text: string) =>
  streamFrom([
    { type: "stream-start", warnings: [] },
    { type: "response-metadata", id: "r", modelId: "mock", timestamp: new Date(0) },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: "stop", usage },
  ]);

const toolCallStream = (toolCallId: string, input: unknown) =>
  streamFrom([
    { type: "stream-start", warnings: [] },
    { type: "response-metadata", id: "r", modelId: "mock", timestamp: new Date(0) },
    { type: "tool-call", toolCallId, toolName: "spawn_agent", input: JSON.stringify(input) },
    { type: "finish", finishReason: "tool-calls", usage },
  ]);

const CASES_JSON = '```json\n[{"name":"greets","input":"hi","expected":{"assertions":{"contains":["hello"]}}}]\n```';
const VERDICT_JSON = '```json\n[{"caseId":"greets","cause":"phrasing","fixTarget":"case","suggestion":"contains: hi"}]\n```';

/** Set by the test between turns: the sub-thread the parent continues. */
let continueThreadId = "";

/** Parent (builder stand-in): turn 1 spawns fresh; turn 2 continues the thread. */
let parentCalls = 0;
const parentModel = new MockLanguageModelV3({
  doStream: async () => {
    parentCalls += 1;
    if (parentCalls === 1) {
      return { stream: toolCallStream("call_author", { agent: "author", prompt: "AUTHOR brief: lead-qualifier" }) };
    }
    if (parentCalls === 2) return { stream: textStream("drafted") };
    if (parentCalls === 3) {
      return {
        stream: toolCallStream("call_diagnose", {
          agent: "author",
          prompt: "DIAGNOSE run evr_1: greets failed",
          threadId: continueThreadId,
        }),
      };
    }
    return { stream: textStream("diagnosed") };
  },
});

/** Author (eval-author stand-in): strict-JSON answers; prompts captured. */
const authorPrompts: string[] = [];
let authorCalls = 0;
const authorModel = new MockLanguageModelV3({
  doStream: async (options) => {
    authorCalls += 1;
    authorPrompts.push(JSON.stringify(options.prompt));
    return { stream: textStream(authorCalls === 1 ? CASES_JSON : VERDICT_JSON) };
  },
});

const parent = defineAgent<P>({
  model: parentModel as never,
  instructions: "builder stand-in",
  subagents: ["author"],
});
const author = defineAgent<P>({
  model: authorModel as never,
  instructions: "eval-author stand-in",
});

async function drain(res: Response) {
  if (res.body) for await (const _ of res.body as unknown as AsyncIterable<unknown>) void _;
}

async function readChunks(res: Response): Promise<UIMessageChunk[]> {
  const out: UIMessageChunk[] = [];
  const parsed = parseJsonEventStream({
    stream: res.body!,
    schema: jsonSchema<UIMessageChunk>({}),
  }) as unknown as AsyncIterable<{ success: boolean; value: UIMessageChunk }>;
  for await (const part of parsed) if (part.success) out.push(part.value);
  return out;
}

type SpawnOutput = { threadId: string; answer: string };

async function lastSpawnOutput(runtime: Runtime<P>, chatId: string): Promise<SpawnOutput> {
  const history = await runtime.loadHistory({ chatId, principal });
  const parts = history.flatMap((m) => (m as { parts?: Record<string, unknown>[] }).parts ?? []);
  const spawns = parts.filter((p) => p.type === "tool-spawn_agent");
  const last = spawns.at(-1)!;
  expect(last.state).toBe("output-available");
  return last.output as SpawnOutput;
}

describe("builder → eval-author delegation over spawn_agent", () => {
  let runtime: Runtime<P>;

  beforeAll(async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    runtime = createRuntime<P, { orgId: string }>({
      storage: createSqliteAdapter<P>(client, { owner: (p) => [p.orgId, p.userId] }),
      context: defineContext<P, { orgId: string }>({
        build: ({ principal: p }) => ({ orgId: p.orgId }),
      }),
      agents: { parent, author },
    });
  });

  it("round-trips the JSON answer and continues the same sub-thread for diagnosis", async () => {
    const chatId = "chat_delegation";

    // Turn 1 — authoring: parent spawns the author with a brief. Capture the
    // wire: spawn_agent streams `data-subagent-progress` parts LIVE into the
    // parent turn (threadId up front, then the author's streaming exchange),
    // all before the tool result lands.
    const chunks = await readChunks(
      await runtime.handleChat({
        agent: "parent",
        chatId,
        principal,
        message: { id: "u1", role: "user", parts: [{ type: "text", text: "make evals" }] } as never,
      }),
    );
    const first = await lastSpawnOutput(runtime, chatId);
    expect(first.threadId).toMatch(/^sub_/);
    expect(first.answer).toBe(CASES_JSON);

    const types = chunks.map((c) => (c as { type: string }).type);
    const progressIdx = types.indexOf("data-subagent-progress");
    const resultIdx = types.indexOf("tool-output-available");
    expect(progressIdx).toBeGreaterThanOrEqual(0);
    expect(resultIdx).toBeGreaterThan(progressIdx);
    const progress = chunks
      .filter((c) => (c as { type: string }).type === "data-subagent-progress")
      .map((c) => (c as unknown as { data: SubagentProgressData }).data);
    // First write: the sub-thread id is known before any output streams.
    expect(progress[0].agent).toBe("author");
    expect(progress[0].threadId).toBe(first.threadId);
    expect(progress[0].messages).toEqual([]);
    // A later snapshot carries the live exchange (the brief is there; the
    // assistant snapshot follows as it streams — throttling may batch it).
    const last = progress.at(-1)!;
    expect(JSON.stringify(last.messages)).toContain("AUTHOR brief: lead-qualifier");

    // The sub-thread is a real, readable chat: brief in, JSON out.
    const subHistory = await runtime.loadHistory({ chatId: first.threadId, principal });
    expect(subHistory).toHaveLength(2);
    const briefText = ((subHistory[0] as { parts?: { type: string; text?: string }[] }).parts ?? [])
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");
    expect(briefText).toBe("AUTHOR brief: lead-qualifier");

    // Turn 2 — diagnosis: parent continues the SAME thread.
    continueThreadId = first.threadId;
    await drain(
      await runtime.handleChat({
        agent: "parent",
        chatId,
        principal,
        message: { id: "u2", role: "user", parts: [{ type: "text", text: "diagnose the run" }] } as never,
      }),
    );
    const second = await lastSpawnOutput(runtime, chatId);
    expect(second.threadId).toBe(first.threadId);
    expect(second.answer).toBe(VERDICT_JSON);

    // Continuation kept context: 4 messages in the thread, and the author's
    // second model call saw the original brief in its prompt.
    expect(await runtime.loadHistory({ chatId: first.threadId, principal })).toHaveLength(4);
    expect(authorCalls).toBe(2);
    expect(authorPrompts[1]).toContain("AUTHOR brief: lead-qualifier");
    expect(authorPrompts[1]).toContain("DIAGNOSE run evr_1");
  });
});
