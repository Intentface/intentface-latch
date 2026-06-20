import type { LanguageModel } from "ai";

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
  /**
   * Optional per-tool approval policy contributed by this source (merged into
   * the agent's `toolApproval`, object form). Lets a source gate its own tools —
   * e.g. an MCP host gating a synthetic `connect_<name>` tool so an unauthorized
   * connection pauses the turn for OAuth instead of failing.
   */
  toolApproval?: Record<string, unknown>;
}

/**
 * A dynamic, per-turn tool provider (e.g. an MCP host). The runtime calls
 * `open(principal)` before the turn, merges the tools, and calls `close()` after —
 * so connections are scoped to the caller and torn down when the turn ends.
 * `@intentface/latch-mcp`'s `McpHost` satisfies this structurally.
 */
export interface ToolSource<P> {
  open(principal: P): Promise<OpenToolSet>;
}

export interface AgentConfig<P> {
  model: LanguageModel;
  instructions?: string;
  /** Static tools, available every turn. */
  tools?: Record<string, unknown>;
  /** Dynamic tool sources opened per turn and closed after (e.g. MCP). */
  toolSources?: ToolSource<P>[];
  /**
   * Names of the connections (from the runtime's connection registry) this
   * agent may use — its MCP servers / integrations. The runtime resolves these
   * to a per-turn tool source: each authorized connection's tools, plus a gated
   * `connect_<name>` tool for any that still need OAuth. Different agents can
   * carry different connections. Names with no registry entry are ignored.
   */
  connections?: string[];
  /**
   * HITL approval policy (the SDK's `toolApproval`): per-tool `'user-approval'`,
   * an object with a reason, or a function. A gated call ends the turn with an
   * `approval-requested` part instead of executing; the decision round-trips as
   * message state via `runtime.applyApproval`. Kept loose (the SDK type is
   * complex); cast at the agent boundary.
   */
  toolApproval?: unknown;
  /**
   * Smooth the visible token cadence (AI SDK `smoothStream`): even out bursty
   * deltas before they stream to the client. `true` uses the SDK defaults
   * (~10ms, word chunking); or tune `delayInMs`/`chunking`. Presentation only —
   * it does not change what gets persisted.
   */
  smoothStream?: boolean | { delayInMs?: number; chunking?: "word" | "line" };
}

/** A factory that produces the agent's config for a given request/context. */
export type AgentFactory<P, RuntimeContext = unknown> = (ctx: {
  runtime: RuntimeContext;
  principal: P;
}) => AgentConfig<P> | Promise<AgentConfig<P>>;

export function defineAgent<P, RuntimeContext = unknown>(
  def: AgentConfig<P> | AgentFactory<P, RuntimeContext>,
): AgentFactory<P, RuntimeContext> {
  return typeof def === "function"
    ? (def as AgentFactory<P, RuntimeContext>)
    : () => def;
}
