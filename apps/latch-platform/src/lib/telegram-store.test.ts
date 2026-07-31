import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTelegramStore, migrateTelegram, type TelegramStore } from "./telegram-store";

let client: Client;
let store: TelegramStore;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await migrateTelegram(client);
  store = createTelegramStore(client);
});

afterEach(() => {
  client.close();
  vi.useRealTimers();
});

const bot = { id: "b1", agent: "support", orgId: "org1", handle: "support-bot" };

describe("telegram store: bots", () => {
  it("creates, reads and lists bots per org", async () => {
    await store.create(bot);
    expect(await store.get("b1")).toMatchObject({ ...bot, status: "active" });
    expect(await store.listForOrg("org1")).toHaveLength(1);
    expect(await store.listForOrg("other")).toHaveLength(0);
  });

  it("enforces unique handles", async () => {
    await store.create(bot);
    await expect(store.create({ ...bot, id: "b2" })).rejects.toThrow(/UNIQUE/i);
  });

  it("a token save records the username and resets the webhook mark", async () => {
    await store.create(bot);
    await store.markWebhookRegistered("b1");
    expect((await store.get("b1"))!.webhookRegisteredAt).toBeTruthy();
    await store.setBotUsername("b1", "acme_bot");
    const after = (await store.get("b1"))!;
    expect(after.botUsername).toBe("acme_bot");
    expect(after.webhookRegisteredAt).toBeUndefined(); // secret rotated → must re-register
  });

  it("remove deletes the bot and its identities + pendings", async () => {
    await store.create(bot);
    await store.linkIdentity({ botId: "b1", telegramUserId: "5", userId: "u1", orgId: "org1" });
    await store.setPending({ botId: "b1", telegramUserId: "5", telegramChatId: "5", text: "hi" });
    await store.remove("b1");
    expect(await store.get("b1")).toBeNull();
    expect(await store.resolveIdentity("b1", "5")).toBeNull();
    expect(await store.takePending("b1", "5")).toBeNull();
  });
});

describe("telegram store: identities", () => {
  it("links and resolves an identity", async () => {
    expect(
      await store.linkIdentity({ botId: "b1", telegramUserId: "5", userId: "u1", orgId: "org1" }),
    ).toBe("linked");
    expect(await store.resolveIdentity("b1", "5")).toEqual({ userId: "u1", orgId: "org1" });
  });

  it("refuses to silently re-link to a DIFFERENT platform user", async () => {
    await store.linkIdentity({ botId: "b1", telegramUserId: "5", userId: "u1", orgId: "org1" });
    expect(
      await store.linkIdentity({ botId: "b1", telegramUserId: "5", userId: "u2", orgId: "org1" }),
    ).toBe("conflict");
    expect((await store.resolveIdentity("b1", "5"))!.userId).toBe("u1"); // unchanged
  });

  it("the same user re-linking refreshes the cached username", async () => {
    await store.linkIdentity({
      botId: "b1",
      telegramUserId: "5",
      userId: "u1",
      orgId: "org1",
      username: "old",
    });
    expect(
      await store.linkIdentity({
        botId: "b1",
        telegramUserId: "5",
        userId: "u1",
        orgId: "org1",
        username: "new",
      }),
    ).toBe("linked");
  });
});

describe("telegram store: delivery dedupe", () => {
  it("first delivery is fresh, replay is seen", async () => {
    expect(await store.seenDelivery("k1")).toBe(false);
    expect(await store.seenDelivery("k1")).toBe(true);
  });

  it("expires keys after the 10-minute TTL (prune-then-check)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000);
    expect(await store.seenDelivery("k1")).toBe(false);
    vi.setSystemTime(1_000_000_000 + 11 * 60 * 1000);
    expect(await store.seenDelivery("k1")).toBe(false); // pruned → fresh again
  });
});

describe("telegram store: pending replay", () => {
  it("holds one message per (bot, user), replays exactly once", async () => {
    await store.setPending({ botId: "b1", telegramUserId: "5", telegramChatId: "5", text: "one" });
    await store.setPending({ botId: "b1", telegramUserId: "5", telegramChatId: "5", text: "two" });
    expect(await store.takePending("b1", "5")).toEqual({ telegramChatId: "5", text: "two" });
    expect(await store.takePending("b1", "5")).toBeNull(); // replay-once
  });

  it("preserves media refs across the stash/replay round-trip", async () => {
    const media = [{ ref: { file_id: "f1", file_size: 9 }, mediaType: "image/jpeg", name: "photo.jpg" }];
    await store.setPending({
      botId: "b1",
      telegramUserId: "5",
      telegramChatId: "5",
      text: "look",
      media,
    });
    expect(await store.takePending("b1", "5")).toEqual({
      telegramChatId: "5",
      text: "look",
      media,
    });
  });
});

