import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AppMessage } from "@intentface/latch-core";
import { slackChannel, type SlackChannelConfig, type SlackChatMeta } from "./slackChannel.js";
import { encodeAction } from "./payloads.js";
import { APPROVE_ACTION, DENY_ACTION } from "./blocks.js";

const SECRET = "signing-secret";
const APP = "A1";
const TEAM = "T1";
const BOT = "UBOT";

// ── Request builders (real HMAC — the signature path is under test too) ─────

function signedRequest(raw: string, form = false): Request {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${raw}`).digest("hex")}`;
  return new Request("https://x.test/api/slack", {
    method: "POST",
    headers: {
      "content-type": form
        ? "application/x-www-form-urlencoded"
        : "application/json; charset=utf-8",
      "x-slack-signature": sig,
      "x-slack-request-timestamp": ts,
    },
    body: raw,
  });
}

let eventSeq = 0;
function eventBody(event: Record<string, unknown>, eventId?: string): string {
  return JSON.stringify({
    type: "event_callback",
    event_id: eventId ?? `Ev${++eventSeq}`,
    team_id: TEAM,
    event,
  });
}

function interactionBody(payload: Record<string, unknown>): string {
  return `payload=${encodeURIComponent(JSON.stringify(payload))}`;
}

/** A run Response in the runtime's SSE shape (what consumeRun parses). */
function sseResponse(chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
const textRun = (text: string) => sseResponse([{ type: "text-delta", id: "1", delta: text }]);

function approvalHistory(approvalId: string, toolName = "web_search"): AppMessage[] {
  return [
    {
      id: "m1",
      role: "assistant",
      parts: [
        {
          type: `tool-${toolName}`,
          state: "approval-requested",
          input: { q: "x" },
          approval: { id: approvalId },
        },
      ],
    } as unknown as AppMessage,
  ];
}

// ── In-memory stores with REAL semantics (TTL, fencing, first-writer-wins) ──

function memoryStores() {
  const claims = new Map<string, number>(); // key → expiresAt
  const leases = new Map<string, string>(); // chatId → token
  const threads = new Map<string, SlackChatMeta>();
  const stops = new Map<string, number>();
  let tokenSeq = 0;
  return {
    claims,
    leases,
    threads,
    stops,
    claimOnce: async (key: string, ttlMs: number) => {
      const exp = claims.get(key);
      if (exp !== undefined && exp > Date.now()) return false;
      claims.set(key, Date.now() + ttlMs);
      return true;
    },
    claimTurn: async (chatId: string) => {
      if (leases.has(chatId)) return null;
      const token = `tok${++tokenSeq}`;
      leases.set(chatId, token);
      return token;
    },
    releaseTurn: async (chatId: string, token: string) => {
      if (leases.get(chatId) === token) leases.delete(chatId);
    },
    threadStore: {
      claim: async (chatId: string, meta: SlackChatMeta) => {
        const existing = threads.get(chatId);
        if (existing) return existing;
        threads.set(chatId, meta);
        return meta;
      },
      get: async (chatId: string) => threads.get(chatId) ?? null,
      markStopped: async (chatId: string) => {
        stops.set(chatId, Date.now());
      },
      stoppedSince: async (chatId: string, sinceMs: number) =>
        (stops.get(chatId) ?? 0) > sinceMs,
    },
  };
}

// ── The harness ──────────────────────────────────────────────────────────────

type P = { userId: string; actor?: string };

function harness(overrides: Partial<SlackChannelConfig<P>> = {}) {
  const calls: { method: string; body: Record<string, string> }[] = [];
  let postSeq = 0;
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = String(url).split("/").pop()!;
    const raw = String(init?.body ?? "");
    const ct = String((init?.headers as Record<string, string>)?.["content-type"] ?? "");
    // Streaming methods post JSON; everything else is form-encoded.
    const body = ct.includes("application/json")
      ? (JSON.parse(raw) as Record<string, string>)
      : Object.fromEntries(new URLSearchParams(raw));
    calls.push({ method, body });
    const payload =
      method === "chat.startStream"
        ? { ok: true, ts: "100.1", channel: body.channel }
        : method === "chat.postMessage"
          ? { ok: true, ts: `200.${++postSeq}`, channel: body.channel }
          : method === "conversations.replies"
            ? { ok: true, messages: [] }
            : method === "conversations.open"
              ? { ok: true, channel: { id: "D9" } }
              : { ok: true };
    return new Response(JSON.stringify(payload), { status: 200 });
  });

  const deferred: Promise<unknown>[] = [];
  const runtime = {
    handleChat: vi.fn(async (_input: unknown) => textRun("Answer!")),
    applyApproval: vi.fn(async (_input: unknown) => textRun("Resumed.")),
    loadHistory: vi.fn(async (): Promise<AppMessage[]> => []),
  };
  const stores = memoryStores();

  const channel = slackChannel<P>({
    agent: "support",
    appId: APP,
    principal: { userId: "binder" },
    botToken: "xoxb-test",
    runtime,
    botUserId: BOT,
    teamId: TEAM,
    signingSecret: SECRET,
    waitUntil: (p) => {
      deferred.push(p);
    },
    claimOnce: stores.claimOnce,
    claimTurn: stores.claimTurn,
    releaseTurn: stores.releaseTurn,
    threads: stores.threadStore,
    authorizeUser: vi.fn(async () => ({ allowed: true, principal: { userId: "actor" } })),
    apiOptions: { fetchImpl: fetchImpl as unknown as typeof fetch },
    ...overrides,
  });

  return {
    channel,
    runtime,
    calls,
    stores,
    fetchImpl,
    flush: async () => {
      // Workers can defer more work (never here, but keep the loop honest).
      while (deferred.length) {
        const batch = deferred.splice(0);
        await Promise.all(batch);
      }
    },
    of: (method: string) => calls.filter((c) => c.method === method),
  };
}

