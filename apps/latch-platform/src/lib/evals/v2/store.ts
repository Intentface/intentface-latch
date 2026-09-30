import type { Client } from "@libsql/client";
import type { Check, Dataset, Input, Owner, Rubric, Ruling, ThreadRef, Verdict, InputFile, View } from "./model";
import type { EvalJob } from "./jobs";
import type { FailureMode, Note, Suggestion } from "./failures";

/**
 * Storage for evals v2.
 *
 * Threads are never copied — `latch_eval_threads` annotates `latch_chats`
 * with why the thread matters to evals and which configuration produced it.
 * Verdicts key on the rubric version, so re-judging appends: rewording a
 * check no longer destroys the numbers it replaced, and rubric versions can
 * be compared the way agent versions are.
 */

export interface EvalsStore {
  saveDataset: (d: Omit<Dataset, "createdAt" | "updatedAt">) => Promise<void>;
  getDataset: (owner: Owner, id: string) => Promise<Dataset | null>;
  listDatasets: (owner: Owner, agentName?: string) => Promise<Dataset[]>;
  deleteDataset: (owner: Owner, id: string) => Promise<void>;

  /** Replace a dataset's inputs wholesale — the editor saves the list. */
  // Inputs, members and views are always read and written under their set's
  // owner: a set id from another owner finds nothing, whoever forgot a check.
  setInputs: (owner: Owner, datasetId: string, inputs: Input[]) => Promise<void>;
  listInputs: (owner: Owner, datasetId: string) => Promise<Input[]>;
  /** For a thread dataset: the threads it holds. */
  setMembers: (owner: Owner, datasetId: string, threadIds: string[]) => Promise<void>;
  listMembers: (owner: Owner, datasetId: string) => Promise<string[]>;

  /** Append a new rubric version; returns it. */
  saveRubric: (r: { owner: Owner; id: string; agentName: string; defaultJudge: string; checks: Check[] }) => Promise<Rubric>;
  getRubric: (owner: Owner, id: string, version?: number) => Promise<Rubric | null>;
  listRubrics: (owner: Owner, agentName: string) => Promise<Rubric[]>;

  saveThread: (t: ThreadRef) => Promise<void>;
  getThread: (owner: Owner, threadId: string) => Promise<ThreadRef | null>;
  listThreads: (owner: Owner, q: { agentName?: string; datasetId?: string; runId?: string; limit?: number }) => Promise<ThreadRef[]>;
  /** The most recent run of a dataset — what `judge` reads by default. */
  latestRunId: (owner: Owner, datasetId: string) => Promise<string | null>;
  /** Runs of a dataset, newest first — what the results view offers to pick from. */
  listRuns: (
    owner: Owner,
    datasetId: string,
  ) => Promise<{ runId: string; threads: number; versions: string[]; questions: number; tries: number; name: string | null; createdAt: number }[]>;

  saveVerdicts: (vs: Verdict[]) => Promise<void>;
  deleteVerdicts: (threadIds: string[], rubricVersion: number) => Promise<void>;
  /** Latest verdict per (thread, check) for one rubric version. */
  listVerdicts: (q: { threadIds: string[]; rubricVersion?: number }) => Promise<Verdict[]>;

  saveJob: (j: EvalJob) => Promise<void>;
  getJob: (owner: Owner, id: string) => Promise<EvalJob | null>;
  listJobs: (owner: Owner, datasetId: string, limit?: number) => Promise<EvalJob[]>;
  /** Merge a patch into a job; a cancelled job is never un-cancelled. Returns it as stored. */
  updateJob: (id: string, patch: Partial<EvalJob>) => Promise<EvalJob | null>;
  /** Take the lease if nobody holds it; true when this caller now does. */
  claimJob: (id: string, now: number, leaseMs: number) => Promise<boolean>;
  /** Unfinished jobs whose lease has lapsed — what the cron picks up. */
  claimableJobs: (now: number) => Promise<{ owner: Owner; id: string }[]>;
  /** What each thread cost, summed over its runs — what an estimate is made from. */
  threadCosts: (threadIds: string[]) => Promise<Map<string, number>>;

  saveNote: (n: Note) => Promise<void>;
  deleteNote: (owner: Owner, threadId: string) => Promise<void>;
  listNotes: (owner: Owner, agentName: string) => Promise<Note[]>;
  /** Replace an agent's failure modes and which note belongs to which. */
  setModes: (owner: Owner, agentName: string, modes: FailureMode[], assign: Map<string, string>) => Promise<void>;
  listModes: (owner: Owner, agentName: string) => Promise<FailureMode[]>;
  updateMode: (owner: Owner, id: string, patch: { name?: string; description?: string }) => Promise<void>;
  /** Record what to do about a failure mode. A person's decision is never overwritten by the agent's. */
  decideMode: (owner: Owner, id: string, d: { decision: "fix" | "measure" | "leave"; why: string; by: "agent" | "person" }) => Promise<boolean>;

