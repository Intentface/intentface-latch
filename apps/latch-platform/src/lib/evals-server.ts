/**
 * Server functions for the Evals page.
 *
 * Read-mostly: the grid reads datasets, runs, verdicts and rulings; the only
 * write is a person's ruling. Running and judging stay in `pnpm evals` until
 * there is a cost guard in front of them — a click must not start 138 runs.
 */
import { createServerFn } from "@tanstack/react-start";
import { getPrincipal } from "./session";
import { getLatch } from "./latch";
import { agentOwnerKey, normalizeAgentName } from "./agent-store";
import type { Principal } from "./session";
import type { Check, Rubric, ThreadRef, Verdict } from "./evals/v2/model";
import { fromEditable, toEditable, validateChecks } from "./evals/v2/validate";
import { CONFIRM_TWICE_ABOVE } from "./evals/v2/jobs";
import { planRun, startJudgeJob, startPlannedRun } from "./evals-jobs";
import { createChecks, createQuestionSet } from "./evals-actions";
import type { RunRequest } from "./evals-jobs";
import type { EditableQuestion } from "./evals/v2/validate";
import { compareVersions, configFingerprint, summarize } from "./evals/v2/runner";
import { thresholdFor, trustOf } from "./evals/v2/alignment";
import { describeCounted } from "./evals/v2/counted";
import { finalAnswer, viewOf } from "./evals/v2/thread";

/** The owner key this agent's eval data lives under, or null when not editable. */
async function ownerFor(principal: Principal, agent: string) {
  const { agentStore } = await getLatch();
  const rec = await agentStore.getRecord(principal, normalizeAgentName(agent));
  return rec ? { owner: agentOwnerKey(principal, rec.scope), name: rec.name } : null;
}

/**
 * Every agent the caller can edit, with its question sets — including agents
 * with none yet, so a new agent can be set up from the Evals pages.
 */
export const getEvalsIndexFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await getPrincipal();
  if (!principal) return [];
  const { evals, agentStore } = await getLatch();
  const owners = [...new Set([agentOwnerKey(principal, "user"), agentOwnerKey(principal, "org")])];
  const datasets = (await Promise.all(owners.map((o) => evals.listDatasets(o)))).flat();
  const byAgent = new Map<string, { id: string; name: string }[]>();
  for (const r of await agentStore.listRecords(principal)) byAgent.set(r.name, []);
  for (const d of datasets) byAgent.set(d.agentName, [...(byAgent.get(d.agentName) ?? []), { id: d.id, name: d.name }]);
  // Agents that have evals first, then the rest, each alphabetical.
  return [...byAgent]
    .map(([agent, sets]) => ({ agent, datasets: sets }))
    .sort((a, b) => Number(!a.datasets.length) - Number(!b.datasets.length) || a.agent.localeCompare(b.agent));
});

export const getEvalsOverviewFn = createServerFn({ method: "GET" })
  .validator((agent: string) => agent)
  .handler(async ({ data: agent }) => {
    const principal = await getPrincipal();
    if (!principal) return null;
    const o = await ownerFor(principal, agent);
    if (!o) return null;
    const { evals } = await getLatch();
    const datasets = await evals.listDatasets(o.owner, o.name);
    const rubrics = await evals.listRubrics(o.owner, o.name);
    return {
      datasets: await Promise.all(
        datasets.map(async (d) => ({
          id: d.id,
          name: d.name,
          inputs: (await evals.listInputs(d.id)).length,
          runs: await evals.listRuns(o.owner, d.id),
        })),
      ),
      rubrics: rubrics.map((r) => ({ id: r.id, version: r.version, checks: r.checks.length })),
    };
  });

export type EvalsOverview = NonNullable<Awaited<ReturnType<typeof getEvalsOverviewFn>>>;

/** A check as a sentence; a per-question value reads as what it is, not as template syntax. */
const sentence = (c: Rubric["checks"][number]) =>
  c.kind === "asked"
    ? c.ask
    : describeCounted(c).replace(/"?\{\{facts\.(\w+)\}\}"?/g, (_, k: string) => (k === "docs" ? "the document the question names" : `the question's ${k}`));

/**
 * A result: one version's answers in one run. The grid compares any results,
 * question by question — the first is the baseline. Within one run the
 * comparison holds everything but the agent fixed; across runs the world may
 * have moved too, so the grid says which it is showing.
 */
export type ResultRef = { runId: string; version: string };

