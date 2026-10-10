import { asSchema, type FlexibleSchema, type LanguageModel } from "ai";
import type { MemoryConfig } from "./memory.js";
import type { Extension } from "./extensions/extension.js";

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
 * `tools` is kept loose for now: the SDK does export `ToolSet`, but every tool
 * source (connections, MCP, OpenAPI, the platform's dynamic connections) builds
 * a `Record<string, unknown>` and adopting the SDK type is one typing pass
 * across them all. Until then the concrete engine constrains it at the call
 * site when the run executes.
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
  /**
   * Which stored version of this agent's record produced this config, when it
   * came from a store that versions them (`latch_agent_versions.version`).
   * Absent for code-declared agents, which have no stored record.
   *
   * Recorded on the run and emitted as a trace tag, so a past answer can be
   * traced back to the exact configuration that produced it — and so eval or
   * judge scores can be compared across versions.
   */
  configVersion?: number;
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
  /**
   * Give the agent the platform's render tool(s) from
   * `RuntimeConfig.harnessTools.render` — a headless-browser fetch for
   * JS-rendered pages. A separate capability flag (like `sandbox`) rather than
   * a `defaultTools` member: the platform supplies it (needs a deployed render
   * service) and it must be opted into explicitly, never swept in by
   * `defaultTools: true`.
   */
  renderTools?: boolean;
  /** Names of harness/default tools to drop for this agent (eve-style opt-out). */
  disableTools?: string[];
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
  /**
   * Persistent cross-session memory for this agent. Requires the runtime to be
   * composed with a `MemoryProvider` (`RuntimeConfig.memory`) — without one the
   * declaration is ignored. When both are set, each turn gets the provider's
   * compiled memory index appended to `instructions` and its memory tools
   * (`memory_search`/`memory_save`) merged as capability tools; the provider's
   * background jobs handle extraction and consolidation out of band.
   */
  memory?: MemoryConfig;
  /**
   * Extensions attached to this agent's turns, after the runtime-wide ones
   * (`RuntimeConfig.extensions`). See `extensions/extension.ts` for the
   * moments and effects. Omitted → the agent's turns are unchanged.
   */
  extensions?: Extension[];
}

