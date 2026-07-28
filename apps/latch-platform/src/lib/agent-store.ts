import type { Client } from "@libsql/client";
import type { LanguageModel } from "ai";
import type { AgentConfig, AgentInfo, DynamicAgentStore } from "@intentface/latch-core";
import type { Principal } from "./session";
import type { CredentialScope } from "./credentials";
import type { EvalContextScope, EvalTrigger } from "./observability/trigger";

/**
 * UI-created agents, stored in a `latch_agents` table (config isn't secret).
 * Owner-keyed for org/personal scope, same as everything else. `resolve` builds
 * the same `AgentConfig` a code agent would (model from the allow-list,
 * instructions, connection names); the `tools` column is reserved for code-mode.
 */
export interface AgentRecord {
  name: string;
  title?: string;
  description?: string;
  modelId: string;
  instructions: string;
  connections: string[];
  /** Tool-loop ceiling: a number caps steps; "unlimited" runs until done; undefined → default. */
  maxSteps?: number | "unlimited";
  /**
   * Per-tool selection over the connections' tools. `enabled` = the namespaced
   * tool names the model may call (empty → all). `approval` = per-tool override:
   * true → require approval, false → waive it (overrides the connection default).
   */
  tools?: {
    enabled: string[];
    approval: Record<string, boolean>;
    /** Per-tool description overrides (by namespaced tool name). */
    descriptions?: Record<string, string>;
  };
  /**
   * Code-execution capabilities (eve-style harness). `sandbox` gives a
   * per-session workspace + the filesystem/shell tools; `provider` picks the
   * backend ("just-bash" default | "daytona"); `defaultTools` adds the
   * app-runtime defaults (web_fetch, …); `disableTools` opts specific defaults
   * out; `codeMode` runs tools via a written-JS program (Phase 2).
   */
  exec?: {
    sandbox?: boolean;
    provider?: string;
    defaultTools?: boolean | string[];
    disableTools?: string[];
    codeMode?: { tools?: string[] };
    /** Use the model provider's native web search/fetch tools. */
    providerWebTools?: boolean;
    /** Give the agent the render tool(s) (headless-browser fetch); separate capability. */
    renderTools?: boolean;
    /** Names of authored tools (latch_tools) attached to this agent. */
    authoredTools?: string[];
    /** Reasoning/thinking effort (gated to reasoning-capable models). */
    effort?: "minimal" | "low" | "medium" | "high";
  };
  /** Agents this one may delegate to via the `spawn_agent` tool. */
  subagents?: string[];
  /**
   * Online evals attached to this agent: LLM-judge rubrics run against
   * completed live runs (each rubric's `trigger` decides which turns), with
   * verdicts pushed to Langfuse as scores (the score name is the rubric name).
   * Authored via the eval-author / attach_evals.
   */
  attachedEvals?: AttachedEval[];
  scope: CredentialScope;
}

/** One judge rubric attached to an agent (see AgentRecord.attachedEvals). */
export interface AttachedEval {
  /** Kebab-case identifier — becomes the Langfuse score name. */
  name: string;
  /** The judging instructions: one observable quality of a good response. */
  prompt: string;
  /** Judge model override (default: the platform judge model). */
  judgeModelId?: string;
  /** binary → pass/fail (1/0, BOOLEAN); score → graded 0–1 (NUMERIC). */
  scale: "binary" | "score";
  enabled: boolean;
  /**
   * When the judge runs (structural predicate — see observability/trigger.ts).
   * Absent → every completed turn. Either way, subagent (depth>0) turns are
   * skipped unless the trigger itself mentions depth.
   */
  trigger?: EvalTrigger;
  /**
   * What the judge sees: "turn" (last user msg + final answer + tool summary,
   * the default), "chat" (plus the conversation so far), or "loop" (this
   * turn full-fidelity: all assistant text + tool calls WITH outputs).
   */
  context?: EvalContextScope;
}

/** Column value (INTEGER) ↔ AgentConfig.maxSteps: NULL=default, 0=unlimited, N=cap. */
const maxStepsToCol = (m: AgentRecord["maxSteps"]): number | null =>
  m === "unlimited" ? 0 : typeof m === "number" ? m : null;
const maxStepsFromCol = (v: unknown): AgentRecord["maxSteps"] =>
  v == null ? undefined : Number(v) === 0 ? "unlimited" : Number(v);

const ownerKey = (p: Principal, scope: CredentialScope): string =>
  (scope === "org" ? [p.orgId] : [p.orgId, p.userId ?? ""])
    .map(encodeURIComponent)
    .join("/");

