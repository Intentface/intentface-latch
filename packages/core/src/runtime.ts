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
import type { Experimental_SandboxSession, LanguageModel } from "ai";
import type { AppMessage } from "./message.js";
import type { ReconstructPrincipal } from "./principal.js";
import type { ContextDefinition, SecretResolver } from "./context.js";
import type {
  AgentConfig,
  AgentFactory,
  AgentInfo,
  OpenToolSet,
  ToolSource,
} from "./agent.js";
import { currentDateLine } from "./current-date.js";
import type { MemoryProvider } from "./memory.js";
import {
  COMPACTION_PART_TYPE,
  sliceAtCompaction,
  toClientMessages,
  toModelMessages,
} from "./projections.js";
import { summarizeForCompaction } from "./compaction.js";
import { computeCost, type Pricing } from "./pricing.js";
import {
  defaultPromptCachingPlan,
  markLastFunctionTool,
  mergeProviderOptions,
  toolsetHash,
  type PromptCachingPlan,
} from "./prompt-caching.js";
import type { LatchTelemetry, TelemetryRunMeta } from "./telemetry.js";
import type {
  ChatRecord,
  RunLease,
  RunRecord,
  RunStatus,
  ScheduleRecord,
  StorageAdapter,
} from "./storage.js";

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
/**
 * T2 durability (opt-in). When enabled, each turn claims a single-writer lease,
 * heartbeats it while streaming, and aborts if the lease is lost. A reaper
 * (`runtime.tick()`, driven by cron) reclaims runs whose owner died.
 */
