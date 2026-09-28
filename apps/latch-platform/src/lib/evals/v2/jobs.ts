/**
 * Evals v2 — runs that outlive the request that started them.
 *
 * A run takes minutes; a serverless request gets a few. So a run is a JOB: a
 * row that says what to run, advanced in slices by whoever holds its lease —
 * the request that started it (kept alive with waitUntil), then the minute
 * cron for as long as it takes. A slice runs the units that have no thread
 * yet, so a restart never pays for a thread twice, and judges once the last
 * thread lands.
 *
 * Money is the constraint here, not time: every run is estimated from what
 * earlier threads of the same set actually cost before anything starts, and
 * nothing starts without the person who pays confirming the number.
 */
import type { Dataset, Input, Rubric, ThreadRef, Verdict, Version } from "./model";
import { judgeThreads, pool, runUnit } from "./runner";
import type { JudgeDeps, RunDeps } from "./runner";

export type JobStatus = "running" | "judging" | "done" | "failed" | "cancelled";

export interface EvalJob {
  owner: string;
  id: string;
  /** The run whose threads this job produces or judges. A `run` job's own id. */
  runId: string;
  /** `run` produces threads then judges; `judge` re-scores an existing run. */
  kind: "run" | "judge";
  /** What this run is testing, in the person's words — "stricter read-failure rule". */
  name?: string;
  /** Existing results (baseline first) the new ones are compared with when it finishes. */
  compareWith?: { runId: string; version: string }[];
  agentName: string;
  datasetId: string;
  rubricId: string;
  /** Who started it. Agent runs act as this person, so they see what they would see. */
  principal: { orgId: string; userId?: string };
  versions: (Version & { fingerprint: string })[];
  inputIds: string[];
  repeats: number;
  /**
   * Answering again, into an existing run: the one try each input gets —
   * one past the tries it already has. The run's other answers are untouched.
   */
  tryOf?: Record<string, number>;
  /** A `judge` job limited to these threads; all of the run's when absent. */
  threadIds?: string[];
  /** Grade again from scratch: the threads' grades under the current checks are cleared first, then made anew. */
  regrade?: boolean;
  /** Set once the old grades are cleared, so a restarted job doesn't clear its own new ones. */
  cleared?: boolean;
  status: JobStatus;
  /** Units planned / produced (including failed) — for `judge` jobs, threads to judge. */
  total: number;
  done: number;
  failed: number;
  estimate: Estimate;
  error?: string;
  createdAt: number;
  updatedAt: number;
  /** Until when the current holder may advance it. */
  leaseUntil: number;
}

export interface Estimate {
  agentRuns: number;
  judgeCalls: number;
  /** Dollars, from what earlier threads of this set cost. Null when there is no history to go on. */
  cost: number | null;
  /** What the number rests on, in words. */
  basis: string;
}

/** Above this, the page asks twice. */
export const CONFIRM_TWICE_ABOVE = 5;
/** A hard ceiling on one run, whatever the confirmation. */
export const MAX_UNITS = 500;

export function estimateRun(opts: {
  units: number;
  askedChecks: number;
  /** Cost of earlier threads of this set, in dollars. */
  history: number[];
}): Estimate {
  const { units, askedChecks, history } = opts;
  // One judge call per thread per judge; the default rubric has one judge.
  const judgeCalls = askedChecks ? units : 0;
  if (!history.length)
    return {
      agentRuns: units,
      judgeCalls,
      cost: null,
      basis: "No earlier run of this set to price it from. Start with a few questions to find out.",
    };
  // A high percentile, not the mean: a run is priced by its slow, chatty
  // threads, and under-promising the bill is the failure worth avoiding.
  const sorted = [...history].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const p75 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))];
  const per = Math.max(mean, p75);
  return {
    agentRuns: units,
    judgeCalls,
    cost: per * units,
    basis: `About $${per.toFixed(2)} a thread, from ${sorted.length} earlier thread${sorted.length === 1 ? "" : "s"} of this set.`,
  };
}

export type Unit = { v: EvalJob["versions"][number]; input: Input; attempt: number };

export function unitsOf(job: Pick<EvalJob, "versions" | "inputIds" | "repeats" | "tryOf">, inputs: Input[]): Unit[] {
  const byId = new Map(inputs.map((i) => [i.id, i]));
  const picked = job.inputIds.map((id) => byId.get(id)).filter((i): i is Input => !!i);
  // Answering again: exactly one new try per input, numbered after its others.
  const tryOf = job.tryOf;
  if (tryOf) return picked.flatMap((input) => job.versions.map((v) => ({ v, input, attempt: tryOf[input.id] ?? 0 })));
  // Question-major, versions interleaved: the versions answer each question
  // side by side, at the same moment, under the same conditions — which is
  // the whole point of running them together. Version-major would run all of
  // one version, then all of the other, minutes apart.
  return picked.flatMap((input) =>
    Array.from({ length: job.repeats }, (_, attempt) => job.versions.map((v) => ({ v, input, attempt }))).flat(),
  );
}

