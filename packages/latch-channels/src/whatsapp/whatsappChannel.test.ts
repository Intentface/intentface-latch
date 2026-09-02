import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AppMessage } from "@intentface/latch-core";
import type { AskSession, AskStateStore } from "../types.js";
import {
  decodeWhatsappQuestionId,
  splitWhatsappText,
  whatsappChannel,
  type WhatsappChannelConfig,
} from "./whatsappChannel.js";

const APP_SECRET = "app-secret";
const VERIFY_TOKEN = "verify-token";

function sseResponse(chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const textRun = (text: string) => sseResponse([{ type: "text-delta", id: "1", delta: text }]);

/** A history message parked on an approval-requested tool part. */
function approvalHistory(approvalId: string, toolName = "web_search"): AppMessage[] {
  return [
    {
      id: "m1",
      role: "assistant",
      parts: [
        { type: `tool-${toolName}`, state: "approval-requested", input: { q: "x" }, approval: { id: approvalId } },
      ],
    } as unknown as AppMessage,
  ];
}

function harness(overrides: Partial<WhatsappChannelConfig<{ userId: string }>> = {}) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ path: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify({ messages: [{ id: "wamid.out" }] }), { status: 200 });
  });

  const deferred: Promise<unknown>[] = [];
  const runtime = {
    handleChat: vi.fn(async (_input: unknown) => textRun("Answer!")),
    applyApproval: vi.fn(async (_input: unknown) => textRun("Resumed.")),
    applyToolResult: vi.fn(async (_input: unknown) => textRun("Thanks!")),
    loadHistory: vi.fn(async (): Promise<AppMessage[]> => []),
  };

  const channel = whatsappChannel<{ userId: string }>({
    agent: "support",
    botRef: "wb1",
    accessToken: "AT",
    phoneNumberId: "555000",
    appSecret: APP_SECRET,
    verifyToken: VERIFY_TOKEN,
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
    sends: () => calls.filter((c) => c.path.includes("/messages")).map((c) => c.body),
  };
}

