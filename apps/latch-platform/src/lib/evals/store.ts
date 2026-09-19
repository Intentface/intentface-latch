import type { Client } from "@libsql/client";
import type { Question } from "./ask";

/**
 * Evals: named sets of test cases for an agent, plus the persisted results of
 * running them. A case sends one user message to the agent (isolated, safe-mode
 * run) and grades the outcome with deterministic checks — answer assertions
 * and tool-call expectations. Owner-scoped (per org+user) like agents/tools.
 *
 * A run pins `agentSnapshot` (the agent's config at run time), so run-over-run
 * comparisons stay honest even though `latch_agents` upserts in place.
 */

/**
 * These structures are stored as JSON columns and cross the server-function
 * boundary, so they are typed as JSON rather than `unknown`: `unknown` cannot
 * be proven serializable, and the honest type is the one the column can hold.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface EvalAssertions {
  /** Substrings the answer must include (case-insensitive). */
  contains?: string[];
  /** Substrings the answer must NOT include (case-insensitive). */
  notContains?: string[];
  /** Regexes (JS syntax) the answer must match. */
  regex?: string[];
}

export interface EvalToolExpectation {
  /** Tool the agent must have called. */
  tool: string;
  /**
   * Subset of the call's arguments that must match (deep-equal per key). A
   * value of `{"$regex": "..."}` is a matcher instead of a literal — it tests
   * the actual value against the pattern (for dynamic values like dates).
   */
  args?: Record<string, JsonValue>;
  /** Max times the tool may be called (catches tool loops). */
  maxCalls?: number;
}

export interface EvalExpectation {
  assertions?: EvalAssertions;
  toolCalls?: EvalToolExpectation[];
  /** Tools the agent must NOT have called. */
  forbiddenTools?: string[];
  /** Tools that must appear in this relative order (others may interleave). */
  toolOrder?: string[];
  /** Budget: max tool calls in the whole case (catches runaway loops). */
  maxTotalToolCalls?: number;
  /**
   * Plain-language criteria graded by a pinned LLM judge (one call per
   * criterion, temperature 0). A failed criterion FAILS the case, like any
   * deterministic check; a judge infra error does not. Max 5 per case.
   */
  rubric?: string[];
}

/**
 * One typed check's verdict, and the human's if someone disagreed.
 *
 * The judge's answer is never overwritten. A correction is a SECOND opinion
 * recorded beside the first, because the pair is the only thing that can
 * answer the question that matters: is this judge reliable on THIS question?
 * Overwriting would leave a tidy table of verdicts and no way to know which of
 * them to believe.
 */
export interface CheckVerdict {
  id: string;
  /** The judge's answer — "true"/"false", or the option it chose. */
  answer: string;
  confidence: number;
  /** The judge's call. */
  failed: boolean;
  /**
   * How many windows the conversation was cut into for judging. 1 means the
   * judge saw the whole thing.
   *
   * Carried so a reader can tell whether the transcript beside a verdict is the
   * evidence the judge actually had. Showing a full conversation next to a
   * verdict drawn from window 3 of 5 is worse than showing nothing: it invites
   * a confident correction based on evidence the judge never saw.
   */
  slices?: number;
  /** Which windows failed — where to look first in a long run. */
  failedSlices?: number[];
  /** A human's call, when someone disagreed or confirmed. */
  human?: {
    failed: boolean;
    at: number;
    /** Who, for attribution — never used to filter. */
    by?: string;
  };
}

/** The judge's verdict on one rubric criterion. */
export interface RubricVerdict {
  criterion: string;
  pass: boolean;
  /** One short sentence from the judge on why. */
  reason: string;
  /** Set when the judge CALL failed (bad JSON, API error) — never fails the case. */
  error?: string;
}