const unitKey = (version: string, inputId: string, attempt: number) => `${version}|${inputId}|${attempt}`;

export interface JobDeps {
  run: RunDeps;
  judge: JudgeDeps;
  loadInputs: () => Promise<Input[]>;
  loadDataset: () => Promise<Pick<Dataset, "id" | "agentName" | "audience" | "note">>;
  loadRubric: () => Promise<Rubric | null>;
  threadsOf: (runId: string) => Promise<ThreadRef[]>;
  saveThread: (t: ThreadRef) => Promise<void>;
  verdictsOf: (threadIds: string[], rubricVersion: number) => Promise<Verdict[]>;
  saveVerdicts: (vs: Verdict[]) => Promise<void>;
  /** Remove the threads' grades under one version of the checks — for grading again from scratch. */
  clearVerdicts: (threadIds: string[], rubricVersion: number) => Promise<void>;
  /** Persist progress; returns the job as stored, so a cancel made elsewhere is seen. */
  update: (patch: Partial<EvalJob>) => Promise<EvalJob | null>;
}

/**
 * Advance a job until it finishes or the deadline passes. Safe to call
 * again at any time: work already done is read back, never repeated.
 * The caller holds the lease.
 */
export async function advanceJob(job: EvalJob, deps: JobDeps, opts: { deadline: number; concurrency?: number }): Promise<EvalJob> {
  let current = job;
  // Read through a function: `current` changes inside callbacks, which flow analysis cannot see.
  const status = (): JobStatus => current.status;
  const stillWanted = async (patch: Partial<EvalJob>) => {
    const next = await deps.update({ ...patch, updatedAt: Date.now() });
    if (next) current = next;
    return current.status !== "cancelled";
  };

  try {
    if (current.kind === "run" && current.status === "running") {
      const [inputs, dataset] = await Promise.all([deps.loadInputs(), deps.loadDataset()]);
      const units = unitsOf(current, inputs);
      const have = new Set((await deps.threadsOf(current.runId)).map((t) => unitKey(t.version, t.inputId ?? "", t.attempt ?? 0)));
      const pending = units.filter((u) => !have.has(unitKey(u.v.label, u.input.id, u.attempt)));
      let done = units.length - pending.length;
      let failed = current.failed;
      let stop = false;
      await pool(pending, opts.concurrency ?? 4, async (u) => {
        // Never START a unit past the deadline; one in flight finishes and is kept.
        if (stop || Date.now() > opts.deadline) return;
        const t = await runUnit({ owner: current.owner, dataset, runId: current.runId, deps: deps.run, ...u });
        await deps.saveThread(t);
        done += 1;
        if (t.error) failed += 1;
        if (!(await stillWanted({ done, failed }))) stop = true;
      });
      if (status() === "cancelled") return current;
      if (done < units.length) return current;
      await stillWanted({ status: "judging", done, failed });
    }

    if (status() === "judging" || (current.kind === "judge" && status() === "running")) {
      const rubric = await deps.loadRubric();
      if (!rubric) {
        await stillWanted({ status: "failed", error: "The checks for this run were deleted." });
        return current;
      }
      const [inputs, dataset] = await Promise.all([deps.loadInputs(), deps.loadDataset()]);
      const only = current.threadIds ? new Set(current.threadIds) : null;
      const threads = (await deps.threadsOf(current.runId)).filter((t) => !t.error && (!only || only.has(t.threadId)));
      if (current.regrade && !current.cleared) {
        await deps.clearVerdicts(threads.map((t) => t.threadId), rubric.version);
        if (!(await stillWanted({ cleared: true }))) return current;
      }
      const judged = new Set((await deps.verdictsOf(threads.map((t) => t.threadId), rubric.version)).map((v) => v.threadId));
      const todo = threads.filter((t) => !judged.has(t.threadId));
      if (current.kind === "judge" && current.total !== threads.length) await stillWanted({ total: threads.length, done: judged.size });
      const inputsById = new Map(inputs.map((i) => [i.id, i]));
      // Judge in small batches so progress is saved and the deadline is honoured.
      for (let i = 0; i < todo.length; i += 8) {
        if (Date.now() > opts.deadline) return current;
        const vs = await judgeThreads({ rubric, threads: todo.slice(i, i + 8), inputsById, dataset, deps: deps.judge });
        await deps.saveVerdicts(vs);
        if (current.kind === "judge" && !(await stillWanted({ done: judged.size + Math.min(i + 8, todo.length) }))) return current;
      }
      await stillWanted({ status: "done", ...(current.kind === "judge" ? { done: threads.length } : {}) });
    }
  } catch (e) {
    await stillWanted({ status: "failed", error: e instanceof Error ? e.message : String(e) });
  }
  return current;
}