const mention = (over: Record<string, unknown> = {}) => ({
  type: "app_mention",
  user: "U1",
  channel: "C1",
  ts: "1.100",
  text: `<@${BOT}> hello there`,
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────

describe("slackChannel v2 — ACK discipline", () => {
  it("returns 200 before doing ANY work; the turn runs on flush", async () => {
    const h = harness();
    const res = await h.channel.handleRequest(signedRequest(eventBody(mention())));
    expect(res.status).toBe(200);
    expect(h.calls.length).toBe(0);
    expect(h.runtime.handleChat).not.toHaveBeenCalled();
    await h.flush();
    expect(h.runtime.handleChat).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid signature with 401 and no side effects", async () => {
    const h = harness();
    const req = new Request("https://x.test/api/slack", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-signature": "v0=deadbeef",
        "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
      },
      body: eventBody(mention()),
    });
    expect((await h.channel.handleRequest(req)).status).toBe(401);
    await h.flush();
    expect(h.calls.length).toBe(0);
  });

  it("answers url_verification with the challenge", async () => {
    const h = harness();
    const res = await h.channel.handleRequest(
      signedRequest(JSON.stringify({ type: "url_verification", challenge: "chal-1" })),
    );
    expect(await res.text()).toBe("chal-1");
  });

  it("ACKs and drops everything outside the allowlist", async () => {
    const h = harness();
    for (const ev of [
      { type: "reaction_added", user: "U1" },
      { type: "message", channel_type: "channel", channel: "C1", ts: "9.9", user: "U1" }, // no thread_ts
      { type: "member_joined_channel", channel: "C1" },
    ]) {
      const res = await h.channel.handleRequest(signedRequest(eventBody(ev)));
      expect(res.status).toBe(200);
    }
    await h.flush();
    expect(h.calls.length).toBe(0);
    expect(h.runtime.handleChat).not.toHaveBeenCalled();
  });
});

