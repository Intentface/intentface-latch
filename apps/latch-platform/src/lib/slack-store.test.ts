import type { Client } from "@libsql/client";
import type { SlackStore } from "./slack-store";
import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSlackStore, migrateSlack } from "./slack-store";

let client: Client;
let store: SlackStore;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await migrateSlack(client);
  store = createSlackStore(client);
});

afterEach(() => {
  client.close();
});

const app = { appId: "A1", agent: "support", orgId: "org1", userId: "u1" };

describe("slack store: app bindings", () => {
  it("binds, resolves and lists per org", async () => {
    expect(await store.bind(app)).toBe(true);
    expect(await store.resolve("A1")).toMatchObject(app);
    expect(await store.listForOrg("org1")).toHaveLength(1);
    expect(await store.listForOrg("other")).toHaveLength(0);
  });

  it("round-trips the pinned agent scope", async () => {
    await store.bind({ ...app, agentScope: "user" });
    expect((await store.resolve("A1"))!.agentScope).toBe("user");
    // Unpinned (code-registry agent) stays undefined rather than becoming "null".
    await store.bind({ ...app, appId: "A2" });
    expect((await store.resolve("A2"))!.agentScope).toBeUndefined();
  });

  it("refuses to rebind an app id owned by another org", async () => {
    await store.bind(app);
    // An `api_app_id` is visible to every member of the hosting Slack workspace,
    // so claiming one must not transfer the binding.
    expect(await store.bind({ ...app, orgId: "attacker", userId: "evil" })).toBe(false);
    expect(await store.resolve("A1")).toMatchObject({ orgId: "org1", userId: "u1" });
  });

  it("allows the owning org to rebind (agent change, OAuth team capture)", async () => {
    await store.bind(app);
    expect(await store.bind({ ...app, agent: "sales", teamId: "T1" })).toBe(true);
    expect(await store.resolve("A1")).toMatchObject({
      agent: "sales",
      teamId: "T1",
      orgId: "org1",
    });
  });

  it("unbind is scoped to the owning org", async () => {
    await store.bind(app);
    await store.unbind("A1", "attacker");
    expect(await store.resolve("A1")).not.toBeNull();
    await store.unbind("A1", "org1");
    expect(await store.resolve("A1")).toBeNull();
  });
});

describe("slack store: identities", () => {
  it("records the linking user's org so the channel can match it", async () => {
    await store.linkIdentity({ teamId: "T1", slackUserId: "U1", userId: "u1", orgId: "org1" });
    expect(await store.resolveIdentity("T1", "U1")).toEqual({ userId: "u1", orgId: "org1" });
    expect(await store.resolveIdentity("T1", "U2")).toBeNull();
  });
});

describe("slack store: claimOnce", () => {
  it("claims a key exactly once within its TTL", async () => {
    expect(await store.claimOnce("A1:evt:E1", 60_000)).toBe(true);
    expect(await store.claimOnce("A1:evt:E1", 60_000)).toBe(false);
  });

  it("keeps key kinds and apps from colliding", async () => {
    expect(await store.claimOnce("A1:evt:X", 60_000)).toBe(true);
    expect(await store.claimOnce("A1:act:X", 60_000)).toBe(true);
    expect(await store.claimOnce("A2:evt:X", 60_000)).toBe(true);
  });

  it("reclaims an expired key (TTL pruning)", async () => {
    expect(await store.claimOnce("A1:evt:E2", -1)).toBe(true); // already expired
    expect(await store.claimOnce("A1:evt:E2", 60_000)).toBe(true);
  });
});

describe("slack store: turn lease", () => {
  it("grants one lease per chat and fences the release on the token", async () => {
    const t1 = await store.claimTurn("slack2_A1_C1_1.0");
    expect(t1).not.toBeNull();
    expect(await store.claimTurn("slack2_A1_C1_1.0")).toBeNull();
    await store.releaseTurn("slack2_A1_C1_1.0", "wrong-token");
    expect(await store.claimTurn("slack2_A1_C1_1.0")).toBeNull(); // still held
    await store.releaseTurn("slack2_A1_C1_1.0", t1!);
    expect(await store.claimTurn("slack2_A1_C1_1.0")).not.toBeNull();
  });
});