function signedPost(body: unknown, secret = APP_SECRET): Request {
  const raw = JSON.stringify(body);
  return new Request("https://host/api/whatsapp/wb1/events", {
    method: "POST",
    headers: {
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`,
    },
    body: raw,
  });
}

const inbound = (msg: Record<string, unknown>, value: Record<string, unknown> = {}) => ({
  object: "whatsapp_business_account",
  entry: [
    {
      changes: [
        {
          field: "messages",
          value: {
            contacts: [{ wa_id: "358401234567", profile: { name: "Aleksi" } }],
            messages: [{ from: "358401234567", id: "wamid.in1", type: "text", ...msg }],
            ...value,
          },
        },
      ],
    },
  ],
});

describe("whatsappChannel.handleRequest", () => {
  it("answers Meta's GET hub.challenge handshake", async () => {
    const h = harness();
    const res = await h.channel.handleRequest(
      new Request(
        `https://host/api/whatsapp/wb1/events?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=ping`,
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ping");
  });

  it("rejects a GET with the wrong verify token", async () => {
    const h = harness();
    const res = await h.channel.handleRequest(
      new Request(
        "https://host/api/whatsapp/wb1/events?hub.mode=subscribe&hub.verify_token=NO&hub.challenge=ping",
      ),
    );
    expect(res.status).toBe(403);
  });

  it("rejects an unsigned/mis-signed POST with 401", async () => {
    const h = harness();
    const res = await h.channel.handleRequest(
      signedPost(inbound({ text: { body: "hi" } }), "wrong-secret"),
    );
    expect(res.status).toBe(401);
    expect(h.runtime.handleChat).not.toHaveBeenCalled();
  });

  it("runs a signed text message and replies once at the end", async () => {
    const h = harness();
    const res = await h.channel.handleRequest(signedPost(inbound({ text: { body: "hi" } })));
    expect(res.status).toBe(200);
    await h.flush();

    const input = h.runtime.handleChat.mock.calls[0]![0] as { chatId: string };
    expect(input.chatId).toBe("whatsapp_wb1_358401234567");
    const sends = h.sends();
    expect(sends).toHaveLength(1); // post-at-end: exactly one reply
    expect(sends[0]).toMatchObject({ to: "358401234567", type: "text" });
    expect((sends[0]!.text as { body: string }).body).toBe("Answer!");
  });

  it("processes changes addressed to the configured phone number id", async () => {
    const h = harness();
    await h.channel.handleRequest(
      signedPost(
        inbound({ text: { body: "hi" } }, { metadata: { phone_number_id: "555000" } }),
      ),
    );
    await h.flush();
    expect(h.runtime.handleChat).toHaveBeenCalledTimes(1);
  });

  it("ignores changes addressed to a DIFFERENT registered number", async () => {
    // One Meta app can deliver events for several numbers to the same endpoint.
    const h = harness();
    await h.channel.handleRequest(
      signedPost(
        inbound({ text: { body: "hi" } }, { metadata: { phone_number_id: "999111" } }),
      ),
    );
    await h.flush();
    expect(h.runtime.handleChat).not.toHaveBeenCalled();
    expect(h.sends()).toHaveLength(0); // never replies through the wrong binding
  });

  it("drops duplicate wamids via seen()", async () => {
    const seen = vi.fn(async () => true);
    const h = harness({ seen });
    await h.channel.handleRequest(signedPost(inbound({ text: { body: "hi" } })));
    await h.flush();
    expect(seen).toHaveBeenCalledWith("wb1:358401234567:wamid.in1");
    expect(h.runtime.handleChat).not.toHaveBeenCalled();
  });

  it("sends a setup link and stashes the message for unlinked users", async () => {
    const stashPending = vi.fn(async () => {});
    const h = harness({
      authorizeUser: async () => ({ allowed: false, linkUrl: "https://x/whatsapp/link?s=1" }),
      stashPending,
    });
    await h.channel.handleRequest(signedPost(inbound({ text: { body: "do it" } })));
    await h.flush();
    expect(stashPending).toHaveBeenCalledWith({
      waId: "358401234567",
      profileName: "Aleksi",
      text: "do it",
    });
    expect((h.sends()[0]!.text as { body: string }).body).toContain("https://x/whatsapp/link?s=1");
  });

  it("stashes media refs with the pending message for unlinked users", async () => {
    const stashPending = vi.fn(async () => {});
    const h = harness({
      authorizeUser: async () => ({ allowed: false, linkUrl: "https://x/whatsapp/link?s=1" }),
      stashPending,
    });
    const image = { id: "media1", mime_type: "image/png", caption: "look" };
    await h.channel.handleRequest(signedPost(inbound({ type: "image", image })));
    await h.flush();
    expect(stashPending).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "look",
        media: [{ ref: image, mediaType: "image/png", name: "photo.jpg" }],
      }),
    );
  });

  it("replayMessage claims and releases the turn lease around the run", async () => {
    const claimTurn = vi.fn(async () => "lease-9");
    const releaseTurn = vi.fn(async () => {});
    const h = harness({ claimTurn, releaseTurn });
    await h.channel.replayMessage({
      waId: "358401234567",
      text: "replayed",
      principal: { userId: "u1" },
    });
    expect(claimTurn).toHaveBeenCalledWith("whatsapp_wb1_358401234567");
    expect(h.runtime.handleChat).toHaveBeenCalledTimes(1);
    expect(releaseTurn).toHaveBeenCalledWith("whatsapp_wb1_358401234567", "lease-9");
  });

  it("splits a long answer across sequential messages", async () => {
    const h = harness();
    h.runtime.handleChat.mockResolvedValueOnce(textRun("a".repeat(5000)));
    await h.channel.handleRequest(signedPost(inbound({ text: { body: "long please" } })));
    await h.flush();
    const sends = h.sends();
    expect(sends.length).toBe(2);
    expect((sends[0]!.text as { body: string }).body.length).toBeLessThanOrEqual(4096);
  });

  it("approval replies resume under the turn lease and release it", async () => {
    const claimTurn = vi.fn(async () => "lease-4");
    const releaseTurn = vi.fn(async () => {});
    const h = harness({ claimTurn, releaseTurn });
    h.runtime.loadHistory.mockResolvedValue(approvalHistory("ap1"));
    await h.channel.handleRequest(
      signedPost(
        inbound({
          type: "interactive",
          interactive: { type: "button_reply", button_reply: { id: "lta:1|ap1" } },
        }),
      ),
    );
    await h.flush();
    expect(claimTurn).toHaveBeenCalledWith("whatsapp_wb1_358401234567");
    expect(h.runtime.applyApproval).toHaveBeenCalledTimes(1);
    expect(releaseTurn).toHaveBeenCalledWith("whatsapp_wb1_358401234567", "lease-4");
  });

  it("approval replies back off with 'still working' when the turn is claimed", async () => {
    const h = harness({ claimTurn: async () => null });
    h.runtime.loadHistory.mockResolvedValue(approvalHistory("ap1"));
    await h.channel.handleRequest(
      signedPost(
        inbound({
          type: "interactive",
          interactive: { type: "button_reply", button_reply: { id: "lta:1|ap1" } },
        }),
      ),
    );
    await h.flush();
    expect(h.runtime.applyApproval).not.toHaveBeenCalled();
    expect((h.sends()[0]!.text as { body: string }).body).toContain("still working");
  });

  it("resolves an approval button reply via applyApproval", async () => {
    const h = harness();
    // Live before the decision; nothing pending after the resume.
    h.runtime.loadHistory.mockResolvedValueOnce(approvalHistory("ap1"));
    await h.channel.handleRequest(
      signedPost(
        inbound({
          type: "interactive",
          interactive: { type: "button_reply", button_reply: { id: "lta:1|ap1", title: "Approve" } },
        }),
      ),
    );
    await h.flush();
    expect(h.runtime.applyApproval).toHaveBeenCalledWith({
      chatId: "whatsapp_wb1_358401234567",
      principal: { userId: "u1" },
      decisions: [{ approvalId: "ap1", approved: true }],
    });
    expect((h.sends().at(-1)!.text as { body: string }).body).toBe("Resumed.");
  });

  it("a tap on an approval that is gone from fresh history says so and runs nothing", async () => {
    const h = harness(); // loadHistory → [] : answered in the web app, or a previous thread's card
    await h.channel.handleRequest(
      signedPost(
        inbound({
          type: "interactive",
          interactive: { type: "button_reply", button_reply: { id: "lta:1|ap1" } },
        }),
      ),
    );
    await h.flush();
    expect(h.runtime.applyApproval).not.toHaveBeenCalled();
    expect((h.sends()[0]!.text as { body: string }).body).toMatch(/no longer active/);
  });
});