describe("slackChannel v2 — dedupe & self-checks", () => {
  it("drops a redelivered event_id (Slack retry)", async () => {
    const h = harness();
    const raw = eventBody(mention(), "EvSAME");
    await h.channel.handleRequest(signedRequest(raw));
    await h.channel.handleRequest(signedRequest(raw));
    await h.flush();
    expect(h.runtime.handleChat).toHaveBeenCalledTimes(1);
  });

  it("runs ONE turn when a DM mention arrives as both app_mention and message.im — either order", async () => {
    for (const order of [
      ["app_mention", "message"],
      ["message", "app_mention"],
    ]) {
      const h = harness();
      for (const type of order) {
        const ev =
          type === "app_mention"
            ? mention({ channel: "D1", ts: "2.200" })
            : { type: "message", channel_type: "im", channel: "D1", ts: "2.200", user: "U1", text: "hello there" };
        await h.channel.handleRequest(signedRequest(eventBody(ev)));
      }
      await h.flush();
      expect(h.runtime.handleChat).toHaveBeenCalledTimes(1);
      // Both shapes resolve to the SAME chat: the DM channel's `_dm` chat.
      const input = h.runtime.handleChat.mock.calls[0]![0] as { chatId: string };
      expect(input.chatId).toBe("slack2_A1_D1_dm");
    }
  });

  it("runs ONE turn when a thread mention arrives as both app_mention and message.channels", async () => {
    const h = harness();
    // Establish the thread first (top-level mention roots the chat).
    await h.channel.handleRequest(signedRequest(eventBody(mention({ ts: "1.0" }))));
    await h.flush();
    // The same in-thread reply, delivered in both shapes.
    await h.channel.handleRequest(
      signedRequest(eventBody(mention({ ts: "1.5", thread_ts: "1.0" }))),
    );
    await h.channel.handleRequest(
      signedRequest(
        eventBody({
          type: "message",
          channel_type: "channel",
          channel: "C1",
          ts: "1.5",
          thread_ts: "1.0",
          user: "U1",
          text: `<@${BOT}> hello there`,
        }),
      ),
    );
    await h.flush();
    expect(h.runtime.handleChat).toHaveBeenCalledTimes(2); // opener + one reply
  });

  it("never answers itself, even without bot_id", async () => {
    const h = harness();
    await h.channel.handleRequest(
      signedRequest(eventBody(mention({ user: BOT, ts: "3.3" }))),
    );
    await h.flush();
    expect(h.runtime.handleChat).not.toHaveBeenCalled();
    expect(h.calls.length).toBe(0);
  });
});

describe("slackChannel v2 — admission", () => {
  it("posts ONE busy notice when the chat's turn lease is held", async () => {
    const h = harness({ claimTurn: async () => null });
    await h.channel.handleRequest(signedRequest(eventBody(mention())));
    await h.flush();
    expect(h.runtime.handleChat).not.toHaveBeenCalled();
    const eph = h.of("chat.postEphemeral");
    expect(eph.length).toBe(1);
    expect(eph[0]!.body.text).toContain("Still working");
  });

  it("releases the lease after a turn so the next message runs", async () => {
    const h = harness();
    await h.channel.handleRequest(signedRequest(eventBody(mention({ ts: "1.0" }))));
    await h.flush();
    await h.channel.handleRequest(
      signedRequest(eventBody(mention({ ts: "1.9", thread_ts: "1.0" }))),
    );
    await h.flush();
    expect(h.runtime.handleChat).toHaveBeenCalledTimes(2);
    expect(h.stores.leases.size).toBe(0);
  });

  it("anchors un-threaded DM streams to the asking message, chat identity stays _dm", async () => {
    const h = harness();
    await h.channel.handleRequest(
      signedRequest(
        eventBody({ type: "message", channel_type: "im", channel: "D1", ts: "6.1", user: "U1", text: "hi" }),
      ),
    );
    await h.flush();
    // The chat is the durable `_dm` identity…
    const input = h.runtime.handleChat.mock.calls[0]![0] as { chatId: string };
    expect(input.chatId).toBe("slack2_A1_D1_dm");
    // …but the stream threads under the message that asked — chat.startStream
    // needs a thread anchor in DMs (no anchor → permanent post+update fallback).
    const start = h.of("chat.startStream")[0]!;
    expect(start.body.thread_ts).toBe("6.1");
  });

  it("keeps un-threaded DM messages in ONE continuous chat", async () => {
    const h = harness();
    for (const ts of ["5.1", "5.2"]) {
      await h.channel.handleRequest(
        signedRequest(
          eventBody({ type: "message", channel_type: "im", channel: "D1", ts, user: "U1", text: "hi again" }),
        ),
      );
      await h.flush();
    }
    const ids = h.runtime.handleChat.mock.calls.map((c) => (c[0] as { chatId: string }).chatId);
    expect(ids).toEqual(["slack2_A1_D1_dm", "slack2_A1_D1_dm"]);
  });
});

