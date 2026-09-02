import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { beforeEach, describe, expect, it } from "vitest";
import type { LanguageModel } from "ai";
import { createSqliteAgentBuilderStore, migrate } from "@intentface/latch-drizzle";
import { agentOwnerSegments, evalOwnerKeysOf, evalOwnerOfRecord, rubricsOf } from "./agent-store";
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

  it("always contains the principal's own owner tag", () => {
    // `scoreReadKeys` appends ownerTagOf(p) so pre-split rows stay readable. That
    // append is redundant precisely because of this invariant — if a change to
    // either derivation breaks it, the two would diverge and scores written under
    // one would silently vanish from reads keyed on the other. `ownerTagOf` is
    // re-derived here rather than imported: importing it pulls in the composition
    // root (agents, connections, model catalog).
    const ownerTagOf = (p: Principal) =>
      (p.userId ? [p.orgId, p.userId] : [p.orgId]).map(encodeURIComponent).join("/");
    for (const p of [
      { orgId: "org1", userId: "me" },
      { orgId: "org1" },
      { orgId: "org1", userId: "" }, // falsy but non-nullish: the two differ here
      { orgId: "user:abc", userId: "abc" }, // the org-less session shape
      { orgId: "a/b", userId: "c" },
    ] satisfies Principal[]) {
      expect(evalOwnerKeysOf(p)).toContain(ownerTagOf(p));
    }
  });
});

describe("rubricsOf", () => {
  it("narrows a stored record's rubrics and tolerates absence", () => {
    expect(rubricsOf(undefined)).toEqual([]);
    expect(rubricsOf({ attachedEvals: undefined })).toEqual([]);
    const rubric = { name: "a", prompt: "p", scale: "binary" as const, enabled: true };
    expect(rubricsOf({ attachedEvals: [rubric] })).toEqual([rubric]);
  });
});

describe("agent store ownership + scope-pinned lookup (drizzle store, in-memory libsql)", () => {
  // The platform hands the framework store ITS owner policy; these tests pin
  // that `evalOwnerOfRecord` (derived) and the store's real owner column agree.
  let store: AgentStore;

  beforeEach(async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    store = createSqliteAgentBuilderStore<Principal>(drizzle(client), {
      owner: agentOwnerSegments,
      modelFor: (() => ({})) as unknown as (id: string) => LanguageModel,
    });
  });

  /** The eval owner of the record `ref` resolves to for `p`. */
  const ownerOf = async (p: Principal, ref: string) => {
    const rec = await store.getRecord(p, ref);
    return rec ? evalOwnerOfRecord(p, rec) : undefined;
  };

  it("derives the eval owner from the caller + the record's scope", async () => {
    await store.upsert(ME, record("shared", "org"));
    await store.upsert(ME, record("mine", "user"));
    expect(await ownerOf(ME, "shared")).toBe("org1");
    expect(await ownerOf(ME, "mine")).toBe("org1/me");
  });

  it("keeps the owner key off the record itself", async () => {
    // AgentRecord is handed wholesale to the model (get_agent) and to the browser
    // (listAgentRecordsFn), so the internal owner key must not ride along.
    await store.upsert(ME, record("mine", "user"));
    const rec = await store.getRecord(ME, "mine");
    expect(rec).not.toHaveProperty("owner");
  });

  it("a colleague deriving the same org agent gets the same key", async () => {
    // The derivation must be caller-independent for org scope — otherwise two
    // members would file verdicts under different keys for one shared agent.
    await store.upsert(ME, record("shared", "org"));
    expect(await ownerOf(COLLEAGUE, "shared")).toBe(await ownerOf(ME, "shared"));
  });

  it("resolves a channel's scope-pinned ref, so the online judge finds its rubrics", async () => {
    // latch_runs.agent keeps the `org:`/`user:` pin a channel binding was created
    // with; getRecord must parse it exactly as resolve() does.
    await store.upsert(ME, record("helper", "org"));
    expect(await ownerOf(ME, "org:helper")).toBe("org1");
    expect(await store.getRecord(ME, "user:helper")).toBeUndefined();
  });

  it("a pin cannot be shadowed by a same-named personal agent", async () => {
    await store.upsert(ME, record("helper", "org"));
    await store.upsert(ME, record("helper", "user"));
    // Unpinned: personal wins. Pinned to org: the org record, whatever else exists.
    expect(await ownerOf(ME, "helper")).toBe("org1/me");
    expect(await ownerOf(ME, "org:helper")).toBe("org1");
  });

  it("a colleague sees the org agent; an outsider sees nothing", async () => {
    await store.upsert(ME, record("shared", "org"));
    expect(await ownerOf(COLLEAGUE, "shared")).toBe("org1");
    expect(await store.getRecord(OUTSIDER, "shared")).toBeUndefined();
  });

  it("round-trips exec.memory and attached evals, and lists memory-enabled names", async () => {
    await store.upsert(ME, {
      ...record("coach", "user"),
      connections: ["loredex"],
      exec: { memory: { scope: "agent-user", connection: "loredex" } },
      attachedEvals: [{ name: "on-topic", prompt: "Stays on topic.", scale: "binary", enabled: true }],
    });
    const rec = await store.getRecord(ME, "coach");
    expect(rec?.exec?.memory?.connection).toBe("loredex");
    expect(rubricsOf(rec)[0]?.name).toBe("on-topic");
    expect(await store.listMemoryEnabledNames()).toEqual(["coach"]);
  });
});