const newId = () => `agt_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

/**
 * Canonical agent-name normalization — used by BOTH writers (the editor's
 * saveAgentFn and the Agent Builder's save_agent) so the same intended name
 * always maps to one record. Lowercased kebab, underscores allowed.
 */
export const normalizeAgentName = (s: string): string =>
  s.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "");

export async function migrateAgents(client: Client): Promise<void> {
  await client.execute(`CREATE TABLE IF NOT EXISTS latch_agents (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL,
    title TEXT, description TEXT, model_id TEXT NOT NULL, instructions TEXT NOT NULL,
    connections TEXT NOT NULL, tools TEXT, scope TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  await client.execute(
    `CREATE UNIQUE INDEX IF NOT EXISTS latch_agents_owner_name ON latch_agents (owner, name)`,
  );
  // Idempotent adds for existing dev DBs (sqlite has no ADD COLUMN IF NOT EXISTS).
  for (const col of ["max_steps INTEGER", "exec TEXT", "subagents TEXT", "attached_evals TEXT"]) {
    try {
      await client.execute(`ALTER TABLE latch_agents ADD COLUMN ${col}`);
    } catch {
      /* column already exists */
    }
  }
}

export interface AgentStore extends DynamicAgentStore<Principal> {
  /** Full records visible to the caller (org + personal), for the editor. */
  listRecords: (p: Principal) => Promise<(AgentRecord & { scope: CredentialScope })[]>;
  /** One record by name (personal wins over org) — e.g. for the online judge. */
  getRecord: (p: Principal, name: string) => Promise<AgentRecord | undefined>;
  upsert: (p: Principal, rec: AgentRecord) => Promise<void>;
  remove: (p: Principal, scope: CredentialScope, name: string) => Promise<void>;
}