describe("slackChannel v2 — initiator-owned threads", () => {
  it("gives a bystander ONE quiet notice, then silence; the initiator keeps driving", async () => {
    const h = harness();
    await h.channel.handleRequest(signedRequest(eventBody(mention({ ts: "1.0", user: "UA" }))));
    await h.flush();

    // UB replies in UA's thread — twice.
    for (const ts of ["1.2", "1.3"]) {
      await h.channel.handleRequest(
        signedRequest(
          eventBody({
            type: "message",
            channel_type: "channel",
            channel: "C1",
            ts,
            thread_ts: "1.0",
            user: "UB",
            text: "and my dms?",
          }),
        ),
      );
      await h.flush();
    }
    expect(h.runtime.handleChat).toHaveBeenCalledTimes(1); // only UA's opener
    const notices = h.of("chat.postEphemeral");
    expect(notices.length).toBe(1);
    expect(notices[0]!.body.text).toContain("<@UA>");

    // UA continues fine.
    await h.channel.handleRequest(
      signedRequest(eventBody(mention({ ts: "1.4", thread_ts: "1.0", user: "UA" }))),
    );
    await h.flush();
    expect(h.runtime.handleChat).toHaveBeenCalledTimes(2);
  });

  it("ignores plain thread replies in threads the bot never joined", async () => {
    const h = harness();
    await h.channel.handleRequest(
      signedRequest(
        eventBody({
          type: "message",
          channel_type: "channel",
          channel: "C1",
          ts: "7.2",
          thread_ts: "7.0",
          user: "U1",
          text: "random human thread",
        }),
      ),
    );
    await h.flush();
    expect(h.runtime.handleChat).not.toHaveBeenCalled();
    expect(h.calls.length).toBe(0);
  });
});

describe("slackChannel v2 — identity gate", () => {
  it("blocks an unlinked user with an ephemeral sign-in card", async () => {
    const h = harness({
      authorizeUser: async () => ({
        allowed: false,
        linkUrl: "https://latch.test/slack/link?token=t",
        message: "Sign in to Latch to use this agent.",
      }),
    });
    await h.channel.handleRequest(signedRequest(eventBody(mention())));
    await h.flush();
    expect(h.runtime.handleChat).not.toHaveBeenCalled();
    const eph = h.of("chat.postEphemeral");
    expect(eph.length).toBe(1);
    expect(eph[0]!.body.blocks).toContain("latch.test/slack/link");
  });

  it("stays silent for silent refusals (disabled bindings)", async () => {
    const h = harness({ authorizeUser: async () => ({ allowed: false, silent: true }) });
    await h.channel.handleRequest(signedRequest(eventBody(mention())));
    await h.flush();
    expect(h.calls.length).toBe(0);
  });

  it("runs the turn under the gate's principal", async () => {
    const h = harness();
    await h.channel.handleRequest(signedRequest(eventBody(mention())));
    await h.flush();
    const input = h.runtime.handleChat.mock.calls[0]![0] as { principal: P };
    expect(input.principal).toEqual({ userId: "actor" });
  });
});

