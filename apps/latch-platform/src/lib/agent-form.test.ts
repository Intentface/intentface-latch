import { describe, expect, it } from "vitest";
import {
  KNOWN_DEFAULT_TOOLS,
  SCHEDULE_TOOLS,
  coerceRecord,
  expandDefaultTools,
  groupOn,
  loadAgentRecord,
  newAgentRecord,
  toSavePayload,
  toggleGroup,
} from "./agent-form";
import type { AgentRecord } from "./agent-form";

const base: AgentRecord = { name: "helper", modelId: "m", instructions: "help", connections: [], scope: "user" };
const ctx = { modelSupportsReasoning: true, visibleAuthored: ["calc"], toolList: [] };

describe("defaultTools as an explicit list", () => {
  it("expands `true` to the known set and never includes render_fetch", () => {
    expect(expandDefaultTools(true)).toEqual(KNOWN_DEFAULT_TOOLS);
    expect(expandDefaultTools(["web_fetch", "future_tool", "render_fetch"])).toEqual(["web_fetch", "future_tool"]);
    expect(expandDefaultTools(undefined)).toEqual([]);
  });

  it("a stored partial subset reads as on and survives an untouched save byte-for-byte", () => {
    // The regression this guards: an agent granted only `list_schedules` (via
    // the API or the builder) must not be expanded to all four by a save that
    // never touched the toggle. With the list AS the state, "untouched" means
    // literally unchanged.
    const rec = loadAgentRecord({ ...base, exec: { defaultTools: ["list_schedules"] } });
    expect(groupOn(rec.exec!.defaultTools as string[], "schedules")).toBe(true);
    expect(toSavePayload(rec, ctx).exec?.defaultTools).toEqual(["list_schedules"]);
  });

  it("an explicit toggle grants the full group; off removes every member; unknown names survive", () => {
    const on = toggleGroup(["list_schedules", "future_tool"], "schedules", true);
    expect(on).toEqual(["list_schedules", "future_tool", ...SCHEDULE_TOOLS.filter((n) => n !== "list_schedules")]);
    const off = toggleGroup([...SCHEDULE_TOOLS, "web_fetch", "future_tool"], "schedules", false);
    expect(off).toEqual(["web_fetch", "future_tool"]);
    expect(toggleGroup([], "web", true)).toEqual(["web_fetch"]);
  });

  it("round-trips an unchanged full grant", () => {
    const prev = ["web_fetch", "askUser", ...SCHEDULE_TOOLS];
    const rec = loadAgentRecord({ ...base, exec: { defaultTools: prev } });
    expect(toSavePayload(rec, ctx).exec?.defaultTools).toEqual(prev);
  });

  it("nothing granted → defaultTools absent", () => {
    const rec = loadAgentRecord({ ...base, exec: { defaultTools: true } });
    let list = rec.exec!.defaultTools as string[];
    for (const g of ["web", "askUser", "schedules"] as const) list = toggleGroup(list, g, false);
    expect(toSavePayload({ ...rec, exec: { defaultTools: list } }, ctx).exec?.defaultTools).toBeUndefined();
  });
});

describe("coerceRecord", () => {
  const withMemory = (rec: Partial<AgentRecord>, memory: NonNullable<AgentRecord["exec"]>["memory"]): AgentRecord => ({
    ...base,
    ...rec,
    exec: { memory },
  });

  it("re-picks the memory connection when it leaves the agent's connections (loredex preferred)", () => {
    const rec = withMemory({ connections: ["github", "loredex"] }, { scope: "agent-user", connection: "old" });
    expect(coerceRecord(rec, ctx).exec?.memory?.connection).toBe("loredex");
    const noLoredex = withMemory({ connections: ["github"] }, { scope: "agent-user", connection: "old" });
    expect(coerceRecord(noLoredex, ctx).exec?.memory?.connection).toBe("github");
  });

  it("leaves the pick alone (for the warning) when the agent has no connections", () => {
    const rec = withMemory({ connections: [] }, { scope: "agent-user", connection: "loredex" });
    expect(coerceRecord(rec, ctx).exec?.memory?.connection).toBe("loredex");
    // …and the save payload drops memory rather than sending a dangling pick.
    expect(toSavePayload(rec, ctx).exec?.memory).toBeUndefined();
  });

  it("falls back from the org-shared level on a personal agent — primary and extraction", () => {
    const rec = withMemory(
      { connections: ["loredex"], scope: "user" },
      { scope: "agent-org", connection: "loredex", extractTo: ["agent-org", "user"] },
    );
    const out = coerceRecord(rec, ctx).exec!.memory!;
    expect(out.scope).toBe("agent-user");
    expect(out.extractTo).toEqual(["user"]);
    const org = coerceRecord({ ...rec, scope: "org" }, ctx).exec!.memory!;
    expect(org.scope).toBe("agent-org");
  });

  it("keeps the primary scope out of the extras list", () => {
    const rec = withMemory({ connections: ["loredex"] }, { scope: "user", connection: "loredex", extractTo: ["user", "agent-user"] });
    expect(coerceRecord(rec, ctx).exec?.memory?.extractTo).toEqual(["agent-user"]);
  });

  it("clears effort on a non-reasoning model and is idempotent", () => {
    const rec: AgentRecord = { ...base, exec: { effort: "high" } };
    const once = coerceRecord(rec, { modelSupportsReasoning: false });
    expect(once.exec?.effort).toBeUndefined();
    expect(coerceRecord(once, { modelSupportsReasoning: false })).toBe(once);
    expect(coerceRecord(rec, { modelSupportsReasoning: true })).toBe(rec);
  });
});