  saveSuggestion: (s: Suggestion) => Promise<void>;
  listSuggestions: (owner: Owner, agentName: string, status?: Suggestion["status"]) => Promise<Suggestion[]>;
  setSuggestionStatus: (owner: Owner, threadId: string, status: Suggestion["status"]) => Promise<void>;
  /** The evals agent's proposed pattern for each reading; null leaves one out. */
  setSuggestionGroups: (owner: Owner, groups: { threadId: string; group: { name: string; description: string } | null }[]) => Promise<void>;
  /** Add one failure mode, leaving the others alone; nothing if the id exists. */
  addMode: (m: FailureMode) => Promise<void>;

  saveRuling: (r: Ruling) => Promise<void>;
  /** Take a ruling back — a misclick must not stay in the alignment numbers. */
  deleteRuling: (threadId: string, checkId: string) => Promise<void>;
  /** A set's saved views, oldest first — the order of the tabs. */
  listViews: (owner: Owner, datasetId: string) => Promise<View[]>;
  saveView: (owner: Owner, v: View) => Promise<void>;
  removeView: (owner: Owner, datasetId: string, id: string) => Promise<void>;
  listRulings: (q: { threadIds?: string[]; checkIds?: string[] }) => Promise<Ruling[]>;
}

export async function migrateEvalsV2(client: Client): Promise<void> {
  const ddl = [
    `CREATE TABLE IF NOT EXISTS latch_eval_datasets (
      owner TEXT NOT NULL, id TEXT NOT NULL, agent_name TEXT NOT NULL, name TEXT NOT NULL,
      kind TEXT NOT NULL, audience TEXT, note TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (owner, id))`,
    INPUTS_DDL,
    MEMBERS_DDL,
    `CREATE TABLE IF NOT EXISTS latch_eval_rubrics (
      owner TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, agent_name TEXT NOT NULL,
      default_judge TEXT NOT NULL, checks TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (owner, id, version))`,
    `CREATE TABLE IF NOT EXISTS latch_eval_threads (
      owner TEXT NOT NULL, thread_id TEXT NOT NULL, agent_name TEXT NOT NULL,
      dataset_id TEXT, input_id TEXT, run_id TEXT, attempt INTEGER,
      version TEXT NOT NULL, config_fingerprint TEXT NOT NULL,
      origin TEXT NOT NULL, answer TEXT NOT NULL, error TEXT, duration_ms INTEGER,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (owner, thread_id))`,
    `CREATE INDEX IF NOT EXISTS latch_eval_threads_dataset ON latch_eval_threads (dataset_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS latch_eval_threads_agent ON latch_eval_threads (owner, agent_name, created_at)`,
    `CREATE TABLE IF NOT EXISTS latch_eval_verdicts (
      thread_id TEXT NOT NULL, check_id TEXT NOT NULL, rubric_version INTEGER NOT NULL,
      judge_id TEXT NOT NULL, answer TEXT NOT NULL, confidence REAL, score REAL,
      failed INTEGER NOT NULL, escalated_to TEXT, created_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS latch_eval_verdicts_thread ON latch_eval_verdicts (thread_id, rubric_version, check_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS latch_eval_jobs (
      owner TEXT NOT NULL, id TEXT NOT NULL PRIMARY KEY, dataset_id TEXT NOT NULL,
      status TEXT NOT NULL, lease_until INTEGER NOT NULL, data TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS latch_eval_jobs_dataset ON latch_eval_jobs (owner, dataset_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS latch_eval_jobs_open ON latch_eval_jobs (status, lease_until)`,
    `CREATE TABLE IF NOT EXISTS latch_eval_notes (
      owner TEXT NOT NULL, thread_id TEXT NOT NULL PRIMARY KEY, agent_name TEXT NOT NULL, dataset_id TEXT,
      text TEXT NOT NULL, ok INTEGER NOT NULL, mode_id TEXT, by TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS latch_eval_notes_agent ON latch_eval_notes (owner, agent_name)`,
    `CREATE TABLE IF NOT EXISTS latch_eval_modes (
      owner TEXT NOT NULL, agent_name TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
      description TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (owner, id))`,
    `CREATE TABLE IF NOT EXISTS latch_eval_suggestions (
      owner TEXT NOT NULL, thread_id TEXT NOT NULL PRIMARY KEY, agent_name TEXT NOT NULL,
      text TEXT NOT NULL, ok INTEGER NOT NULL, why TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS latch_eval_suggestions_agent ON latch_eval_suggestions (owner, agent_name, status)`,
    VIEWS_DDL,
    `CREATE TABLE IF NOT EXISTS latch_eval_rulings (
      thread_id TEXT NOT NULL, check_id TEXT NOT NULL, failed INTEGER NOT NULL,
      by TEXT, created_at INTEGER NOT NULL,
      PRIMARY KEY (thread_id, check_id))`,
  ];
  for (const sql of ddl) await client.execute(sql);
  // Tables created before repeats existed; ADD COLUMN fails once present.
  for (const col of ["decision TEXT", "decision_why TEXT", "decided_by TEXT"])
    await client.execute(`ALTER TABLE latch_eval_modes ADD COLUMN ${col}`).catch(() => {});
  for (const col of ["group_name TEXT", "group_description TEXT"])
    await client.execute(`ALTER TABLE latch_eval_suggestions ADD COLUMN ${col}`).catch(() => {});
  // (Before owner scoping, which rebuilds the table with them.)
  await client.execute(`ALTER TABLE latch_eval_inputs ADD COLUMN files TEXT`).catch(() => {});
  await client.execute(`ALTER TABLE latch_eval_inputs ADD COLUMN tags TEXT`).catch(() => {});
  await client.execute(`ALTER TABLE latch_eval_verdicts ADD COLUMN probabilities TEXT`).catch(() => {});
  for (const col of ["run_id TEXT", "attempt INTEGER"])
    await client.execute(`ALTER TABLE latch_eval_threads ADD COLUMN ${col}`).catch(() => {});
  await client.execute(`CREATE INDEX IF NOT EXISTS latch_eval_threads_run ON latch_eval_threads (run_id)`);
  // Tables from before they were owner-scoped: rebuild once, each row taking
  // its set's owner.
  await ownerScope(client, "latch_eval_inputs", INPUTS_DDL, "dataset_id, id, position, prompt, follow_ups, facts, files, tags");
  await ownerScope(client, "latch_eval_members", MEMBERS_DDL, "dataset_id, thread_id");
  await ownerScope(client, "latch_eval_views", VIEWS_DDL, "dataset_id, id, name, tags, created_at");
}

