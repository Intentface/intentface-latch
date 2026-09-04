import { describe, expect, it, vi } from "vitest";
import { createClient } from "@libsql/client";
import { createTools } from "./tools.js";
import { createStateStore, MAX_DOC_CHARS } from "./state.js";
import type { ChannelMessage, Slack } from "./slack.js";

/** The tools read the channel from `options.context`, exactly as the runtime stamps it. */
const options = (channel: string) =>
  ({ toolCallId: "t1", messages: [], context: { principal: { channel }, run: { id: "r", chatId: "c", agent: "watcher" } } }) as never;

const msg = (ts: string, text: string): ChannelMessage => ({ ts, author: "anna", isBot: false, mentionsMe: false, text, at: "2026-09-03T00:00:00.000Z" });

async function build(history: ChannelMessage[] = []) {
  const state = createStateStore(createClient({ url: ":memory:" }));
  await state.migrate();
  const slack: Slack = {
    botUserId: async () => "UBOT",
    botName: async () => "Ambient",
    react: vi.fn(async () => {}),
    userName: async (id) => (id === "U1" ? "anna" : id ?? "someone"),
    channelName: async () => "general",
    myChannels: async () => [{ id: "C1", name: "general" }],
    recentHistory: vi.fn(async () => history),
    readThread: vi.fn(async () => []),
    post: vi.fn(async () => ({ ts: `${Math.random()}` })),
    setThinking: vi.fn(async () => {}),
  };
  const tools = createTools({ slack, state, maxPostsPerDay: 2, now: () => 1_000_000 });
  const call = (name: string, input: unknown, channel = "C1") =>
    (tools[name] as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(input, options(channel));
  return { tools, state, slack, call };
}

describe("ambient tools", () => {
  it("read_inbox drains the inbox with names, and bootstraps history exactly once", async () => {
    const { call, state, slack } = await build([msg("50.1", "old context")]);
    await state.push("C1", "e1", { kind: "message", ts: "100.1", userId: "U1", text: "who owns the deploy?" });
    await state.push("C1", "e2", { kind: "reaction_added", ts: "100.2", userId: "U2", emoji: "white_check_mark", targetTs: "90.0" });
    const first = (await call("read_inbox", {})) as { count: number; events: unknown[]; history?: unknown[]; note?: string };
    expect(first.count).toBe(2);
    expect(first.events).toEqual([
      { kind: "message", ts: "100.1", text: "who owns the deploy?", at: "1970-01-01T00:01:40.100Z", who: "anna" },
      { kind: "reactions", ts: "100.2", emoji: "white_check_mark", targetTs: "90.0", at: "1970-01-01T00:01:40.200Z", who: ["U2"] },
    ]);
    expect(first.history).toHaveLength(1);
    expect(first.note).toMatch(/First look/);
    const second = (await call("read_inbox", {})) as { count: number; history?: unknown };
    expect(second.count).toBe(0);
    expect(second.history).toBeUndefined();
    expect(slack.recentHistory).toHaveBeenCalledTimes(1);
  });

  it("a pile of reactions folds: same-person add/remove cancels, survivors group per message and emoji", async () => {
    const { call, state } = await build();
    await state.push("C1", "r1", { kind: "reaction_added", ts: "1.0", userId: "U1", emoji: "white_check_mark", targetTs: "50.0" });
    await state.push("C1", "r2", { kind: "reaction_added", ts: "1.1", userId: "U2", emoji: "white_check_mark", targetTs: "50.0" });
    await state.push("C1", "r3", { kind: "reaction_removed", ts: "1.2", userId: "U1", emoji: "white_check_mark", targetTs: "50.0" });
    await state.push("C1", "r4", { kind: "reaction_added", ts: "1.3", userId: "U3", emoji: "eyes", targetTs: "50.0" });
    await state.push("C1", "r5", { kind: "reaction_removed", ts: "1.4", userId: "U4", emoji: "tada", targetTs: "60.0" }); // taken back, added before we watched
    await state.push("C1", "m1", { kind: "message", ts: "1.5", userId: "U1", text: "done" });
    const out = (await call("read_inbox", {})) as { events: { kind: string; emoji?: string; who?: unknown; removed?: boolean; targetTs?: string }[] };
    expect(out.events.map((e) => [e.kind, e.emoji, e.who, e.removed, e.targetTs])).toEqual([
      ["reactions", "white_check_mark", ["U2"], undefined, "50.0"],
      ["reactions", "eyes", ["U3"], undefined, "50.0"],
      ["reactions", "tada", ["U4"], true, "60.0"],
      ["message", undefined, "anna", undefined, undefined],
    ]);
  });

  it("update_state stores the document and refuses one over the cap", async () => {
    const { call, state } = await build();
    expect(await call("update_state", { doc: "## Open questions\n- x" })).toEqual({ ok: true, chars: 21 });
    expect((await state.load("C1")).doc).toBe("## Open questions\n- x");
    const big = (await call("update_state", { doc: "x".repeat(MAX_DOC_CHARS + 1) })) as { ok: boolean; error: string };
    expect(big.ok).toBe(false);
    expect(big.error).toMatch(/cap is/);
    expect((await state.load("C1")).doc).toBe("## Open questions\n- x");
  });

  it("post_to_channel budgets unprompted posts per channel but never replies to someone who asked", async () => {
    const { call, slack } = await build();
    expect(await call("post_to_channel", { text: "one", reason: "overdue" })).toMatchObject({ ok: true, kind: "unprompted" });
    expect(await call("post_to_channel", { text: "two", reason: "answer" })).toMatchObject({ ok: true });
    const refused = (await call("post_to_channel", { text: "three", reason: "correction" })) as { ok: boolean; error: string };
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/budget spent \(2\/2/);
    expect(await call("post_to_channel", { text: "reply", reason: "addressed", threadTs: "1.0" })).toMatchObject({ ok: true, kind: "addressed" });
    expect(await call("post_to_channel", { text: "my take", reason: "invited", threadTs: "1.0" })).toMatchObject({ ok: true, kind: "addressed" });
    expect(await call("post_to_channel", { text: "elsewhere", reason: "overdue" }, "C2")).toMatchObject({ ok: true });
    expect(slack.post).toHaveBeenCalledTimes(5);
    expect(slack.post).toHaveBeenLastCalledWith("C2", "elsewhere", undefined);
  });

  it("marks follow-ups to its own posts and messages that say its name; react is pinned to the channel", async () => {
    const { call, state, slack } = await build();
    await state.recordPost("C1", "100.0", "addressed"); // a top-level post of ours
    await state.recordPost("C1", "210.0", "addressed", "200.0"); // a reply of ours in thread 200.0
    await state.push("C1", "a", { kind: "message", ts: "160.0", userId: "U1", text: "so filter coffee is fine then?" }); // 60 s after our post
    await state.push("C1", "b", { kind: "reply", ts: "220.0", threadTs: "200.0", userId: "U1", text: "and this?" });
    await state.push("C1", "c", { kind: "message", ts: "5000.0", userId: "U1", text: "Ambient we are talking here" }); // long after, but by name
    await state.push("C1", "d", { kind: "message", ts: "5001.0", userId: "U1", text: "unrelated ambient noise levels" }); // 'ambient' as a word, not addressed? it is — name match is case-insensitive
    await state.push("C1", "e", { kind: "reply", ts: "5002.0", threadTs: "999.0", userId: "U2", text: "other thread" });
    const out = (await call("read_inbox", {})) as { events: { ts: string; followsMe?: boolean; addressesMe?: boolean }[] };
    expect(out.events.map((e) => [e.ts, !!e.followsMe, !!e.addressesMe])).toEqual([
      ["160.0", true, false],
      ["220.0", true, false],
      ["5000.0", false, true],
      ["5001.0", false, true],
      ["5002.0", false, false],
    ]);
    await call("react", { ts: "160.0", emoji: "coffee" }, "C1");
    expect(slack.react).toHaveBeenCalledWith("C1", "160.0", "coffee");
    (slack.react as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("slack:reactions.add failed: missing_scope"));
    expect(await call("react", { ts: "160.0", emoji: "coffee" }, "C1")).toMatchObject({ ok: false, transient: true, error: /missing_scope/ });
  });

  it("every tool acts on the principal's channel, never on model input", async () => {
    const { call, slack } = await build();
    await call("post_to_channel", { text: "hi", reason: "addressed" }, "C9");
    expect(slack.post).toHaveBeenCalledWith("C9", "hi", undefined);
    await call("read_thread", { threadTs: "5.0" }, "C9");
    expect(slack.readThread).toHaveBeenCalledWith("C9", "5.0");
  });
});
