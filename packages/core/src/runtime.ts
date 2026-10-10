import {
  ToolLoopAgent,
  consumeStream,
  createIdGenerator,
  createUIMessageStream,
  createUIMessageStreamResponse,
  jsonSchema,
  readUIMessageStream,
  smoothStream,
  stepCountIs,
  tool,
  toUIMessageStream,
} from "ai";
import type { Experimental_SandboxSession, Instructions, LanguageModel, ToolSet } from "ai";
import { acceptUserMessage, contextData, contextOf, InvalidMessageError, isHidden, lastQuestionResent, latestMessageContext, type AppMessage } from "./message.js";
import type { ReconstructPrincipal } from "./principal.js";
import { toContextDefinition, type ContextInput, type ToolContext } from "./context.js";
import type {
  AgentConfig,
  AgentFactory,
  AgentInfo,
  OpenToolSet,
  ToolSource,
} from "./agent.js";
import { ParamsFixedError, paramsToSave, validateParams } from "./agent.js";
import { asSchema, type FlexibleSchema } from "ai";
import { currentDateLine } from "./current-date.js";
import type { MemoryProvider } from "./memory.js";
import {
  COMPACTION_PART_TYPE,
  sliceAtCompaction,
  toClientMessages,
  toModelMessages,
} from "./projections.js";
import { summarizeForCompaction } from "./compaction.js";
import { safeFileDownload } from "./file-download.js";
import { computeCost, type Pricing } from "./pricing.js";
import {
  defaultPromptCachingPlan,
  markLastFunctionTool,
  mergeProviderOptions,
  toolsetHash,
  type PromptCachingPlan,
} from "./prompt-caching.js";
import type { TurnTrigger, LatchTelemetry, TelemetryRunMeta } from "./telemetry.js";
import {
  LimitExceededError,
  exceededPolicy,
  remainingTokens,
  windowRef,
  type LatchLimits,
  type LimitPolicy,
  type LimitUsage,
  type LimitWindowRef,
} from "./limits.js";
import {
  isOwnerKeyMismatchError,
  type ChatRecord,
  type OwnerKeyMismatchError,
  type RunLease,
  type RunFence,
  type RunRecord,
  type RunSettings,
  type RunStatus,
  type ScheduleRecord,
  type StorageAdapter,
} from "./storage.js";
import {
  compose,
  fireClientToolResults,
  insertStepParts,
  isNewSession,
  lastUserTextOf,
  renderTranscript,
  replaceLastUserText,
  wrapTools,
  type Extension,
  type Part,
  type Principal as ExtensionPrincipal,
  type RunContext as ExtensionRunContext,
  type StepContext as ExtensionStepContext,
  type StepInfo as ExtensionStepInfo,
} from "./extensions/index.js";

/**
 * The Runtime — composition root + operations facade.
 *
 * `createRuntime(config)` wires the chosen seams (storage, context, agent
 * registry) and exposes the operations. Routes/cron/CLI/tests all call the
 * runtime, never the seams directly. It's stateless and re-creatable (holds
 * adapters, no per-run state — that lives in the DB), so it's serverless-safe.
 *
 * T1: `handleChat` runs one turn with a `ToolLoopAgent` and persists via the
 * stock AI SDK stream helper — `onStepEnd` → runs/usage, `onFinish` → messages.
 */
// T2 durability (opt-in). When enabled, each turn claims a single-writer lease,
// heartbeats it while streaming, and aborts if the lease is lost. A reaper
// (`runtime.cron()` → `sweep`, driven by cron) reclaims runs whose owner died.
/**
 * Crash recovery. With it on, a run that was cut off (the server crashed or
 * was redeployed mid-answer) is picked up by another server and finished, and
 * no two servers ever work on the same run at once.
 */
export interface DurabilityConfig {
  /**
   * Turn crash recovery on. You also need to call `runtime.cron()` regularly
   * (for example from a cron route every minute): that is what finds and
   * resumes interrupted runs.
   *
   * @default false
   */
  enabled?: boolean;
  /**
   * How long a server's claim on a run lasts without being renewed, in ms.
   * When a server dies, its runs are picked up once this has passed, so a
   * crashed run is resumed after roughly this long plus your cron interval.
   *
   * @default 30_000
   */
  leaseTtlMs?: number;
  /**
   * How often a server renews its claim while a run is going, in ms. Keep it
   * well below `leaseTtlMs`, so a slow renewal never lets a live run expire.
   *
   * @default 10_000
   */
  heartbeatMs?: number;
  /**
   * A name for this server, recorded on the runs it claims. Set it to
   * something stable (a pod or instance name) to see in the database which
   * server owns which run.
   *
   * @default a random id per process
   */
  instanceId?: string;
}

/**
 * A connection registry seam: resolve a set of connection names to a single
 * per-turn tool source. `@intentface/latch-mcp`'s `McpConnections` satisfies
 * this structurally, so `core` stays decoupled from MCP. When set on the
 * runtime, an agent's `connections: [...]` names are resolved through it.
 */
export interface ConnectionRegistry<P> {
  hostFor(names: string[]): ToolSource<P>;
}

/**
 * A source of agents resolved at request time (e.g. DB/UI-created), consulted
 * when a name isn't in the static `agents` registry. Lets agents be data, not
 * just code — scoped per `Principal`. `@intentface` platforms back this with a
 * table; `resolve` builds the same `AgentConfig` a code agent would.
 */
/**
 * What the runtime knows about the turn a dynamic agent is being resolved for.
 * Optional on both sides: a store that ignores it behaves exactly as before.
 */
export interface DynamicAgentResolveContext {
  /**
   * The agent that spawned this one, when the chat is a subagent thread
   * (`ChatRecord.parentAgent`). Read on EVERY resolve of that thread — first
   * turn, approval resume, crash recovery — so a per-parent shaping of the
   * subagent (e.g. restricting a connector's tools to what the parent agent's
   * record allows) can never lapse on a later turn.
   */
  parentAgent?: string;
  /**
   * The turn runs unattended (cron / `runAgent` / an autonomous parent): HITL
   * approvals are waived. A store that would gate a tool can drop it instead.
   */
  autoApprove?: boolean;
}

export interface DynamicAgentStore<P> {
  /** Build an agent's config for this caller, or undefined if not found. */
  resolve(
    name: string,
    principal: P,
    ctx?: DynamicAgentResolveContext,
  ): AgentConfig<P> | undefined | Promise<AgentConfig<P> | undefined>;
  /** The caller's dynamic agents, for the picker. */
  list(principal: P): AgentInfo[] | Promise<AgentInfo[]>;
}

/**
 * Everything `createRuntime` takes. Only `storage`, `context` and `agents` are
 * required; every other option switches a capability on, and leaving it out
 * means that capability simply doesn't exist.
 */
export interface RuntimeConfig<P, RuntimeContext = unknown> {
  /**
   * Where conversations, runs, usage and schedules are stored. Use
   * `createSqliteAdapter` or `createPostgresAdapter` from
   * `@intentface/latch-drizzle`, or your own adapter (check it with
   * `registerStorageConformance` from `@intentface/latch-core/testing`).
   */
  storage: StorageAdapter<P>;
  /**
   * What your agents and tools can work with, built from who is asking at the
   * start of every turn, including resumed runs, approvals and schedule fires:
   * `async ({ principal }) => ({ db: dbFor(principal.orgId), … })`. Never
   * saved, so it can hold clients and functions and always reads current
   * values. Optional. The `{ build }` object from `defineContext` still works
   * but is deprecated.
   */
  context?: ContextInput<P, RuntimeContext>;
  /**
   * What the user is looking at, sent as a `data-context` part on their
   * message (the open file, the selection, a model pick). The model reads it
   * as text in that message; chat UIs don't show it; agent functions and
   * tools get the latest one as `messageContext`. It's saved with its
   * message, so a continuation of the answer sees the same values, and the
   * instructions stay the same between messages, which keeps prompt caching
   * working.
   *
   * Works without configuration. `schema` checks the part when a message
   * arrives (a mismatch is refused, 400); `toModel` decides how it reads to
   * the model (default: a `[Context]` block of `key: value` lines). An agent
   * can override `toModel` in its own `defineAgent` meta.
   */
  messageContext?: {
    schema?: FlexibleSchema;
    toModel?: (context: any) => string | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  /**
   * Your agents, by name: `{ support: defineAgent({ … }) }`. The name is what
   * clients send to pick an agent. Agents created by users at runtime come
   * from `dynamicAgents` instead.
   */
  // `any` context and params: with `createRuntime<Principal>(…)` the context
  // type is `unknown`, and each agent declares its own params, so a factory
  // typed for its own context and params must still fit the registry.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agents: Record<string, AgentFactory<P, any, any>>;
  /**
   * Crash recovery: a run cut off by a crash or redeploy is finished by
   * another server, and no two servers work on the same run at once.
   *
   * Without it, a crashed run stays unfinished until the user sends another
   * message.
   */
  durability?: DurabilityConfig;
  /**
   * Prices per model, so each run records what it cost. Needed for cost-based
   * limits and usage reports. `providerDefaults` from
   * `@intentface/latch-core/models` supplies it from a model catalog.
   *
   * Without it, every run's cost is recorded as 0.
   */
  pricing?: Pricing;
  /**
   * Turns the names in an agent's `connections: [...]` into tools, typically
   * MCP servers. Use `createMcpConnections` from `@intentface/latch-mcp`.
   *
   * Without it, an agent's `connections` are ignored.
   */
  connections?: ConnectionRegistry<P>;
  /**
   * Agents that live in a database rather than in code, such as agents your
   * users create in a UI. Looked up by name, per caller, when a name isn't in
   * `agents`. The Agent Builder's store
   * (`createPostgresAgentBuilderStore` or `createSqliteAgentBuilderStore` from
   * `@intentface/latch-drizzle`) provides `resolve` and `list`.
   *
   * Without it, only the agents in `agents` exist.
   */
  dynamicAgents?: DynamicAgentStore<P>;
  /**
   * Long-term memory for agents that declare `memory`: what they learned is
   * added to their instructions, and they get tools to search and save it.
   * Use `createMemoryProvider` from `@intentface/latch-memory`.
   *
   * **Experimental.** The only production store today is a Loredex workspace,
   * and the design may change.
   *
   * Without it, an agent's `memory` setting is ignored.
   */
  memory?: MemoryProvider<P>;
  /**
   * Rebuilds the caller's principal when nobody is there to send a request: a
   * scheduled run firing, or a crashed run being resumed. Use it to re-check
   * that the person still has access. Return `null` to refuse, which stops
   * the schedule or ends the run.
   *
   * Without it, the principal stored when the run or schedule was created is
   * used as it is, unchecked.
   *
   * @default (identity) => identity
   */
  reconstructPrincipal?: ReconstructPrincipal<P>;
  /**
   * Works out the next time a cron expression fires, so recurring schedules
   * can run. Wire a cron library, for example
   * `(expr, after, tz) => new Cron(expr, { timezone: tz }).nextRun(new Date(after))?.getTime() ?? null`
   * with `croner`.
   *
   * Without it, only one-off schedules can be created.
   */
  cron?: (expr: string, afterMs: number, timezone?: string) => number | null;
  /**
   * Runs a scheduled fire yourself, for example to post the result into a
   * Slack channel or a Telegram chat instead of a new web chat. Return `true`
   * when you handled it; return `false` to let Latch run it in a new chat as
   * usual (a stale or missing target, say). A throw, or a result that's
   * neither, counts as an error for that occurrence and nothing else runs,
   * since the hook may already have done the work: once you've delivered,
   * return `true` even if a later step fails.
   *
   * Return `{ handled: true, chatId, parked }` to tell Latch which chat the
   * fire ran in and whether it is waiting on a person; schedules that skip a
   * fire while the previous one waits need that.
   *
   * Without it, every scheduled fire runs in a new chat.
   */
  runSchedule?: (input: {
    schedule: ScheduleRecord;
    principal: P;
  }) => Promise<boolean | { handled: boolean; chatId?: string; parked?: boolean }>;
  /**
   * Provides a sandbox (a workspace with files and a shell) for agents that
   * set `sandbox: true`, one per chat. Return an AI SDK
   * `Experimental_SandboxSession` from any provider: a simulated shell, a
   * Daytona VM, and so on.
   *
   * Without it, `sandbox: true` on an agent has no effect.
   */
  sandbox?: (args: {
    principal: P;
    chatId: string;
    agent: string;
    provider?: string;
  }) => Experimental_SandboxSession | Promise<Experimental_SandboxSession>;
  /**
   * Built-in tools to offer agents: shell and file tools that work in the
   * sandbox, and app tools such as web fetch, asking the user a question and
   * scheduling. `defaultHarnessTools()` from `@intentface/latch-core/harness`
   * gives you the standard set. Each agent picks them up through its
   * `sandbox` and `defaultTools` settings.
   */
  harnessTools?: {
    /** Tools that work inside the agent's sandbox: `bash`, `read_file`, `write_file`, `glob`, `grep`. */
    sandbox?: Record<string, unknown>;
    /**
     * Tools that run in your server: `web_fetch`, `askUser`, scheduling, and
     * so on. Pass a function instead of an object when the tools must be
     * built per turn, for example to limit them to what the caller may access.
     */
    app?:
      | Record<string, unknown>
      | ((args: {
          principal: unknown;
          chatId: string;
          agent: string;
        }) => Record<string, unknown> | Promise<Record<string, unknown>>);
    /** Tools that render a web page in a browser. Only agents that set `renderTools: true` get them. */
    render?: Record<string, unknown>;
    /**
     * Which built-in tools need a person's approval by default, by tool name,
     * for example `{ create_schedule: "user-approval" }`. An agent's own
     * `toolApproval` overrides this for the tools it names.
     */
    approval?: Record<string, unknown>;
  };
  /**
   * Returns the model provider's own web tools (its server-side search and
   * fetch) for a model id, for agents that set `providerWebTools`. Return `{}`
   * for a provider without them. `providerDefaults` supplies it.
   */
  resolveProviderTools?: (modelId: string) => Record<string, unknown>;
  /**
   * Turns an agent's `effort` setting into the provider-specific reasoning
   * options for a model. Return `undefined` to leave the provider's default,
   * for example for a model that doesn't reason. `providerDefaults` supplies
   * it.
   *
   * Without it, `effort` on an agent has no effect.
   */
  resolveReasoningOptions?: (
    modelId: string,
    effort: string,
  ) => { providerOptions?: Record<string, unknown>; maxOutputTokens?: number } | undefined;
  /**
   * Controls prompt caching per model. Return `undefined` for a model to turn
   * caching off for it. `memoryScoped` is true when the system prompt differs
   * per person (an agent with memory), which matters for how OpenAI routes
   * its cache.
   *
   * Without it, caching is on for Anthropic and OpenAI models, which can cut
   * the cost of tool-heavy agents several times over. Turn it off everywhere
   * with `resolvePromptCaching: () => undefined`, or for one run with
   * `promptCaching: false`.
   */
  resolvePromptCaching?: (
    modelId: string,
    args: { agent: string; memoryScoped: boolean; principal: P },
  ) => PromptCachingPlan | undefined;
  /**
   * Observes runs: tracing, per-step and per-run callbacks. Use
   * `@intentface/latch-langfuse` for full tracing, or only the callbacks you
   * need (usage dashboards, alerts when a scheduled run waits on a person).
   * Subagent runs are reported too.
   *
   * Without it, nothing is observed.
   */
  telemetry?: LatchTelemetry<P>;
  /**
   * Called when the storage adapter refuses a call because its owner key
   * doesn't match the row (`OwnerKeyMismatchError`). Latch never retries it;
   * crash recovery and schedule firing leave that run or schedule alone, so an
   * interrupted answer stays unfinished until someone looks. Send it to your
   * alerting. It also appears in `cron()`'s `errors`.
   *
   * Without it, the mismatch is logged and nothing else happens.
   */
  onOwnerKeyMismatch?: (event: {
    error: OwnerKeyMismatchError;
    /** Where it happened: resuming a run, firing a schedule, or a turn. */
    during: "resume" | "schedule" | "turn";
    runId?: string;
    scheduleId?: string;
  }) => void | Promise<void>;
  /**
   * Usage limits per organization, user and agent: requests, tokens and cost
   * per time window. You decide which limits a run counts against; Latch
   * refuses a run over a limit (HTTP 429 with a retry time), stops a long run
   * when it uses up its token budget, and records usage when it finishes.
   *
   * Request limits hold even when many requests arrive at once. Token and
   * cost limits are checked against usage already recorded, so runs that are
   * still going can take them over by what those runs spend.
   *
   * Without it, nothing is limited.
   */
  limits?: LatchLimits<P>;
  /**
   * Extensions that apply to every run, before each agent's own. An
   * extension can react to points in a run (before a turn, after each step,
   * on finish) to add context, store data or stop the run.
   */
  // Order matters for `step_end`: list an extension that persists before ones
  // that observe. With none attached a turn is byte-identical to a runtime
  // without the seam.
  extensions?: Extension[];
  /**
   * The most bytes of files a user message may carry inline (as `data:` URLs,
   * which is how `useChat` sends attachments by default). Inline files travel
   * in the chat request and are stored in the message, then reloaded on every
   * turn; a message over the limit is refused (`InvalidMessageError`, HTTP
   * 400). Send larger files by URL.
   *
   * @default 20 MB
   */
  maxInlineFileBytes?: number;
}

/** What `handleChat` takes: one user message for one agent in one chat. */
export interface HandleChatInput<P> {
  /**
   * The agent to run, by name (a key of `agents`, or a dynamic agent's name).
   * Required for a new chat; a continuing chat uses the agent it was started
   * with when omitted.
   */
  agent?: string;
  /**
   * The chat to continue. Pass the same id on every message of a conversation;
   * a new id starts a new chat with that id. Omit it to start a new chat with
   * a generated id.
   */
  chatId?: string;
  /**
   * Who is asking, as your auth resolved it. Everything the run reads and
   * writes is scoped to this principal, so build it on the server, never from
   * client input.
   */
  principal: P;
  /**
   * The user's message, as `useChat` sends it. Accepted:
   * - a new user message with text and files (files sent inline count
   *   against `maxInlineFileBytes`);
   * - the chat's last question resent unchanged (`regenerate()`) or edited
   *   (`sendMessage({ messageId })`): the old answer is hidden, not deleted,
   *   and the agent answers again;
   * - the paused assistant message with approval answers on it
   *   (`addToolApprovalResponse` with `sendAutomaticallyWhen`): only the
   *   decisions are read, as `applyApproval` would.
   *
   * Anything else is refused: another role or part type (`InvalidMessageError`,
   * 400), or an earlier question regenerated or edited
   * (`RewindNotSupportedError`, 409; fork the chat instead).
   */
  message: AppMessage;
  /**
   * What the chat is about, for an agent that declares `params` (see
   * `defineAgent`). Pass them with the chat's first message; they're validated,
   * saved on the chat, and given to the agent on every later turn, so later
   * messages don't send them again. Sending the same params again is fine;
   * different ones are refused (`ParamsFixedError`, 409).
   */
  params?: unknown;
  /** @deprecated The original request. Missing when an answer continues; read what you need in your route. */
  request?: Request;
  /**
   * @deprecated Per-request data that isn't saved, so it is missing when an
   * answer continues after an approval, a crash or on a schedule. Use `params`
   * for what the chat is about, and a `data-context` part on the message for
   * what the user is looking at.
   */
  turnContext?: unknown;
}

/** What `runAgent` takes: one prompt, run to completion without a client. */
export interface RunAgentInput<P> {
  /** Who the run acts for. The run is scoped to this principal like a chat turn. */
  principal: P;
  /** The agent to run, by name. */
  agent: string;
  /** The task, as the user message. */
  prompt: string;
  /**
   * Files sent with the prompt: `url` is a data URL or a URL the model
   * provider can fetch. They come before the text in the user message.
   */
  files?: { url: string; mediaType: string; filename?: string }[];
  /** Continue an earlier `runAgent` thread instead of starting a new one. */
  threadId?: string;
  /**
   * What the run is about, for an agent that declares `params`: validated and
   * saved on the thread, so a resumed run gets them too. Continuing an existing
   * `threadId` with different params is refused.
   */
  params?: unknown;
  /**
   * What happens to tools that need a person's approval, since nobody is there
   * to give it:
   * - `true`: they don't run; the model is told they were blocked.
   * - `"simulate-success"`: they don't run; the model is told they succeeded.
   *   For testing what an agent would do next.
   * - `false`: they run for real, without approval.
   *
   * @default true
   */
  blockGated?: boolean | "simulate-success";
  /**
   * Set `false` to run without the agent's long-term memory: nothing is
   * recalled and nothing saved. Useful when running one agent over many test
   * inputs, so earlier inputs can't influence later ones.
   */
  memory?: boolean;
  /**
   * Run on a different model than the agent's own, for this run only. For
   * comparing models on the same task.
   */
  model?: LanguageModel;
  /**
   * @deprecated Per-request data that isn't saved, so it is missing when an
   * answer continues. Use the agent's `params`, or a `data-context` part on the
   * message.
   */
  turnContext?: unknown;
  /**
   * Set `false` to turn prompt caching off for this run, for example as the
   * control in a cost comparison.
   */
  promptCaching?: boolean;
  /**
   * How telemetry labels this run. Pass `"chat"` when a person is waiting on
   * the answer, for example a webhook that replies to them.
   *
   * @default "programmatic"
   */
  trigger?: TurnTrigger;
}

/** What `runAgent` returns. */
export interface RunAgentResult {
  /** The thread the run used. Pass it back as `threadId` to continue. */
  threadId: string;
  /** The agent's final answer. Empty when the run failed. */
  answer: string;
  /**
   * Why the run failed, when it did: the model provider refused, a tool source
   * wouldn't open, and so on.
   */
  error?: string;
}

/** What `applyApproval` takes: a person's decisions on tools waiting for approval. */
export interface ApplyApprovalInput<P> {
  /** The chat whose run is waiting. */
  chatId: string;
  /** Who is deciding. Must be allowed to see the chat. */
  principal: P;
  /**
   * One decision per approval request. A decision for a request that is no
   * longer waiting (already decided, or from an older message) is ignored.
   */
  decisions: ApprovalDecision[];
  /** @deprecated The original request. Missing when an answer continues; read what you need in your route. */
  request?: Request;
  /**
   * @deprecated Per-request data that isn't saved, so it is missing when an
   * answer continues. Use the agent's `params`, or a `data-context` part on the
   * message.
   */
  turnContext?: unknown;
}

/** What `applyToolResult` takes: the answer to a tool the client handles. */
export interface ApplyToolResultInput<P> {
  /** The chat whose run is waiting. */
  chatId: string;
  /** Who is answering. Must be allowed to see the chat. */
  principal: P;
  /** The tool call being answered, from the message part. */
  toolCallId: string;
  /** The tool's result, for example the user's answer to `askUser`. */
  output: unknown;
  /** @deprecated The original request. Missing when an answer continues; read what you need in your route. */
  request?: Request;
  /**
   * @deprecated Per-request data that isn't saved, so it is missing when an
   * answer continues. Use the agent's `params`, or a `data-context` part on the
   * message.
   */
  turnContext?: unknown;
}

/** What `schedule` takes: an agent run on a timer. */
export interface ScheduleInput<P> {
  /**
   * Who the schedule runs as. Every fire acts for this principal, re-checked
   * with `reconstructPrincipal` when one is configured.
   */
  principal: P;
  /** The agent to run, by name. */
  agent: string;
  /**
   * When to run, as a cron expression (`"0 9 * * 1"` is Mondays at 9:00).
   * `null` runs it once, on the next cron tick. Recurring schedules need
   * `cron` in the runtime config.
   */
  cron: string | null;
  /**
   * The time zone the cron expression is read in, for example
   * `"Europe/Helsinki"`.
   *
   * @default "UTC"
   */
  timezone?: string;
  /** The message the agent receives on every fire. */
  prompt: string;
  /**
   * Where the result should go, for your `runSchedule` hook to read (a Slack
   * channel, a Telegram chat). Saved as it is; Latch never reads it.
   */
  delivery?: unknown;
  /**
   * What to do when it's time to fire but the previous fire is still waiting
   * on a person (an approval nobody has given):
   * - `"skip"`: skip this fire, so unanswered runs don't pile up.
   * - `"fire"`: run anyway. For schedules where every fire matters, like a
   *   daily digest.
   *
   * @default "skip"
   */
  onParked?: "skip" | "fire";
  /**
   * Params for the agent (see `defineAgent`): checked now, saved with the
   * schedule, and given to the chat each fire starts.
   */
  params?: unknown;
}

/**
 * What one `runDue` pass did. A fire that ran and then stopped to wait for a
 * person counts in both `fired` and `parked`.
 */
export interface RunDueResult {
  /** Fires that ran. */
  fired: number;
  /** Fires that failed. */
  errors: number;
  /** Fires skipped because the previous one is still waiting on a person (`onParked: "skip"`). */
  skipped: number;
  /**
   * Fires that ran and then stopped, waiting on an approval or a question
   * nobody is there to answer. Tokens were spent and no answer was delivered,
   * so a non-zero number is worth looking at.
   */
  parked: number;
  /**
   * Fires refused because `reconstructPrincipal` returned `null` (the person
   * no longer has access). Their schedules are disabled.
   */
  rejected: number;
}

/** The runtime `createRuntime` returns. */
export interface Runtime<P> {
  /** The agents this person can use (yours and their dynamic ones), for an agent picker. */
  listAgents(principal: P): Promise<AgentInfo[]>;
  /**
   * Runs one chat turn and streams the answer. Returns a streaming `Response`
   * in the AI SDK's UI message format, ready to return from your route to
   * `useChat`. The run keeps going and is saved even if the client
   * disconnects.
   */
  handleChat(input: HandleChatInput<P>): Promise<Response>;
  /**
   * Runs an agent to completion without a client and returns its answer: for
   * webhooks, background jobs, tests and evaluations. Never throws for a run
   * that fails once started; the failure comes back as `error`.
   */
  runAgent(input: RunAgentInput<P>): Promise<RunAgentResult>;
  /**
   * Summarizes a long conversation so later turns send the model the summary
   * instead of the old messages. The stored history is kept in full. Returns
   * `null` when there is too little to summarize or the chat isn't the
   * caller's; throws `PendingApprovalError` while the chat waits on an
   * approval.
   */
  compactChat(input: {
    chatId: string;
    principal: P;
    /** What the summary should keep, for example `"keep the training plan"`. */
    focus?: string;
    request?: Request;
    turnContext?: unknown;
  }): Promise<{ summary: string; compacted: number } | null>;
  /**
   * A chat's messages for showing to the user, with internal messages left
   * out. Use it to render a conversation when the page loads.
   */
  loadHistory(input: {
    chatId: string;
    principal: P;
  }): Promise<AppMessage[]>;
  /**
   * The caller's chats, newest first, for a sidebar. Pass `kind: "user"` to
   * leave out the threads subagents use internally.
   */
  listChats(input: {
    principal: P;
    limit?: number;
    kind?: string;
  }): Promise<ChatRecord[]>;
  /** One chat, or `null` when it doesn't exist or isn't the caller's. */
  getChat(input: { principal: P; id: string }): Promise<ChatRecord | null>;
  /** The caller's runs, newest first, with status, usage and cost: for an activity or usage view. */
  listRuns(input: {
    principal: P;
    limit?: number;
  }): Promise<RunRecord[]>;
  /** One run, or `null` when it doesn't exist or its chat isn't the caller's. */
  getRun(input: { principal: P; runId: string }): Promise<RunRecord | null>;
  /**
   * Resumes one interrupted run and finishes it. Needs `durability`. Returns
   * `null` when the run can't be resumed: it already finished, or another
   * server has it. You rarely call this yourself; `cron()` does it.
   *
   * Pass the run record (from `reapExpiredRuns`, say) rather than its id when
   * your storage adapter checks or routes by owner key: the record carries it.
   */
  resume(run: string | Pick<RunRecord, "id" | "ownerKey">): Promise<RunOutcome | null>;
  /**
   * Finds runs whose server died and resumes them. Gives up on a run after
   * `maxAttempts` tries (default 5), so one that crashes every time can't loop
   * forever. Safe to call from every server at once. Needs `durability`;
   * `cron()` calls it for you.
   */
  sweep(opts?: {
    /** Pretend it is this time (epoch ms). For tests. */
    now?: number;
    /** @default 5 */
    maxAttempts?: number;
    error?: string;
  }): Promise<{
    reaped: RunRecord[];
    resumed: RunOutcome[];
    /** Runs whose recovery failed, one line each; the sweep carried on with the rest. */
    errors: string[];
  }>;
  /**
   * The one function to call on a timer: fires due schedules, then (with
   * `durability`) resumes interrupted runs. Call it every minute or so from a
   * cron route, or with `createIntervalScheduler`. Safe to call from every
   * server at once. Failures are returned in `errors`, never thrown.
   */
  cron(opts?: {
    /** Pretend it is this time (epoch ms). For tests. */
    now?: number;
    /** @default 5 */
    maxAttempts?: number;
  }): Promise<{
    due: RunDueResult;
    reaped: RunRecord[];
    resumed: RunOutcome[];
    /** What failed, as `"runDue: …"` or `"sweep: …"`. */
    errors: string[];
  }>;
  /**
   * Records a person's approve or deny decisions and continues the run:
   * approved tools run, denied ones don't. Returns the continuation as a
   * streaming `Response`. Works from any device or channel, any time later,
   * because the waiting state is stored in the conversation. Repeated or
   * stale decisions are ignored.
   */
  applyApproval(input: ApplyApprovalInput<P>): Promise<Response>;
  /**
   * Answers a tool the client handles (one without `execute`, like `askUser`)
   * and continues the run. Returns the continuation as a streaming `Response`,
   * or an empty response while other client tools in the same step still need
   * answers.
   */
  applyToolResult(input: ApplyToolResultInput<P>): Promise<Response>;
  /** Schedules an agent to run on a timer, as the caller. */
  schedule(input: ScheduleInput<P>): Promise<ScheduleRecord>;
  /** The caller's schedules. */
  listSchedules(input: { principal: P }): Promise<ScheduleRecord[]>;
  /** Deletes one of the caller's schedules. */
  unschedule(input: { principal: P; id: string }): Promise<void>;
  /**
   * Makes one of the caller's schedules fire on the next cron tick, exactly
   * as a timed fire would. Returns `false` when there was nothing to run:
   * the id is unknown, not the caller's, or a one-off that already ran.
   */
  runScheduleNow(input: { principal: P; id: string }): Promise<boolean>;
  /**
   * Fires every schedule that is due, for all customers. `cron()` calls it;
   * call it directly only if you drive schedules separately from crash
   * recovery. Waits for each fired run to finish.
   */
  // Occurrences are at-most-once: `nextRunAt` advances BEFORE firing, so no
  // concurrent claimer can fire it again, and a process that dies mid-fire
  // does not retry the occurrence — the run row survives and `sweep()` resumes
  // the turn instead, so recovery never means a second paid attempt.
  runDue(opts?: { now?: number }): Promise<RunDueResult>;
}

/** A person's decision on one tool waiting for approval. */
export interface ApprovalDecision {
  /** The approval request's id, from the tool part's `approval.id`. */
  approvalId: string;
  /** `true` lets the tool run; `false` stops it. */
  approved: boolean;
  /** Why, shown to the model, for example why a request was denied. */
  reason?: string;
}

/** The terminal state of a resumed run. */
export interface RunOutcome {
  runId: string;
  status: RunStatus;
  attempt: number | null;
}

/**
 * The minimal `UIMessageStreamWriter` surface we use: `merge` to fold in the
 * model's stream, and `write` for custom data parts (exposed to tools/context).
 */
export interface TurnWriter {
  write(part: unknown): void;
  merge(stream: ReadableStream<unknown>): void;
}

/**
 * The `data-subagent-progress` part `spawn_agent` streams into the PARENT
 * turn while a subagent runs (one part, reconciled in place by id) — lets the
 * host render the delegated conversation live instead of a silent spinner.
 * Written immediately on spawn (empty `messages`) so the client learns the
 * sub-thread id up front, then re-written (throttled) as the subagent streams.
 */
export interface SubagentProgressData {
  /** The spawn_agent tool call this progress belongs to. */
  toolCallId?: string;
  agent: string;
  threadId: string;
  /** The sub-thread's current exchange: the prompt + the streaming assistant snapshot. */
  messages: AppMessage[];
}

/**
 * The `data-subagent-progress` writer for one delegation: `now` sends a
 * snapshot immediately, `throttled` at most every 250ms (each write re-sends
 * the whole snapshot). Shared by `spawn_agent` and the approval resume so both
 * write the SAME part id — a resumed delegation updates the one the client is
 * already showing instead of adding a second.
 */
function subagentProgressWriter(
  writer: TurnWriter,
  ids: { toolCallId?: string; agent: string; threadId: string },
): { now: (messages: AppMessage[]) => void; throttled: (messages: AppMessage[]) => void } {
  const now = (messages: AppMessage[]) => {
    writer.write({
      type: "data-subagent-progress",
      id: `subagent_${ids.toolCallId ?? ids.threadId}`,
      data: { ...ids, messages } satisfies SubagentProgressData,
    });
  };
  let lastWrite = 0;
  const throttled = (messages: AppMessage[]) => {
    const t = Date.now();
    if (t - lastWrite < 250) return;
    lastWrite = t;
    now(messages);
  };
  return { now, throttled };
}

/**
 * A `buildTurn` `observeStream` that folds the turn's UI chunks into message
 * snapshots and hands each to `onProgress` as `[...lead, ...assistant]`.
 * `continuing` is the assistant message a resume extends, so the snapshot keeps
 * the parts it already had. Observation must never break the run: errors are
 * swallowed, and the primary stream is drained independently.
 */
function progressObserver(
  lead: AppMessage[],
  onProgress: (messages: AppMessage[]) => void,
  continuing?: AppMessage,
): (observed: ReadableStream<unknown>) => void {
  return (observed) => {
    void (async () => {
      try {
        const byId = new Map<string, AppMessage>();
        for await (const m of readUIMessageStream({
          stream: observed as Parameters<typeof readUIMessageStream>[0]["stream"],
          ...(continuing ? { message: structuredClone(continuing) as never } : {}),
        })) {
          const msg = m as unknown as AppMessage;
          byId.set(msg.id, msg);
          onProgress([...lead, ...byId.values()]);
        }
      } catch {
        // ignore — live progress is best-effort
      }
    })();
  };
}

/**
 * What an unattended turn records on its run (`RunRecord.settings`): only what
 * differs from an attended chat turn's defaults, so a plain turn stores none.
 */
function runSettingsOf(o: {
  autoApprove: boolean;
  blockGated?: boolean | "simulate-success";
  memory?: boolean;
  promptCaching?: boolean;
  model?: LanguageModel;
}): RunSettings | undefined {
  const settings: RunSettings = {
    ...(o.autoApprove ? { autoApprove: true } : {}),
    ...(o.blockGated ? { blockGated: o.blockGated } : {}),
    ...(o.memory === false ? { memory: false } : {}),
    ...(o.promptCaching === false ? { promptCaching: false } : {}),
    ...(o.model ? { modelOverride: typeof o.model === "string" ? o.model : `${o.model.provider}:${o.model.modelId}` } : {}),
  };
  return Object.keys(settings).length ? settings : undefined;
}

/** JSON with object keys sorted, so two equal values compare equal however they were built. */
function stableJson(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
      : v,
  );
}

