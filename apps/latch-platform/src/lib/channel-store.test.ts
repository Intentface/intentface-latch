import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChannelStore, migrateChannels, type ChannelStore } from "./channel-store";

let client: Client;
let store: ChannelStore;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await migrateChannels(client);
  store = createChannelStore(client);
});

afterEach(() => {
  client.close();
  vi.useRealTimers();
});

const bot = { kind: "telegram" as const, id: "b1", agent: "support", orgId: "org1", handle: "support-bot" };
const tg = (externalId: string, userId: string, botRef = "b1") =>
  ({ kind: "telegram" as const, botRef, externalId, userId, orgId: "org1" });

describe("channel store: bots", () => {
  it("creates, reads and lists bots per kind and org", async () => {
    await store.createBot(bot);
    await store.createBot({ ...bot, kind: "whatsapp", id: "w1", handle: "support-bot" }); // same handle, other kind
    expect(await store.getBot("telegram", "b1")).toMatchObject({ ...bot, status: "active" });
    expect(await store.getBot("whatsapp", "b1")).toBeNull();
    expect(await store.listBots("telegram", "org1")).toHaveLength(1);
    expect(await store.listBots("telegram", "other")).toHaveLength(0);
  });

  it("bot identity is (kind, id): the same id on two kinds is two bots", async () => {
    await store.createBot(bot);
    await store.createBot({ ...bot, kind: "whatsapp", handle: "wa" });
    expect((await store.getBot("telegram", "b1"))!.kind).toBe("telegram");
    expect((await store.getBot("whatsapp", "b1"))!.kind).toBe("whatsapp");
    await store.removeBot("whatsapp", "b1");
    expect(await store.getBot("telegram", "b1")).not.toBeNull();
  });

  it("enforces unique handles within a kind", async () => {
    await store.createBot(bot);
    await expect(store.createBot({ ...bot, id: "b2" })).rejects.toThrow(/UNIQUE/i);
  });

  it("a credential save records the platform handle; Telegram's resets the webhook mark", async () => {
    await store.createBot(bot);
    await store.markWebhookRegistered("telegram", "b1");
    expect((await store.getBot("telegram", "b1"))!.webhookRegisteredAt).toBeTruthy();
    await store.setExternalHandle("telegram", "b1", "acme_bot", { resetWebhook: true });
    expect(await store.getBot("telegram", "b1")).toMatchObject({ externalHandle: "acme_bot" });
    expect((await store.getBot("telegram", "b1"))!.webhookRegisteredAt).toBeUndefined();
  });

  it("botsForAgent lists only this org's ACTIVE bots of that kind for that agent", async () => {
    await store.createBot(bot);
    await store.createBot({ ...bot, id: "b2", handle: "other", agent: "weekly" });
    await store.createBot({ ...bot, id: "b3", handle: "off" });
    await store.setBotStatus("telegram", "b3", "disabled");
    expect((await store.botsForAgent("telegram", "org1", "support")).map((b) => b.id)).toEqual(["b1"]);
    expect(await store.botsForAgent("whatsapp", "org1", "support")).toEqual([]);
  });

  it("removeBot cascades identities, pendings and per-chat state — for that bot only", async () => {
    await store.createBot(bot);
    await store.createBot({ ...bot, id: "b10", handle: "ten" });
    await store.linkIdentity(tg("5", "u1"));
    await store.linkIdentity(tg("5", "u1", "b10"));
    await store.setPending("telegram", "b1", "5", { text: "held" });
    await store.rotateThread("telegram_b1_5");
    await store.rotateThread("telegram_b10_5");
    await store.removeBot("telegram", "b1");
    expect(await store.getBot("telegram", "b1")).toBeNull();
    expect(await store.resolveIdentity("telegram", "b1", "5")).toBeNull();
    expect(await store.takePending("telegram", "b1", "5")).toBeNull();
    expect(await store.currentThread("telegram_b1_5")).toBe(0);
    // `b1_` is a prefix of nothing else: b10's rows survive.
    expect(await store.resolveIdentity("telegram", "b10", "5")).toEqual({ userId: "u1", orgId: "org1" });
    expect(await store.currentThread("telegram_b10_5")).toBe(1);
  });
});

