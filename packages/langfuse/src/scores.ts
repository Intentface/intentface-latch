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

/**
 * Attach a score to a run's Langfuse trace (judge verdicts, user feedback).
 * Flushes immediately — callers are post-turn/endpoint paths, not hot loops.
 */
export async function postScore(input: PostScoreInput): Promise<void> {
  const client = getLangfuseClient();
  client.score.create({
    traceId: await traceIdForRun(input.runId),
    name: input.name,
    value: input.value,
    comment: input.comment,
    dataType: input.dataType,
  });
  await client.score.flush();
}
