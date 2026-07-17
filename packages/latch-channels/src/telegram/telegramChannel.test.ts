import { describe, expect, it, vi } from "vitest";
import type { AppMessage } from "@intentface/latch-core";
import { telegramChannel, type TelegramChannelConfig } from "./telegramChannel.js";

const SECRET = "webhook-secret";

/** A run Response in the runtime's SSE shape (what consumeRun parses). */
function sseResponse(chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function textRun(text: string): Response {
  return sseResponse([{ type: "text-delta", id: "1", delta: text }]);
}

/** A history message parked on an approval-requested tool part. */
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

/** Build a channel over a fetch-mocked Bot API + an inline waitUntil collector. */
function harness(overrides: Partial<TelegramChannelConfig<{ userId: string }>> = {}) {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = String(url).split("/").pop()!;
    calls.push({ method, body: JSON.parse(String(init?.body ?? "{}")) });
    const result =
      method === "sendMessage" ? { message_id: 77 } : method === "getFile" ? {} : true;
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  });

  const deferred: Promise<unknown>[] = [];
  const runtime = {
    handleChat: vi.fn(async (_input: unknown) => textRun("Answer!")),
    applyApproval: vi.fn(async (_input: unknown) => textRun("Resumed.")),
    loadHistory: vi.fn(async (): Promise<AppMessage[]> => []),
  };

  const channel = telegramChannel<{ userId: string }>({
    agent: "support",
    botRef: "bot1",
    botToken: "T",
    webhookSecret: SECRET,
    runtime,
    authorizeUser: vi.fn(async () => ({ allowed: true, principal: { userId: "u1" } })),
    waitUntil: (p) => {
      deferred.push(p);
    },
    apiOptions: { fetchImpl: fetchImpl as unknown as typeof fetch },
    ...overrides,
  });

  return {
    channel,
    runtime,
    calls,
    flush: () => Promise.all(deferred),
    of: (method: string) => calls.filter((c) => c.method === method),
  };
}

function webhookRequest(update: unknown, secret = SECRET): Request {
  return new Request("http://host/api/telegram/bot1/events", {
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": secret },
    body: JSON.stringify(update),
  });
}

const dm = (text: string, over: Record<string, unknown> = {}) => ({
  update_id: 1,
  message: {
    message_id: 10,
    from: { id: 5, is_bot: false, username: "al" },
    chat: { id: 5, type: "private" },
    text,
    ...over,
  },
});

