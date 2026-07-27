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

describe("slack store: event dedupe", () => {
  it("reports a repeat delivery of the same event id", async () => {
    expect(await store.seen("E1")).toBe(false);
    expect(await store.seen("E1")).toBe(true);
  });
});