describe("splitWhatsappText", () => {
  it("returns short text as a single chunk", () => {
    expect(splitWhatsappText("hello")).toEqual(["hello"]);
  });

  it("prefers splitting at paragraph breaks", () => {
    const text = `${"a".repeat(3000)}\n\n${"b".repeat(3000)}`;
    const chunks = splitWhatsappText(text, 4096);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe("a".repeat(3000));
    expect(chunks[1]).toBe("b".repeat(3000));
  });

  it("hard-splits when there is no break to use", () => {
    const chunks = splitWhatsappText("x".repeat(9000), 4096);
    expect(chunks.length).toBe(3);
    expect(chunks.every((c) => c.length <= 4096)).toBe(true);
  });
});

/** In-memory AskStateStore with the real rev/nonce/"already" semantics. */
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
      update: async (c: string, t: string, rev: number, patch: Partial<AskSession>) => {
        const row = rows.get(c);
        if (!row || row.toolCallId !== t || row.rev !== rev) return null;
        rows.set(c, { ...row, ...patch, rev: rev + 1 });
        return rev + 1;
      },
      finish: async (c: string, t: string, rev: number) => {
        const row = rows.get(c);
        if (!row || row.toolCallId !== t || row.rev !== rev) return false;
        rows.delete(c);
        return true;
      },
      clear: async (c: string) => {
        const row = rows.get(c) ?? null;
        rows.delete(c);
        return row;
      },
    } satisfies AskStateStore,
  };
}

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

