import { describe, expect, it, vi } from "vitest";
import { createAgentBuilder } from "./agent-builder";
import type { AgentBuilderDeps } from "./agent-builder";
import type { AgentBuilderExtension } from "./extension";
import { normalizeAgentName } from "./store";
import type { AgentRecord } from "./store";

type P = { orgId: string; userId: string };
const principal: P = { orgId: "org1", userId: "u1" };

/** In-memory store + stub host services, enough to drive the toolset. */
function makeDeps(): AgentBuilderDeps<P> & { records: AgentRecord[] } {
  const records: AgentRecord[] = [];
  return {
    records,
    runtime: {
      listAgents: vi.fn(async () => [{ name: "assistant" }, ...records.map((r) => ({ name: r.name }))]),
      listChats: vi.fn(async () => []),
      loadHistory: vi.fn(async () => []),
      runAgent: vi.fn(async () => ({ threadId: "sub_1", answer: "hi" })),
    },
    store: {
      resolve: async () => undefined,
      list: async () => records.map((r) => ({ name: r.name })),
      listRecords: async () => records,
      upsert: async (_p, rec) => {
        const i = records.findIndex((r) => r.name === rec.name && r.scope === rec.scope);
        if (i >= 0) records[i] = rec;
        else records.push(rec);
      },
      remove: async (_p, scope, name) => {
        const i = records.findIndex((r) => r.name === name && r.scope === scope);
        if (i >= 0) records.splice(i, 1);
      },
    },
    models: [{ id: "m-1", label: "Model One", provider: "anthropic", reasoning: true }],
    listConnections: async () => [{ name: "github", kind: "mcp", authorized: true }],
    connectionTools: async () => [{ name: "github_search", description: "search" }],
  };
}

const model = { modelId: "test" } as never;

async function openTools(
  deps: AgentBuilderDeps<P>,
  extensions?: AgentBuilderExtension<P>[],
  reservedNames?: string[],
) {
  const factory = createAgentBuilder<P>({
    model,
    deps: async () => deps,
    reservedNames: reservedNames ?? ["assistant", "agent-builder"],
    extensions,
  });
  const cfg = await factory({ runtime: undefined, principal });
  const opened = await cfg.toolSources![0]!.open(principal);
  return { cfg, tools: opened.tools as Record<string, { execute: (input: unknown, opts?: unknown) => Promise<unknown> }> };
}

const SAVE = {
  name: "My Agent",
  modelId: "m-1",
  instructions: "be helpful",
  scope: "user" as const,
};

describe("normalizeAgentName", () => {
  it("kebab-cases and strips edges", () => {
    expect(normalizeAgentName(" My Agent! ")).toBe("my-agent");
    expect(normalizeAgentName("--x_y--")).toBe("x_y");
  });
});

describe("builder with zero extensions", () => {
  it("has the core toolset and none of the extension tools", async () => {
    const { tools } = await openTools(makeDeps());
    expect(Object.keys(tools).sort()).toEqual(
      [
        "delete_agent",
        "get_agent",
        "list_agents",
        "list_chats",
        "list_connection_tools",
        "list_connections",
        "list_models",
        "read_chat",
        "save_agent",
        "test_agent",
      ].sort(),
    );
  });

  it("mentions no evals / tool authoring in the prompt and declares no subagents", async () => {
    const { cfg } = await openTools(makeDeps());
    expect(cfg.instructions).not.toMatch(/EVALS|eval-author|BUILDING TOOLS|save_tool/);
    expect(cfg.subagents).toBeUndefined();
    expect(cfg.toolApproval).toEqual({ save_agent: "user-approval", delete_agent: "user-approval" });
  });

  it("saves a valid agent (normalized name) and lists it", async () => {
    const deps = makeDeps();
    const { tools } = await openTools(deps);
    const res = (await tools.save_agent!.execute(SAVE)) as Record<string, unknown>;
    expect(res.saved).toBe(true);
    expect(res.name).toBe("my-agent");
    expect(deps.records[0]!.name).toBe("my-agent");
  });

  it("rejects reserved names, unknown models/connections/subagents", async () => {
    const { tools } = await openTools(makeDeps());
    const err = async (input: object) =>
      ((await tools.save_agent!.execute({ ...SAVE, ...input })) as { error?: string }).error;
    expect(await err({ name: "assistant" })).toMatch(/built-in/);
    expect(await err({ modelId: "nope" })).toMatch(/Unknown modelId/);
    expect(await err({ connections: ["nope"] })).toMatch(/Unknown connection/);
    expect(await err({ subagents: ["nope"] })).toMatch(/Unknown subagent/);
  });

  it("rejects authoredTools with a clear error (never silently ignores)", async () => {
    const { tools } = await openTools(makeDeps());
    const res = (await tools.save_agent!.execute({ ...SAVE, authoredTools: ["t1"] })) as {
      error?: string;
    };
    expect(res.error).toMatch(/Tool authoring is not available/);
  });
});

describe("builder with a stub extension", () => {
  const extension: AgentBuilderExtension<P> = {
    name: "stub",
    tools: () => ({ stub_tool: { execute: async () => "ok" } }),
    promptSections: ["STUB SECTION: extra guidance."],
    subagents: ["stub-helper"],
    reservedNames: ["stub-helper"],
    toolApproval: { stub_tool: "user-approval" },
    handlesAuthoredTools: true,
    validateSave: (_p, input) => (input.authoredTools?.includes("forbidden") ? "forbidden tool" : undefined),
    decorateSaveResult: async (_p, name, result) => ({ ...result, note: `${result.note} [stub:${name}]` }),
    decorateTestResult: async (_p, _name, result) => ({ ...result, stubbed: true }),
  };

  it("merges tools, prompt, subagents, reserved names, and approvals", async () => {
    const { cfg, tools } = await openTools(makeDeps(), [extension]);
    expect(tools.stub_tool).toBeDefined();
    expect(cfg.instructions).toContain("STUB SECTION");
    expect(cfg.subagents).toEqual(["stub-helper"]);
    expect((cfg.toolApproval as Record<string, unknown>).stub_tool).toBe("user-approval");
    const res = (await tools.save_agent!.execute({ ...SAVE, name: "stub-helper" })) as {
      error?: string;
    };
    expect(res.error).toMatch(/built-in/);
  });

  it("allows authoredTools when handled, applies validateSave veto and decorators", async () => {
    const { tools } = await openTools(makeDeps(), [extension]);
    const vetoed = (await tools.save_agent!.execute({ ...SAVE, authoredTools: ["forbidden"] })) as {
      error?: string;
    };
    expect(vetoed.error).toBe("forbidden tool");
    const ok = (await tools.save_agent!.execute({ ...SAVE, authoredTools: ["t1"] })) as Record<
      string,
      unknown
    >;
    expect(ok.saved).toBe(true);
    expect(ok.note).toContain("[stub:my-agent]");
    const test = (await tools.test_agent!.execute({ name: "my-agent", message: "hi" })) as Record<
      string,
      unknown
    >;
    expect(test.stubbed).toBe(true);
  });
});