describe("slack store: thread ownership", () => {
  it("first writer wins; later claims return the owning row", async () => {
    const first = await store.claimThread({
      chatId: "slack2_A1_C1_1.0",
      appId: "A1",
      initiatorSlackUserId: "UA",
    });
    expect(first.initiatorSlackUserId).toBe("UA");
    const second = await store.claimThread({
      chatId: "slack2_A1_C1_1.0",
      appId: "A1",
      initiatorSlackUserId: "UB",
    });
    expect(second.initiatorSlackUserId).toBe("UA");
  });

  it("records and reads back the stop flag relative to a turn start", async () => {
    await store.claimThread({
      chatId: "slack2_A1_D1_dm",
      appId: "A1",
      initiatorSlackUserId: "UA",
    });
    const turnStart = Date.now() - 1;
    expect(await store.threadStoppedSince("slack2_A1_D1_dm", turnStart)).toBe(false);
    await store.markThreadStopped("slack2_A1_D1_dm");
    expect(await store.threadStoppedSince("slack2_A1_D1_dm", turnStart)).toBe(true);
    // An old stop never cancels a NEW turn.
    expect(await store.threadStoppedSince("slack2_A1_D1_dm", Date.now() + 1000)).toBe(false);
  });
});

describe("slack store: pending replays (app-keyed)", () => {
  const pending = (appId: string) => ({
    appId,
    teamId: "T1",
    slackUserId: "U1",
    channel: "C1",
    threadRoot: "1.0",
    prompt: `held for ${appId}`,
  });

  it("holds one pending message PER APP for the same Slack user", async () => {
    await store.setPending(pending("A1"));
    await store.setPending(pending("A2"));
    expect((await store.takePending("A1", "T1", "U1"))?.prompt).toBe("held for A1");
    expect((await store.takePending("A2", "T1", "U1"))?.prompt).toBe("held for A2");
  });

  it("replays once", async () => {
    await store.setPending(pending("A1"));
    expect(await store.takePending("A1", "T1", "U1")).not.toBeNull();
    expect(await store.takePending("A1", "T1", "U1")).toBeNull();
  });
});

describe("slack store: lifecycle & health", () => {
  it("disables and revives a binding", async () => {
    await store.bind({ ...app, teamId: "T1" });
    await store.setStatus("A1", "disabled", "app_uninstalled");
    expect(await store.resolve("A1")).toMatchObject({
      status: "disabled",
      disabledReason: "app_uninstalled",
    });
    await store.setStatus("A1", "active");
    expect((await store.resolve("A1"))!.status).toBe("active");
  });

  it("round-trips manifest version and the unattended allowlist (org-scoped)", async () => {
    await store.bind(app);
    await store.setManifestVersion("A1", "attacker", 2);
    expect((await store.resolve("A1"))!.manifestVersion).toBeUndefined();
    await store.setManifestVersion("A1", "org1", 2);
    expect((await store.resolve("A1"))!.manifestVersion).toBe(2);
    await store.setUnattendedChannels("A1", "org1", ["C9"]);
    expect((await store.resolve("A1"))!.unattendedChannels).toEqual(["C9"]);
  });

  it("reverse-resolves a Latch user's Slack identity in a workspace", async () => {
    await store.linkIdentity({ teamId: "T1", slackUserId: "U7", userId: "u7", orgId: "org1" });
    expect(await store.slackUserFor("T1", "u7")).toBe("U7");
    expect(await store.slackUserFor("T2", "u7")).toBeNull();
  });

  it("migrate + prune run twice without error", async () => {
    await migrateSlack(client);
    await store.pruneExpired();
    await store.pruneExpired();
  });
});