export const getEvalGridFn = createServerFn({ method: "GET" })
  .validator((d: { agent: string; datasetId: string; rubricId: string; runId?: string; columns?: ResultRef[] }) => d)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return null;
    const o = await ownerFor(principal, data.agent);
    if (!o) return null;
    const { evals } = await getLatch();
    const latest = await evals.getRubric(o.owner, data.rubricId);
    if (!latest) return null;
    const runs = await evals.listRuns(o.owner, data.datasetId);

    // Columns: as asked, or every version of one run (the latest by default).
    let columns: ResultRef[] = (data.columns ?? []).filter((c) => runs.some((r) => r.runId === c.runId && r.versions.includes(c.version)));
    if (!columns.length) {
      const run = runs.find((r) => r.runId === data.runId) ?? runs.at(0);
      if (!run) return null;
      const order = (v: string) => (v === "live" ? "" : v);
      columns = [...run.versions].sort((a, b) => order(a).localeCompare(order(b))).map((version) => ({ runId: run.runId, version }));
    }
    const crossRun = new Set(columns.map((c) => c.runId)).size > 1;
    const runOf = new Map(runs.map((r) => [r.runId, r]));
    const when = (at: number) => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    // Across runs a column needs its run in its name; within one, the version is enough.
    const labelOf = (c: ResultRef) => {
      if (!crossRun) return c.version;
      const r = runOf.get(c.runId)!;
      return `${c.version} · ${r.name ?? when(r.createdAt)}`;
    };

    const rubrics = new Map<number, Rubric>([[latest.version, latest]]);
    const rubricAt = async (v: number) => rubrics.get(v) ?? (await evals.getRubric(o.owner, data.rubricId, v).then((r) => (r && rubrics.set(v, r), r)));
    const threads: ThreadRef[] = [];
    const verdicts: Verdict[] = [];
    const judgedWith: number[] = [];
    for (const c of columns) {
      const label = labelOf(c);
      const mine = (await evals.listThreads(o.owner, { datasetId: data.datasetId, runId: c.runId })).filter((t) => t.version === c.version);
      const ids = mine.map((t) => t.threadId);
      // Editing the checks saves a new version nothing has judged yet: each
      // column shows the newest version that HAS verdicts on its threads.
      let used = latest.version;
      let vs = await evals.listVerdicts({ threadIds: ids, rubricVersion: used });
      for (let v = latest.version - 1; !vs.length && v >= 1; v--) {
        if (!(await rubricAt(v))) continue;
        const older = await evals.listVerdicts({ threadIds: ids, rubricVersion: v });
        if (older.length) (vs = older, used = v);
      }
      judgedWith.push(used);
      threads.push(...mine.map((t) => ({ ...t, version: label })));
      verdicts.push(...vs);
    }
    const rubric = (await rubricAt(Math.max(...judgedWith))) ?? latest;

    // Trust reads every ruled thread of this question set, not just these runs.
    const all = await evals.listThreads(o.owner, { datasetId: data.datasetId });
    const allVerdicts = await evals.listVerdicts({ threadIds: all.map((t) => t.threadId), rubricVersion: rubric.version });
    const rulings = await evals.listRulings({ threadIds: all.map((t) => t.threadId) });
    const inputs = new Map((await evals.listInputs(data.datasetId)).map((i) => [i.id, i]));

    const labels = columns.map(labelOf);
    const byLabel = new Map(summarize(threads, verdicts, rubric).map((s) => [s.version, s]));
    const summaries = labels.map((l) => byLabel.get(l) ?? { version: l, threads: 0, errors: 0, checks: rubric.checks.map((c) => ({ checkId: c.id, passed: 0, total: 0, allPassed: 0, inputs: 0, answers: {} })) });
    const checkIds = rubric.checks.map((c) => c.id);
    // Every column against the baseline, on the questions both answered.
    const changes = new Map(labels.slice(1).map((l) => [l, compareVersions(threads, verdicts, checkIds, labels[0], l)]));
    const trust = trustOf(allVerdicts, rulings);
    const rulingOf = new Map(rulings.map((r) => [`${r.threadId}|${r.checkId}`, r.failed]));
    const byThread = new Map<string, ThreadRef>(threads.map((t) => [t.threadId, t]));

    return {
      runId: columns[0].runId,
      crossRun,
      columns: columns.map((c, i) => {
        const r = runOf.get(c.runId)!;
        return { ...c, label: labels[i], runName: r.name, at: r.createdAt, judgedWith: judgedWith[i] };
      }),
      rubricVersion: rubric.version,
      latestVersion: latest.version,
      versions: labels,
      attempts: Math.max(1, ...threads.map((t) => (t.attempt ?? 0) + 1)),
      errors: summaries.map((s) => ({ version: s.version, errors: s.errors })),
      checks: rubric.checks.map((c) => {
        const th = thresholdFor(c.id, allVerdicts, rulings);
        return {
          id: c.id,
          label: c.label,
          kind: c.kind,
          sentence: sentence(c),
          judge: c.kind === "counted" ? "counted" : (c.judge ?? rubric.defaultJudge),
          cells: summaries.map((s) => s.checks.find((k) => k.checkId === c.id)!),
          /** Baseline vs the second column — what the summary sentence reads. */
          compare: labels[1] ? (changes.get(labels[1])?.find((x) => x.checkId === c.id) ?? null) : null,
          /** Baseline vs each other column, by column label. */
          changes: Object.fromEntries(labels.slice(1).map((l) => [l, changes.get(l)?.find((x) => x.checkId === c.id) ?? null])),
          trust: trust.find((t) => t.checkId === c.id) ?? null,
          accept: th.accept,
        };
      }),
      verdicts: verdicts.map((v) => {
        const t = byThread.get(v.threadId)!;
        return {
          threadId: v.threadId,
          checkId: v.checkId,
          version: t.version,
          inputId: t.inputId ?? "",
          attempt: t.attempt ?? 0,
          prompt: (t.inputId && inputs.get(t.inputId)?.prompt) || "",
          answer: v.answer,
          failed: v.failed,
          confidence: v.confidence ?? null,
          ruling: rulingOf.get(`${v.threadId}|${v.checkId}`) ?? null,
        };
      }),
    };
  });

