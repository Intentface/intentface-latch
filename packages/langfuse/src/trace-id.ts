import { createTraceId } from "@langfuse/tracing";

/**
 * The deterministic Langfuse trace id for a latch run. Both the tracer (span
 * seeding) and out-of-band writers (judge scores, user feedback) derive the
 * same id from the runId, so scores land on the run's trace without lookups.
 */
export function traceIdForRun(runId: string): Promise<string> {
  return createTraceId(`latch-run:${runId}`);
}