export interface DurabilityConfig {
  enabled?: boolean;
  /** Lease lifetime in ms; a run is reapable once `now > leaseExpiresAt` (default 30s). */
  leaseTtlMs?: number;
  /** Heartbeat cadence in ms; must be comfortably < leaseTtlMs (default 10s). */
  heartbeatMs?: number;
  /** Stable owner id for this runtime instance (default: random per process). */
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
export interface DynamicAgentStore<P> {
  /** Build an agent's config for this caller, or undefined if not found. */
  resolve(
    name: string,
    principal: P,
  ): AgentConfig<P> | undefined | Promise<AgentConfig<P> | undefined>;
  /** The caller's dynamic agents, for the picker. */
  list(principal: P): AgentInfo[] | Promise<AgentInfo[]>;
}

export interface RuntimeConfig<P, RuntimeContext = unknown> {
  storage: StorageAdapter<P>;
  context: ContextDefinition<P, RuntimeContext>;
  /** The agent registry: name → factory (file-based or DB-driven upstream). */
  agents: Record<string, AgentFactory<P, RuntimeContext>>;
  secrets?: SecretResolver<P>;
  durability?: DurabilityConfig;
  /** Optional cost calculation. Without it, recorded cost is 0. */
  pricing?: Pricing;
  /**
   * Connection registry used to resolve each agent's `connections: [...]` names
   * into a per-turn tool source (MCP servers / integrations). Optional — without
   * it, `connections` on an agent is ignored.
   */
  connections?: ConnectionRegistry<P>;
  /**
   * Resolve agents not in the static `agents` registry (e.g. DB/UI-created),
   * per caller. Optional — without it, only code-declared agents exist.
   */
  dynamicAgents?: DynamicAgentStore<P>;
  /**
   * Memory seam: gives agents that declare `memory` persistent cross-session
   * memory (compiled index injected into instructions + scope-bound
   * `memory_search`/`memory_save` tools). Optional — without it, an agent's
   * `memory` declaration is ignored. See `MemoryProvider`.
   */
  memory?: MemoryProvider<P>;
  /**
   * Rebuild a `Principal` from the opaque identity blob a run stored, for
   * resume/cron (no request). Default: passthrough (`identity as P`). Override to
   * re-hydrate (e.g. re-fetch fresh identity) or validate on resume.
   */
  reconstructPrincipal?: ReconstructPrincipal<P>;
  /**
   * Next-fire evaluator for scheduled agents: given a cron expression, a lower
   * bound (epoch ms), and an optional IANA timezone the expression is
   * interpreted in, return the next fire time (epoch ms) or null if it never
   * fires again. Keeps core cron-library-free — wire e.g. `croner`. Required to
   * create recurring schedules.
   */
  cron?: (expr: string, afterMs: number, timezone?: string) => number | null;
  /**
   * Optional per-fire override for `runDue`, so a host can run a scheduled turn
   * somewhere the default can't reach — typically a chat channel, where the
   * report should land in the conversation the person actually replies in.
   *
   * Return true when the host ran (and delivered) this fire ITSELF; core then
   * skips its own fresh-chat run. Anything else — false, absent, or a throw —
   * falls through to the default, so a host whose delivery target has gone
   * stale (bot disabled, user unlinked) still gets the work done in a chat
   * rather than losing the fire.
   *
   * A host that wants the SAME accounting the default path gets can return the
   * object form instead of a bare boolean: `chatId` lets the next occurrence's
   * `onParked` check see this fire's conversation, and `parked` joins `runDue`'s
   * `parked` count. Core cannot derive either itself — the host owns the chat a
   * channel fire runs in. Omit them and this fire simply isn't accounted (the
   * bare-boolean behavior), which is correct for a host that reports its own.
   *
   * Core keeps owning the claim, the lease and the advance either way, and
   * stays entirely channel-blind: `schedule.delivery` is opaque here and only
   * ever interpreted by this hook.
   */
  runSchedule?: (input: {
    schedule: ScheduleRecord;
    principal: P;
  }) => Promise<boolean | { handled: boolean; chatId?: string; parked?: boolean }>;
  /**
   * Resolve a per-session sandbox for an agent that declares `sandbox: true`.
   * Returns the AI SDK `Experimental_SandboxSession` passed to the model
   * (`agent.stream({ experimental_sandbox })`) and read by sandbox tools. Keeps
   * core free of any sandbox backend dep — the platform supplies the provider
   * (e.g. just-bash / Daytona). The sandbox is per chat (`chatId`).
   */
  sandbox?: (args: {
    principal: P;
    chatId: string;
    agent: string;
    provider?: string;
  }) => Experimental_SandboxSession | Promise<Experimental_SandboxSession>;
  /**
   * The default harness tools, supplied by the platform (kept out of core so we
   * carry no sandbox/QuickJS deps). `sandbox` tools (bash/read_file/write_file/
   * glob/grep) operate on the resolved `experimental_sandbox`; `app` tools
   * (web_fetch/todo/ask_question) run in the app process. Merged into an agent's
   * toolset per its `sandbox`/`defaultTools` flags.
   */
  harnessTools?: {
    sandbox?: Record<string, unknown>;
    /**
     * App-process tools. A static record for principal-independent tools
     * (web_fetch, …), or a per-turn factory when the tools must bind to the
     * caller (e.g. workspace file/db tools scoped to the user's permissions
     * and the current chat).
     */
    app?:
      | Record<string, unknown>
      | ((args: {
          principal: unknown;
          chatId: string;
          agent: string;
        }) => Record<string, unknown> | Promise<Record<string, unknown>>);
    /**
     * Platform render tool(s) — attached only when an agent sets
     * `renderTools: true`, never by `defaultTools`. Kept a separate capability
     * (like `sandbox`) because it's platform-specific (needs a deployed render
     * service) and should be opted into explicitly.
     */
    render?: Record<string, unknown>;
    /**
     * Default approval policy for harness tools, by tool name (e.g.
     * `{ create_schedule: "user-approval" }`). Applied only to tools actually
     * attached to the agent, and merged like a tool source's: the AGENT WINS
     * for names it lists in its own `toolApproval`, so a host can ship a
     * side-effecting harness tool gated by default without freezing that
     * choice.
     */
    approval?: Record<string, unknown>;
  };
  /**
   * Resolve the model provider's NATIVE web tools (server-side search/fetch) for
   * a model id — kept out of core so it carries no provider SDK dep. Merged into
   * an agent's toolset when it sets `providerWebTools`. Return `{}` for providers
   * without native web tools.
   */
  resolveProviderTools?: (modelId: string) => Record<string, unknown>;
  /**
   * Resolve an agent's `effort` to provider-specific reasoning options for a
   * model id — kept out of core (no provider SDK dep). Returns the
   * `providerOptions` (keyed by provider id) and an optional `maxOutputTokens`
   * (token-budget providers need the budget to stay under the model's max).
   * Return `undefined` to leave the provider default (e.g. non-reasoning model).
   */
  resolveReasoningOptions?: (
    modelId: string,
    effort: string,
  ) => { providerOptions?: Record<string, unknown>; maxOutputTokens?: number } | undefined;
  /**
   * Resolve the prompt-caching plan for a model id. Supply it when you own a
   * model catalog (you know the provider family better than the model object
   * does) or need per-principal cache routing — typically
   * `promptCachingPlanFor(providerOf(modelId), { agent, cacheKeySuffix })`.
   * `memoryScoped` is true when the turn's system prompt is per-principal
   * (memory-enabled agent) — use it to scope OpenAI's cache routing key.
   *
   * ABSENT hook → caching defaults ON for first-party Anthropic/OpenAI models
   * (see `defaultPromptCachingPlan`; measured ~6x unit cost on MCP-heavy
   * agents). Opt out with `resolvePromptCaching: () => undefined`, or per turn
   * with `promptCaching: false`. Returning `undefined` for a model disables
   * caching for it.
   */
  resolvePromptCaching?: (
    modelId: string,
    args: { agent: string; memoryScoped: boolean; principal: P },
  ) => PromptCachingPlan | undefined;
  /**
   * Wrap a set of tools into a single code-mode tool (the model writes JS that
   * calls them as functions). Supplied by the platform (e.g. via
   * `experimental-ai-sdk-code-mode`), so core needs no QuickJS dep. Used when an
   * agent sets `codeMode`.
   */
  codeModeWrap?: (
    tools: Record<string, unknown>,
    opts?: { agent: string },
  ) => unknown;
  /**
   * Tracing seam (kept out of core — no OTEL/vendor dep). Supplies per-run AI
   * SDK telemetry options, an optional trace wrapper around the model call, and
   * a post-turn hook (e.g. `@intentface/latch-langfuse`). This is the OTEL/span
   * plumbing — the `observability` seam below is for plain event callbacks.
   * Optional — without it, nothing is traced and behavior is unchanged.
   */
  telemetry?: LatchTelemetry<P>;
  /**
   * Optional observability seam — consumer telemetry (usage rollups, per-tool
   * analytics, tracing) attached WITHOUT wrapping `handleChat`. Complements the
   * built-in `recordUsage` (billing rollup): this is where an app emits its own
   * events. Fires for subagent turns too — distinguish via `depth` (0 =
   * top-level). All hooks are fire-and-forget: a thrown/rejected hook is
   * swallowed so telemetry never breaks a turn. Without it, zero behavior change.
   */
  observability?: ObservabilityHooks<P>;
}

/** Fields common to every observability event. */
/**
 * What started this turn — and, in practice, whether a human is at the other
 * end of it:
 *
 * - `"chat"` — a user message (`handleChat` / `runTurnStream`). Someone is
 *   watching the stream.
 * - `"decision"` — a human answered a pending request: an approval decision or
 *   a client-handled tool result. Someone is watching.
 * - `"schedule"` — a cron/one-shot fire (`runDue`). NOBODY is watching.
 * - `"programmatic"` — the host called `runAgent` directly (a background job, a
 *   webhook handler, a test run). There is no client stream, and only the host
 *   knows whether a person is waiting on the result — so `runAgent` takes a
 *   `trigger` to say when it does.
 * - `"resume"` — the durability sweep recovered a crashed run and drove it to
 *   completion server-side. Nobody is watching.
 *
 * That distinction is what makes the observability hooks usable as an
 * operational notification channel and not just an analytics feed: a turn that
 * finishes `awaiting_input` under `"schedule"` or `"resume"` is a person who
 * needs to be told, while the same status under `"chat"` or `"decision"` is
 * just a gate rendering in front of someone who can answer it.
 *
 * A subagent turn inherits its parent's trigger (like `rootChatId`), so a
 * whole delegation tree is attributable to what set it off.
 */
export type TurnTrigger = "chat" | "decision" | "programmatic" | "schedule" | "resume";

export interface ObservabilityEventBase<P> {
  principal: P;
  chatId: string;
  runId: string;
  /** The agent (registry key) running this turn. */
  agent: string;
  /** Resolved model id for this turn. */
  modelId: string;
  /** Delegation depth: 0 = top-level turn, >0 = a subagent turn. */
  depth: number;
  /** What started this turn — see {@link TurnTrigger}. */
  trigger: TurnTrigger;
}

/** One completed generation step (model call + any tool calls made in it). */
export interface ObservabilityStepEvent<P> extends ObservabilityEventBase<P> {
  step: {
    text?: string;
    finishReason?: string;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
    toolCalls?: Array<{
      toolCallId: string;
      toolName: string;
      input?: unknown;
    }>;
    toolResults?: Array<{
      toolCallId: string;
      toolName: string;
      output?: unknown;
    }>;
  };
}

/** The turn settled. `usage`/`cost` are the turn totals also written to the run. */
export interface ObservabilityFinishEvent<P> extends ObservabilityEventBase<P> {
  status: "completed" | "awaiting_input" | "errored";
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  cost: number;
  messages: AppMessage[];
}

export interface ObservabilityErrorEvent<P> extends ObservabilityEventBase<P> {
  error: unknown;
}

export interface ObservabilityHooks<P> {
  /** After each generation step (model output + the step's tool calls/results). */
  onStep?: (event: ObservabilityStepEvent<P>) => void | Promise<void>;
  /** After the turn settles (completed / awaiting_input / errored-on-abort). */
  onFinish?: (event: ObservabilityFinishEvent<P>) => void | Promise<void>;
  /** When the turn errors. */
  onError?: (event: ObservabilityErrorEvent<P>) => void | Promise<void>;
}

export interface HandleChatInput<P> {
  /** Which registered agent to run. */
  agent: string;
  /** Client-chosen chat id (create-or-continue). Omit to start a new chat. */
  chatId?: string;
  /** Resolved by the caller's ContextResolver (isolation flows from this). */
  principal: P;
  /** The incoming user message. */
  message: AppMessage;
  /** Optional original request, passed to context.build. */
  request?: Request;
  /**
   * Per-turn request payload, passed to `context.build` and the agent factory.
   * EPHEMERAL: never persisted with the run (only the principal is stored as
   * `runs.identity`), so it is absent on resume/cron. Use it for request-scoped
   * inputs (active document, UI selection, parsed body fields) — never identity.
   */
  turnContext?: unknown;
}

export interface Runtime<P> {
  /** The agents available to the caller (code-declared + dynamic) — for a picker. */
  listAgents(principal: P): Promise<AgentInfo[]>;
  /** Run one turn; returns a streaming UIMessage `Response`. */
  handleChat(input: HandleChatInput<P>): Promise<Response>;
  /**
   * Run one agent turn from the supplied messages and stream it back, persisting
   * NOTHING (no chat/run/message/usage rows). The full tool loop, streaming, and
   * observability hooks all run; durability, history, and HITL round-tripping are
   * not available. For read-mostly, single-shot loops where a durable chat would
   * be pure churn (e.g. inline editor assist). Use `handleChat` when you need
   * history, resume, or approvals.
   */
  runTurnStream(input: {
    agent: string;
    principal: P;
    messages: AppMessage[];
    request?: Request;
    /** Per-turn request payload (see HandleChatInput.turnContext). */
    turnContext?: unknown;
    /** Body format: `ui` (default) SSE UIMessage stream, or `text` plain text. */
    format?: "ui" | "text";
    /** Fired with the final assistant text + messages (capture side outputs). */
    onComplete?: (result: {
      text: string;
      messages: AppMessage[];
    }) => void | Promise<void>;
  }): Promise<Response>;
  /**
   * Run one agent to completion once, autonomously, in an isolated throwaway
   * thread (no streaming) — for programmatic use like the Agent Builder testing
   * an agent it just created. `blockGated` (default true) stubs approval-gated
   * (mutating) tools so a test run has no real side effects; pass false for a
   * true end-to-end run. Returns the throwaway threadId + the final answer.
   */
  runAgent(input: {
    principal: P;
    agent: string;
    prompt: string;
    threadId?: string;
    blockGated?: boolean;
    /**
     * Per-turn request payload, passed to `context.build` and the agent
     * factory (see `HandleChatInput.turnContext`). Ephemeral — never persisted,
     * absent on resume.
     */
    turnContext?: unknown;
    /**
     * Per-turn prompt-caching override. `false` = set no caching provider
     * options for this run (the control arm of an A/B comparison); default on
     * when the runtime has a `resolvePromptCaching` hook.
     */
    promptCaching?: boolean;
    /**
     * How to classify this run on the observability events (see `TurnTrigger`).
     * Defaults to `"programmatic"` — there is no client stream here, so the
     * safe assumption is that nobody is watching, and a host that knows better
     * (a webhook with a user waiting) says so by passing `"chat"`.
     */
    trigger?: TurnTrigger;
  }): Promise<{ threadId: string; answer: string }>;
  /**
   * Summarize a conversation and append a compaction boundary, so later turns
   * send the model the summary instead of the turns it replaces. Stored history
   * is untouched — this shrinks the model projection, not the record. Null when
   * there's too little to compact (or the chat isn't the caller's); throws
   * `PendingApprovalError` when the last turn is paused awaiting a human.
   */
  compactChat(input: {
    chatId: string;
    principal: P;
    /** Optional steer for the summary ("keep the training plan"). */
    focus?: string;
    request?: Request;
    turnContext?: unknown;
  }): Promise<{ summary: string; compacted: number } | null>;
  /**
   * Client-projected conversation history (`toClientMessages`): the stored
   * messages with `internal`/`redacted` ones filtered out. For rendering past
   * turns on load.
   */
  loadHistory(input: {
    chatId: string;
    principal: P;
  }): Promise<AppMessage[]>;
  /**
   * The caller's chats, most-recent first (for a chat list / sidebar).
   * `kind` filters to one chat kind (e.g. `'user'` to hide the runtime's
   * internal `sub_…` threads); omitted → all kinds (back-compatible default).
   */
  listChats(input: {
    principal: P;
    limit?: number;
    kind?: string;
  }): Promise<ChatRecord[]>;
  /**
   * One chat by id, scoped to the caller (null when it isn't theirs or doesn't
   * exist). A direct lookup, not a capped scan — so "does this chat exist, and
   * whose agent is it?" stays correct for a tenant with any number of chats.
   */
  getChat(input: { principal: P; id: string }): Promise<ChatRecord | null>;
  /** The caller's runs, most-recent first (status, usage, cost — for an ops view). */
  listRuns(input: {
    principal: P;
    limit?: number;
  }): Promise<RunRecord[]>;
  /**
   * One run by id, scoped to the caller: returns it only when the run's chat is
   * owned by `principal` (else null). A direct lookup — no capped scan — so it's
   * safe for ownership checks on arbitrarily old runs.
   */
  getRun(input: { principal: P; runId: string }): Promise<RunRecord | null>;
  /**
   * Reaper tick (cron/Scheduler entry point): reclaim runs whose lease expired.
   * Returns the reaped runs. No-op-safe to call on every node.
   */
  tick(opts?: { now?: number; error?: string }): Promise<{ reaped: RunRecord[] }>;
  /**
   * Resume an interrupted run (requires durability). Re-claims it exactly-once,
   * re-runs the turn from persisted history, and completes it server-side.
   * Returns the run's final state, or null if it wasn't resumable (already
   * completed, or claimed by another node).
   */
  resume(runId: string): Promise<RunOutcome | null>;
  /**
   * Reaper + auto-resume in one call — the Scheduler/cron entry point. Reaps
   * lease-expired runs, then resumes each whose attempt count is still under
   * `maxAttempts` (default 5; the cap stops poison runs from looping forever).
   * Safe to fire on every node: reap and reclaim are atomic, so each run is
   * handled exactly once.
   */
  sweep(opts?: {
    now?: number;
    maxAttempts?: number;
    error?: string;
  }): Promise<{ reaped: RunRecord[]; resumed: RunOutcome[] }>;
  /**
   * Apply HITL tool-approval decisions and continue the turn. Records each
   * decision onto the persisted assistant message (approval-requested →
   * approval-responded), then re-runs the agent from history: approved tools
   * execute, denied ones are skipped. Returns the continuation's streaming
   * Response. No suspension machinery — approvals round-trip as message state.
   */
  applyApproval(input: {
    chatId: string;
    principal: P;
    decisions: ApprovalDecision[];
    request?: Request;
    /** Per-turn request payload (see HandleChatInput.turnContext). */
    turnContext?: unknown;
  }): Promise<Response>;
  /**
   * Resume a turn paused on a client-handled tool (no `execute`, e.g.
   * `askUser`): record the supplied output onto the matching tool call and
   * re-run from history. Returns the continuation stream, or an empty 200 if
   * other client tool calls in the step still need results.
   */
  applyToolResult(input: {
    chatId: string;
    principal: P;
    toolCallId: string;
    output: unknown;
    request?: Request;
    /** Per-turn request payload (see HandleChatInput.turnContext). */
    turnContext?: unknown;
  }): Promise<Response>;
  /**
   * Schedule an agent to run on a cron expression (or `cron: null` for one-shot,
   * fired on the next `runDue`). Captures the caller's identity for fire-time.
   * Requires `cron` in the runtime config for recurring schedules.
   */
  schedule(input: {
    principal: P;
    agent: string;
    cron: string | null;
    /** IANA timezone the cron is interpreted in (e.g. "Europe/Helsinki"). */
    timezone?: string;
    prompt: string;
    /**
     * Opaque, host-interpreted delivery target for each fire (see
     * `RuntimeConfig.runSchedule`). Stored verbatim; core never reads it.
     */
    delivery?: unknown;
    /**
     * What a fire does while the previous fire's chat is still parked waiting
     * on a human (see `ScheduleRecord.onParked`). Default `"skip"`.
     */
    onParked?: "skip" | "fire";
  }): Promise<ScheduleRecord>;
  /** The caller's schedules. */
  listSchedules(input: { principal: P }): Promise<ScheduleRecord[]>;
  /** Delete one of the caller's schedules. */
  unschedule(input: { principal: P; id: string }): Promise<void>;
  /**
   * Make one of the caller's schedules due immediately. It then fires through
   * the ordinary `runDue` path — same claim, same delivery, same advance — so
   * "run now" can never drift from what the cron actually does.
   *
   * False when nothing was armed: unknown id, not the caller's, or already
   * spent.
   */
  runScheduleNow(input: { principal: P; id: string }): Promise<boolean>;
  /**
   * Fire all due schedules across ALL tenants (system op — the cron entry point).
   * Claims each, consumes the occurrence (advances `nextRunAt` BEFORE firing,
   * so no concurrent claimer can fire it again), reconstructs its principal,
   * and runs the turn in a fresh chat (or via `runSchedule`, when the host
   * handles the fire). Point a platform cron (or the in-process scheduler) at
   * this.
   *
   * Occurrences are at-most-once: a process that dies mid-fire does not retry
   * the occurrence — the run row survives and `sweep()` resumes the turn
   * instead, so recovery never means a second paid attempt.
   *
   * Awaits each fired turn to completion before returning. A driver that also
   * gates on this promise (the in-process interval scheduler does) is stalled
   * for the duration of the longest turn — fan out per tenant rather than
   * looping serially if that matters to you.
   *
   * `skipped` counts occurrences consumed WITHOUT running because the previous
   * fire's chat is still parked on a human (see `ScheduleRecord.onParked`) —
   * distinct from `errors` so a quiet schedule is legible as "waiting on you",
   * never mistaken for "ran fine" or "broken".
   *
   * `parked` counts fires that RAN and then stopped waiting on a human (an
   * approval or question they cannot answer) — tokens spent, no answer
   * delivered. They are counted in `fired` too: the turn did happen. A
   * non-zero `parked` is the signal to go look — a cron whose every fire parks
   * is paying for nothing, and for a one-shot schedule there is no later
   * occurrence to notice. Chats awaiting a human are queryable via
   * `ChatRecord.lastRunStatus`.
   */
  runDue(opts?: {
    now?: number;
  }): Promise<{ fired: number; errors: number; skipped: number; parked: number }>;
}

/** A user's decision on one pending tool-approval request. */
export interface ApprovalDecision {
  approvalId: string;
  approved: boolean;
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
/** Synthetic run id for an ephemeral (unpersisted) `runTurnStream` turn. */
const generateRunId = createIdGenerator({ prefix: "run", separator: "_" });

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
function firstText(message: AppMessage): string | undefined {
  const text = (message.parts ?? [])
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join(" ")
    .trim();
  return text.length > 0 ? text : undefined;
}

/** The text of the turn's incoming user message (for telemetry). */
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
export function trimTrailingAssistantPrefill(messages: AppMessage[]): AppMessage[] {
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
  // No tool anchor at all → nothing safe to say about this shape; leave it.
  if (anchor === -1) return messages;
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

/** Invoke an observability hook fire-and-forget — a thrown/rejected hook is
 * swallowed so telemetry never breaks a turn. */
function fireObs<E>(
  hook: ((event: E) => void | Promise<void>) | undefined,
  event: E,
): void {
  if (!hook) return;
  try {
    void Promise.resolve(hook(event)).catch(() => {});
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
  const reconstructPrincipal: ReconstructPrincipal<P> =
    config.reconstructPrincipal ?? ((identity) => identity as P);
  const dur = {
    enabled: config.durability?.enabled ?? false,
    leaseTtlMs: config.durability?.leaseTtlMs ?? 30_000,
    heartbeatMs: config.durability?.heartbeatMs ?? 10_000,
    instanceId: config.durability?.instanceId ?? newInstanceId(),
  };

  /** Resolve an agent's per-request config + a display model id. */
  async function resolveAgentConfig(
    agentName: string,
    principal: P,
    request?: Request,
    turnContext?: unknown,
  ): Promise<{ cfg: AgentConfig<P>; modelId: string; runtimeCtx: RC }> {
    const runtimeCtx = await config.context.build({ principal, request, turnContext });
    // Code-declared agents first; otherwise a dynamic (e.g. DB-stored) agent.
    const factory = config.agents[agentName];
    const cfg = factory
      ? await factory({ context: runtimeCtx, runtime: runtimeCtx, principal, turnContext })
      : await config.dynamicAgents?.resolve(agentName, principal);
    if (!cfg) throw new Error(`Unknown agent: ${agentName}`);
    const modelId =
      typeof cfg.model === "string"
        ? cfg.model
        : ((cfg.model as { modelId?: string }).modelId ?? "unknown");
    return { cfg, modelId, runtimeCtx };
  }

  /**
   * Build (and start) one turn's stream — shared by a fresh chat turn and a
   * resume. With durability on, it heartbeats the lease and aborts if it's
   * lost; onFinish writes are fenced by `lease`. The caller decides whether to
   * hand the stream to a client (handleChat) or drive it to completion
   * server-side (resume).
   */
  async function buildTurn(args: {
    resolvedChatId: string;
    principal: P;
    modelId: string;
    cfg: AgentConfig<P>;
    run: RunRecord;
    lease: RunLease | undefined;
    uiMessages: AppMessage[];
    runtimeCtx: RC;
    /** Subagent runs: waive approvals + drop OAuth `connect_` gates (no human). */
    autoApprove?: boolean;
    /**
     * Test runs: instead of executing approval-gated (mutating) tools, stub them
     * to return a "blocked" result — so a trial run has no real side effects.
     * Only meaningful with `autoApprove` (an autonomous run).
     */
    blockGated?: boolean;
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
     * observability event so a host can tell an unattended park — nobody to
     * answer the gate — from an interactive one. Defaults to `"chat"`.
     */
    trigger?: TurnTrigger;
    /** Telemetry linkage: the run that spawned this subagent turn (if any). */
    parentRunId?: string;
    /** Telemetry linkage: the top-level conversation id (threaded through
     *  subagent turns so a delegation tree shares one trace session). */
    rootChatId?: string;
    /**
     * Ephemeral turn (`runTurnStream`): stream a full tool-loop turn WITHOUT
     * persisting anything — no run/lease, no message/run/usage writes. The
     * observability hooks still fire (usage/analytics), tool sources still
     * open/close. For read-mostly, single-shot loops (e.g. inline editor assist)
     * where a durable chat would be pure churn. `run` is a synthetic record.
     */
    ephemeral?: boolean;
    /**
     * Response body format (ephemeral turns): `ui` (default) → the SSE
     * UIMessage stream; `text` → a plain `text/plain` stream of the assistant's
     * text deltas (parity with the AI SDK's `toTextStreamResponse`), for
     * consumers that render raw text.
     */
    responseFormat?: "ui" | "text";
    /**
     * Fired once the turn's messages are final (after any persistence), with the
     * assembled assistant text + the full message list — so an ephemeral caller
     * can capture side outputs (e.g. tool results) that the text stream drops.
     */
    onComplete?: (result: {
      text: string;
      messages: AppMessage[];
    }) => void | Promise<void>;
    /**
     * Observe the turn's UI chunk stream without consuming it (the response
     * gets a tee'd branch). Used by `runSubagent` to forward a subagent's
     * live output into the parent turn. The observer owns its branch — it
     * must keep reading or the tee buffers.
     */
    observeStream?: (stream: ReadableStream<unknown>) => void;
  }): Promise<Response> {
    const { resolvedChatId, principal, modelId, cfg, run, lease, uiMessages, runtimeCtx } =
      args;
    const autoApprove = args.autoApprove ?? false;
    const blockGated = args.blockGated ?? false;
    const depth = args.depth ?? 0;
    const trigger = args.trigger ?? "chat";
    const ephemeral = args.ephemeral ?? false;
    // The top-level conversation id — this turn's own chat unless a spawn
    // threaded a root down. Subagent turns spawned below inherit it, so a whole
    // delegation tree shares one telemetry session (see telemetryMeta).
    const rootChatId = args.rootChatId ?? resolvedChatId;

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
        void storage
          .heartbeatRun(run.id, lease.owner, dur.leaseTtlMs, lease.fencingToken)
          .then((held) => {
            missedBeats = 0;
            if (!held) {
              stopHeartbeat();
              abort.abort(new Error("lease lost"));
            }
          })
          .catch((e) => missBeat("write failed", e))
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
      for (const source of sources) {
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
    if (cfg.memory && config.memory) {
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
            const write = (messages: AppMessage[]) => {
              writer.write({
                type: "data-subagent-progress",
                id: `subagent_${options.toolCallId ?? subChatId}`,
                data: {
                  toolCallId: options.toolCallId,
                  agent,
                  threadId: subChatId,
                  messages,
                } satisfies SubagentProgressData,
              });
            };
            write([]);
            // Each write re-sends the whole snapshot — throttle the re-sends.
            // The trailing tokens are covered by the tool RESULT (the client
            // switches to the persisted thread once output lands).
            let lastWrite = 0;
            onProgress = (messages) => {
              const now = Date.now();
              if (now - lastWrite < 250) return;
              lastWrite = now;
              write(messages);
            };
          }
          // Propagate the PARENT turn's approval mode: interactive → the subagent
          // gates its tools (a pending write bubbles up here); autonomous → it
          // auto-approves.
          const result = await runSubagent({
            principal,
            agent,
            prompt,
            threadId: subChatId,
            depth: depth + 1,
            autoApprove,
            onProgress,
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
                subChatId: result.threadId,
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
              threadId: result.threadId,
              pending: result.pending.map((p) => p.summary),
              note: "Awaiting the user's approval — do not retry; stop here, the user will decide and you'll continue automatically.",
            };
          }
          return { threadId: result.threadId, answer: result.answer };
        },
      });
      capabilityTools.push("spawn_agent");
    }

    // Subagent runs are autonomous — there's no human to authorize, so waive
    // approvals and drop the OAuth `connect_` gates (they'd pause forever).
    if (autoApprove) {
      for (const k of Object.keys(tools)) if (k.startsWith("connect_")) delete tools[k];
      // Test runs: stub the approval-gated (mutating) tools so a trial has no
      // real side effects. Gated set = connection defaults + the agent's policy.
      if (blockGated) {
        const gated = new Set<string>();
        for (const [k, v] of Object.entries(harnessApproval)) if (v) gated.add(k);
        for (const o of opened) {
          for (const [k, v] of Object.entries(o.toolApproval ?? {})) if (v) gated.add(k);
        }
        if (cfg.toolApproval && typeof cfg.toolApproval !== "function") {
          for (const [k, v] of Object.entries(cfg.toolApproval as Record<string, unknown>)) {
            if (v) gated.add(k);
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
              execute: async (input: unknown) => ({
                __blocked: true,
                tool: name,
                input,
                reason: "approval-gated tool blocked during test run (no real side effects)",
              }),
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
    const toolApproval = autoApprove
      ? undefined
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
    const stopWhen =
      cfg.maxSteps === "unlimited"
        ? stepCountIs(Number.MAX_SAFE_INTEGER)
        : typeof cfg.maxSteps === "number"
          ? stepCountIs(cfg.maxSteps)
          : undefined;

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
              memoryScoped: !!(cfg.memory && config.memory),
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

    // Telemetry seam: per-run AI SDK telemetry options + trace correlation
    // identity, resolved once per turn (undefined → nothing traced).
    const telemetryMeta: TelemetryRunMeta<P> = {
      runId: run.id,
      chatId: resolvedChatId,
      agent: run.agent,
      modelId,
      principal,
      startedAt: run.startedAt,
      depth,
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
      // Every agent gets a trailing "today's date" line — after the memory
      // block, so it stays the tail. Day-granularity by design — see
      // `currentDateLine` for the prompt-cache reasoning. With a caching plan,
      // the instructions become a MARKED system message and the date line a
      // separate unmarked one, so the daily flip lands after the breakpoint
      // instead of invalidating it at midnight UTC.
      instructions: caching?.systemProviderOptions
        ? [
            ...(instructions
              ? [
                  {
                    role: "system",
                    content: instructions,
                    providerOptions: caching.systemProviderOptions,
                  },
                ]
              : []),
            { role: "system", content: currentDateLine() },
          ]
        : [instructions, currentDateLine()].filter(Boolean).join("\n\n"),
      tools,
      toolApproval,
      stopWhen,
      activeTools,
      ...(providerOptions ? { providerOptions } : {}),
      ...(reasoning?.maxOutputTokens ? { maxOutputTokens: reasoning.maxOutputTokens } : {}),
      ...(telemetryOptions ? { telemetry: telemetryOptions } : {}),
    } as ConstructorParameters<typeof ToolLoopAgent>[0]);

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;

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
        // (in-turn writer writes — e.g. a "compacting…" / compaction marker —
        //  would go here, before the model output is merged in)
        // Model projection: drops `sendToModel:false` messages (and data-* parts).
        const modelMessages = await toModelMessages(uiMessages, { tools });
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
          // the project's runtime context + who it's for + the run + the writer.
          // A tool reads it as `options.context`.
          toolsContext: Object.fromEntries(
            Object.keys(tools).map((name) => [
              name,
              {
                ...(runtimeCtx as Record<string, unknown>),
                principal,
                // `agent` is the ref the turn resolved (scope-pinned as stored
                // on the run), so a tool that acts on "the agent I'm running
                // as" names the same record the turn is using.
                run: { id: run.id, chatId: resolvedChatId, agent: run.agent },
                writer,
              },
            ]),
          ),
          // generate-text step callback: accumulate usage across steps,
          // including the cached-prompt breakdown so cost reflects cache reads.
          onStepEnd: (step: {
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
            fireObs(config.observability?.onStep, {
              principal,
              chatId: resolvedChatId,
              runId: run.id,
              agent: run.agent,
              modelId,
              depth,
              trigger,
              step: {
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
      // Guarded on the turn's abort signal: `appendMessages` has no lease
      // fence (only `updateRun` does), so once this worker has lost the lease
      // a reclaimed copy of the run may be replaying into this same chat —
      // an un-guarded checkpoint from the zombie would interleave with it,
      // and every later resume replays the polluted history.
      //
      // Best-effort, not a fence: the lease can be lost between this check and
      // the write committing. Closing that window needs a lease/fencing-token
      // check inside the storage write itself — an adapter interface change,
      // tracked as a follow-up. With the heartbeat now aborting within one TTL
      // of losing contact, the exposure is bounded to ~leaseTtlMs.
      onStepEnd: dur.enabled
        ? ({ responseMessage }: { responseMessage: AppMessage }) => {
            if (abort.signal.aborted) return;
            void storage
              .appendMessages(resolvedChatId, [responseMessage])
              .catch((e) =>
                console.warn(`[durability] step checkpoint failed for run ${run.id}:`, e),
              );
          }
        : undefined,
      onFinish: async ({
        messages,
        isAborted,
      }: {
        messages: AppMessage[];
        isAborted?: boolean;
      }) => {
        stopHeartbeat();
        await closeSources();
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
        // Aborted (lease lost): don't claim completion, and DON'T persist the
        // partial messages/usage — the run may already be reaped and re-claimed
        // by another node whose writes must win. The guarded update no-ops if
        // the run was reassigned.
        if (isAborted) {
          if (!ephemeral)
            await storage.updateRun(
              run.id,
              { status: "errored", error: "aborted", endedAt: Date.now() },
              lease,
            );
          fireObs(config.observability?.onFinish, {
            principal,
            chatId: resolvedChatId,
            runId: run.id,
            agent: run.agent,
            modelId,
            depth,
            trigger,
            status: "errored",
            usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
            cost,
            messages,
          });
          await reportRunFinished("errored", messages, "aborted");
          return;
        }
        // A gated tool ended the turn awaiting a decision — pause, don't
        // complete. The decision arrives via applyApproval (message state).
        const paused = hasPendingApproval(messages);
        // Ephemeral turns aren't fenced (no lease/run row) — they always finish
        // here. For persisted turns, `applied` reflects whether our lease still
        // owns the run (see below).
        let applied = true;
        if (!ephemeral) {
          // Fenced finish: settle the run FIRST. If the guarded update doesn't
          // apply (our lease was reaped + the run re-claimed elsewhere), we're
          // a stale writer — skip the final message/usage persistence so we
          // don't overwrite the new owner's state.
          applied = await storage.updateRun(
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
            await storage.appendMessages(resolvedChatId, messages);
            await storage.recordUsage(principal, {
              runId: run.id,
              model: modelId,
              inputTokens,
              outputTokens,
              ...(cacheReadTokens ? { cacheReadTokens } : {}),
              ...(cacheWriteTokens ? { cacheWriteTokens } : {}),
              cost,
            });
          }
        }
        fireObs(config.observability?.onFinish, {
          principal,
          chatId: resolvedChatId,
          runId: run.id,
          agent: run.agent,
          modelId,
          depth,
          trigger,
          status: paused ? "awaiting_input" : "completed",
          usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
          cost,
          messages,
        });
        if (args.onComplete) {
          try {
            await args.onComplete({ text: lastAssistantText(messages), messages });
          } catch (e) {
            console.error("[runtime] onComplete hook failed:", e);
          }
        }
        // Only the winning writer reports terminal telemetry. If our lease was
        // reaped and the run re-claimed elsewhere (`!applied`), that node will
        // finish it — a stale writer must not re-run the judge or emit a
        // duplicate "completed"/"awaiting_input" trace.
        if (applied)
          await reportRunFinished(paused ? "awaiting_input" : "completed", messages);
      },
      onError: (error: unknown) => {
        stopHeartbeat();
        void closeSources();
        const message = clientErrorMessage(error);
        fireObs(config.observability?.onError, {
          principal,
          chatId: resolvedChatId,
          runId: run.id,
          agent: run.agent,
          modelId,
          depth,
          trigger,
          error,
        });
        // The AI SDK's onError must return the client string synchronously, so
        // the terminal telemetry can't be awaited here. A serverless-safe impl
        // keeps its own flush alive (e.g. via waitUntil) so the errored trace
        // still lands; failures are swallowed inside reportRunFinished.
        void reportRunFinished("errored", [], message);
        return message;
      },
    } as Parameters<typeof createUIMessageStream>[0]);

    // Plain-text stream (ephemeral `responseFormat: "text"`): project the
    // UIMessage chunks down to their text deltas and emit `text/plain` — parity
    // with the AI SDK's `toTextStreamResponse`. Tool calls still run (their
    // side effects happen as the stream is pulled); only the framing differs.
    if (args.responseFormat === "text") {
      const text = (
        stream as ReadableStream<{
          type?: string;
          delta?: string;
          errorText?: string;
        }>
      )
        .pipeThrough(
          new TransformStream<
            { type?: string; delta?: string; errorText?: string },
            string
          >({
            transform(chunk, controller) {
              if (chunk.type === "text-delta" && chunk.delta)
                controller.enqueue(chunk.delta);
              // Don't let a failed turn look like an empty-but-successful one:
              // fail the stream so the client sees an error, not silence.
              else if (chunk.type === "error")
                controller.error(
                  new Error(chunk.errorText || "The run failed."),
                );
            },
          }),
        )
        .pipeThrough(new TextEncoderStream());
      return new Response(text, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

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
    return createUIMessageStreamResponse({
      stream: out as Parameters<typeof createUIMessageStreamResponse>[0]["stream"],
      consumeSseStream: consumeStream,
    });
  }

  async function reapTick(opts?: { now?: number; error?: string }) {
    const reaped = await storage.reapExpiredRuns(opts?.now ?? Date.now(), {
      error: opts?.error,
    });
    return { reaped };
  }

  /** Open a run for a turn: durable → leased claim; T1 → an unleased run. */
  async function openRun(
    principal: P,
    chatId: string,
    agentName: string,
  ): Promise<{ run: RunRecord; lease: RunLease | undefined }> {
    if (dur.enabled) {
      const run = await storage.claimRun({
        principal,
        chatId,
        agent: agentName,
        owner: dur.instanceId,
        ttlMs: dur.leaseTtlMs,
      });
      return { run, lease: { owner: dur.instanceId, fencingToken: run.fencingToken ?? 1 } };
    }
    return {
      run: await storage.createRun(principal, { chatId, agent: agentName, kind: "turn" }),
      lease: undefined,
    };
  }

  async function handleChat({
    agent: agentName,
    chatId,
    principal,
    message,
    request,
    turnContext,
  }: HandleChatInput<P>): Promise<Response> {
    // chat: scoped create-or-continue (others' ids resolve to "not found")
    let chat = chatId ? await storage.getChat(principal, chatId) : null;
    if (!chat) {
      chat = await storage.createChat(principal, {
        id: chatId, // use the provided id (create-or-continue); generated if omitted
        agent: agentName,
        // Title from the first user message — for the chat list.
        title: firstText(message)?.slice(0, 80),
      });
    }
    const resolvedChatId = chat.id;

    const { cfg, modelId, runtimeCtx } = await resolveAgentConfig(
      agentName,
      principal,
      request,
      turnContext,
    );

    const prior = await storage.loadMessages(principal, resolvedChatId);

    // A new message while the last turn is parked on an approval is itself the
    // decision: the user declined to answer and wants to steer elsewhere. Close
    // the gate as declined (persisted, so the card stops rendering as live) and
    // carry on — the gated tool never runs, and the model sees the denial
    // followed by the new instruction. Refusing the message instead is what
    // wedged chats whose gate could not be satisfied at all.
    if (hasPendingApproval(prior)) {
      const declined = declinePendingApprovals(prior);
      if (declined.length > 0) await storage.appendMessages(resolvedChatId, declined);
    }

    // persist the user message up front (crash-safe), then open the run
    await storage.appendMessages(resolvedChatId, [message]);
    const { run, lease } = await openRun(principal, resolvedChatId, agentName);

    return buildTurn({
      resolvedChatId,
      principal,
      modelId,
      cfg,
      run,
      lease,
      uiMessages: [...prior, message],
      runtimeCtx,
    });
  }

  /**
   * Run one agent turn from the supplied messages and stream it back, persisting
   * NOTHING — no chat, run, message, or usage rows. The full tool loop,
   * streaming, and observability hooks all run; only durability/history are
   * skipped. For read-mostly, single-shot loops (inline editor assist, one-off
   * generations) where a durable chat would be pure churn. There's no chatId to
   * resume and approvals can't round-trip (no persisted state) — use `handleChat`
   * for anything that needs HITL or history.
   */
  async function runTurnStream({
    agent: agentName,
    principal,
    messages,
    request,
    turnContext,
    format,
    onComplete,
  }: {
    agent: string;
    principal: P;
    messages: AppMessage[];
    request?: Request;
    turnContext?: unknown;
    format?: "ui" | "text";
    onComplete?: (result: {
      text: string;
      messages: AppMessage[];
    }) => void | Promise<void>;
  }): Promise<Response> {
    const { cfg, modelId, runtimeCtx } = await resolveAgentConfig(
      agentName,
      principal,
      request,
      turnContext,
    );
    // Synthetic, unpersisted run — buildTurn only reads `id`/`agent` from it,
    // and every storage write is guarded by `ephemeral`.
    const run = {
      id: generateRunId(),
      chatId: "ephemeral",
      agent: agentName,
      status: "active",
      startedAt: Date.now(),
    } as unknown as RunRecord;
    return buildTurn({
      resolvedChatId: run.chatId,
      principal,
      modelId,
      cfg,
      run,
      lease: undefined,
      uiMessages: messages,
      runtimeCtx,
      ephemeral: true,
      responseFormat: format ?? "ui",
      onComplete,
    });
  }

  async function resumeRun(runId: string): Promise<RunOutcome | null> {
    if (!dur.enabled) throw new Error("resume requires durability.enabled");

    // Exactly-once re-claim: only one node wins; a concurrent resumer / an
    // already-completed run yields null.
    const run = await storage.reclaimRun(runId, dur.instanceId, dur.leaseTtlMs);
    if (!run) return null;

    // System op (no request): rebuild the principal from the run's identity blob.
    const principal = await reconstructPrincipal(run.identity);

    const { cfg, modelId, runtimeCtx } = await resolveAgentConfig(run.agent, principal);
    const uiMessages = await storage.loadMessages(principal, run.chatId);
    const lease: RunLease = {
      owner: dur.instanceId,
      fencingToken: run.fencingToken ?? 1,
    };

    // Re-run from persisted history and drive to completion server-side
    // (there's no client to consume the stream).
    const res = await buildTurn({
      resolvedChatId: run.chatId,
      principal,
      modelId,
      cfg,
      run,
      lease,
      uiMessages,
      runtimeCtx,
      // Crash recovery, driven server-side: nobody is watching this stream.
      trigger: "resume",
    });
    await res.text();

    const final = await storage.getRun(runId);
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
  }): Promise<{ reaped: RunRecord[]; resumed: RunOutcome[] }> {
    if (!dur.enabled) throw new Error("sweep requires durability.enabled");
    const maxAttempts = opts?.maxAttempts ?? 5;
    const { reaped } = await reapTick({ now: opts?.now, error: opts?.error });
    const resumed: RunOutcome[] = [];
    for (const run of reaped) {
      // Give up on poison runs that keep dying — don't loop forever.
      if ((run.attempt ?? 1) >= maxAttempts) continue;
      const outcome = await resumeRun(run.id);
      if (outcome) resumed.push(outcome);
    }
    return { reaped, resumed };
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
    const messages = await storage.loadMessages(principal, chatId);
    const changed = applyDecisions(messages, decisions);
    if (changed.length > 0) await storage.appendMessages(chatId, changed);

    // Route any just-decided SUBAGENT approvals (bubbled up via spawn_agent):
    // resume the sub thread with the decision, then fold its answer back into
    // the parent's spawn_agent result so this turn continues with the digest.
    const subApprovals = collectDecidedSubagentApprovals(messages);
    if (subApprovals.length > 0) {
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
        );
        if (resumed.pending?.length) {
          // The resumed sub paused on ANOTHER gated tool — re-bubble it as a
          // fresh data-subagent-approval part on the same parent message. The
          // undecided part keeps this chat awaiting_input (hasPendingApproval
          // below), and the next decision routes through here again, so
          // bubbling recurses per round.
          const nextApprovalId = generateSubApprovalId();
          appendSubagentApprovalPart(messages, sa.approvalId, {
            approvalId: nextApprovalId,
            subChatId: sa.subChatId,
            subApprovalIds: resumed.pending.map((p) => p.approvalId),
            spawnToolCallId: sa.spawnToolCallId,
            summaries: resumed.pending.map((p) => p.summary),
            // Carry the linkage forward so each further resume stays nested.
            parentRunId: sa.parentRunId,
            rootChatId: sa.rootChatId,
          });
          if (sa.spawnToolCallId) {
            overwriteToolResult(messages, sa.spawnToolCallId, {
              status: "awaiting_approval",
              threadId: sa.subChatId,
              pending: resumed.pending.map((p) => p.summary),
              note: "Awaiting the user's approval — do not retry; stop here, the user will decide and you'll continue automatically.",
            });
          }
        } else if (sa.spawnToolCallId) {
          overwriteToolResult(messages, sa.spawnToolCallId, {
            threadId: sa.subChatId,
            answer: resumed.answer,
          });
        }
        markSubagentApprovalResolved(messages, sa.approvalId);
      }
      // Persist the folded spawn_agent result (or re-bubbled approval part)
      // + resolved markers.
      await storage.appendMessages(chatId, messages);
    }

    // If the step had several gated calls and some are still undecided, DON'T
    // re-run yet — a tool call without a result makes convertToModelMessages
    // throw MissingToolResultsError. Persist the decision, stay awaiting_input,
    // and let the client submit the rest. Only continue once none are pending.
    if (hasPendingApproval(messages)) {
      return new Response(null, { status: 200 });
    }

    const { cfg, modelId, runtimeCtx } = await resolveAgentConfig(
      chat.agent,
      principal,
      request,
      turnContext,
    );
    const { run, lease } = await openRun(principal, chatId, chat.agent);

    return buildTurn({
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
      // A human just decided something, so a human is present — even if this
      // turn parks again on the NEXT gate (see TurnTrigger).
      trigger: "decision",
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

    const messages = await storage.loadMessages(principal, chatId);
    const changed = recordToolResult(messages, toolCallId, output);
    // Unknown or already-answered call: nothing to resume. Makes a duplicate
    // submit (double-tapped button, redelivered webhook) a no-op instead of a
    // spurious extra turn.
    if (changed.length === 0) return new Response(null, { status: 200 });
    await storage.appendMessages(chatId, changed);

    // Another client tool call in the SAME step may still be awaiting a result;
    // re-running now would throw MissingToolResultsError. Wait for the rest.
    // Scope this to the messages we just touched: a call abandoned turns ago is
    // still `input-available` in stored history, and counting it would park
    // every future resume in this chat forever.
    if (hasPendingToolResult(changed)) {
      return new Response(null, { status: 200 });
    }

    const { cfg, modelId, runtimeCtx } = await resolveAgentConfig(
      chat.agent,
      principal,
      request,
      turnContext,
    );
    const { run, lease } = await openRun(principal, chatId, chat.agent);

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
      // A client-handled tool result is a human answering (see TurnTrigger).
      trigger: "decision",
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

    const { cfg, modelId } = await resolveAgentConfig(chat.agent, principal, request, turnContext);
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
    const run = await storage.createRun(principal, {
      chatId,
      agent: chat.agent,
      // Not a conversational turn — stats/rollups filter on kind so a
      // compaction's cache-less usage never depresses an agent's hit rate.
      kind: "compaction",
    });
    try {
      const { text, truncated, usage } = await summarizeForCompaction({
        model: cfg.model as LanguageModel,
        messages: await toModelMessages(live, { tools }),
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
      await storage.appendMessages(chatId, [
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
      await storage.updateRun(run.id, {
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
    return toClientMessages(messages);
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
    const run = await storage.getRun(runId);
    if (!run) return null;
    // Ownership: the run is the caller's only if its chat is (getChat is
    // principal-scoped). Guards cross-tenant reads/writes keyed by runId.
    const chat = await storage.getChat(principal, run.chatId);
    return chat ? run : null;
  }

  /** A fresh user message from plain text (for cron-fired turns). */
  function userMessageOf(text: string): AppMessage {
    return {
      id: generateMessageId(),
      role: "user",
      parts: [{ type: "text", text }],
      metadata: { visibility: "user", createdAt: Date.now() },
    } as AppMessage;
  }

  /**
   * Run one turn to completion server-side (no client consuming the stream).
   * Reports whether the turn ended PARKED — waiting on a human (an undecided
   * approval or client tool result) rather than finished. An unattended caller
   * (`runDue`) needs that: the stream ending is not the same as an answer, and
   * a parked scheduled turn has spent its tokens and produced nothing.
   */
  async function runTurnToCompletion(
    principal: P,
    agentName: string,
    message: AppMessage,
    chatId: string,
  ): Promise<{ parked: boolean }> {
    const { cfg, modelId, runtimeCtx } = await resolveAgentConfig(agentName, principal);
    await storage.appendMessages(chatId, [message]);
    const { run, lease } = await openRun(principal, chatId, agentName);
    const res = await buildTurn({
      resolvedChatId: chatId,
      principal,
      modelId,
      cfg,
      run,
      lease,
      uiMessages: [message],
      runtimeCtx,
      // A cron/one-shot fire — no human at the other end (see TurnTrigger).
      trigger: "schedule",
    });
    await res.text();
    // The fold over the persisted log — the same truth every interactive path
    // trusts — not the run row, which a parked turn also leaves behind.
    const after = await storage.loadMessages(principal, chatId);
    const last = after[after.length - 1];
    return {
      parked: hasPendingApproval(after) || (!!last && hasPendingToolResult([last])),
    };
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
   * Run another agent as an autonomous subagent in its own persisted thread and
   * return its final answer. `threadId` omitted → a fresh `sub_…` thread;
   * supplied → continue that thread with full prior context. Approvals are
   * waived (autonomous). Returns `{ threadId, answer }`.
   */
  async function runSubagent({
    principal,
    agent,
    prompt,
    threadId,
    depth,
    blockGated,
    autoApprove = true,
    onProgress,
    parentRunId,
    rootChatId,
    turnContext,
    promptCaching,
    trigger,
  }: {
    principal: P;
    agent: string;
    prompt: string;
    threadId?: string;
    depth: number;
    blockGated?: boolean;
    /** Per-turn prompt-caching override (see buildTurn). */
    promptCaching?: boolean;
    /**
     * Per-turn request payload for THIS run, passed to `context.build` and the
     * agent factory (see `HandleChatInput.turnContext`). Ephemeral — applies to
     * this initial turn only, never to resumes. Lets programmatic callers (e.g.
     * background jobs) hand a factory-form agent its work payload.
     */
    turnContext?: unknown;
    /** Telemetry: the run that spawned this subagent (nests its trace). */
    parentRunId?: string;
    /** Telemetry: the top-level conversation id (shared session across the tree). */
    rootChatId?: string;
    /** What set the delegation tree off (see `TurnTrigger`); inherited as-is. */
    trigger?: TurnTrigger;
    /**
     * Waive HITL approvals inside the subagent. Default true (autonomous runs —
     * cron / `runAgent` — have no human). `spawn_agent` passes the PARENT turn's
     * value, so a subagent spawned from an interactive chat GATES its tools and
     * a pending approval bubbles up to the parent (see the pending return).
     */
    autoApprove?: boolean;
    /** Progressive snapshots of the sub-turn's exchange (prompt + streaming assistant). */
    onProgress?: (messages: AppMessage[]) => void;
  }): Promise<{ threadId: string; answer: string; pending?: SubagentPending[] }> {
    // `||` (not `??`): an empty-string threadId must mint a fresh id, or the
    // subagent chat is created with id "" and the UI can never open it.
    const subChatId = threadId?.trim() || generateSubchatId();
    let chat = await storage.getChat(principal, subChatId);
    if (!chat) {
      chat = await storage.createChat(principal, {
        id: subChatId,
        agent,
        title: prompt.slice(0, 80),
        // Runtime-created sub-thread: stamp it internal so a host filtering
        // its chat list on kind never shows it (see ChatRecord.kind).
        kind: "internal",
      });
    }
    const prior = await storage.loadMessages(principal, subChatId);
    const message = userMessageOf(prompt);
    await storage.appendMessages(subChatId, [message]);

    const { cfg, modelId, runtimeCtx } = await resolveAgentConfig(
      agent,
      principal,
      undefined,
      turnContext,
    );
    const { run, lease } = await openRun(principal, subChatId, agent);
    const res = await buildTurn({
      resolvedChatId: subChatId,
      principal,
      modelId,
      cfg,
      run,
      lease,
      uiMessages: [...prior, message],
      runtimeCtx,
      autoApprove,
      blockGated,
      promptCaching,
      depth,
      parentRunId,
      rootChatId,
      trigger,
      // Forward progressive UI-message snapshots to the caller (spawn_agent
      // streams them into the parent turn). Observation must never break the
      // run — the primary stream is drained independently below.
      observeStream: onProgress
        ? (observed) => {
            void (async () => {
              try {
                const byId = new Map<string, AppMessage>();
                for await (const m of readUIMessageStream({
                  stream: observed as Parameters<typeof readUIMessageStream>[0]["stream"],
                })) {
                  const msg = m as unknown as AppMessage;
                  byId.set(msg.id, msg);
                  onProgress([message, ...byId.values()]);
                }
              } catch {
                // ignore — live progress is best-effort
              }
            })();
          }
        : undefined,
    });
    await res.text();

    const subMessages = await storage.loadMessages(principal, subChatId);
    // Interactive subagent paused on a gated tool → lift its pending approval(s)
    // so the caller (`spawn_agent`) can surface them on the parent turn.
    const pending = collectPendingApprovals(subMessages);
    if (pending.length > 0) {
      return { threadId: subChatId, answer: "", pending };
    }
    return { threadId: subChatId, answer: lastAssistantText(subMessages) };
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
  ): Promise<{ answer: string; pending?: SubagentPending[] }> {
    const subChat = await storage.getChat(principal, subChatId);
    if (!subChat) return { answer: "" };
    const subMessages = await storage.loadMessages(principal, subChatId);
    const changed = applyDecisions(subMessages, decisions);
    if (changed.length > 0) await storage.appendMessages(subChatId, changed);
    // Another gated call in the same sub step still undecided → can't finish.
    if (hasPendingApproval(subMessages)) return { answer: "" };

    const { cfg, modelId, runtimeCtx } = await resolveAgentConfig(
      subChat.agent,
      principal,
    );
    const { run, lease } = await openRun(principal, subChatId, subChat.agent);
    const res = await buildTurn({
      resolvedChatId: subChatId,
      principal,
      modelId,
      cfg,
      run,
      lease,
      uiMessages: subMessages,
      runtimeCtx,
      autoApprove: false, // keep gating any further writes in the sub
      depth: 1,
      // Keep the resumed turn nested under the original trace/session.
      parentRunId: linkage?.parentRunId,
      rootChatId: linkage?.rootChatId,
      // Reached only by a human deciding the bubbled-up approval.
      trigger: "decision",
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
  }: {
    principal: P;
    agent: string;
    cron: string | null;
    timezone?: string;
    prompt: string;
    delivery?: unknown;
    onParked?: "skip" | "fire";
  }): Promise<ScheduleRecord> {
    // Accept code-declared or dynamic (UI-created) agents.
    const known =
      !!config.agents[agent] || !!(await config.dynamicAgents?.resolve(agent, principal));
    if (!known) throw new Error(`Unknown agent: ${agent}`);
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
    });
  }

  async function runDue(opts?: {
    now?: number;
  }): Promise<{ fired: number; errors: number; skipped: number; parked: number }> {
    const now = opts?.now ?? Date.now();
    const claimed = await storage.claimDueSchedules(now, dur.leaseTtlMs, dur.instanceId);
    let fired = 0;
    let errors = 0;
    let skipped = 0;
    let parked = 0;
    for (const s of claimed) {
      const next = s.cron ? (config.cron?.(s.cron, now, s.timezone) ?? null) : null;
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
        await storage.completeSchedule(
          s.id,
          { nextRunAt: next ?? now, lastRunAt: now, enabled: next != null },
          dur.instanceId,
        );
      } catch (e) {
        // Cannot consume the occurrence → do NOT fire. Firing anyway would
        // leave the row due, and every subsequent tick would fire it again —
        // the swallowed version of this write was itself a repeat-fire bug.
        console.error(`[schedule] failed to advance ${s.id}; skipping this fire:`, e);
        errors++;
        continue;
      }
      try {
        const principal = await reconstructPrincipal(s.identity);
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
        // and stream the answer there). A hook that throws is treated as "not
        // handled": the fire still happens the default way, so a broken
        // delivery target degrades to a normal chat run instead of losing the
        // occurrence entirely. Hosts: only throw BEFORE doing paid work — a
        // hook that already ran the agent and then throws (say, on delivery)
        // makes the fallback a second full turn for the same occurrence.
        let handled = false;
        if (config.runSchedule) {
          try {
            const outcome = await config.runSchedule({ schedule: s, principal });
            handled = typeof outcome === "boolean" ? outcome : outcome.handled;
            // The host owns the chat a channel fire ran in, so it is the only
            // one that can report it. Same accounting as the default path when
            // it does: stamp the chat for the next `onParked` check, and count
            // a park that nobody can answer.
            if (handled && typeof outcome === "object") {
              if (outcome.chatId) {
                await storage.noteScheduleFire?.(s.id, {
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
          } catch (e) {
            console.error(`[schedule] runSchedule hook failed for ${s.id}:`, e);
          }
        }
        if (!handled) {
          const chat = await storage.createChat(principal, {
            agent: s.agent,
            title: s.prompt.slice(0, 80),
          });
          // Remember where this fire ran so the NEXT occurrence can see a
          // parked predecessor. Stamped before the turn (a parked turn still
          // "completes" the await); optional — see StorageAdapter. `firedAt`
          // is the lastRunAt this fire's completeSchedule wrote above, so a
          // delayed stamp can't clobber a newer occurrence's.
          await storage.noteScheduleFire?.(s.id, { lastChatId: chat.id, firedAt: now });
          const outcome = await runTurnToCompletion(
            principal,
            s.agent,
            userMessageOf(s.prompt),
            chat.id,
          );
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
    return { fired, errors, skipped, parked };
  }

  return {
    listAgents: agentInfos,
    tick: reapTick,
    handleChat,
    runTurnStream,
    runAgent: ({
      principal,
      agent,
      prompt,
      threadId,
      blockGated = true,
      turnContext,
      promptCaching,
      // No client stream: assume unattended unless the host says otherwise, so
      // a park here can't be silently filtered out as "someone's watching".
      trigger = "programmatic",
    }) =>
      runSubagent({
        principal,
        agent,
        prompt,
        threadId,
        depth: 1,
        blockGated,
        turnContext,
        promptCaching,
        trigger,
      }),
    compactChat,
    loadHistory,
    listChats,
    getChat: getChatById,
    listRuns,
    getRun,
    resume: resumeRun,
    sweep,
    applyApproval,
    applyToolResult,
    schedule,
    listSchedules: ({ principal }) => storage.listSchedules(principal),
    unschedule: ({ principal, id }) => storage.deleteSchedule(principal, id),
    runScheduleNow: ({ principal, id }) => storage.bumpSchedule(principal, id),
    runDue,
  };
}