export interface EvalCase {
  /** Stable id — keep it constant across saves so run history stays comparable. */
  id: string;
  /** Short human label ("refund question escalates"). */
  name: string;
  /** The user message sent to the agent — the first turn. */
  input: string;
  /**
   * Further user messages, sent into the SAME thread after the first answer.
   *
   * Most real failures are not in the opening question. An agent that fetches
   * correctly and then answers a follow-up from memory, or loses the thread of
   * what "it" refers to, passes every single-turn case ever written. Without
   * this the only way to test a follow-up is to cram two requests into one
   * message, which tests a different thing.
   *
   * Checks see the WHOLE conversation, so a question can be about the arc
   * ("did it keep using the fetched data?") rather than one reply.
   */
  followUps?: string[];
  expected: EvalExpectation;
  /**
   * Typed questions asked of the trace this case produces — the same
   * `boolean` / `choice` / `score` primitives used on live traffic.
   *
   * This is the open half of a case. `expected` is a fixed vocabulary someone
   * has to fit an intention into; `checks` lets the author COMPOSE the
   * judgment: a choice where a failure has several shapes, a score where the
   * quality is a matter of degree, a boolean where it really is a line. The
   * two coexist — a deterministic tool assertion is still exact and free, and
   * no question should be paid for that a comparison can answer.
   *
   * Keyed by a stable id, like every other question, because that id is what a
   * later comparison pairs on.
   */
  checks?: Record<string, Question>;
  /**
   * Opt-in flakiness measurement: run the case N times (2–5); it passes on a
   * majority of attempts and the result records the pass rate. Only for
   * behaviors observed to be nondeterministic — repeats multiply run cost.
   */
  repeats?: number;
}

export interface EvalSet {
  owner: string;
  agentName: string;
  name: string;
  /**
   * Checks asked of EVERY case in the set.
   *
   * Most questions do not depend on the input. "Is every claim supported by a
   * tool result?" means the same thing whether the user asked about networking
   * or billing, so it belongs to the set, not to one case. Only a question that
   * needs ground truth the question itself cannot know — WHICH document, WHICH
   * number — has to live on a case.
   *
   * The split is not a convenience. A shared check gets one observation per
   * case, so a set of 100 inputs gives it n=100 and a comparison between two
   * versions can actually resolve it. A per-case check gets n=1 and can never
   * be conclusive on its own, however carefully it is written. Sharing is what
   * makes the statistics work at all.
   *
   * A case may add its own on top; ids collide toward the CASE, so one input
   * can sharpen a shared question without rewriting it for the other 99.
   */
  checks?: Record<string, Question>;
  cases: EvalCase[];
  createdAt: number;
  updatedAt: number;
}

/** One tool invocation observed in a case's transcript. */
export interface EvalToolCall {
  tool: string;
  args?: JsonValue;
  /** True when safe mode stubbed this approval-gated tool. */
  blocked?: boolean;
}

/** One attempt of a case (a repeated case has several; a plain case exactly one). */
export interface EvalAttemptResult {
  pass: boolean;
  /** Failure reasons (empty when passing). */
  reasons: string[];
  /** The isolated sub-thread holding the full transcript. */
  threadId?: string;
  answerPreview: string;
  toolCalls: EvalToolCall[];
  /** Set when the run itself errored (agent crash, not a failed grade). */
  error?: string;
  /** Judge verdicts, one per rubric criterion (only when the case has a rubric). */
  rubric?: RubricVerdict[];
  /** Verdicts for the case's typed `checks`, if it declared any. */
  checks?: CheckVerdict[];
}

export interface EvalCaseResult extends EvalAttemptResult {
  caseId: string;
  caseName: string;
  /** Attempts run (only set when the case declared repeats > 1). */
  repeats?: number;
  /** Attempts that passed (only set alongside `repeats`). */
  passes?: number;
  /** Per-attempt detail for repeated cases (top-level fields mirror the first failing attempt). */
  attempts?: EvalAttemptResult[];
}

/**
 * Attempt-level pass rate of a run (0..1): a repeated case contributes
 * passes/repeats, a single-attempt case 0 or 1. Older stored results (no
 * repeats fields) degrade to their boolean verdict, so run-over-run rate
 * deltas stay computable across history.
 */
export function runPassRate(results: Pick<EvalCaseResult, "pass" | "passes" | "repeats">[]): number {
  if (results.length === 0) return 0;
  const sum = results.reduce(
    (acc, r) => acc + (r.repeats ? (r.passes ?? 0) / r.repeats : r.pass ? 1 : 0),
    0,
  );
  return sum / results.length;
}