export function createAgentStore(
  client: Client,
  modelFor: (id: string) => LanguageModel,
  /**
   * Resolve the named authored tools (latch_tools) into executable tools for a
   * caller — supplied by the composition root (which owns the tool store). When
   * omitted, an agent's `authoredTools` are simply not attached.
   */
  loadAuthoredTools?: (
    principal: Principal,
    names: string[],
    agentScope: CredentialScope,
  ) => Promise<Record<string, unknown>>,
): AgentStore {
  const recordOf = (row: Record<string, unknown>): AgentRecord => ({
    name: String(row.name),
    title: (row.title as string) ?? undefined,
    description: (row.description as string) ?? undefined,
    modelId: String(row.model_id),
    instructions: String(row.instructions),
    connections: JSON.parse(String(row.connections)) as string[],
    maxSteps: maxStepsFromCol(row.max_steps),
    tools: row.tools
      ? (JSON.parse(String(row.tools)) as AgentRecord["tools"])
      : undefined,
    exec: row.exec ? (JSON.parse(String(row.exec)) as AgentRecord["exec"]) : undefined,
    subagents: row.subagents ? (JSON.parse(String(row.subagents)) as string[]) : undefined,
    attachedEvals: row.attached_evals
      ? (JSON.parse(String(row.attached_evals)) as AttachedEval[])
      : undefined,
    scope: String(row.scope) as CredentialScope,
  });

  async function find(
    p: Principal,
    name: string,
    scope?: CredentialScope,
  ): Promise<AgentRecord | undefined> {
    // Personal wins over org on a name clash — unless pinned to one scope.
    const owners =
      scope === "org"
        ? [ownerKey(p, "org")]
        : scope === "user"
          ? [ownerKey(p, "user")]
          : [ownerKey(p, "user"), ownerKey(p, "org")];
    const res = await client.execute({
      sql: `SELECT * FROM latch_agents WHERE name = ? AND owner IN (${owners.map(() => "?").join(", ")})`,
      args: [name, ...owners],
    });
    const rows = res.rows as unknown as Record<string, unknown>[];
    const personal = rows.find((r) => r.owner === ownerKey(p, "user"));
    const row = personal ?? rows[0];
    return row ? recordOf(row) : undefined;
  }

  return {
    async resolve(name, principal): Promise<AgentConfig<Principal> | undefined> {
      // Channel bindings pin resolution to one scope with an `org:`/`user:`
      // prefix (stored names never contain `:` — normalizeAgentName strips
      // it), so a same-named record in the OTHER scope can never shadow the
      // agent the binding was created for.
      const pin = /^(org|user):(.+)$/.exec(name);
      const rec = pin
        ? await find(principal, pin[2], pin[1] as CredentialScope)
        : await find(principal, name);
      if (!rec) return undefined;
      const sel = rec.tools;
      const approvalEntries = Object.entries(sel?.approval ?? {});
      // Authored tools (latch_tools) attached to this agent, resolved per caller
      // into a tool source. Marked alwaysActive so an `enabledTools` restriction
      // on connection tools never hides them (they're capabilities, not picks).
      const authored = rec.exec?.authoredTools?.length ? rec.exec.authoredTools : undefined;
      const toolSources =
        authored && loadAuthoredTools
          ? [
              {
                async open(p: Principal) {
                  // Never let attached-tool resolution fail the whole turn.
                  try {
                    // Resolve under the AGENT's scope: an org agent gets org
                    // tools (shared with every member), not the caller's personal.
                    const tools = await loadAuthoredTools(p, authored, rec.scope);
                    return { tools, alwaysActive: Object.keys(tools), close: async () => {} };
                  } catch (e) {
                    console.warn("Authored-tools attach failed; running without them:", e);
                    return { tools: {}, close: async () => {} };
                  }
                },
              },
            ]
          : undefined;
      return {
        model: modelFor(rec.modelId),
        instructions: rec.instructions,
        connections: rec.connections,
        toolSources,
        maxSteps: rec.maxSteps,
        // Restrict callable tools (empty/undefined → all).
        enabledTools: sel?.enabled?.length ? sel.enabled : undefined,
        // Per-tool description overrides → applied to the resolved tools.
        toolDescriptions:
          sel?.descriptions && Object.keys(sel.descriptions).length ? sel.descriptions : undefined,
        // Agents this one may delegate to (→ the runtime's spawn_agent tool).
        subagents: rec.subagents?.length ? rec.subagents : undefined,
        // Per-tool approval override (agent wins): on → require, off → waive.
        toolApproval: approvalEntries.length
          ? Object.fromEntries(
              approvalEntries.map(([n, req]) => [n, req ? "user-approval" : "not-applicable"]),
            )
          : undefined,
        // Code-execution capabilities (sandbox + default harness tools).
        sandbox: rec.exec?.sandbox || undefined,
        sandboxProvider: rec.exec?.provider,
        defaultTools: rec.exec?.defaultTools,
        disableTools: rec.exec?.disableTools,
        codeMode: rec.exec?.codeMode,
        providerWebTools: rec.exec?.providerWebTools || undefined,
        renderTools: rec.exec?.renderTools || undefined,
        effort: rec.exec?.effort,
        smoothStream: true,
      };
    },

    async list(principal): Promise<AgentInfo[]> {
      const res = await client.execute({
        sql: "SELECT name, title, description FROM latch_agents WHERE owner IN (?, ?) ORDER BY created_at DESC",
        args: [ownerKey(principal, "user"), ownerKey(principal, "org")],
      });
      return (res.rows as unknown as Record<string, unknown>[]).map((r) => ({
        name: String(r.name),
        title: (r.title as string) ?? undefined,
        description: (r.description as string) ?? undefined,
      }));
    },

    async getRecord(principal, name) {
      return find(principal, name);
    },

    async listRecords(principal) {
      const res = await client.execute({
        sql: "SELECT * FROM latch_agents WHERE owner IN (?, ?) ORDER BY created_at DESC",
        args: [ownerKey(principal, "user"), ownerKey(principal, "org")],
      });
      return (res.rows as unknown as Record<string, unknown>[]).map((r) => ({
        ...recordOf(r),
        scope: String(r.scope) as CredentialScope,
      }));
    },

    async upsert(principal, rec) {
      const now = Date.now();
      await client.execute({
        sql: `INSERT INTO latch_agents
          (id, owner, name, title, description, model_id, instructions, connections, tools, exec, subagents, attached_evals, max_steps, scope, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(owner, name) DO UPDATE SET
            title=excluded.title, description=excluded.description, model_id=excluded.model_id,
            instructions=excluded.instructions, connections=excluded.connections,
            tools=excluded.tools, exec=excluded.exec, subagents=excluded.subagents,
            attached_evals=excluded.attached_evals,
            max_steps=excluded.max_steps, scope=excluded.scope,
            updated_at=excluded.updated_at`,
        args: [
          newId(),
          ownerKey(principal, rec.scope),
          rec.name,
          rec.title ?? null,
          rec.description ?? null,
          rec.modelId,
          rec.instructions,
          JSON.stringify(rec.connections),
          rec.tools ? JSON.stringify(rec.tools) : null,
          rec.exec ? JSON.stringify(rec.exec) : null,
          rec.subagents?.length ? JSON.stringify(rec.subagents) : null,
          rec.attachedEvals?.length ? JSON.stringify(rec.attachedEvals) : null,
          maxStepsToCol(rec.maxSteps),
          rec.scope,
          now,
          now,
        ],
      });
    },

    async remove(principal, scope, name) {
      await client.execute({
        sql: "DELETE FROM latch_agents WHERE owner = ? AND name = ?",
        args: [ownerKey(principal, scope), name],
      });
    },
  };
}