const INPUTS_DDL = `CREATE TABLE IF NOT EXISTS latch_eval_inputs (
      owner TEXT NOT NULL, dataset_id TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL,
      prompt TEXT NOT NULL, follow_ups TEXT, facts TEXT, files TEXT, tags TEXT,
      PRIMARY KEY (owner, dataset_id, id))`;
const MEMBERS_DDL = `CREATE TABLE IF NOT EXISTS latch_eval_members (
      owner TEXT NOT NULL, dataset_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      PRIMARY KEY (owner, dataset_id, thread_id))`;
const VIEWS_DDL = `CREATE TABLE IF NOT EXISTS latch_eval_views (
      owner TEXT NOT NULL, dataset_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, tags TEXT NOT NULL,
      created_at INTEGER NOT NULL, PRIMARY KEY (owner, dataset_id, id))`;

async function ownerScope(client: Client, table: string, ddl: string, cols: string) {
  const info = await client.execute(`PRAGMA table_info(${table})`);
  if (info.rows.some((r) => r.name === "owner")) return;
  const old = `${table}_unscoped`;
  await client.batch(
    [
      `ALTER TABLE ${table} RENAME TO ${old}`,
      ddl,
      `INSERT OR IGNORE INTO ${table} (owner, ${cols}) SELECT d.owner, ${cols.split(", ").map((c) => `o.${c}`).join(", ")} FROM ${old} o JOIN latch_eval_datasets d ON d.id = o.dataset_id`,
      `DROP TABLE ${old}`,
    ],
    "write",
  );
}

const parse = <T>(v: unknown, fallback: T): T => {
  if (v == null) return fallback;
  try {
    return JSON.parse(String(v)) as T;
  } catch {
    return fallback;
  }
};
const str = (v: unknown) => (v == null ? undefined : String(v));
const num = (v: unknown) => (v == null ? undefined : Number(v));
type Row = Record<string, unknown>;