export interface EvalRunMetrics {
  /** Wall clock for the whole set, including judging. */
  durationMs: number;
  /** What running the AGENT cost — the expensive half. */
  agentCost: number;
  agentTokensIn: number;
  agentTokensOut: number;
  /** What JUDGING cost, in calls and tokens — usually rounding error beside it. */
  judgeCalls: number;
  judgeTokensIn: number;
  judgeTokensOut: number;
}

export interface EvalRun {
  id: string;
  owner: string;
  agentName: string;
  setName: string;
  /** The agent's stored config at run time (null for code-declared agents). */
  agentSnapshot: JsonValue | null;
  results: EvalCaseResult[];
  passCount: number;
  failCount: number;
  /** The pinned judge model used for rubric criteria (null when the set has none). */
  judgeModelId?: string | null;
  /**
   * The agent reference this run used — "hn-digest", "hn-digest@7",
   * "hn-digest@draft". The column a comparison is read along: without it two
   * runs are just two timestamps, and which configuration produced which set
   * of results is guesswork.
   */
  configRef?: string | null;
  /**
   * What the run cost and how long it took.
   *
   * Quality alone ranks nothing: a configuration that scores two points higher
   * for four times the money is a different decision from one that scores the
   * same for half. Recorded per run so the two can be read on one axis pair,
   * the way a model benchmark is read.
   */
  metrics?: EvalRunMetrics | null;
  createdAt: number;
}

/** Per-case result compacted for tool output / streaming (full detail stays in the run row). */
export interface CompactCaseResult {
  caseId: string;
  caseName: string;
  pass: boolean;
  reasons: string[];
  threadId?: string;
  answerPreview: string;
  toolCalls: string[];
  error?: string;
  /** Attempts run / passed (only for repeated cases) — the flakiness signal. */
  repeats?: number;
  passes?: number;
  /** Judge verdicts per rubric criterion (shown distinctly in the card). */
  rubric?: RubricVerdict[];
}

export const compactResult = (r: EvalCaseResult): CompactCaseResult => ({
  caseId: r.caseId,
  caseName: r.caseName,
  pass: r.pass,
  reasons: r.reasons,
  threadId: r.threadId,
  answerPreview: r.answerPreview,
  toolCalls: r.toolCalls.map((tc) => (tc.blocked ? `${tc.tool} (blocked)` : tc.tool)),
  error: r.error,
  repeats: r.repeats,
  passes: r.passes,
  rubric: r.rubric,
});

/**
 * The `data-eval-progress` part run_evals streams while executing (one part,
 * reconciled in place by id) — what the chat card renders live.
 */
export interface EvalProgressData {
  /** The run_evals tool call this progress belongs to. */
  toolCallId?: string;
  agentName: string;
  setName: string;
  /** Total ATTEMPTS (repeats counted) — what completed ticks against. */
  total: number;
  completed: number;
  /** Number of cases (≤ total when repeats are in play) — for the pass bar. */
  totalCases?: number;
  /** Graded cases so far, in completion order. */
  results: CompactCaseResult[];
}

export interface EvalStore {
  saveSet: (rec: Omit<EvalSet, "createdAt" | "updatedAt">) => Promise<void>;
  getSet: (owner: string, agentName: string, name: string) => Promise<EvalSet | null>;
  listSets: (owner: string, agentName?: string) => Promise<EvalSet[]>;
  deleteSet: (owner: string, agentName: string, name: string) => Promise<void>;
  saveRun: (run: Omit<EvalRun, "id" | "createdAt">) => Promise<EvalRun>;
  getRun: (owner: string, id: string) => Promise<EvalRun | null>;
  listRuns: (owner: string, agentName: string, setName?: string, limit?: number) => Promise<EvalRun[]>;
  /**
   * Record a human verdict on one check of one case in a stored run.
   *
   * Rewrites that run's results blob rather than keeping corrections in their
   * own table: a correction has no meaning apart from the verdict it disputes,
   * and splitting them would let one be deleted without the other.
   */
  /**
   * What the agent cost across these threads.
   *
   * An eval case runs the agent for real, so each thread already has a run row
   * carrying usage and cost — this totals them rather than re-deriving a price.
   * Lives here because this is where the eval SQL lives; the composition root
   * does not need to hand out a raw client for it.
   */
  costOfThreads: (
    threadIds: string[],
  ) => Promise<{ cost: number; tokensIn: number; tokensOut: number }>;
  correctCheck: (
    owner: string,
    runId: string,
    caseId: string,
    checkId: string,
    failed: boolean,
    by?: string,
  ) => Promise<EvalRun | null>;
}