describe("telegramChannel.handleRequest", () => {
  it("rejects a wrong secret token with 401", async () => {
    const h = harness();
    const res = await h.channel.handleRequest(webhookRequest(dm("hi"), "wrong"));
    expect(res.status).toBe(401);
    expect(h.runtime.handleChat).not.toHaveBeenCalled();
  });

  it("runs a DM through the agent and streams the reply", async () => {
    const h = harness();
    const res = await h.channel.handleRequest(webhookRequest(dm("hi")));
    expect(res.status).toBe(200);
    await h.flush();

    expect(h.runtime.handleChat).toHaveBeenCalledTimes(1);
    const input = h.runtime.handleChat.mock.calls[0]![0] as {
      agent: string;
      chatId: string;
      principal: { userId: string };
      message: AppMessage;
    };
    expect(input.agent).toBe("support");
    expect(input.chatId).toBe("telegram_bot1_5"); // continuity per (bot, user)
    expect(input.principal).toEqual({ userId: "u1" }); // the RESOLVED user, not an owner
    expect(h.of("sendMessage").at(-1)!.body.text).toBe("Answer!");
  });

  it("drops duplicate deliveries via the seen() key", async () => {
    const seen = vi.fn(async () => true);
    const h = harness({ seen });
    await h.channel.handleRequest(webhookRequest(dm("hi")));
    await h.flush();
    expect(seen).toHaveBeenCalledWith("bot1:5:5:10");
    expect(h.runtime.handleChat).not.toHaveBeenCalled();
  });

  it("ignores bot messages, group chats, and empty messages", async () => {
    const h = harness();
    await h.channel.handleRequest(
      webhookRequest(dm("hi", { from: { id: 5, is_bot: true } })),
    );
    await h.channel.handleRequest(
      webhookRequest(dm("hi", { chat: { id: -100, type: "group" } })),
    );
    await h.channel.handleRequest(webhookRequest(dm("")));
    await h.flush();
    expect(h.runtime.handleChat).not.toHaveBeenCalled();
    expect(h.calls).toHaveLength(0); // silent — no reply spam in groups
  });

  it("sends a setup link and stashes the message for unlinked users", async () => {
    const stashPending = vi.fn(async () => {});
    const h = harness({
      authorizeUser: async () => ({ allowed: false, linkUrl: "https://x/telegram/link?s=1" }),
      stashPending,
    });
    await h.channel.handleRequest(webhookRequest(dm("do the thing")));
    await h.flush();

    expect(h.runtime.handleChat).not.toHaveBeenCalled();
    expect(stashPending).toHaveBeenCalledWith({
      telegramUserId: "5",
      username: "al",
      telegramChatId: "5",
      text: "do the thing",
    });
    const notice = h.of("sendMessage")[0]!.body;
    expect(String(notice.text)).toContain("https://x/telegram/link?s=1");
  });

  it("replies 'still working' when the chat's turn is already claimed", async () => {
    const h = harness({ claimTurn: async () => false });
    await h.channel.handleRequest(webhookRequest(dm("another")));
    await h.flush();
    expect(h.runtime.handleChat).not.toHaveBeenCalled();
    expect(String(h.of("sendMessage")[0]!.body.text)).toContain("still working");
  });

  it("releases the turn claim even when the run fails", async () => {
    const releaseTurn = vi.fn(async () => {});
    const h = harness({
      claimTurn: async () => true,
      releaseTurn,
      runtime: {
        handleChat: vi.fn(async () => {
          throw new Error("kaboom");
        }),
        applyApproval: vi.fn(),
        loadHistory: vi.fn(async () => []),
      } as never,
    });
    await h.channel.handleRequest(webhookRequest(dm("hi")));
    await h.flush();
    expect(releaseTurn).toHaveBeenCalledWith("telegram_bot1_5");
    expect(String(h.of("sendMessage").at(-1)!.body.text)).toContain("kaboom");
  });

  it("prompts pending approvals with Approve/Deny inline buttons", async () => {
    const h = harness();
    h.runtime.loadHistory.mockResolvedValue(approvalHistory("ap1"));
    await h.channel.handleRequest(webhookRequest(dm("hi")));
    await h.flush();

    const prompt = h.of("sendMessage").at(-1)!.body as {
      text: string;
      reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] };
    };
    expect(prompt.text).toContain("web_search");
    expect(prompt.reply_markup.inline_keyboard[0]!.map((b) => b.callback_data)).toEqual([
      "lta:1|ap1",
      "lta:0|ap1",
    ]);
  });

  it("resolves an approval callback: applyApproval + settled card + continuation", async () => {
    const h = harness();
    h.runtime.loadHistory.mockResolvedValueOnce(approvalHistory("ap1")); // toolName lookup
    await h.channel.handleRequest(
      webhookRequest({
        update_id: 2,
        callback_query: {
          id: "cb9",
          from: { id: 5, username: "al" },
          message: { message_id: 99, chat: { id: 5, type: "private" } },
          data: "lta:1|ap1",
        },
      }),
    );
    await h.flush();

    expect(h.runtime.applyApproval).toHaveBeenCalledWith({
      chatId: "telegram_bot1_5",
      principal: { userId: "u1" },
      decisions: [{ approvalId: "ap1", approved: true }],
    });
    expect(h.of("answerCallbackQuery")).toHaveLength(1);
    const settled = h.of("editMessageText").find((c) => c.body.message_id === 99);
    expect(String(settled!.body.text)).toContain("Approved");
    // the continuation stream posted its text
    expect(h.of("sendMessage").some((c) => c.body.text === "Resumed.")).toBe(true);
  });
});
