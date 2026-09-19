import { getLangfuseClient } from "./client.js";
import { tracingEnvironment } from "./otel.js";
import { scoreIdForRun, traceIdForRun } from "./trace-id.js";

export interface PostScoreInput {
  /** The latch run the score belongs to (resolved to its trace id). */
  runId: string;
  /** Score name — e.g. a rubric name, or "user-feedback". */
  name: string;
  /**
   * The score. A string is only meaningful alongside `dataType: "CATEGORICAL"`,
   * where the value IS the selected label — a numeric projection of it would
   * throw away the thing the score exists to record.
   */
  value: number | string;
  /** Free-text rationale (judge reason / user comment). */
  comment?: string;
  dataType?: "NUMERIC" | "BOOLEAN" | "CATEGORICAL";
  /** Extra metadata on the score — e.g. a human correction's original AI verdict. */
  metadata?: Record<string, unknown>;
  /**
   * Stable score id. Defaults to a deterministic id derived from (runId, name)
   * so repeated writes for the same run+name upsert one score rather than
   * accumulating duplicates (live verdict → human correction overwrites it).
   * Pass an explicit id only when you deliberately want independent scores.
   */
  id?: string;
  /**
   * The run's start time (epoch ms) — the stable per-run clock every writer for
   * a run should pass. Langfuse only treats a write as an upsert when id, name
   * AND timestamp (at date granularity) all match; the high-level SDK stamps
   * `now`, so a correction on a later day would create a SECOND score and skew
   * aggregates. Pinning every write for a run to its start keeps corrections
   * idempotent across days. Defaults to now (same-day writes still dedupe).
   */
  timestamp?: number;
  /**
   * Langfuse environment for the score. Defaults to the environment tracing was
   * set up with (so scores match their trace), then `LANGFUSE_TRACING_ENVIRONMENT`.
   * Pass explicitly to override.
   */
  environment?: string;
}

/** Default hard bound on the ingest network call (ms). */
const INGEST_TIMEOUT_MS = 10_000;

/** The `score-create` ingestion event shape, derived from the client's API. */
type IngestionEvent = Parameters<
  ReturnType<typeof getLangfuseClient>["api"]["ingestion"]["batch"]
>[0]["batch"][number];

/**
 * Attach a score to a run's Langfuse trace (judge verdicts, user feedback).
 * Sent through the raw ingestion endpoint (not the high-level `score.create`)
 * so the event timestamp can be pinned to the run's clock — the only way to
 * make cross-day corrections upsert instead of duplicate (see `timestamp`).
 * Ingests immediately — callers are post-turn/endpoint paths, not hot loops —
 * with a request-level timeout and no retries so a slow/down Langfuse can't
 * hang a user-facing request for this non-critical write. Rejects on
 * timeout/error; callers decide whether to surface or swallow it (the judge
 * and endpoint callers all swallow).
 */
export async function postScore(
  input: PostScoreInput & { timeoutMs?: number },
): Promise<void> {
  const client = getLangfuseClient();
  const event: IngestionEvent = {
    // Event id is unique per write so the ingestion event itself isn't deduped;
    // the SCORE is deduped by `body.id` (the deterministic per-run+name id).
    id: crypto.randomUUID(),
    type: "score-create",
    timestamp: new Date(input.timestamp ?? Date.now()).toISOString(),
    body: {
      id: input.id ?? (await scoreIdForRun(input.runId, input.name)),
      traceId: await traceIdForRun(input.runId),
      name: input.name,
      value: input.value,
      comment: input.comment,
      dataType: input.dataType,
      // Match the trace's environment (from ensureTracing) so scores land
      // alongside their trace, not in a mismatched Langfuse environment; fall
      // back to the env var on a cold, score-only invocation.
      environment:
        input.environment ??
        tracingEnvironment() ??
        process.env.LANGFUSE_TRACING_ENVIRONMENT,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    },
  };
  // Bound the call at the request level: this cancels the actual HTTP on
  // timeout (a Promise.race would leave it running) and disables the SDK's
  // default 2 retries, so the worst-case hang stays at one timeout window.
  const res = await client.api.ingestion.batch(
    { batch: [event] },
    {
      timeoutInSeconds: Math.ceil((input.timeoutMs ?? INGEST_TIMEOUT_MS) / 1000),
      maxRetries: 0,
    },
  );
  if (res.errors.length > 0) {
    throw new Error(
      `Langfuse score ingest failed: ${res.errors
        .map((e) => e.message ?? String(e.status))
        .join("; ")}`,
    );
  }
}
