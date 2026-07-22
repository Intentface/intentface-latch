import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AppMessage } from "@intentface/latch-core";
import {
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

  it("resolves an approval button reply via applyApproval", async () => {
    const h = harness();
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