describe("channel store: identities", () => {
  it("links and resolves, both directions, scoped by kind and bot", async () => {
    expect(await store.linkIdentity({ ...tg("5", "u1"), label: "al" })).toBe("linked");
    expect(await store.resolveIdentity("telegram", "b1", "5")).toEqual({ userId: "u1", orgId: "org1" });
    expect(await store.resolveIdentity("whatsapp", "b1", "5")).toBeNull();
    expect(await store.identityForUser("telegram", "b1", "u1")).toEqual({ externalId: "5", orgId: "org1" });
    expect(await store.identityForUser("telegram", "b2", "u1")).toBeNull();
  });

  it("refuses to silently re-link to a DIFFERENT Latch user; the same user just refreshes", async () => {
    await store.linkIdentity({ ...tg("5", "u1"), label: "old" });
    expect(await store.linkIdentity(tg("5", "u2"))).toBe("conflict");
    expect(await store.linkIdentity({ ...tg("5", "u1"), label: "new" })).toBe("linked");
    expect(await store.resolveIdentity("telegram", "b1", "5")).toEqual({ userId: "u1", orgId: "org1" });
  });

  it("'replace' is last-wins, for flows that proved both sides (a Slack installer)", async () => {
    await store.linkIdentity({ kind: "slack", botRef: "T1", externalId: "U1", userId: "u1", orgId: "org1" });
    expect(
      await store.linkIdentity(
        { kind: "slack", botRef: "T1", externalId: "U1", userId: "u2", orgId: "org1" },
        { onConflict: "replace" },
      ),
    ).toBe("linked");
    expect(await store.resolveIdentity("slack", "T1", "U1")).toEqual({ userId: "u2", orgId: "org1" });
  });

  it("identityForUser picks the OLDEST link deterministically when a user linked two accounts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    await store.linkIdentity(tg("9", "u1"));
    vi.setSystemTime(2_000);
    await store.linkIdentity(tg("5", "u1"));
    expect((await store.identityForUser("telegram", "b1", "u1"))!.externalId).toBe("9");
  });
});

