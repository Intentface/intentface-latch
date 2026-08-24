import { createClient } from "@libsql/client";
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackStore, migrateSlack } from "@/lib/slack-store";
import type { Principal } from "@/lib/session";

/**
 * The Slack conversation tools against a REAL store and a scripted Slack API —
 * what's under test is the authority model: everything derives from the run's
 * chat id, and reads are gated on the REQUESTER's membership, fail-closed.
 */

let client: Client;
let slackStore: ReturnType<typeof createSlackStore>;

vi.mock("@/lib/latch", () => ({
  getLatch: async () => ({
    slackStore,
    credentials: { get: async () => "xoxb-test" },
  }),
}));

const { slackTools, slackToolsApproval } = await import("./slack-tools");
type Exec = { execute: (args: unknown, options: unknown) => Promise<Record<string, unknown>> };
const read_channel = slackTools.slack_read_channel as Exec;
const read_thread = slackTools.slack_read_thread as Exec;
const list_channels = slackTools.slack_list_channels as Exec;
const post = slackTools.post_to_channel as Exec;

const principal: Principal = { orgId: "org1", userId: "owner" };
const CHAT = "slack2_A1_C1_1.0"; // home channel C1, requester UREQ
const ctx = (chatId = CHAT) => ({
  context: { principal, run: { id: "r1", chatId, agent: "support" } },
});

/** Scripted Slack Web API: membership per channel, plus canned reads. */
const world = {
  members: new Map<string, string[]>(),
  memberError: new Map<string, string>(), // channel → slack error code
  postError: undefined as string | undefined,
  calls: [] as { method: string; body: Record<string, string> }[],
};

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await migrateSlack(client);
  slackStore = createSlackStore(client);
  await slackStore.bind({
    appId: "A1",
    teamId: "T1",
    agent: "support",
    orgId: "org1",
    userId: "owner",
  });
  await slackStore.claimThread({ chatId: CHAT, appId: "A1", initiatorSlackUserId: "UREQ" });
  world.members.clear();
  world.memberError.clear();
  world.postError = undefined;
  world.calls = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const method = String(url).split("/").pop()!;
      const body = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
      world.calls.push({ method, body });
      const respond = (payload: Record<string, unknown>) =>
        new Response(JSON.stringify(payload), { status: 200 });
      if (method === "conversations.members") {
        const err = world.memberError.get(String(body.channel));
        if (err) return respond({ ok: false, error: err });
        return respond({ ok: true, members: world.members.get(String(body.channel)) ?? [] });
      }
      if (method === "conversations.history" || method === "conversations.replies") {
        return respond({
          ok: true,
          messages: [{ user: "U2", text: "hello world", ts: "9.1" }],
        });
      }
      if (method === "conversations.list") {
        return respond({ ok: true, channels: [{ id: "C9", name: "general" }] });
      }
      if (method === "chat.postMessage") {
        if (world.postError) return respond({ ok: false, error: world.postError });
        return respond({ ok: true, ts: "10.1", channel: body.channel });
      }
      return respond({ ok: true });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  client.close();
});

const calls = (method: string) => world.calls.filter((c) => c.method === method);

describe("slack tools: authority derivation", () => {
  it("refuses outside a Slack conversation (web runs, subagent runs)", async () => {
    for (const t of [read_channel, read_thread, list_channels, post]) {
      const r = await t.execute({ channel: "C9", thread_ts: "1.0", text: "x" }, ctx("chat_abc"));
      expect(String(r.error)).toContain("Slack conversation");
    }
    expect(world.calls.length).toBe(0);
  });

  it("refuses v1 chat ids — no legacy authority", async () => {
    const r = await read_channel.execute({ channel: "C9" }, ctx("slack_C1_1.0"));
    expect(r.error).toBeDefined();
  });

  it("refuses when the binding is disabled", async () => {
    await slackStore.setStatus("A1", "disabled", "app_uninstalled");
    const r = await read_channel.execute({ channel: "C1" }, ctx());
    expect(String(r.error)).toContain("disabled");
  });
});

describe("slack tools: requester-visibility gate", () => {
  it("reads the home channel without a membership walk", async () => {
    const r = await read_channel.execute({ channel: "C1" }, ctx());
    expect(r.messages).toEqual([{ from: "@U2", ts: "9.1", text: "hello world" }]);
    expect(calls("conversations.members").length).toBe(0);
  });

  it("reads another channel only when the requester is a member", async () => {
    world.members.set("C9", ["UREQ", "U2"]);
    const ok = await read_channel.execute({ channel: "C9" }, ctx());
    expect(ok.messages).toBeDefined();

    world.members.set("C8", ["U2"]); // requester NOT in C8
    const refused = await read_channel.execute({ channel: "C8" }, ctx());
    expect(String(refused.error)).toContain("isn't a member");
    // The refusal must short-circuit — no history read happened for C8.
    expect(calls("conversations.history").map((c) => c.body.channel)).toEqual(["C9"]);
  });

  it("asks for an /invite when the bot can't see the channel", async () => {
    world.memberError.set("C7", "not_in_channel");
    const r = await read_thread.execute({ channel: "C7", thread_ts: "5.0" }, ctx());
    expect(String(r.error)).toContain("/invite");
  });

  it("fails CLOSED when the membership walk can't complete", async () => {
    world.memberError.set("CBIG", "member_list_truncated");
    const r = await read_channel.execute({ channel: "CBIG" }, ctx());
    expect(String(r.error)).toContain("not allowed");
  });
});

describe("slack tools: post_to_channel", () => {
  it("is approval-gated by default", () => {
    expect(slackToolsApproval.post_to_channel).toBe("user-approval");
  });

  it("posts the full text as markdown blocks + notification text — NEVER markdown_text with text", async () => {
    const r = await post.execute({ channel: "C9", text: "# Summary\nAll good." }, ctx());
    expect(r.posted).toBe(true);
    const sent = calls("chat.postMessage")[0].body;
    // chat.postMessage rejects markdown_text combined with text
    // (markdown_text_conflict) — the observed live failure.
    expect(sent.markdown_text).toBeUndefined();
    expect(sent.text).toBeDefined();
    const blocks = JSON.parse(sent.blocks) as { type: string; text: string }[];
    expect(blocks[0]).toEqual({ type: "markdown", text: "# Summary\nAll good." });
    expect(sent.channel).toBe("C9");
  });

  it("relays Slack's error code instead of a bare failure", async () => {
    world.postError = "msg_too_long";
    const r = await post.execute({ channel: "C9", text: "hello" }, ctx());
    expect(String(r.error)).toContain("msg_too_long");
  });

  it("refuses empty posts", async () => {
    const r = await post.execute({ channel: "C9", text: "   " }, ctx());
    expect(r.error).toBeDefined();
    expect(calls("chat.postMessage").length).toBe(0);
  });

  it("rejects oversized posts instead of silently truncating what was approved", async () => {
    const r = await post.execute({ channel: "C9", text: "x".repeat(12_001) }, ctx());
    expect(String(r.error)).toContain("12000");
    expect(calls("chat.postMessage").length).toBe(0);
    const ok = await post.execute({ channel: "C9", text: "x".repeat(12_000) }, ctx());
    expect(ok.posted).toBe(true);
  });
});