export type EvalGrid = NonNullable<Awaited<ReturnType<typeof getEvalGridFn>>>;

/** One thread as a reviewer needs it: question, tools, answer, reference. */
export const getEvalThreadFn = createServerFn({ method: "GET" })
  .validator((d: { agent: string; threadId: string }) => d)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return null;
    const o = await ownerFor(principal, data.agent);
    if (!o) return null;
    const { evals, runtime } = await getLatch();
    const t = await evals.getThread(o.owner, data.threadId);
    if (!t) return null;
    const view = viewOf(await runtime.loadHistory({ chatId: t.threadId, principal }));
    const input = t.datasetId && t.inputId ? (await evals.listInputs(t.datasetId)).find((i) => i.id === t.inputId) : undefined;
    return {
      version: t.version,
      prompt: input?.prompt ?? view.inputs[0],
      followUps: input?.followUps ?? [],
      tools: view.calls.map((c) => ({ tool: c.tool, stubbed: c.gated })),
      answer: finalAnswer(view),
      reference: input?.facts?.answer ?? null,
    };
  });

export const saveEvalRulingFn = createServerFn({ method: "POST" })
  .validator((d: { agent: string; threadId: string; checkId: string; failed: boolean | null }) => d)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "unauthorized" };
    const o = await ownerFor(principal, data.agent);
    if (!o) return { ok: false as const, error: "not your agent" };
    const { evals } = await getLatch();
    // A ruling may only land on a thread this owner holds.
    if (!(await evals.getThread(o.owner, data.threadId))) return { ok: false as const, error: "no such thread" };
    if (data.failed === null) await evals.deleteRuling(data.threadId, data.checkId);
    else
      await evals.saveRuling({
        threadId: data.threadId,
        checkId: data.checkId,
        failed: data.failed,
        ...(principal.userId ? { by: principal.userId } : {}),
        createdAt: Date.now(),
      });
    return { ok: true as const };
  });

// ─── Editing the tests ─────────────────────────────────────────────────────

/** A question set's questions, for the editor. */
export const getQuestionsFn = createServerFn({ method: "GET" })
  .validator((d: { agent: string; datasetId: string }) => d)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return null;
    const o = await ownerFor(principal, data.agent);
    if (!o) return null;
    const { evals } = await getLatch();
    const d = await evals.getDataset(o.owner, data.datasetId);
    if (!d) return null;
    return { dataset: { id: d.id, name: d.name, audience: d.audience ?? "", note: d.note ?? "" }, questions: (await evals.listInputs(d.id)).map(toEditable) };
  });

/**
 * Replace a question set's questions. Ids are what past results hang on, so
 * a question keeps its id when edited; a removed id's old results stay in
 * old runs and simply stop appearing in new ones.
 */