describe("channel store: held messages", () => {
  it("holds one payload per identity (newest wins), replays exactly once, typed by the caller", async () => {
    await store.setPending("telegram", "b1", "5", { text: "first" });
    await store.setPending("telegram", "b1", "5", { text: "second", media: [{ name: "a.png" }] });
    expect(await store.takePending<{ text: string }>("telegram", "b1", "5")).toMatchObject({ text: "second" });
    expect(await store.takePending("telegram", "b1", "5")).toBeNull();
  });

  it("two concurrent takes hand the payload to exactly one caller", async () => {
    await store.setPending("telegram", "b1", "5", { text: "once" });
    const results = await Promise.all([
      store.takePending("telegram", "b1", "5"),
      store.takePending("telegram", "b1", "5"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("an expired pending reads as absent", async () => {
    await store.setPending("telegram", "b1", "5", { text: "stale" }, -1);
    expect(await store.takePending("telegram", "b1", "5")).toBeNull();
  });
});

describe("channel store: admission", () => {
  it("seen(): first delivery is fresh, a replay is seen, per kind", async () => {
    expect(await store.seen("telegram", "b1:5:5:1")).toBe(false);
    expect(await store.seen("telegram", "b1:5:5:1")).toBe(true);
    expect(await store.seen("whatsapp", "b1:5:5:1")).toBe(false);
  });

  it("claimOnce claims a key exactly once within its TTL and reclaims after", async () => {
    expect(await store.claimOnce("slack:A1:evt:E1", 60_000)).toBe(true);
    expect(await store.claimOnce("slack:A1:evt:E1", 60_000)).toBe(false);
    expect(await store.claimOnce("slack:A1:evt:E2", -1)).toBe(true); // already expired
    expect(await store.claimOnce("slack:A1:evt:E2", 60_000)).toBe(true);
  });

  it("migrate + prune run twice without error", async () => {
    await migrateChannels(client);
    await store.pruneExpired();
    await store.pruneExpired();
  });
});

describe("channel store: legacy carry-over", () => {
  /** The per-channel tables as the old stores created them, with one row each. */
  async function seedLegacy(c: Client) {
    await c.batch(
      [
        `CREATE TABLE latch_telegram_bot (id TEXT PRIMARY KEY, agent TEXT NOT NULL, agent_scope TEXT, org_id TEXT NOT NULL,
           user_id TEXT, handle TEXT NOT NULL UNIQUE, display_name TEXT, bot_username TEXT, status TEXT NOT NULL DEFAULT 'active',
           webhook_registered_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
        `INSERT INTO latch_telegram_bot VALUES ('b1','support','org','org1','u1','support-bot','Support','acme_bot','active',123,1,1)`,
        `CREATE TABLE latch_telegram_identity (bot_id TEXT NOT NULL, telegram_user_id TEXT NOT NULL, user_id TEXT NOT NULL,
           org_id TEXT NOT NULL, username TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (bot_id, telegram_user_id))`,
        `INSERT INTO latch_telegram_identity VALUES ('b1','5','u1','org1','al',1)`,
        `CREATE TABLE latch_telegram_pending (bot_id TEXT NOT NULL, telegram_user_id TEXT NOT NULL, telegram_chat_id TEXT NOT NULL,
           username TEXT, text TEXT NOT NULL, media TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (bot_id, telegram_user_id))`,
        `INSERT INTO latch_telegram_pending VALUES ('b1','7','7','bo','do the thing','[{"name":"a.png"}]',${Date.now()})`,
        `CREATE TABLE latch_telegram_delivery (key TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)`,
        `INSERT INTO latch_telegram_delivery VALUES ('b1:5:5:1', ${Date.now() + 600_000})`,
        `CREATE TABLE latch_whatsapp_bot (id TEXT PRIMARY KEY, agent TEXT NOT NULL, agent_scope TEXT, org_id TEXT NOT NULL,
           user_id TEXT, handle TEXT NOT NULL UNIQUE, display_name TEXT, phone_number_id TEXT, status TEXT NOT NULL DEFAULT 'active',
           created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
        `INSERT INTO latch_whatsapp_bot VALUES ('w1','support',NULL,'org1','u1','wa-support',NULL,'555000','active',1,1)`,
        `CREATE TABLE latch_whatsapp_identity (bot_id TEXT NOT NULL, wa_user_id TEXT NOT NULL, user_id TEXT NOT NULL,
           org_id TEXT NOT NULL, profile_name TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (bot_id, wa_user_id))`,
        `INSERT INTO latch_whatsapp_identity VALUES ('w1','35840','u1','org1','Aleksi',1)`,
        `CREATE TABLE latch_whatsapp_pending (bot_id TEXT NOT NULL, wa_user_id TEXT NOT NULL, profile_name TEXT, text TEXT NOT NULL,
           media TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (bot_id, wa_user_id))`,
        `INSERT INTO latch_whatsapp_pending VALUES ('w1','35841','Bo','hello',NULL,${Date.now()})`,
        `CREATE TABLE latch_whatsapp_delivery (key TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)`,
        `CREATE TABLE latch_slack_identity (team_id TEXT NOT NULL, slack_user_id TEXT NOT NULL, user_id TEXT NOT NULL,
           org_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (team_id, slack_user_id))`,
        `INSERT INTO latch_slack_identity VALUES ('T1','U1','u1','org1',1)`,
        `CREATE TABLE latch_slack_pending2 (app_id TEXT NOT NULL, team_id TEXT NOT NULL, slack_user_id TEXT NOT NULL, channel TEXT NOT NULL,
           thread_root TEXT NOT NULL, prompt TEXT NOT NULL, anchor_ts TEXT, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
           PRIMARY KEY (app_id, team_id, slack_user_id))`,
        `INSERT INTO latch_slack_pending2 VALUES ('A1','T1','U2','C1','1.0','held','1.5',${Date.now() + 600_000},1)`,
        `CREATE TABLE latch_slack_dedupe (key TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)`,
        `INSERT INTO latch_slack_dedupe VALUES ('A1:evt:E1', ${Date.now() + 600_000})`,
        `CREATE TABLE latch_slack_event (event_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)`,
        `CREATE TABLE latch_slack_pending (team_id TEXT, slack_user_id TEXT, app_id TEXT, channel TEXT, thread_root TEXT, prompt TEXT, created_at INTEGER)`,
      ],
      "write",
    );
  }

  async function tables(c: Client): Promise<string[]> {
    const res = await c.execute(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'latch_%' ORDER BY name`);
    return res.rows.map((r) => String(r.name));
  }

  it("copies every legacy table into the shared schema, drops it, and is idempotent", async () => {
    const c = createClient({ url: ":memory:" });
    await seedLegacy(c);
    await migrateChannels(c);
    const s = createChannelStore(c);

    expect(await s.getBot("telegram", "b1")).toMatchObject({
      agent: "support",
      agentScope: "org",
      externalHandle: "acme_bot",
      webhookRegisteredAt: 123,
    });
    expect(await s.getBot("whatsapp", "w1")).toMatchObject({ externalHandle: "555000" });
    expect(await s.resolveIdentity("telegram", "b1", "5")).toEqual({ userId: "u1", orgId: "org1" });
    expect(await s.resolveIdentity("whatsapp", "w1", "35840")).toEqual({ userId: "u1", orgId: "org1" });
    expect(await s.resolveIdentity("slack", "T1", "U1")).toEqual({ userId: "u1", orgId: "org1" });
    expect(await s.takePending("telegram", "b1", "7")).toEqual({
      telegramChatId: "7",
      username: "bo",
      text: "do the thing",
      media: [{ name: "a.png" }],
    });
    expect(await s.takePending("whatsapp", "w1", "35841")).toEqual({ profileName: "Bo", text: "hello", media: null });
    expect(await s.takePending("slack", "A1", "T1:U2")).toEqual({
      channel: "C1",
      threadRoot: "1.0",
      anchorTs: "1.5",
      prompt: "held",
    });
    // Dedupe keys carry the kind prefix the new callers use.
    expect(await s.seen("telegram", "b1:5:5:1")).toBe(true);
    expect(await s.claimOnce("slack:A1:evt:E1", 60_000)).toBe(false);

    const after = await tables(c);
    expect(after.filter((t) => /latch_(telegram|whatsapp)_/.test(t))).toEqual([]);
    expect(after.filter((t) => /latch_slack_(identity|pending|pending2|dedupe|event)$/.test(t))).toEqual([]);

    await migrateChannels(c); // second boot: nothing to carry, nothing breaks
    expect(await tables(c)).toEqual(after);
    c.close();
  });
});
