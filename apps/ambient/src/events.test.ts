import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createClient } from "@libsql/client";
import { createEventsHandler, toObservation } from "./events.js";
import { createStateStore } from "./state.js";

const SECRET = "shh";
const NOW = 1_700_000_000_000;

function signed(body: unknown, opts: { secret?: string } = {}): Request {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(NOW / 1000));
  const sig = `v0=${createHmac("sha256", opts.secret ?? SECRET).update(`v0:${ts}:${raw}`).digest("hex")}`;
  return new Request("http://x/slack/events", {
    method: "POST",
    headers: { "x-slack-signature": sig, "x-slack-request-timestamp": ts, "content-type": "application/json" },
    body: raw,
  });
}

async function build(botUserId: () => Promise<string> = async () => "UBOT") {
  const state = createStateStore(createClient({ url: ":memory:" }));
  await state.migrate();
  const watched = new Set(["C1"]);
  const wake = vi.fn();
  const onJoin = vi.fn(async (c: string) => void watched.add(c));
  const onLeave = vi.fn(async (c: string) => void watched.delete(c));
  const handler = createEventsHandler({ signingSecret: SECRET, state, isWatched: (c) => watched.has(c), wake, onJoin, onLeave, botUserId, now: () => NOW });
  return { handler, state, wake, onJoin, onLeave, watched };
}

const cb = (event: Record<string, unknown>, event_id = `Ev${Math.random()}`) => ({ type: "event_callback", event_id, event });

describe("toObservation", () => {
  const me = "UBOT";
  it("messages, replies, edits, deletions, reactions, mentions", () => {
    expect(toObservation({ type: "message", channel: "C1", ts: "1.0", user: "U1", text: "hi" }, me)).toEqual({ channel: "C1", obs: { kind: "message", ts: "1.0", userId: "U1", text: "hi" } });
    expect(toObservation({ type: "message", channel: "C1", ts: "2.0", thread_ts: "1.0", user: "U1", text: "re", files: [{}] }, me)?.obs).toEqual({ kind: "reply", ts: "2.0", threadTs: "1.0", userId: "U1", text: "re", files: 1 });
    expect(toObservation({ type: "message", subtype: "message_changed", channel: "C1", event_ts: "3.0", message: { ts: "1.0", user: "U1", text: "hi!" } }, me)?.obs).toEqual({ kind: "edit", ts: "3.0", userId: "U1", text: "hi!", targetTs: "1.0" });
    expect(toObservation({ type: "message", subtype: "message_deleted", channel: "C1", event_ts: "4.0", deleted_ts: "1.0", previous_message: { ts: "1.0", user: "U1" } }, me)?.obs).toEqual({ kind: "delete", ts: "4.0", targetTs: "1.0" });
    expect(toObservation({ type: "reaction_added", user: "U2", reaction: "white_check_mark", event_ts: "5.0", item: { channel: "C1", ts: "1.0" } }, me)).toEqual({ channel: "C1", obs: { kind: "reaction_added", ts: "5.0", userId: "U2", emoji: "white_check_mark", targetTs: "1.0" } });
    expect(toObservation({ type: "app_mention", channel: "C1", ts: "6.0", thread_ts: "1.0", user: "U1", text: "<@UBOT> status?" }, me)?.obs).toEqual({ kind: "mention", ts: "6.0", threadTs: "1.0", userId: "U1", text: "<@UBOT> status?" });
  });

  it("drops its own posts, join/leave subtypes, the message twin of a mention, and unknown events", () => {
    expect(toObservation({ type: "message", channel: "C1", ts: "1.0", user: "UBOT", text: "me" }, me)).toBeNull();
    expect(toObservation({ type: "message", channel: "C1", ts: "1.0", bot_id: "B1", text: "bot w/o user" }, me)).toBeNull();
    expect(toObservation({ type: "message", subtype: "channel_join", channel: "C1", ts: "1.0", user: "U1", text: "joined" }, me)).toBeNull();
    expect(toObservation({ type: "message", channel: "C1", ts: "1.0", user: "U1", text: "<@UBOT> hi" }, me)).toBeNull();
    expect(toObservation({ type: "reaction_added", user: "UBOT", reaction: "eyes", item: { channel: "C1", ts: "1.0" } }, me)).toBeNull();
    expect(toObservation({ type: "pin_added", channel: "C1" }, me)).toBeNull();
  });
});

describe("events route", () => {
  it("rejects a bad signature and answers the url challenge", async () => {
    const { handler } = await build();
    expect((await handler(signed({ type: "url_verification", challenge: "abc" }, { secret: "wrong" }))).status).toBe(401);
    expect(await (await handler(signed({ type: "url_verification", challenge: "abc" }))).json()).toEqual({ challenge: "abc" });
  });

  it("queues observations and wakes: debounced for messages, immediately for mentions", async () => {
    const { handler, state, wake } = await build();
    await handler(signed(cb({ type: "message", channel: "C1", ts: "1.0", user: "U1", text: "hi" })));
    expect(wake).toHaveBeenLastCalledWith("C1", { now: false });
    await handler(signed(cb({ type: "app_mention", channel: "C1", ts: "2.0", user: "U1", text: "<@UBOT> ?" })));
    expect(wake).toHaveBeenLastCalledWith("C1", { now: true });
    expect((await state.drain("C1")).map((o) => o.kind)).toEqual(["message", "mention"]);
  });

  it("a redelivered event (same event_id) is queued once", async () => {
    const { handler, state } = await build();
    const body = cb({ type: "message", channel: "C1", ts: "1.0", user: "U1", text: "hi" }, "Ev1");
    await handler(signed(body));
    await handler(signed(body));
    expect(await state.pending("C1")).toBe(1);
  });

  it("ignores unwatched channels and follows the bot's own joins and leaves", async () => {
    const { handler, state, wake, onJoin, onLeave } = await build();
    await handler(signed(cb({ type: "message", channel: "C2", ts: "1.0", user: "U1", text: "hi" })));
    expect(wake).not.toHaveBeenCalled();
    await handler(signed(cb({ type: "member_joined_channel", channel: "C2", user: "UBOT" })));
    expect(onJoin).toHaveBeenCalledWith("C2");
    await handler(signed(cb({ type: "message", channel: "C2", ts: "2.0", user: "U1", text: "now watched" })));
    expect(await state.pending("C2")).toBe(1);
    await handler(signed(cb({ type: "member_joined_channel", channel: "C3", user: "U7" }))); // someone else
    expect(onJoin).toHaveBeenCalledTimes(1);
    await handler(signed(cb({ type: "member_left_channel", channel: "C2", user: "UBOT" })));
    expect(onLeave).toHaveBeenCalledWith("C2");
  });

  it("a failing self-check does not drop events", async () => {
    const { handler, state, wake } = await build(async () => {
      throw new Error("slack:auth.test failed: invalid_auth");
    });
    expect((await handler(signed(cb({ type: "app_mention", channel: "C1", ts: "1.0", user: "U1", text: "<@UBOT> hi" })))).status).toBe(200);
    expect(wake).toHaveBeenCalledWith("C1", { now: true });
    expect(await state.pending("C1")).toBe(1);
  });
});