describe("telegram store: turn leases", () => {
  it("claims once per chat, releases, and reclaims after expiry", async () => {
    const t1 = await store.claimTurn("telegram_b1_5");
    expect(t1).toBeTruthy();
    expect(await store.claimTurn("telegram_b1_5")).toBeNull();
    await store.releaseTurn("telegram_b1_5", t1!);
    expect(await store.claimTurn("telegram_b1_5")).toBeTruthy();

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 6 * 60 * 1000); // past the 5-min lease
    expect(await store.claimTurn("telegram_b1_5")).toBeTruthy(); // crash-safe reclaim
  });

  it("release is fenced on the claimant token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000);
    const stale = await store.claimTurn("telegram_b1_5");
    vi.setSystemTime(1_000_000_000 + 6 * 60 * 1000); // stale lease expires…
    const fresh = await store.claimTurn("telegram_b1_5"); // …a new turn reclaims
    expect(fresh).toBeTruthy();

    await store.releaseTurn("telegram_b1_5", stale!); // outlived turn finishes late
    expect(await store.claimTurn("telegram_b1_5")).toBeNull(); // fresh lease survives

    await store.releaseTurn("telegram_b1_5", fresh!);
    expect(await store.claimTurn("telegram_b1_5")).toBeTruthy();
  });
});

describe("telegram store: askUser sessions", () => {
  const chat = "telegram_b1_5";
  const questions = [
    { question: "Goal?", options: [{ label: "Speed", description: "faster" }] },
    { question: "Days?", options: [{ label: "3", description: "three" }] },
  ];
  const session = {
    toolCallId: "toolu_1",
    nonce: "abc123",
    questions,
    cursor: 0,
    answers: {},
    selected: [],
    promptChatId: "5",
  };

  it("begins a session and round-trips it", async () => {
    expect(await store.beginAsk(chat, session)).toBe("started");
    expect(await store.getAsk(chat)).toEqual({ ...session, rev: 0 });
  });

  it("re-begins for the SAME tool call as 'already' — no duplicate prompt", async () => {
    await store.beginAsk(chat, session);
    await store.updateAsk(chat, "toolu_1", 0, { cursor: 1 });
    expect(await store.beginAsk(chat, { ...session, nonce: "zzz999" })).toBe("already");
    // The live session survives untouched — the second render must not reset it.
    const live = (await store.getAsk(chat))!;
    expect(live.nonce).toBe("abc123");
    expect(live.cursor).toBe(1);
  });

  it("a DIFFERENT tool call takes over the row and resets progress", async () => {
    await store.beginAsk(chat, session);
    await store.updateAsk(chat, "toolu_1", 0, { cursor: 1, answers: { "Goal?": "Speed" } });
    expect(await store.beginAsk(chat, { ...session, toolCallId: "toolu_2", nonce: "def456" })).toBe(
      "started",
    );
    const live = (await store.getAsk(chat))!;
    expect(live).toMatchObject({ toolCallId: "toolu_2", cursor: 0, answers: {}, rev: 0 });
  });

  it("update is fenced on rev — a double tap can't advance twice", async () => {
    await store.beginAsk(chat, session);
    expect(await store.updateAsk(chat, "toolu_1", 0, { cursor: 1 })).toBe(1);
    // The second delivery of the same tap still carries rev 0.
    expect(await store.updateAsk(chat, "toolu_1", 0, { cursor: 2 })).toBeNull();
    expect((await store.getAsk(chat))!.cursor).toBe(1);
  });

  it("finish is fenced too, so only one caller submits", async () => {
    await store.beginAsk(chat, session);
    expect(await store.finishAsk(chat, "toolu_1", 9)).toBe(false); // stale rev
    expect(await store.getAsk(chat)).not.toBeNull();
    expect(await store.finishAsk(chat, "toolu_1", 0)).toBe(true);
    expect(await store.getAsk(chat)).toBeNull();
    expect(await store.finishAsk(chat, "toolu_1", 0)).toBe(false); // already gone
  });

  it("clear returns what it removed", async () => {
    await store.beginAsk(chat, session);
    expect((await store.clearAsk(chat))!.toolCallId).toBe("toolu_1");
    expect(await store.getAsk(chat)).toBeNull();
    expect(await store.clearAsk(chat)).toBeNull();
  });

  it("expires a session after 24h so it can't swallow a later message", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000);
    await store.beginAsk(chat, session);
    vi.setSystemTime(1_000_000_000 + 25 * 60 * 60 * 1000);
    expect(await store.getAsk(chat)).toBeNull();
  });

  it("re-begins over an EXPIRED row for the same tool call", async () => {
    // begin() is reached without a preceding get() (which is what prunes), so a
    // stale row must not answer "already" — that would suppress the prompt and
    // leave the user with no question AND no button on a still-paused turn.
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000);
    await store.beginAsk(chat, session);
    vi.setSystemTime(1_000_000_000 + 25 * 60 * 60 * 1000);
    expect(await store.beginAsk(chat, { ...session, nonce: "fresh1" })).toBe("started");
    expect((await store.getAsk(chat))!.nonce).toBe("fresh1");
  });

  it("keeps sessions of different chats apart", async () => {
    await store.beginAsk(chat, session);
    await store.beginAsk("telegram_b1_6", { ...session, toolCallId: "toolu_9", nonce: "n9" });
    expect((await store.getAsk(chat))!.toolCallId).toBe("toolu_1");
    expect((await store.getAsk("telegram_b1_6"))!.toolCallId).toBe("toolu_9");
  });
});
