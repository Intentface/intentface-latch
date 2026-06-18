import type { LanguageModel } from "ai";
import type { Principal, Scope } from "./principal.js";

/**
 * Agent definitions.
 *
 * An agent definition is *config*, never an instantiated engine — that's the
 * "engine portability" invariant: the executor builds a `ToolLoopAgent` (T1) or
 * a `WorkflowAgent` (later) from the same config. It's a lazy factory resolved
 * per request with the typed runtime context (static config is wrapped into one).
 */

/**
 * Minimal, engine-agnostic agent config (a subset of the SDK's agent settings).
 * `tools` is kept loose (`ToolSet` is not a public AI SDK export); the concrete
 * engine constrains it at the call site when the run executes.
 */
/** A set of tools opened for a turn, plus the teardown to run when it ends. */
export interface OpenToolSet {
  tools: Record<string, unknown>;
  close(): Promise<void>;
}

/**
 * A dynamic, per-turn tool provider (e.g. an MCP host). The runtime calls
 * `open(scope)` before the turn, merges the tools, and calls `close()` after —
 * so connections are scoped to the tenant and torn down when the turn ends.
 * `@intentface/latch-mcp`'s `McpHost` satisfies this structurally.
 */
export interface ToolSource {
  open(scope: Scope): Promise<OpenToolSet>;
}

export interface AgentConfig {
  model: LanguageModel;
  instructions?: string;
  /** Static tools, available every turn. */
  tools?: Record<string, unknown>;
  /** Dynamic tool sources opened per turn and closed after (e.g. MCP). */
  toolSources?: ToolSource[];
}

/** A factory that produces the agent's config for a given request/context. */
export type AgentFactory<RuntimeContext = unknown> = (ctx: {
  runtime: RuntimeContext;
  principal: Principal;
}) => AgentConfig | Promise<AgentConfig>;

export function defineAgent<RuntimeContext = unknown>(
  def: AgentConfig | AgentFactory<RuntimeContext>,
): AgentFactory<RuntimeContext> {
  return typeof def === "function"
    ? (def as AgentFactory<RuntimeContext>)
    : () => def;
}
