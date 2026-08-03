import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { jsonSchema, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { beforeEach, describe, expect, it } from "vitest";
import { createRuntime, defineAgent, defineContext } from "@intentface/latch-core";
import type { Runtime } from "@intentface/latch-core";
import { createSqliteAdapter, migrate, schema } from "@intentface/latch-drizzle";

/**
 * `/compact` on a real runtime: a Telegram DM is one conversation forever, so the
 * only way to stop its prompt growing is to summarize it and keep going. What
 * matters is that the NEXT turn stops sending the model the turns the summary
 * replaced — while stored history keeps all of it.
 */

type P = { orgId: string; userId: string };
const principal: P = { orgId: "org", userId: "user" };

const SUMMARY = "The user is training for a marathon in October and runs 4 times a week.";

const usage = {
  inputTokens: { total: 120, noCache: 120, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 30, text: 30, reasoning: 0 },
};

/** Every prompt the streaming (turn) path saw, and the summarizer's own. */
let streamPrompts: unknown[] = [];
let generatePrompts: unknown[] = [];
/** What the model should do on each successive streamed turn. */
let script: (() => unknown[])[] = [];

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

const model = new MockLanguageModelV3({
  doStream: async ({ prompt }) => {
    streamPrompts.push(prompt);
    const next = script.shift() ?? (() => sayText("Anything else?"));
    return { stream: streamFrom(next()) };
  },
  // The compaction pass is a single tool-free generate, not a streamed turn.
  doGenerate: async ({ prompt }) => {
    generatePrompts.push(prompt);
    return {
      content: [{ type: "text", text: SUMMARY }],
      finishReason: "stop",
      usage,
      warnings: [],
    } as never;
  },
});

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
  },
});

async function drain(res: Response) {
  if (res.body) for await (const _ of res.body as unknown as AsyncIterable<unknown>) void _;
}

const send = (runtime: Runtime<P>, chatId: string, text: string) =>
  runtime.handleChat({
    agent: "t",
    chatId,
    principal,
    message: { id: `u_${text}`, role: "user", parts: [{ type: "text", text }] } as never,
  });

const dump = (prompt: unknown) => JSON.stringify(prompt);

describe("compactChat", () => {
  let runtime: Runtime<P>;

  beforeEach(async () => {
    script = [];
    streamPrompts = [];
    generatePrompts = [];
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

  /** Two exchanges — enough to be worth compacting. */
  async function chatTwice(chatId: string) {
    script = [() => sayText("Nice, 4 times a week is solid."), () => sayText("October it is.")];
    await drain(await send(runtime, chatId, "I run four times a week"));
    await drain(await send(runtime, chatId, "my marathon is in October"));
  }

  it("later turns send the summary instead of the turns it replaced", async () => {
    const chatId = "chat_compact";
    await chatTwice(chatId);

    const res = await runtime.compactChat({ chatId, principal });
    expect(res).toMatchObject({ summary: SUMMARY, compacted: 4 });

    // The summarizer saw the real conversation…
    expect(dump(generatePrompts.at(-1))).toContain("I run four times a week");

    script = [() => sayText("Sub-4 is realistic.")];
    await drain(await send(runtime, chatId, "what pace should I target?"));

    // …and the next turn no longer does.
    const prompt = dump(streamPrompts.at(-1));
    expect(prompt).toContain(SUMMARY);
    expect(prompt).not.toContain("I run four times a week");
    expect(prompt).not.toContain("October it is.");
    expect(prompt).toContain("what pace should I target?");
  });

  it("keeps the whole conversation in storage and out of the user's view", async () => {
    const chatId = "chat_keep";
    await chatTwice(chatId);
    const before = await runtime.loadHistory({ chatId, principal });

    await runtime.compactChat({ chatId, principal });

    // The summary is `internal`: the web UI must not show a "user" message the
    // user never wrote, and nothing that was already there may disappear.
    const after = await runtime.loadHistory({ chatId, principal });
    expect(after).toHaveLength(before.length);
    expect(JSON.stringify(after)).not.toContain(SUMMARY);
  });

  it("accounts for the summarization call as its own completed run", async () => {
    const chatId = "chat_usage";
    await chatTwice(chatId);
    // Identify the compaction run by id, not by timestamp: two runs in the same
    // millisecond would make a `max(startedAt)` pick arbitrary.
    const before = new Set((await runtime.listRuns({ principal })).map((r) => r.id));

    await runtime.compactChat({ chatId, principal });

    const runs = await runtime.listRuns({ principal });
    const added = runs.filter((r) => !before.has(r.id));
    expect(added).toHaveLength(1);
    expect(added[0].status).toBe("completed");
    expect(added[0].usageOutputTokens).toBe(usage.outputTokens.total);
  });

  it("compacting twice summarizes only the live window", async () => {
    const chatId = "chat_twice";
    await chatTwice(chatId);
    await runtime.compactChat({ chatId, principal });

    script = [() => sayText("Noted."), () => sayText("Good plan.")];
    await drain(await send(runtime, chatId, "I also swim on Sundays"));
    await drain(await send(runtime, chatId, "and I lift on Tuesdays"));
    const second = await runtime.compactChat({ chatId, principal });

    // The second pass sees the first summary plus what came after it — not the
    // original turns, which the first summary already stands for.
    expect(second).toMatchObject({ compacted: 5 });
    const prompt = dump(generatePrompts.at(-1));
    expect(prompt).toContain(SUMMARY);
    expect(prompt).toContain("I also swim on Sundays");
    expect(prompt).not.toContain("I run four times a week");
  });

  it("does nothing to a conversation that is barely started", async () => {
    const chatId = "chat_short";
    script = [() => sayText("Hi!")];
    await drain(await send(runtime, chatId, "hello"));
    expect(await runtime.compactChat({ chatId, principal })).toBeNull();
    expect(generatePrompts).toHaveLength(0);
  });

  it("is a no-op for a chat that isn't the caller's", async () => {
    const chatId = "chat_theirs";
    await chatTwice(chatId);
    expect(
      await runtime.compactChat({ chatId, principal: { orgId: "org", userId: "someone-else" } }),
    ).toBeNull();
  });

  it("refuses while the turn is parked on a questionnaire", async () => {
    // The parked `tool_use` would fall behind the boundary and vanish from the
    // model view, while stored history still gates every new message — exactly
    // the wedge the tail-scoping fixes removed.
    const chatId = "chat_parked";
    await chatTwice(chatId);
    script = [() => callAskUser("call_live", "Which race?")];
    await drain(await send(runtime, chatId, "help me pick a race"));

    await expect(runtime.compactChat({ chatId, principal })).rejects.toMatchObject({
      code: "pending_approval",
    });
    expect(generatePrompts).toHaveLength(0);
  });
});
