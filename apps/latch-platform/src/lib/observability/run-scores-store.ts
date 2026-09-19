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
 *
 * `owner` is the EVAL owner — the owner key of the agent whose rubrics produced
 * the verdict (`agentOwnerKey`), NOT whoever ran the turn. That's what lets a
 * colleague's run on my agent surface in my observations while staying invisible
 * to them. Who ran it is recorded separately in `run_owner`, for attribution.
 */
export interface RunScore {
  runId: string;
  rubricName: string;
  /**
   * 1/0 for boolean, 0–1 for graded, and for a CHOICE the pass/fail projection
   * (1 unless the selected option is one the rubric calls bad).
   *
   * Projecting rather than storing the label here is what keeps every existing
   * aggregate correct: a choice rubric's average is still its pass rate, and
   * `/observability` needs no special case to chart it. The label itself lives
   * in `choice`, where it is detail rather than arithmetic.
   */
  value: number;
  /** The option a choice rubric selected. Absent for boolean and score. */
  choice?: string;
  comment?: string;
  /** As written. "binary" and "boolean" are synonyms — read with `isGradedScale`. */
  scale: "binary" | "boolean" | "score" | "choice";
  source: "live" | "rejudge" | "human";
  /** When a human corrected it: the judge's original value/reason, preserved. */
  aiValue?: number;
  /** A corrected choice rubric's original selected option. */
  aiChoice?: string;
  aiComment?: string;
  /**
   * The `ownerTagOf` of the principal that ran the judged turn. Absent on rows
   * written before the eval-owner split (where `owner` WAS the runner).
   */
  runOwner?: string;
  /**
   * The `owner` column this row was found under. Reads always set it, so a caller
   * that searched several keys can upsert the row it actually matched instead of
   * forking a duplicate under its preferred key. `put` takes the owner as its own
   * argument and rejects it here (`RunScoreWrite`), so it can't be passed twice.
   */
  owner: string;
  updatedAt: number;
}

/**
 * A verdict as written: everything except `owner`, which `put` takes separately.
 * Splitting it keeps a read result from being handed back to `put` in the hope
 * that its `owner` routes the write — that would have been a silent no-op.
 */
export type RunScoreWrite = Omit<RunScore, "owner">;

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
  // Human-correction columns, added idempotently for existing dev DBs. SQLite's
  // ADD COLUMN has no IF NOT EXISTS, so add only what PRAGMA reports missing —
  // swallowing every ALTER error would let a genuine failure leave the schema
  // half-migrated, and put() would then hit missing ai_value/ai_comment columns.
  const columns = async () =>
    new Set(
      ((await client.execute(`PRAGMA table_info(latch_run_scores)`))
        .rows as unknown as Record<string, unknown>[]).map((r) => String(r.name)),
    );
  const existing = await columns();
  for (const [name, def] of [
    ["ai_value", "ai_value REAL"],
    ["ai_comment", "ai_comment TEXT"],
    ["run_owner", "run_owner TEXT"],
    // A choice verdict's selected option. Nullable: `value` stays the
    // NOT NULL pass/fail projection for every scale.
    ["choice", "choice TEXT"],
    ["ai_choice", "ai_choice TEXT"],
  ] as const) {
    if (existing.has(name)) continue;
    try {
      await client.execute(`ALTER TABLE latch_run_scores ADD COLUMN ${def}`);
    } catch (err) {
      // Race: another process (concurrent getLatch()) may have added the column
      // between our PRAGMA read and this ALTER. Re-read and tolerate the error
      // ONLY if the column is now present — otherwise it's a genuine failure.
      if (!(await columns()).has(name)) throw err;
    }
  }
}

export interface RunScoresStore {
  /** Upsert one verdict for a run+rubric (live or re-judge). `owner` is the eval
   *  owner — the judged agent's owner key (see `agentOwnerKey`). */
  put: (owner: string, score: RunScoreWrite) => Promise<void>;
  /**
   * All scores for the given run ids, grouped by runId. `owner` accepts several
   * keys (see `evalOwnerKeysOf`) so a caller can read its personal AND its org's
   * agents in one hop; rows are matched on any of them.
   */
  getForRuns: (
    owner: string | string[],
    runIds: string[],
  ) => Promise<Map<string, RunScore[]>>;
  /** One score for a run+rubric under any of `owner`, or null. */
  getOne: (
    owner: string | string[],
    runId: string,
    rubricName: string,
  ) => Promise<RunScore | null>;
}

const asSource = (v: unknown): RunScore["source"] =>
  v === "human" ? "human" : v === "rejudge" ? "rejudge" : "live";

