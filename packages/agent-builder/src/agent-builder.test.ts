import { describe, expect, it, vi } from "vitest";
import { createAgentBuilder } from "./agent-builder";
import type { AgentBuilderDeps } from "./agent-builder";
import type { AgentBuilderExtension } from "./extension";
import { normalizeAgentName } from "./store";
import type { AgentRecord } from "./store";

type P = { orgId: string; userId: string };
const principal: P = { orgId: "org1", userId: "u1" };

type StubSchedule = {
  id: string;
  agent: string;
  cron: string | null;
  timezone?: string;
  prompt: string;
  nextRunAt: number;
  lastRunAt: number | null;
  enabled: boolean;
};

/** In-memory store + stub host services, enough to drive the toolset. */
function makeDeps(): AgentBuilderDeps<P> & {
  records: AgentRecord[];
  schedules: StubSchedule[];
} {
  const records: AgentRecord[] = [];
  const schedules: StubSchedule[] = [];
  return {
    records,
    schedules,
    runtime: {
      listAgents: vi.fn(async () => [{ name: "assistant" }, ...records.map((r) => ({ name: r.name }))]),
      listChats: vi.fn(async () => []),
      loadHistory: vi.fn(async () => []),
      runAgent: vi.fn(async () => ({ threadId: "sub_1", answer: "hi" })),
      schedule: vi.fn(async (input: { agent: string; cron: string | null; prompt: string; timezone?: string }) => {
        const rec: StubSchedule = {
          id: `sch_${schedules.length + 1}`,
          agent: input.agent,
          cron: input.cron,
          timezone: input.timezone,
          prompt: input.prompt,
          nextRunAt: Date.now() + 1000,
          lastRunAt: null,
          enabled: true,
        };
        schedules.push(rec);
        return rec;
      }),
      listSchedules: vi.fn(async () => schedules),
      unschedule: vi.fn(async ({ id }: { id: string }) => {
        const i = schedules.findIndex((s) => s.id === id);
        if (i >= 0) schedules.splice(i, 1);
      }),
    } as unknown as AgentBuilderDeps<P>["runtime"],
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
  configExtras?: Partial<Parameters<typeof createAgentBuilder<P>>[0]>,
) {
  const factory = createAgentBuilder<P>({
    model,
    deps: async () => deps,
    reservedNames: reservedNames ?? ["assistant", "agent-builder"],
    extensions,
    ...configExtras,
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
        "list_schedules",
        "read_chat",
        "save_agent",
        "schedule_agent",
        "test_agent",
        "unschedule_agent",
      ].sort(),
    );
  });

  it("mentions no evals / tool authoring in the prompt and declares no subagents", async () => {
    const { cfg } = await openTools(makeDeps());
    expect(cfg.instructions).not.toMatch(/EVALS|eval-author|BUILDING TOOLS|save_tool/);
    expect(cfg.subagents).toBeUndefined();
    expect(cfg.toolApproval).toEqual({
      save_agent: "user-approval",
      delete_agent: "user-approval",
      schedule_agent: "user-approval",
      unschedule_agent: "user-approval",
    });
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

describe("capability support (truthful prompt + save rejection)", () => {
  const NONE = { sandbox: false, codeMode: false, providerWebTools: false, defaultTools: false };

  it("rejects capability flags the host never wired", async () => {
    const { tools } = await openTools(makeDeps(), undefined, undefined, {
      capabilities: NONE,
    });
    const res = (await tools.save_agent!.execute({
      ...SAVE,
      capabilities: { sandbox: true, codeMode: true },
    })) as { error?: string };
    expect(res.error).toMatch(/Not available in this host: codeMode, sandbox/);
  });

  it("prompt only offers supported capabilities, with the host's defaultTools description", async () => {
    const { cfg } = await openTools(makeDeps(), undefined, undefined, {
      capabilities: {
        sandbox: false,
        codeMode: false,
        providerWebTools: false,
        defaultTools: { description: "workspace write access (every write needs approval)" },
      },
    });
    expect(cfg.instructions).not.toMatch(/sandbox \(|codeMode \(|providerWebTools \(/);
    expect(cfg.instructions).toContain("workspace write access (every write needs approval)");
    // The no-background-loops rule is always present.
    expect(cfg.instructions).toContain("No background loops");
  });

  it("default (undeclared) support keeps everything offered and saveable", async () => {
    const { cfg, tools } = await openTools(makeDeps());
    expect(cfg.instructions).toMatch(/sandbox \(workspace \+ file\/shell tools\)/);
    const res = (await tools.save_agent!.execute({
      ...SAVE,
      capabilities: { sandbox: true },
    })) as { saved?: boolean };
    expect(res.saved).toBe(true);
  });
});

describe("scheduling tools", () => {
  it("schedules an agent (normalized name), lists, and unschedules", async () => {
    const deps = makeDeps();
    const { tools } = await openTools(deps);
    const res = (await tools.schedule_agent!.execute({
      agent: "My Agent",
      prompt: "do the thing",
      cron: "0 9 * * *",
      timezone: "Europe/Helsinki",
    })) as Record<string, unknown>;
    expect(res.scheduled).toBe(true);
    expect(deps.schedules[0]).toMatchObject({ agent: "my-agent", cron: "0 9 * * *" });

    const listed = (await tools.list_schedules!.execute({})) as Array<Record<string, unknown>>;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ agent: "my-agent", cron: "0 9 * * *", timezone: "Europe/Helsinki" });

    await tools.unschedule_agent!.execute({ id: String(res.id) });
    expect(deps.schedules).toHaveLength(0);
  });

  it("one-shot when cron omitted; schedule errors surface as tool errors", async () => {
    const deps = makeDeps();
    const { tools } = await openTools(deps);
    const res = (await tools.schedule_agent!.execute({
      agent: "my-agent",
      prompt: "once",
    })) as Record<string, unknown>;
    expect(res.cron).toBe("one-shot");

    ;(deps.runtime.schedule as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Unknown agent: ghost"),
    );
    const err = (await tools.schedule_agent!.execute({ agent: "ghost", prompt: "x" })) as {
      error?: string;
    };
    expect(err.error).toMatch(/Unknown agent/);
  });

  it("scheduling: false removes the tools and the prompt section", async () => {
    const { cfg, tools } = await openTools(makeDeps(), undefined, undefined, {
      scheduling: false,
    });
    expect(tools.schedule_agent).toBeUndefined();
    expect(cfg.instructions).not.toContain("SCHEDULING");
    expect((cfg.toolApproval as Record<string, unknown>).schedule_agent).toBeUndefined();
  });
});