export async function migrateEvals(client: Client): Promise<void> {
  await client.execute(`CREATE TABLE IF NOT EXISTS latch_eval_sets (
    owner TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    name TEXT NOT NULL,
    cases TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner, agent_name, name)
  )`);
  await client.execute(`ALTER TABLE latch_eval_sets ADD COLUMN checks TEXT`).catch(() => {});
  await client.execute(`CREATE TABLE IF NOT EXISTS latch_eval_runs (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    set_name TEXT NOT NULL,
    agent_snapshot TEXT,
    results TEXT NOT NULL,
    pass_count INTEGER NOT NULL,
    fail_count INTEGER NOT NULL,
    judge_model_id TEXT,
    created_at INTEGER NOT NULL
  )`);
  // Pre-judge-tier tables lack the column; ADD COLUMN fails once it exists.
  await client
    .execute(`ALTER TABLE latch_eval_runs ADD COLUMN judge_model_id TEXT`)
    .catch(() => {});
  await client.execute(`ALTER TABLE latch_eval_runs ADD COLUMN config_ref TEXT`).catch(() => {});
  await client.execute(`ALTER TABLE latch_eval_runs ADD COLUMN metrics TEXT`).catch(() => {});
  await client.execute(
    `CREATE INDEX IF NOT EXISTS latch_eval_runs_owner_agent ON latch_eval_runs (owner, agent_name, created_at)`,
  );
}

/** Parse a JSON column, falling back instead of throwing on a corrupt value. */
const safeParse = <T>(v: unknown, fallback: T): T => {
  if (v == null) return fallback;
  try {
    return JSON.parse(String(v)) as T;
  } catch {
    return fallback;
  }
};

