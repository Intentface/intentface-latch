import type { TelemetryOptions } from "ai";

/**
 * The telemetry seam — THE observation point for a turn, kept out of core so it
 * carries no OTEL/vendor dep. A host supplies an implementation via
 * `RuntimeConfig.telemetry`: a full tracer (`@intentface/latch-langfuse`), or
 * just the hooks it wants (`onRunFinished` for a usage ledger or an
 * operational notification, `onStep` for per-tool analytics). Without one,
 * nothing changes.
 *
 * The runtime calls it around the single model-call choke-point in
 * `buildTurn`: per-run settings feed the AI SDK's `telemetry` option, the run
 * span wrapper lets a tracer root all spans in one trace, `onStep` fires after
 * each generation step, and `onRunFinished` fires after the turn is persisted
 * (scores, judges, flush). Every hook is guarded: a throwing or rejecting hook
 * is swallowed, so telemetry can never fail a turn.
 *
 * Opting a run out: an impl that defines `telemetryFor` and returns undefined
 * for a run silences ALL hooks for that run (not just the AI SDK settings).
 */

/**
 * What started a turn — and, in practice, whether a human is at the other end
 * of it:
 *
 * - `"chat"` — a user message (`handleChat`). Someone is watching the stream.
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
 * That distinction is what makes `onRunFinished` usable as an operational
 * notification channel and not just an analytics feed: a turn that finishes
 * `awaiting_input` under `"schedule"` or `"resume"` is a person who needs to
 * be told, while the same status under `"chat"` or `"decision"` is just a gate
 * rendering in front of someone who can answer it.
 *
 * A subagent turn inherits its parent's trigger (like `rootChatId`), so a
 * whole delegation tree is attributable to what set it off.
 */
export type TurnTrigger = "chat" | "decision" | "programmatic" | "schedule" | "resume";

/** Identity of one run/turn, known before the model call starts. */
export interface TelemetryRunMeta<P = unknown> {
  /** Per-turn run id (`latch_runs.id`) — the natural trace correlation key. */
  runId: string;
  /** The conversation id — the natural session id. */
  chatId: string;
  /** Registered agent name. */
  agent: string;
  /** Display model id for the turn. */
  modelId: string;
  /** The caller the run is scoped to (tenant/user isolation flows from this). */
  principal: P;
  /**
   * Run start time (epoch ms, `latch_runs.startedAt`). A stable per-run clock:
   * out-of-band score writers (judge verdicts, user feedback, human
   * corrections) pin their Langfuse score timestamp to it so repeated writes
   * for the same run+rubric upsert one score instead of duplicating across days.
   */
  startedAt: number;
  /**
   * The stored agent-record version this turn ran on, when the agent came from
   * a versioning store. Absent for code-declared agents. Lets a tracer tag the
   * trace with the exact configuration behind it.
   */
  agentVersion?: number;
  /** Delegation depth: 0 = top-level turn, >0 = a subagent turn. */
  depth: number;
  /** What started this turn — see {@link TurnTrigger}. */
  trigger: TurnTrigger;
  /**
   * The run that spawned this subagent turn, when applicable. Absent at the top
   * level. Lets a tracer link a helper's trace back to the agent it ran for.
   */
  parentRunId?: string;
  /**
   * The top-level conversation id — stable across a turn AND its subagent
   * turns (a subagent's own `chatId` is an internal `sub_…` thread). A tracer
   * can use it as the session id so a whole delegation tree groups together.
   * Falls back to `chatId` when unset (top-level turns).
   */
  rootChatId?: string;
}

/** Outcome of one finished turn, delivered after persistence. */
export interface TelemetryRunOutcome {
  status: "completed" | "awaiting_input" | "errored";
  /** Present when status is "errored". */
  error?: string;
  /** Plain text of the incoming user message for this turn, if any. */
  inputText?: string;
  /**
   * The turn's persisted messages (assistant message last). Typed loosely so
   * implementations stay decoupled from the message shape; cast to
   * `AppMessage[]` to walk parts.
   */
  messages: unknown[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  /** Cost for the turn (0 without a pricing config). */
  cost: number;
  endedAt?: number;
}

/** One completed generation step (model output + the step's tool calls/results). */
export interface TelemetryStep {
  text?: string;
  finishReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  toolCalls?: Array<{ toolCallId: string; toolName: string; input?: unknown }>;
  toolResults?: Array<{ toolCallId: string; toolName: string; output?: unknown }>;
}

export interface LatchTelemetry<P = unknown> {
  /**
   * Per-run AI SDK telemetry options (integrations, functionId, …), passed as
   * `telemetry` on the turn's agent. Return undefined to skip this run — every
   * other hook goes silent for it too.
   */
  telemetryFor?(run: TelemetryRunMeta<P>): TelemetryOptions | undefined;
  /**
   * After each generation step (model output + that step's tool calls and
   * results). Fire-and-forget: not awaited, never fails the turn. For per-tool
   * analytics and step-level metrics.
   */
  onStep?(run: TelemetryRunMeta<P>, step: TelemetryStep): void | Promise<void>;
  /**
   * Wrap the model call so the impl can root it in a trace context (seeded
   * trace id, session/user/tags). Identity when absent.
   */
  withRunSpan?<T>(run: TelemetryRunMeta<P>, fn: () => Promise<T>): Promise<T>;
  /**
   * Post-turn hook, fired after messages/run/usage are persisted (and on
   * error/abort with status "errored", carrying the error message). Awaited,
   * errors swallowed — telemetry must never fail a turn. With `run.trigger`
   * this doubles as the operational notification seam: `status:
   * "awaiting_input"` under `"schedule"`/`"resume"` is a fire nobody can
   * answer.
   */
  onRunFinished?(
    run: TelemetryRunMeta<P>,
    outcome: TelemetryRunOutcome,
  ): void | Promise<void>;
  /** Flush exporters (serverless). Awaited after onRunFinished. */
  flush?(): Promise<void>;
}
