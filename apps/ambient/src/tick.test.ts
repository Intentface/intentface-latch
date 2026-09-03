import { describe, expect, it, vi } from "vitest";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream } from "ai";
import { createRuntime, defineContext } from "@intentface/latch-core";
import { createSqliteAdapter, migrate, schema } from "@intentface/latch-drizzle";
import { createWatcher, TICK_PROMPT, type Ctx } from "./agent.js";
import { owner, type Principal } from "./principal.js";
import type { ChannelMessage, Slack } from "./slack.js";
import { createStateStore } from "./state.js";
import { createTools } from "./tools.js";

/**
 * One whole tick through Latch, no network: a one-shot schedule fires through
 * `runtime.cron()`, the agent factory receives the channel's state via the
 * context builder, the model reads the channel, writes its state document and
 * thinks out loud, and the next tick's instructions carry what it wrote.
 * Channels are isolated by principal alone.
 */

const finish = (reason: "tool-calls" | "stop") => ({
  type: "finish",
  finishReason: reason,
  usage: { inputTokens: { total: 5 }, outputTokens: { total: 2 } },
});

const toolStep = (name: string, input: string) => ({
  stream: simulateReadableStream({
    initialDelayInMs: 0,
    chunkDelayInMs: 0,
    chunks: [
      { type: "stream-start", warnings: [] },
      { type: "tool-input-start", id: "call_1", toolName: name },
      { type: "tool-input-delta", id: "call_1", delta: input },
      { type: "tool-input-end", id: "call_1" },
      { type: "tool-call", toolCallId: "call_1", toolName: name, input },
      finish("tool-calls"),
    ],
  }),
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

const DOC = "## Open questions\n- anna asked who owns the deploy (ts 200.1)\n\n## Commitments\n\n## Decisions\n\n## Watching\n\n## Notes to self\n- first tick";

async function harness() {
  const client = createClient({ url: ":memory:" });
  await migrate(client);
  const state = createStateStore(client);
  await state.migrate();
  const db = drizzle(client, { schema });

  const messages: ChannelMessage[] = [
    { ts: "100.1", author: "bob", isBot: false, mentionsMe: false, text: "morning", at: "2026-09-03T08:00:00.000Z" },
    { ts: "200.1", author: "anna", isBot: false, mentionsMe: false, text: "who owns the deploy?", at: "2026-09-03T08:05:00.000Z" },
  ];
  const slack: Slack = {
    botUserId: async () => "UBOT",
    userName: async (id) => id ?? "someone",
    channelName: async (c) => (c === "C1" ? "general" : "other"),
    readSince: vi.fn(async (_c, cursor) => messages.filter((m) => !cursor || Number(m.ts) > Number(cursor))),
    readThread: vi.fn(async () => []),
    post: vi.fn(async () => ({ ts: "999.0" })),
  };
  const tools = createTools({ slack, state, maxPostsPerDay: 5 });

  // Scripted model: read → update_state → monologue. Records every system prompt it saw.
  const systemPrompts: string[] = [];
  const script = [
    () => toolStep("read_new_messages", "{}"),
    () => toolStep("update_state", JSON.stringify({ doc: DOC })),
    () => textStep("Anna's question is open; nothing for me to say yet."),
  ];
  let step = 0;
  const model = new MockLanguageModelV4({
    modelId: "mock-watcher",
    doStream: (async (options: { prompt: { role: string; content: unknown }[] }) => {
      const sys = options.prompt.find((m) => m.role === "system");
      if (sys) systemPrompts.push(typeof sys.content === "string" ? sys.content : JSON.stringify(sys.content));
      return script[step++ % script.length]!();
    }) as never,
  });

  const runtime = createRuntime<Principal, Ctx>({
    storage: createSqliteAdapter<Principal>(db, { owner }),
    context: defineContext<Principal, Ctx>({
      build: async ({ principal }) => ({
        state: await state.load(principal.channel),
        channelName: await slack.channelName(principal.channel),
      }),
    }),
    agents: { watcher: createWatcher({ model, tools }) },
  });
  return { runtime, state, slack, systemPrompts };
}

describe("one ambient tick through Latch", () => {
  it("a scheduled fire reads the channel, writes state, and the next tick starts from that state", async () => {
    const { runtime, state, slack, systemPrompts } = await harness();
    const principal: Principal = { channel: "C1" };

    await runtime.schedule({ principal, agent: "watcher", cron: null, prompt: TICK_PROMPT, onParked: "fire" });
    const first = await runtime.cron();
    expect(first.due).toMatchObject({ fired: 1, errors: 0 });
    expect(first.errors).toEqual([]);

    // The tools acted on the principal's channel, the cursor moved, the doc landed.
    expect(slack.readSince).toHaveBeenCalledWith("C1", null, 200);
    const saved = await state.load("C1");
    expect(saved.cursor).toBe("200.1");
    expect(saved.doc).toBe(DOC);
    expect(slack.post).not.toHaveBeenCalled();

    // First tick: instructions said the state was empty and named the channel.
    expect(systemPrompts[0]).toContain("#general");
    expect(systemPrompts[0]).toContain("(empty — you have not written one yet)");
    expect(systemPrompts[0]).toContain("Last read: never");

    // The run and the monologue are on record, under this channel only.
    const runs = await runtime.listRuns({ principal, limit: 5 });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("completed");
    const [chat] = await runtime.listChats({ principal, limit: 1 });
    const history = await runtime.loadHistory({ chatId: chat!.id, principal });
    const text = history.flatMap((m) => m.parts).find((p) => p.type === "text" && p.text.includes("open"));
    expect(text).toBeDefined();
    expect(await runtime.listChats({ principal: { channel: "C2" }, limit: 5 })).toEqual([]);
    expect(await state.load("C2")).toMatchObject({ doc: "", cursor: null });

    // Second tick: the factory rebuilt instructions from the saved document.
    await runtime.schedule({ principal, agent: "watcher", cron: null, prompt: TICK_PROMPT });
    const second = await runtime.cron();
    expect(second.due.fired).toBe(1);
    expect(systemPrompts[3]).toContain("anna asked who owns the deploy");
    expect(systemPrompts[3]).toContain("Last read: 1970-01-01T00:03:20.100Z");
    expect(slack.readSince).toHaveBeenLastCalledWith("C1", "200.1", 200);
  });
});
