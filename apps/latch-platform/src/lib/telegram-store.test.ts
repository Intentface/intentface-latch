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
});

describe("telegram store: turn leases", () => {
  it("claims once per chat, releases, and reclaims after expiry", async () => {
    expect(await store.claimTurn("telegram_b1_5")).toBe(true);
    expect(await store.claimTurn("telegram_b1_5")).toBe(false);
    await store.releaseTurn("telegram_b1_5");
    expect(await store.claimTurn("telegram_b1_5")).toBe(true);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 6 * 60 * 1000); // past the 5-min lease
    expect(await store.claimTurn("telegram_b1_5")).toBe(true); // crash-safe reclaim
  });
});
