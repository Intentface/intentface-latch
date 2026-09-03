import { describe, expect, it, vi } from "vitest";
import { createClient } from "@libsql/client";
import { createTools } from "./tools.js";
import { createStateStore, MAX_DOC_CHARS } from "./state.js";
import type { ChannelMessage, Slack } from "./slack.js";

/** The tools read the channel from `options.context`, exactly as the runtime stamps it. */
const options = (channel: string) =>
  ({ toolCallId: "t1", messages: [], context: { principal: { channel }, run: { id: "r", chatId: "c", agent: "watcher" } } }) as never;

const msg = (ts: string, text: string): ChannelMessage => ({ ts, author: "anna", isBot: false, mentionsMe: false, text, at: "2026-09-03T00:00:00.000Z" });

async function build(messages: ChannelMessage[] = []) {
  const state = createStateStore(createClient({ url: ":memory:" }));
  await state.migrate();
  const slack: Slack = {
    botUserId: async () => "UBOT",
    userName: async (id) => (id === "U1" ? "anna" : id ?? "someone"),
    channelName: async () => "general",
    readSince: vi.fn(async (_c, cursor) => messages.filter((m) => !cursor || Number(m.ts) > Number(cursor))),
    readThread: vi.fn(async () => []),
    post: vi.fn(async () => ({ ts: `${Math.random()}` })),
  };
  const tools = createTools({ slack, state, maxPostsPerDay: 2, now: () => 1_000_000 });
  const call = (name: string, input: unknown, channel = "C1") =>
    (tools[name] as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(input, options(channel));
  return { tools, state, slack, call };
}

describe("ambient tools", () => {
  it("read_new_messages returns what is newer than the cursor and advances it", async () => {
    const { call, state } = await build([msg("100.1", "a"), msg("200.1", "b"), msg("300.1", "c")]);
    const first = (await call("read_new_messages", {})) as { count: number; since: string };
    expect(first.count).toBe(3);
    expect(first.since).toBe("the beginning");
    expect((await state.load("C1")).cursor).toBe("300.1");
    const again = (await call("read_new_messages", {})) as { count: number };
    expect(again.count).toBe(0);
  });

  it("read_new_messages hands over queued mentions with names, once", async () => {
    const { call, state } = await build([msg("100.1", "a")]);
    await state.addMention("C1", { ts: "300.1", threadTs: "200.0", userId: "U1", text: "<@UBOT> status?" });
    const out = (await call("read_new_messages", {})) as { mentions: unknown[] };
    expect(out.mentions).toEqual([
      { ts: "300.1", threadTs: "200.0", author: "anna", text: "<@UBOT> status?", at: "1970-01-01T00:05:00.100Z" },
    ]);
    expect(((await call("read_new_messages", {})) as { mentions: unknown[] }).mentions).toEqual([]);
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
    // Another channel has its own budget.
    expect(await call("post_to_channel", { text: "elsewhere", reason: "overdue" }, "C2")).toMatchObject({ ok: true });
    expect(slack.post).toHaveBeenCalledTimes(4);
    expect(slack.post).toHaveBeenLastCalledWith("C2", "elsewhere", undefined);
  });

  it("every tool acts on the principal's channel, never on model input", async () => {
    const { call, slack } = await build();
    await call("post_to_channel", { text: "hi", reason: "addressed" }, "C9");
    expect(slack.post).toHaveBeenCalledWith("C9", "hi", undefined);
    await call("read_thread", { threadTs: "5.0" }, "C9");
    expect(slack.readThread).toHaveBeenCalledWith("C9", "5.0");
  });
});
