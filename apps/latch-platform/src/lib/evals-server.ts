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
import type { Check, Rubric, ThreadRef } from "./evals/v2/model";
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

/** Every agent with eval data the caller can see, with its question sets. */
export const getEvalsIndexFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await getPrincipal();
  if (!principal) return [];
  const { evals } = await getLatch();
  const owners = [...new Set([agentOwnerKey(principal, "user"), agentOwnerKey(principal, "org")])];
  const datasets = (await Promise.all(owners.map((o) => evals.listDatasets(o)))).flat();
  const byAgent = new Map<string, { id: string; name: string }[]>();
  for (const d of datasets) byAgent.set(d.agentName, [...(byAgent.get(d.agentName) ?? []), { id: d.id, name: d.name }]);
  return [...byAgent].map(([agent, sets]) => ({ agent, datasets: sets })).sort((a, b) => a.agent.localeCompare(b.agent));
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

export const getEvalGridFn = createServerFn({ method: "GET" })
  .validator((d: { agent: string; datasetId: string; rubricId: string; runId: string }) => d)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return null;
    const o = await ownerFor(principal, data.agent);
    if (!o) return null;
    const { evals } = await getLatch();
    const latest = await evals.getRubric(o.owner, data.rubricId);
    if (!latest) return null;
    const threads = await evals.listThreads(o.owner, { datasetId: data.datasetId, runId: data.runId });
    const ids = threads.map((t) => t.threadId);
    // Editing the checks saves a new version that nothing has judged yet.
    // Show the newest version that HAS verdicts on this run, and say so.
    let rubric = latest;
    let verdicts = await evals.listVerdicts({ threadIds: ids, rubricVersion: latest.version });
    for (let v = latest.version - 1; !verdicts.length && v >= 1; v--) {
      const older = await evals.getRubric(o.owner, data.rubricId, v);
      if (!older) continue;
      const vs = await evals.listVerdicts({ threadIds: ids, rubricVersion: v });
      if (vs.length) (rubric = older, verdicts = vs);
    }
    // Trust reads every ruled thread of this dataset, not just this run.
    const all = await evals.listThreads(o.owner, { datasetId: data.datasetId });
    const allVerdicts = await evals.listVerdicts({ threadIds: all.map((t) => t.threadId), rubricVersion: rubric.version });
    const rulings = await evals.listRulings({ threadIds: all.map((t) => t.threadId) });
    const inputs = new Map((await evals.listInputs(data.datasetId)).map((i) => [i.id, i]));

    const order = (v: string) => (v === "live" ? "" : v);
    const summaries = summarize(threads, verdicts, rubric).sort((a, b) => order(a.version).localeCompare(order(b.version)));
    const versions = summaries.map((s) => s.version);
    const comparison =
      versions.length >= 2
        ? compareVersions(threads, verdicts, rubric.checks.map((c) => c.id), versions[0], versions[1])
        : [];
    const trust = trustOf(allVerdicts, rulings);
    const rulingOf = new Map(rulings.map((r) => [`${r.threadId}|${r.checkId}`, r.failed]));
    const byThread = new Map<string, ThreadRef>(threads.map((t) => [t.threadId, t]));

    return {
      runId: data.runId,
      rubricVersion: rubric.version,
      latestVersion: latest.version,
      versions,
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
          compare: comparison.find((x) => x.checkId === c.id) ?? null,
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