describe("slackChannel v2 — approvals", () => {
  const CHAT = "slack2_A1_C1_1.0";

  async function postedApprovalValue(h: ReturnType<typeof harness>): Promise<string> {
    h.runtime.loadHistory.mockResolvedValue(approvalHistory("appr1"));
    await h.channel.handleRequest(signedRequest(eventBody(mention({ ts: "1.0" }))));
    await h.flush();
    const card = h
      .of("chat.postMessage")
      .find((c) => (c.body.blocks ?? "").includes(APPROVE_ACTION));
    expect(card).toBeDefined();
    const blocks = JSON.parse(card!.body.blocks!) as {
      type: string;
      elements?: { action_id: string; value: string }[];
    }[];
    const actions = blocks.find((b) => b.type === "actions")!;
    return actions.elements!.find((e) => e.action_id === APPROVE_ACTION)!.value;
  }

  function click(value: string, over: Record<string, unknown> = {}): string {
    return interactionBody({
      type: "block_actions",
      trigger_id: `trig${++eventSeq}`,
      team: { id: TEAM },
      user: { id: "U1" },
      channel: { id: "C1" },
      message: { ts: "200.9", thread_ts: "1.0" },
      actions: [{ action_id: APPROVE_ACTION, value }],
      ...over,
    });
  }

  it("posts a signed approval card and resumes on the actor's click", async () => {
    const h = harness();
    const value = await postedApprovalValue(h);
    h.runtime.loadHistory.mockResolvedValue([]);
    await h.channel.handleRequest(signedRequest(click(value), true));
    await h.flush();
    expect(h.runtime.applyApproval).toHaveBeenCalledTimes(1);
    const applied = h.runtime.applyApproval.mock.calls[0]![0] as {
      chatId: string;
      decisions: { approvalId: string; approved: boolean }[];
    };
    expect(applied.chatId).toBe(CHAT);
    expect(applied.decisions).toEqual([{ approvalId: "appr1", approved: true }]);
    // Card settled in place.
    expect(h.of("chat.update").length).toBe(1);
  });

  it("refuses a click from anyone but the requesting actor", async () => {
    const h = harness();
    const value = await postedApprovalValue(h);
    await h.channel.handleRequest(
      signedRequest(click(value, { user: { id: "UMALLORY" } }), true),
    );
    await h.flush();
    expect(h.runtime.applyApproval).not.toHaveBeenCalled();
    const eph = h.of("chat.postEphemeral");
    expect(eph[eph.length - 1]!.body.text).toContain("<@U1>");
  });

  it("treats a tampered or expired payload as a dead button", async () => {
    const h = harness();
    await postedApprovalValue(h);
    await h.channel.handleRequest(signedRequest(click("garbage.value"), true));
    await h.flush();
    expect(h.runtime.applyApproval).not.toHaveBeenCalled();
    const eph = h.of("chat.postEphemeral");
    expect(eph[eph.length - 1]!.body.text).toContain("expired");
  });

  it("dedupes a redelivered interaction by trigger_id", async () => {
    const h = harness();
    const value = await postedApprovalValue(h);
    h.runtime.loadHistory.mockResolvedValue([]);
    const raw = click(value, { trigger_id: "trigSAME" });
    await h.channel.handleRequest(signedRequest(raw, true));
    await h.channel.handleRequest(signedRequest(raw, true));
    await h.flush();
    expect(h.runtime.applyApproval).toHaveBeenCalledTimes(1);
  });

  it("denies via the deny button", async () => {
    const h = harness();
    const value = await postedApprovalValue(h);
    h.runtime.loadHistory.mockResolvedValue([]);
    await h.channel.handleRequest(
      signedRequest(click(value, { actions: [{ action_id: DENY_ACTION, value }] }), true),
    );
    await h.flush();
    const applied = h.runtime.applyApproval.mock.calls[0]![0] as {
      decisions: { approved: boolean }[];
    };
    expect(applied.decisions[0]!.approved).toBe(false);
  });
});

