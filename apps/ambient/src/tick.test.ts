import { describe, expect, it, vi } from "vitest";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream } from "ai";
import { createRuntime, defineContext, isChatBusyError } from "@intentface/latch-core";
import { createSqliteAdapter, migrate, schema } from "@intentface/latch-drizzle";
import { createWatcher, TICK_PROMPT, type Ctx } from "./agent.js";
import { owner, type Principal } from "./principal.js";
import type { Slack } from "./slack.js";
import { createStateStore } from "./state.js";
import { createTools } from "./tools.js";

/**
 * Two ticks through Latch, no network: each is one more turn of the channel's
 * ONE long-lived chat. The model drains the inbox, writes its state and thinks
 * out loud; the second tick's instructions carry the state, the chat carries
 * the earlier thinking, and a concurrent tick on the same channel is refused
 * as busy rather than interleaved. Another channel sees none of it.
 */

const finish = (reason: "tool-calls" | "stop") => ({ type: "finish", finishReason: reason, usage: { inputTokens: { total: 5 }, outputTokens: { total: 2 } } });
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
const textStep = (text: string, delayMs = 0) => ({
  stream: simulateReadableStream({
    initialDelayInMs: delayMs,
    chunkDelayInMs: 0,
    chunks: [{ type: "stream-start", warnings: [] }, { type: "text-start", id: "0" }, { type: "text-delta", id: "0", delta: text }, { type: "text-end", id: "0" }, finish("stop")],
  }),
});

const DOC = "## Open questions\n- anna asked who owns the deploy (ts 200.1)\n\n## Commitments\n\n## Decisions\n\n## Watching\n\n## Notes to self\n- first tick";

async function harness() {
  const client = createClient({ url: ":memory:" });
  await migrate(client);
  const state = createStateStore(client);
  await state.migrate();
  const db = drizzle(client, { schema });

  const slack: Slack = {
    botUserId: async () => "UBOT",
    userName: async (id) => (id === "U1" ? "anna" : id ?? "someone"),
    channelName: async (c) => (c === "C1" ? "general" : "other"),
    myChannels: async () => [{ id: "C1", name: "general" }],
    recentHistory: vi.fn(async () => [{ ts: "50.0", author: "bob", isBot: false, mentionsMe: false, text: "morning", at: "2026-09-03T08:00:00.000Z" }]),
    readThread: vi.fn(async () => []),
    post: vi.fn(async () => ({ ts: "999.0" })),
    setThinking: vi.fn(async () => {}),
  };
  const tools = createTools({ slack, state, maxPostsPerDay: 5 });

  const systemPrompts: string[] = [];
  const script = [
    () => toolStep("read_inbox", "{}"),
    () => toolStep("update_state", JSON.stringify({ doc: DOC })),
    () => textStep("Anna's question is open; nothing for me to say yet."),
  ];
  let step = 0;
  let slow = false;
  const model = new MockLanguageModelV4({
    modelId: "mock-watcher",
    doStream: (async (options: { prompt: { role: string; content: unknown }[] }) => {
      const sys = options.prompt.find((m) => m.role === "system");
      if (sys) systemPrompts.push(typeof sys.content === "string" ? sys.content : JSON.stringify(sys.content));
      if (slow) return textStep("slow", 150);
      return script[step++ % script.length]!();
    }) as never,
  });

  const runtime = createRuntime<Principal, Ctx>({
    storage: createSqliteAdapter<Principal>(db, { owner }),
    context: defineContext<Principal, Ctx>({
      build: async ({ principal }) => ({ state: await state.load(principal.channel), channelName: await slack.channelName(principal.channel) }),
    }),
    agents: { watcher: createWatcher({ model, tools }) },
  });
  const tick = (channel: string) => runtime.runAgent({ principal: { channel }, agent: "watcher", prompt: TICK_PROMPT, threadId: `ambient_${channel}`, blockGated: false });
  return { runtime, state, slack, systemPrompts, tick, setSlow: (v: boolean) => (slow = v) };
}

describe("the watcher's toolset", () => {
  it("asks for the harness web_fetch alongside its own four tools", async () => {
    const { runtime } = await harness();
    void runtime;
    const factory = createWatcher({ model: {} as never, tools: { a: {} as never } });
    const cfg = await factory({ context: { state: { channel: "C1", doc: "", bootstrappedAt: null, updatedAt: null }, channelName: "g" }, principal: { channel: "C1" } });
    expect(cfg.defaultTools).toEqual(["web_fetch"]);
    expect(cfg.instructions).toContain("web_fetch");
  });
});

describe("ticks on the channel's long-lived chat", () => {
  it("drains the inbox, writes state, and the next tick continues the same chat with that state", async () => {
    const { runtime, state, slack, systemPrompts, tick } = await harness();
    const principal: Principal = { channel: "C1" };
    await state.push("C1", "e1", { kind: "message", ts: "200.1", userId: "U1", text: "who owns the deploy?" });

    const first = await tick("C1");
    expect(first.threadId).toBe("ambient_C1");
    expect(first.answer).toContain("open");
    expect(await state.pending("C1")).toBe(0);
    expect((await state.load("C1")).doc).toBe(DOC);
    expect(slack.recentHistory).toHaveBeenCalledWith("C1", 50); // first look → bootstrap
    expect(slack.post).not.toHaveBeenCalled();
    expect(systemPrompts[0]).toContain("#general");
    expect(systemPrompts[0]).toContain("(empty — you have not written one yet)");

    // Second tick: same chat, instructions rebuilt from the saved document, earlier thinking still in history.
    await state.push("C1", "e2", { kind: "reaction_added", ts: "300.1", userId: "U2", emoji: "white_check_mark", targetTs: "200.1" });
    const second = await tick("C1");
    expect(second.threadId).toBe("ambient_C1");
    expect(systemPrompts[3]).toContain("anna asked who owns the deploy");
    const history = await runtime.loadHistory({ chatId: "ambient_C1", principal });
    expect(history.filter((m) => m.role === "user")).toHaveLength(2);
    expect(history.flatMap((m) => m.parts).filter((p) => p.type === "text" && p.text.includes("open"))).toHaveLength(2);
    expect(slack.recentHistory).toHaveBeenCalledTimes(1);

    // Isolation: another channel has no chat, no state.
    expect(await runtime.listChats({ principal: { channel: "C2" }, limit: 5 })).toEqual([]);
    expect(await state.load("C2")).toMatchObject({ doc: "", bootstrappedAt: null });
    expect(await runtime.listRuns({ principal, limit: 5 })).toHaveLength(2);
  });

  it("a second tick while one runs is refused as busy, not interleaved", async () => {
    const { tick, setSlow, state } = await harness();
    await state.push("C1", "e1", { kind: "message", ts: "1.0", text: "x" });
    await tick("C1"); // the chat exists now
    setSlow(true);
    const a = tick("C1");
    await new Promise((r) => setTimeout(r, 30)); // a has opened its run; the model is still "thinking"
    const b = await tick("C1").catch((e) => e);
    expect(isChatBusyError(b)).toBe(true);
    await a;
  });
});