/** Ids for assistant response messages — `msg_<random>`, matching storage ids. */
const generateMessageId = createIdGenerator({ prefix: "msg", separator: "_" });
/** Sub-thread chat ids start with `sub_` so the host can keep them out of the
 * main chat list (they're nested under the parent's spawn_agent tool calls). */
const generateSubchatId = createIdGenerator({ prefix: "sub", separator: "_" });
/** Parent-level id for a subagent approval bubbled up via `spawn_agent`. */
const generateSubApprovalId = createIdGenerator({ prefix: "sapv", separator: "_" });
/** Recursion ceiling for subagent delegation. */
const MAX_SUBAGENT_DEPTH = 4;
/**
 * Below this many messages in the live window, compaction isn't worth a model
 * call: one exchange (user + assistant) plus the message asking for it summarizes
 * to roughly what it replaces.
 */
const MIN_COMPACTABLE_MESSAGES = 4;

const newInstanceId = createIdGenerator({ prefix: "inst", separator: "_" });

/** A tool/dynamic-tool UI part, narrowed to the approval fields we touch. */
type ApprovalPart = {
  type: string;
  state?: string;
  input?: unknown;
  approval?: { id: string; approved?: boolean; reason?: string };
};

/** A subagent's undecided approval, lifted so the parent turn can surface it. */
export interface SubagentPending {
  approvalId: string;
  toolName: string;
  summary: string;
}

/** One-line summary of a gated tool call, for the approval dialog. */
function summarizeApproval(toolName: string, input: unknown): string {
  let args = "";
  try {
    args = JSON.stringify(input ?? {});
  } catch {
    args = "";
  }
  if (args.length > 200) args = `${args.slice(0, 200)}…`;
  return `${toolName}(${args})`;
}

/** The undecided (`approved === undefined`) approvals in a thread's messages. */
function collectPendingApprovals(messages: AppMessage[]): SubagentPending[] {
  const out: SubagentPending[] = [];
  for (const m of messages) {
    for (const p of (m.parts ?? []) as ApprovalPart[]) {
      if (
        p.state === "approval-requested" &&
        p.approval &&
        p.approval.approved === undefined
      ) {
        const toolName = p.type.replace(/^tool-/, "");
        out.push({
          approvalId: p.approval.id,
          toolName,
          summary: summarizeApproval(toolName, p.input),
        });
      }
    }
  }
  return out;
}

/** The concatenated text of a message's text parts (for a chat title). */
/**
 * The decisions on an assistant message `useChat` sent back after
 * `addToolApprovalResponse`: each tool part the client marked
 * `approval-responded`, as `{ approvalId, approved, reason }`. Nothing else in
 * the message is read. A message carrying no decision is refused.
 */
function approvalDecisionsIn(message: AppMessage): ApprovalDecision[] {
  const decisions: ApprovalDecision[] = [];
  for (const part of (Array.isArray(message.parts) ? message.parts : []) as Array<{
    state?: unknown;
    approval?: { id?: unknown; approved?: unknown; reason?: unknown };
  }>) {
    const a = part?.approval;
    if (part?.state !== "approval-responded" || typeof a?.id !== "string" || typeof a.approved !== "boolean") continue;
    decisions.push({ approvalId: a.id, approved: a.approved, ...(typeof a.reason === "string" ? { reason: a.reason } : {}) });
  }
  if (decisions.length === 0) {
    throw new InvalidMessageError("an assistant message is only accepted when it carries approval decisions");
  }
  return decisions;
}

function firstText(message: AppMessage): string | undefined {
  const text = (message.parts ?? [])
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join(" ")
    .trim();
  return text.length > 0 ? text : undefined;
}

/** The text of the turn's incoming user message (for telemetry). */
/** The runtime's own user-role message: a compaction summary + boundary marker, not a turn. */
function isCompactionMarker(m: AppMessage): boolean {
  return (m.parts ?? []).some((p) => (p as { type: string }).type === COMPACTION_PART_TYPE);
}

/**
 * The model that ran THIS run, off the assistant message it produced (each one
 * carries its run id). Falls back to the tail when nothing is correlated —
 * the legacy shape — and to nothing when the run never produced a message.
 */
function ranAs(messages: AppMessage[], runId: string): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const owner = (m.metadata as { runId?: unknown } | undefined)?.runId;
    if (owner === runId || owner === undefined) return m.metadata?.model;
  }
  return undefined;
}

function lastUserText(messages: AppMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user") return firstText(m);
  }
  return undefined;
}

/**
 * Thrown when work is attempted on a chat whose last turn is still paused
 * awaiting a human — by `compactChat`, where the pause can also be a parked
 * client tool call and there's no sensible way to summarize around it. Carries
 * a stable `code` so the handler can map it to a 409 and the client can prompt
 * the user to resolve it first.
 *
 * `handleChat` deliberately does NOT throw this: a new message supersedes the
 * pause (see `declinePendingApprovals`).
 */
export class PendingApprovalError extends Error {
  readonly code = "pending_approval";
  constructor(message: string) {
    super(message);
    this.name = "PendingApprovalError";
  }
}

/** A bubbled-up subagent approval, carried as a `data-subagent-approval` part. */
type SubApprovalPart = {
  type: string;
  data?: {
    approvalId: string;
    subChatId: string;
    subApprovalIds: string[];
    spawnToolCallId?: string;
    summaries: string[];
    approved?: boolean;
    reason?: string;
    resolved?: boolean;
    /**
     * Telemetry linkage of the paused subagent turn, persisted here so the
     * resumed turn (post-approval) keeps nesting under the same trace/session
     * instead of defaulting `rootChatId` to its own `sub_…` chat and dropping
     * `parentRunId`. Set at bubble time; forwarded into the resumed `buildTurn`.
     */
    parentRunId?: string;
    rootChatId?: string;
  };
};

/**
 * Is the chat parked on an undecided approval RIGHT NOW?
 *
 * Only the last assistant message counts. A paused turn's gated calls all live
 * on the assistant message it paused on (a resume starts a new one), so that
 * message is the live pause point. Undecided parts in OLDER messages are
 * abandoned turns — `closeDanglingToolCalls` already fabricates a terminal
 * result for them in the model projection, and stored history is never
 * rewritten. Scanning all of history instead wedged chats permanently in both
 * directions: `handleChat` refused every new message with PendingApprovalError,
 * AND `applyApproval` returned an empty 200 without resuming, so no button
 * press could clear it either.
 */
function hasPendingApproval(messages: AppMessage[]): boolean {
  const last = messages[messages.length - 1];
  // Strictly the FINAL message: a later user message means the turn moved on.
  if (last?.role !== "assistant") return false;
  for (const p of (last.parts ?? []) as (ApprovalPart & SubApprovalPart)[]) {
    if (p.state === "approval-requested" && p.approval?.approved === undefined) {
      return true;
    }
    // A bubbled-up subagent approval still awaiting a decision.
    if (p.type === "data-subagent-approval" && p.data && p.data.approved === undefined) {
      return true;
    }
  }
  return false;
}

/** Why an approval was closed without the user ever deciding it. */
const SUPERSEDED_REASON =
  "Superseded — the user sent a new message instead of responding to this request.";

/**
 * Decline every undecided approval on the paused turn, because the user moved
 * on: they typed a new message instead of pressing a button.
 *
 * Without this a chat could wedge for good. A gate the user CAN'T satisfy — a
 * misconfigured `connect_<name>` whose OAuth never completes is the reported
 * case — left `handleChat` refusing every message with `PendingApprovalError`,
 * so the only escape was a decision UI that (on the web) had no deny button.
 * Declining is always the safe direction: no gated tool runs, and the model
 * sees a denial plus the new instruction, so the user can simply redirect it.
 *
 * Bubbled-up subagent approvals are marked `resolved` too, so
 * `collectDecidedSubagentApprovals` won't later try to resume a sub thread the
 * user has walked away from. Mutates in place; returns the changed messages.
 */
function declinePendingApprovals(messages: AppMessage[]): AppMessage[] {
  const last = messages[messages.length - 1];
  if (last?.role !== "assistant") return [];
  const changed = new Set<AppMessage>();
  for (const p of (last.parts ?? []) as (ApprovalPart & SubApprovalPart)[]) {
    if (p.state === "approval-requested" && p.approval && p.approval.approved === undefined) {
      p.state = "approval-responded";
      p.approval = { ...p.approval, approved: false, reason: SUPERSEDED_REASON };
      changed.add(last);
    }
    if (p.type === "data-subagent-approval" && p.data && p.data.approved === undefined) {
      const { spawnToolCallId, subChatId } = p.data;
      p.data = { ...p.data, approved: false, reason: SUPERSEDED_REASON, resolved: true };
      changed.add(last);
      // Close the parent's `spawn_agent` call too. Its stored result is the
      // `awaiting_approval` payload, whose note tells the model to stop and
      // wait for a decision that is never coming — and the model projection
      // drops data parts, so that note is ALL the next turn would see of this.
      if (spawnToolCallId) {
        for (const m of overwriteToolResult(messages, spawnToolCallId, {
          status: "declined",
          threadId: subChatId,
          note: SUPERSEDED_REASON,
        })) {
          changed.add(m);
        }
      }
    }
  }
  return [...changed];
}

/**
 * Record decisions onto matching `approval-requested` parts (→ `approval-responded`).
 * Mutates in place and returns the messages that changed (to re-persist).
 */
/**
 * Whether an approval belongs to the chat's LAST message — the only one a turn
 * can be paused on. Matches a gated tool part's `approval.id` or a bubbled
 * subagent approval's `data.approvalId`.
 */
function approvalIsLast(messages: AppMessage[], approvalId: string): boolean {
  const last = messages.at(-1);
  return ((last?.parts ?? []) as (ApprovalPart & SubApprovalPart)[]).some(
    (p) => p.approval?.id === approvalId || (p.type === "data-subagent-approval" && p.data?.approvalId === approvalId),
  );
}

/**
 * Whether an approval still awaits the agent: a gated call waiting for a
 * decision or decided but not yet run (no outcome recorded), or a bubbled
 * subagent approval not yet `resolved`.
 */
function approvalIsOpen(messages: AppMessage[], approvalId: string): boolean {
  for (const m of messages) {
    for (const p of (m.parts ?? []) as (ApprovalPart & SubApprovalPart)[]) {
      if (p.approval?.id === approvalId) return p.state === "approval-requested" || p.state === "approval-responded";
      if (p.type === "data-subagent-approval" && p.data?.approvalId === approvalId) return !p.data.resolved;
    }
  }
  return false;
}

function applyDecisions(
  messages: AppMessage[],
  decisions: ApprovalDecision[],
): AppMessage[] {
  const byId = new Map(decisions.map((d) => [d.approvalId, d]));
  const changed: AppMessage[] = [];
  for (const m of messages) {
    let touched = false;
    for (const p of (m.parts ?? []) as (ApprovalPart & SubApprovalPart)[]) {
      if (p.state === "approval-requested" && p.approval && byId.has(p.approval.id)) {
        const d = byId.get(p.approval.id)!;
        p.state = "approval-responded";
        p.approval = { ...p.approval, approved: d.approved, reason: d.reason };
        touched = true;
      }
      // A bubbled-up subagent approval — record the decision on the data part;
      // applyApproval routes it to the sub thread.
      if (
        p.type === "data-subagent-approval" &&
        p.data &&
        byId.has(p.data.approvalId)
      ) {
        const d = byId.get(p.data.approvalId)!;
        p.data = { ...p.data, approved: d.approved, reason: d.reason };
        touched = true;
      }
    }
    if (touched) changed.push(m);
  }
  return changed;
}

/** Overwrite a tool call's result (regardless of current state) — used to fold
 * a resumed subagent's answer back into the `spawn_agent` call on the parent. */
function overwriteToolResult(
  messages: AppMessage[],
  toolCallId: string,
  output: unknown,
): AppMessage[] {
  const changed: AppMessage[] = [];
  for (const m of messages) {
    let touched = false;
    for (const p of (m.parts ?? []) as ResultPart[]) {
      if (
        p.toolCallId === toolCallId &&
        (p.state === "output-available" || p.state === "input-available")
      ) {
        p.state = "output-available";
        p.output = output;
        touched = true;
      }
    }
    if (touched) changed.push(m);
  }
  return changed;
}

/** Decided-but-unresolved subagent approvals to route to their sub threads. */
function collectDecidedSubagentApprovals(
  messages: AppMessage[],
): NonNullable<SubApprovalPart["data"]>[] {
  const out: NonNullable<SubApprovalPart["data"]>[] = [];
  for (const m of messages) {
    for (const p of (m.parts ?? []) as SubApprovalPart[]) {
      if (
        p.type === "data-subagent-approval" &&
        p.data &&
        p.data.approved !== undefined &&
        !p.data.resolved
      ) {
        out.push(p.data);
      }
    }
  }
  return out;
}

/**
 * Re-bubble: append a fresh `data-subagent-approval` part next to a resolved
 * one (same parent assistant message), for a resumed subagent that paused on
 * ANOTHER gated tool. The undecided part keeps the parent `awaiting_input`;
 * deciding it round-trips through `applyApproval` again, so bubbling recurses
 * for as many rounds as the sub needs.
 */
