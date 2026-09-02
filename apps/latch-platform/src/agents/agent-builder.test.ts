import { describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "@intentface/latch-agent-builder";
import type { Principal } from "@/lib/session";

/**
 * The composed platform builder = the package meta-agent + five extensions.
 * These tests stand up the toolset against a stubbed composition root and
 * check the platform-specific behaviour: the tool surface, the approval gates,
 * and each extension's save veto.
 */

const principal: Principal = { orgId: "org1", userId: "u1" };
const records: AgentRecord[] = [];
const schedules: { id: string; agent: string }[] = [];
const authored: { name: string; scope: "user" | "org" }[] = [{ name: "calc", scope: "user" }];

const latch = {
  runtime: {
    listAgents: async () => [{ name: "assistant" }, ...records.map((r) => ({ name: r.name }))],
    listChats: async () => [],
    loadHistory: async () => [],
    runAgent: async () => ({ threadId: "sub_1", answer: "hi" }),
    schedule: async () => ({ id: "sch_1", agent: "x", cron: null, nextRunAt: 0 }),
    listSchedules: async () => schedules,
    unschedule: async () => {},
  },
  agentStore: {
    resolve: async () => undefined,
    list: async () => records.map((r) => ({ name: r.name })),
    listRecords: async () => records,
    getRecord: async (_p: Principal, ref: string) => {
      const m = /^(org|user):(.+)$/.exec(ref);
      const name = m ? m[2] : ref;
      const scope = m ? m[1] : undefined;
      const hits = records.filter((r) => r.name === name && (!scope || r.scope === scope));
      return hits.find((r) => r.scope === "user") ?? hits[0];
    },
    listMemoryEnabledNames: async () => [],
    upsert: async (_p: Principal, rec: AgentRecord) => {
      const i = records.findIndex((r) => r.name === rec.name && r.scope === rec.scope);
      if (i >= 0) records[i] = rec;
      else records.push(rec);
    },
    remove: async () => {},
  },
  allConnections: { hostFor: () => ({ open: async () => ({ tools: {}, close: async () => {} }) }) },
  connections: { names: ["loredex", "github"] },
  connectionStore: { list: async () => [], remove: async () => {} },
  dynamic: { status: async () => [], testTools: async () => [] },
  models: [
    { id: "m-1", label: "One", provider: "anthropic", reasoning: true },
    // validateRubrics requires the default judge model to be in the catalog.
    { id: "claude-haiku-4-5", label: "Haiku", provider: "anthropic" },
  ],
  authoredTools: {
    listFor: async () => authored,
    authoringTools: () => ({ save_tool: {}, test_tool: {}, list_tools: {}, delete_tool: {} }),
    executableTools: async () => ({}),
  },
  evalStore: { listSets: async () => [] },
  namedSecrets: { list: async () => [] },
  memoryStore: { writeFile: async () => {} },
};

vi.mock("@/lib/latch", () => ({ getLatch: async () => latch }));
vi.mock("@/lib/auth", () => ({ isOrgAdmin: async () => true }));

const { agentBuilder } = await import("./agent-builder");

async function openTools() {
  const cfg = await agentBuilder({ context: { orgId: "org1" }, runtime: { orgId: "org1" }, principal });
  const opened = await cfg.toolSources![0]!.open(principal);
  return {
    cfg,
    tools: opened.tools as Record<string, { execute: (input: unknown) => Promise<unknown> }>,
  };
}

const SAVE = { name: "helper", modelId: "m-1", instructions: "help", scope: "user" as const };

describe("platform agent builder (package + extensions)", () => {
  it("exposes the core toolset plus every platform extension's tools", async () => {
    const { tools } = await openTools();
    expect(Object.keys(tools).sort()).toEqual(
      [
        // package core
        "delete_agent", "get_agent", "list_agents", "list_chats", "list_connection_tools",
        "list_connections", "list_models", "read_chat", "save_agent", "test_agent",
        // connections
        "list_secrets", "request_secret", "create_connection", "connect_connection", "delete_connection",
        // memory
        "generate_memory_schemas", "save_user_memory_schema",
        // schedules (delivery-aware; the package's plain ones are off)
        "list_agent_channels", "create_agent_schedule", "list_agent_schedules", "delete_agent_schedule",
        // evals
        "attach_evals", "list_eval_sets",
        // tool authoring
        "save_tool", "test_tool", "list_tools", "delete_tool",
      ].sort(),
    );
    expect(tools.schedule_agent).toBeUndefined();
  });

  it("gates every persisting mutation and declares the eval-author delegate", async () => {
    const { cfg } = await openTools();
    expect(cfg.subagents).toEqual(["eval-author"]);
    expect(cfg.toolApproval).toMatchObject({
      save_agent: "user-approval",
      delete_agent: "user-approval",
      save_tool: "user-approval",
      delete_tool: "user-approval",
      attach_evals: "user-approval",
      create_connection: "user-approval",
      delete_connection: "user-approval",
      connect_connection: "user-approval",
      create_agent_schedule: "user-approval",
      delete_agent_schedule: "user-approval",
      save_user_memory_schema: "user-approval",
    });
    expect((cfg.toolApproval as Record<string, unknown>).request_secret).toBeUndefined();
    expect(cfg.instructions).toMatch(/MEMORY & SCHEMAS|CREATING A CONNECTION|BUILDING TOOLS|EVALS|SCHEDULES/);
    expect(cfg.instructions).toContain("exec.memory");
  });

  it("memory extension reserves the memory-* prefix", async () => {
    const { tools } = await openTools();
    const res = (await tools.save_agent!.execute({ ...SAVE, name: "memory-notes" })) as { error?: string };
    expect(res.error).toMatch(/reserved/);
  });

  it("tool-authoring extension vetoes unknown tools and personal tools on org agents", async () => {
    const { tools } = await openTools();
    const unknown = (await tools.save_agent!.execute({ ...SAVE, exec: { authoredTools: ["ghost"] } })) as {
      error?: string;
    };
    expect(unknown.error).toMatch(/Unknown authored tool/);
    const orgWithPersonal = (await tools.save_agent!.execute({
      ...SAVE,
      scope: "org",
      exec: { authoredTools: ["calc"] },
    })) as { error?: string };
    expect(orgWithPersonal.error).toMatch(/org-scoped tools/);
    const ok = (await tools.save_agent!.execute({ ...SAVE, exec: { authoredTools: ["calc"] } })) as {
      saved?: boolean;
    };
    expect(ok.saved).toBe(true);
  });

  it("memory is offered and saves; the schema's memory invariants apply", async () => {
    const { tools } = await openTools();
    const dangling = (await tools.save_agent!.execute({
      ...SAVE,
      name: "coach",
      exec: { memory: { scope: "agent-user", connection: "loredex" } },
    })) as { error?: string };
    expect(dangling.error).toMatch(/must also be listed/);
    const ok = (await tools.save_agent!.execute({
      ...SAVE,
      name: "coach",
      connections: ["loredex"],
      exec: { memory: { scope: "agent-user", connection: "loredex" } },
    })) as { saved?: boolean };
    expect(ok.saved).toBe(true);
  });

  it("evals extension: attach_evals validates rubrics, save keeps them, results carry the nudge", async () => {
    const { tools } = await openTools();
    await tools.save_agent!.execute({ ...SAVE, name: "judged" });
    const bad = (await tools.attach_evals!.execute({
      agentName: "judged",
      evals: [{ name: "Not Kebab", prompt: "x" }],
    })) as { error?: string };
    expect(bad.error).toMatch(/kebab/i);
    const good = (await tools.attach_evals!.execute({
      agentName: "judged",
      // Direct `execute` bypasses the input schema's defaults — spell them out.
      evals: [{ name: "on-topic", prompt: "Stays on topic.", scale: "binary", enabled: true }],
    })) as { saved?: boolean };
    expect(good.saved).toBe(true);
    // A later save without evals keeps them, and the result says so.
    const saved = (await tools.save_agent!.execute({ ...SAVE, name: "judged", instructions: "v2" })) as {
      attachedEvals?: string[];
      note?: string;
    };
    expect(saved.attachedEvals).toEqual(["on-topic"]);
    expect(saved.note).toMatch(/online eval\(s\): on-topic/);
    expect(records.find((r) => r.name === "judged")?.attachedEvals?.[0]?.name).toBe("on-topic");
  });
});