export const saveQuestionsFn = createServerFn({ method: "POST" })
  .validator((d: { agent: string; datasetId: string; audience: string; note: string; questions: EditableQuestion[] }) => d)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "Sign in again to save." };
    const o = await ownerFor(principal, data.agent);
    if (!o) return { ok: false as const, error: "Only agents you can edit have editable questions." };
    const { evals } = await getLatch();
    const d = await evals.getDataset(o.owner, data.datasetId);
    if (!d) return { ok: false as const, error: "This question set no longer exists." };
    const valid = fromEditable(data.questions);
    if (!valid.ok) return valid;
    await evals.saveDataset({
      owner: d.owner,
      id: d.id,
      agentName: d.agentName,
      name: d.name,
      kind: d.kind,
      ...(data.audience.trim() ? { audience: data.audience.trim() } : {}),
      ...(data.note.trim() ? { note: data.note.trim() } : {}),
    });
    await evals.setInputs(d.id, valid.value);
    return { ok: true as const, questions: valid.value.map(toEditable) };
  });

/** The latest version of a set of checks, plus the judges a check may name. */
export const getChecksFn = createServerFn({ method: "GET" })
  .validator((d: { agent: string; rubricId: string }) => d)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return null;
    const o = await ownerFor(principal, data.agent);
    if (!o) return null;
    const { evals, models } = await getLatch();
    const r = await evals.getRubric(o.owner, data.rubricId);
    if (!r) return null;
    return {
      // As JSON: a matcher's value can be anything, which a server function cannot type.
      rubric: { id: r.id, version: r.version, defaultJudge: r.defaultJudge, checks: JSON.stringify(r.checks) },
      judges: ["jev-latest", ...models.map((m) => m.id)],
    };
  });

/** Save checks as a NEW version: old verdicts stay attached to the version that produced them. */
export const saveChecksFn = createServerFn({ method: "POST" })
  .validator((d: { agent: string; rubricId: string; defaultJudge: string; checks: string }) => d)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "Sign in again to save." };
    const o = await ownerFor(principal, data.agent);
    if (!o) return { ok: false as const, error: "Only agents you can edit have editable checks." };
    const { evals } = await getLatch();
    const prev = await evals.getRubric(o.owner, data.rubricId);
    if (!prev) return { ok: false as const, error: "These checks no longer exist." };
    let parsed: Check[];
    try {
      parsed = JSON.parse(data.checks) as Check[];
    } catch {
      return { ok: false as const, error: "The checks could not be read." };
    }
    const valid = validateChecks(parsed);
    if (!valid.ok) return valid;
    const r = await evals.saveRubric({
      owner: o.owner,
      id: prev.id,
      agentName: prev.agentName,
      defaultJudge: data.defaultJudge || prev.defaultJudge,
      checks: valid.value,
    });
    return { ok: true as const, version: r.version };
  });

// ─── Running and judging ───────────────────────────────────────────────────

/** What a new run can be made of: the versions that exist, and the questions. */
export const getRunOptionsFn = createServerFn({ method: "GET" })
  .validator((d: { agent: string; datasetId: string }) => d)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return null;
    const o = await ownerFor(principal, data.agent);
    if (!o) return null;
    const { evals, agentStore } = await getLatch();
    const rec = await agentStore.getRecord(principal, o.name);
    if (!rec) return null;
    const [draft, history, inputs] = await Promise.all([
      agentStore.getDraft(principal, o.name, rec.scope),
      agentStore.listVersions(principal, o.name, rec.scope),
      evals.listInputs(data.datasetId),
    ]);
    // Say which listed version IS live: picking both compares a configuration with itself.
    const livePrint = configFingerprint(rec);
    const recent = history.slice().sort((a, b) => b.version - a.version).slice(0, 12);
    const prints = await Promise.all(
      recent.map(async (v) => {
        const r = await agentStore.getVersion(principal, o.name, rec.scope, v.version);
        return r ? configFingerprint(r) : null;
      }),
    );
    const sameAsLive = (print: string | null) => print === livePrint;
    return {
      versions: [
        { label: "live", note: "what users get now" },
        ...(draft
          ? [{ label: "@draft", note: sameAsLive(configFingerprint(draft.record)) ? "same as live — no changes yet" : "unpublished changes" }]
          : []),
        ...recent.map((v, i) => ({
          label: `@${v.version}`,
          note: sameAsLive(prints[i] ?? null)
            ? "same as live"
            : (v.message ?? (v.changedFields?.length ? `changed ${v.changedFields.join(", ")}` : "")),
        })),
      ],
      questions: inputs.map((i) => ({ id: i.id, prompt: i.prompt })),
    };
  });

export const estimateRunFn = createServerFn({ method: "POST" })
  .validator((d: RunRequest) => d)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "Sign in again." };
    const p = await planRun(principal, data);
    if (!p.ok) return p;
    return { ok: true as const, estimate: p.estimate, same: p.same, confirmTwiceAbove: CONFIRM_TWICE_ABOVE };
  });

