import { getLangfuseClient } from "./client.js";
import { traceIdForRun } from "./trace-id.js";

export interface PostScoreInput {
  /** The latch run the score belongs to (resolved to its trace id). */
  runId: string;
  /** Score name — e.g. a rubric name, or "user-feedback". */
  name: string;
  value: number;
  /** Free-text rationale (judge reason / user comment). */
  comment?: string;
  dataType?: "NUMERIC" | "BOOLEAN" | "CATEGORICAL";
}

/** Default hard bound on the flush network call (ms). */
const FLUSH_TIMEOUT_MS = 10_000;

/**
 * Attach a score to a run's Langfuse trace (judge verdicts, user feedback).
 * Flushes immediately — callers are post-turn/endpoint paths, not hot loops —
 * with a hard timeout so a slow/down Langfuse can't hang a user-facing request
 * for a non-critical write. Rejects on timeout/error; callers decide whether
 * to surface or swallow it.
 */
export async function postScore(
  input: PostScoreInput & { timeoutMs?: number },
): Promise<void> {
  const client = getLangfuseClient();
  client.score.create({
    traceId: await traceIdForRun(input.runId),
    name: input.name,
    value: input.value,
    comment: input.comment,
    dataType: input.dataType,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Langfuse score flush timed out")),
      input.timeoutMs ?? FLUSH_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([client.score.flush(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
