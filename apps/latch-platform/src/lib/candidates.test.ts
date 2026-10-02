import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LanguageModel } from "ai";
import { createSqliteAgentBuilderStore, migrate } from "@intentface/latch-drizzle";
import { agentOwnerSegments } from "./agent-store";
import type { AgentRecord, AgentStore } from "./agent-store";
import type { Principal } from "./session";

const ME: Principal = { orgId: "org1", userId: "me" };
const COLLEAGUE: Principal = { orgId: "org1", userId: "colleague" };
let store: AgentStore;

// The composition root pulls in every agent and connection; these need only the store.
vi.mock("./latch", () => ({
  getLatch: async () => ({ agentStore: store, models: [{ id: "m" }, { id: "m2" }], authoredTools: { listFor: async () => [] } }),
}));
const { adoptLegacyDraft, applyChange, changeTitle, publishRecord, resolveLabel, titleOf, uniqueTitle } = await import("./candidates");

const rec = (over: Partial<AgentRecord> = {}): AgentRecord => ({ name: "helper", modelId: "m", instructions: "be helpful", connections: [], scope: "org", ...over });

beforeEach(async () => {
  const client = createClient({ url: ":memory:" });
  await migrate(client);
  store = createSqliteAgentBuilderStore<Principal>(drizzle(client), {
    owner: agentOwnerSegments,
    modelFor: (() => ({})) as unknown as (id: string) => LanguageModel,
  });
  await store.upsert(ME, rec());
});

describe("titles", () => {
  it("say what one change does", () => {
    expect(changeTitle("live", { model: "claude-haiku-4-5" })).toBe("live · haiku-4-5");
    expect(changeTitle("@3", { effort: "high" })).toBe("@3 · high effort");
    expect(changeTitle("live", { addInstructions: "Sourcing rules: cite pages" })).toBe("live + sourcing rules");
  });

  it("never repeat an open candidate's", () => {
    const open = [{ id: "c_a", title: "Draft" }, { id: "c_b", title: "draft 2" }];
    expect(uniqueTitle("Draft", open)).toBe("Draft 3");
    expect(uniqueTitle("Draft", open, "c_a")).toBe("Draft");
  });

  it("show a candidate's name, and anything else as it is", () => {
    const c = { id: "c_x" as const, title: "Terse", record: rec(), createdAt: 0, updatedAt: 0 };
    expect(titleOf("@c_x", [c])).toBe("Terse");
    expect(titleOf("@3", [c])).toBe("@3");
  });

  it("apply one change and nothing else", () => {
    expect(applyChange(rec(), { addInstructions: " Be brief. " }).instructions).toBe("be helpful\n\nBe brief.");
    expect(applyChange(rec(), { model: "m2" })).toEqual({ ...rec(), modelId: "m2" });
  });
});

describe("resolveLabel", () => {
  it("files live under the version it is, so the column never moves", async () => {
    expect((await resolveLabel(ME, "helper", "live")).label).toBe("@1");
    await store.upsert(ME, rec({ instructions: "v2" }));
    const now = await resolveLabel(ME, "helper", "live");
    expect([now.label, now.record.instructions]).toEqual(["@2", "v2"]);
    expect((await resolveLabel(ME, "helper", "@1")).record.instructions).toBe("be helpful");
  });

  it("finds a candidate by id or by title, and a teammate's too", async () => {
    const c = await store.saveCandidate(ME, "helper", "org", { title: "Terse", record: rec({ instructions: "short" }) });
    expect((await resolveLabel(COLLEAGUE, "helper", `@${c.id}`)).record.instructions).toBe("short");
    expect((await resolveLabel(COLLEAGUE, "helper", "terse")).label).toBe(`@${c.id}`);
  });

  it("refuses what does not exist, and the old @draft", async () => {
    await expect(resolveLabel(ME, "helper", "@9")).rejects.toThrow(/does not exist/);
    await expect(resolveLabel(ME, "helper", "nope")).rejects.toThrow(/not a version or candidate/);
    await expect(resolveLabel(ME, "helper", "@draft")).rejects.toThrow(/candidates now/);
  });
});

describe("publishRecord", () => {
  it("publishes a candidate as the next version and closes it, saying what it became", async () => {
    const c = await store.saveCandidate(ME, "helper", "org", { title: "Terse", record: rec({ instructions: "short" }), baseVersion: 1 });
    const r = await publishRecord(ME, { record: c.record, baseVersion: 1, candidateId: c.id });
    expect(r).toEqual({ ok: true, version: 2 });
    expect((await store.getRecord(ME, "helper"))?.instructions).toBe("short");
    expect((await store.getCandidate(ME, "helper", "org", c.id))?.publishedAs).toBe(2);
    expect(await store.listCandidates(ME, "helper", "org")).toHaveLength(0);
  });

  it("refuses once when someone published after the candidate was started", async () => {
    const c = await store.saveCandidate(ME, "helper", "org", { title: "Terse", record: rec({ instructions: "short" }), baseVersion: 1 });
    await store.upsert(COLLEAGUE, rec({ instructions: "theirs" }));
    const r = await publishRecord(ME, { record: c.record, baseVersion: 1, candidateId: c.id });
    expect(r).toMatchObject({ ok: false, stale: true, liveVersion: 2, baseVersion: 1 });
    expect((await store.getCandidate(ME, "helper", "org", c.id))?.closedAt).toBeUndefined();
    expect(await publishRecord(ME, { record: c.record, baseVersion: 1, candidateId: c.id, force: true })).toEqual({ ok: true, version: 3 });
  });
});

describe("adoptLegacyDraft", () => {
  it("turns the per-person draft into a candidate called Draft, once", async () => {
    await store.saveDraft(ME, "helper", "org", rec({ instructions: "half-written" }), 1);
    const c = await adoptLegacyDraft(ME, "helper", "org");
    expect(c).toMatchObject({ title: "Draft", baseVersion: 1 });
    expect(c?.record.instructions).toBe("half-written");
    expect(await store.getDraft(ME, "helper", "org")).toBeUndefined();
    expect(await adoptLegacyDraft(ME, "helper", "org")).toBeNull();
  });
});