function appendSubagentApprovalPart(
  messages: AppMessage[],
  afterApprovalId: string,
  data: NonNullable<SubApprovalPart["data"]>,
): AppMessage[] {
  for (const m of messages) {
    const parts = (m.parts ?? []) as (SubApprovalPart & { id?: string })[];
    if (
      parts.some(
        (p) =>
          p.type === "data-subagent-approval" &&
          p.data?.approvalId === afterApprovalId,
      )
    ) {
      parts.push({
        type: "data-subagent-approval",
        id: data.approvalId,
        data,
      });
      m.parts = parts as AppMessage["parts"];
      return [m];
    }
  }
  return [];
}

/** Mark a routed subagent approval resolved so it isn't re-processed. */
function markSubagentApprovalResolved(
  messages: AppMessage[],
  approvalId: string,
): AppMessage[] {
  const changed: AppMessage[] = [];
  for (const m of messages) {
    let touched = false;
    for (const p of (m.parts ?? []) as SubApprovalPart[]) {
      if (
        p.type === "data-subagent-approval" &&
        p.data &&
        p.data.approvalId === approvalId
      ) {
        p.data = { ...p.data, resolved: true };
        touched = true;
      }
    }
    if (touched) changed.push(m);
  }
  return changed;
}

/**
 * What crash recovery should DO with a run it just reclaimed, read off the tail
 * of persisted history.
 *
 * The subtlety this exists for: finishing the tool loop and RECORDING that fact
 * are two different writes. The per-step checkpoint is fire-and-forget at each
 * step's end, while the run row only becomes `completed` in `onFinish`. Die in
 * that gap and the row still says `active` with a lease — so the reaper takes a
 * run whose work is already done and whose answer is already stored.
 *
 * Re-running the model there is worse than useless: it pays for a second
 * generation, and (because the SDK reuses the message id) the new text lands in
 * the same message as the old, so the reader can end up with the answer twice.
 * Reconciling the row costs nothing and loses nothing.
 *
 *  - `superseded` — not produced here but by `supersededBy`, from the runs
 *    table: the chat opened a later turn while this run sat reaped. Settle it as
 *    errored with the same "superseded" outcome `openTurn` gives a stale run.
 *  - `decision-pending` — a gate is awaiting a human. The row never got its
 *    `awaiting_input`; settle it there and let `applyApproval` drive the rest.
 *    (Reaping is scoped to `active`, so this only ever arrives via that gap.)
 *  - `loop-finished` — the last step called no tool, which is exactly the
 *    condition on which the tool loop stops; or it is waiting on a CLIENT-
 *    handled tool (askUser), which `onFinish` also records as completed, the
 *    answer arriving later via `applyToolResult`. The turn is done; settle it.
 *  - `continue` — there is real work left (a tool result to consume, a step that
 *    produced nothing, or no assistant message at all). Re-run the model.
 *
 * The yardstick for every verdict: what `onFinish` would have written had the
 * process lived. That is what makes each one checkable — a `stopWhen` cut (step
 * cap, token budget) leaves a tool part in the final step and so reads as
 * `continue`, which costs a wasted turn but never loses work; the reverse
 * mistake, calling an unfinished turn finished, would silently drop the user's
 * request.
 *
 * The final step is the parts after the last `step-start`; a tool part there
 * means the loop had gone round again and was still going.
 */
export type ResumeShape = "superseded" | "decision-pending" | "loop-finished" | "continue";

/**
 * Has this chat opened another turn since `run` started? Then `run` was
 * superseded — the conversation moved on while it sat reaped — and it must
 * settle rather than run: re-running would generate against a conversation that
 * has moved on and, because the message id is reused, append the result to the
 * later turn's message.
 *
 * Read off the RUNS, not the messages. Every user message is persisted together
 * with its run (`openTurn`), so a later run in the chat is the one fact that
 * proves a later turn exists. Messages cannot tell us this: user messages carry
 * no run id, and when a turn crashes before its first checkpoint the previous
 * turn's assistant message is legitimately the last assistant in history —
 * reading either as "someone else's" marks a live run superseded and drops the
 * user's request without a model call, which is the one failure worse than the
 * bug this all fixes.
 *
 * Compaction runs summarise the conversation so far; they are not turns.
 */
export function supersededBy(
  run: Pick<RunRecord, "id" | "chatId" | "startedAt">,
  runs: readonly RunRecord[],
): boolean {
  return runs.some(
    (r) => r.chatId === run.chatId && r.id !== run.id && r.kind !== "compaction" && r.startedAt > run.startedAt,
  );
}

/**
 * What a reclaimed run's OWN history says it needs. Pure: whether the chat has
 * since moved on is `supersededBy`'s question, answered from the runs table.
 */
/**
 * The history to continue a run from, without a hidden tail: answers a
 * regenerate replaced (`sendToModel: false`) after the last message the turn
 * actually builds on. Left at the end, the AI SDK would treat such an answer
 * as the message to continue and write the new answer into it, where it would
 * stay hidden. The hidden answers stay stored; they're only left out here.
 */
function withoutHiddenTail(messages: AppMessage[]): AppMessage[] {
  let end = messages.length;
  while (end > 0 && messages[end - 1]!.metadata?.sendToModel === false) end--;
  return end === messages.length ? messages : messages.slice(0, end);
}

export function resumeShapeOf(messages: AppMessage[]): ResumeShape {
  // Compaction markers are not turns, so the tail is read past them: a summary
  // appended after a reaped run's finished message must not make that message
  // look like it was followed by a user turn (which would say "continue" and
  // regenerate against the summary). `compactChat` refuses while a gate or
  // client tool is pending, so a marker can never sit after an undecided one.
  let end = messages.length;
  // Hidden from the model too: an answer a regenerate replaced. If the crash
  // came after it was hidden, the turn still has to run from the user message.
  while (end > 0 && (isCompactionMarker(messages[end - 1]) || messages[end - 1]!.metadata?.sendToModel === false)) end--;
  const turns = end === messages.length ? messages : messages.slice(0, end);
  // Checked next: a pending gate outranks the tail's shape, and its own tail
  // (narration after the gated call) would otherwise read as `loop-finished`.
  if (hasPendingApproval(turns)) return "decision-pending";
  const last = turns[turns.length - 1];
  // Nothing of this turn was checkpointed (or a user message came last) — the
  // model has not spoken yet, so run it.
  if (last?.role !== "assistant") return "continue";
  const parts = (last.parts ?? []) as { type: string }[];
  let stepStart = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].type === "step-start") {
      stepStart = i;
      break;
    }
  }
  const finalStep = parts.slice(stepStart + 1) as Array<{
    type: string;
    toolCallId?: unknown;
    state?: unknown;
    providerExecuted?: unknown;
  }>;
  // A step that opened and produced nothing: the crash landed inside it, so
  // there is unfinished work regardless of what earlier steps did.
  if (finalStep.length === 0) return "continue";
  const toolParts = finalStep.filter((p) => p.type.startsWith("tool-") || p.type === "dynamic-tool");
  // A CLIENT-handled tool (no `execute`, e.g. askUser) is the one tool part a
  // checkpoint can hold with no result: the step's other tools ran, this one is
  // for the client to answer, and the loop stops because not every call has an
  // output. `onFinish` records that turn as `completed` and the answer arrives
  // later through `applyToolResult`, which opens its own run — so that is what
  // recovery must record too. Re-running instead would make the projection
  // close the call as "interrupted" and the model ask its question twice.
  // (A provider-executed tool still pending is the loop continuing, not a
  // client wait, so it must not match.)
  const awaitingClient = toolParts.some(
    (p) => p.state === "input-available" && typeof p.toolCallId === "string" && !p.providerExecuted,
  );
  if (awaitingClient) return "loop-finished";
  return toolParts.length > 0 ? "continue" : "loop-finished";
}

/**
 * The resume paths ({@link applyApproval} / {@link applyToolResult}) re-run the
 * model from history whose LAST message is the assistant turn that paused — no
 * fresh user message is appended. If that turn streamed trailing user-facing
 * text before pausing (e.g. "…ready to create the page but needs your approval
 * first"), the model projection ends on an assistant message. Some providers
 * reject that ("This model does not support assistant message prefill. The
 * conversation must end with a user message.").
 *
 * Drop the trailing text/reasoning that follows the final TOOL part of the last
 * assistant message, so the projection ends on the tool result (a user turn) and
 * the model generates a fresh continuation. Returns a shallow copy touching only
 * the last message.
 *
 * **The anchor must be a part the model projection keeps.** `toModelMessages`
 * drops every `data-*` part, so anchoring on a bubbled `data-subagent-approval`
 * kept the text BEFORE it — leaving the projection ending on assistant text,
 * i.e. exactly the prefill this exists to prevent. That is the shape the
 * agent-builder produces on every approval round: `… tool-spawn_agent,
 * data-subagent-progress, data-subagent-approval, step-start, text,
 * data-subagent-approval`. Only `tool-*` / `dynamic-tool` anchor.
 *
 * `data-*` parts after the anchor are KEPT: the resumed turn's `onFinish`
 * re-persists this message, so removing them would erase the approval markers
 * the UI renders and `hasPendingApproval` reads. Trailing `step-start` is
 * DROPPED along with the text: it is invisible content, but it instructs
 * `convertToModelMessages` to open a NEW assistant message — and with the text
 * gone, that message is empty, so the projection would still end on the
 * assistant (`{ role: "assistant", content: [] }`), trading the prefill
 * rejection for an empty-content one. The only thing in that step was the
 * narration being removed, so history loses nothing but an empty divider.
 * The trailing text is dropped from stored history too — it is provisional
 * commentary about a decision that has now been made; the resumed turn
 * regenerates the real continuation.
 */
export function trimTrailingAssistantPrefill(
  messages: AppMessage[],
  opts?: { unanchored?: boolean },
): AppMessage[] {
  if (messages.length === 0) return messages;
  const lastIndex = messages.length - 1;
  const last = messages[lastIndex];
  if (last.role !== "assistant") return messages;
  const parts = (last.parts ?? []) as { type: string }[];
  // Last part that survives into the model projection as a turn boundary.
  let anchor = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    const t = parts[i].type;
    if (t.startsWith("tool-") || t === "dynamic-tool") {
      anchor = i;
      break;
    }
  }
  // No tool anchor at all. On the DECISION paths that shape is not theirs to
  // judge, so leave it (a bubbled `data-subagent-approval` message carries its
  // narration and no `tool-*` part; trimming there would silently lose it).
  //
  // `unanchored` is belt and braces for CRASH RECOVERY, which cannot afford to
  // hand the model a prefill under any tail shape: with no anchor every prefill
  // part is dropped, which empties the message out of the model projection
  // entirely. Today `resumeShapeOf` settles the one anchorless tail a
  // checkpoint can actually produce (`[step-start, text]` — a tool-free turn,
  // which is `loop-finished`) before the trim is reached, so this branch is a
  // guard against a future classifier change, not a live path.
  if (anchor === -1 && !opts?.unanchored) return messages;
  // step-start joins text/reasoning: see the doc comment — keeping it ends the
  // projection on an EMPTY assistant message, which providers also reject.
  const isPrefill = (t: string) => t === "text" || t === "reasoning" || t === "step-start";
  const tail = parts.slice(anchor + 1);
  if (!tail.some((p) => isPrefill(p.type))) return messages;
  const kept = [...parts.slice(0, anchor + 1), ...tail.filter((p) => !isPrefill(p.type))];
  const trimmed = { ...last, parts: kept } as AppMessage;
  return [...messages.slice(0, lastIndex), trimmed];
}

/** A tool/dynamic-tool UI part, narrowed to the result fields we touch. */
type ResultPart = { type?: string; toolCallId?: string; state?: string; output?: unknown };

/**
 * True if any tool call is still awaiting a (client-supplied) result.
 *
 * Callers must pass only the messages of the step being resolved (see
 * `applyToolResult`) — NOT full history. A client tool call abandoned turns ago
 * stays `input-available` in stored history forever (`closeDanglingToolCalls`
 * repairs the model projection, never the store), so an all-history scan would
 * make every later resume in that chat return "still waiting" and never re-run.
 */
function hasPendingToolResult(messages: AppMessage[]): boolean {
  for (const m of messages) {
    for (const p of (m.parts ?? []) as ResultPart[]) {
      if (p.state === "input-available" && typeof p.toolCallId === "string") return true;
    }
  }
  return false;
}

/**
 * Record a tool `output` onto the matching tool call (input-available →
 * output-available). Mutates in place and returns the messages that changed.
 */
function recordToolResult(
  messages: AppMessage[],
  toolCallId: string,
  output: unknown,
): AppMessage[] {
  // Only the live pause point may be answered. A parked client tool call always
  // sits on the assistant message the turn paused on (a resume starts a new
  // one), so anything older was abandoned and buried by a later user turn.
  // Recording onto it would mutate dead history AND resume an obsolete turn —
  // a stale button, or a redelivered submit for a long-dead question, would
  // trigger a spurious agent run instead of doing nothing.
  const last = messages[messages.length - 1];
  if (last?.role !== "assistant") return [];
  let touched = false;
  for (const p of (last.parts ?? []) as ResultPart[]) {
    if (p.toolCallId === toolCallId && p.state === "input-available") {
      p.state = "output-available";
      p.output = output;
      touched = true;
    }
  }
  return touched ? [last] : [];
}

/** Run a hook fire-and-forget — a thrown/rejected hook is swallowed so
 * telemetry never breaks a turn. */
function fireAndForget(fn: (() => void | Promise<void>) | undefined): void {
  if (!fn) return;
  try {
    void Promise.resolve(fn()).catch(() => {});
  } catch {
    // synchronous throw from the hook — ignore
  }
}

/**
 * The one place an error becomes a client-visible string. Latch deliberately
 * forwards `Error` messages — they are the debugging surface for sandbox and
 * tool failures, and the audience is the org's own authenticated users — but
 * every stream/tool error path must route through here so the exposure policy
 * can be tightened in a single place. Non-`Error` throws and unbounded
 * payloads never pass through verbatim.
 */
/** Keys whose values are masked when a non-`Error` throw is serialized. */
const SECRETISH_KEY = /token|secret|password|authorization|cookie|api[-_]?key|credential/i;

/** The last `error` chunk's text in a UI message stream body (SSE `data:` lines), if any. */
function lastStreamError(body: string): string | undefined {
  let error: string | undefined;
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const chunk = JSON.parse(line.slice(6)) as { type?: string; errorText?: string };
      if (chunk.type === "error" && chunk.errorText) error = chunk.errorText;
    } catch {
      // "[DONE]" and other non-JSON lines
    }
  }
  return error;
}

export function clientErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : "";
  if (message) return message.length > 500 ? `${message.slice(0, 499)}…` : message;
  // A non-Error throw or an empty-message Error still carries signal — a raw
  // HTTP body, a JSON-RPC error object, a string. Describe it instead of
  // masking: the bare mask turned an MCP server's `404 {"error":"Session not
  // found"}` into an undebuggable generic string. Serialization masks
  // secret-shaped fields (a thrown response object can embed headers or
  // tokens) and stays bounded; JSON.stringify can throw on cycles, hence the
  // try. Exported so hosts render connection failures through the SAME
  // exposure policy instead of reinventing (String(err) → "[object Object]").
  if (error instanceof Error) {
    const name = error.name?.trim();
    if (name && name !== "Error") return `${name.slice(0, 100)} (no message)`;
  }
  try {
    const desc =
      typeof error === "string"
        ? error
        : JSON.stringify(error, (key, value) =>
            key && SECRETISH_KEY.test(key) ? "[redacted]" : (value as unknown),
          );
    if (desc && desc !== "{}" && desc !== "null" && desc !== '""' && desc !== "undefined") {
      return `An error occurred: ${desc.length > 300 ? `${desc.slice(0, 299)}…` : desc}`;
    }
  } catch {
    // circular or non-serializable — fall through to the mask
  }
  return "An error occurred.";
}

