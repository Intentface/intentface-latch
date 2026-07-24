import type { Client } from "@libsql/client";

/**
 * Local mirror of per-run eval verdicts — the fast, mutable layer the agent
 * chat page reads so scores appear in the judge's own latency instead of
 * Langfuse's read-side ingestion lag. Langfuse remains the production record;
 * this table also carries re-judge (tuning) verdicts that are deliberately NOT
 * written to Langfuse, so production aggregates stay clean.
 *
 * Keyed (owner, run_id, rubric_name): the live judge and any later re-judge of
 * the same run+rubric upsert the same row. `source` distinguishes the original
 * live verdict from a tuning re-judge.
 */
export interface RunScore {
  runId: string;
  rubricName: string;
  /** 1/0 for binary, 0–1 for graded. The human value when source="human". */
  value: number;
  comment?: string;
  scale: "binary" | "score";
  source: "live" | "rejudge" | "human";
  /** When a human corrected it: the judge's original value/reason, preserved. */
  aiValue?: number;
  aiComment?: string;
  updatedAt: number;
}

export async function migrateRunScores(client: Client): Promise<void> {
  await client.execute(`CREATE TABLE IF NOT EXISTS latch_run_scores (
    owner TEXT NOT NULL,
    run_id TEXT NOT NULL,
    rubric_name TEXT NOT NULL,
    value REAL NOT NULL,
    comment TEXT,
    scale TEXT NOT NULL,
    source TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner, run_id, rubric_name)
  )`);
  await client.execute(
    `CREATE INDEX IF NOT EXISTS latch_run_scores_owner_run ON latch_run_scores (owner, run_id)`,
  );
  // Human-correction columns (idempotent for existing dev DBs).
  for (const col of ["ai_value REAL", "ai_comment TEXT"]) {
    await client.execute(`ALTER TABLE latch_run_scores ADD COLUMN ${col}`).catch(() => {});
  }
}

export interface RunScoresStore {
  /** Upsert one verdict for a run+rubric (live or re-judge). `owner` is the
   *  canonical owner key (see `ownerTagOf`). */
  put: (owner: string, score: RunScore) => Promise<void>;
  /** All scores for the given run ids, grouped by runId. */
  getForRuns: (owner: string, runIds: string[]) => Promise<Map<string, RunScore[]>>;
  /** One score for a run+rubric, or null. */
  getOne: (owner: string, runId: string, rubricName: string) => Promise<RunScore | null>;
}

const asSource = (v: unknown): RunScore["source"] =>
  v === "human" ? "human" : v === "rejudge" ? "rejudge" : "live";

const rowToScore = (r: Record<string, unknown>): RunScore => ({
  runId: String(r.run_id),
  rubricName: String(r.rubric_name),
  value: Number(r.value),
  comment: (r.comment as string) ?? undefined,
  scale: String(r.scale) === "score" ? "score" : "binary",
  source: asSource(r.source),
  aiValue: r.ai_value == null ? undefined : Number(r.ai_value),
  aiComment: (r.ai_comment as string) ?? undefined,
  updatedAt: Number(r.updated_at),
});

export function createRunScoresStore(client: Client): RunScoresStore {
  return {
    async put(owner, score) {
      await client.execute({
        sql: `INSERT INTO latch_run_scores
          (owner, run_id, rubric_name, value, comment, scale, source, ai_value, ai_comment, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(owner, run_id, rubric_name) DO UPDATE SET
            value=excluded.value, comment=excluded.comment, scale=excluded.scale,
            source=excluded.source, ai_value=excluded.ai_value,
            ai_comment=excluded.ai_comment, updated_at=excluded.updated_at`,
        args: [
          owner,
          score.runId,
          score.rubricName,
          score.value,
          score.comment ?? null,
          score.scale,
          score.source,
          score.aiValue ?? null,
          score.aiComment ?? null,
          score.updatedAt,
        ],
      });
    },

    async getOne(owner, runId, rubricName) {
      const res = await client.execute({
        sql: `SELECT * FROM latch_run_scores WHERE owner = ? AND run_id = ? AND rubric_name = ?`,
        args: [owner, runId, rubricName],
      });
      const row = (res.rows as unknown as Record<string, unknown>[])[0];
      return row ? rowToScore(row) : null;
    },

    async getForRuns(owner, runIds) {
      const byRun = new Map<string, RunScore[]>();
      if (runIds.length === 0) return byRun;
      // Bound the IN-list; visible messages per poll are few, but guard anyway.
      const ids = runIds.slice(0, 200);
      const placeholders = ids.map(() => "?").join(",");
      const res = await client.execute({
        sql: `SELECT * FROM latch_run_scores
          WHERE owner = ? AND run_id IN (${placeholders})
          ORDER BY rubric_name ASC`,
        args: [owner, ...ids],
      });
      for (const row of res.rows as unknown as Record<string, unknown>[]) {
        const s = rowToScore(row);
        const list = byRun.get(s.runId) ?? [];
        list.push(s);
        byRun.set(s.runId, list);
      }
      return byRun;
    },
  };
}