/** Static, display-only metadata for an agent — surfaced by `runtime.listAgents()`. */
export interface AgentMeta {
  /** Human-friendly name for a picker (defaults to the registry key). */
  title?: string;
  /** Short description of what the agent does. */
  description?: string;
  /**
   * Internal agent: still resolvable/runnable by name, but flagged so
   * user-facing pickers can drop it. `runtime.listAgents()` returns hidden
   * agents WITH the flag (internal callers — e.g. a builder validating
   * subagent names — need the full set); the HTTP `GET agents` route filters
   * them out.
   */
  hidden?: boolean;
  /**
   * What a chat with this agent is about, as a schema (Zod, Valibot, any
   * Standard Schema): a ticket, a document, a model fixed for the chat. Set on
   * the chat's first message (`handleChat({ params })`, `runAgent`,
   * `schedule`), validated, saved on the chat, and handed to the agent function
   * and its tools on every turn. Most agents need none; an agent without a
   * schema refuses params.
   *
   * Params come from the client. An id in them says which thing the chat is
   * about, not whether the user may see it: load it through something limited
   * to the principal, in the agent function.
   */
  params?: FlexibleSchema;
  /**
   * How this agent reads the `data-context` part on user messages, in place of
   * the runtime's `messageContext.toModel`. Return `undefined` to leave it out
   * for this agent.
   */
  messageContext?: { toModel?: (context: any) => string | undefined }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** An agent's identity for selection UIs: its registry key + display metadata. */
export interface AgentInfo extends Omit<AgentMeta, "params" | "messageContext"> {
  name: string;
}

/**
 * A factory that produces the agent's config for a given request/context.
 * Carries optional static `meta` (read without invoking the factory) so the
 * runtime can list agents for a picker.
 */
export type AgentFactory<P, RuntimeContext = unknown, Params = unknown> = ((ctx: AgentFactoryInput<P, RuntimeContext, Params>) => AgentConfig<P> | Promise<AgentConfig<P>>) & { meta?: AgentMeta };

/**
 * What an agent function receives. `params` is required for an agent that
 * declares a params type, and optional for one that doesn't, so a factory with
 * no params can still be called as `factory({ context, principal })`.
 */
export type AgentFactoryInput<P, RuntimeContext = unknown, Params = unknown> = {
  /**
   * The runtime CONTEXT built by `context.build` for this turn (org name, plan,
   * feature flags — see `ContextDefinition`).
   */
  context: RuntimeContext;
  principal: P;
  /**
   * What the user is looking at, from the `data-context` part of the message
   * being answered (checked against `messageContext.schema` when set). The
   * same on a continuation of that answer; `undefined` when the message has
   * none.
   */
  messageContext?: unknown;
  /**
   * @deprecated Per-request data that isn't saved, so it is missing when an
   * answer continues after an approval, a crash or on a schedule. Use `params`
   * for what the chat is about.
   */
  turnContext?: unknown;
} & (0 extends 1 & Params
  ? {
      // `any` (the registry's view of every agent): required, so a factory
      // that needs its params still fits.
      params: Params;
    }
  : unknown extends Params
  ? {
      /** What this chat is about; `undefined` for an agent that declares no params. */
      params?: Params;
    }
  : {
      /**
       * What this chat is about, validated against `meta.params` (see
       * {@link AgentMeta.params}).
       */
      params: Params;
    });

/**
 * Declares an agent: a config, or a function that builds one every turn from
 * `{ context, principal, params }`. Pass `params` in `meta` to say what a chat
 * with it is about; its type then flows into the function. With explicit type
 * arguments, give the params type as the third:
 * `defineAgent<Principal, Ctx, { ticketId: string }>(fn, { params: schema })`.
 */
export function defineAgent<P, RuntimeContext = unknown, Params = unknown>(
  def: AgentConfig<P> | AgentFactory<P, RuntimeContext, Params>,
  meta?: AgentMeta & { params?: FlexibleSchema<Params> },
): AgentFactory<P, RuntimeContext, Params> {
  const factory: AgentFactory<P, RuntimeContext, Params> =
    typeof def === "function"
      ? (def as AgentFactory<P, RuntimeContext, Params>)
      : () => def;
  if (meta) factory.meta = meta;
  return factory;
}

/** Params larger than this (as JSON) are refused: they are saved with every chat. */
export const MAX_PARAMS_BYTES = 16 * 1024;

/**
 * Params were refused: the agent declares none, they don't match its schema,
 * they aren't JSON, or they are too large. The HTTP server answers 400.
 */
export class InvalidParamsError extends Error {
  readonly code = "invalid_params" as const;
  constructor(message: string) {
    super(message);
    this.name = "InvalidParamsError";
  }
}

export function isInvalidParamsError(e: unknown): e is InvalidParamsError {
  return e instanceof InvalidParamsError || (e as { code?: unknown } | null)?.code === "invalid_params";
}

/**
 * A later message tried to change the chat's params. They are fixed for the
 * chat's life; start a new chat for something else. The HTTP server answers 409.
 */
export class ParamsFixedError extends Error {
  readonly code = "params_fixed" as const;
  constructor(chatId: string) {
    super(`chat ${chatId} is already about something else: start a new chat for different params`);
    this.name = "ParamsFixedError";
  }
}

export function isParamsFixedError(e: unknown): e is ParamsFixedError {
  return e instanceof ParamsFixedError || (e as { code?: unknown } | null)?.code === "params_fixed";
}

/**
 * Checks params against an agent's schema and returns what to SAVE: the input,
 * as plain JSON, once the schema has accepted it. The input rather than the
 * schema's output, because the output can be anything a transform makes (a
 * `Date`), and because the saved value is checked again on every turn: a
 * transform must run on the original, not on its own result. Refuses params for
 * an agent without a schema, values that aren't JSON, and anything over
 * {@link MAX_PARAMS_BYTES}. `undefined` stays `undefined` unless the schema
 * rejects it.
 */
export async function paramsToSave(agent: string, schema: FlexibleSchema | undefined, value: unknown): Promise<unknown> {
  const json = paramsJson(agent, schema, value);
  await validateParams(agent, schema, json);
  return json;
}

/** `value` as plain JSON, size-capped; refused for an agent without a schema. */
function paramsJson(agent: string, schema: FlexibleSchema | undefined, value: unknown): unknown {
  if (!schema) {
    if (value !== undefined) throw new InvalidParamsError(`agent "${agent}" takes no params`);
    return undefined;
  }
  if (value === undefined) return undefined;
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    // falls through to the refusal below
  }
  if (text === undefined) throw new InvalidParamsError(`params for "${agent}" must be JSON`);
  if (new TextEncoder().encode(text).length > MAX_PARAMS_BYTES) {
    throw new InvalidParamsError(`params for "${agent}" are over ${MAX_PARAMS_BYTES} bytes`);
  }
  return JSON.parse(text);
}

/**
 * Checks params against an agent's schema and returns the schema's output
 * (defaults applied, transforms run): what the agent function and tools get.
 * Use {@link paramsToSave} for what to store.
 */
export async function validateParams(agent: string, schema: FlexibleSchema | undefined, value: unknown): Promise<unknown> {
  const json = paramsJson(agent, schema, value);
  if (!schema) return undefined;
  const check = asSchema(schema).validate;
  if (!check) return json;
  const result = await check(json);
  if (!result.success) throw new InvalidParamsError(`params for "${agent}" don't match its schema: ${result.error.message}`);
  return result.value;
}
