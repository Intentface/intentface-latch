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

/**
 * An agent: a model, its instructions and what it may do. Pass it to
 * `defineAgent`, or return it from a factory when it depends on who is asking.
 */
export interface AgentConfig<P> {
  /**
   * Which saved version of a database agent this config came from. Set by
   * agent stores that keep versions; leave it out for agents defined in code.
   * Recorded on every run, so an answer can be traced to the exact
   * configuration that produced it.
   */
  configVersion?: number;
  /** The model the agent runs on, as an AI SDK model, for example `anthropic("claude-sonnet-4-6")`. */
  model: LanguageModel;
  /** The system prompt. */
  instructions?: string;
  /** Tools available on every turn, as AI SDK `tool()` definitions, by name. */
  tools?: Record<string, unknown>;
  /**
   * Tools that are opened for each turn and closed after it, for example from
   * an MCP server. Each source is opened with the caller's principal, so its
   * tools can act as that person.
   */
  toolSources?: ToolSource<P>[];
  /**
   * The connections this agent may use, by name (MCP servers and other
   * integrations from the runtime's `connections`). A connection the user
   * hasn't authorized yet appears as a `connect_<name>` tool that starts its
   * sign-in. Names the runtime doesn't know are ignored.
   */
  connections?: string[];
  /**
   * Which tools need a person's approval before they run, by tool name:
   * `{ send_email: "user-approval" }`. A gated call pauses the run and shows
   * an approval request; `runtime.applyApproval` continues it. Same format as
   * the AI SDK's `toolApproval`, including the function form.
   */
  toolApproval?: unknown;
  /**
   * Evens out the speed of streamed text, so it appears word by word instead
   * of in bursts. `true` uses the AI SDK defaults; pass `delayInMs` or
   * `chunking` to tune it. Only affects display.
   */
  smoothStream?: boolean | { delayInMs?: number; chunking?: "word" | "line" };
  /**
   * The most model steps (a step is one model call and the tools it calls) a
   * turn may take before it stops. `"unlimited"` lets the agent run until it
   * stops calling tools; use with care, as nothing then stops a runaway loop.
   *
   * @default 20
   */
  maxSteps?: number | "unlimited";
  /**
   * Limits the agent to these tools, by name (connection tools are prefixed,
   * like `github_create_issue`). Sign-in tools such as `connect_<name>` stay
   * available.
   *
   * @default all tools
   */
  enabledTools?: string[];
  /**
   * Replaces tool descriptions for this agent, by tool name: tailor how a
   * connection's tool is described to the model without changing the tool.
   */
  toolDescriptions?: Record<string, string>;
  /**
   * Agents this one can hand work to, by name. The agent gets a `spawn_agent`
   * tool: the other agent runs on its own and its final answer comes back as
   * the tool's result. Each handover is a saved thread the agent can continue
   * with the returned `threadId`. A subagent's approval requests are shown in
   * the parent chat.
   */
  subagents?: string[];
  /**
   * Gives the agent a workspace with files and a shell, one per chat, plus
   * the tools that use it: `bash`, `read_file`, `write_file`, `glob`, `grep`.
   * Needs `sandbox` and `harnessTools` in the runtime config.
   */
  sandbox?: boolean;
  /** Which sandbox provider to use, for example `"daytona"`. Passed to the runtime's `sandbox` function, which picks the default. */
  sandboxProvider?: string;
  /**
   * Adds the built-in app tools: `web_fetch`, `askUser`, `list_schedules`,
   * `cancel_schedule`. `true` adds all of them; a list adds only those. Needs
   * `harnessTools` in the runtime config.
   */
  defaultTools?: boolean | string[];
  /**
   * Adds tools that open web pages in a real browser, for pages that need
   * JavaScript to show their content. Needs `harnessTools.render`, which you
   * supply with a deployed render service.
   */
  renderTools?: boolean;
  /** Built-in tools to leave out for this agent, by name. */
  disableTools?: string[];
  /**
   * Uses the model provider's own web search and fetch, run on the provider's
   * side. Anthropic offers search and fetch, OpenAI search only; other
   * providers ignore it. Needs `resolveProviderTools` in the runtime config.
   */
  providerWebTools?: boolean;
  /**
   * How hard a reasoning model thinks before answering. Higher is slower and
   * costs more. Ignored by models that don't reason. Needs
   * `resolveReasoningOptions` in the runtime config.
   *
   * @default the provider's default
   */
  effort?: "minimal" | "low" | "medium" | "high";
  /**
   * Long-term memory across conversations: what the agent learns is added to
   * its instructions on later turns, and it gets tools to search and save
   * memories. Needs `memory` in the runtime config.
   */
  memory?: MemoryConfig;
  /**
   * Extensions for this agent's runs, applied after the runtime-wide ones.
   */
  extensions?: Extension[];
}

/** How an agent is shown in a picker. Returned by `runtime.listAgents()`. */
export interface AgentMeta {
  /**
   * The name shown to users.
   *
   * @default the agent's key in `agents`
   */
  title?: string;
  /** One line on what the agent does. */
  description?: string;
  /**
   * Hides the agent from pickers. It still runs when called by name, for
   * example as a subagent. `listAgents()` returns it with this flag set; the
   * HTTP server's agent list leaves it out.
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
