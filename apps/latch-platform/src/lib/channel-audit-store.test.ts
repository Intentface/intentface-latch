import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHANNEL_AUDIT_TTL_MS,
  createChannelAuditStore,
  migrateChannelAudit,
} from "./channel-audit-store";

let client: Client;
beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await migrateChannelAudit(client);
  await migrateChannelAudit(client); // idempotent
});
afterEach(() => client.close());

describe("channel audit store", () => {
  it("round-trips a decision with its optional fields and meta", async () => {
    let t = 1_000;
    const store = createChannelAuditStore(client, { now: () => t });
    await store.record({
      channel: "slack",
      action: "trigger",
      decision: "deny",
      reason: "external_workspace",
      orgId: "o1",
      agent: "support",
      appId: "A1",
      teamId: "T_OTHER",
      externalChannelId: "C1",
      externalUserId: "UX",
      meta: { tool: "x" },
    });
    t = 2_000;
    await store.record({ channel: "slack", action: "tool_call", decision: "allow", appId: "A1", chatId: "slack2_A1_C1_1.0" });

    const rows = await store.list({ appId: "A1" });
    expect(rows.map((r) => [r.ts, r.action, r.decision])).toEqual([
      [2_000, "tool_call", "allow"],
      [1_000, "trigger", "deny"],
    ]);
    expect(rows[1]).toMatchObject({
      reason: "external_workspace",
      orgId: "o1",
      agent: "support",
      teamId: "T_OTHER",
      externalChannelId: "C1",
      externalUserId: "UX",
      meta: { tool: "x" },
      expiresAt: 1_000 + CHANNEL_AUDIT_TTL_MS,
    });
    expect(rows[1]!.userId).toBeUndefined();
    expect(await store.list({ chatId: "slack2_A1_C1_1.0" })).toHaveLength(1);
  });

  it("sweeps expired rows on write", async () => {
    let t = 0;
    const store = createChannelAuditStore(client, { now: () => t, ttlMs: 100 });
    await store.record({ channel: "slack", action: "trigger", decision: "allow", appId: "A1" });
    t = 50;
    await store.record({ channel: "slack", action: "resume", decision: "allow", appId: "A1" });
    expect(await store.list({ appId: "A1" })).toHaveLength(2);
    t = 101; // first row expired (0 + 100 < 101)
    await store.record({ channel: "slack", action: "resume", decision: "allow", appId: "A1" });
    const rows = await store.list({ appId: "A1" });
    expect(rows.map((r) => r.ts)).toEqual([101, 50]);
  });

  it("never reads back an expired row, swept or not", async () => {
    let t = 0;
    const store = createChannelAuditStore(client, { now: () => t, ttlMs: 100 });
    await store.record({ channel: "slack", action: "trigger", decision: "allow", appId: "A1" });
    t = 101;
    expect(await store.list({ appId: "A1" })).toEqual([]);
    // Still on disk (nothing wrote since) — the read, not the sweep, hid it.
    const raw = await client.execute("SELECT COUNT(*) AS n FROM latch_channel_audit");
    expect(Number((raw.rows[0] as Record<string, unknown>).n)).toBe(1);
  });

  it("prunes expired rows on the cron path, with no audit traffic at all", async () => {
    let t = 0;
    const store = createChannelAuditStore(client, { now: () => t, ttlMs: 100 });
    await store.record({ channel: "slack", action: "trigger", decision: "allow", appId: "A1" });
    t = 50;
    await store.record({ channel: "slack", action: "resume", decision: "allow", appId: "A1" });
    t = 101; // the first row is past its TTL; the second is not
    await store.pruneExpired();
    const raw = await client.execute("SELECT ts FROM latch_channel_audit ORDER BY ts");
    expect(raw.rows.map((r) => Number((r as Record<string, unknown>).ts))).toEqual([50]);
  });
});
