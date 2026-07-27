import { createTraceId } from "@langfuse/tracing";

/**
 * The deterministic Langfuse trace id for a latch run. Both the tracer (span
 * seeding) and out-of-band writers (judge scores, user feedback) derive the
 * same id from the runId, so scores land on the run's trace without lookups.
 */
export function traceIdForRun(runId: string): Promise<string> {
  return createTraceId(`latch-run:${runId}`);
}

/**
 * A deterministic Langfuse score id for a (run, score-name) pair. Langfuse
 * upserts a score only when its id, name AND timestamp (date granularity) all
 * match, so deriving the id from run+name is necessary but not sufficient:
 * writers must ALSO pin the score timestamp to the run's clock (see
 * `PostScoreInput.timestamp`). Together they make score writes idempotent — the
 * live judge and a later human correction of the same rubric write the SAME id
 * and the correction overwrites the original verdict instead of leaving two
 * scores of the same name on the trace, even across days.
 */
export function scoreIdForRun(runId: string, name: string): Promise<string> {
  return createTraceId(`latch-score:${runId}:${name}`);
}