/**
 * Start a run. The caller sends back the cost it was shown; if the price has
 * risen since (more history, a pricier thread), the run does not start — a
 * person confirms the number that will be spent, not an earlier one.
 */
export const startRunFn = createServerFn({ method: "POST" })
  .validator((d: RunRequest & { confirmedCost: number | null }) => d)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "Sign in again." };
    return startPlannedRun(principal, data, data.confirmedCost);
  });

/** Re-score an existing run under the latest checks. No agent runs, so no confirmation. */
export const startJudgeFn = createServerFn({ method: "POST" })
  .validator((d: { agent: string; datasetId: string; rubricId: string; runId: string }) => d)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "Sign in again." };
    return startJudgeJob(principal, data);
  });

/** Recent jobs for a question set, newest first — what the progress bar reads. */
export const listJobsFn = createServerFn({ method: "GET" })
  .validator((d: { agent: string; datasetId: string }) => d)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return [];
    const o = await ownerFor(principal, data.agent);
    if (!o) return [];
    const { evals } = await getLatch();
    return (await evals.listJobs(o.owner, data.datasetId, 10)).map((j) => ({
      id: j.id,
      runId: j.runId,
      kind: j.kind,
      status: j.status,
      total: j.total,
      done: j.done,
      failed: j.failed,
      versions: j.versions.map((v) => v.label),
      questions: j.inputIds.length,
      repeats: j.repeats,
      cost: j.estimate.cost,
      error: j.error ?? null,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
    }));
  });

export type JobRow = Awaited<ReturnType<typeof listJobsFn>>[number];

export const cancelJobFn = createServerFn({ method: "POST" })
  .validator((d: { agent: string; id: string }) => d)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const };
    const o = await ownerFor(principal, data.agent);
    if (!o) return { ok: false as const };
    const { evals } = await getLatch();
    const j = await evals.getJob(o.owner, data.id);
    if (!j || (j.status !== "running" && j.status !== "judging")) return { ok: false as const };
    // Threads already in flight finish and are kept; nothing new starts.
    await evals.updateJob(data.id, { status: "cancelled", updatedAt: Date.now() });
    return { ok: true as const };
  });

export const createQuestionSetFn = createServerFn({ method: "POST" })
  .validator((d: { agent: string; name: string; audience: string; note: string }) => d)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "Sign in again." };
    return createQuestionSet(principal, data);
  });

export const createChecksFn = createServerFn({ method: "POST" })
  .validator((d: { agent: string; name: string }) => d)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "Sign in again." };
    return createChecks(principal, data);
  });

/**
 * Every run of a question set as points: for each version in each run, the
 * share of verdicts that passed and what a thread cost on average. What the
 * cost chart plots — did the better version cost more?
 */
export const getRunHistoryFn = createServerFn({ method: "GET" })
  .validator((d: { agent: string; datasetId: string; rubricId: string }) => d)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return [];
    const o = await ownerFor(principal, data.agent);
    if (!o) return [];
    const { evals } = await getLatch();
    const latest = await evals.getRubric(o.owner, data.rubricId);
    if (!latest) return [];
    const runs = (await evals.listRuns(o.owner, data.datasetId)).slice(0, 20);
    const points: { runId: string; version: string; at: number; passRate: number; verdicts: number; costPerThread: number | null; threads: number }[] = [];
    for (const r of runs) {
      const threads = (await evals.listThreads(o.owner, { datasetId: data.datasetId, runId: r.runId })).filter((t) => !t.error);
      const ids = threads.map((t) => t.threadId);
      // The newest checks version this run was judged under.
      let verdicts = await evals.listVerdicts({ threadIds: ids, rubricVersion: latest.version });
      for (let v = latest.version - 1; !verdicts.length && v >= 1; v--) verdicts = await evals.listVerdicts({ threadIds: ids, rubricVersion: v });
      if (!verdicts.length) continue;
      const costs = await evals.threadCosts(ids);
      for (const version of r.versions) {
        const mine = new Set(threads.filter((t) => t.version === version).map((t) => t.threadId));
        const vs = verdicts.filter((v) => mine.has(v.threadId));
        const cs = [...mine].map((id) => costs.get(id)).filter((c): c is number => c !== undefined && c > 0);
        if (!vs.length) continue;
        points.push({
          runId: r.runId,
          version,
          at: r.createdAt,
          passRate: vs.filter((v) => !v.failed).length / vs.length,
          verdicts: vs.length,
          costPerThread: cs.length ? cs.reduce((a, b) => a + b, 0) / cs.length : null,
          threads: mine.size,
        });
      }
    }
    return points;
  });

export type RunPoint = Awaited<ReturnType<typeof getRunHistoryFn>>[number];