describe("slackChannel v2 — sessions & lifecycle", () => {
  it("handles agent_session_stopped: stop flag, stream closed, status reset", async () => {
    const h = harness();
    await h.channel.handleRequest(
      signedRequest(
        eventBody({
          type: "agent_session_stopped",
          channel: "D1",
          thread_ts: "8.0",
          user: "U1",
          streaming_message_ts: ["100.1"],
        }),
      ),
    );
    await h.flush();
    expect(h.stores.stops.has("slack2_A1_D1_8.0")).toBe(true);
    expect(h.of("chat.stopStream").length).toBe(1);
    const status = h.of("agents.sessions.setStatus");
    expect(status[status.length - 1]!.body.status).toBe("active");
  });

  it("pins suggested prompts on app_home_opened (messages tab only)", async () => {
    const h = harness({ suggestedPrompts: [{ title: "Hi", message: "Say hi" }] });
    await h.channel.handleRequest(
      signedRequest(eventBody({ type: "app_home_opened", tab: "home", channel: "D1", user: "U1" })),
    );
    await h.channel.handleRequest(
      signedRequest(
        eventBody({ type: "app_home_opened", tab: "messages", channel: "D1", user: "U1" }),
      ),
    );
    await h.flush();
    expect(h.of("assistant.threads.setSuggestedPrompts").length).toBe(1);
  });

  it("routes tokens_revoked / app_uninstalled to the lifecycle hook", async () => {
    const onLifecycle = vi.fn(async (_i: { type: string; teamId: string }) => {});
    const h = harness({ onLifecycle });
    await h.channel.handleRequest(signedRequest(eventBody({ type: "tokens_revoked" })));
    await h.channel.handleRequest(signedRequest(eventBody({ type: "app_uninstalled" })));
    await h.flush();
    expect(onLifecycle.mock.calls.map((c) => (c[0] as { type: string }).type)).toEqual([
      "tokens_revoked",
      "app_uninstalled",
    ]);
  });

  it("feedback clicks hit the hook and never touch the runtime", async () => {
    const onFeedback = vi.fn(async () => {});
    const h = harness({ onFeedback });
    await h.channel.handleRequest(
      signedRequest(
        interactionBody({
          type: "block_actions",
          trigger_id: "trigFb",
          team: { id: TEAM },
          user: { id: "U1" },
          channel: { id: "C1" },
          message: { ts: "200.1" },
          actions: [{ action_id: "latch_feedback", value: "negative" }],
        }),
        true,
      ),
    );
    await h.flush();
    expect(onFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ sentiment: "negative", userId: "U1" }),
    );
    expect(h.runtime.applyApproval).not.toHaveBeenCalled();
  });
});

describe("slackChannel v2 — host entries", () => {
  it("runMessage takes the lease, claims ownership, and runs the replay", async () => {
    const h = harness();
    await h.channel.runMessage({
      channel: "C1",
      root: "9.0",
      userId: "U1",
      prompt: "replayed after linking",
      principal: { userId: "actor" },
    });
    expect(h.runtime.handleChat).toHaveBeenCalledTimes(1);
    expect(h.stores.threads.get("slack2_A1_C1_9.0")?.initiatorUserId).toBe("U1");
    expect(h.stores.leases.size).toBe(0);
  });

  it("resumeApproval applies only a pending CONNECT approval", async () => {
    const h = harness();
    // Non-connect pending → no-op.
    h.runtime.loadHistory.mockResolvedValue(approvalHistory("appr1", "edit_file"));
    await h.channel.resumeApproval({
      chatId: "slack2_A1_C1_1.0",
      approvalId: "appr1",
      userId: "U1",
    });
    expect(h.runtime.applyApproval).not.toHaveBeenCalled();

    // Connect pending → approved.
    h.runtime.loadHistory.mockResolvedValue(approvalHistory("appr2", "connect_gmail"));
    await h.channel.resumeApproval({
      chatId: "slack2_A1_C1_1.0",
      approvalId: "appr2",
      userId: "U1",
    });
    expect(h.runtime.applyApproval).toHaveBeenCalledTimes(1);
  });

  it("resumeApproval ignores foreign and v1 chat ids", async () => {
    const h = harness();
    h.runtime.loadHistory.mockResolvedValue(approvalHistory("appr1", "connect_gmail"));
    await h.channel.resumeApproval({
      chatId: "slack2_OTHER_C1_1.0",
      approvalId: "appr1",
      userId: "U1",
    });
    await h.channel.resumeApproval({
      chatId: "slack_C1_1.0",
      approvalId: "appr1",
      userId: "U1",
    });
    expect(h.runtime.applyApproval).not.toHaveBeenCalled();
  });
});

describe("slackChannel v2 — payload sanity", () => {
  it("the approval card's value round-trips through encode/decode with the actor bound", async () => {
    const value = encodeAction(
      { kind: "approval", chatId: "slack2_A1_C1_1.0", approvalId: "a1", actor: "U1" },
      SECRET,
    );
    expect(value.length).toBeLessThanOrEqual(2000);
  });
});
