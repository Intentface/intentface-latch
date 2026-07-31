import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The trace-list calls the reader made, in order, so a test can assert WHICH
 * queries were issued (one per agent-owner tag, plus the caller's own userId).
 */
const calls: Record<string, unknown>[] = [];
let tracePages: Record<string, unknown[]>;
let scoreRows: unknown[];
/** When set, the trace-list call matching this filter key rejects. */
let failFor: string | undefined;

vi.mock("./client.js", () => ({
  getLangfuseClient: () => ({
    api: {
      trace: {
        list: async (params: Record<string, unknown>) => {
          calls.push(params);
          // Key the canned page by the filter this call used.
          const tags = params.tags as string[] | undefined;
          const key = tags?.[0] ?? `user:${String(params.userId)}`;
          if (failFor && key === failFor) throw new Error("langfuse unavailable");
          return { data: tracePages[key] ?? [] };
        },
      },
      scoresV3: {
        getManyV3: async () => ({ data: scoreRows, meta: {} }),
      },
    },
  }),
}));

const { AGENT_OWNER_TAG, listAdministeredTraces } = await import("./reads.js");

const trace = (id: string, at: string, over: Record<string, unknown> = {}) => ({
  id,
  name: "my-agent",
  timestamp: at,
  tags: [`run:run-${id}`, `agent:my-agent`],
  ...over,
});

describe("listAdministeredTraces", () => {
  beforeEach(() => {
    calls.length = 0;
    tracePages = {};
    scoreRows = [];
    failFor = undefined;
  });

  it("queries once per agent-owner key, plus the reader's own runs", async () => {
    await listAdministeredTraces({
      agentOwnerTags: ["org/me", "org"],
      ownerTag: "org/me",
      limit: 10,
    });
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({ tags: [`${AGENT_OWNER_TAG}org/me`] });
    expect(calls[1]).toMatchObject({ tags: [`${AGENT_OWNER_TAG}org`] });
    expect(calls[2]).toMatchObject({ userId: "org/me" });
  });

  it("collapses duplicate owner keys into one query", async () => {
    // An org-only principal's personal and org keys are the same string.
    await listAdministeredTraces({
      agentOwnerTags: ["org", "org", ""],
      ownerTag: "org",
    });
    expect(calls).toHaveLength(2); // one tag query + the userId query
  });

  it("surfaces another user's run on an agent I administer", async () => {
    tracePages[`${AGENT_OWNER_TAG}org`] = [
      trace("t1", "2026-07-31T10:00:00Z", {
        userId: "org/colleague",
        tags: ["run:run-t1", "agent:my-agent", `${AGENT_OWNER_TAG}org`],
      }),
    ];
    const rows = await listAdministeredTraces({
      agentOwnerTags: ["org"],
      ownerTag: "org/me",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runId: "run-t1",
      userId: "org/colleague", // attribution: who ran it
      agentOwner: "org", // whose agent it was
    });
  });

  it("de-duplicates a trace returned by more than one source", async () => {
    const t = trace("t1", "2026-07-31T10:00:00Z", { userId: "org/me" });
    tracePages[`${AGENT_OWNER_TAG}org`] = [t];
    tracePages["user:org/me"] = [t];
    const rows = await listAdministeredTraces({
      agentOwnerTags: ["org"],
      ownerTag: "org/me",
    });
    expect(rows.map((r) => r.id)).toEqual(["t1"]);
  });

  it("re-sorts across sources and caps at the limit", async () => {
    // Each source is newest-first on its own; the union must be too, or the cap
    // would keep whichever query a row happened to come from.
    tracePages[`${AGENT_OWNER_TAG}org`] = [
      trace("old", "2026-07-01T00:00:00Z"),
      trace("oldest", "2026-06-01T00:00:00Z"),
    ];
    tracePages["user:org/me"] = [trace("newest", "2026-07-31T00:00:00Z")];
    const rows = await listAdministeredTraces({
      agentOwnerTags: ["org"],
      ownerTag: "org/me",
      limit: 2,
    });
    expect(rows.map((r) => r.id)).toEqual(["newest", "old"]);
  });

  it("joins scores in and normalizes booleans to numbers", async () => {
    tracePages[`${AGENT_OWNER_TAG}org`] = [trace("t1", "2026-07-31T10:00:00Z")];
    scoreRows = [
      { name: "greets", value: true, subject: { kind: "trace", id: "t1" }, dataType: "BOOLEAN" },
      { name: "user-feedback", value: 1, subject: { kind: "trace", id: "t1" } },
      { name: "ignored", value: 1, subject: { kind: "observation", id: "t1" } },
    ];
    const rows = await listAdministeredTraces({
      agentOwnerTags: ["org"],
      ownerTag: "org/me",
    });
    expect(rows[0].scores).toEqual([
      { name: "greets", value: 1, comment: undefined, dataType: "BOOLEAN" },
      { name: "user-feedback", value: 1, comment: undefined, dataType: undefined },
    ]);
  });

  it("degrades to the surviving sources when one query fails", async () => {
    tracePages["user:org/me"] = [trace("mine", "2026-07-31T10:00:00Z", { userId: "org/me" })];
    // The tag query throws; the reader's own runs must still render.
    failFor = `${AGENT_OWNER_TAG}org`;
    const rows = await listAdministeredTraces({
      agentOwnerTags: ["org"],
      ownerTag: "org/me",
    });
    expect(rows.map((r) => r.id)).toEqual(["mine"]);
  });

  it("passes the agent filter to every source", async () => {
    await listAdministeredTraces({
      agentOwnerTags: ["org"],
      ownerTag: "org/me",
      agent: "my-agent",
    });
    for (const c of calls) expect(c).toMatchObject({ name: "my-agent" });
  });
});