describe("whatsappChannel questionnaires (askUser)", () => {
  const two = {
    question: "Goal?",
    options: [
      { label: "Speed", description: "faster" },
      { label: "Finish", description: "just finish" },
    ],
  };
  const many = {
    question: "Which day?",
    options: ["Mon", "Tue", "Wed", "Thu", "Fri"].map((d) => ({ label: d, description: `on ${d}` })),
  };
  const lots = {
    question: "Pick a number",
    options: Array.from({ length: 12 }, (_, i) => ({ label: `n${i}`, description: `num ${i}` })),
  };
  const multi = {
    question: "Which sports?",
    multiSelect: true,
    options: [
      { label: "Trail", description: "trail" },
      { label: "Road", description: "road" },
    ],
  };

  function askHarness(questions: unknown[], over: Record<string, unknown> = {}) {
    const ask = fakeAskState();
    const h = harness({ askState: ask.store, ...over });
    h.runtime.loadHistory.mockResolvedValue(askHistory("toolu_ask1", questions));
    return { ...h, ask };
  }

  const lastSend = (h: ReturnType<typeof harness>) => h.sends().at(-1)!;

  const tapReply = (h: ReturnType<typeof harness>, id: string, kind = "button_reply") =>
    h.channel.handleRequest(
      signedPost(
        inbound({
          id: `wamid.${id}`,
          type: "interactive",
          interactive: { type: kind === "button_reply" ? "button" : "list", [kind]: { id } },
        }),
      ),
    );

  it("uses reply buttons when a question has ≤3 options", async () => {
    const h = askHarness([two]);
    await h.channel.handleRequest(signedPost(inbound({ text: { body: "moi" } })));
    await h.flush();

    const body = lastSend(h) as {
      type: string;
      interactive: { type: string; action: { buttons: { reply: { id: string; title: string } }[] } };
    };
    expect(body.type).toBe("interactive");
    expect(body.interactive.type).toBe("button");
    expect(body.interactive.action.buttons.map((b) => b.reply.title)).toEqual(["Speed", "Finish"]);
    expect(decodeWhatsappQuestionId(body.interactive.action.buttons[0]!.reply.id)).toMatchObject({
      verb: "pick",
      questionIndex: 0,
      optionIndex: 0,
    });
  });

  it("falls back to a list when a question has 4–10 options", async () => {
    const h = askHarness([many]);
    await h.channel.handleRequest(signedPost(inbound({ text: { body: "moi" } })));
    await h.flush();

    const body = lastSend(h) as {
      interactive: { type: string; action: { sections: { rows: { title: string }[] }[] } };
    };
    expect(body.interactive.type).toBe("list");
    expect(body.interactive.action.sections[0]!.rows).toHaveLength(5);
  });

  it("falls back to numbered text past the list limit", async () => {
    const h = askHarness([lots]);
    await h.channel.handleRequest(signedPost(inbound({ text: { body: "moi" } })));
    await h.flush();

    const body = lastSend(h) as { type: string; text?: { body: string } };
    expect(body.type).toBe("text");
    expect(body.text!.body).toContain("1. n0");
    expect(body.text!.body).toContain("12. n11");
  });

  it("multi-select always uses numbered text (messages can't be edited)", async () => {
    const h = askHarness([multi]);
    await h.channel.handleRequest(signedPost(inbound({ text: { body: "moi" } })));
    await h.flush();

    const body = lastSend(h) as { type: string; text?: { body: string } };
    expect(body.type).toBe("text");
    expect(body.text!.body).toMatch(/numbers you want/i);
  });

  it("a button tap submits the answer map", async () => {
    const h = askHarness([two]);
    await h.channel.handleRequest(signedPost(inbound({ text: { body: "moi" } })));
    await h.flush();
    const id = (
      lastSend(h) as { interactive: { action: { buttons: { reply: { id: string } }[] } } }
    ).interactive.action.buttons[0]!.reply.id;

    await tapReply(h, id);
    await h.flush();

    expect(h.runtime.applyToolResult).toHaveBeenCalledWith({
      chatId: "whatsapp_wb1_358401234567",
      principal: { userId: "u1" },
      toolCallId: "toolu_ask1",
      output: { "Goal?": "Speed" },
    });
  });

  it("a list-row tap answers too", async () => {
    const h = askHarness([many]);
    await h.channel.handleRequest(signedPost(inbound({ text: { body: "moi" } })));
    await h.flush();
    const id = (
      lastSend(h) as { interactive: { action: { sections: { rows: { id: string }[] }[] } } }
    ).interactive.action.sections[0]!.rows[2]!.id;

    await tapReply(h, id, "list_reply");
    await h.flush();

    expect(h.runtime.applyToolResult.mock.calls[0]![0]).toMatchObject({
      output: { "Which day?": "Wed" },
    });
  });

  it("a typed number answers the pending question instead of starting a turn", async () => {
    const h = askHarness([two]);
    await h.channel.handleRequest(signedPost(inbound({ text: { body: "moi" } })));
    await h.flush();
    h.runtime.handleChat.mockClear();

    await h.channel.handleRequest(
      signedPost(inbound({ id: "wamid.in2", text: { body: "2" } })),
    );
    await h.flush();

    expect(h.runtime.handleChat).not.toHaveBeenCalled();
    expect(h.runtime.applyToolResult.mock.calls[0]![0]).toMatchObject({
      output: { "Goal?": "Finish" },
    });
  });

  it("a multi-select numbered reply picks several options", async () => {
    const h = askHarness([multi]);
    await h.channel.handleRequest(signedPost(inbound({ text: { body: "moi" } })));
    await h.flush();

    await h.channel.handleRequest(
      signedPost(inbound({ id: "wamid.in2", text: { body: "1,2" } })),
    );
    await h.flush();

    expect(h.runtime.applyToolResult.mock.calls[0]![0]).toMatchObject({
      output: { "Which sports?": "Trail, Road" },
    });
  });

  it("walks two questions, submitting only after the last", async () => {
    const h = askHarness([two, many]);
    await h.channel.handleRequest(signedPost(inbound({ text: { body: "moi" } })));
    await h.flush();

    await h.channel.handleRequest(signedPost(inbound({ id: "wamid.a", text: { body: "1" } })));
    await h.flush();
    expect(h.runtime.applyToolResult).not.toHaveBeenCalled();
    expect((lastSend(h) as { interactive?: { type: string } }).interactive?.type).toBe("list");

    await h.channel.handleRequest(signedPost(inbound({ id: "wamid.b", text: { body: "1" } })));
    await h.flush();
    expect(h.runtime.applyToolResult.mock.calls[0]![0]).toMatchObject({
      output: { "Goal?": "Speed", "Which day?": "Mon" },
    });
  });

  it("a tap whose questionnaire is gone says so instead of answering", async () => {
    const h = harness({ askState: fakeAskState().store });
    await tapReply(h, "ltq:s|zzzzzz|0|0");
    await h.flush();
    expect(h.runtime.applyToolResult).not.toHaveBeenCalled();
    expect(String((lastSend(h) as { text?: { body: string } }).text?.body)).toMatch(
      /no longer active/i,
    );
  });

  it("/cancel drops the questionnaire and runs no turn", async () => {
    const h = askHarness([two]);
    await h.channel.handleRequest(signedPost(inbound({ text: { body: "moi" } })));
    await h.flush();
    h.runtime.handleChat.mockClear();

    await h.channel.handleRequest(
      signedPost(inbound({ id: "wamid.in2", text: { body: "/cancel" } })),
    );
    await h.flush();

    expect(h.runtime.handleChat).not.toHaveBeenCalled();
    expect(h.runtime.applyToolResult).not.toHaveBeenCalled();
    expect(h.ask.rows.size).toBe(0);
  });

  it("ignores an askUser call that is no longer the tail", async () => {
    const h = askHarness([two]);
    h.runtime.loadHistory.mockResolvedValue([
      ...askHistory("toolu_old", [two]),
      { id: "u9", role: "user", parts: [{ type: "text", text: "never mind" }] } as AppMessage,
    ]);
    await h.channel.handleRequest(signedPost(inbound({ text: { body: "moi" } })));
    await h.flush();

    expect(h.sends().some((b) => (b as { type?: string }).type === "interactive")).toBe(false);
  });

  it("a captioned image is NOT an answer — it runs a turn so the file reaches the agent", async () => {
    const h = askHarness([two]);
    await h.channel.handleRequest(signedPost(inbound({ text: { body: "moi" } })));
    await h.flush();
    h.runtime.handleChat.mockClear();
    h.runtime.loadHistory.mockResolvedValue([]);

    await h.channel.handleRequest(
      signedPost(
        inbound({
          id: "wamid.img",
          type: "image",
          text: undefined,
          image: { id: "media1", mime_type: "image/jpeg", caption: "here it is" },
        }),
      ),
    );
    await h.flush();

    // Treating the caption as the answer would silently drop the attachment.
    expect(h.runtime.applyToolResult).not.toHaveBeenCalled();
    expect(h.runtime.handleChat).toHaveBeenCalledTimes(1);
    expect(h.ask.rows.size).toBe(0); // questionnaire retired
  });

  it("keeps the answers when the host forgot to wire applyToolResult", async () => {
    const ask = fakeAskState();
    const h = harness({
      askState: ask.store,
      runtime: {
        handleChat: vi.fn(async () => textRun("Answer!")),
        applyApproval: vi.fn(),
        loadHistory: vi.fn(async () => askHistory("toolu_ask1", [two])),
      } as never,
    });
    await h.channel.handleRequest(signedPost(inbound({ text: { body: "moi" } })));
    await h.flush();

    await h.channel.handleRequest(signedPost(inbound({ id: "wamid.a", text: { body: "1" } })));
    await h.flush();

    // Destroying the session here would lose every collected answer.
    expect(ask.rows.get("whatsapp_wb1_358401234567")).toBeDefined();
  });

  it("without askState the questions are posted as text and nothing is submitted", async () => {
    const h = harness();
    h.runtime.loadHistory.mockResolvedValue(askHistory("toolu_ask1", [two]));
    await h.channel.handleRequest(signedPost(inbound({ text: { body: "moi" } })));
    await h.flush();

    expect(String((lastSend(h) as { text?: { body: string } }).text?.body)).toContain("Goal?");
    expect(h.runtime.applyToolResult).not.toHaveBeenCalled();
  });
});
