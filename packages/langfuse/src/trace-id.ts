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
 * ingestion upserts scores by id, so deriving the id from run+name makes score
 * writes idempotent: the live judge and a later human correction of the same
 * rubric write the SAME id and the correction overwrites the original verdict
 * instead of leaving two scores of the same name on the trace.
 */
export function scoreIdForRun(runId: string, name: string): Promise<string> {
  return createTraceId(`latch-score:${runId}:${name}`);
}
