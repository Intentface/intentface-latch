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

  it("migrate runs twice without error", async () => {
    await migrateSlack(client);
  });
});