describe("loadAgentRecord ↔ toSavePayload", () => {
  it("extractTo is extras-only in the editor and canonical [primary, ...extras] on the wire", () => {
    const stored: AgentRecord = {
      ...base,
      connections: ["loredex"],
      scope: "org",
      exec: {
        memory: {
          scope: "agent-user",
          connection: "loredex",
          extractTo: ["agent-user", "agent-org"],
          schemas: { "agent-user": "## A", "agent-org": "   " },
        },
      },
    };
    const rec = loadAgentRecord(stored);
    expect(rec.exec?.memory?.extractTo).toEqual(["agent-org"]);
    const out = toSavePayload(rec, ctx).exec!.memory!;
    expect(out.extractTo).toEqual(["agent-user", "agent-org"]);
    // Blank schema dropped; schemas only for levels the agent participates in.
    expect(out.schemas).toEqual({ "agent-user": "## A" });
  });

  it("drops a schema for a level the agent no longer participates in", () => {
    const rec = loadAgentRecord({
      ...base,
      connections: ["loredex"],
      exec: { memory: { scope: "agent-user", connection: "loredex", schemas: { "agent-org": "## Org" } } },
    });
    expect(toSavePayload(rec, ctx).exec?.memory?.schemas).toBeUndefined();
  });

  it("provider only with sandbox; authored tools filtered to the visible set; false flags absent", () => {
    const rec: AgentRecord = {
      ...base,
      exec: { sandbox: false, provider: "daytona", renderTools: false, authoredTools: ["calc", "ghost"] },
    };
    const exec = toSavePayload(rec, ctx).exec!;
    expect(exec.provider).toBeUndefined();
    expect(exec.sandbox).toBeUndefined();
    expect(exec.renderTools).toBeUndefined();
    expect(exec.authoredTools).toEqual(["calc"]);
    expect(toSavePayload({ ...rec, exec: { ...rec.exec, sandbox: true } }, ctx).exec?.provider).toBe("daytona");
  });

  it("tools: all-enabled saves as [] (= all), description overrides only when they differ", () => {
    const toolList = [
      { name: "gh_search", description: "Search" },
      { name: "gh_issue", description: "Issue" },
    ];
    const rec: AgentRecord = {
      ...base,
      connections: ["gh"],
      tools: {
        enabled: ["gh_search", "gh_issue"],
        approval: { gh_issue: true },
        descriptions: { gh_search: "Search ", gh_issue: "Open an issue" },
      },
    };
    const tools = toSavePayload(rec, { ...ctx, toolList }).tools!;
    expect(tools.enabled).toEqual([]);
    expect(tools.approval).toEqual({ gh_issue: true });
    expect(tools.descriptions).toEqual({ gh_issue: "Open an issue" });
    const partial = toSavePayload({ ...rec, tools: { ...rec.tools!, enabled: ["gh_search"] } }, { ...ctx, toolList }).tools!;
    expect(partial.enabled).toEqual(["gh_search"]);
    // No listed tools → nothing to select → tools absent.
    expect(toSavePayload(rec, ctx).tools).toBeUndefined();
  });

  it("new record has sane defaults and blank labels save as absent", () => {
    const rec = { ...newAgentRecord("m-1"), title: "", description: " " };
    const out = toSavePayload(rec, ctx);
    expect(out.maxSteps).toBe(20);
    expect(out.title).toBeUndefined();
    expect(out.description).toBe(" "); // trimming is the server's normalize job
  });
});
