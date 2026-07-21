import type { Client } from "@libsql/client";

/**
 * Evals: named sets of test cases for an agent, plus the persisted results of
 * running them. A case sends one user message to the agent (isolated, safe-mode
 * run) and grades the outcome with deterministic checks — answer assertions
 * and tool-call expectations. Owner-scoped (per org+user) like agents/tools.
 *
 * A run pins `agentSnapshot` (the agent's config at run time), so run-over-run
 * comparisons stay honest even though `latch_agents` upserts in place.
 */

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
  /** Subset of the call's arguments that must match exactly (deep-equal per key). */
  args?: Record<string, unknown>;
}

export interface EvalExpectation {
  assertions?: EvalAssertions;
  toolCalls?: EvalToolExpectation[];
  /** Tools the agent must NOT have called. */
  forbiddenTools?: string[];
}

export interface EvalCase {
  /** Stable id — keep it constant across saves so run history stays comparable. */
  id: string;
  /** Short human label ("refund question escalates"). */
  name: string;
  /** The user message sent to the agent. */
  input: string;
  expected: EvalExpectation;
}

export interface EvalSet {
  owner: string;
  agentName: string;
  name: string;
  cases: EvalCase[];
  createdAt: number;
  updatedAt: number;
}

/** One tool invocation observed in a case's transcript. */
export interface EvalToolCall {
  tool: string;
  args?: unknown;
  /** True when safe mode stubbed this approval-gated tool. */
  blocked?: boolean;
}

export interface EvalCaseResult {
  caseId: string;
  caseName: string;
  pass: boolean;
  /** Failure reasons (empty when passing). */
  reasons: string[];
  /** The isolated sub-thread holding the full transcript. */
  threadId?: string;
  answerPreview: string;
  toolCalls: EvalToolCall[];
  /** Set when the run itself errored (agent crash, not a failed grade). */
  error?: string;
}

export interface EvalRun {
  id: string;
  owner: string;
  agentName: string;
  setName: string;
  /** The agent's stored config at run time (null for code-declared agents). */
  agentSnapshot: unknown | null;
  results: EvalCaseResult[];
  passCount: number;
  failCount: number;
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
  total: number;
  completed: number;
  /** Graded cases so far, in completion order. */
  results: CompactCaseResult[];
}

export interface EvalStore {
  saveSet: (rec: Omit<EvalSet, "createdAt" | "updatedAt">) => Promise<void>;
  getSet: (owner: string, agentName: string, name: string) => Promise<EvalSet | null>;
  listSets: (owner: string, agentName?: string) => Promise<EvalSet[]>;
  deleteSet: (owner: string, agentName: string, name: string) => Promise<void>;
  saveRun: (run: Omit<EvalRun, "id" | "createdAt">) => Promise<EvalRun>;
  listRuns: (owner: string, agentName: string, setName?: string, limit?: number) => Promise<EvalRun[]>;
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
  await client.execute(`CREATE TABLE IF NOT EXISTS latch_eval_runs (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    set_name TEXT NOT NULL,
    agent_snapshot TEXT,
    results TEXT NOT NULL,
    pass_count INTEGER NOT NULL,
    fail_count INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`);
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
  agentSnapshot: safeParse<unknown | null>(r.agent_snapshot, null),
  results: (() => {
    const v = safeParse<unknown>(r.results, []);
    return Array.isArray(v) ? (v as EvalCaseResult[]) : [];
  })(),
  passCount: Number(r.pass_count),
  failCount: Number(r.fail_count),
  createdAt: Number(r.created_at),
});

const newRunId = () => `evr_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

export function createEvalStore(client: Client): EvalStore {
  return {
    async saveSet(rec) {
      const now = Date.now();
      await client.execute({
        sql: `INSERT INTO latch_eval_sets (owner, agent_name, name, cases, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(owner, agent_name, name) DO UPDATE SET
                cases = excluded.cases,
                updated_at = excluded.updated_at`,
        args: [rec.owner, rec.agentName, rec.name, JSON.stringify(rec.cases), now, now],
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
        sql: `INSERT INTO latch_eval_runs (id, owner, agent_name, set_name, agent_snapshot, results, pass_count, fail_count, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          full.id,
          full.owner,
          full.agentName,
          full.setName,
          full.agentSnapshot == null ? null : JSON.stringify(full.agentSnapshot),
          JSON.stringify(full.results),
          full.passCount,
          full.failCount,
          full.createdAt,
        ],
      });
      return full;
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