export function createRuntime<P, RC = unknown>(
  config: RuntimeConfig<P, RC>,
): Runtime<P> {
  const { storage } = config;
  const contextDef = toContextDefinition(config.context);
  const reconstructPrincipal: ReconstructPrincipal<P> =
    config.reconstructPrincipal ?? ((identity) => identity as P);
  const dur = {
    enabled: config.durability?.enabled ?? false,
    leaseTtlMs: config.durability?.leaseTtlMs ?? 30_000,
    heartbeatMs: config.durability?.heartbeatMs ?? 10_000,
    instanceId: config.durability?.instanceId ?? newInstanceId(),
  };
  if (dur.enabled && !storage.openTurn) {
    // Without `openTurn` a turn opens as two writes (run, then message), and a
    // crash between them leaves a run whose own message never landed. Recovery
    // then reads the PREVIOUS turn's tail as this run's history. Run
    // correlation catches the common shape, but the contract is explicit that
    // a durable adapter should be atomic here — every shipped adapter is.
    console.warn(
      "[latch] durability is enabled but the storage adapter has no openTurn(): " +
        "turn creation is not atomic, so a crash can leave a run without its message. " +
        "Implement openTurn — see the StorageAdapter contract.",
    );
  }

  /**
   * Params arriving with a message: for a new chat, validated against the
   * agent's schema and returned for saving; for an existing chat, they must
   * equal what it was started with (`ParamsFixedError` otherwise), and nothing
   * new is saved. An agent without a schema refuses params.
   */
  async function checkChatParams(agentName: string, chat: ChatRecord | null, incoming: unknown): Promise<unknown> {
    const schema = config.agents[agentName]?.meta?.params;
    if (!chat) return paramsToSave(agentName, schema, incoming);
    if (incoming === undefined) return undefined;
    const given = await paramsToSave(agentName, schema, incoming);
    if (stableJson(given) !== stableJson(chat.params)) throw new ParamsFixedError(chat.id);
    return undefined;
  }

  /** How a `data-context` part reads to this agent's model: its own `toModel`, else the runtime's, else the default. */
  function contextToTextFor(agentRef: string): ((data: unknown) => string | undefined) | undefined {
    const name = agentRef.split("@")[0]!;
    const own = config.agents[name]?.meta?.messageContext;
    if (own && "toModel" in own) return own.toModel ?? (() => undefined);
    return config.messageContext?.toModel;
  }

  /** A new message's `data-context`, checked against `messageContext.schema`; the message is refused on a mismatch. */
  async function checkMessageContext(message: AppMessage): Promise<AppMessage> {
    const schema = config.messageContext?.schema;
    const data = contextOf(message);
    if (!schema || data === undefined) return message;
    const check = asSchema(schema).validate;
    if (!check) return message;
    const result = await check(data);
    if (!result.success) throw new InvalidMessageError(`the data-context part doesn't match messageContext.schema: ${result.error.message}`);
    return {
      ...message,
      // The schema's output is what's saved, so it gets the same JSON and size
      // check as what the client sent: a transform can produce anything.
      parts: message.parts.map((p) => (p.type === "data-context" ? ({ type: "data-context", data: contextData(result.value) } as typeof p) : p)),
    };
  }

  /** Resolve an agent's per-request config + a display model id. */
  async function resolveAgentConfig(
    agentName: string,
    principal: P,
    request?: Request,
    turnContext?: unknown,
    /** Passed through to `dynamicAgents.resolve` (see DynamicAgentResolveContext). */
    resolveCtx?: DynamicAgentResolveContext,
    /** The chat's saved params (`ChatRecord.params`). */
    chatParams?: unknown,
    /** The `data-context` of the message being answered. */
    messageContext?: unknown,
  ): Promise<{ cfg: AgentConfig<P>; modelId: string; runtimeCtx: RC; params: unknown; messageContext: unknown }> {
    const runtimeCtx = await contextDef.build({ principal, request, turnContext });
    // Code-declared agents first; otherwise a dynamic (e.g. DB-stored) agent.
    const factory = config.agents[agentName];
    // Re-checked every turn, so the agent always gets its schema's output. An
    // agent without a schema gets none, whatever the chat holds.
    const schema = factory?.meta?.params;
    const params = schema ? await validateParams(agentName, schema, chatParams) : undefined;
    const cfg = factory
      ? await factory({ context: runtimeCtx, principal, params, messageContext, turnContext })
      : await config.dynamicAgents?.resolve(agentName, principal, resolveCtx);
    if (!cfg) throw new Error(`Unknown agent: ${agentName}`);
    const modelId =
      typeof cfg.model === "string"
        ? cfg.model
        : ((cfg.model as { modelId?: string }).modelId ?? "unknown");
    return { cfg, modelId, runtimeCtx, params, messageContext };
  }

  /** `buildTurnStream` as an SSE `Response` — what every chat-facing path returns. */
  async function buildTurn(args: Parameters<typeof buildTurnStream>[0]): Promise<Response> {
    return createUIMessageStreamResponse({
      stream: (await buildTurnStream(args)) as Parameters<typeof createUIMessageStreamResponse>[0]["stream"],
      consumeSseStream: consumeStream,
    });
  }

  /**
   * Build (and start) one turn's stream — shared by a fresh chat turn and a
   * resume. With durability on, it heartbeats the lease and aborts if it's
   * lost; onFinish writes are fenced by `lease`. The caller decides whether to
   * hand the stream to a client (handleChat) or drive it to completion
   * server-side (resume). Returned as the bare chunk stream (see `buildTurn`
   * for the `Response`) so `applyApproval`, which may already be streaming a
   * subagent resume, can merge the continuation into that response.
   */
  async function buildTurnStream(args: {
    resolvedChatId: string;
    principal: P;
    modelId: string;
    cfg: AgentConfig<P>;
    run: RunRecord;
    lease: RunLease | undefined;
    uiMessages: AppMessage[];
    runtimeCtx: RC;
    /** The chat's params, as the agent's schema returned them. */
    params?: unknown;
    /** The `data-context` of the message being answered. */
    messageContext?: unknown;
    /** Subagent runs: waive approvals + drop OAuth `connect_` gates (no human). */
    autoApprove?: boolean;
    /**
     * Test runs: instead of executing approval-gated (mutating) tools, stub them
     * to return a "blocked" result — so a trial run has no real side effects.
     * Only meaningful with `autoApprove` (an autonomous run).
     */
    blockGated?: boolean | "simulate-success";
    /** Per-turn memory override; `false` disables recall and memory tools. */
    memory?: boolean;
    /** Per-turn model override — replaces the agent's own for this turn. */
    model?: LanguageModel;
    /**
     * Per-turn prompt-caching override (defaults on when the runtime has a
     * `resolvePromptCaching` hook). `false` = set no caching options this turn
     * — the control arm of an A/B comparison.
     */
    promptCaching?: boolean;
    /** Delegation depth of this turn (top-level = 0); guards `spawn_agent`. */
    depth?: number;
    /**
     * What started this turn (see `TurnTrigger`). Stamped on every
     * telemetry run meta so a host can tell an unattended park — nobody to
     * answer the gate — from an interactive one. Defaults to `"chat"`.
     */
    trigger?: TurnTrigger;
    /** Telemetry linkage: the run that spawned this subagent turn (if any). */
    parentRunId?: string;
    /** Telemetry linkage: the top-level conversation id (threaded through
     *  subagent turns so a delegation tree shares one trace session). */
    rootChatId?: string;
    /**
     * Observe the turn's UI chunk stream without consuming it (the response
     * gets a tee'd branch). Used by `runToCompletion` to forward a subagent's
     * live output into the parent turn. The observer owns its branch — it
     * must keep reading or the tee buffers.
     */
    observeStream?: (stream: ReadableStream<unknown>) => void;
    /** The limits this turn was admitted under (see `admitTurn`); absent = unlimited. */
    admitted?: Admitted;
  }): Promise<ReadableStream<unknown>> {
    const { resolvedChatId, principal, run, lease, runtimeCtx } = args;
    // Every id-only write of this turn carries the run's owner key.
    const owned = ownedBy(run.ownerKey);
    // A per-turn model override replaces the agent's own, and the telemetry id
    // with it — a run row that says the agent's model while a different one
    // answered makes every later comparison a lie.
    const cfg = args.model ? { ...args.cfg, model: args.model } : args.cfg;
    const modelId = args.model
      ? typeof args.model === "string"
        ? args.model
        : ((args.model as { modelId?: string }).modelId ?? "unknown")
      : args.modelId;
    // Mutable: the start moments below may inject, replace or rewrite history
    // before the model runs. From here on this is the turn's transcript.
    let uiMessages = args.uiMessages;
    const admitted = args.admitted;
    const autoApprove = args.autoApprove ?? false;
    const blockGated = args.blockGated ?? false;
    const depth = args.depth ?? 0;
    const trigger = args.trigger ?? "chat";
    // The top-level conversation id — this turn's own chat unless a spawn
    // threaded a root down. Subagent turns spawned below inherit it, so a whole
    // delegation tree shares one telemetry session (see telemetryMeta).
    const rootChatId = args.rootChatId ?? resolvedChatId;

    // --- the extension seam --------------------------------------------------
    // Runtime-wide extensions first, then the agent's own. With none attached
    // every moment below is a no-op and the turn is byte-identical to a runtime
    // without the seam — `turn-snapshot.test.ts` holds it to that.
    const hooks = compose([...(config.extensions ?? []), ...(cfg.extensions ?? [])]);
    const xrun: ExtensionRunContext = {
      runId: run.id,
      principal: principal as unknown as ExtensionPrincipal,
    };
    const xctx = (stepNumber: number, messages: AppMessage[]): ExtensionStepContext => ({
      ...xrun,
      stepNumber,
      messages,
    });
    // A command an extension answered without the model (see the `input` moment).
    let handled: Part[] | undefined;
    // The start moments run once per conversation turn. A resume replays a
    // history they already shaped, and a decision continues a turn they
    // already opened — running them again would inject twice.
    const startMoments = trigger !== "resume" && trigger !== "decision";
    if (startMoments) {
      if (isNewSession(uiMessages))
        uiMessages = (await hooks.messagesIn("session_start", uiMessages, xrun)) as AppMessage[];
      uiMessages = (await hooks.messagesIn("before_agent_start", uiMessages, xrun)) as AppMessage[];
      const text = lastUserTextOf(uiMessages);
      if (text != null) {
        const e = await hooks.input(text, uiMessages, xrun);
        if (e && "handled" in e && e.handled) {
          const reply = e.reply;
          handled =
            typeof reply === "string"
              ? [{ type: "text", text: reply } as Part]
              : Array.isArray(reply)
                ? reply
                : [];
          if (e.replace) uiMessages = e.replace as AppMessage[];
        } else if (e && "transform" in e && e.transform != null) {
          uiMessages = replaceLastUserText(uiMessages, e.transform) as AppMessage[];
        }
      }
    }

    const abort = new AbortController();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const stopHeartbeat = () => {
      if (heartbeat !== undefined) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
    };
    if (dur.enabled && lease) {
      // A THROWN heartbeat write means "we don't know if we still hold the
      // lease" — very different from `held === false` ("someone else owns this
      // run"). Swallowing it silently let a run whose beats were all failing
      // keep streaming at full token cost while the reaper reclaimed it and a
      // second worker resumed the same turn. So: retry transient failures, but
      // once consecutive failures span a full TTL the lease has provably
      // expired — abort, exactly as if `held` had come back false.
      let missedBeats = 0;
      let beatInFlight = false;
      const maxMissedBeats = Math.max(1, Math.ceil(dur.leaseTtlMs / dur.heartbeatMs));
      const missBeat = (why: string, e?: unknown) => {
        missedBeats++;
        console.warn(
          `[durability] heartbeat ${why} for run ${run.id} (${missedBeats}/${maxMissedBeats})`,
          e ?? "",
        );
        if (missedBeats >= maxMissedBeats) {
          stopHeartbeat();
          abort.abort(new Error("lease lost: heartbeats failing for a full TTL"));
        }
      };
      heartbeat = setInterval(() => {
        // A write that never settles is as blind as one that throws — count it
        // against the TTL budget instead of stacking another write on top.
        if (beatInFlight) {
          missBeat("write still unsettled from the previous interval");
          return;
        }
        beatInFlight = true;
        void owned
          .heartbeatRun(run.id, lease.owner, dur.leaseTtlMs, lease.fencingToken)
          .then((held) => {
            missedBeats = 0;
            if (!held) {
              stopHeartbeat();
              abort.abort(new Error("lease lost"));
            }
          })
          .catch((e) => {
            // A key mismatch won't fix itself on the next beat: stop now, loudly.
            if (isOwnerKeyMismatchError(e)) {
              stopHeartbeat();
              abort.abort(e);
              void reportMismatch(e, { during: "turn", runId: run.id });
            } else missBeat("write failed", e);
          })
          .finally(() => {
            beatInFlight = false;
          });
      }, dur.heartbeatMs);
      // Don't let the heartbeat alone keep a Node process alive.
      (heartbeat as { unref?: () => void }).unref?.();
    }

    // Open dynamic tool sources (e.g. MCP) for this tenant, then merge their
    // tools with the static ones. They're closed when the turn ends. If opening
    // one fails, close any already opened so we don't leak connections.
    // Effective tool sources: the agent's own, plus a registry-resolved source
    // for its declared `connections` (its MCP servers / integrations).
    const sources = [...(cfg.toolSources ?? [])];
    if (config.connections && cfg.connections && cfg.connections.length > 0) {
      sources.push(config.connections.hostFor(cfg.connections));
    }

    const opened: OpenToolSet[] = [];
    try {
      // A command answered without the model needs no tools; don't open MCP
      // connections for `/stats`.
      for (const source of handled ? [] : sources) {
        opened.push(await source.open(principal));
      }
    } catch (error) {
      await Promise.all(opened.map((o) => o.close().catch(() => {})));
      stopHeartbeat();
      throw error;
    }
    const closeSources = () =>
      Promise.all(opened.map((o) => o.close().catch(() => {}))).then(
        () => undefined,
      );
    const tools = Object.assign({}, cfg.tools, ...opened.map((o) => o.tools));

    // Default harness tools (eve-mirrored), merged per the agent's flags. The
    // platform supplies them (core carries no sandbox/QuickJS dep): `sandbox`
    // tools (bash/read_file/write_file/glob/grep) operate on the resolved
    // Experimental_SandboxSession; `app` tools (web_fetch/todo/ask_question) run
    // in the app process. `disableTools` opts any of them back out.
    // Names that must stay callable even when `enabledTools` restricts the set
    // (it only restricts *connection* tools): the agent's own declared tools,
    // the harness tools, and `spawn_agent` are capabilities, not connection picks.
    const capabilityTools: string[] = Object.keys(cfg.tools ?? {});
    const harness = config.harnessTools ?? {};
    // Gate defaults for the harness tools this agent actually gets (a policy
    // naming an unattached tool would be dead weight in the merge below).
    const harnessApproval: Record<string, unknown> = {};
    const attachHarness = (name: string, t: unknown) => {
      tools[name] = t;
      capabilityTools.push(name);
      const gate = harness.approval?.[name];
      if (gate) harnessApproval[name] = gate;
    };
    const wantSandbox = !!cfg.sandbox && !!config.sandbox;
    if (wantSandbox && harness.sandbox) {
      for (const [name, t] of Object.entries(harness.sandbox)) attachHarness(name, t);
    }
    if (cfg.defaultTools && harness.app) {
      let appTools: Record<string, unknown>;
      if (typeof harness.app === "function") {
        try {
          appTools = await harness.app({ principal, chatId: resolvedChatId, agent: run.agent });
        } catch (error) {
          // Same teardown as a failing tool-source open above: the sources are
          // already open and the lease heartbeat is running — release both
          // before surfacing the factory error.
          await closeSources();
          stopHeartbeat();
          throw error;
        }
      } else {
        appTools = harness.app;
      }
      const only = Array.isArray(cfg.defaultTools) ? new Set(cfg.defaultTools) : null;
      for (const [name, t] of Object.entries(appTools)) {
        if (!only || only.has(name)) attachHarness(name, t);
      }
    }
    // Render tools — a separate capability (like sandbox), opted into via
    // `renderTools: true`, never granted by `defaultTools`.
    if (cfg.renderTools && harness.render) {
      for (const [name, t] of Object.entries(harness.render)) attachHarness(name, t);
    }
    // Provider-native web tools (server-side search/fetch), if the agent opts in
    // and the platform supplies a resolver for this model's provider.
    if (cfg.providerWebTools && config.resolveProviderTools) {
      for (const [name, t] of Object.entries(config.resolveProviderTools(modelId))) {
        tools[name] = t;
        capabilityTools.push(name);
      }
    }
    // Memory seam: when the agent declares `memory` and the runtime has a
    // provider, merge the scope-bound memory tools (capabilities, not
    // connection picks — they must survive an `enabledTools` restriction) and
    // append the provider's compiled-index block to the instructions. A
    // provider failure degrades to a turn without memory, never a dead turn.
    let instructions = cfg.instructions;
    const memoryOn = args.memory ?? true;
    if (memoryOn && cfg.memory && config.memory) {
      const memArgs = { principal, agent: run.agent, memory: cfg.memory };
      try {
        // Resolve both hooks BEFORE mutating the toolset, so a failure in
        // either leaves the turn exactly as it was without memory.
        const memoryTools = Object.entries(config.memory.toolsFor(memArgs));
        const block = await config.memory.instructionsFor(memArgs);
        for (const [name, t] of memoryTools) {
          tools[name] = t;
          capabilityTools.push(name);
        }
        if (block) instructions = [instructions, block].filter(Boolean).join("\n\n");
      } catch {
        // Memory is optional and degradable — continue without it.
      }
    }
    // instructions: an extension's appends land after the memory block; the
    // date line stays the tail (see the agent construction). A `replace` may
    // hand back system message(s) carrying providerOptions — the extension then
    // owns that shape, and the caching plan's system breakpoint steps aside.
    const composedInstructions: Instructions | undefined = hooks.has("instructions")
      ? await hooks.instructions(instructions, xctx(0, uiMessages))
      : instructions;
    for (const name of cfg.disableTools ?? []) delete tools[name];

    // Per-agent tool description overrides — swap the resolved tool's
    // description so the model sees the agent's custom guidance.
    if (cfg.toolDescriptions) {
      for (const [name, description] of Object.entries(cfg.toolDescriptions)) {
        const t = tools[name];
        if (t && description) tools[name] = { ...(t as object), description };
      }
    }

    // Subagent delegation: one `spawn_agent` tool that runs another agent and
    // returns its final answer. Skipped past the recursion ceiling.
    if (cfg.subagents?.length && depth < MAX_SUBAGENT_DEPTH) {
      const allowed = new Set(cfg.subagents);
      const infos = await agentInfos(principal);
      const lines = cfg.subagents
        .map((n) => {
          const i = infos.find((a) => a.name === n);
          return `- ${n}: ${i?.description ?? i?.title ?? "(no description)"}`;
        })
        .join("\n");
      tools.spawn_agent = tool({
        description:
          "Delegate a sub-task to one of your agents and get its final answer.\n" +
          `Available agents:\n${lines}\n\n` +
          "Omit threadId to start a new conversation; pass the threadId returned by a " +
          "previous call to continue with the SAME agent (it keeps full context). " +
          "Returns { threadId, answer }.",
        inputSchema: jsonSchema<{ agent: string; prompt: string; threadId?: string }>({
          type: "object",
          properties: {
            agent: { type: "string", description: "One of the available agent names above." },
            prompt: { type: "string", description: "The task / message for the subagent." },
            threadId: { type: "string", description: "Continue an existing subagent thread." },
          },
          required: ["agent", "prompt"],
          additionalProperties: false,
        }),
        execute: async (
          { agent, prompt, threadId }: { agent: string; prompt: string; threadId?: string },
          options: { toolCallId?: string; context?: { writer?: TurnWriter } },
        ) => {
          if (!allowed.has(agent)) return { error: `Not an allowed subagent: ${agent}` };
          // Stream the delegated conversation live into the parent turn (one
          // data part, reconciled in place by id). Pre-generate the sub-thread
          // id so the very first write already carries it.
          const writer = options.context?.writer;
          // `||` (not `??`): strict-schema models fill optional params with "" — an
          // empty threadId must mean "new thread", never become a real chat id.
          const subChatId = threadId?.trim() || generateSubchatId();
          let onProgress: ((messages: AppMessage[]) => void) | undefined;
          if (writer) {
            const progress = subagentProgressWriter(writer, {
              toolCallId: options.toolCallId,
              agent,
              threadId: subChatId,
            });
            progress.now([]);
            // The trailing tokens are covered by the tool RESULT (the client
            // switches to the persisted thread once output lands).
            onProgress = progress.throttled;
          }
          // Propagate the PARENT turn's execution mode AS A SET: interactive →
          // the subagent gates its tools (a pending write bubbles up here);
          // autonomous → it auto-approves; a TEST run (blockGated) stays a test
          // run all the way down, or a stubbed parent could delegate to a child
          // whose gated tools run for real.
          const result = await runToCompletion({
            principal,
            agent,
            message: userMessageOf(prompt),
            chatId: subChatId,
            depth: depth + 1,
            autoApprove,
            blockGated,
            // Memory off stays off down the tree: an eval turn's delegate must
            // not recall earlier inputs or save new memory either.
            ...(memoryOn ? {} : { memory: false }),
            onProgress,
            // Who is delegating — persisted on the sub-thread so every later
            // resolve of it can be shaped per parent (DynamicAgentResolveContext).
            parentAgent: run.agent,
            // Telemetry linkage: this turn is the parent; carry the root chat
            // down so the subagent's trace nests under this conversation.
            parentRunId: run.id,
            rootChatId,
            // A subagent inherits what set the tree off, so a scheduled fire's
            // delegate is still attributable to the schedule (see TurnTrigger).
            trigger,
          });
          if (result.pending?.length) {
            // The subagent paused on a gated tool. Surface it on THIS turn as a
            // `data-subagent-approval` part (tagged with the sub thread + this
            // spawn_agent call) so the turn ends `awaiting_input` and
            // `applyApproval` can route the decision back → resume the sub →
            // resume here. Raw sub output stays in the sub thread (isolation).
            const approvalId = generateSubApprovalId();
            writer?.write({
              type: "data-subagent-approval",
              id: approvalId,
              data: {
                approvalId,
                subChatId: result.chatId,
                subApprovalIds: result.pending.map((p) => p.approvalId),
                spawnToolCallId: options.toolCallId,
                summaries: result.pending.map((p) => p.summary),
                // Persist the sub-turn's telemetry linkage so its resumed turn
                // (after approval) stays nested under this conversation/run.
                parentRunId: run.id,
                rootChatId,
              },
            });
            return {
              status: "awaiting_approval",
              threadId: result.chatId,
              pending: result.pending.map((p) => p.summary),
              note: "Awaiting the user's approval — do not retry; stop here, the user will decide and you'll continue automatically.",
            };
          }
          return { threadId: result.chatId, answer: result.answer };
        },
      });
      capabilityTools.push("spawn_agent");
    }

    // register_tools: what extensions add are capabilities — always active, and
    // gated by the agent's own policy like any other tool. Mutated in place so
    // every later reference (toolsContext keys, the fingerprint) sees them.
    if (hooks.has("register_tools")) {
      const before = new Set(Object.keys(tools));
      const registered = hooks.tools(tools as ToolSet, xrun) as Record<string, unknown>;
      for (const k of Object.keys(tools)) if (!(k in registered)) delete tools[k];
      Object.assign(tools, registered);
      for (const name of Object.keys(tools)) if (!before.has(name)) capabilityTools.push(name);
    }
    // Outputs a CLIENT produced (a browser tool's answer) are already in the
    // transcript; fire tool_result for them now that the toolset can tell a
    // client tool from a server one.
    // A decision turn is exactly when a client's answer has just been recorded,
    // so it fires here too; a resume replays outputs an earlier run handled.
    if ((startMoments || trigger === "decision") && hooks.has("tool_result"))
      uiMessages = (await fireClientToolResults(uiMessages, tools as ToolSet, hooks, xrun)) as AppMessage[];

    // Subagent runs are autonomous — there's no human to authorize, so waive
    // approvals and drop the OAuth `connect_` gates (they'd pause forever).
    if (autoApprove) {
      for (const k of Object.keys(tools)) if (k.startsWith("connect_")) delete tools[k];
      // Test runs: stub the approval-gated (mutating) tools so a trial has no
      // real side effects. Gated set = connection defaults + the agent's policy.
      if (blockGated) {
        /**
         * Does this approval value actually gate the tool?
         *
         * NOT a truthiness check. The SDK spells a waiver as the STRING
         * `"not-applicable"` — which is truthy — so `if (v)` treated every
         * tool an agent had explicitly waived as gated and stubbed it. On an
         * agent whose reads are waived to override a connection default, that
         * is every read tool: the agent could not retrieve anything, and an
         * eval run measured a model with no access to its own corpus.
         *
         * Gated: `true`, `"user-approval"`, an object (approval with a
         * reason), a function. Waived: `false`, `undefined`,
         * `"not-applicable"`.
         */
        const gatedBy = (v: unknown): boolean =>
          v === true ||
          v === "user-approval" ||
          typeof v === "function" ||
          (typeof v === "object" && v !== null);

        const gated = new Set<string>();
        for (const [k, v] of Object.entries(harnessApproval)) if (gatedBy(v)) gated.add(k);
        for (const o of opened) {
          for (const [k, v] of Object.entries(o.toolApproval ?? {})) if (gatedBy(v)) gated.add(k);
        }
        if (cfg.toolApproval && typeof cfg.toolApproval !== "function") {
          for (const [k, v] of Object.entries(cfg.toolApproval as Record<string, unknown>)) {
            if (gatedBy(v)) gated.add(k);
            else gated.delete(k);
          }
        } else if (typeof cfg.toolApproval === "function") {
          // A function policy can't be enumerated — it may gate ANY tool. To keep
          // the test side-effect-free, conservatively block every executable tool
          // (connection, authored, and harness — `connect_` is already dropped).
          for (const k of Object.keys(tools)) gated.add(k);
        }
        for (const name of gated) {
          const t = tools[name] as { execute?: unknown } | undefined;
          if (t && typeof t.execute === "function") {
            tools[name] = {
              ...(t as object),
              execute: async (input: unknown) =>
                blockGated === "simulate-success"
                  ? {
                      ok: true,
                      __stubbed: true,
                      tool: name,
                      input,
                    }
                  : {
                      __blocked: true,
                      tool: name,
                      input,
                      reason:
                        "approval-gated tool blocked during test run (no real side effects)",
                    },
            };
          }
        }
      }
    }

    // Merge the default approval policies — harness-tool gates and the
    // source-contributed ones (connection defaults + synthetic `connect_<name>`
    // gates) — with the agent's. The AGENT WINS for tools it names, so an agent
    // can require approval on a GET or waive it on a mutating op; tools it
    // doesn't mention keep the default. Only for the object form (a function
    // policy is left as-is).
    const sourceApproval = Object.assign(
      {},
      harnessApproval,
      ...opened.map((o) => o.toolApproval ?? {}),
    ) as Record<string, unknown>;
    // An unattended run waives the AGENT's own policy — that is what makes a
    // delegated or programmatic turn autonomous. It does NOT waive the gates a
    // TOOL SOURCE contributed: a connection's gates are the end user's choice
    // about that connector ("deletes here must ask me"), and a harness gate is
    // the host's about that tool. Dropping those was the one thing they were
    // set to prevent, so they survive and the turn parks instead — a first-class
    // outcome (`runDue` reports `parked`; a subagent's gate bubbles to its
    // parent). `blockGated` is the opt-out: it has already stubbed those tools,
    // so gating them too would park a trial run that is meant to complete.
    const toolApproval = autoApprove
      ? blockGated || Object.keys(sourceApproval).length === 0
        ? undefined
        : sourceApproval
      : cfg.toolApproval && typeof cfg.toolApproval !== "function"
        ? { ...sourceApproval, ...(cfg.toolApproval as Record<string, unknown>) }
        : Object.keys(sourceApproval).length > 0 && !cfg.toolApproval
          ? sourceApproval
          : cfg.toolApproval;

    // Which tools the model may call. `enabledTools` restricts only CONNECTION
    // tools, so union in each source's `alwaysActive` (e.g. connect_<name>) AND
    // the capability tools (the agent's own tools, harness web_fetch/sandbox,
    // spawn_agent) — otherwise picking specific connection tools would hide the
    // harness. Omitted → all tools active.
    const alwaysActive = opened.flatMap((o) => o.alwaysActive ?? []);
    const activeTools = cfg.enabledTools
      ? // Exclude capability names that `disableTools` removed from `tools` (they
        // were pushed to capabilityTools before the delete) — never list a tool
        // in activeTools that isn't in the resolved toolset.
        Array.from(new Set([...cfg.enabledTools, ...alwaysActive, ...capabilityTools])).filter(
          (n) => n in tools,
        )
      : undefined;

    // Tool-loop ceiling: a number caps it; "unlimited" runs until the model
    // stops on its own; omitted → SDK default (stepCountIs(20)).
    const stepCap =
      cfg.maxSteps === "unlimited"
        ? stepCountIs(Number.MAX_SAFE_INTEGER)
        : typeof cfg.maxSteps === "number"
          ? stepCountIs(cfg.maxSteps)
          : undefined;
    // Mid-turn limit: stop the tool loop once THIS turn's tokens reach the
    // tightest remaining budget it was admitted with. The model's last text is
    // kept; no further step runs. (Counters were read at admission — concurrent
    // turns can overshoot by at most one turn each, which settlement records.)
    const tokenBudget = admitted?.remainingTokens;
    const budgetStop =
      tokenBudget !== undefined
        ? ({ steps }: { steps: { usage?: { inputTokens?: number; outputTokens?: number } }[] }) =>
            steps.reduce((n, st) => n + (st.usage?.inputTokens ?? 0) + (st.usage?.outputTokens ?? 0), 0) >=
            tokenBudget
        : undefined;
    // A delegation that paused on the user's approval ends the turn, exactly as
    // a gated tool of the agent's own does. A gated call has no result, so the
    // SDK stops there by itself; `spawn_agent` RETURNS one (`awaiting_approval`),
    // so without this the loop continues and only the result's note stands
    // between the model and a second delegation — another bubbled card per
    // step, up to the step cap. Added only when the agent can delegate, so
    // other agents' stop conditions stay exactly as configured.
    const subagentPauseStop = tools.spawn_agent
      ? ({ steps }: { steps: { toolResults?: { toolName: string; output?: unknown }[] }[] }) =>
          (steps.at(-1)?.toolResults ?? []).some(
            (r) =>
              r.toolName === "spawn_agent" &&
              (r.output as { status?: unknown } | undefined)?.status === "awaiting_approval",
          )
      : undefined;
    const extraStops = [budgetStop, subagentPauseStop].filter((s) => s !== undefined);
    const baseStopWhen = extraStops.length > 0 ? [stepCap ?? stepCountIs(20), ...extraStops] : stepCap;

    // --- step boundaries for the seam -------------------------------------------
    // A step ends twice from here: on the model side (`agent.stream`'s
    // onStepEnd — usage, finish reason, tool calls) and on the UI side (the
    // stream's onStepEnd — the assembled assistant message). `step_end` needs
    // both, so a step is SETTLED once both have arrived, and the next step's
    // prepareStep waits for the settlement: an extension that persists has
    // written before the model is called again. None of this runs when no
    // extension listens to a step moment.
    const stepHooks = hooks.has("step_start") || hooks.has("step_end");
    type ModelSide = {
      usage: unknown;
      finishReason: string;
      toolCalls: Array<{ toolName: string; toolCallId: string }>;
      model: { provider: string; modelId: string };
    };
    type Slot<T> = { promise: Promise<T>; resolve: (v: T) => void };
    const slotOf = <T,>(m: Map<number, Slot<T>>, k: number): Slot<T> => {
      let d = m.get(k);
      if (!d) {
        let resolve!: (v: T) => void;
        const promise = new Promise<T>((r) => (resolve = r));
        d = { promise, resolve };
        m.set(k, d);
      }
      return d;
    };
    const modelSide = new Map<number, Slot<ModelSide>>();
    const uiSide = new Map<number, Slot<AppMessage>>();
    const settledSteps = new Map<number, Promise<void>>();
    const appendedByStep = new Map<number, Part[]>();
    const stepStartedAt = new Map<number, number>();
    type StepControl = { stop: boolean; model?: LanguageModel; activeTools?: string[] };
    let control0: StepControl | undefined;
    let nextControl: StepControl | undefined;
    let stoppedBeforeStart = false;
    let uiStepIndex = 0;
    let stepsSeen = 0;
    let turnWriter: TurnWriter | undefined;
    let latestAssistant: AppMessage | undefined;
    // A continuation reuses the assistant message the SDK merges into; its
    // earlier step-start parts are not this run's steps.
    const anchor = uiMessages[uiMessages.length - 1];
    const anchorIsAssistant = anchor?.role === "assistant";
    const priorSteps = anchorIsAssistant
      ? (anchor!.parts as Array<{ type: string }>).filter((p) => p.type === "step-start").length
      : 0;
    const transcriptNow = (): AppMessage[] =>
      latestAssistant
        ? anchorIsAssistant
          ? [...uiMessages.slice(0, -1), latestAssistant]
          : [...uiMessages, latestAssistant]
        : uiMessages;
    // Assigned below, once the checkpoint chain exists; only ever called mid-stream.
    let settle: (k: number) => Promise<void> = async () => {};
    const extensionStop = stepHooks
      ? async ({ steps }: { steps: unknown[] }) => {
          const k = steps.length - 1;
          await settle(k);
          const c = await hooks.stepStart(xctx(steps.length, transcriptNow()));
          nextControl = c;
          return c.stop;
        }
      : undefined;
    const stopWhen = extensionStop
      ? [...(Array.isArray(baseStopWhen) ? baseStopWhen : [baseStopWhen ?? stepCountIs(20)]), extensionStop]
      : baseStopWhen;

    // Reasoning/thinking effort → provider-specific options (the platform maps
    // it per provider + gates to reasoning-capable models). Called even without
    // an effort so the hook can set safe defaults (e.g. lift a provider's tiny
    // default max_tokens for models that think by default); an absent/unknown
    // effort must be a thinking-config no-op in the hook.
    const reasoning = config.resolveReasoningOptions
      ? config.resolveReasoningOptions(modelId, cfg.effort ?? "")
      : undefined;

    // Prompt-caching plan for this model's provider (platform hook — see
    // `prompt-caching.ts` for the breakpoint layout). `promptCaching: false`
    // (e.g. the control arm of an A/B comparison) skips it for this turn only.
    const caching =
      args.promptCaching === false
        ? undefined
        : config.resolvePromptCaching
          ? config.resolvePromptCaching(modelId, {
              agent: run.agent,
              memoryScoped: !!(memoryOn && cfg.memory && config.memory),
              principal,
            })
          : // No hook → caching is ON by default for first-party Anthropic /
            // OpenAI models (derived from the model object's `provider`).
            // Measured at ~6x unit cost on MCP-heavy agents — too expensive to
            // leave off for hosts that never found the hook. Opt out with
            // `resolvePromptCaching: () => undefined`.
            defaultPromptCachingPlan(cfg.model, run.agent);
    if (caching?.toolProviderOptions) {
      markLastFunctionTool(tools, caching.toolProviderOptions, activeTools);
    }
    // Fingerprint the toolset the model will actually see — persisted on the
    // run so churn across a chat's turns (a cache invalidator) is queryable.
    const toolsHash = toolsetHash(activeTools ?? Object.keys(tools));
    const providerOptions = mergeProviderOptions(
      reasoning?.providerOptions,
      caching?.requestProviderOptions,
    );
    // tool_call / tool_result: wrap in place, after the caching marker and the
    // test-run stubs, so every later reference sees the same names. Identity-
    // preserving when no extension listens.
    if (hooks.has("tool_call") || hooks.has("tool_result")) {
      const wrapped = wrapTools(tools as ToolSet, hooks, xrun) as Record<string, unknown>;
      for (const k of Object.keys(wrapped)) tools[k] = wrapped[k];
    }

    // Telemetry seam: per-run AI SDK telemetry options + trace correlation
    // identity, resolved once per turn (undefined → nothing traced).
    const telemetryMeta: TelemetryRunMeta<P> = {
      runId: run.id,
      chatId: resolvedChatId,
      agent: run.agent,
      modelId,
      principal,
      startedAt: run.startedAt,
      agentVersion: cfg.configVersion,
      depth,
      trigger,
      parentRunId: args.parentRunId,
      // Top-level turns are their own root; subagent turns inherit the root the
      // spawn threaded down, so a whole delegation tree shares one session id.
      rootChatId,
    };
    const telemetryOptions = config.telemetry?.telemetryFor?.(telemetryMeta);
    // A telemetry impl that defines `telemetryFor` but returns undefined is
    // opting THIS run out — so the span wrapper and finish/flush hooks must go
    // silent too, not just the AI SDK settings. If `telemetryFor` is absent
    // entirely, the impl simply isn't customizing settings, so tracing stays on.
    const telemetryOn =
      !!config.telemetry &&
      !(config.telemetry.telemetryFor && telemetryOptions === undefined);

    const agent = new ToolLoopAgent({
      model: cfg.model,
      // File URLs the model can't fetch itself: capped, refused where
      // addresses can't be checked, and stopped with the run (see
      // `file-download.ts`). Not with the request: a run outlives its client.
      experimental_download: safeFileDownload({ signal: abort.signal }),
      // Every agent gets a trailing "today's date" line — after the memory
      // block, so it stays the tail. Day-granularity by design — see
      // `currentDateLine` for the prompt-cache reasoning. With a caching plan,
      // the instructions become a MARKED system message and the date line a
      // separate unmarked one, so the daily flip lands after the breakpoint
      // instead of invalidating it at midnight UTC.
      instructions:
        typeof composedInstructions === "object" && composedInstructions !== null
          ? // An extension replaced the system prompt with message(s) of its own,
            // providerOptions and all: keep them, with the date line as its own
            // trailing message so the daily flip stays past any breakpoint.
            [
              ...(Array.isArray(composedInstructions) ? composedInstructions : [composedInstructions]),
              { role: "system", content: currentDateLine() },
            ]
          : caching?.systemProviderOptions
            ? [
                ...(composedInstructions
                  ? [
                      {
                        role: "system",
                        content: composedInstructions,
                        providerOptions: caching.systemProviderOptions,
                      },
                    ]
                  : []),
                { role: "system", content: currentDateLine() },
              ]
            : [composedInstructions, currentDateLine()].filter(Boolean).join("\n\n"),
      tools,
      toolApproval,
      stopWhen,
      activeTools,
      ...(stepHooks
        ? {
            prepareStep: (async ({ stepNumber }: { stepNumber: number }) => {
              if (stepNumber > 0) await settle(stepNumber - 1);
              stepStartedAt.set(stepNumber, Date.now());
              const c = stepNumber === 0 ? control0 : nextControl;
              return {
                ...(c?.model ? { model: c.model } : {}),
                ...(c?.activeTools ? { activeTools: c.activeTools } : {}),
              };
            }) as never,
          }
        : {}),
      ...(providerOptions ? { providerOptions } : {}),
      ...(reasoning?.maxOutputTokens ? { maxOutputTokens: reasoning.maxOutputTokens } : {}),
      ...(telemetryOptions ? { telemetry: telemetryOptions } : {}),
    } as ConstructorParameters<typeof ToolLoopAgent>[0]);

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    // Set by the FIRST onError, consumed by onFinish (which the SDK still runs
    // after a stream error, and may precede with more than one onError). It is
    // what keeps the turn's terminal state single and ordered: the run row is
    // settled as errored FIRST, and exactly one errored report follows — only
    // from the writer whose fenced update applied.
    let failed: string | undefined;
    // Step checkpoints commit IN STEP ORDER. Each write is still fire-and-forget
    // for the stream, but chained behind the previous one, so a slow early
    // write can't commit after a later one and roll the row back to an older
    // step — and `onFinish` awaits the chain before its final write, so the
    // finished message is strictly the LAST write of the turn. Without that the
    // final step's checkpoint races `onFinish` for the same row: the parts are
    // equal by then, but a late checkpoint clobbers the usage/cost metadata
    // only `onFinish` stamps. The chain orders, it does not batch: each write
    // starts the moment the one before it commits, so a crash at step N loses
    // at most the write in flight and the one queued behind it. A failed write
    // logs and releases the chain — the next checkpoint still runs.
    let checkpoints: Promise<void> = Promise.resolve();
    // Message writes of a leased turn carry the lease, so the adapter refuses
    // them atomically once the run was reaped and re-claimed elsewhere.
    const fence: RunFence | undefined = lease ? { runId: run.id, ...lease } : undefined;
    const checkpoint = (message: AppMessage) => {
      if (!dur.enabled || abort.signal.aborted) return;
      checkpoints = checkpoints
        .then(async () => {
          // Re-checked at write time: the lease may have gone while this
          // checkpoint waited behind the previous one.
          if (abort.signal.aborted) return;
          const landed = await owned.appendMessages(resolvedChatId, [message], fence);
          // Refused by the fence: another worker owns the run now. Stop like
          // a lost heartbeat does, before this turn spends another step.
          if (landed === false) abort.abort(new Error("lease lost"));
        })
        .catch((e) => {
          if (isOwnerKeyMismatchError(e)) {
            abort.abort(e);
            void reportMismatch(e, { during: "turn", runId: run.id });
          } else console.warn(`[durability] step checkpoint failed for run ${run.id}:`, e);
        });
    };
    if (stepHooks) {
      const needUi = hooks.has("step_end");
      settle = (k) => {
        const known = settledSteps.get(k);
        if (known) return known;
        const p = (async () => {
          const model = await slotOf(modelSide, k).promise;
          const response = needUi ? await slotOf(uiSide, k).promise : undefined;
          const raw = model.usage as
            | {
                inputTokens?: number;
                outputTokens?: number;
                totalTokens?: number;
                inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
                outputTokenDetails?: { reasoningTokens?: number };
              }
            | undefined;
          // The SDK assembles the message from chunks; our parts were streamed
          // transient and never entered it. Fold every step's back in.
          const assistant = response
            ? (insertStepParts(response, appendedByStep, priorSteps) as AppMessage)
            : undefined;
          const messages = assistant
            ? anchorIsAssistant
              ? [...uiMessages.slice(0, -1), assistant]
              : [...uiMessages, assistant]
            : transcriptNow();
          const info: ExtensionStepInfo = {
            ...xctx(k, messages),
            usage: {
              inputTokens: raw?.inputTokens,
              outputTokens: raw?.outputTokens,
              totalTokens: raw?.totalTokens,
              cacheReadTokens: raw?.inputTokenDetails?.cacheReadTokens,
              cacheWriteTokens: raw?.inputTokenDetails?.cacheWriteTokens,
              reasoningTokens: raw?.outputTokenDetails?.reasoningTokens,
            },
            finishReason: model.finishReason,
            model: model.model,
            durationMs: Date.now() - (stepStartedAt.get(k) ?? Date.now()),
            toolCalls: model.toolCalls,
          };
          if (needUi) {
            const appended = await hooks.stepEnd(messages, info);
            if (appended.length) {
              appendedByStep.set(k, appended);
              // The client copy goes through the view rules and is TRANSIENT, so
              // the SDK's own merge cannot persist a viewed copy over the truth,
              // which is folded into the checkpoint and the finish below.
              for (const part of appended) {
                if (!part.type.startsWith("data-")) continue;
                const view = hooks.view(part, false, xrun);
                if (view && "hide" in view && view.hide) continue;
                const shown = view && "replace" in view && view.replace ? view.replace : part;
                turnWriter?.write({ type: shown.type, data: (shown as { data: unknown }).data, transient: true });
              }
            }
            latestAssistant = insertStepParts(response!, appendedByStep, priorSteps) as AppMessage;
            checkpoint(latestAssistant);
          }
        })();
        settledSteps.set(k, p);
        p.catch(() => {}); // surfaces where it is awaited: prepareStep, stopWhen, onFinish
        return p;
      };
    }

    // Post-turn telemetry: fired after persistence on every terminal path
    // (completed / awaiting_input / errored). Must never fail the turn.
    const reportRunFinished = async (
      status: "completed" | "awaiting_input" | "errored",
      messages: AppMessage[],
      error?: string,
    ) => {
      const t = config.telemetry;
      if (!t || !telemetryOn) return;
      try {
        await t.onRunFinished?.(telemetryMeta, {
          status,
          ...(error !== undefined ? { error } : {}),
          inputText: lastUserText(uiMessages),
          messages,
          usage: {
            inputTokens,
            outputTokens,
            ...(cacheReadTokens ? { cacheReadTokens } : {}),
            ...(cacheWriteTokens ? { cacheWriteTokens } : {}),
          },
          cost: computeCost(config.pricing?.(modelId), {
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
          }),
          endedAt: Date.now(),
        });
      } catch (e) {
        console.warn("latch telemetry onRunFinished failed:", e);
      } finally {
        // Always flush, even when the finish hook threw — otherwise a failed
        // judge/score pass would drop the turn's spans in serverless.
        try {
          await t.flush?.();
        } catch (e) {
          console.warn("latch telemetry flush failed:", e);
        }
      }
    };

    // Lower-level composition (vs `createAgentUIStreamResponse`) so we get the
    // UI-stream `onStepEnd` (per-step persistence) and the `writer`. The model
    // call runs INSIDE `execute` so the writer is live during the turn — code
    // here can write data parts (e.g. a compaction marker) before the model's
    // output, and tools can write via `toolsContext`.
    const stream = createUIMessageStream({
      originalMessages: uiMessages,
      // Persistence mode: one stable assistant-message id per turn (else every
      // turn would upsert onto the same row — see the dup-id regression test).
      generateId: generateMessageId,
      execute: async ({ writer }: { writer: TurnWriter }) => {
        turnWriter = writer;
        if (handled) {
          // A command an extension answered without the model. Emitted as an
          // ordinary assistant turn so the conversation reads normally and the
          // finish hook persists it like any other.
          writer.write({
            type: "start",
            messageId: generateMessageId(),
            messageMetadata: { visibility: "user", model: modelId, createdAt: Date.now(), runId: run.id },
          });
          for (const p of handled) {
            if (p.type === "text") {
              const id = generateMessageId();
              writer.write({ type: "text-start", id });
              writer.write({ type: "text-delta", id, delta: (p as { text: string }).text });
              writer.write({ type: "text-end", id });
              continue;
            }
            if (!p.type.startsWith("data-")) continue;
            const view = hooks.view(p, false, xrun);
            if (view && "hide" in view && view.hide) continue;
            const shown = view && "replace" in view && view.replace ? view.replace : p;
            writer.write({ type: shown.type, data: (shown as { data: unknown }).data });
          }
          writer.write({ type: "finish" });
          return;
        }
        // Model projection: drops `sendToModel:false` messages (and data-* parts).
        // `context` lets an extension reshape what the model reads this turn.
        const projected = await toModelMessages(uiMessages, { tools, contextToText: contextToTextFor(run.agent) });
        const modelMessages = hooks.has("context")
          ? await hooks.context(projected, xctx(0, uiMessages))
          : projected;
        // step_start for the first step — the SDK has no hook before its first call.
        control0 = stepHooks ? await hooks.stepStart(xctx(0, uiMessages)) : undefined;
        if (control0?.stop) {
          stoppedBeforeStart = true;
          writer.write({ type: "finish" });
          return;
        }
        // Per-session sandbox (one per chat) for agents that declared `sandbox`.
        // Exposed to sandbox tools as `options.experimental_sandbox`.
        const sandbox = wantSandbox
          ? await config.sandbox!({
              principal,
              chatId: resolvedChatId,
              agent: run.agent,
              provider: cfg.sandboxProvider,
            })
          : undefined;
        // Start the model call inside the telemetry run span (when provided)
        // so the impl can root every AI SDK span in one seeded trace.
        const startStream = () =>
          agent.stream({
          prompt: modelMessages,
          experimental_sandbox: sandbox,
          abortSignal: dur.enabled ? abort.signal : undefined,
          // Optional: smooth the visible token cadence before deltas stream out.
          experimental_transform: cfg.smoothStream
            ? smoothStream(cfg.smoothStream === true ? undefined : cfg.smoothStream)
            : undefined,
          // Shared context for hooks / prepareStep / approval policies.
          runtimeContext: runtimeCtx,
          // `toolsContext` is keyed BY TOOL NAME (the SDK does
          // `toolsContext[toolName]`), so point every tool at the same context:
          // the project's runtime context + who it's for + the run + the writer
          // + the runtime itself (so a harness tool can schedule, list chats or
          // spawn a run without reaching for a host-global). A tool reads it as
          // `options.context`.
          toolsContext: Object.fromEntries(
            Object.keys(tools).map((name) => [
              name,
              {
                ...(runtimeCtx as Record<string, unknown>),
                principal,
                runtime: self,
                // `agent` is the ref the turn resolved (scope-pinned as stored
                // on the run), so a tool that acts on "the agent I'm running
                // as" names the same record the turn is using.
                run: { id: run.id, chatId: resolvedChatId, agent: run.agent },
                writer,
                params: args.params,
                messageContext: args.messageContext,
              } satisfies ToolContext<P, Record<string, unknown>, unknown, unknown>,
            ]),
          ),
          // generate-text step callback: accumulate usage across steps,
          // including the cached-prompt breakdown so cost reflects cache reads.
          onStepEnd: (step: {
            stepNumber?: number;
            model?: { provider: string; modelId: string };
            response?: { modelId?: string };
            text?: string;
            finishReason?: string;
            usage?: {
              inputTokens?: number;
              outputTokens?: number;
              inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
            };
            toolCalls?: Array<{ toolCallId: string; toolName: string; input?: unknown }>;
            toolResults?: Array<{ toolCallId: string; toolName: string; output?: unknown }>;
          }) => {
            inputTokens += step.usage?.inputTokens ?? 0;
            outputTokens += step.usage?.outputTokens ?? 0;
            cacheReadTokens += step.usage?.inputTokenDetails?.cacheReadTokens ?? 0;
            cacheWriteTokens += step.usage?.inputTokenDetails?.cacheWriteTokens ?? 0;
            if (telemetryOn && config.telemetry?.onStep) {
              const onStep = config.telemetry.onStep.bind(config.telemetry);
              fireAndForget(() =>
                onStep(telemetryMeta, {
                  text: step.text,
                  finishReason: step.finishReason,
                  usage: {
                    inputTokens: step.usage?.inputTokens,
                    outputTokens: step.usage?.outputTokens,
                    cacheReadTokens: step.usage?.inputTokenDetails?.cacheReadTokens,
                    cacheWriteTokens: step.usage?.inputTokenDetails?.cacheWriteTokens,
                  },
                  toolCalls: step.toolCalls,
                  toolResults: step.toolResults,
                }),
              );
            }
            stepsSeen++;
            if (stepHooks && step.stepNumber !== undefined)
              slotOf(modelSide, step.stepNumber).resolve({
                usage: step.usage,
                finishReason: step.finishReason ?? "unknown",
                toolCalls: (step.toolCalls ?? []).map((c) => ({ toolName: c.toolName, toolCallId: c.toolCallId })),
                // The id the PROVIDER reports; pricing keys on that.
                model: {
                  provider: step.model?.provider ?? "",
                  modelId: step.response?.modelId ?? step.model?.modelId ?? modelId,
                },
              });
          },
        } as unknown as Parameters<typeof agent.stream>[0]);
        const result =
          telemetryOn && config.telemetry?.withRunSpan
            ? await config.telemetry.withRunSpan(telemetryMeta, startStream)
            : await startStream();
        // Fold the model's own output into the stream.
        writer.merge(
          toUIMessageStream({
            stream: result.stream,
            // Without this the AI SDK collapses every tool `execute` throw to
            // the literal "An error occurred." — surface the real message so
            // failures (sandbox init, credential lookups, …) are debuggable
            // from the chat itself.
            onError: clientErrorMessage,
            messageMetadata: ({ part }: { part: { type: string } }) =>
              part.type === "start"
                ? {
                    visibility: "user",
                    model: modelId,
                    createdAt: Date.now(),
                    // Correlates the assistant message to its run (and trace)
                    // — e.g. per-message feedback posts against this id.
                    runId: run.id,
                  }
                : undefined,
          } as Parameters<typeof toUIMessageStream>[0]) as ReadableStream<unknown>,
        );
      },
      // UI-stream per-step hook: checkpoint the in-progress assistant message
      // (with any completed tool results) so a crash mid-turn doesn't repeat
      // them on resume. Durable turns only — keeps T1 write counts unchanged.
      //
      // Fenced: once this worker has lost the lease, a reclaimed copy of the
      // run may be replaying into this same chat — a checkpoint from the
      // zombie would interleave with it, and every later resume replays the
      // polluted history. The write carries the lease (`fence`) and the
      // adapter checks it atomically with the insert; the abort-signal check
      // only saves a doomed write.
      onStepEnd:
        dur.enabled || hooks.has("step_end")
          ? ({ responseMessage }: { responseMessage: AppMessage }) => {
              if (hooks.has("step_end")) {
                // The step's parts are final only once `step_end` has appended
                // its own; `settle` writes the checkpoint after that.
                slotOf(uiSide, uiStepIndex).resolve(responseMessage);
                void settle(uiStepIndex++);
                return;
              }
              checkpoint(responseMessage);
            }
          : undefined,
      onFinish: async ({
        messages: finishedMessages,
        isAborted,
      }: {
        messages: AppMessage[];
        isAborted?: boolean;
      }) => {
        stopHeartbeat();
        await closeSources();
        let messages = finishedMessages;
        if (stepHooks && failed === undefined && !isAborted) {
          // Every step's `step_end` has run before the record is settled. A
          // critical extension's throw on an EARLIER step surfaced through the
          // stream (prepareStep rethrows it); on the LAST step nothing awaited
          // it yet, so it lands here — and fails the run just the same.
          try {
            await Promise.all([...settledSteps.values()]);
          } catch (e) {
            failed = clientErrorMessage(e);
          }
          if (appendedByStep.size) {
            const i = messages.length - 1;
            const last = messages[i];
            if (last?.role === "assistant")
              messages = [...messages.slice(0, i), insertStepParts(last, appendedByStep, priorSteps) as AppMessage];
          }
        }
        if (stoppedBeforeStart || handled)
          // Nothing (or nothing but a command with no reply) was said: the SDK
          // still assembles an empty assistant message from the bare `finish`,
          // and there is no reason to store a blank turn.
          messages = messages.filter((m) => !(m.role === "assistant" && (m.parts as unknown[]).length === 0));
        const agentEnd = (error?: unknown) =>
          hooks.has("agent_end")
            ? hooks.agentEnd({
                runId: run.id,
                principal: xrun.principal,
                messages,
                stepCount: stepsSeen,
                isAborted: isAborted === true,
                ...(error !== undefined ? { error } : {}),
                usage: {
                  inputTokens,
                  outputTokens,
                  ...(cacheReadTokens ? { cacheReadTokens } : {}),
                  ...(cacheWriteTokens ? { cacheWriteTokens } : {}),
                },
              })
            : Promise.resolve();
        // Cost for this turn (0 if no pricing configured). Stamp usage + cost
        // onto the assistant message — the message is complete; this is metadata.
        const cost = computeCost(config.pricing?.(modelId), {
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
        });
        const last = messages[messages.length - 1];
        if (last?.role === "assistant") {
          last.metadata = {
            ...last.metadata,
            usage: {
              inputTokens,
              outputTokens,
              ...(cacheReadTokens ? { cacheReadTokens } : {}),
              ...(cacheWriteTokens ? { cacheWriteTokens } : {}),
            },
            cost,
          };
        }
        // Errored (the stream failed — onError already reported it) or aborted
        // (lease lost): don't claim completion, and DON'T persist the partial
        // messages/usage — an aborted run may already be reaped and re-claimed
        // by another node whose writes must win. The guarded update no-ops if
        // the run was reassigned. Exactly one terminal report either way.
        if (failed !== undefined || isAborted) {
          const settled = await owned.updateRun(
            run.id,
            { status: "errored", error: failed ?? "aborted", endedAt: Date.now() },
            lease,
          );
          // Only the winning writer reports (same rule as the completion
          // path): a stale worker whose fenced update did not apply is not
          // the one that ended this run. The tokens WERE spent, though — a
          // failing turn settles against its budgets like any other, or a
          // token-only cap would never bound a run that keeps erroring.
          if (settled) {
            await settleLimits(admitted, { tokens: inputTokens + outputTokens, cost });
            await reportRunFinished("errored", messages, failed ?? "aborted");
            await agentEnd(failed ?? "aborted");
          }
          return;
        }
        // A gated tool ended the turn awaiting a decision — pause, don't
        // complete. The decision arrives via applyApproval (message state).
        const paused = hasPendingApproval(messages);
        // Every step checkpoint has committed (or failed and been logged)
        // BEFORE the row is settled. Recovery never revisits a completed run,
        // so the moment the row says `completed` the stored message must
        // already hold the final step — otherwise a crash between the settle
        // and the final write below loses the answer text, not just metadata.
        // Awaiting here also makes the final write the row's last one.
        await checkpoints;
        // Fenced finish: settle the run FIRST. If the guarded update doesn't
        // apply (our lease was reaped + the run re-claimed elsewhere), we're
        // a stale writer — skip the final message/usage persistence so we
        // don't overwrite the new owner's state.
        const applied = await owned.updateRun(
          run.id,
          {
            status: paused ? "awaiting_input" : "completed",
            usageInputTokens: inputTokens,
            usageOutputTokens: outputTokens,
            usageCacheReadTokens: cacheReadTokens || undefined,
            usageCacheWriteTokens: cacheWriteTokens || undefined,
            costTotal: cost,
            toolsHash,
            endedAt: paused ? undefined : Date.now(),
          },
          lease,
        );
        if (applied) {
          // Fenced too: the run row and the message are separate writes, and
          // the lease can be lost between them.
          await owned.appendMessages(resolvedChatId, messages, fence);
          await storage.recordUsage(principal, {
            runId: run.id,
            model: modelId,
            inputTokens,
            outputTokens,
            ...(cacheReadTokens ? { cacheReadTokens } : {}),
            ...(cacheWriteTokens ? { cacheWriteTokens } : {}),
            cost,
          });
          await settleLimits(admitted, { tokens: inputTokens + outputTokens, cost });
        }
        // Only the winning writer reports terminal telemetry. If our lease was
        // reaped and the run re-claimed elsewhere (`!applied`), that node will
        // finish it — a stale writer must not re-run the judge or emit a
        // duplicate "completed"/"awaiting_input" trace.
        if (applied) {
          await reportRunFinished(paused ? "awaiting_input" : "completed", messages);
          await agentEnd();
        }
      },
      onError: (error: unknown) => {
        stopHeartbeat();
        void closeSources();
        const message = clientErrorMessage(error);
        if (hooks.has("error"))
          void hooks.error({ error, stepNumber: stepsSeen, messages: transcriptNow() }, xrun);
        // Record only — the first error wins; later onError calls for the same
        // stream are noise. The SDK's onError must return the client string
        // synchronously and still runs onFinish afterwards, so that is where
        // the run row is settled as errored and the single terminal report is
        // made (after, and only if, the fenced update applied).
        if (failed === undefined) failed = message;
        return message;
      },
    } as Parameters<typeof createUIMessageStream>[0]);

    // Drain the stream server-side regardless of the client. If the browser
    // closes mid-turn, the response stops being pulled — without this the
    // generation stalls/cuts short and a refresh shows a partial answer. With
    // it, the agent runs to completion in the background and onFinish persists
    // the full message (the model's abort is tied to the lease, not the
    // request, so a disconnect doesn't cancel generation).
    let out = stream as ReadableStream<unknown>;
    if (args.observeStream) {
      const [main, observed] = out.tee();
      out = main;
      args.observeStream(observed);
    }
    return out;
  }

  async function reapTick(opts?: { now?: number; error?: string }) {
    const reaped = await storage.reapExpiredRuns(opts?.now, {
      error: opts?.error,
    });
    return { reaped };
  }

  /** Open a run for a turn: durable → leased claim; T1 → an unleased run. */
  /** What a turn was admitted under: its policies and the token room it started with. */
  interface Admitted {
    policies: LimitPolicy[];
    /** The windows the reservation landed in — released against THESE, not re-derived (a window may have turned over since). */
    refs: LimitWindowRef[];
    remainingTokens: number | undefined;
    /** True when this admission reserved a turn — released if the turn never opens. */
    counted: boolean;
  }

  /**
   * The admission gate. A FRESH turn (chat, schedule, subagent spawn, runAgent)
   * is RESERVED: one atomic increment of every policy's turn counter, which
   * returns the new counts; the first policy now over its cap refuses the turn
   * (`LimitExceededError`) and the reservation is released. Increment-then-
   * check is what makes a one-turn cap admit exactly one of N concurrent
   * requests — a read-then-write check would let them all through.
   *
   * A CONTINUATION is the second half of an already-admitted turn: a crash
   * resume, an approval or tool-result decision, a subagent's decided gate. It
   * passes `{ countTurn: false, refuse: false }`: never counted twice, never
   * refused (the persisted decision would strand until the window turned
   * over), but its tokens still settle and the mid-turn stop still applies —
   * with an exhausted budget it gets one step and stops. Undefined when no
   * limits are configured or none apply.
   */
  async function admitTurn(
    principal: P,
    agent: string,
    trigger: TurnTrigger,
    opts: { countTurn: boolean; refuse: boolean } = { countTurn: true, refuse: true },
  ): Promise<Admitted | undefined> {
    const limits = config.limits;
    if (!limits) return undefined;
    const policies = await limits.limitsFor({ principal, agent, trigger });
    if (policies.length === 0) return undefined;
    const now = Date.now();
    const refs = policies.map((p) => windowRef(p, now));
    // Reserve (fresh turn) or just look (continuation). Either way `usage` is
    // the state this turn is judged against, reservation included.
    const usage = opts.countTurn
      ? await limits.store.add(refs.map((ref) => ({ ...ref, usage: { turns: 1 } })))
      : await limits.store.read(refs);
    if (opts.refuse) {
      const over = exceededPolicy(policies, usage, now, { nextTurn: false });
      if (over) {
        // Release the reservation: the window should count admitted turns, not
        // refused attempts. Best-effort — a failed release only over-counts.
        if (opts.countTurn) {
          await limits.store
            .add(refs.map((ref) => ({ ...ref, usage: { turns: -1 } })))
            .catch((e) => console.error("[limits] reservation release failed:", e));
        }
        // A host hook must never turn a refusal into a 500: isolate sync throws too.
        try {
          await limits.onRefused?.({ principal, agent, trigger, ...over });
        } catch (e) {
          console.error("[limits] onRefused failed:", e);
        }
        throw new LimitExceededError(over.policy, over.usage, over.retryAfterMs);
      }
    }
    return { policies, refs, remainingTokens: remainingTokens(policies, usage, now), counted: opts.countTurn };
  }

  /**
   * Give a reserved turn back when the turn never opened (busy chat, agent
   * resolution or run creation failed): the window counts turns that RAN, or a
   * user retrying into a busy chat would exhaust their own turn cap.
   */
  /** A run's stored error, when it ended `errored` — the fallback when its stream said nothing. */
  async function terminalError(run: RunRecord): Promise<string | undefined> {
    const row = await ownedBy(run.ownerKey).getRun(run.id).catch(() => null);
    return row?.status === "errored" && row.error ? row.error : undefined;
  }

  async function releaseReservation(admitted: Admitted | undefined): Promise<void> {
    if (!admitted?.counted || !config.limits) return;
    await config.limits.store
      .add(admitted.refs.map((ref) => ({ ...ref, usage: { turns: -1 } })))
      .catch((e) => console.error("[limits] reservation release failed:", e));
  }

  /** Run `open` for a freshly admitted turn; on failure the reservation is released and the error rethrown. */
  async function withReservation<T>(admitted: Admitted | undefined, open: () => Promise<T>): Promise<T> {
    try {
      return await open();
    } catch (e) {
      await releaseReservation(admitted);
      throw e;
    }
  }

  /** `admitTurn` for continuations (see above). */
  const admitContinuation = (principal: P, agent: string, trigger: TurnTrigger) =>
    admitTurn(principal, agent, trigger, { countTurn: false, refuse: false });

  /** Settlement: add this turn's tokens and cost to every policy it was admitted under. */
  async function settleLimits(
    admitted: Admitted | undefined,
    usage: Pick<LimitUsage, "tokens" | "cost">,
  ): Promise<void> {
    if (!admitted || !config.limits) return;
    const now = Date.now();
    await config.limits.store
      .add(admitted.policies.map((p) => ({ ...windowRef(p, now), usage })))
      .catch((e) => console.error("[limits] settlement failed:", e));
  }

  /**
   * The id-only storage calls, each carrying the owner key of the record it
   * acts on (see `OwnerScope`), so an adapter can check or route by it. Every
   * id-only call goes through here: a call without a key is a bug, and a test
   * fails on one.
   */
  const ownedBy = (ownerKey: string | undefined) => {
    const scope = ownerKey ? { ownerKey } : undefined;
    return {
      appendMessages: (chatId: string, messages: AppMessage[], fence?: RunFence) =>
        storage.appendMessages(chatId, messages, fence, scope),
      updateRun: (id: string, patch: Partial<RunRecord>, guard?: RunLease) => storage.updateRun(id, patch, guard, scope),
      getRun: (id: string) => storage.getRun(id, scope),
      heartbeatRun: (id: string, owner: string, ttlMs: number, fencingToken: number) =>
        storage.heartbeatRun(id, owner, ttlMs, fencingToken, scope),
      reclaimRun: (id: string, owner: string, ttlMs: number) => storage.reclaimRun(id, owner, ttlMs, scope),
      completeSchedule: (
        id: string,
        patch: { nextRunAt: number; lastRunAt: number; enabled: boolean },
        owner: string,
        claim?: { leaseExpiresAt: number },
      ) => storage.completeSchedule(id, patch, owner, claim, scope),
      noteScheduleFire: (id: string, patch: { lastChatId: string; firedAt: number }) =>
        storage.noteScheduleFire?.(id, patch, scope),
    };
  };

  /** A run as the runtime holds it: carrying its chat's owner key even when the adapter left it off. */
  const withOwnerKey = (run: RunRecord, chat: Pick<ChatRecord, "owner">): RunRecord =>
    run.ownerKey ? run : { ...run, ownerKey: chat.owner };

  /** Report an owner-key mismatch through the host's hook (never throws). */
  async function reportMismatch(
    error: OwnerKeyMismatchError,
    at: { during: "resume" | "schedule" | "turn"; runId?: string; scheduleId?: string },
  ): Promise<void> {
    console.error(`[latch] owner key mismatch (${at.during}): ${error.message}`);
    try {
      await config.onOwnerKeyMismatch?.({ error, ...at });
    } catch (e) {
      console.error("[latch] onOwnerKeyMismatch failed:", e);
    }
  }

  /**
   * Open a turn: the run (one active per chat — `ChatBusyError` if not ours to
   * run) and the user message that starts it. Atomic when the adapter offers
   * `openTurn`; otherwise the run first, then the message, so a refusal still
   * persists nothing (the crash window between the two writes is the trade-off
   * an adapter without `openTurn` accepts).
   */
  async function openTurn(
    principal: P,
    chat: Pick<ChatRecord, "id" | "owner">,
    agentName: string,
    messages: AppMessage[],
    agentVersion?: number,
    /** Recorded on the run so recovery resumes it the same way (`RunRecord.settings`). */
    settings?: RunSettings,
  ): Promise<{ run: RunRecord; lease: RunLease | undefined }> {
    const chatId = chat.id;
    if (storage.openTurn) {
      const run = withOwnerKey(await storage.openTurn(principal, {
        chatId,
        agent: agentName,
        messages,
        agentVersion: agentVersion ?? null,
        ...(settings ? { settings } : {}),
        ...(dur.enabled ? { lease: { owner: dur.instanceId, ttlMs: dur.leaseTtlMs } } : {}),
      }), chat);
      return {
        run,
        lease: dur.enabled ? { owner: dur.instanceId, fencingToken: run.fencingToken ?? 1 } : undefined,
      };
    }
    const opened = await openRun(principal, chat, agentName, agentVersion, settings);
    if (messages.length > 0) await ownedBy(chat.owner).appendMessages(chatId, messages);
    return opened;
  }

  async function openRun(
    principal: P,
    chat: Pick<ChatRecord, "id" | "owner">,
    agentName: string,
    agentVersion?: number,
    settings?: RunSettings,
  ): Promise<{ run: RunRecord; lease: RunLease | undefined }> {
    const chatId = chat.id;
    if (dur.enabled) {
      const run = withOwnerKey(await storage.claimRun({
        principal,
        chatId,
        agent: agentName,
        owner: dur.instanceId,
        ttlMs: dur.leaseTtlMs,
        agentVersion: agentVersion ?? null,
        ...(settings ? { settings } : {}),
      }), chat);
      return { run, lease: { owner: dur.instanceId, fencingToken: run.fencingToken ?? 1 } };
    }
    return {
      run: withOwnerKey(
        await storage.createRun(principal, {
          chatId,
          agent: agentName,
          kind: "turn",
          agentVersion: agentVersion ?? null,
          ...(settings ? { settings } : {}),
        }),
        chat,
      ),
      lease: undefined,
    };
  }

  async function handleChat({
    agent: agentIn,
    chatId,
    principal,
    message,
    params: paramsIn,
    request,
    turnContext,
  }: HandleChatInput<P>): Promise<Response> {
    // `useChat`'s own approvals (`addToolApprovalResponse` +
    // `sendAutomaticallyWhen`) send the paused assistant message back with the
    // decisions on it. Only the decisions are taken from it, and they go
    // through `applyApproval` like any other: the client's copy of the
    // message, inputs included, is never stored or run.
    if ((message as { role?: unknown } | null)?.role === "assistant") {
      if (!chatId) throw new InvalidMessageError("approval decisions need the chat they belong to");
      return applyApproval({ chatId, principal, decisions: approvalDecisionsIn(message), request, turnContext });
    }

    // chat: scoped create-or-continue (others' ids resolve to "not found")
    let chat = chatId ? await storage.getChat(principal, chatId) : null;
    const agentName = agentIn ?? chat?.agent;
    if (!agentName) throw new InvalidMessageError("a new chat needs an agent");
    // A chat's params are set by its first message and fixed after that:
    // checked before anything is created, so a refusal leaves nothing behind.
    const newParams = await checkChatParams(agentName, chat, paramsIn);
    // Only a new user message gets in: a client can take part in the
    // conversation, not write it (see `acceptUserMessage`). Checked before a
    // chat is created, so a refused message leaves nothing behind.
    const existing = chat ? await storage.loadMessages(principal, chat.id) : [];
    const userMessage = await checkMessageContext(acceptUserMessage(message, existing, { maxInlineFileBytes: config.maxInlineFileBytes }));
    // The last question regenerated (`useChat`'s `regenerate()`) or edited:
    // what it replaces is hidden from the user and the model, not deleted,
    // and the turn runs again from that question.
    const replaced = lastQuestionResent(userMessage, existing) ?? [];
    if (!chat) {
      chat = await storage.createChat(principal, {
        id: chatId, // use the provided id (create-or-continue); generated if omitted
        agent: agentName,
        // Title from the first user message — for the chat list.
        title: firstText(userMessage)?.slice(0, 80),
        ...(newParams !== undefined ? { params: newParams } : {}),
      });
    }
    const resolvedChatId = chat.id;

    const { cfg, modelId, runtimeCtx, params, messageContext } = await resolveAgentConfig(
      agentName,
      principal,
      request,
      turnContext,
      // A host may continue a subagent thread through the chat surface; keep
      // resolving it the way its spawner would.
      { parentAgent: chat.parentAgent },
      chat.params,
      contextOf(userMessage),
    );

    // The replaced answers are hidden by the same write that opens the new turn
    // (below), so a turn refused for a limit or a busy chat hides nothing.
    const hidden = new Set(replaced.map((m) => m.id));
    // Hidden messages, from this resend or earlier ones, take no part in the turn.
    const prior = (await storage.loadMessages(principal, resolvedChatId)).filter((m) => !hidden.has(m.id) && !isHidden(m));

    // A new message while the last turn is parked on an approval is itself the
    // decision: the user declined to answer and wants to steer elsewhere. Close
    // the gate as declined (persisted, so the card stops rendering as live) and
    // carry on — the gated tool never runs, and the model sees the denial
    // followed by the new instruction. Refusing the message instead is what
    // wedged chats whose gate could not be satisfied at all.
    if (hasPendingApproval(prior)) {
      const declined = declinePendingApprovals(prior);
      if (declined.length > 0) await ownedBy(chat.owner).appendMessages(resolvedChatId, declined);
    }

    // Limits gate BEFORE anything is persisted: a refused turn leaves no
    // trace (the client gets 429 and can retry when the window turns over).
    const admitted = await admitTurn(principal, agentName, "chat");
    // Run + message open together (atomically where the adapter can): a chat
    // with a live turn refuses (`ChatBusyError` → 409) and the message never
    // lands in history — the client retries it (with its turn reservation released).
    const { run, lease } = await withReservation(admitted, () =>
      openTurn(principal, chat, agentName, [...replaced, userMessage], cfg.configVersion),
    );

    return buildTurn({
      resolvedChatId,
      principal,
      modelId,
      cfg,
      run,
      lease,
      // A retried message replaces its earlier copy rather than appearing twice.
      uiMessages: [...prior.filter((m) => m.id !== userMessage.id), userMessage],
      runtimeCtx,
      params,
      messageContext,
      admitted,
    });
  }

  async function resumeRun(reaped: Pick<RunRecord, "id" | "ownerKey">): Promise<RunOutcome | null> {
    if (!dur.enabled) throw new Error("resume requires durability.enabled");
    const runId = reaped.id;

    // Exactly-once re-claim: only one node wins; a concurrent resumer / an
    // already-completed run yields null. The reaped record carries the run's
    // owner key, so even the first call of a recovery says whose run it is.
    const reclaimed = await ownedBy(reaped.ownerKey).reclaimRun(runId, dur.instanceId, dur.leaseTtlMs);
    if (!reclaimed) return null;
    const run: RunRecord = reclaimed.ownerKey || !reaped.ownerKey ? reclaimed : { ...reclaimed, ownerKey: reaped.ownerKey };
    const owned = ownedBy(run.ownerKey);

    // System op (no request): rebuild the principal from the run's identity blob.
    const principal = await reconstructPrincipal(run.identity);
    const lease: RunLease = {
      owner: dur.instanceId,
      fencingToken: run.fencingToken ?? 1,
    };
    // End a run recovery won't resume. Settled rather than returned early with
    // the lease held: an `active` row would be reaped and re-refused every tick
    // until `maxAttempts`, and a throw would abort the rest of `sweep`'s loop.
    // No `onRunFinished`: nothing ran.
    const refuse = async (error: string): Promise<RunOutcome> => {
      await owned.updateRun(
        run.id,
        {
          status: "errored",
          error,
          endedAt: Date.now(),
          // Terminal, so give up the reclaim just taken. `reclaimRun` matches
          // any non-completed row whose lease has lapsed, so a lease left to
          // expire would let a direct `resume()` re-claim and re-refuse it,
          // spending an attempt each time.
          leaseOwner: null,
          leaseExpiresAt: null,
        },
        lease,
      );
      console.warn(`[resume] run ${run.id} (${run.agent}): ${error}`);
      const settled = await owned.getRun(runId);
      return {
        runId,
        status: settled?.status ?? "errored",
        attempt: settled?.attempt ?? run.attempt ?? null,
      };
    };
    if (principal === null) {
      // Refused (see `ReconstructPrincipal`): the identity may no longer act, so
      // nothing below — not even reading its history — runs as it.
      return refuse("principal rejected: reconstructPrincipal refused the run's identity");
    }

    const uiMessages = withoutHiddenTail(await storage.loadMessages(principal, run.chatId));

    // What does this run actually need? A crash between the last step's
    // checkpoint and `onFinish`'s `updateRun` leaves a FINISHED turn on an
    // `active` row, and re-running the model there would pay twice for an answer
    // already in history — and append the second copy to the same message. So
    // reconcile the row instead, and only re-run when work is genuinely left.
    // Did the chat move on while this run sat reaped? Asked of the runs table,
    // never inferred from message shapes — see `supersededBy` for why. The list
    // is owner-scoped and most-recent first; a later sibling is more recent than
    // we are, so it is present unless more than `limit` runs happened owner-wide
    // after IT. A miss errs toward re-running (today's behaviour), never toward
    // settling a live run.
    const siblings = await storage.listRuns(principal, { limit: 500 });
    const shape: ResumeShape = supersededBy(run, siblings) ? "superseded" : resumeShapeOf(uiMessages);
    if (shape !== "continue") {
      const status: RunStatus =
        shape === "superseded" ? "errored" : shape === "decision-pending" ? "awaiting_input" : "completed";
      // Same outcome `openTurn` records when a fresh message supersedes a stale
      // run, so a superseded run reads the same however it got there.
      const error = shape === "superseded" ? "superseded: a later turn moved the conversation on" : null;
      // Fenced like every other terminal write: if our lease was reaped again
      // mid-flight, the new owner decides this run's end state, not us.
      const applied = await owned.updateRun(
        run.id,
        {
          status,
          // The reaper stamped BOTH an error and an `endedAt` on the way in
          // (see `reapExpiredRuns`). A finished turn did not fail, so its error
          // has to go or the row reads as failed forever — and a run settling to
          // `awaiting_input` is paused, not over, so its `endedAt` has to go
          // too. `onFinish` leaves it unset for a paused turn; a crash-settled
          // one must match, or inter-run gap stats read a run that ended before
          // its decision arrived. `null` (not `undefined`) is what clears a
          // column: the adapters drop undefined from the patch.
          error,
          endedAt: status === "awaiting_input" ? null : Date.now(),
        },
        lease,
      );
      // The process that spent this turn's tokens died before recording them,
      // so usage is unknowable here — the row and this report agree on zero
      // rather than inventing a number. The notification still fires: a host
      // watching `onRunFinished` for "the turn ended" must not miss a turn just
      // because recovery was a row write instead of a model call.
      const meta: TelemetryRunMeta<P> = {
        runId: run.id,
        chatId: run.chatId,
        agent: run.agent,
        // The model that ACTUALLY ran, off the message it produced — not a
        // freshly resolved config. Reconciling a finished turn must not need
        // the agent to still exist (see above), and this is the truer answer
        // anyway: the agent's model may have been changed since.
        modelId: ranAs(uiMessages, run.id) ?? "unknown",
        principal,
        startedAt: run.startedAt,
        // Likewise persisted, not re-resolved: reconciling a finished run must
        // report the version it ran on, not whatever is published now.
        agentVersion: run.agentVersion ?? undefined,
        depth: 0,
        trigger: "resume",
        rootChatId: run.chatId,
      };
      // Same opt-out rule as a streamed turn: a `telemetryFor` that returns
      // undefined silences this run's hooks too (see buildTurn).
      const telemetryOn =
        !!config.telemetry &&
        !(config.telemetry.telemetryFor && config.telemetry.telemetryFor(meta) === undefined);
      if (applied && telemetryOn) {
        try {
          await config.telemetry?.onRunFinished?.(meta, {
            status,
            ...(error !== null ? { error } : {}),
            inputText: lastUserText(uiMessages),
            messages: uiMessages,
            usage: { inputTokens: 0, outputTokens: 0 },
            cost: 0,
            endedAt: Date.now(),
          });
        } catch (e) {
          console.warn("latch telemetry onRunFinished failed:", e);
        }
        try {
          await config.telemetry?.flush?.();
        } catch (e) {
          console.warn("latch telemetry flush failed:", e);
        }
      }
      const settled = await owned.getRun(runId);
      return {
        runId,
        status: settled?.status ?? status,
        attempt: settled?.attempt ?? run.attempt ?? null,
      };
    }

    // Only now resolve the agent — `resolveAgentConfig` throws on an agent that
    // no longer resolves, and a run whose answer is already stored must be
    // reconcilable even if its (dynamic, DB-stored) agent was since deleted.
    // Before this ordering that throw also aborted `sweep`'s loop, so one such
    // run held up recovery for every other run until its attempts ran out.
    // Resume the turn the way it was asked to run (`RunRecord.settings`): an
    // unattended run stays unattended — and keeps its `blockGated`, or its
    // gated tools would run for real — memory off stays off. A run on a
    // per-turn model override can't be resumed on that model (the object
    // isn't stored), and finishing it on the agent's own would quietly change
    // what answered: refuse it instead.
    const settings = run.settings ?? {};
    if (settings.modelOverride) {
      return refuse(`can't resume on the per-turn model it started with (${settings.modelOverride})`);
    }

    // A recovered subagent run must resolve exactly as its spawner shaped it —
    // crash recovery and `sweep` both land here.
    const chat = await storage.getChat(principal, run.chatId);
    // And on the agent VERSION it started on (`RunRecord.agentVersion`): a
    // publish between the crash and the recovery must not change what finishes
    // the turn — a new model, new instructions. Pinned as `name@7`, the same
    // read-only pin a measured version uses. Code-declared agents have no
    // stored version, and an agent already pinned (`name@7`, `name@c_…`) keeps
    // the pin it ran under.
    const pinnedAgent =
      run.agentVersion != null && !config.agents[run.agent] && !run.agent.includes("@")
        ? `${run.agent}@${run.agentVersion}`
        : run.agent;
    const resolveCtx = {
      parentAgent: chat?.parentAgent,
      ...(settings.autoApprove !== undefined ? { autoApprove: settings.autoApprove } : {}),
    };
    // A store that records versions but can't resolve a pin falls back to the
    // agent as it is now — what recovery always did — rather than failing it.
    const { cfg, modelId, runtimeCtx, params, messageContext } = await resolveAgentConfig(pinnedAgent, principal, undefined, undefined, resolveCtx, chat?.params, latestMessageContext(uiMessages)).catch(
      (e: unknown) => {
        if (pinnedAgent === run.agent) throw e;
        console.warn(`[resume] run ${run.id}: ${pinnedAgent} did not resolve; resuming on ${run.agent} as it is now`);
        return resolveAgentConfig(run.agent, principal, undefined, undefined, resolveCtx, chat?.params, latestMessageContext(uiMessages));
      },
    );

    // A resume was admitted when the turn first ran — never refuse it (the
    // half-done work would strand), but its tokens still settle against the
    // same counters, and the mid-turn stop still applies.
    const admitted = await admitContinuation(principal, run.agent, "resume");
    // Re-run from persisted history and drive to completion server-side
    // (there's no client to consume the stream).
    const res = await buildTurn({
      resolvedChatId: run.chatId,
      principal,
      modelId,
      cfg,
      run,
      lease,
      // Same prefill guard the decision paths use: a tail ending in the turn's
      // own half-written sentence would reach the model as an assistant
      // prefill, which models that reject one refuse on the request SHAPE — so
      // every identical retry fails until `maxAttempts` is spent. `unanchored`
      // extends it to a tail with no tool part to anchor on; no checkpoint
      // produces such a tail on this path today (see the note there), it is
      // here so a classifier change cannot reintroduce the prefill.
      uiMessages: trimTrailingAssistantPrefill(uiMessages, { unanchored: true }),
      runtimeCtx,
      params,
      messageContext,
      admitted,
      ...(settings.autoApprove !== undefined ? { autoApprove: settings.autoApprove } : {}),
      ...(settings.blockGated !== undefined ? { blockGated: settings.blockGated } : {}),
      ...(settings.memory !== undefined ? { memory: settings.memory } : {}),
      ...(settings.promptCaching !== undefined ? { promptCaching: settings.promptCaching } : {}),
      // Crash recovery, driven server-side: nobody is watching this stream.
      trigger: "resume",
    });
    await res.text();

    const final = await owned.getRun(runId);
    return {
      runId,
      status: final?.status ?? "errored",
      attempt: final?.attempt ?? run.attempt ?? null,
    };
  }

  async function sweep(opts?: {
    now?: number;
    maxAttempts?: number;
    error?: string;
  }): Promise<{ reaped: RunRecord[]; resumed: RunOutcome[]; errors: string[] }> {
    if (!dur.enabled) throw new Error("sweep requires durability.enabled");
    const maxAttempts = opts?.maxAttempts ?? 5;
    const { reaped } = await reapTick({ now: opts?.now, error: opts?.error });
    const resumed: RunOutcome[] = [];
    const errors: string[] = [];
    for (const run of reaped) {
      // Give up on poison runs that keep dying — don't loop forever.
      if ((run.attempt ?? 1) >= maxAttempts) continue;
      // One run's failure must not strand the rest of the batch. The reaper
      // flipped EVERY run here to `errored` in one write, and no later reap
      // selects an `errored` row — so an escaping throw (a transient
      // `reconstructPrincipal` failure, a storage blip) would leave each run
      // after it unrecovered for good. A throw AFTER the reclaim (the hook,
      // history, the turn) leaves that run `active` under a lease, so it is
      // reaped and retried once the lease lapses, spending an attempt like any
      // other failed resume. A throw FROM the reclaim itself leaves the run as
      // the reaper left it — `errored`, not auto-retried — which is today's
      // outcome for that run too; only its neighbours are new to recovery.
      try {
        const outcome = await resumeRun(run);
        if (outcome) resumed.push(outcome);
      } catch (e) {
        // A mismatched owner key is never retried: the run stays as the reaper
        // left it, and the host hears about it.
        if (isOwnerKeyMismatchError(e)) await reportMismatch(e, { during: "resume", runId: run.id });
        else console.error(`[resume] run ${run.id} (${run.agent}) failed; continuing the sweep:`, e);
        errors.push(`resume ${run.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return { reaped, resumed, errors };
  }

  async function cron(opts?: { now?: number; maxAttempts?: number }): Promise<{
    due: RunDueResult;
    reaped: RunRecord[];
    resumed: RunOutcome[];
    errors: string[];
  }> {
    const errors: string[] = [];
    const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));
    let due: RunDueResult = { fired: 0, errors: 0, skipped: 0, parked: 0, rejected: 0 };
    try {
      due = await runDue({ now: opts?.now });
    } catch (e) {
      errors.push(`runDue: ${describe(e)}`);
    }
    let reaped: RunRecord[] = [];
    let resumed: RunOutcome[] = [];
    // Without durability there are no leases to reap — nothing to sweep.
    if (dur.enabled) {
      try {
        let swept: string[];
        ({ reaped, resumed, errors: swept } = await sweep({ now: opts?.now, maxAttempts: opts?.maxAttempts }));
        errors.push(...swept);
      } catch (e) {
        errors.push(`sweep: ${describe(e)}`);
      }
    }
    // Limit counters: windows that ended more than a day ago are dead weight.
    if (config.limits?.store.prune) {
      try {
        await config.limits.store.prune((opts?.now ?? Date.now()) - 24 * 3_600_000);
      } catch (e) {
        errors.push(`limits.prune: ${describe(e)}`);
      }
    }
    return { due, reaped, resumed, errors };
  }

  async function applyApproval({
    chatId,
    principal,
    decisions,
    request,
    turnContext,
  }: {
    chatId: string;
    principal: P;
    decisions: ApprovalDecision[];
    request?: Request;
    turnContext?: unknown;
  }): Promise<Response> {
    const chat = await storage.getChat(principal, chatId);
    if (!chat) throw new Error(`Unknown chat: ${chatId}`);

    // Merge the decisions onto the persisted assistant message, then re-persist
    // only what changed. The agent continues from this updated history.
    const messages = withoutHiddenTail(await storage.loadMessages(principal, chatId));
    // A decision only means something for the message the turn paused on —
    // the LAST one. An approval from further back (an old tab, an old Slack
    // card, a late retry after the user moved on) was already settled: the
    // next message declined it. Continuing anyway would run the agent again
    // and append an answer nobody asked for. A real retry (a crash or a busy
    // chat after the decision was saved) still finds its approval last.
    //
    // And only for a call the agent hasn't acted on yet — the same rule the AI
    // SDK's own chat client applies before it sends a decision: still waiting
    // (`approval-requested`), or decided but never continued, after a crash or
    // a busy chat (`approval-responded`). Once a call has an outcome
    // (`output-available` / `output-denied` / …), or a bubbled subagent
    // approval is `resolved`, the decision was already acted on: a double
    // click, Slack re-sending a button press, a second tab. Continuing would
    // answer the same thing again. (A call auto-declined because the user
    // moved on stays `approval-responded`; the last-message rule retires it.)
    const live = decisions.filter((d) => approvalIsLast(messages, d.approvalId) && approvalIsOpen(messages, d.approvalId));
    if (live.length === 0) return new Response(null, { status: 200 });
    decisions = live;
    const changed = applyDecisions(messages, decisions);
    if (changed.length > 0) await ownedBy(chat.owner).appendMessages(chatId, changed);

    // Continue this chat from the decided history.
    const continueTurn = async () => {
      const { cfg, modelId, runtimeCtx, params, messageContext } = await resolveAgentConfig(
        chat.agent,
        principal,
        request,
        turnContext,
        { parentAgent: chat.parentAgent },
        chat.params,
        latestMessageContext(messages),
      );
      const admitted = await admitContinuation(principal, chat.agent, "decision");
      const { run, lease } = await openRun(principal, chat, chat.agent, cfg.configVersion);
      return buildTurnStream({
        resolvedChatId: chatId,
        principal,
        modelId,
        cfg,
        run,
        lease,
        // Resume: strip the paused turn's trailing text so the model call ends on
        // the tool result (a user turn), not an assistant prefill.
        uiMessages: trimTrailingAssistantPrefill(messages),
        runtimeCtx,
        params,
        messageContext,
        // A human just decided something, so a human is present — even if this
        // turn parks again on the NEXT gate (see TurnTrigger).
        trigger: "decision",
        admitted,
      });
    };

    // Route any just-decided SUBAGENT approvals (bubbled up via spawn_agent):
    // resume the sub thread with the decision, then fold its answer back into
    // the parent's spawn_agent result so this turn continues with the digest.
    //
    // All of it streams in THIS response, which is the only channel back to a
    // client already showing the paused message. The resume can run for
    // minutes, pause on a SECOND gate, or fold an answer the client has never
    // seen — answered with an empty body instead, the user saw their approval
    // land and then nothing: no progress, and no card for the next gate, while
    // the chat sat awaiting a decision it never offered.
    const subApprovals = collectDecidedSubagentApprovals(messages);
    if (subApprovals.length > 0) {
      const stream = createUIMessageStream({
        execute: async ({ writer }: { writer: TurnWriter }) => {
          for (const sa of subApprovals) {
            const resumed = await resumeSubagentApproval(
              principal,
              sa.subChatId,
              sa.subApprovalIds.map((id) => ({
                approvalId: id,
                approved: sa.approved as boolean,
                reason: sa.reason,
              })),
              { parentRunId: sa.parentRunId, rootChatId: sa.rootChatId },
              { writer, spawnToolCallId: sa.spawnToolCallId },
            );
            let output: unknown;
            if (resumed.pending?.length) {
              // The resumed sub paused on ANOTHER gated tool — re-bubble it as a
              // fresh data-subagent-approval part on the same parent message. The
              // undecided part keeps this chat awaiting_input (hasPendingApproval
              // below), and the next decision routes through here again, so
              // bubbling recurses per round.
              const data: NonNullable<SubApprovalPart["data"]> = {
                approvalId: generateSubApprovalId(),
                subChatId: sa.subChatId,
                subApprovalIds: resumed.pending.map((p) => p.approvalId),
                spawnToolCallId: sa.spawnToolCallId,
                summaries: resumed.pending.map((p) => p.summary),
                // Carry the linkage forward so each further resume stays nested.
                parentRunId: sa.parentRunId,
                rootChatId: sa.rootChatId,
              };
              appendSubagentApprovalPart(messages, sa.approvalId, data);
              // Same id as the stored part, so the client reconciles it into the
              // paused message exactly as a reload would show it.
              writer.write({ type: "data-subagent-approval", id: data.approvalId, data });
              output = {
                status: "awaiting_approval",
                threadId: sa.subChatId,
                pending: resumed.pending.map((p) => p.summary),
                note: "Awaiting the user's approval — do not retry; stop here, the user will decide and you'll continue automatically.",
              };
            } else {
              output = { threadId: sa.subChatId, answer: resumed.answer };
            }
            if (sa.spawnToolCallId) {
              overwriteToolResult(messages, sa.spawnToolCallId, output);
              writer.write({ type: "tool-output-available", toolCallId: sa.spawnToolCallId, output });
            }
            markSubagentApprovalResolved(messages, sa.approvalId);
          }
          // Persist the folded spawn_agent result (or re-bubbled approval part)
          // + resolved markers.
          await ownedBy(chat.owner).appendMessages(chatId, messages);
          if (hasPendingApproval(messages)) {
            writer.write({ type: "finish" });
            return;
          }
          writer.merge(await continueTurn());
        },
        onError: (error: unknown) => clientErrorMessage(error),
      } as Parameters<typeof createUIMessageStream>[0]);
      return createUIMessageStreamResponse({
        stream: stream as Parameters<typeof createUIMessageStreamResponse>[0]["stream"],
        // Drain server-side even if the client leaves: the resume must finish
        // and persist either way, as every turn does (see buildTurnStream).
        consumeSseStream: consumeStream,
      });
    }

    // If the step had several gated calls and some are still undecided, DON'T
    // re-run yet — a tool call without a result makes convertToModelMessages
    // throw MissingToolResultsError. Persist the decision, stay awaiting_input,
    // and let the client submit the rest. Only continue once none are pending.
    if (hasPendingApproval(messages)) {
      return new Response(null, { status: 200 });
    }

    return createUIMessageStreamResponse({
      stream: (await continueTurn()) as Parameters<typeof createUIMessageStreamResponse>[0]["stream"],
      consumeSseStream: consumeStream,
    });
  }

  /**
   * Resume a turn paused on a client-handled tool (one with no `execute`, e.g.
   * `askUser`). Records the supplied `output` onto the matching tool call in the
   * persisted assistant message (input-available → output-available), then
   * re-runs the agent from history. Mirrors `applyApproval`: the result
   * round-trips as message state, not a client-message ingest (the handler only
   * ever accepts a fresh user message otherwise).
   */
  async function applyToolResult({
    chatId,
    principal,
    toolCallId,
    output,
    request,
    turnContext,
  }: {
    chatId: string;
    principal: P;
    toolCallId: string;
    output: unknown;
    request?: Request;
    turnContext?: unknown;
  }): Promise<Response> {
    const chat = await storage.getChat(principal, chatId);
    if (!chat) throw new Error(`Unknown chat: ${chatId}`);

    const messages = withoutHiddenTail(await storage.loadMessages(principal, chatId));
    const changed = recordToolResult(messages, toolCallId, output);
    // Unknown or already-answered call: nothing to resume. Makes a duplicate
    // submit (double-tapped button, redelivered webhook) a no-op instead of a
    // spurious extra turn.
    if (changed.length === 0) return new Response(null, { status: 200 });

    // Another client tool call in the SAME step may still be awaiting a result;
    // re-running now would throw MissingToolResultsError. Record this one and
    // wait for the rest. Scope this to the messages we just touched: a call
    // abandoned turns ago is still `input-available` in stored history, and
    // counting it would park every future resume in this chat forever.
    if (hasPendingToolResult(changed)) {
      await ownedBy(chat.owner).appendMessages(chatId, changed);
      return new Response(null, { status: 200 });
    }

    const { cfg, modelId, runtimeCtx, params, messageContext } = await resolveAgentConfig(
      chat.agent,
      principal,
      request,
      turnContext,
      { parentAgent: chat.parentAgent },
      chat.params,
      latestMessageContext(messages),
    );
    const admitted = await admitContinuation(principal, chat.agent, "decision");
    // The result is persisted WITH the run (atomically where the adapter can):
    // a busy chat refuses before anything is recorded, so the retry finds the
    // call still unanswered and resumes it — persisting first would make the
    // retry a "duplicate submit" no-op and lose the answer.
    const { run, lease } = await openTurn(principal, chat, chat.agent, changed, cfg.configVersion);

    return buildTurn({
      resolvedChatId: chatId,
      principal,
      modelId,
      cfg,
      run,
      lease,
      // Resume: same prefill guard as applyApproval (see trimTrailingAssistantPrefill).
      uiMessages: trimTrailingAssistantPrefill(messages),
      runtimeCtx,
      params,
      messageContext,
      // A client-handled tool result is a human answering (see TurnTrigger).
      trigger: "decision",
      admitted,
    });
  }

  /**
   * Compact a conversation: summarize the live context window and append the
   * summary as a boundary marker, so later turns send the model the summary
   * instead of the turns it replaces (see `sliceAtCompaction`). Stored history is
   * never rewritten — nothing is lost, and a chat can be compacted repeatedly.
   *
   * Returns null when there's too little to be worth compacting (or the chat
   * isn't the caller's). Throws `PendingApprovalError` when the turn is paused:
   * the parked `tool_use` would fall behind the boundary and vanish from the
   * model view while stored history still gates every new message.
   */
  async function compactChat({
    chatId,
    principal,
    focus,
    signal,
    request,
    turnContext,
  }: {
    chatId: string;
    principal: P;
    /** Optional steer, e.g. Telegram's `/compact keep the training plan`. */
    focus?: string;
    /** Abort a stalled summarization (a request signal, or a caller timeout). */
    signal?: AbortSignal;
    request?: Request;
    turnContext?: unknown;
  }): Promise<{ summary: string; compacted: number } | null> {
    const chat = await storage.getChat(principal, chatId);
    if (!chat) return null;

    const stored = await storage.loadMessages(principal, chatId);
    // Only the live window is summarized: everything before the previous
    // boundary is already represented by that boundary's summary.
    const live = sliceAtCompaction(stored);
    if (live.length < MIN_COMPACTABLE_MESSAGES) return null;
    if (hasPendingApproval(live) || hasPendingToolResult([live[live.length - 1]!])) {
      throw new PendingApprovalError(
        "This chat is awaiting a decision — resolve the pending request before compacting.",
      );
    }

    const { cfg, modelId } = await resolveAgentConfig(
      chat.agent,
      principal,
      request,
      turnContext,
      { parentAgent: chat.parentAgent },
      chat.params,
      latestMessageContext(stored),
    );
    // Tool definitions only affect how a recorded tool RESULT is rendered for the
    // model (`toModelOutput`); an unknown tool falls back to its raw JSON rather
    // than failing. So take every definition available without I/O — the agent's
    // own plus the harness ones — and deliberately skip opening dynamic sources
    // (MCP / connections): summarizing must not depend on a remote server being
    // reachable, and raw JSON is a fine thing to summarize.
    const harness = config.harnessTools ?? {};
    const tools = {
      ...cfg.tools,
      ...harness.app,
      ...harness.sandbox,
    } as Record<string, unknown>;
    // Summarizing needs no reasoning block, and on a model that thinks by
    // DEFAULT that block spends the same output budget as the summary — leaving
    // the call truncated with nothing usable. `"minimal"` is the effort every
    // provider mapping turns into "thinking off", so reuse the host's hook rather
    // than hardcoding provider shapes here.
    const noThinking = config.resolveReasoningOptions?.(modelId, "minimal")?.providerOptions;
    const run = withOwnerKey(
      await storage.createRun(principal, {
        chatId,
        agent: chat.agent,
        // Not a conversational turn — stats/rollups filter on kind so a
        // compaction's cache-less usage never depresses an agent's hit rate.
        kind: "compaction",
      }),
      chat,
    );
    const owned = ownedBy(run.ownerKey);
    try {
      const { text, truncated, usage } = await summarizeForCompaction({
        model: cfg.model as LanguageModel,
        messages: await toModelMessages(live, { tools, contextToText: contextToTextFor(chat.agent) }),
        ...(focus ? { focus } : {}),
        ...(noThinking ? { providerOptions: noThinking } : {}),
        ...(signal ? { signal } : {}),
      });
      if (!text) throw new Error("The model returned an empty summary.");
      // Still truncated after the shortened retry (see summarizeForCompaction).
      // A summary cut off mid-thought must not be stored — it would become the
      // permanent head of every later prompt. History is untouched, so retrying
      // is safe.
      if (truncated) {
        throw new Error(
          "Couldn't fit a summary of this conversation — nothing was changed. Try /compact again, or /new to start fresh.",
        );
      }

      const cost = computeCost(config.pricing?.(modelId), usage);
      // `internal` so the client projection never shows a "user" message the user
      // didn't write; `sendToModel` stays default-true so the model DOES see it.
      // Role `user` because after slicing this is the conversation's first
      // message, and a model prompt may not open with an assistant turn.
      await owned.appendMessages(chatId, [
        {
          id: generateMessageId(),
          role: "user",
          parts: [
            { type: "text", text },
            {
              type: COMPACTION_PART_TYPE,
              data: { compacted: live.length, at: Date.now() },
            },
          ],
          metadata: {
            visibility: "internal",
            createdAt: Date.now(),
            model: modelId,
            usage: {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              ...(usage.cacheReadTokens ? { cacheReadTokens: usage.cacheReadTokens } : {}),
              ...(usage.cacheWriteTokens ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
            },
            cost,
          },
        } as AppMessage,
      ]);
      await owned.updateRun(run.id, {
        status: "completed",
        usageInputTokens: usage.inputTokens,
        usageOutputTokens: usage.outputTokens,
        usageCacheReadTokens: usage.cacheReadTokens || undefined,
        usageCacheWriteTokens: usage.cacheWriteTokens || undefined,
        costTotal: cost,
        endedAt: Date.now(),
      });
      await storage.recordUsage(principal, {
        runId: run.id,
        model: modelId,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        ...(usage.cacheReadTokens ? { cacheReadTokens: usage.cacheReadTokens } : {}),
        ...(usage.cacheWriteTokens ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
        cost,
      });
      return { summary: text, compacted: live.length };
    } catch (e) {
      await storage
        .updateRun(run.id, {
          status: "errored",
          error: e instanceof Error ? e.message : String(e),
          endedAt: Date.now(),
        })
        .catch(() => {});
      throw e;
    }
  }

  async function loadHistory({
    chatId,
    principal,
  }: {
    chatId: string;
    principal: P;
  }): Promise<AppMessage[]> {
    const messages = await storage.loadMessages(principal, chatId);
    // `render` rules apply on load as they do live. Runtime-wide extensions
    // only: an agent's own would need the chat's agent resolved here.
    return renderTranscript(config.extensions ?? [], toClientMessages(messages), {
      principal: principal as unknown as ExtensionPrincipal,
    }) as AppMessage[];
  }

  async function listChats({
    principal,
    limit,
    kind,
  }: {
    principal: P;
    limit?: number;
    kind?: string;
  }): Promise<ChatRecord[]> {
    // No default kind filter — passing nothing returns ALL chats (unchanged
    // behavior). Callers that want only user-facing chats pass kind: "user".
    return storage.listChats(principal, { limit, kind });
  }

  async function listRuns({
    principal,
    limit,
  }: {
    principal: P;
    limit?: number;
  }): Promise<RunRecord[]> {
    return storage.listRuns(principal, { limit });
  }

  async function getChatById({
    principal,
    id,
  }: {
    principal: P;
    id: string;
  }): Promise<ChatRecord | null> {
    return storage.getChat(principal, id);
  }

  async function getRun({
    principal,
    runId,
  }: {
    principal: P;
    runId: string;
  }): Promise<RunRecord | null> {
    // No record in hand yet: the principal stands in for the owner key.
    const run = await storage.getRun(runId, { principal });
    if (!run) return null;
    // Ownership: the run is the caller's only if its chat is (getChat is
    // principal-scoped). Guards cross-tenant reads/writes keyed by runId.
    const chat = await storage.getChat(principal, run.chatId);
    return chat ? run : null;
  }

  /** A fresh user message from plain text (for cron-fired turns). */
  function userMessageOf(text: string, files?: { url: string; mediaType: string; filename?: string }[]): AppMessage {
    return {
      id: generateMessageId(),
      role: "user",
      parts: [
        ...(files ?? []).map((f) => ({ type: "file" as const, url: f.url, mediaType: f.mediaType, ...(f.filename ? { filename: f.filename } : {}) })),
        { type: "text", text },
      ],
      metadata: { visibility: "user", createdAt: Date.now() },
    } as AppMessage;
  }

  /** Merged agent directory (code-declared + dynamic) — name/title/description. */
  async function agentInfos(principal: P): Promise<AgentInfo[]> {
    const stat = Object.entries(config.agents).map(([name, factory]) => ({
      name,
      title: factory.meta?.title,
      description: factory.meta?.description,
      hidden: factory.meta?.hidden,
    }));
    const dyn = (await config.dynamicAgents?.list(principal)) ?? [];
    // Dedup by name, static first — mirrors resolve-time precedence (a
    // code-declared agent shadows a same-named dynamic one).
    const seen = new Set(stat.map((a) => a.name));
    return [...stat, ...dyn.filter((a) => !seen.has(a.name) && seen.add(a.name))];
  }

  /** Concatenated text of the last assistant message in a chat (subagent answer). */
  function lastAssistantText(messages: AppMessage[]): string {
    const last = [...messages].reverse().find((m) => m.role === "assistant");
    if (!last) return "";
    return (last.parts ?? [])
      .filter((p): p is { type: "text"; text: string } => (p as { type?: string }).type === "text")
      .map((p) => p.text)
      .join("");
  }

  /**
   * Run one agent turn to completion, server-side, and report how it ended —
   * THE single non-streaming path. `runAgent` (programmatic / test runs),
   * `spawn_agent` (subagent delegation) and `runDue` (scheduled fires) all
   * funnel here, so approval semantics, telemetry linkage and the "did it
   * park?" verdict cannot drift between them.
   *
   * `chatId` absent (or "") → a fresh internal `sub_…` thread; present → that
   * chat continues with its full history (created as an internal thread when
   * it doesn't exist yet). `autoApprove` is REQUIRED, not defaulted: autonomous
   * runs (subagents, tests) waive HITL gates, while a scheduled fire keeps them
   * — and parks on them, which is the whole point of `parked`.
   *
   * `parked` = the turn ended waiting on a human (an undecided approval or
   * client tool result) rather than with an answer; the stream ending is not
   * the same as an answer, and a parked unattended turn has spent its tokens
   * and produced nothing. `pending` lifts an interactive subagent's undecided
   * approvals so `spawn_agent` can bubble them up to the parent turn. Both are
   * read from the fold over the persisted log — the same truth every
   * interactive path trusts — not the run row.
   */
  async function runToCompletion(o: {
    principal: P;
    agent: string;
    message: AppMessage;
    chatId?: string;
    /** Params for the thread (see `HandleChatInput.params`): saved on a new one, checked against an existing one. */
    params?: unknown;
    autoApprove: boolean;
    blockGated?: boolean | "simulate-success";
    /** Per-turn memory override (see buildTurn) — `false` disables recall. */
    memory?: boolean;
    /** Per-turn model override (see buildTurn). */
    model?: LanguageModel;
    /** Per-turn prompt-caching override (see buildTurn). */
    promptCaching?: boolean;
    /** Delegation depth of this turn (top-level = 0); guards `spawn_agent`. */
    depth?: number;
    trigger: TurnTrigger;
    /** Telemetry: the run that spawned this turn (nests its trace). */
    parentRunId?: string;
    /** Telemetry: the top-level conversation id (shared session across the tree). */
    rootChatId?: string;
    /**
     * The agent delegating this run (`spawn_agent` passes its own name).
     * Persisted on a NEW thread as `ChatRecord.parentAgent` and handed to
     * `dynamicAgents.resolve` on this and every later turn of that thread.
     */
    parentAgent?: string;
    /**
     * Per-turn request payload for THIS run, passed to `context.build` and the
     * agent factory (see `HandleChatInput.turnContext`). Ephemeral — applies to
     * this initial turn only, never to resumes.
     */
    turnContext?: unknown;
    /** Progressive snapshots of the turn's exchange (prompt + streaming assistant). */
    onProgress?: (messages: AppMessage[]) => void;
  }): Promise<{ chatId: string; answer: string; parked: boolean; pending?: SubagentPending[]; error?: string }> {
    // `||` (not `??`): an empty-string id must mint a fresh one, or the chat is
    // created with id "" and the UI can never open it.
    const chatId = o.chatId?.trim() || generateSubchatId();
    let chat = await storage.getChat(o.principal, chatId);
    const newParams = await checkChatParams(o.agent, chat, o.params);
    if (!chat) {
      chat = await storage.createChat(o.principal, {
        id: chatId,
        agent: o.agent,
        title: firstText(o.message)?.slice(0, 80),
        ...(newParams !== undefined ? { params: newParams } : {}),
        // Runtime-created thread: stamp it internal so a host filtering its
        // chat list on kind never shows it (see ChatRecord.kind).
        kind: "internal",
        ...(o.parentAgent ? { parentAgent: o.parentAgent } : {}),
      });
    }
    // A spawn may only continue a thread its own agent delegated. Otherwise
    // agent B could pass agent A's sub-thread id and have the child resolved
    // under A — borrowing whatever a host grants A's subagents.
    if (o.parentAgent && chat.parentAgent && chat.parentAgent !== o.parentAgent) {
      throw new Error(`Thread ${chatId} was delegated by another agent; omit threadId to start a new one.`);
    }
    const prior = await storage.loadMessages(o.principal, chatId);
    // Same rule as handleChat: a new message while the thread is parked on an
    // approval IS the decision — close the stale gate as declined (persisted)
    // and carry on. Otherwise a continued thread (`runAgent({ threadId })`,
    // `spawn_agent({ threadId })`) would run with an undecided gate in history
    // and this turn's verdict below would re-report that stale approval.
    if (hasPendingApproval(prior)) {
      const declined = declinePendingApprovals(prior);
      if (declined.length > 0) await ownedBy(chat.owner).appendMessages(chatId, declined);
    }
    // Gate before the message persists — a refused schedule/subagent turn
    // leaves nothing behind, same as handleChat. Same for a busy chat: open
    // the run first, persist the message only once it is ours to run.
    const admitted = await admitTurn(o.principal, o.agent, o.trigger);
    const { cfg, modelId, runtimeCtx, params, messageContext, run, lease } = await withReservation(admitted, async () => {
      const resolved = await resolveAgentConfig(o.agent, o.principal, undefined, o.turnContext, {
        // A continued thread keeps the parent it was created under (a mismatch
        // was refused above). Without a stored one — an adapter that doesn't
        // persist the column — the spawner of THIS turn is the parent: a host
        // that restricts a subagent by its parent must never see none.
        parentAgent: chat.parentAgent ?? o.parentAgent,
        autoApprove: o.autoApprove,
      }, chat.params, contextOf(o.message));
      const opened = await openTurn(o.principal, chat, o.agent, [o.message], resolved.cfg.configVersion, runSettingsOf(o));
      return { ...resolved, ...opened };
    });
    const onProgress = o.onProgress;
    let res: Response;
    try {
      res = await buildTurn({
        resolvedChatId: chatId,
        principal: o.principal,
        modelId,
        cfg,
        run,
        lease,
        uiMessages: [...prior, o.message],
        runtimeCtx,
        params,
        messageContext,
        admitted,
        autoApprove: o.autoApprove,
        blockGated: o.blockGated,
        memory: o.memory,
        model: o.model,
        promptCaching: o.promptCaching,
        depth: o.depth ?? 0,
        parentRunId: o.parentRunId,
        rootChatId: o.rootChatId,
        trigger: o.trigger,
        // Forward progressive UI-message snapshots to the caller (spawn_agent
        // streams them into the parent turn).
        observeStream: onProgress ? progressObserver([o.message], onProgress) : undefined,
      });
    } catch (e) {
      // Setup failed after the run opened — a tool source that would not
      // open, say. Settle the run (left `active`, it would hold the chat until
      // its lease or the stale timeout lapsed), give back the reservation, and
      // say why the way a failed turn does: as `error`, not a throw. Admission
      // refusals never get here — they throw before any run exists.
      const error = clientErrorMessage(e);
      // If settling fails too, say so: the run then stays active (holding the
      // chat until its lease lapses), and a caller told only the setup error
      // would retry into a busy chat without knowing why.
      const unsettled = await storage
        .updateRun(run.id, { status: "errored", error, endedAt: Date.now(), leaseOwner: null, leaseExpiresAt: null }, lease)
        .then(
          // `false`: the lease guard refused the write — another worker holds the run now.
          (applied) => (applied === false ? "its lease is held elsewhere" : undefined),
          (settleError: unknown) => clientErrorMessage(settleError),
        );
      await releaseReservation(admitted);
      if (unsettled) console.error(`[runAgent] run ${run.id} failed during setup and could not be settled: ${unsettled}`);
      return {
        chatId,
        answer: "",
        parked: false,
        error: unsettled ? `${error} (and the run could not be marked failed: ${unsettled})` : error,
      };
    }
    // The turn's own failure travels as an `error` chunk — the stream, not a
    // throw. Keep its text: without it a failed turn reads as a silent one.
    // A failure that ends the run without an error chunk (a final-step
    // `step_end` handler, caught in onFinish) is only on the run row: read it
    // back so a failed turn never looks like a silent one.
    const error = lastStreamError(await res.text()) ?? (await terminalError(run));

    const after = await storage.loadMessages(o.principal, chatId);
    // The verdict is about THIS turn, so read the FINAL message only (the same
    // rule hasPendingApproval applies): an undecided gate in an older message
    // is an abandoned turn, not this one's pause point.
    const last = after[after.length - 1];
    const pending = last?.role === "assistant" ? collectPendingApprovals([last]) : [];
    const parked =
      pending.length > 0 ||
      hasPendingApproval(after) ||
      (!!last && hasPendingToolResult([last]));
    return {
      chatId,
      answer: pending.length > 0 ? "" : lastAssistantText(after),
      parked,
      ...(pending.length > 0 ? { pending } : {}),
      ...(error ? { error } : {}),
    };
  }

  /**
   * Resume a subagent thread after its bubbled-up approval was decided: apply
   * the decision to the sub's gated tool, re-run the sub from history (the
   * approved tool executes, or returns denied), and return the sub's digest.
   *
   * If the resumed sub pauses AGAIN on a new gated tool, its pending
   * approval(s) are returned so the caller (`applyApproval`) can re-bubble
   * them to the parent as a fresh `data-subagent-approval` part — bubbling
   * recurses one round per decision round-trip.
   */
  async function resumeSubagentApproval(
    principal: P,
    subChatId: string,
    decisions: ApprovalDecision[],
    /** Telemetry linkage of the original sub-turn, so the trace stays nested. */
    linkage?: { parentRunId?: string; rootChatId?: string },
    /**
     * Stream the resumed sub-turn into the parent's response as the same
     * `data-subagent-progress` part `spawn_agent` wrote, so the delegation the
     * user just approved visibly runs again instead of sitting silent.
     */
    live?: { writer: TurnWriter; spawnToolCallId?: string },
  ): Promise<{ answer: string; pending?: SubagentPending[] }> {
    const subChat = await storage.getChat(principal, subChatId);
    if (!subChat) return { answer: "" };
    const subMessages = await storage.loadMessages(principal, subChatId);
    const changed = applyDecisions(subMessages, decisions);
    if (changed.length > 0) await ownedBy(subChat.owner).appendMessages(subChatId, changed);
    // Another gated call in the same sub step still undecided → can't finish.
    if (hasPendingApproval(subMessages)) return { answer: "" };

    const { cfg, modelId, runtimeCtx, params, messageContext } = await resolveAgentConfig(
      subChat.agent,
      principal,
      undefined,
      undefined,
      // Same shaping as the first sub-turn: the parent is read off the persisted
      // sub-thread, and this path is only ever reached by a human decision.
      { parentAgent: subChat.parentAgent, autoApprove: false },
      subChat.params,
      latestMessageContext(subMessages),
    );
    const admitted = await admitContinuation(principal, subChat.agent, "decision");
    const { run, lease } = await openRun(principal, subChat, subChat.agent, cfg.configVersion);
    const resumeFrom = trimTrailingAssistantPrefill(subMessages);
    let observeStream: ((observed: ReadableStream<unknown>) => void) | undefined;
    if (live) {
      const progress = subagentProgressWriter(live.writer, {
        toolCallId: live.spawnToolCallId,
        agent: subChat.agent,
        threadId: subChatId,
      });
      // The exchange being resumed: its prompt and the paused assistant
      // message, which the resumed turn extends in place.
      const last = resumeFrom[resumeFrom.length - 1];
      const continuing = last?.role === "assistant" ? last : undefined;
      const prompt = resumeFrom.findLast((m) => m.role === "user");
      const lead = prompt ? [prompt] : [];
      progress.now(continuing ? [...lead, continuing] : lead);
      observeStream = progressObserver(lead, progress.throttled, continuing);
    }
    const res = await buildTurn({
      resolvedChatId: subChatId,
      principal,
      modelId,
      cfg,
      run,
      admitted,
      lease,
      // Resume: same prefill guard as applyApproval — the paused sub turn may
      // have narrated after its gated call, and that text must not reach the
      // model as an assistant prefill.
      uiMessages: resumeFrom,
      runtimeCtx,
      params,
      messageContext,
      autoApprove: false, // keep gating any further writes in the sub
      depth: 1,
      // Keep the resumed turn nested under the original trace/session.
      parentRunId: linkage?.parentRunId,
      rootChatId: linkage?.rootChatId,
      // Reached only by a human deciding the bubbled-up approval.
      trigger: "decision",
      observeStream,
    });
    await res.text();
    const after = await storage.loadMessages(principal, subChatId);
    // Paused on a SECOND gated tool → lift it so the caller re-bubbles.
    const pending = collectPendingApprovals(after);
    if (pending.length > 0) return { answer: "", pending };
    return { answer: lastAssistantText(after) };
  }

  async function schedule({
    principal,
    agent,
    cron,
    timezone,
    prompt,
    delivery,
    onParked,
    params: paramsIn,
  }: {
    principal: P;
    agent: string;
    cron: string | null;
    timezone?: string;
    prompt: string;
    delivery?: unknown;
    onParked?: "skip" | "fire";
    params?: unknown;
  }): Promise<ScheduleRecord> {
    // Accept code-declared or dynamic (UI-created) agents.
    const known =
      !!config.agents[agent] || !!(await config.dynamicAgents?.resolve(agent, principal));
    if (!known) throw new Error(`Unknown agent: ${agent}`);
    // Checked now, so a bad schedule is refused when it's made, not at 9:00.
    const params = await paramsToSave(agent, config.agents[agent]?.meta?.params, paramsIn);
    const now = Date.now();
    let nextRunAt = now; // one-shot → fire on the next runDue
    if (cron) {
      const next = config.cron?.(cron, now, timezone);
      if (next == null) {
        throw new Error(
          "Recurring schedules need a `cron` evaluator in the runtime config (or the expression never fires)",
        );
      }
      nextRunAt = next;
    }
    return storage.createSchedule(principal, {
      agent,
      cron,
      timezone,
      prompt,
      nextRunAt,
      delivery,
      onParked,
      ...(params !== undefined ? { params } : {}),
    });
  }

  async function runDue(opts?: {
    now?: number;
  }): Promise<RunDueResult> {
    const now = opts?.now ?? Date.now();
    const claimed = await storage.claimDueSchedules(now, dur.leaseTtlMs, dur.instanceId);
    let fired = 0;
    let errors = 0;
    let skipped = 0;
    let parked = 0;
    let rejected = 0;
    for (const s of claimed) {
      const next = s.cron ? (config.cron?.(s.cron, now, s.timezone) ?? null) : null;
      // Rebuild the principal FIRST, because a refusal has to reach the one
      // write below: `completeSchedule` is fenced by the claim lease and clears
      // it, so there is no second write in which to disable the schedule. A
      // refused identity (`null`) is permanent — the owner was removed, the
      // account is gone — so the schedule is disabled rather than left to refuse
      // on every tick, which is how a revoked user's schedule stays invisible
      // forever. A THROW is transient and keeps today's contract: the occurrence
      // is still consumed, the fire is counted in `errors`, the schedule stays
      // live. Hosts keep the hook fast (see `reconstructPrincipal`); it now runs
      // inside the claim window.
      let principal: P | null = null;
      let principalError: { error: unknown } | undefined;
      try {
        principal = await reconstructPrincipal(s.identity);
      } catch (error) {
        principalError = { error };
      }
      const refused = !principalError && principal === null;
      // Consume the occurrence BEFORE firing, not after. The claim lease is
      // stamped once (never heartbeated), so while a fire is in flight the row
      // still reads `enabled AND nextRunAt <= now` — and once the lease TTL
      // (default 30s) lapses, ANY claimer re-fires the same occurrence: a
      // second node, a deploy overlap, the POST /cron/run backstop, even this
      // same instance's next tick. A scheduled agent turn routinely outlives
      // the TTL, and each duplicate is a full paid turn. Advancing first makes
      // the occurrence at-most-once: after this write the row is no longer due
      // (or no longer enabled, for one-shots), so it cannot be claimed again
      // regardless of lease state. Run-level durability — not an occurrence
      // retry — is what recovers a fire that dies mid-turn: the run row
      // survives and `sweep()` resumes it. For work that is billed per
      // attempt, "ran twice" is strictly worse than "ran once, resumed".
      try {
        const applied = await ownedBy(s.owner).completeSchedule(
          s.id,
          { nextRunAt: next ?? now, lastRunAt: now, enabled: next != null && !refused },
          dur.instanceId,
          // Which claim this is: a later pass on this same instance may have
          // re-claimed the row under the same owner id since.
          s.leaseExpiresAt != null ? { leaseExpiresAt: s.leaseExpiresAt } : undefined,
        );
        if (applied === false) {
          // The fence rejected us: our claim lapsed (the lease is never
          // renewed, and the hook above runs inside it) and a newer claim —
          // another node's, or a later pass on this one — holds this
          // occurrence. It fires it and accounts for it; firing here too would
          // be the duplicate paid turn consuming-first exists to prevent.
          console.warn(
            `[schedule] ${s.id} (${s.agent}): claim lost before the occurrence was consumed; ` +
              `the newer claim owns this fire`,
          );
          continue;
        }
      } catch (e) {
        // Cannot consume the occurrence → do NOT fire. Firing anyway would
        // leave the row due, and every subsequent tick would fire it again —
        // the swallowed version of this write was itself a repeat-fire bug.
        if (isOwnerKeyMismatchError(e)) await reportMismatch(e, { during: "schedule", scheduleId: s.id });
        else console.error(`[schedule] failed to advance ${s.id}; skipping this fire:`, e);
        errors++;
        continue;
      }
      if (principalError) {
        console.error(
          `[schedule] fire failed for ${s.id} (${s.agent}): reconstructPrincipal threw:`,
          principalError.error,
        );
        errors++;
        continue;
      }
      if (principal === null) {
        console.warn(
          `[schedule] ${s.id} (${s.agent}): reconstructPrincipal refused the schedule's ` +
            `identity — not fired, schedule disabled`,
        );
        rejected++;
        continue;
      }
      try {
        // Parked-predecessor guard: when the LAST fire's chat is still waiting
        // on a human (an undecided approval or tool result), firing again just
        // mints another parked chat and pays for the tokens up to the gate —
        // on every tick, forever. `onParked: "skip"` (the default) consumes
        // the occurrence without running instead; the answer is one approval
        // away in the existing chat, and the next occurrence re-checks. The
        // truth is the message-log fold, not run rows — same predicates the
        // interactive paths trust. Best-effort: a failed check must never
        // block a fire.
        if ((s.onParked ?? "skip") === "skip" && s.lastChatId) {
          try {
            const prior = await storage.loadMessages(principal, s.lastChatId);
            const last = prior[prior.length - 1];
            if (hasPendingApproval(prior) || (last && hasPendingToolResult([last]))) {
              console.warn(
                `[schedule] ${s.id} (${s.agent}): previous fire's chat ${s.lastChatId} ` +
                  `is still waiting on a human — skipping this occurrence (onParked: skip)`,
              );
              skipped++;
              continue;
            }
          } catch (e) {
            console.error(`[schedule] ${s.id}: parked check failed; firing anyway:`, e);
          }
        }
        // Give the host first refusal (e.g. run it in the user's channel thread
        // and stream the answer there). Only an explicit "not handled" falls
        // through to the default run, so a stale delivery target still gets
        // the work done in a chat. A hook that THROWS ends this occurrence as
        // an error instead: there's no knowing how far it got, and if it had
        // already run the agent (and failed on delivery, say), the default run
        // would be a second paid turn for the same occurrence — the duplicate
        // consuming-first exists to prevent.
        let handled = false;
        if (config.runSchedule) {
          let outcome: Awaited<ReturnType<NonNullable<typeof config.runSchedule>>>;
          try {
            outcome = await config.runSchedule({ schedule: s, principal });
          } catch (e) {
            console.error(
              `[schedule] runSchedule hook failed for ${s.id} (${s.agent}); not running it again ` +
                `the default way, which could repeat work the hook already did:`,
              e,
            );
            errors++;
            continue;
          }
          // Only an explicit decline (`false`, `{ handled: false }`) runs the
          // default. A missing or malformed result is an error, not a decline:
          // a hook that ran the agent and forgot to return would otherwise pay
          // for the occurrence twice.
          const declined =
            outcome === false ||
            (typeof outcome === "object" && outcome !== null && outcome.handled === false);
          const accepted =
            outcome === true ||
            (typeof outcome === "object" && outcome !== null && outcome.handled === true);
          if (!declined && !accepted) {
            console.error(
              `[schedule] runSchedule hook for ${s.id} (${s.agent}) returned ${String(outcome)}; ` +
                `expected true, false or { handled }. Not running it the default way.`,
            );
            errors++;
            continue;
          }
          handled = accepted;
          // The host owns the chat a channel fire ran in, so it is the only
          // one that can report it. Same accounting as the default path when
          // it does: stamp the chat for the next `onParked` check, and count
          // a park that nobody can answer.
          if (handled && typeof outcome === "object") {
            if (outcome.chatId) {
              await ownedBy(s.owner).noteScheduleFire(s.id, {
                lastChatId: outcome.chatId,
                firedAt: now,
              });
            }
            if (outcome.parked) {
              parked++;
              console.warn(
                `[schedule] ${s.id} (${s.agent}): host-delivered fire parked waiting on a ` +
                  `human${outcome.chatId ? ` in chat ${outcome.chatId}` : ""} — no answer was delivered`,
              );
            }
          }
        }
        if (!handled) {
          const chat = await storage.createChat(principal, {
            agent: s.agent,
            title: s.prompt.slice(0, 80),
            ...(s.params !== undefined ? { params: s.params } : {}),
          });
          // Remember where this fire ran so the NEXT occurrence can see a
          // parked predecessor. Stamped before the turn (a parked turn still
          // "completes" the await); optional — see StorageAdapter. `firedAt`
          // is the lastRunAt this fire's completeSchedule wrote above, so a
          // delayed stamp can't clobber a newer occurrence's.
          await ownedBy(s.owner).noteScheduleFire(s.id, { lastChatId: chat.id, firedAt: now });
          const outcome = await runToCompletion({
            principal,
            agent: s.agent,
            message: userMessageOf(s.prompt),
            chatId: chat.id,
            // A cron fire keeps HITL gates: nobody is here to waive them, and a
            // gated tool parks the turn (reported below) instead of running.
            autoApprove: false,
            trigger: "schedule",
          });
          if (outcome.parked) {
            // Say it on THIS tick, not the next one: a one-shot has no next
            // occurrence, and even a cron's operator shouldn't have to wait
            // for the skip message to learn that a paid fire produced nothing.
            parked++;
            console.warn(
              `[schedule] ${s.id} (${s.agent}): fire parked waiting on a human in ` +
                `chat ${chat.id} — no answer was delivered`,
            );
          }
        }
        fired++;
      } catch (e) {
        // The occurrence is already consumed (above), so this cannot repeat-
        // fire — but a silent `errors++` left hosts unable to see WHY a
        // schedule produced nothing.
        console.error(`[schedule] fire failed for ${s.id} (${s.agent}):`, e);
        errors++;
      }
    }
    return { fired, errors, skipped, parked, rejected };
  }

  const self: Runtime<P> = {
    listAgents: agentInfos,
    handleChat,
    runAgent: async ({
      principal,
      agent,
      prompt,
      files,
      threadId,
      params,
      blockGated = true,
      memory,
      model,
      turnContext,
      promptCaching,
      // No client stream: assume unattended unless the host says otherwise, so
      // a park here can't be silently filtered out as "someone's watching".
      trigger = "programmatic",
    }) => {
      const r = await runToCompletion({
        principal,
        agent,
        message: userMessageOf(prompt, files),
        chatId: threadId,
        params,
        depth: 1,
        // Autonomous: no human to authorize (blockGated stubs the gated tools).
        autoApprove: true,
        blockGated,
        memory,
        model,
        turnContext,
        promptCaching,
        trigger,
      });
      return { threadId: r.chatId, answer: r.answer, ...(r.error ? { error: r.error } : {}) };
    },
    compactChat,
    loadHistory,
    listChats,
    getChat: getChatById,
    listRuns,
    getRun,
    resume: (run) => resumeRun(typeof run === "string" ? { id: run } : run),
    sweep,
    cron,
    applyApproval,
    applyToolResult,
    schedule,
    listSchedules: ({ principal }) => storage.listSchedules(principal),
    unschedule: ({ principal, id }) => storage.deleteSchedule(principal, id),
    runScheduleNow: ({ principal, id }) => storage.bumpSchedule(principal, id),
    runDue,
  };
  return self;
}
