import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AppMessage } from "@intentface/latch-core";
import { slackChannel, type SlackChannelConfig, type SlackChatMeta } from "./slackChannel.js";
import type { SlackAuditEvent } from "./audit.js";
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
      markSeen: async (chatId: string, ts: string) => {
        const meta = threads.get(chatId);
        if (meta) threads.set(chatId, { ...meta, lastSeenTs: ts });
      },
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

function harness(
  overrides: Partial<SlackChannelConfig<P>> = {},
  slack: { reply?: (method: string, body: Record<string, string>) => unknown } = {},
) {
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
    const custom = slack.reply?.(method, body);
    const payload =
      custom !== undefined
        ? custom
        : method === "chat.startStream"
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

    // UB @-mentions the bot in UA's thread — twice.
    for (const ts of ["1.2", "1.3"]) {
      await h.channel.handleRequest(
        signedRequest(eventBody(mention({ ts, thread_ts: "1.0", user: "UB", text: `<@${BOT}> and my dms?` }))),
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

describe("slackChannel v2 — strict mention-only & channel history", () => {
  const promptOf = (h: ReturnType<typeof harness>, n = 0) => {
    const arg = h.runtime.handleChat.mock.calls[n]![0] as {
      message: { parts: { type: string; text: string }[] };
    };
    return arg.message.parts[0]!.text;
  };
  const msg = (ts: string, user: string, text: string, extra: Record<string, unknown> = {}) => ({
    ts,
    user,
    text,
    ...extra,
  });

  it("never runs on an un-mentioned thread reply — not even the owner's", async () => {
    const audits: SlackAuditEvent[] = [];
    const h = harness({ audit: (e) => void audits.push(e) });
    await h.channel.handleRequest(signedRequest(eventBody(mention({ ts: "1.0", user: "UA" }))));
    await h.flush();
    expect(h.runtime.handleChat).toHaveBeenCalledTimes(1);
    expect(audits).toEqual([
      expect.objectContaining({ action: "trigger", decision: "allow", chatId: "slack2_A1_C1_1.0" }),
    ]);

    await h.channel.handleRequest(
      signedRequest(
        eventBody({
          type: "message",
          channel_type: "channel",
          channel: "C1",
          ts: "1.2",
          thread_ts: "1.0",
          user: "UA",
          text: "follow-up without a mention",
        }),
      ),
    );
    await h.flush();
    expect(h.runtime.handleChat).toHaveBeenCalledTimes(1);
    expect(audits.length).toBe(1); // dropped at the router — not even a decision
  });

  it("top-level mention: fetches the last 20 channel messages before it, oldest-first, fenced, bot excluded", async () => {
    const h = harness({}, {
      reply: (method) =>
        method === "conversations.history"
          ? {
              ok: true,
              messages: [
                msg("1.100", "U1", `<@${BOT}> hello there`), // the mention itself
                msg("1.050", BOT, "earlier bot answer"),
                msg("1.040", "U2", "second human line", { bot_id: undefined }),
                msg("1.030", "U3", "first human line"),
                msg("1.020", "UB", "bot-ish", { bot_id: "B1" }),
              ],
            }
          : undefined,
    });
    await h.channel.handleRequest(signedRequest(eventBody(mention({ ts: "1.100" }))));
    await h.flush();

    const hist = h.of("conversations.history");
    expect(hist.length).toBe(1);
    expect(hist[0]!.body).toMatchObject({ channel: "C1", latest: "1.100", limit: "20" });
    expect(h.of("conversations.replies").length).toBe(0);

    const text = promptOf(h);
    expect(text).toContain("untrusted third-party data");
    expect(text).toContain('<slack-history kind="channel" channel="C1">');
    const i3 = text.indexOf("first human line");
    const i2 = text.indexOf("second human line");
    expect(i3).toBeGreaterThan(-1);
    expect(i2).toBeGreaterThan(i3); // oldest first
    expect(text).not.toContain("earlier bot answer");
    expect(text).not.toContain("bot-ish");
    expect(text).not.toContain("hello there\n"); // the asking message is not in the fence
    expect(text.endsWith("The message addressed to you:\nhello there")).toBe(true);
    expect(h.stores.threads.get("slack2_A1_C1_1.100")?.lastSeenTs).toBe("1.100");
  });

  it("repeat mention in an owned thread: fetches only the delta since last seen, parent excluded, third parties fenced", async () => {
    const audits: SlackAuditEvent[] = [];
    const h = harness({ audit: (e) => void audits.push(e) }, {
      reply: (method, body) =>
        method === "conversations.replies"
          ? {
              ok: true,
              messages: [
                msg("1.0", "UA", "the parent"), // always returned by Slack
                ...(body.oldest
                  ? [msg("1.2", "UB", "maria's reply"), msg("1.3", "UA", `<@${BOT}> what did she say?`)]
                  : []),
              ],
            }
          : undefined,
    });
    await h.channel.handleRequest(signedRequest(eventBody(mention({ ts: "1.0", user: "UA" }))));
    await h.flush();
    expect(h.stores.threads.get("slack2_A1_C1_1.0")?.lastSeenTs).toBe("1.0");
    expect(h.of("conversations.replies").length).toBe(0); // top-level opener: no thread to read

    await h.channel.handleRequest(
      signedRequest(eventBody(mention({ ts: "1.3", thread_ts: "1.0", user: "UA", text: `<@${BOT}> what did she say?` }))),
    );
    await h.flush();
    const replies = h.of("conversations.replies");
    expect(replies.length).toBe(1);
    expect(replies[0]!.body).toMatchObject({ channel: "C1", ts: "1.0", oldest: "1.0" });
    expect(replies[0]!.body.latest).toBeUndefined();

    const text = promptOf(h, 1);
    expect(text).toContain('<slack-history kind="thread" channel="C1">');
    expect(text).toContain("[1.2] <@UB>: maria's reply");
    expect(text).not.toContain("the parent");
    expect(text).not.toContain("what did she say?\n"); // the mention itself is not context
    expect(h.stores.threads.get("slack2_A1_C1_1.0")?.lastSeenTs).toBe("1.3");
    expect(audits.map((a) => a.action)).toEqual(["trigger", "resume"]);
  });

  it("first mention inside a pre-existing human thread (or a thread without a watermark) reads a fresh tail, never an unbounded window", async () => {
    const h = harness({}, {
      reply: (method) =>
        method === "conversations.replies"
          ? { ok: true, messages: [msg("7.0", "U2", "parent"), msg("7.1", "U3", "reply one")] }
          : undefined,
    });
    // Thread row exists without lastSeenTs (a replay/delivery created it).
    h.stores.threads.set("slack2_A1_C1_7.0", { initiatorUserId: "U1", teamId: TEAM, createdAt: 1 });
    await h.channel.handleRequest(
      signedRequest(eventBody(mention({ ts: "7.5", thread_ts: "7.0", user: "U1" }))),
    );
    await h.flush();
    const r = h.of("conversations.replies");
    expect(r.length).toBe(1);
    expect(r[0]!.body).toMatchObject({ ts: "7.0", latest: "7.5", limit: "200" });
    expect(r[0]!.body.oldest).toBeUndefined();
    expect(promptOf(h)).toContain("[7.0] <@U2>: parent"); // no delta → the parent IS context
    expect(promptOf(h)).toContain("[7.1] <@U3>: reply one");
  });

  it("a failed turn does not advance the watermark", async () => {
    const h = harness();
    h.runtime.handleChat.mockRejectedValueOnce(new Error("model down"));
    await h.channel.handleRequest(signedRequest(eventBody(mention({ ts: "1.0" }))));
    await h.flush();
    expect(h.stores.threads.get("slack2_A1_C1_1.0")?.lastSeenTs).toBeUndefined();
    expect(h.of("chat.postMessage").some((c) => c.body.text?.includes("Something went wrong"))).toBe(true);
  });

  it("DMs: answered without a mention, no history fetched, no attribution footer", async () => {
    const h = harness();
    await h.channel.handleRequest(
      signedRequest(
        eventBody({ type: "message", channel_type: "im", channel: "D1", ts: "5.0", user: "U1", text: "hi" }),
      ),
    );
    await h.flush();
    expect(h.runtime.handleChat).toHaveBeenCalledTimes(1);
    expect(h.of("conversations.history").length).toBe(0);
    expect(h.of("conversations.replies").length).toBe(0);
    expect(promptOf(h)).toBe("hi");
    const stop = h.of("chat.stopStream")[0]!.body as unknown as { blocks?: unknown[] };
    expect(JSON.stringify(stop.blocks ?? [])).not.toContain("requested by");
  });

  it("channel answers end with a 'requested by' footer on the closing message", async () => {
    const h = harness();
    await h.channel.handleRequest(signedRequest(eventBody(mention({ ts: "1.0", user: "UA" }))));
    await h.flush();
    const stop = h.of("chat.stopStream")[0]!.body as unknown as {
      blocks?: { type: string; elements?: { text: string }[] }[];
    };
    const footer = stop.blocks?.find((b) => b.type === "context");
    expect(footer?.elements?.[0]?.text).toBe("_requested by <@UA>_");
  });

  it("drops messages from another workspace before any identity lookup (Slack Connect)", async () => {
    const audits: SlackAuditEvent[] = [];
    const authorizeUser = vi.fn(async () => ({ allowed: true }));
    const h = harness({ audit: (e) => void audits.push(e), authorizeUser });
    // Envelope team differs from the installed workspace.
    const raw = JSON.stringify({
      type: "event_callback",
      event_id: "EvX",
      team_id: "T_OTHER",
      event: mention({ ts: "3.0", user: "UX" }),
    });
    await h.channel.handleRequest(signedRequest(raw));
    await h.flush();
    // Envelope team matches but the message carries a foreign user_team.
    await h.channel.handleRequest(
      signedRequest(eventBody(mention({ ts: "3.1", user: "UY", user_team: "T_OTHER" }))),
    );
    await h.flush();

    expect(authorizeUser).not.toHaveBeenCalled();
    expect(h.runtime.handleChat).not.toHaveBeenCalled();
    expect(h.of("chat.postEphemeral").length).toBe(0);
    expect(audits).toEqual([
      expect.objectContaining({ decision: "deny", reason: "external_workspace", teamId: "T_OTHER", slackUserId: "UX" }),
      expect.objectContaining({ decision: "deny", reason: "external_workspace", teamId: "T_OTHER", slackUserId: "UY" }),
    ]);
  });

  it("audits the deny paths: non-starter, unlinked, busy", async () => {
    const audits: SlackAuditEvent[] = [];
    const authorizeUser = vi.fn(async ({ userId }: { userId: string }) =>
      userId === "UN"
        ? { allowed: false, linkUrl: "https://latch/link", message: "link please" }
        : { allowed: true, principal: { userId: "actor" } },
    );
    const h = harness({ audit: (e) => void audits.push(e), authorizeUser });
    await h.channel.handleRequest(signedRequest(eventBody(mention({ ts: "1.0", user: "UA" }))));
    await h.flush();
    await h.channel.handleRequest(
      signedRequest(eventBody(mention({ ts: "1.1", thread_ts: "1.0", user: "UB" }))),
    );
    await h.flush();
    await h.channel.handleRequest(signedRequest(eventBody(mention({ ts: "2.0", user: "UN" }))));
    await h.flush();
    // Hold the lease, then mention again.
    h.stores.leases.set("slack2_A1_C1_1.0", "held");
    await h.channel.handleRequest(
      signedRequest(eventBody(mention({ ts: "1.2", thread_ts: "1.0", user: "UA" }))),
    );
    await h.flush();

    expect(audits.map((a) => [a.action, a.decision, a.reason])).toEqual([
      ["trigger", "allow", undefined],
      ["resume", "deny", "non_starter"],
      ["trigger", "deny", "unlinked"],
      ["resume", "deny", "busy"],
    ]);
    expect(audits.every((a) => a.appId === APP)).toBe(true);
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