const toDataset = (r: Row): Dataset => ({
  owner: String(r.owner),
  id: String(r.id),
  agentName: String(r.agent_name),
  name: String(r.name),
  kind: r.kind === "threads" ? "threads" : "inputs",
  ...(r.audience ? { audience: String(r.audience) } : {}),
  ...(r.note ? { note: String(r.note) } : {}),
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

const toRubric = (r: Row): Rubric => ({
  owner: String(r.owner),
  id: String(r.id),
  agentName: String(r.agent_name),
  version: Number(r.version),
  defaultJudge: String(r.default_judge),
  checks: parse<Check[]>(r.checks, []),
  createdAt: Number(r.created_at),
});

const toThread = (r: Row): ThreadRef => ({
  owner: String(r.owner),
  threadId: String(r.thread_id),
  agentName: String(r.agent_name),
  ...(r.dataset_id ? { datasetId: String(r.dataset_id) } : {}),
  ...(r.input_id ? { inputId: String(r.input_id) } : {}),
  ...(r.run_id ? { runId: String(r.run_id) } : {}),
  ...(r.attempt != null ? { attempt: Number(r.attempt) } : {}),
  version: String(r.version),
  configFingerprint: String(r.config_fingerprint),
  origin: r.origin === "production" ? "production" : "run",
  answer: String(r.answer),
  ...(r.error ? { error: String(r.error) } : {}),
  ...(r.duration_ms != null ? { durationMs: Number(r.duration_ms) } : {}),
  createdAt: Number(r.created_at),
});

const toVerdict = (r: Row): Verdict => ({
  threadId: String(r.thread_id),
  checkId: String(r.check_id),
  rubricVersion: Number(r.rubric_version),
  judgeId: String(r.judge_id),
  answer: String(r.answer),
  ...(r.confidence != null ? { confidence: Number(r.confidence) } : {}),
  ...(r.score != null ? { score: Number(r.score) } : {}),
  ...(r.probabilities ? { probabilities: JSON.parse(String(r.probabilities)) as Record<string, number> } : {}),
  failed: Number(r.failed) === 1,
  ...(r.escalated_to ? { escalatedTo: String(r.escalated_to) } : {}),
  createdAt: Number(r.created_at),
});

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(",");

export function createEvalsStore(client: Client): EvalsStore {
  const rows = async (sql: string, args: unknown[] = []) =>
    (await client.execute({ sql, args: args as never })).rows as unknown as Row[];

  return {
    async saveDataset(d) {
      const now = Date.now();
      await client.execute({
        sql: `INSERT INTO latch_eval_datasets (owner, id, agent_name, name, kind, audience, note, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(owner, id) DO UPDATE SET name = excluded.name, audience = excluded.audience,
                note = excluded.note, updated_at = excluded.updated_at`,
        args: [d.owner, d.id, d.agentName, d.name, d.kind, d.audience ?? null, d.note ?? null, now, now],
      });
    },
    async getDataset(owner, id) {
      const [r] = await rows(`SELECT * FROM latch_eval_datasets WHERE owner = ? AND id = ?`, [owner, id]);
      return r ? toDataset(r) : null;
    },
    async listDatasets(owner, agentName) {
      return (
        agentName
          ? await rows(`SELECT * FROM latch_eval_datasets WHERE owner = ? AND agent_name = ? ORDER BY name`, [owner, agentName])
          : await rows(`SELECT * FROM latch_eval_datasets WHERE owner = ? ORDER BY agent_name, name`, [owner])
      ).map(toDataset);
    },
    async deleteDataset(owner, id) {
      await client.batch(
        [
          { sql: `DELETE FROM latch_eval_inputs WHERE dataset_id = ?`, args: [id] },
          { sql: `DELETE FROM latch_eval_members WHERE dataset_id = ?`, args: [id] },
          { sql: `DELETE FROM latch_eval_datasets WHERE owner = ? AND id = ?`, args: [owner, id] },
        ],
        "write",
      );
    },

    async setInputs(owner, datasetId, inputs) {
      const seen = new Set<string>();
      for (const i of inputs) {
        // A duplicate id collapses two inputs into one across runs, and a
        // regression on the second disappears rather than reporting.
        if (seen.has(i.id)) throw new Error(`duplicate input id "${i.id}"`);
        seen.add(i.id);
      }
      await client.batch(
        [
          { sql: `DELETE FROM latch_eval_inputs WHERE owner = ? AND dataset_id = ?`, args: [owner, datasetId] },
          ...inputs.map((i, position) => ({
            sql: `INSERT INTO latch_eval_inputs (owner, dataset_id, id, position, prompt, follow_ups, facts, files, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
              owner,
              datasetId,
              i.id,
              position,
              i.prompt,
              i.followUps?.length ? JSON.stringify(i.followUps) : null,
              i.facts && Object.keys(i.facts).length ? JSON.stringify(i.facts) : null,
              i.files?.length ? JSON.stringify(i.files) : null,
              i.tags?.length ? JSON.stringify(i.tags) : null,
            ],
          })),
        ],
        "write",
      );
    },
    async listInputs(owner, datasetId) {
      return (await rows(`SELECT * FROM latch_eval_inputs WHERE owner = ? AND dataset_id = ? ORDER BY position`, [owner, datasetId])).map(
        (r): Input => ({
          id: String(r.id),
          prompt: String(r.prompt),
          ...(r.follow_ups ? { followUps: parse<string[]>(r.follow_ups, []) } : {}),
          ...(r.facts ? { facts: parse(r.facts, {}) } : {}),
          ...(r.files ? { files: parse<InputFile[]>(r.files, []) } : {}),
          ...(r.tags ? { tags: parse<string[]>(r.tags, []) } : {}),
        }),
      );
    },
    async setMembers(owner, datasetId, threadIds) {
      await client.batch(
        [
          { sql: `DELETE FROM latch_eval_members WHERE owner = ? AND dataset_id = ?`, args: [owner, datasetId] },
          ...[...new Set(threadIds)].map((t) => ({
            sql: `INSERT INTO latch_eval_members (owner, dataset_id, thread_id) VALUES (?, ?, ?)`,
            args: [owner, datasetId, t],
          })),
        ],
        "write",
      );
    },
    async listMembers(owner, datasetId) {
      return (await rows(`SELECT thread_id FROM latch_eval_members WHERE owner = ? AND dataset_id = ?`, [owner, datasetId])).map((r) =>
        String(r.thread_id),
      );
    },

    async saveRubric(r) {
      const [top] = await rows(`SELECT MAX(version) AS v FROM latch_eval_rubrics WHERE owner = ? AND id = ?`, [r.owner, r.id]);
      const version = (num(top?.v) ?? 0) + 1;
      const createdAt = Date.now();
      await client.execute({
        sql: `INSERT INTO latch_eval_rubrics (owner, id, version, agent_name, default_judge, checks, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [r.owner, r.id, version, r.agentName, r.defaultJudge, JSON.stringify(r.checks), createdAt],
      });
      return { ...r, version, createdAt };
    },
    async getRubric(owner, id, version) {
      const [r] =
        version === undefined
          ? await rows(`SELECT * FROM latch_eval_rubrics WHERE owner = ? AND id = ? ORDER BY version DESC LIMIT 1`, [owner, id])
          : await rows(`SELECT * FROM latch_eval_rubrics WHERE owner = ? AND id = ? AND version = ?`, [owner, id, version]);
      return r ? toRubric(r) : null;
    },
    async listRubrics(owner, agentName) {
      // Latest version of each rubric for the agent.
      return (
        await rows(
          `SELECT r.* FROM latch_eval_rubrics r
             JOIN (SELECT id, MAX(version) AS v FROM latch_eval_rubrics WHERE owner = ? AND agent_name = ? GROUP BY id) m
               ON r.id = m.id AND r.version = m.v
            WHERE r.owner = ? ORDER BY r.id`,
          [owner, agentName, owner],
        )
      ).map(toRubric);
    },

    async saveThread(t) {
      await client.execute({
        sql: `INSERT INTO latch_eval_threads (owner, thread_id, agent_name, dataset_id, input_id, run_id, attempt,
                version, config_fingerprint, origin, answer, error, duration_ms, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(owner, thread_id) DO UPDATE SET dataset_id = excluded.dataset_id,
                input_id = excluded.input_id, answer = excluded.answer, error = excluded.error`,
        args: [
          t.owner,
          t.threadId,
          t.agentName,
          t.datasetId ?? null,
          t.inputId ?? null,
          t.runId ?? null,
          t.attempt ?? null,
          t.version,
          t.configFingerprint,
          t.origin,
          t.answer,
          t.error ?? null,
          t.durationMs ?? null,
          t.createdAt,
        ],
      });
    },
    async getThread(owner, threadId) {
      const [r] = await rows(`SELECT * FROM latch_eval_threads WHERE owner = ? AND thread_id = ?`, [owner, threadId]);
      return r ? toThread(r) : null;
    },
    async listThreads(owner, q) {
      const where = ["owner = ?"];
      const args: unknown[] = [owner];
      if (q.agentName) (where.push("agent_name = ?"), args.push(q.agentName));
      if (q.datasetId) (where.push("dataset_id = ?"), args.push(q.datasetId));
      if (q.runId) (where.push("run_id = ?"), args.push(q.runId));
      args.push(q.limit ?? 5000);
      return (
        await rows(`SELECT * FROM latch_eval_threads WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`, args)
      ).map(toThread);
    },

    async latestRunId(owner, datasetId) {
      const [r] = await rows(
        `SELECT run_id FROM latch_eval_threads WHERE owner = ? AND dataset_id = ? AND run_id IS NOT NULL
          ORDER BY created_at DESC LIMIT 1`,
        [owner, datasetId],
      );
      return r ? String(r.run_id) : null;
    },

    async listRuns(owner, datasetId) {
      const rs = await rows(
        `SELECT t.run_id, COUNT(*) AS n, GROUP_CONCAT(DISTINCT t.version) AS versions,
                COUNT(DISTINCT t.input_id) AS questions, MAX(COALESCE(t.attempt, 0)) + 1 AS tries,
                MIN(t.created_at) AS at, json_extract(MAX(j.data), '$.name') AS name
           FROM latch_eval_threads t LEFT JOIN latch_eval_jobs j ON j.id = t.run_id
          WHERE t.owner = ? AND t.dataset_id = ? AND t.run_id IS NOT NULL
          GROUP BY t.run_id ORDER BY at DESC LIMIT 50`,
        [owner, datasetId],
      );
      return rs.map((r) => ({
        runId: String(r.run_id),
        threads: Number(r.n),
        versions: String(r.versions ?? "").split(",").filter(Boolean),
        questions: Number(r.questions),
        tries: Number(r.tries),
        name: str(r.name) ?? null,
        createdAt: Number(r.at),
      }));
    },

    async deleteVerdicts(threadIds, rubricVersion) {
      if (!threadIds.length) return;
      await client.batch(
        threadIds.map((id) => ({ sql: `DELETE FROM latch_eval_verdicts WHERE thread_id = ? AND rubric_version = ?`, args: [id, rubricVersion] })),
        "write",
      );
    },
    async saveVerdicts(vs) {
      if (!vs.length) return;
      await client.batch(
        vs.map((v) => ({
          sql: `INSERT INTO latch_eval_verdicts (thread_id, check_id, rubric_version, judge_id, answer,
                  confidence, score, probabilities, failed, escalated_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            v.threadId,
            v.checkId,
            v.rubricVersion,
            v.judgeId,
            v.answer,
            v.confidence ?? null,
            v.score ?? null,
            v.probabilities ? JSON.stringify(v.probabilities) : null,
            v.failed ? 1 : 0,
            v.escalatedTo ?? null,
            v.createdAt,
          ],
        })),
        "write",
      );
    },
    async listVerdicts(q) {
      if (!q.threadIds.length) return [];
      const args: unknown[] = [...q.threadIds];
      let where = `thread_id IN (${placeholders(q.threadIds.length)})`;
      if (q.rubricVersion !== undefined) (where += ` AND rubric_version = ?`, args.push(q.rubricVersion));
      const all = (await rows(`SELECT * FROM latch_eval_verdicts WHERE ${where} ORDER BY created_at`, args)).map(toVerdict);
      // Re-judging appends; the report reads the latest per (thread, check, version).
      const latest = new Map<string, Verdict>();
      for (const v of all) latest.set(`${v.threadId}|${v.checkId}|${v.rubricVersion}`, v);
      return [...latest.values()];
    },

    async saveRuling(r) {
      await client.execute({
        sql: `INSERT INTO latch_eval_rulings (thread_id, check_id, failed, by, created_at) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(thread_id, check_id) DO UPDATE SET failed = excluded.failed, by = excluded.by,
                created_at = excluded.created_at`,
        args: [r.threadId, r.checkId, r.failed ? 1 : 0, r.by ?? null, r.createdAt],
      });
    },
    async saveJob(j) {
      await client.execute({
        sql: `INSERT INTO latch_eval_jobs (owner, id, dataset_id, status, lease_until, data, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [j.owner, j.id, j.datasetId, j.status, j.leaseUntil, JSON.stringify(j), j.createdAt, j.updatedAt],
      });
    },
    async getJob(owner, id) {
      const [r] = await rows(`SELECT data FROM latch_eval_jobs WHERE owner = ? AND id = ?`, [owner, id]);
      return r ? (JSON.parse(String(r.data)) as EvalJob) : null;
    },
    async listJobs(owner, datasetId, limit = 20) {
      return (
        await rows(`SELECT data FROM latch_eval_jobs WHERE owner = ? AND dataset_id = ? ORDER BY created_at DESC LIMIT ?`, [
          owner,
          datasetId,
          limit,
        ])
      ).map((r) => JSON.parse(String(r.data)) as EvalJob);
    },
    async updateJob(id, patch) {
      // One statement, so two holders never lose each other's writes, and a
      // cancel is final: SET reads the row's OLD status, which wins if cancelled.
      const status = `CASE WHEN status = 'cancelled' THEN 'cancelled' ELSE COALESCE(json_extract(?1, '$.status'), status) END`;
      await client.execute({
        sql: `UPDATE latch_eval_jobs SET
                status = ${status},
                lease_until = COALESCE(json_extract(?1, '$.leaseUntil'), lease_until),
                updated_at = COALESCE(json_extract(?1, '$.updatedAt'), updated_at),
                data = json_set(json_patch(data, ?1), '$.status', ${status})
              WHERE id = ?2`,
        args: [JSON.stringify(patch), id],
      });
      const [r] = await rows(`SELECT data FROM latch_eval_jobs WHERE id = ?`, [id]);
      return r ? (JSON.parse(String(r.data)) as EvalJob) : null;
    },
    async claimJob(id, now, leaseMs) {
      const until = now + leaseMs;
      const r = await client.execute({
        sql: `UPDATE latch_eval_jobs SET lease_until = ?1, data = json_set(data, '$.leaseUntil', ?1)
              WHERE id = ?2 AND status IN ('running', 'judging') AND lease_until < ?3`,
        args: [until, id, now],
      });
      return r.rowsAffected === 1;
    },
    async claimableJobs(now) {
      return (
        await rows(`SELECT owner, id FROM latch_eval_jobs WHERE status IN ('running', 'judging') AND lease_until < ? LIMIT 5`, [now])
      ).map((r) => ({ owner: String(r.owner), id: String(r.id) }));
    },
    async threadCosts(threadIds) {
      const out = new Map<string, number>();
      for (let i = 0; i < threadIds.length; i += 500) {
        const ids = threadIds.slice(i, i + 500);
        for (const r of await rows(
          `SELECT chat_id, SUM(COALESCE(cost_total, 0)) AS c FROM latch_runs WHERE chat_id IN (${placeholders(ids.length)}) GROUP BY chat_id`,
          ids,
        ))
          out.set(String(r.chat_id), Number(r.c));
      }
      return out;
    },

    async saveNote(n) {
      await client.execute({
        sql: `INSERT INTO latch_eval_notes (owner, thread_id, agent_name, dataset_id, text, ok, mode_id, by, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(thread_id) DO UPDATE SET text = excluded.text, ok = excluded.ok, by = excluded.by,
                updated_at = excluded.updated_at,
                -- A rewritten note may no longer fit its mode; the next grouping decides.
                mode_id = CASE WHEN latch_eval_notes.text = excluded.text THEN latch_eval_notes.mode_id ELSE NULL END`,
        args: [n.owner, n.threadId, n.agentName, n.datasetId ?? null, n.text, n.ok ? 1 : 0, n.modeId ?? null, n.by ?? null, n.createdAt, n.updatedAt],
      });
    },
    async deleteNote(owner, threadId) {
      await client.execute({ sql: `DELETE FROM latch_eval_notes WHERE owner = ? AND thread_id = ?`, args: [owner, threadId] });
    },
    async listNotes(owner, agentName) {
      return (await rows(`SELECT * FROM latch_eval_notes WHERE owner = ? AND agent_name = ? ORDER BY updated_at DESC`, [owner, agentName])).map(
        (r) => ({
          owner: String(r.owner),
          threadId: String(r.thread_id),
          agentName: String(r.agent_name),
          ...(str(r.dataset_id) ? { datasetId: str(r.dataset_id) } : {}),
          text: String(r.text),
          ok: Number(r.ok) === 1,
          ...(str(r.mode_id) ? { modeId: str(r.mode_id) } : {}),
          ...(str(r.by) ? { by: str(r.by) } : {}),
          createdAt: Number(r.created_at),
          updatedAt: Number(r.updated_at),
        }),
      );
    },
    async setModes(owner, agentName, modes, assign) {
      await client.batch(
        [
          { sql: `DELETE FROM latch_eval_modes WHERE owner = ? AND agent_name = ?`, args: [owner, agentName] },
          { sql: `UPDATE latch_eval_notes SET mode_id = NULL WHERE owner = ? AND agent_name = ?`, args: [owner, agentName] },
          ...modes.map((m) => ({
            sql: `INSERT INTO latch_eval_modes (owner, agent_name, id, name, description, created_at, decision, decision_why, decided_by)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [owner, agentName, m.id, m.name, m.description, m.createdAt, m.decision ?? null, m.decisionWhy ?? null, m.decidedBy ?? null],
          })),
          ...[...assign].map(([threadId, modeId]) => ({
            sql: `UPDATE latch_eval_notes SET mode_id = ? WHERE owner = ? AND thread_id = ?`,
            args: [modeId, owner, threadId],
          })),
        ],
        "write",
      );
    },
    async listModes(owner, agentName) {
      return (await rows(`SELECT * FROM latch_eval_modes WHERE owner = ? AND agent_name = ? ORDER BY created_at`, [owner, agentName])).map((r) => ({
        owner: String(r.owner),
        agentName: String(r.agent_name),
        id: String(r.id),
        name: String(r.name),
        description: String(r.description),
        ...(str(r.decision) ? { decision: str(r.decision) as "fix" | "measure" | "leave" } : {}),
        ...(str(r.decision_why) ? { decisionWhy: str(r.decision_why) } : {}),
        ...(str(r.decided_by) ? { decidedBy: str(r.decided_by) as "agent" | "person" } : {}),
        createdAt: Number(r.created_at),
      }));
    },
    async decideMode(owner, id, d) {
      const r = await client.execute({
        sql: `UPDATE latch_eval_modes SET decision = ?, decision_why = ?, decided_by = ?
              WHERE owner = ? AND id = ? AND NOT (? = 'agent' AND decided_by = 'person')`,
        args: [d.decision, d.why, d.by, owner, id, d.by],
      });
      return r.rowsAffected === 1;
    },
    async updateMode(owner, id, patch) {
      await client.execute({
        sql: `UPDATE latch_eval_modes SET name = COALESCE(?, name), description = COALESCE(?, description) WHERE owner = ? AND id = ?`,
        args: [patch.name ?? null, patch.description ?? null, owner, id],
      });
    },

    async saveSuggestion(x) {
      await client.execute({
        sql: `INSERT INTO latch_eval_suggestions (owner, thread_id, agent_name, text, ok, why, status, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(thread_id) DO UPDATE SET text = excluded.text, ok = excluded.ok, why = excluded.why,
                status = excluded.status, created_at = excluded.created_at,
                -- A new reading may not fit the pattern proposed for the old one.
                group_name = NULL, group_description = NULL`,
        args: [x.owner, x.threadId, x.agentName, x.text, x.ok ? 1 : 0, x.why, x.status, x.createdAt],
      });
    },
    async listSuggestions(owner, agentName, status) {
      return (
        await rows(
          `SELECT * FROM latch_eval_suggestions WHERE owner = ? AND agent_name = ?${status ? " AND status = ?" : ""} ORDER BY created_at DESC`,
          status ? [owner, agentName, status] : [owner, agentName],
        )
      ).map((r) => ({
        owner: String(r.owner),
        threadId: String(r.thread_id),
        agentName: String(r.agent_name),
        text: String(r.text),
        ok: Number(r.ok) === 1,
        why: String(r.why),
        status: String(r.status) as Suggestion["status"],
        createdAt: Number(r.created_at),
        ...(r.group_name ? { group: { name: String(r.group_name), description: String(r.group_description ?? "") } } : {}),
      }));
    },
    async setSuggestionGroups(owner, groups) {
      if (!groups.length) return;
      await client.batch(
        groups.map((g) => ({
          sql: `UPDATE latch_eval_suggestions SET group_name = ?, group_description = ? WHERE owner = ? AND thread_id = ?`,
          args: [g.group?.name ?? null, g.group?.description ?? null, owner, g.threadId],
        })),
        "write",
      );
    },
    async addMode(m) {
      await client.execute({
        sql: `INSERT INTO latch_eval_modes (owner, agent_name, id, name, description, created_at, decision, decision_why, decided_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner, id) DO NOTHING`,
        args: [m.owner, m.agentName, m.id, m.name, m.description, m.createdAt, m.decision ?? null, m.decisionWhy ?? null, m.decidedBy ?? null],
      });
    },
    async setSuggestionStatus(owner, threadId, status) {
      await client.execute({ sql: `UPDATE latch_eval_suggestions SET status = ? WHERE owner = ? AND thread_id = ?`, args: [status, owner, threadId] });
    },

    async listViews(owner, datasetId) {
      return (await rows(`SELECT * FROM latch_eval_views WHERE owner = ? AND dataset_id = ? ORDER BY created_at`, [owner, datasetId])).map((r) => ({
        datasetId: String(r.dataset_id),
        id: String(r.id),
        name: String(r.name),
        tags: parse<string[]>(r.tags, []),
        createdAt: Number(r.created_at),
      }));
    },
    async saveView(owner, v) {
      await client.execute({
        sql: `INSERT INTO latch_eval_views (owner, dataset_id, id, name, tags, created_at) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(owner, dataset_id, id) DO UPDATE SET name = excluded.name, tags = excluded.tags`,
        args: [owner, v.datasetId, v.id, v.name, JSON.stringify(v.tags), v.createdAt],
      });
    },
    async removeView(owner, datasetId, id) {
      await client.execute({ sql: `DELETE FROM latch_eval_views WHERE owner = ? AND dataset_id = ? AND id = ?`, args: [owner, datasetId, id] });
    },
    async deleteRuling(threadId, checkId) {
      await client.execute({ sql: `DELETE FROM latch_eval_rulings WHERE thread_id = ? AND check_id = ?`, args: [threadId, checkId] });
    },
    async listRulings(q) {
      const where: string[] = [];
      const args: unknown[] = [];
      if (q.threadIds?.length) (where.push(`thread_id IN (${placeholders(q.threadIds.length)})`), args.push(...q.threadIds));
      if (q.checkIds?.length) (where.push(`check_id IN (${placeholders(q.checkIds.length)})`), args.push(...q.checkIds));
      return (
        await rows(`SELECT * FROM latch_eval_rulings${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`, args)
      ).map((r) => ({
        threadId: String(r.thread_id),
        checkId: String(r.check_id),
        failed: Number(r.failed) === 1,
        ...(str(r.by) ? { by: str(r.by) } : {}),
        createdAt: Number(r.created_at),
      }));
    },
  };
}
