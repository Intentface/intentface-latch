import { createClient } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import type { LanguageModel } from "ai";
import { createAgentStore, evalOwnerKeysOf, migrateAgents } from "./agent-store";
import type { AgentRecord, AgentStore } from "./agent-store";
import type { Principal } from "./session";

const ME: Principal = { orgId: "org1", userId: "me" };
const COLLEAGUE: Principal = { orgId: "org1", userId: "colleague" };
const OUTSIDER: Principal = { orgId: "org2", userId: "outsider" };

const record = (name: string, scope: "org" | "user"): AgentRecord => ({
  name,
  modelId: "m",
  instructions: "do things",
  connections: [],
  scope,
});

describe("evalOwnerKeysOf", () => {
  it("is the personal key then the org key", () => {
    expect(evalOwnerKeysOf(ME)).toEqual(["org1/me", "org1"]);
  });

  it("covers the org-only principal's tag (no user segment)", () => {
    // ownerTagOf({orgId}) is "org1"; the key list must still contain it, or a
    // system/cron run's verdicts would be unreadable.
    expect(evalOwnerKeysOf({ orgId: "org1" })).toContain("org1");
  });

  it("URL-encodes each segment so a '/' in an id can't forge another key", () => {
    expect(evalOwnerKeysOf({ orgId: "a/b", userId: "c" })).toEqual(["a%2Fb/c", "a%2Fb"]);
  });
});

describe("agent store ownership + scope-pinned lookup (in-memory libsql)", () => {
  let store: AgentStore;

  beforeEach(async () => {
    const client = createClient({ url: ":memory:" });
    await migrateAgents(client);
    store = createAgentStore(client, (() => ({})) as unknown as (id: string) => LanguageModel);
  });

  it("reports the row's owner, which is the eval-visibility boundary", async () => {
    await store.upsert(ME, record("shared", "org"));
    await store.upsert(ME, record("mine", "user"));
    expect((await store.getRecord(ME, "shared"))?.owner).toBe("org1");
    expect((await store.getRecord(ME, "mine"))?.owner).toBe("org1/me");
  });

  it("ignores a record's read-only owner on write", async () => {
    // A caller round-tripping a record (getRecord → upsert) must not be able to
    // re-home the agent by echoing back the owner field.
    await store.upsert(ME, { ...record("mine", "user"), owner: "org1" });
    expect((await store.getRecord(ME, "mine"))?.owner).toBe("org1/me");
    expect(await store.getRecord(COLLEAGUE, "mine")).toBeUndefined();
  });

  it("resolves a channel's scope-pinned ref, so the online judge finds its rubrics", async () => {
    // latch_runs.agent keeps the `org:`/`user:` pin a channel binding was created
    // with; getRecord must parse it exactly as resolve() does.
    await store.upsert(ME, record("helper", "org"));
    expect((await store.getRecord(ME, "org:helper"))?.owner).toBe("org1");
    expect(await store.getRecord(ME, "user:helper")).toBeUndefined();
  });

  it("a pin cannot be shadowed by a same-named personal agent", async () => {
    await store.upsert(ME, record("helper", "org"));
    await store.upsert(ME, record("helper", "user"));
    // Unpinned: personal wins. Pinned to org: the org record, whatever else exists.
    expect((await store.getRecord(ME, "helper"))?.owner).toBe("org1/me");
    expect((await store.getRecord(ME, "org:helper"))?.owner).toBe("org1");
  });

  it("a colleague sees the org agent; an outsider sees nothing", async () => {
    await store.upsert(ME, record("shared", "org"));
    expect((await store.getRecord(COLLEAGUE, "shared"))?.owner).toBe("org1");
    expect(await store.getRecord(OUTSIDER, "shared")).toBeUndefined();
  });
});
