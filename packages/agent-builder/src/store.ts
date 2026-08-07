import type { DynamicAgentStore } from "@intentface/latch-core";

/**
 * The agent-record model and store seam.
 *
 * A record is the persisted form of a UI/builder-created agent (config isn't
 * secret). Storage is host-supplied: `@intentface/latch-drizzle` ships an
 * implementation; latch-platform keeps its libsql one. The store doubles as a
 * `DynamicAgentStore` so saved records are runnable by the host's runtime —
 * `resolve` builds the same `AgentConfig` a code-declared agent would.
 */

/** Where a record lives: the caller's personal scope or the shared org scope. */
export type AgentScope = "user" | "org";

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
   * Code-execution capabilities. `sandbox` gives a per-session workspace +
   * filesystem/shell tools; `provider` picks the backend; `defaultTools` adds
   * the app-runtime defaults (web_fetch, …); `disableTools` opts specific
   * defaults out; `codeMode` runs tools via a written-JS program.
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
    /** Names of authored tools attached to this agent (host tool-authoring feature). */
    authoredTools?: string[];
    /**
     * Waive the host's per-call approval pause on this agent's WRITE tools —
     * the save_agent approval (where this flag is visible) is the consent.
     * For agents that must run unattended (schedules). Only meaningful on
     * hosts that gate writes; requires the write capability (`defaultTools`).
     */
    preApprovedWrites?: boolean;
    /** Reasoning/thinking effort (gated to reasoning-capable models). */
    effort?: "minimal" | "low" | "medium" | "high";
  };
  /** Agents this one may delegate to via the `spawn_agent` tool. */
  subagents?: string[];
  scope: AgentScope;
}

/**
 * Canonical agent-name normalization — used by EVERY writer (host editors and
 * the builder's save_agent) so the same intended name always maps to one
 * record. Lowercased kebab, underscores allowed.
 */
export const normalizeAgentName = (s: string): string =>
  s.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "");

/**
 * The storage seam the builder writes through. Extends `DynamicAgentStore` so
 * one object serves both duties: record CRUD for the builder/editor, and
 * list/resolve for the runtime's dynamic-agent registry.
 */
export interface AgentBuilderStore<P> extends DynamicAgentStore<P> {
  /** Full records visible to the caller (org + personal), for the builder/editor. */
  listRecords: (p: P) => Promise<AgentRecord[]>;
  /** Create or update by (owner, name). */
  upsert: (p: P, rec: AgentRecord) => Promise<void>;
  remove: (p: P, scope: AgentScope, name: string) => Promise<void>;
}
