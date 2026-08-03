import { describe, expect, it, vi } from "vitest";
import type { AppMessage } from "@intentface/latch-core";
import type { AskSession, AskStateStore } from "../types.js";
import {
  decodeQuestionCallback,
  telegramChannel,
  type TelegramChannelConfig,
} from "./telegramChannel.js";
import { MAX_CALLBACK_DATA_BYTES } from "./api.js";

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
      method === "sendMessage"
        ? { message_id: 77 }
        : method === "getFile"
          ? { file_path: "files/f1.bin", file_size: 4 }
          : true;
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  });

  const deferred: Promise<unknown>[] = [];
  const runtime = {
    handleChat: vi.fn(async (_input: unknown) => textRun("Answer!")),
    applyApproval: vi.fn(async (_input: unknown) => textRun("Resumed.")),
    applyToolResult: vi.fn(async (_input: unknown) => textRun("Thanks!")),
    compactChat: vi.fn(
      async (_input: unknown): Promise<{ summary: string; compacted: number } | null> => ({
        summary: "The user is training for a marathon in October.",
        compacted: 12,
      }),
    ),
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

/**
 * An in-memory AskStateStore with the REAL rev/nonce/"already" semantics — the
 * fencing is what the questionnaire flow relies on for idempotency, so stubbing
 * it away would test nothing.
 */
function fakeAskState() {
  const rows = new Map<string, AskSession>();
  return {
    rows,
    store: {
      get: async (chatId: string) => rows.get(chatId) ?? null,
      begin: async (chatId: string, session: Omit<AskSession, "rev">) => {
        const existing = rows.get(chatId);
        if (existing && existing.toolCallId === session.toolCallId) return "already" as const;
        rows.set(chatId, { ...session, rev: 0 });
        return "started" as const;
      },
      update: async (
        chatId: string,
        toolCallId: string,
        rev: number,
        patch: Partial<AskSession>,
      ) => {
        const row = rows.get(chatId);
        if (!row || row.toolCallId !== toolCallId || row.rev !== rev) return null;
        const next = rev + 1;
        rows.set(chatId, { ...row, ...patch, rev: next });
        return next;
      },
      finish: async (chatId: string, toolCallId: string, rev: number) => {
        const row = rows.get(chatId);
        if (!row || row.toolCallId !== toolCallId || row.rev !== rev) return false;
        rows.delete(chatId);
        return true;
      },
      clear: async (chatId: string) => {
        const row = rows.get(chatId) ?? null;
        rows.delete(chatId);
        return row;
      },
    } satisfies AskStateStore,
  };
}

/** History parked on an `askUser` call (tail assistant message). */
function askHistory(toolCallId: string, questions: unknown[]): AppMessage[] {
  return [
    {
      id: "a1",
      role: "assistant",
      parts: [
        { type: "tool-askUser", toolCallId, state: "input-available", input: { questions } },
      ],
    } as unknown as AppMessage,
  ];
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
    const h = harness({ claimTurn: async () => null });
    await h.channel.handleRequest(webhookRequest(dm("another")));
    await h.flush();
    expect(h.runtime.handleChat).not.toHaveBeenCalled();
    expect(String(h.of("sendMessage")[0]!.body.text)).toContain("still working");
  });

  it("releases the turn claim with ITS token even when the run fails", async () => {
    const releaseTurn = vi.fn(async () => {});
    const h = harness({
      claimTurn: async () => "lease-1",
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
    expect(releaseTurn).toHaveBeenCalledWith("telegram_bot1_5", "lease-1");
    expect(String(h.of("sendMessage").at(-1)!.body.text)).toContain("kaboom");
  });

  it("stashes media refs with the pending message for unlinked users", async () => {
    const stashPending = vi.fn(async () => {});
    const h = harness({
      authorizeUser: async () => ({ allowed: false, linkUrl: "https://x/telegram/link?s=1" }),
      stashPending,
    });
    const photo = [{ file_id: "f1", file_size: 10 }];
    await h.channel.handleRequest(webhookRequest(dm("", { text: undefined, caption: "look", photo })));
    await h.flush();
    expect(stashPending).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "look",
        media: [{ ref: photo[0], mediaType: "image/jpeg", name: "photo.jpg" }],
      }),
    );
  });

  it("replayMessage claims and releases the turn lease around the run", async () => {
    const claimTurn = vi.fn(async () => "lease-2");
    const releaseTurn = vi.fn(async () => {});
    const h = harness({ claimTurn, releaseTurn });
    await h.channel.replayMessage({
      telegramUserId: "5",
      telegramChatId: "5",
      text: "replayed",
      principal: { userId: "u1" },
    });
    expect(claimTurn).toHaveBeenCalledWith("telegram_bot1_5");
    expect(h.runtime.handleChat).toHaveBeenCalledTimes(1);
    expect(releaseTurn).toHaveBeenCalledWith("telegram_bot1_5", "lease-2");
  });

  it("replayMessage backs off with 'still working' when the lease is held", async () => {
    const h = harness({ claimTurn: async () => null });
    await h.channel.replayMessage({
      telegramUserId: "5",
      telegramChatId: "5",
      text: "replayed",
      principal: { userId: "u1" },
    });
    expect(h.runtime.handleChat).not.toHaveBeenCalled();
    expect(String(h.of("sendMessage")[0]!.body.text)).toContain("still working");
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

  it("approval callbacks resume under the turn lease and release it", async () => {
    const claimTurn = vi.fn(async () => "lease-3");
    const releaseTurn = vi.fn(async () => {});
    const h = harness({ claimTurn, releaseTurn });
    h.runtime.loadHistory.mockResolvedValue(approvalHistory("ap1"));
    await h.channel.handleRequest(
      webhookRequest({
        update_id: 3,
        callback_query: { id: "cb1", from: { id: 5 }, data: "lta:1|ap1" },
      }),
    );
    await h.flush();
    expect(claimTurn).toHaveBeenCalledWith("telegram_bot1_5");
    expect(h.runtime.applyApproval).toHaveBeenCalledTimes(1);
    expect(releaseTurn).toHaveBeenCalledWith("telegram_bot1_5", "lease-3");
  });

  it("approval callbacks back off with 'still working' when the turn is claimed", async () => {
    const h = harness({ claimTurn: async () => null });
    h.runtime.loadHistory.mockResolvedValue(approvalHistory("ap1"));
    await h.channel.handleRequest(
      webhookRequest({
        update_id: 3,
        callback_query: { id: "cb1", from: { id: 5 }, data: "lta:1|ap1" },
      }),
    );
    await h.flush();
    expect(h.runtime.applyApproval).not.toHaveBeenCalled();
    expect(String(h.of("sendMessage")[0]!.body.text)).toContain("still working");
  });

  it("retires a card whose approval is gone from fresh history", async () => {
    // e.g. decided in the web app, or left over from a previous thread — pushing
    // it through would surface a raw "Unknown chat" instead.
    const h = harness();
    h.runtime.loadHistory.mockResolvedValue([]);
    await h.channel.handleRequest(
      webhookRequest({
        update_id: 4,
        callback_query: {
          id: "cb2",
          from: { id: 5 },
          message: { message_id: 99, chat: { id: 5, type: "private" } },
          data: "lta:1|ap1",
        },
      }),
    );
    await h.flush();
    expect(h.runtime.applyApproval).not.toHaveBeenCalled();
    expect(String(h.of("editMessageText").at(-1)!.body.text)).toMatch(/no longer active/i);
  });

  it("leaves the card alone when the history read FAILS", async () => {
    // A transient read failure must not strand a live approval with no buttons.
    const h = harness();
    h.runtime.loadHistory.mockRejectedValue(new Error("db down"));
    await h.channel.handleRequest(
      webhookRequest({
        update_id: 5,
        callback_query: {
          id: "cb3",
          from: { id: 5 },
          message: { message_id: 99, chat: { id: 5, type: "private" } },
          data: "lta:1|ap1",
        },
      }),
    );
    await h.flush();
    expect(h.runtime.applyApproval).not.toHaveBeenCalled();
    expect(h.of("editMessageText")).toHaveLength(0); // card untouched
    expect(String(h.of("sendMessage").at(-1)!.body.text)).toMatch(/couldn't check/i);
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

describe("telegramChannel voice messages", () => {
  const voice = { file_id: "v1", file_size: 4, mime_type: "audio/ogg" };
  const voiceDm = (over: Record<string, unknown> = {}) =>
    dm("", { text: undefined, voice, ...over });

  const sentMessage = (h: ReturnType<typeof harness>) =>
    h.runtime.handleChat.mock.calls[0]![0] as { message: AppMessage };

  it("transcribes a voice note into a text part — no file part reaches the agent", async () => {
    const transcribe = vi.fn(
      async (_audio: { bytes: Uint8Array; mediaType: string; filename: string }) =>
        "legs felt great today",
    );
    const h = harness({ transcribe });
    await h.channel.handleRequest(webhookRequest(voiceDm()));
    await h.flush();

    expect(transcribe).toHaveBeenCalledTimes(1);
    const arg = transcribe.mock.calls[0]![0];
    expect(arg.mediaType).toBe("audio/ogg");
    expect(arg.filename).toBe("voice.ogg");
    expect(arg.bytes).toBeInstanceOf(Uint8Array);

    const { message } = sentMessage(h);
    expect(message.parts).toEqual([
      { type: "text", text: "[Voice message]: legs felt great today" },
    ]);
  });

  it("keeps the caption first, transcript after", async () => {
    const h = harness({ transcribe: async () => "the audio part" });
    await h.channel.handleRequest(
      webhookRequest(
        dm("", {
          text: undefined,
          caption: "typed caption",
          audio: { file_id: "a1", file_size: 4, mime_type: "audio/mpeg" },
        }),
      ),
    );
    await h.flush();

    const { message } = sentMessage(h);
    expect(message.parts).toEqual([
      { type: "text", text: "typed caption\n\n[Voice message]: the audio part" },
    ]);
  });

  it("replies with an error and skips the turn when transcription fails on a voice-only message", async () => {
    const releaseTurn = vi.fn(async () => {});
    const h = harness({
      transcribe: async () => {
        throw new Error("scribe down");
      },
      claimTurn: async () => "lease-9",
      releaseTurn,
    });
    await h.channel.handleRequest(webhookRequest(voiceDm()));
    await h.flush();

    expect(h.runtime.handleChat).not.toHaveBeenCalled();
    expect(String(h.of("sendMessage")[0]!.body.text)).toContain("Couldn't transcribe");
    expect(releaseTurn).toHaveBeenCalledWith("telegram_bot1_5", "lease-9"); // lease not leaked
  });

  it("replies with an error when no transcribe hook is configured", async () => {
    const h = harness();
    await h.channel.handleRequest(webhookRequest(voiceDm()));
    await h.flush();

    expect(h.runtime.handleChat).not.toHaveBeenCalled();
    expect(String(h.of("sendMessage")[0]!.body.text)).toContain("Couldn't transcribe");
  });

  it("folds a failed transcription into a note when the message has other content", async () => {
    const h = harness({
      transcribe: async () => {
        throw new Error("scribe down");
      },
    });
    await h.channel.handleRequest(webhookRequest(voiceDm({ caption: "also this text" })));
    await h.flush();

    const { message } = sentMessage(h);
    expect(message.parts).toEqual([
      {
        type: "text",
        text: "also this text\n\n[A voice/audio message could not be transcribed: voice.ogg]",
      },
    ]);
  });

  it("still inlines non-audio media as file parts (regression)", async () => {
    const h = harness({ transcribe: async () => "unused" });
    const photo = [{ file_id: "p1", file_size: 4 }];
    await h.channel.handleRequest(webhookRequest(dm("", { text: undefined, caption: "look", photo })));
    await h.flush();

    const { message } = sentMessage(h);
    expect(message.parts[0]).toEqual({ type: "text", text: "look" });
    expect(message.parts[1]).toMatchObject({
      type: "file",
      mediaType: "image/jpeg",
      filename: "photo.jpg",
    });
  });
});

describe("telegramChannel questionnaires (askUser)", () => {
  const goal = {
    question: "Mikä on tavoitteesi?",
    options: [
      { label: "Ajan parantaminen", description: "faster" },
      { label: "Maaliin pääsy", description: "finish" },
    ],
  };
  const days = {
    question: "Montako kertaa viikossa?",
    options: [
      { label: "1-2", description: "light" },
      { label: "3-4", description: "moderate" },
    ],
  };
  const sports = {
    question: "Mitkä lajit?",
    multiSelect: true,
    options: [
      { label: "Polkujuoksu", description: "trail" },
      { label: "Maantie", description: "road" },
      { label: "Rata", description: "track" },
    ],
  };

  /** Build a harness already parked on a questionnaire, with a live ask store. */
  function askHarness(questions: unknown[], over: Record<string, unknown> = {}) {
    const ask = fakeAskState();
    const h = harness({ askState: ask.store, ...over });
    h.runtime.loadHistory.mockResolvedValue(askHistory("toolu_ask1", questions));
    return { ...h, ask };
  }

  /** The buttons on the most recent sendMessage. */
  const keyboardOf = (h: ReturnType<typeof harness>) => {
    const body = h.of("sendMessage").at(-1)!.body as {
      reply_markup?: { inline_keyboard: { text: string; callback_data?: string }[][] };
    };
    return body.reply_markup?.inline_keyboard ?? [];
  };

  const tap = (h: ReturnType<typeof harness>, data: string, messageId = 77) =>
    h.channel.handleRequest(
      webhookRequest({
        update_id: 90,
        callback_query: {
          id: `cb-${data}`,
          from: { id: 5, username: "al" },
          message: { message_id: messageId, chat: { id: 5, type: "private" } },
          data,
        },
      }),
    );

  it("posts the first question with one button per option", async () => {
    const h = askHarness([goal, days]);
    await h.channel.handleRequest(webhookRequest(dm("moi")));
    await h.flush();

    const prompt = h.of("sendMessage").at(-1)!.body as { text: string };
    expect(prompt.text).toContain("Question 1 of 2");
    expect(prompt.text).toContain("Mikä on tavoitteesi?");
    expect(prompt.text).toContain("Ajan parantaminen");
    const kb = keyboardOf(h);
    expect(kb.map((row) => row[0]!.text)).toEqual(["Ajan parantaminen", "Maaliin pääsy"]);
    // No submit yet — the turn stays parked until every question is answered.
    expect(h.runtime.applyToolResult).not.toHaveBeenCalled();
  });

  it("every callback_data fits Telegram's 64-byte cap", async () => {
    const h = askHarness([goal, sports]);
    await h.channel.handleRequest(webhookRequest(dm("moi")));
    await h.flush();
    const datas = keyboardOf(h).flatMap((row) => row.map((b) => b.callback_data ?? ""));
    expect(datas.length).toBeGreaterThan(0);
    for (const d of datas) {
      expect(new TextEncoder().encode(d).length).toBeLessThanOrEqual(MAX_CALLBACK_DATA_BYTES);
      expect(decodeQuestionCallback(d)).not.toBeNull();
    }
  });

  it("a single question submits the answer map on the first tap", async () => {
    const h = askHarness([goal]);
    await h.channel.handleRequest(webhookRequest(dm("moi")));
    await h.flush();
    const pick = keyboardOf(h)[0]![0]!.callback_data!;

    await tap(h, pick);
    await h.flush();

    expect(h.runtime.applyToolResult).toHaveBeenCalledWith({
      chatId: "telegram_bot1_5",
      principal: { userId: "u1" },
      toolCallId: "toolu_ask1",
      output: { "Mikä on tavoitteesi?": "Ajan parantaminen" },
    });
    // The answered card collapses to a receipt, and the continuation is rendered.
    expect(String(h.of("editMessageText").at(-1)!.body.text)).toContain("Ajan parantaminen");
    expect(h.of("sendMessage").some((c) => c.body.text === "Thanks!")).toBe(true);
  });

  it("walks several questions, submitting only after the last", async () => {
    const h = askHarness([goal, days]);
    await h.channel.handleRequest(webhookRequest(dm("moi")));
    await h.flush();

    await tap(h, keyboardOf(h)[0]![0]!.callback_data!); // Q1 → "Ajan parantaminen"
    await h.flush();
    expect(h.runtime.applyToolResult).not.toHaveBeenCalled();
    expect(String(h.of("sendMessage").at(-1)!.body.text)).toContain("Montako kertaa");

    await tap(h, keyboardOf(h)[1]![0]!.callback_data!); // Q2 → "3-4"
    await h.flush();
    expect(h.runtime.applyToolResult).toHaveBeenCalledTimes(1);
    expect(h.runtime.applyToolResult.mock.calls[0]![0]).toMatchObject({
      output: { "Mikä on tavoitteesi?": "Ajan parantaminen", "Montako kertaa viikossa?": "3-4" },
    });
  });

  it("takes the turn lease only on the tap that resumes the agent", async () => {
    const claimTurn = vi.fn(async () => "lease-q");
    const releaseTurn = vi.fn(async () => {});
    const h = askHarness([goal, days], { claimTurn, releaseTurn });
    await h.channel.handleRequest(webhookRequest(dm("moi")));
    await h.flush();
    const afterTurn = claimTurn.mock.calls.length;

    await tap(h, keyboardOf(h)[0]![0]!.callback_data!); // intermediate
    await h.flush();
    expect(claimTurn).toHaveBeenCalledTimes(afterTurn); // no new claim

    await tap(h, keyboardOf(h)[0]![0]!.callback_data!); // final
    await h.flush();
    expect(claimTurn).toHaveBeenCalledTimes(afterTurn + 1);
    expect(releaseTurn).toHaveBeenCalledWith("telegram_bot1_5", "lease-q");
  });

  it("keeps the session when the final tap can't get the lease, so a retry works", async () => {
    const h = askHarness([goal], { claimTurn: async () => null });
    await h.channel.handleRequest(webhookRequest(dm("moi")));
    await h.flush();
    // The turn itself was refused the lease, so prompt manually via a callback.
    h.ask.rows.set("telegram_bot1_5", {
      toolCallId: "toolu_ask1",
      nonce: "abc123",
      questions: [goal],
      cursor: 0,
      answers: {},
      selected: [],
      promptChatId: "5",
      rev: 0,
    });
    await tap(h, "ltq:s|abc123|0|0");
    await h.flush();

    expect(h.runtime.applyToolResult).not.toHaveBeenCalled();
    expect(h.ask.rows.get("telegram_bot1_5")).toBeDefined(); // answers not destroyed
  });

  it("multi-select ticks in place and only commits on Done", async () => {
    const h = askHarness([sports]);
    await h.channel.handleRequest(webhookRequest(dm("moi")));
    await h.flush();
    const kb = keyboardOf(h);
    expect(kb.at(-1)![0]!.text).toBe("✅ Done");

    await tap(h, kb[0]![0]!.callback_data!); // tick Polkujuoksu
    await h.flush();
    expect(h.runtime.applyToolResult).not.toHaveBeenCalled();
    const ticked = h.of("editMessageReplyMarkup").at(-1)!.body as {
      reply_markup: { inline_keyboard: { text: string }[][] };
    };
    expect(ticked.reply_markup.inline_keyboard[0]![0]!.text).toContain("✓");

    await tap(h, kb[2]![0]!.callback_data!); // tick Rata
    await h.flush();
    await tap(h, kb.at(-1)![0]!.callback_data!); // Done
    await h.flush();

    expect(h.runtime.applyToolResult.mock.calls[0]![0]).toMatchObject({
      output: { "Mitkä lajit?": "Polkujuoksu, Rata" },
    });
  });

  it("Done with nothing ticked answers the tap with a nudge and does not advance", async () => {
    const h = askHarness([sports]);
    await h.channel.handleRequest(webhookRequest(dm("moi")));
    await h.flush();
    await tap(h, keyboardOf(h).at(-1)![0]!.callback_data!);
    await h.flush();

    expect(h.runtime.applyToolResult).not.toHaveBeenCalled();
    const ack = h.of("answerCallbackQuery").at(-1)!.body as { text?: string };
    expect(String(ack.text)).toMatch(/at least one/i);
  });

  it("a typed reply answers the pending question instead of starting a turn", async () => {
    const h = askHarness([goal]);
    await h.channel.handleRequest(webhookRequest(dm("moi")));
    await h.flush();
    h.runtime.handleChat.mockClear();

    await h.channel.handleRequest(webhookRequest({ ...dm("Maaliin pääsy"), update_id: 2 }));
    await h.flush();

    expect(h.runtime.handleChat).not.toHaveBeenCalled(); // not a fresh turn
    expect(h.runtime.applyToolResult.mock.calls[0]![0]).toMatchObject({
      output: { "Mikä on tavoitteesi?": "Maaliin pääsy" },
    });
  });

  it("a typed number picks that option", async () => {
    const h = askHarness([goal]);
    await h.channel.handleRequest(webhookRequest(dm("moi")));
    await h.flush();
    await h.channel.handleRequest(webhookRequest({ ...dm("2"), update_id: 2 }));
    await h.flush();
    expect(h.runtime.applyToolResult.mock.calls[0]![0]).toMatchObject({
      output: { "Mikä on tavoitteesi?": "Maaliin pääsy" },
    });
  });

  it("/cancel drops the questionnaire and runs no turn; the next message runs normally", async () => {
    const h = askHarness([goal]);
    await h.channel.handleRequest(webhookRequest(dm("moi")));
    await h.flush();
    h.runtime.handleChat.mockClear();

    await h.channel.handleRequest(webhookRequest({ ...dm("/cancel"), update_id: 2 }));
    await h.flush();
    expect(h.runtime.handleChat).not.toHaveBeenCalled();
    expect(h.runtime.applyToolResult).not.toHaveBeenCalled();
    expect(h.ask.rows.get("telegram_bot1_5")).toBeUndefined();
    expect(h.of("editMessageReplyMarkup").length).toBeGreaterThan(0); // buttons retired

    h.runtime.loadHistory.mockResolvedValue([]);
    await h.channel.handleRequest(webhookRequest({ ...dm("uusi juttu"), update_id: 3 }));
    await h.flush();
    expect(h.runtime.handleChat).toHaveBeenCalledTimes(1);
  });

  it("a stale nonce is rejected and its buttons retired", async () => {
    const h = askHarness([goal]);
    await h.channel.handleRequest(webhookRequest(dm("moi")));
    await h.flush();

    await tap(h, "ltq:s|zzzzzz|0|0");
    await h.flush();

    expect(h.runtime.applyToolResult).not.toHaveBeenCalled();
    expect(String(h.of("answerCallbackQuery").at(-1)!.body.text)).toMatch(/already answered/i);
    expect(h.of("editMessageReplyMarkup").length).toBeGreaterThan(0);
  });

  it("a tap on an already-answered question index is ignored", async () => {
    const h = askHarness([goal, days]);
    await h.channel.handleRequest(webhookRequest(dm("moi")));
    await h.flush();
    const q1 = keyboardOf(h)[0]![0]!.callback_data!;
    await tap(h, q1); // answer Q1, cursor → 1
    await h.flush();
    h.runtime.applyToolResult.mockClear();

    await tap(h, q1); // same Q1 button again
    await h.flush();
    expect(h.runtime.applyToolResult).not.toHaveBeenCalled();
  });

  it("a duplicate delivery of the final tap submits exactly once", async () => {
    const h = askHarness([goal]);
    await h.channel.handleRequest(webhookRequest(dm("moi")));
    await h.flush();
    const pick = keyboardOf(h)[0]![0]!.callback_data!;

    await tap(h, pick);
    await tap(h, pick);
    await h.flush();

    expect(h.runtime.applyToolResult).toHaveBeenCalledTimes(1);
  });

  it("does not re-post the card when a resume lands on the SAME questionnaire", async () => {
    // The final tap submits, then renders whatever the continuation parked on.
    // If history still shows the same askUser call (a resume that produced no new
    // question), `begin` must answer "already" rather than posting a twin card
    // whose buttons would both drive one session.
    const h = askHarness([goal, days]);
    await h.channel.handleRequest(webhookRequest(dm("moi")));
    await h.flush();
    const cardsAfterPrompt = h
      .of("sendMessage")
      .filter((c) => String(c.body.text).includes("tavoitteesi")).length;
    expect(cardsAfterPrompt).toBe(1);

    // Answer Q1 → Q2 is posted; history (mocked) still reports the same call.
    await tap(h, keyboardOf(h)[0]![0]!.callback_data!);
    await h.flush();
    await tap(h, keyboardOf(h)[0]![0]!.callback_data!); // final → submit + re-render
    await h.flush();

    expect(h.runtime.applyToolResult).toHaveBeenCalledTimes(1);
    // The re-render after the resume found the session gone but the SAME call
    // still in history, so it started a fresh session — but exactly one card.
    const q1Cards = h
      .of("sendMessage")
      .filter((c) => String(c.body.text).includes("tavoitteesi")).length;
    expect(q1Cards).toBe(2); // the original prompt + one fresh prompt, never a twin
    expect(h.ask.rows.get("telegram_bot1_5")!.cursor).toBe(0);
  });

  it("posting a questionnaire records a session whose nonce matches its buttons", async () => {
    const h = askHarness([goal]);
    await h.channel.handleRequest(webhookRequest(dm("moi")));
    await h.flush();

    const session = h.ask.rows.get("telegram_bot1_5")!;
    expect(session).toMatchObject({ toolCallId: "toolu_ask1", cursor: 0, answers: {} });
    const decoded = decodeQuestionCallback(keyboardOf(h)[0]![0]!.callback_data!)!;
    expect(decoded.nonce).toBe(session.nonce);
    expect(decoded).toMatchObject({ verb: "pick", questionIndex: 0, optionIndex: 0 });
  });

  it("ignores an askUser call that is no longer the tail (abandoned turns)", async () => {
    const h = askHarness([goal]);
    h.runtime.loadHistory.mockResolvedValue([
      ...askHistory("toolu_old", [goal]),
      { id: "u9", role: "user", parts: [{ type: "text", text: "never mind" }] } as AppMessage,
    ]);
    await h.channel.handleRequest(webhookRequest(dm("moi")));
    await h.flush();

    const cards = h.of("sendMessage").filter((c) => String(c.body.text).includes("tavoitteesi"));
    expect(cards).toHaveLength(0);
  });

  it("retires a live session when the questionnaire is gone (answered in the web app)", async () => {
    const h = askHarness([goal]);
    await h.channel.handleRequest(webhookRequest(dm("moi")));
    await h.flush();
    expect(h.ask.rows.get("telegram_bot1_5")).toBeDefined();

    h.runtime.loadHistory.mockResolvedValue([]); // resolved elsewhere
    await h.channel.handleRequest(webhookRequest({ ...dm("mitä nyt"), update_id: 6 }));
    await h.flush();

    expect(h.ask.rows.get("telegram_bot1_5")).toBeUndefined();
  });

  it("a captioned photo is NOT an answer — it runs a turn so the file reaches the agent", async () => {
    const h = askHarness([goal]);
    await h.channel.handleRequest(webhookRequest(dm("moi")));
    await h.flush();
    h.runtime.handleChat.mockClear();
    h.runtime.loadHistory.mockResolvedValue([]);

    const photo = [{ file_id: "p1", file_size: 4 }];
    await h.channel.handleRequest(
      webhookRequest({ ...dm("", { text: undefined, caption: "here it is", photo }), update_id: 7 }),
    );
    await h.flush();

    // Treating the caption as the answer would silently drop the attachment.
    expect(h.runtime.applyToolResult).not.toHaveBeenCalled();
    expect(h.runtime.handleChat).toHaveBeenCalledTimes(1);
    const sent = h.runtime.handleChat.mock.calls[0]![0] as { message: AppMessage };
    expect(sent.message.parts.some((p) => p.type === "file")).toBe(true);
    expect(h.ask.rows.get("telegram_bot1_5")).toBeUndefined(); // questionnaire retired
  });

  it("keeps the answers when the host forgot to wire applyToolResult", async () => {
    const ask = fakeAskState();
    const h = harness({
      askState: ask.store,
      runtime: {
        handleChat: vi.fn(async () => textRun("Answer!")),
        applyApproval: vi.fn(),
        loadHistory: vi.fn(async () => askHistory("toolu_ask1", [goal])),
      } as never,
    });
    await h.channel.handleRequest(webhookRequest(dm("moi")));
    await h.flush();
    const kb = (
      h.of("sendMessage").at(-1)!.body as {
        reply_markup: { inline_keyboard: { callback_data: string }[][] };
      }
    ).reply_markup.inline_keyboard;

    await tap(h, kb[0]![0]!.callback_data);
    await h.flush();

    // Destroying the session here would lose every collected answer with no
    // way left to submit them.
    expect(ask.rows.get("telegram_bot1_5")).toBeDefined();
  });

  it("without askState the questions are posted as text and nothing is submitted", async () => {
    const h = harness();
    h.runtime.loadHistory.mockResolvedValue(askHistory("toolu_ask1", [goal, days]));
    await h.channel.handleRequest(webhookRequest(dm("moi")));
    await h.flush();

    const texts = h.of("sendMessage").map((c) => String(c.body.text));
    expect(texts.some((t) => t.includes("tavoitteesi"))).toBe(true);
    expect(texts.some((t) => t.includes("Montako kertaa"))).toBe(true);
    expect(h.runtime.applyToolResult).not.toHaveBeenCalled();
  });

  it("renders a pending approval instead of the questionnaire when both are parked", async () => {
    const h = askHarness([goal]);
    h.runtime.loadHistory.mockResolvedValue([
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-web_search",
            state: "approval-requested",
            input: { q: "x" },
            approval: { id: "ap9" },
          },
          {
            type: "tool-askUser",
            toolCallId: "toolu_ask1",
            state: "input-available",
            input: { questions: [goal] },
          },
        ],
      } as unknown as AppMessage,
    ]);
    await h.channel.handleRequest(webhookRequest(dm("moi")));
    await h.flush();

    const texts = h.of("sendMessage").map((c) => String(c.body.text));
    expect(texts.some((t) => t.includes("web_search"))).toBe(true);
    expect(texts.some((t) => t.includes("tavoitteesi"))).toBe(false);
  });
});

describe("telegramChannel commands", () => {
  /** An in-memory ChannelThreadStore with the real "rotate bumps" semantics. */
  function fakeThreadStore() {
    const epochs = new Map<string, number>();
    return {
      epochs,
      store: {
        current: vi.fn(async (key: string) => epochs.get(key) ?? 0),
        rotate: vi.fn(async (key: string) => {
          const next = (epochs.get(key) ?? 0) + 1;
          epochs.set(key, next);
          return next;
        }),
      },
    };
  }

  const send = (h: ReturnType<typeof harness>, text: string, update_id = 1) =>
    h.channel.handleRequest(webhookRequest({ ...dm(text), update_id }));

  const texts = (h: ReturnType<typeof harness>) =>
    h.of("sendMessage").map((c) => String(c.body.text));

  const question = {
    question: "Mikä on tavoitteesi?",
    options: [{ label: "Ajan parantaminen", description: "faster" }],
  };

  it("/help lists the commands and runs no turn", async () => {
    const h = harness();
    await send(h, "/help");
    await h.flush();
    expect(h.runtime.handleChat).not.toHaveBeenCalled();
    const help = texts(h).at(-1)!;
    for (const name of ["/new", "/compact", "/cancel", "/status", "/help", "/start"]) {
      expect(help).toContain(name);
    }
  });

  it("/start names the agent instead of sending '/start' to it", async () => {
    const h = harness();
    await send(h, "/start");
    await h.flush();
    expect(h.runtime.handleChat).not.toHaveBeenCalled();
    expect(texts(h).at(-1)!).toContain("support");
  });

  it("an unknown command still reaches the agent", async () => {
    // Pasted paths and unregistered commands must not be swallowed.
    const h = harness();
    await send(h, "/deploy the thing");
    await h.flush();
    const input = h.runtime.handleChat.mock.calls[0]![0] as { message: AppMessage };
    expect(JSON.stringify(input.message.parts)).toContain("/deploy the thing");
  });

  it("a command from an unlinked user is not stashed for replay", async () => {
    const stashPending = vi.fn(async () => {});
    const h = harness({
      stashPending,
      authorizeUser: vi.fn(async () => ({ allowed: false, linkUrl: "https://latch/link" })),
    });
    await send(h, "/new");
    await h.flush();
    // Otherwise linking would replay "/new" to the agent as a message.
    expect(stashPending).not.toHaveBeenCalled();
    expect(texts(h).at(-1)!).toContain("Link your Latch account");
  });

  describe("/new", () => {
    it("rotates the thread so the next message lands in a new chat", async () => {
      const thread = fakeThreadStore();
      const claimTurn = vi.fn(async () => "lease-n");
      const h = harness({ thread: thread.store, claimTurn, releaseTurn: async () => {} });

      await send(h, "/new");
      await h.flush();
      expect(h.runtime.handleChat).not.toHaveBeenCalled();
      expect(thread.store.rotate).toHaveBeenCalledWith("telegram_bot1_5");
      expect(texts(h).at(-1)!).toMatch(/new conversation/i);

      await send(h, "fresh start", 2);
      await h.flush();
      expect(h.runtime.handleChat.mock.calls[0]![0]).toMatchObject({
        chatId: "telegram_bot1_5_t1",
      });
      // The lease and every other per-chat key follow the rotated id.
      expect(claimTurn).toHaveBeenCalledWith("telegram_bot1_5_t1");
    });

    it("keeps the original chat id for the first thread", async () => {
      const thread = fakeThreadStore();
      const h = harness({ thread: thread.store });
      await send(h, "hi");
      await h.flush();
      expect(h.runtime.handleChat.mock.calls[0]![0]).toMatchObject({
        chatId: "telegram_bot1_5",
      });
    });

    it("says so when the host has no thread store", async () => {
      const h = harness();
      await send(h, "/new");
      await h.flush();
      expect(texts(h).at(-1)!).toMatch(/isn't available/i);
      expect(h.runtime.handleChat).not.toHaveBeenCalled();
    });

    it("drops the message when the thread can't be resolved", async () => {
      // Falling back to epoch 0 would write into the conversation the user just
      // left behind, silently mixing two threads.
      const thread = fakeThreadStore();
      thread.store.current.mockRejectedValue(new Error("db down"));
      const h = harness({ thread: thread.store });
      await send(h, "hello?");
      await h.flush();
      expect(h.runtime.handleChat).not.toHaveBeenCalled();
      expect(texts(h).at(-1)!).toMatch(/which conversation/i);
    });

    it("retires a live questionnaire", async () => {
      const ask = fakeAskState();
      const thread = fakeThreadStore();
      const h = harness({ askState: ask.store, thread: thread.store });
      h.runtime.loadHistory.mockResolvedValue(askHistory("toolu_ask1", [question]));
      await send(h, "moi");
      await h.flush();
      expect(ask.rows.get("telegram_bot1_5")).toBeDefined();

      await send(h, "/new", 2);
      await h.flush();
      expect(ask.rows.get("telegram_bot1_5")).toBeUndefined();
      expect(h.of("editMessageReplyMarkup").length).toBeGreaterThan(0);
      expect(h.runtime.applyToolResult).not.toHaveBeenCalled();
    });
  });

  describe("/status", () => {
    it("reports the agent, the thread, the message count and what it waits on", async () => {
      const thread = fakeThreadStore();
      thread.epochs.set("telegram_bot1_5", 2);
      const h = harness({ thread: thread.store });
      h.runtime.loadHistory.mockResolvedValue(approvalHistory("ap1"));

      await send(h, "/status");
      await h.flush();
      const status = texts(h).at(-1)!;
      expect(status).toContain("support");
      expect(status).toContain("#3"); // epoch 2 ⇒ the third conversation
      expect(status).toContain("Messages: 1");
      expect(status).toContain("web_search");
      expect(h.runtime.handleChat).not.toHaveBeenCalled();
    });

    it("does NOT retire a live questionnaire", async () => {
      // Asking about a conversation must not destroy the questions in it.
      const ask = fakeAskState();
      const h = harness({ askState: ask.store });
      h.runtime.loadHistory.mockResolvedValue(askHistory("toolu_ask1", [question]));
      await send(h, "moi");
      await h.flush();

      await send(h, "/status", 2);
      await h.flush();
      expect(ask.rows.get("telegram_bot1_5")).toBeDefined();
      expect(texts(h).at(-1)!).toContain("1 question");
    });
  });

  describe("/cancel", () => {
    it("denies every pending approval under the turn lease", async () => {
      const claimTurn = vi.fn(async () => "lease-c");
      const releaseTurn = vi.fn(async () => {});
      const h = harness({ claimTurn, releaseTurn });
      h.runtime.loadHistory.mockResolvedValue(approvalHistory("ap1"));

      await send(h, "/cancel");
      await h.flush();
      expect(h.runtime.applyApproval).toHaveBeenCalledWith({
        chatId: "telegram_bot1_5",
        principal: { userId: "u1" },
        decisions: [{ approvalId: "ap1", approved: false }],
      });
      expect(claimTurn).toHaveBeenCalledWith("telegram_bot1_5");
      expect(releaseTurn).toHaveBeenCalledWith("telegram_bot1_5", "lease-c");
      expect(texts(h).some((t) => t.includes("Denied"))).toBe(true);
      // The wrap-up the denial produced is rendered.
      expect(texts(h).some((t) => t === "Resumed.")).toBe(true);
    });

    it("says there's nothing to cancel when nothing is pending", async () => {
      const h = harness();
      await send(h, "/cancel");
      await h.flush();
      expect(h.runtime.applyApproval).not.toHaveBeenCalled();
      expect(texts(h).at(-1)!).toMatch(/nothing to cancel/i);
    });

    it("retires a live questionnaire and says so", async () => {
      // The only observable proof that `cancel` is thread-changing: drop it from
      // THREAD_CHANGING_COMMANDS and the session survives this.
      const ask = fakeAskState();
      const h = harness({ askState: ask.store });
      h.runtime.loadHistory.mockResolvedValue(askHistory("toolu_ask1", [question]));
      await send(h, "moi");
      await h.flush();
      expect(ask.rows.get("telegram_bot1_5")).toBeDefined();

      h.runtime.loadHistory.mockResolvedValue([]);
      await send(h, "/cancel", 2);
      await h.flush();
      expect(ask.rows.get("telegram_bot1_5")).toBeUndefined();
      expect(h.runtime.applyToolResult).not.toHaveBeenCalled();
      expect(texts(h).at(-1)!).toMatch(/dropped those questions/i);
    });

    it("reads what's pending under the lease, not before it", async () => {
      // A pre-lease read could deny approvals a concurrent turn has moved past.
      const h = harness({ claimTurn: async () => null });
      h.runtime.loadHistory.mockResolvedValue(approvalHistory("ap1"));
      await send(h, "/cancel");
      await h.flush();
      expect(h.runtime.applyApproval).not.toHaveBeenCalled();
      expect(texts(h).at(-1)!).toContain("still working");
    });
  });

  describe("/compact", () => {
    it("compacts under the lease and echoes the summary", async () => {
      const claimTurn = vi.fn(async () => "lease-k");
      const releaseTurn = vi.fn(async () => {});
      const h = harness({ claimTurn, releaseTurn });

      await send(h, "/compact keep the training plan");
      await h.flush();
      expect(h.runtime.compactChat).toHaveBeenCalledWith({
        chatId: "telegram_bot1_5",
        principal: { userId: "u1" },
        focus: "keep the training plan",
      });
      expect(claimTurn).toHaveBeenCalledWith("telegram_bot1_5");
      expect(releaseTurn).toHaveBeenCalledWith("telegram_bot1_5", "lease-k");
      const reply = texts(h).at(-1)!;
      expect(reply).toContain("12");
      expect(reply).toContain("marathon in October");
      expect(h.runtime.handleChat).not.toHaveBeenCalled();
    });

    it("passes no focus when the command had no arguments", async () => {
      const h = harness();
      await send(h, "/compact");
      await h.flush();
      expect(h.runtime.compactChat.mock.calls[0]![0]).not.toHaveProperty("focus");
    });

    it("says the conversation is short enough when there's nothing to compact", async () => {
      const h = harness();
      h.runtime.compactChat.mockResolvedValue(null);
      await send(h, "/compact");
      await h.flush();
      expect(texts(h).at(-1)!).toMatch(/short enough/i);
    });

    it("re-posts the pending card when the turn is paused", async () => {
      const h = harness();
      h.runtime.compactChat.mockRejectedValue(
        Object.assign(new Error("This chat is awaiting a decision"), {
          code: "pending_approval",
        }),
      );
      h.runtime.loadHistory.mockResolvedValue(approvalHistory("ap1"));

      await send(h, "/compact");
      await h.flush();
      const all = texts(h);
      expect(all.some((t) => t.includes("awaiting a decision"))).toBe(true);
      // Actionable: the approval it's stuck on comes back with its buttons.
      expect(all.some((t) => t.includes("web_search"))).toBe(true);
    });

    it("says so when the host has not wired compactChat", async () => {
      const h = harness({
        runtime: {
          handleChat: vi.fn(async () => textRun("Answer!")),
          applyApproval: vi.fn(async () => textRun("Resumed.")),
          loadHistory: vi.fn(async () => []),
        },
      });
      await send(h, "/compact");
      await h.flush();
      expect(texts(h).at(-1)!).toMatch(/isn't available/i);
    });
  });
});
