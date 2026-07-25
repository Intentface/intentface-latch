import type { TelemetryOptions } from "ai";

/**
 * The telemetry seam — kept out of core so it carries no OTEL/vendor dep.
 * A platform supplies an implementation (e.g. `@intentface/latch-langfuse`)
 * via `RuntimeConfig.telemetry`; without one, nothing changes.
 *
 * The runtime calls it around the single model-call choke-point in
 * `buildTurn`: per-run settings feed the AI SDK's `telemetry` option, the
 * run span wrapper lets the impl root all spans in one trace, and the
 * finish hook fires after the turn is persisted (scores, judges, flush).
 */

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
  /** Delegation depth: 0 = top-level turn, >0 = a subagent turn. */
  depth: number;
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

export interface LatchTelemetry<P = unknown> {
  /**
   * Per-run AI SDK telemetry options (integrations, functionId, …), passed as
   * `telemetry` on the turn's agent. Return undefined to skip this run.
   */
  telemetryFor?(run: TelemetryRunMeta<P>): TelemetryOptions | undefined;
  /**
   * Wrap the model call so the impl can root it in a trace context (seeded
   * trace id, session/user/tags). Identity when absent.
   */
  withRunSpan?<T>(run: TelemetryRunMeta<P>, fn: () => Promise<T>): Promise<T>;
  /**
   * Post-turn hook, fired after messages/run/usage are persisted (and on
   * error/abort with status "errored"). Errors are swallowed — telemetry must
   * never fail a turn.
   */
  onRunFinished?(
    run: TelemetryRunMeta<P>,
    outcome: TelemetryRunOutcome,
  ): void | Promise<void>;
  /** Flush exporters (serverless). Awaited after onRunFinished. */
  flush?(): Promise<void>;
}
