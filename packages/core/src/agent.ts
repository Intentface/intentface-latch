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
  /**
   * Tools that stay callable even when an agent restricts `enabledTools` — e.g.
   * the synthetic `connect_<name>` auth tools, which must work so the connect
   * flow isn't blocked by a tool allow-list.
   */
  alwaysActive?: string[];
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
  /**
   * Max tool-loop steps before the turn stops (the SDK `stopWhen` ceiling).
   * Omitted → SDK default (20). A number caps the loop; `"unlimited"` lets it
   * run until the model stops on its own (no more tool calls) — use with care,
   * it removes the runaway-loop backstop.
   */
  maxSteps?: number | "unlimited";
  /**
   * Restrict which tools the model may call (the SDK's `activeTools`) — the
   * namespaced names (e.g. `clockify_getTimeEntries`). Omitted → all available
   * tools are active. Tools a source marks `alwaysActive` (e.g. `connect_<name>`)
   * stay callable regardless.
   */
  enabledTools?: string[];
  /**
   * Per-tool description overrides (by namespaced tool name). The runtime
   * replaces the resolved tool's `description` with this text before the model
   * sees it — e.g. to tailor a connection tool's guidance for this agent.
   */
  toolDescriptions?: Record<string, string>;
  /**
   * Agents this one may delegate to. The runtime adds a `spawn_agent` tool that
   * runs one of these as a subagent (a normal agent, run autonomously — its
   * tools are auto-approved) and returns its final answer. Each subagent run is
   * its own persisted thread; pass the returned `threadId` back to continue the
   * same subagent with full context.
   */
  subagents?: string[];
  /**
   * Give the agent a per-session sandbox (a workspace) and the filesystem/shell
   * tools that operate on it (`bash`, `read_file`, `write_file`, `glob`,
   * `grep`). The runtime resolves the actual `Experimental_SandboxSession` via
   * `RuntimeConfig.sandbox` and passes it to the model; the tools come from
   * `RuntimeConfig.harnessTools.sandbox`. Optional `provider` picks the backend
   * (e.g. `"just-bash"` | `"daytona"`); the resolver decides the default.
   */
  sandbox?: boolean;
  /** Sandbox backend hint, passed through to `RuntimeConfig.sandbox`. */
  sandboxProvider?: string;
  /**
   * Add the app-runtime default harness tools (`web_fetch`, `todo`,
   * `ask_question`) from `RuntimeConfig.harnessTools.app`. `true` adds all;
   * an array restricts to those names. These run in the app process, not the
   * sandbox.
   */
  defaultTools?: boolean | string[];
  /** Names of harness/default tools to drop for this agent (eve-style opt-out). */
  disableTools?: string[];
  /**
   * Run the agent in code-mode: the model writes JS that calls the selected
   * tools as functions (one program instead of many round-trips). `tools` names
   * which connection tools to expose inside code-mode (omitted → all ungated);
   * the runtime wraps them via `RuntimeConfig.codeModeWrap`.
   */
  codeMode?: { tools?: string[] };
  /**
   * Use the model provider's NATIVE web tools (server-side web search/fetch)
   * when available, supplied by `RuntimeConfig.resolveProviderTools(modelId)`.
   * Provider-specific: e.g. Anthropic exposes web_search + web_fetch, OpenAI
   * web_search only. No-op on providers without native web tools.
   */
  providerWebTools?: boolean;
  /**
   * Reasoning/thinking effort for this agent. Mapped to provider-specific
   * options by `RuntimeConfig.resolveReasoningOptions` (OpenAI effort enum vs
   * Anthropic/Google thinking-token budget) and gated to reasoning-capable
   * models. Omitted → the provider default.
   */
  effort?: "minimal" | "low" | "medium" | "high";
}

/** Static, display-only metadata for an agent — surfaced by `runtime.listAgents()`. */
export interface AgentMeta {
  /** Human-friendly name for a picker (defaults to the registry key). */
  title?: string;
  /** Short description of what the agent does. */
  description?: string;
}

/** An agent's identity for selection UIs: its registry key + display metadata. */
export interface AgentInfo extends AgentMeta {
  name: string;
}

/**
 * A factory that produces the agent's config for a given request/context.
 * Carries optional static `meta` (read without invoking the factory) so the
 * runtime can list agents for a picker.
 */
export type AgentFactory<P, RuntimeContext = unknown> = ((ctx: {
  runtime: RuntimeContext;
  principal: P;
}) => AgentConfig<P> | Promise<AgentConfig<P>>) & { meta?: AgentMeta };

export function defineAgent<P, RuntimeContext = unknown>(
  def: AgentConfig<P> | AgentFactory<P, RuntimeContext>,
  meta?: AgentMeta,
): AgentFactory<P, RuntimeContext> {
  const factory: AgentFactory<P, RuntimeContext> =
    typeof def === "function"
      ? (def as AgentFactory<P, RuntimeContext>)
      : () => def;
  if (meta) factory.meta = meta;
  return factory;
}