const rowToSet = (r: Record<string, unknown>): EvalSet => ({
  owner: String(r.owner),
  agentName: String(r.agent_name),
  name: String(r.name),
  checks: (() => {
    const v = safeParse<unknown>(r.checks, undefined);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, Question>) : undefined;
  })(),
  cases: (() => {
    const v = safeParse<unknown>(r.cases, []);
    return Array.isArray(v) ? (v as EvalCase[]) : [];
  })(),
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

const rowToRun = (r: Record<string, unknown>): EvalRun => ({
  id: String(r.id),
  owner: String(r.owner),
  agentName: String(r.agent_name),
  setName: String(r.set_name),
  agentSnapshot: safeParse<JsonValue | null>(r.agent_snapshot, null),
  results: (() => {
    const v = safeParse<unknown>(r.results, []);
    return Array.isArray(v) ? (v as EvalCaseResult[]) : [];
  })(),
  passCount: Number(r.pass_count),
  failCount: Number(r.fail_count),
  judgeModelId: r.judge_model_id == null ? null : String(r.judge_model_id),
  configRef: r.config_ref == null ? null : String(r.config_ref),
  metrics: safeParse<EvalRunMetrics | null>(r.metrics, null),
  createdAt: Number(r.created_at),
});

const newRunId = () => `evr_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

export function createEvalStore(client: Client): EvalStore {
  return {
    async saveSet(rec) {
      const now = Date.now();
      await client.execute({
        sql: `INSERT INTO latch_eval_sets (owner, agent_name, name, cases, checks, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(owner, agent_name, name) DO UPDATE SET
                cases = excluded.cases,
                checks = excluded.checks,
                updated_at = excluded.updated_at`,
        args: [
          rec.owner,
          rec.agentName,
          rec.name,
          JSON.stringify(rec.cases),
          rec.checks ? JSON.stringify(rec.checks) : null,
          now,
          now,
        ],
      });
    },

    async getSet(owner, agentName, name) {
      const res = await client.execute({
        sql: `SELECT * FROM latch_eval_sets WHERE owner = ? AND agent_name = ? AND name = ?`,
        args: [owner, agentName, name],
      });
      const r = res.rows[0] as Record<string, unknown> | undefined;
      return r ? rowToSet(r) : null;
    },

    async listSets(owner, agentName) {
      const res = await client.execute(
        agentName
          ? {
              sql: `SELECT * FROM latch_eval_sets WHERE owner = ? AND agent_name = ? ORDER BY agent_name, name`,
              args: [owner, agentName],
            }
          : {
              sql: `SELECT * FROM latch_eval_sets WHERE owner = ? ORDER BY agent_name, name`,
              args: [owner],
            },
      );
      return (res.rows as unknown as Record<string, unknown>[]).map(rowToSet);
    },

    async deleteSet(owner, agentName, name) {
      await client.execute({
        sql: `DELETE FROM latch_eval_sets WHERE owner = ? AND agent_name = ? AND name = ?`,
        args: [owner, agentName, name],
      });
    },

    async saveRun(run) {
      const full: EvalRun = { ...run, id: newRunId(), createdAt: Date.now() };
      await client.execute({
        sql: `INSERT INTO latch_eval_runs (id, owner, agent_name, set_name, agent_snapshot, results, pass_count, fail_count, judge_model_id, config_ref, metrics, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          full.id,
          full.owner,
          full.agentName,
          full.setName,
          full.agentSnapshot == null ? null : JSON.stringify(full.agentSnapshot),
          JSON.stringify(full.results),
          full.passCount,
          full.failCount,
          full.judgeModelId ?? null,
          full.configRef ?? null,
          full.metrics ? JSON.stringify(full.metrics) : null,
          full.createdAt,
        ],
      });
      return full;
    },

    async getRun(owner, id) {
      const res = await client.execute({
        sql: `SELECT * FROM latch_eval_runs WHERE owner = ? AND id = ?`,
        args: [owner, id],
      });
      const r = res.rows[0] as Record<string, unknown> | undefined;
      return r ? rowToRun(r) : null;
    },

    async costOfThreads(threadIds) {
      const zero = { cost: 0, tokensIn: 0, tokensOut: 0 };
      // `IN ()` is a syntax error in SQLite, so an empty list short-circuits.
      if (threadIds.length === 0) return zero;
      const res = await client.execute({
        sql: `SELECT cost_total, usage_input_tokens, usage_output_tokens FROM latch_runs
              WHERE chat_id IN (${threadIds.map(() => "?").join(",")})`,
        args: threadIds,
      });
      for (const row of res.rows as unknown as Record<string, unknown>[]) {
        zero.cost += Number(row.cost_total ?? 0);
        zero.tokensIn += Number(row.usage_input_tokens ?? 0);
        zero.tokensOut += Number(row.usage_output_tokens ?? 0);
      }
      return zero;
    },

    async correctCheck(owner, runId, caseId, checkId, failed, by) {
      const res = await client.execute({
        sql: `SELECT * FROM latch_eval_runs WHERE owner = ? AND id = ?`,
        args: [owner, runId],
      });
      const row = res.rows[0] as Record<string, unknown> | undefined;
      if (!row) return null;
      const run = rowToRun(row);

      let touched = false;
      const results = run.results.map((r) => {
        if (r.caseId !== caseId) return r;
        const checks = (r.checks ?? []).map((c) => {
          if (c.id !== checkId) return c;
          touched = true;
          // The judge's own fields are left exactly as they were: the PAIR is
          // the evidence, not the human answer on its own.
          return { ...c, human: { failed, at: Date.now(), ...(by ? { by } : {}) } };
        });
        return { ...r, checks };
      });
      if (!touched) return run;

      await client.execute({
        sql: `UPDATE latch_eval_runs SET results = ? WHERE owner = ? AND id = ?`,
        args: [JSON.stringify(results), owner, runId],
      });
      return { ...run, results };
    },

    async listRuns(owner, agentName, setName, limit) {
      const res = await client.execute(
        setName
          ? {
              sql: `SELECT * FROM latch_eval_runs WHERE owner = ? AND agent_name = ? AND set_name = ?
                    ORDER BY created_at DESC LIMIT ?`,
              args: [owner, agentName, setName, limit ?? 20],
            }
          : {
              sql: `SELECT * FROM latch_eval_runs WHERE owner = ? AND agent_name = ?
                    ORDER BY created_at DESC LIMIT ?`,
              args: [owner, agentName, limit ?? 20],
            },
      );
      return (res.rows as unknown as Record<string, unknown>[]).map(rowToRun);
    },
  };
}
