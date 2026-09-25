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
import type { AppMessage } from "./message.js";
import type { ReconstructPrincipal } from "./principal.js";
import type { ContextDefinition } from "./context.js";
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
import type {
  ChatRecord,
  RunLease,
  RunRecord,
  RunStatus,
  ScheduleRecord,
  StorageAdapter,
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
/**
 * T2 durability (opt-in). When enabled, each turn claims a single-writer lease,
 * heartbeats it while streaming, and aborts if the lease is lost. A reaper
 * (`runtime.cron()` → `sweep`, driven by cron) reclaims runs whose owner died.
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
   * re-hydrate (e.g. re-fetch fresh identity) or validate on resume — return
   * `null` to refuse an identity that is no longer valid (see
   * `ReconstructPrincipal`). Runs before a cron occurrence is consumed, so keep
   * it well under `durability.leaseTtlMs`.
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
   * (web_fetch, askUser, scheduling, …) run in the app process. Merged into an
   * agent's toolset per its `sandbox`/`defaultTools` flags.
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
   * The observation seam (kept out of core — no OTEL/vendor dep): per-run AI
   * SDK telemetry options, an optional trace wrapper around the model call, a
   * per-step hook and a post-turn hook. A full tracer
   * (`@intentface/latch-langfuse`) or just the callbacks a host wants (usage
   * rollups, per-tool analytics, "a scheduled fire parked — notify someone").
   * Fires for subagent turns too — distinguish via `depth` and `trigger`.
   * Optional — without it, nothing is observed and behavior is unchanged.
   */
  telemetry?: LatchTelemetry<P>;
  /**
   * Per org / user / agent budgets on turns, tokens and cost (see `limits.ts`).
   * The host names the counters a turn counts against and their caps; the
   * runtime refuses at admission (`LimitExceededError`, HTTP 429), stops the
   * tool loop at the tightest remaining token budget, and settles usage on
   * finish. Optional — without it, nothing is limited.
   */
  limits?: LatchLimits<P>;
  /**
   * Extensions attached to EVERY turn this runtime runs, before the agent's
   * own (`AgentConfig.extensions`). An extension attaches handlers to the
   * moments of a turn and returns effects — see `extensions/extension.ts`.
   * Optional — with none attached every moment is a no-op and a turn is
   * byte-identical to a runtime without the seam. Order matters for
   * `step_end`: list an extension that persists before ones that observe.
   */
  extensions?: Extension[];
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

/** What one `runDue` pass did — see `Runtime.runDue` for each counter. */
export interface RunDueResult {
  fired: number;
  errors: number;
  skipped: number;
  parked: number;
  rejected: number;
}

export interface Runtime<P> {
  /** The agents available to the caller (code-declared + dynamic) — for a picker. */
  listAgents(principal: P): Promise<AgentInfo[]>;
  /** Run one turn; returns a streaming UIMessage `Response`. */
  handleChat(input: HandleChatInput<P>): Promise<Response>;
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
     * How to classify this run on the telemetry run meta (see `TurnTrigger`).
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
   * Resume an interrupted run (requires durability). Re-claims it exactly-once,
   * re-runs the turn from persisted history, and completes it server-side.
   * Returns the run's final state, or null if it wasn't resumable (already
   * completed, or claimed by another node).
   */
  resume(runId: string): Promise<RunOutcome | null>;
  /**
   * Reaper + auto-resume in one call — the durability half of `cron()`. Reaps
   * lease-expired runs, then resumes each whose attempt count is still under
   * `maxAttempts` (default 5; the cap stops poison runs from looping forever).
   * Safe to fire on every node: reap and reclaim are atomic, so each run is
   * handled exactly once. Requires durability.
   */
  sweep(opts?: {
    now?: number;
    maxAttempts?: number;
    error?: string;
  }): Promise<{ reaped: RunRecord[]; resumed: RunOutcome[] }>;
  /**
   * THE cron entry point — point a platform cron or the in-process scheduler at
   * this and nothing else. Fires due schedules (`runDue`), then, when
   * durability is on, reaps lease-expired runs and resumes them (`sweep`). One
   * call per tick, so a deploy can't wire half of the operational surface. The
   * two phases are isolated: a failure in one lands in `errors` and the other
   * still runs. Safe to fire on every node concurrently (claims are atomic).
   */
  cron(opts?: { now?: number; maxAttempts?: number }): Promise<{
    due: RunDueResult;
    reaped: RunRecord[];
    resumed: RunOutcome[];
    /** Phase failures (`"runDue: …"` / `"sweep: …"`) — reported, never thrown. */
    errors: string[];
  }>;
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
   *
   * `rejected` counts occurrences whose principal `reconstructPrincipal`
   * refused (returned `null`): not run, and the schedule is DISABLED rather
   * than left to refuse on every tick. Not counted in `errors` — nothing broke;
   * the identity is simply no longer allowed to act.
   */
  runDue(opts?: { now?: number }): Promise<RunDueResult>;
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
export function resumeShapeOf(messages: AppMessage[]): ResumeShape {
  // Compaction markers are not turns, so the tail is read past them: a summary
  // appended after a reaped run's finished message must not make that message
  // look like it was followed by a user turn (which would say "continue" and
  // regenerate against the summary). `compactChat` refuses while a gate or
  // client tool is pending, so a marker can never sit after an undecided one.
  let end = messages.length;
  while (end > 0 && isCompactionMarker(messages[end - 1])) end--;
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
      ? await factory({ context: runtimeCtx, principal, turnContext })
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
  }): Promise<Response> {
    const { resolvedChatId, principal, modelId, cfg, run, lease, runtimeCtx } = args;
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
    const baseStopWhen = budgetStop ? [stepCap ?? stepCountIs(20), budgetStop] : stepCap;

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
    const checkpoint = (message: AppMessage) => {
      if (!dur.enabled || abort.signal.aborted) return;
      checkpoints = checkpoints
        .then(() => {
          // Re-checked at write time: the lease may have gone while this
          // checkpoint waited behind the previous one.
          if (abort.signal.aborted) return;
          return storage.appendMessages(resolvedChatId, [message]);
        })
        .catch((e) => console.warn(`[durability] step checkpoint failed for run ${run.id}:`, e));
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
        const projected = await toModelMessages(uiMessages, { tools });
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
              },
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
          const settled = await storage.updateRun(
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
        const applied = await storage.updateRun(
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
   * Open a turn: the run (one active per chat — `ChatBusyError` if not ours to
   * run) and the user message that starts it. Atomic when the adapter offers
   * `openTurn`; otherwise the run first, then the message, so a refusal still
   * persists nothing (the crash window between the two writes is the trade-off
   * an adapter without `openTurn` accepts).
   */
  async function openTurn(
    principal: P,
    chatId: string,
    agentName: string,
    messages: AppMessage[],
    agentVersion?: number,
  ): Promise<{ run: RunRecord; lease: RunLease | undefined }> {
    if (storage.openTurn) {
      const run = await storage.openTurn(principal, {
        chatId,
        agent: agentName,
        messages,
        agentVersion: agentVersion ?? null,
        ...(dur.enabled ? { lease: { owner: dur.instanceId, ttlMs: dur.leaseTtlMs } } : {}),
      });
      return {
        run,
        lease: dur.enabled ? { owner: dur.instanceId, fencingToken: run.fencingToken ?? 1 } : undefined,
      };
    }
    const opened = await openRun(principal, chatId, agentName, agentVersion);
    if (messages.length > 0) await storage.appendMessages(chatId, messages);
    return opened;
  }

  async function openRun(
    principal: P,
    chatId: string,
    agentName: string,
    agentVersion?: number,
  ): Promise<{ run: RunRecord; lease: RunLease | undefined }> {
    if (dur.enabled) {
      const run = await storage.claimRun({
        principal,
        chatId,
        agent: agentName,
        owner: dur.instanceId,
        ttlMs: dur.leaseTtlMs,
        agentVersion: agentVersion ?? null,
      });
      return { run, lease: { owner: dur.instanceId, fencingToken: run.fencingToken ?? 1 } };
    }
    return {
      run: await storage.createRun(principal, {
        chatId,
        agent: agentName,
        kind: "turn",
        agentVersion: agentVersion ?? null,
      }),
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

    // Limits gate BEFORE anything is persisted: a refused turn leaves no
    // trace (the client gets 429 and can retry when the window turns over).
    const admitted = await admitTurn(principal, agentName, "chat");
    // Run + message open together (atomically where the adapter can): a chat
    // with a live turn refuses (`ChatBusyError` → 409) and the message never
    // lands in history — the client retries it (with its turn reservation released).
    const { run, lease } = await withReservation(admitted, () =>
      openTurn(principal, resolvedChatId, agentName, [message], cfg.configVersion),
    );

    return buildTurn({
      resolvedChatId,
      principal,
      modelId,
      cfg,
      run,
      lease,
      uiMessages: [...prior, message],
      runtimeCtx,
      admitted,
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
    const lease: RunLease = {
      owner: dur.instanceId,
      fencingToken: run.fencingToken ?? 1,
    };
    if (principal === null) {
      // Refused (see `ReconstructPrincipal`): the identity may no longer act, so
      // nothing below — not even reading its history — runs as it. End the run
      // instead of returning early with the lease held: an `active` row would be
      // reaped and re-refused every tick until `maxAttempts`, and a throw here
      // would abort the rest of `sweep`'s loop. No `onRunFinished`: its meta
      // carries the principal, and there is none to report.
      const error = "principal rejected: reconstructPrincipal refused the run's identity";
      await storage.updateRun(
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
      const settled = await storage.getRun(runId);
      return {
        runId,
        status: settled?.status ?? "errored",
        attempt: settled?.attempt ?? run.attempt ?? null,
      };
    }

    const uiMessages = await storage.loadMessages(principal, run.chatId);

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
      const applied = await storage.updateRun(
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
      const settled = await storage.getRun(runId);
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
    const { cfg, modelId, runtimeCtx } = await resolveAgentConfig(run.agent, principal);

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
      admitted,
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
      // One run's failure must not strand the rest of the batch. The reaper
      // flipped EVERY run here to `errored` in one write, and no later reap
      // selects an `errored` row — so an escaping throw (a transient
      // `reconstructPrincipal` failure, a storage blip) would leave each run
      // after it unrecovered for good. The run that threw was already
      // reclaimed to `active` under a lease, so it is reaped and retried once
      // that lease lapses, spending an attempt like any other failed resume.
      try {
        const outcome = await resumeRun(run.id);
        if (outcome) resumed.push(outcome);
      } catch (e) {
        console.error(`[resume] run ${run.id} (${run.agent}) failed; continuing the sweep:`, e);
      }
    }
    return { reaped, resumed };
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
        ({ reaped, resumed } = await sweep({ now: opts?.now, maxAttempts: opts?.maxAttempts }));
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
    const admitted = await admitContinuation(principal, chat.agent, "decision");
    const { run, lease } = await openRun(principal, chatId, chat.agent, cfg.configVersion);

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
      admitted,
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

    // Another client tool call in the SAME step may still be awaiting a result;
    // re-running now would throw MissingToolResultsError. Record this one and
    // wait for the rest. Scope this to the messages we just touched: a call
    // abandoned turns ago is still `input-available` in stored history, and
    // counting it would park every future resume in this chat forever.
    if (hasPendingToolResult(changed)) {
      await storage.appendMessages(chatId, changed);
      return new Response(null, { status: 200 });
    }

    const { cfg, modelId, runtimeCtx } = await resolveAgentConfig(
      chat.agent,
      principal,
      request,
      turnContext,
    );
    const admitted = await admitContinuation(principal, chat.agent, "decision");
    // The result is persisted WITH the run (atomically where the adapter can):
    // a busy chat refuses before anything is recorded, so the retry finds the
    // call still unanswered and resumes it — persisting first would make the
    // retry a "duplicate submit" no-op and lose the answer.
    const { run, lease } = await openTurn(principal, chatId, chat.agent, changed, cfg.configVersion);

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
    autoApprove: boolean;
    blockGated?: boolean;
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
     * Per-turn request payload for THIS run, passed to `context.build` and the
     * agent factory (see `HandleChatInput.turnContext`). Ephemeral — applies to
     * this initial turn only, never to resumes.
     */
    turnContext?: unknown;
    /** Progressive snapshots of the turn's exchange (prompt + streaming assistant). */
    onProgress?: (messages: AppMessage[]) => void;
  }): Promise<{ chatId: string; answer: string; parked: boolean; pending?: SubagentPending[] }> {
    // `||` (not `??`): an empty-string id must mint a fresh one, or the chat is
    // created with id "" and the UI can never open it.
    const chatId = o.chatId?.trim() || generateSubchatId();
    let chat = await storage.getChat(o.principal, chatId);
    if (!chat) {
      chat = await storage.createChat(o.principal, {
        id: chatId,
        agent: o.agent,
        title: firstText(o.message)?.slice(0, 80),
        // Runtime-created thread: stamp it internal so a host filtering its
        // chat list on kind never shows it (see ChatRecord.kind).
        kind: "internal",
      });
    }
    const prior = await storage.loadMessages(o.principal, chatId);
    // Same rule as handleChat: a new message while the thread is parked on an
    // approval IS the decision — close the stale gate as declined (persisted)
    // and carry on. Otherwise a continued thread (`runAgent({ threadId })`,
    // `spawn_agent({ threadId })`) would run with an undecided gate in history
    // and this turn's verdict below would re-report that stale approval.
    if (hasPendingApproval(prior)) {
      const declined = declinePendingApprovals(prior);
      if (declined.length > 0) await storage.appendMessages(chatId, declined);
    }
    // Gate before the message persists — a refused schedule/subagent turn
    // leaves nothing behind, same as handleChat. Same for a busy chat: open
    // the run first, persist the message only once it is ours to run.
    const admitted = await admitTurn(o.principal, o.agent, o.trigger);
    const { cfg, modelId, runtimeCtx, run, lease } = await withReservation(admitted, async () => {
      const resolved = await resolveAgentConfig(o.agent, o.principal, undefined, o.turnContext);
      const opened = await openTurn(o.principal, chatId, o.agent, [o.message], resolved.cfg.configVersion);
      return { ...resolved, ...opened };
    });
    const onProgress = o.onProgress;
    const res = await buildTurn({
      resolvedChatId: chatId,
      principal: o.principal,
      modelId,
      cfg,
      run,
      lease,
      uiMessages: [...prior, o.message],
      runtimeCtx,
      admitted,
      autoApprove: o.autoApprove,
      blockGated: o.blockGated,
      promptCaching: o.promptCaching,
      depth: o.depth ?? 0,
      parentRunId: o.parentRunId,
      rootChatId: o.rootChatId,
      trigger: o.trigger,
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
                  onProgress([o.message, ...byId.values()]);
                }
              } catch {
                // ignore — live progress is best-effort
              }
            })();
          }
        : undefined,
    });
    await res.text();

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
    const admitted = await admitContinuation(principal, subChat.agent, "decision");
    const { run, lease } = await openRun(principal, subChatId, subChat.agent, cfg.configVersion);
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
      uiMessages: trimTrailingAssistantPrefill(subMessages),
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
        const applied = await storage.completeSchedule(
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
        console.error(`[schedule] failed to advance ${s.id}; skipping this fire:`, e);
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
      threadId,
      blockGated = true,
      turnContext,
      promptCaching,
      // No client stream: assume unattended unless the host says otherwise, so
      // a park here can't be silently filtered out as "someone's watching".
      trigger = "programmatic",
    }) => {
      const r = await runToCompletion({
        principal,
        agent,
        message: userMessageOf(prompt),
        chatId: threadId,
        depth: 1,
        // Autonomous: no human to authorize (blockGated stubs the gated tools).
        autoApprove: true,
        blockGated,
        turnContext,
        promptCaching,
        trigger,
      });
      return { threadId: r.chatId, answer: r.answer };
    },
    compactChat,
    loadHistory,
    listChats,
    getChat: getChatById,
    listRuns,
    getRun,
    resume: resumeRun,
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