const rowToScore = (r: Record<string, unknown>): RunScore => ({
  runId: String(r.run_id),
  rubricName: String(r.rubric_name),
  value: Number(r.value),
  choice: (r.choice as string) ?? undefined,
  comment: (r.comment as string) ?? undefined,
  scale:
    String(r.scale) === "score"
      ? "score"
      : String(r.scale) === "choice"
        ? "choice"
        : "binary",
  source: asSource(r.source),
  aiValue: r.ai_value == null ? undefined : Number(r.ai_value),
  aiChoice: (r.ai_choice as string) ?? undefined,
  aiComment: (r.ai_comment as string) ?? undefined,
  runOwner: (r.run_owner as string) ?? undefined,
  owner: String(r.owner),
  updatedAt: Number(r.updated_at),
});

/**
 * Normalize the owner argument to a non-empty key list. An empty array would
 * compile to `owner IN ()` — a syntax error in SQLite — so callers that legibly
 * pass a filtered-empty list get "no rows" instead of a thrown query.
 */
const ownerList = (owner: string | string[]): string[] =>
  (typeof owner === "string" ? [owner] : owner).filter((o) => o.length > 0);

export function createRunScoresStore(client: Client): RunScoresStore {
  return {
    async put(owner, score) {
      await client.execute({
        sql: `INSERT INTO latch_run_scores
          (owner, run_id, rubric_name, value, choice, comment, scale, source, ai_value, ai_choice, ai_comment, run_owner, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(owner, run_id, rubric_name) DO UPDATE SET
            value=excluded.value, choice=excluded.choice,
            comment=excluded.comment, scale=excluded.scale,
            source=excluded.source, ai_value=excluded.ai_value,
            ai_choice=excluded.ai_choice, ai_comment=excluded.ai_comment,
            -- A human correction carries no runner (it isn't a run); keep the
            -- attribution the live judge recorded instead of nulling it out.
            run_owner=COALESCE(excluded.run_owner, run_owner),
            updated_at=excluded.updated_at`,
        args: [
          owner,
          score.runId,
          score.rubricName,
          score.value,
          score.choice ?? null,
          score.comment ?? null,
          score.scale,
          score.source,
          score.aiValue ?? null,
          score.aiChoice ?? null,
          score.aiComment ?? null,
          score.runOwner ?? null,
          score.updatedAt,
        ],
      });
    },

    async getOne(owner, runId, rubricName) {
      const owners = ownerList(owner);
      if (owners.length === 0) return null;
      const res = await client.execute({
        // Newest wins when the same verdict exists under two keys — see
        // getForRuns for why that happens.
        sql: `SELECT * FROM latch_run_scores
          WHERE owner IN (${owners.map(() => "?").join(",")})
            AND run_id = ? AND rubric_name = ?
          ORDER BY updated_at DESC LIMIT 1`,
        args: [...owners, runId, rubricName],
      });
      const row = (res.rows as unknown as Record<string, unknown>[])[0];
      return row ? rowToScore(row) : null;
    },

    async getForRuns(owner, runIds) {
      const byRun = new Map<string, RunScore[]>();
      const owners = ownerList(owner);
      if (runIds.length === 0 || owners.length === 0) return byRun;
      // Bound the IN-list; visible messages per poll are few, but guard anyway.
      const ids = runIds.slice(0, 200);
      const placeholders = ids.map(() => "?").join(",");
      const res = await client.execute({
        sql: `SELECT * FROM latch_run_scores
          WHERE owner IN (${owners.map(() => "?").join(",")})
            AND run_id IN (${placeholders})
          ORDER BY rubric_name ASC`,
        args: [...owners, ...ids],
      });
      // One verdict can exist under two keys: a row written before the
      // eval-owner split (keyed by the RUNNER, which for one's own runs equals
      // one's personal key) plus a later row keyed by the agent's owner. Collapse
      // to the newest so a rubric never renders twice — matching getOne, and
      // keeping a human correction authoritative over an older live verdict.
      const newest = new Map<string, RunScore>();
      for (const row of res.rows as unknown as Record<string, unknown>[]) {
        const s = rowToScore(row);
        const key = `${s.runId} ${s.rubricName}`;
        const prev = newest.get(key);
        if (!prev || s.updatedAt > prev.updatedAt) newest.set(key, s);
      }
      for (const s of newest.values()) {
        const list = byRun.get(s.runId) ?? [];
        list.push(s);
        byRun.set(s.runId, list);
      }
      for (const list of byRun.values()) {
        list.sort((a, b) => a.rubricName.localeCompare(b.rubricName));
      }
      return byRun;
    },
  };
}
