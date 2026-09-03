import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createClient } from "@libsql/client";
import { createEventsHandler } from "./events.js";
import { createStateStore } from "./state.js";

const SECRET = "shh";
const NOW = 1_700_000_000_000;

function signed(body: unknown, opts: { secret?: string; ts?: number } = {}): Request {
  const raw = JSON.stringify(body);
  const ts = String(opts.ts ?? Math.floor(NOW / 1000));
  const sig = `v0=${createHmac("sha256", opts.secret ?? SECRET).update(`v0:${ts}:${raw}`).digest("hex")}`;
  return new Request("http://x/slack/events", {
    method: "POST",
    headers: { "x-slack-signature": sig, "x-slack-request-timestamp": ts, "content-type": "application/json" },
    body: raw,
  });
}

async function build() {
  const state = createStateStore(createClient({ url: ":memory:" }));
  await state.migrate();
  const wake = vi.fn();
  const handler = createEventsHandler({
    signingSecret: SECRET,
    isWatched: (c) => c === "C1",
    state,
    wake,
    botUserId: async () => "UBOT",
    now: () => NOW,
  });
  return { handler, state, wake };
}

const mention = (over: Record<string, unknown> = {}) => ({
  type: "event_callback",
  event: { type: "app_mention", channel: "C1", ts: "100.5", user: "U1", text: "<@UBOT> who owns the deploy?", ...over },
});

describe("slack events route", () => {
  it("rejects a bad signature and answers the url challenge", async () => {
    const { handler } = await build();
    expect((await handler(signed({ type: "url_verification", challenge: "abc" }, { secret: "wrong" }))).status).toBe(401);
    const res = await handler(signed({ type: "url_verification", challenge: "abc" }));
    expect(await res.json()).toEqual({ challenge: "abc" });
  });

  it("queues a mention for the next read and wakes the channel", async () => {
    const { handler, state, wake } = await build();
    expect((await handler(signed(mention()))).status).toBe(200);
    expect(wake).toHaveBeenCalledWith("C1");
    expect(await state.takeMentions("C1")).toEqual([{ ts: "100.5", userId: "U1", text: "<@UBOT> who owns the deploy?" }]);
    expect(await state.takeMentions("C1")).toEqual([]); // drained
  });

  it("keeps the thread of a mention inside a thread", async () => {
    const { handler, state } = await build();
    await handler(signed(mention({ ts: "300.1", thread_ts: "200.0" })));
    expect(await state.takeMentions("C1")).toEqual([{ ts: "300.1", threadTs: "200.0", userId: "U1", text: "<@UBOT> who owns the deploy?" }]);
  });

  it("ignores unwatched channels, its own messages, bots, and other events", async () => {
    const { handler, state, wake } = await build();
    await handler(signed(mention({ channel: "C2" })));
    await handler(signed(mention({ user: "UBOT" })));
    await handler(signed(mention({ bot_id: "B1" })));
    await handler(signed({ type: "event_callback", event: { type: "reaction_added", channel: "C1" } }));
    expect(wake).not.toHaveBeenCalled();
    expect(await state.takeMentions("C1")).toEqual([]);
    expect(await state.takeMentions("C2")).toEqual([]);
  });

  it("a failing self-check does not drop the mention", async () => {
    const state = createStateStore(createClient({ url: ":memory:" }));
    await state.migrate();
    const wake = vi.fn();
    const handler = createEventsHandler({
      signingSecret: SECRET,
      isWatched: () => true,
      state,
      wake,
      botUserId: async () => {
        throw new Error("slack:auth.test failed: invalid_auth");
      },
      now: () => NOW,
    });
    expect((await handler(signed(mention()))).status).toBe(200);
    expect(wake).toHaveBeenCalledWith("C1");
    expect(await state.takeMentions("C1")).toHaveLength(1);
  });

  it("the same mention delivered twice is queued once", async () => {
    const { handler, state } = await build();
    await handler(signed(mention()));
    await handler(signed(mention()));
    expect(await state.takeMentions("C1")).toHaveLength(1);
  });
});
