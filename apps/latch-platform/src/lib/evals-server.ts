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
import type { Check, Variant } from "./evals/v2/model";
import { fromEditable, toEditable, validateChecks } from "./evals/v2/validate";
import { CONFIRM_TWICE_ABOVE } from "./evals/v2/jobs";
import { planAgain, planRun, startAgain, startJudgeJob, startPlannedRun } from "./evals-jobs";
import { computeGrid } from "./evals-grid";
import type { ResultRef } from "./evals-grid";
import { createChecks, createQuestionSet, editInputFiles, editQuestions } from "./evals-actions";
import type { AgainRequest, RunRequest } from "./evals-jobs";
import type { EditableQuestion } from "./evals/v2/validate";
import { configFingerprint } from "./evals/v2/runner";
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

/**
 * A result: one version's answers in one run. The grid compares any results,
 * question by question — the first is the baseline. Within one run the
 * comparison holds everything but the agent fixed; across runs the world may
 * have moved too, so the grid says which it is showing.
 */
export type { ResultRef } from "./evals-grid";

export const getEvalGridFn = createServerFn({ method: "GET" })
  .validator((d: { agent: string; datasetId: string; rubricId: string; runId?: string; columns?: ResultRef[] }) => d)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return null;
    return computeGrid(principal, data);
  });

export type EvalGrid = NonNullable<Awaited<ReturnType<typeof computeGrid>>>;

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
    return {
      dataset: { id: d.id, name: d.name, audience: d.audience ?? "", note: d.note ?? "" },
      questions: (await evals.listInputs(d.id)).map((i) => ({
        ...toEditable(i),
        files: (i.files ?? []).map((f) => ({ filename: f.filename, mediaType: f.mediaType, size: f.size })),
      })),
    };
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
    const filesOf = new Map((await evals.listInputs(d.id)).map((i) => [i.id, i.files]));
    for (const i of valid.value) {
      const f = filesOf.get(i.id);
      if (f?.length) i.files = f;
    }
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

/**
 * Add, change or remove inputs one at a time — what the results table's
 * composer and an input's drawer save. An edited input keeps its id, which
 * is what its past answers hang on.
 */
export const editInputsFn = createServerFn({ method: "POST" })
  .validator(
    (d: {
      agent: string;
      datasetId: string;
      upserts?: (Partial<EditableQuestion> & { prompt: string })[];
      deletes?: string[];
      audience?: string;
      note?: string;
    }) => d,
  )
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "Sign in again to save." };

    return editQuestions(principal, { ...data, questionSetId: data.datasetId });
  });

/**
 * The agent's tools, each with the arguments seen in its past answers to
 * this set and the values it passed — what an input's "calls a tool" picks
 * from. Read from real calls rather than declared schemas, so it names what
 * the agent actually sends; tools it has never called are listed bare.
 */
export const getToolArgsFn = createServerFn({ method: "GET" })
  .validator((d: { agent: string; datasetId: string }) => d)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return null;
    const o = await ownerFor(principal, data.agent);
    if (!o) return null;
    const { evals, agentStore, runtime } = await getLatch();
    const rec = await agentStore.getRecord(principal, o.name);
    const threads = (await evals.listThreads(o.owner, { datasetId: data.datasetId })).filter((t) => !t.error).slice(0, 30);
    const seen = new Map<string, Map<string, { type: string; values: Map<string, number> }>>();
    for (const t of threads) {
      const view = viewOf(await runtime.loadHistory({ chatId: t.threadId, principal }));
      for (const c of view.calls) {
        const args = seen.get(c.tool) ?? seen.set(c.tool, new Map()).get(c.tool)!;
        if (!c.args || typeof c.args !== "object") continue;
        for (const [k, v] of Object.entries(c.args as Record<string, unknown>)) {
          if (k === "reason") continue;
          const a = args.get(k) ?? args.set(k, { type: Array.isArray(v) ? "list" : typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : "text", values: new Map() }).get(k)!;
          for (const item of Array.isArray(v) ? v : [v]) {
            const text = typeof item === "string" || typeof item === "number" || typeof item === "boolean" ? String(item) : null;
            if (text && text.length < 80) a.values.set(text, (a.values.get(text) ?? 0) + 1);
          }
        }
      }
    }
    const enabled = (rec?.tools as { enabled?: string[] } | undefined)?.enabled ?? [];
    const names = [...new Set([...seen.keys(), ...enabled])].sort();
    return names.map((name) => ({
      name,
      called: seen.has(name),
      args: [...(seen.get(name) ?? new Map()).entries()].map(([arg, a]) => ({
        name: arg,
        type: a.type,
        seen: [...a.values.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([v]) => v),
      })),
    }));
  });

/** Attach a file to an input, or remove one. Sent as its contents, the way chat sends one. */
export const editInputFilesFn = createServerFn({ method: "POST" })
  .validator((d: { agent: string; datasetId: string; inputId: string; add?: { filename: string; mediaType: string; url: string }; remove?: number }) => d)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "Sign in again." };
    return editInputFiles(principal, data);
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
/**
 * Save a variant — a version with one thing changed — so it can be run as a
 * column. Its name says what changed; the same change on the same base is the
 * same variant, so running it again reuses its answers.
 */
export const createVariantFn = createServerFn({ method: "POST" })
  .validator((d: { agent: string; base: string; change: Variant["change"] }) => d)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "Sign in again." };
    const o = await ownerFor(principal, data.agent);
    if (!o) return { ok: false as const, error: "Only agents you can edit." };
    const { evals, models } = await getLatch();
    const change: Variant["change"] = {
      ...(data.change.model ? { model: data.change.model } : {}),
      ...(data.change.effort ? { effort: data.change.effort } : {}),
      ...(data.change.addInstructions?.trim() ? { addInstructions: data.change.addInstructions.trim() } : {}),
    };
    if (!Object.keys(change).length) return { ok: false as const, error: "Change one thing: the model, the reasoning effort or the instructions." };
    if (change.model && !models.some((m) => m.id === change.model)) return { ok: false as const, error: `No model ${change.model} is configured.` };
    const existing = await evals.listVariants(o.owner, o.name);
    const same = existing.find((v) => v.base === data.base && JSON.stringify(v.change) === JSON.stringify(change));
    if (same) return { ok: true as const, id: same.id, name: same.name };
    const what = change.model
      ? change.model.replace(/^claude-/, "")
      : change.effort
        ? `${change.effort} effort`
        : `+ “${change.addInstructions!.slice(0, 24)}${change.addInstructions!.length > 24 ? "…" : ""}”`;
    let name = `${data.base} · ${what}`;
    for (let n = 2; existing.some((v) => v.name === name); n++) name = `${data.base} · ${what} ${n}`;
    const id = `v_${Math.random().toString(36).slice(2, 8)}`;
    await evals.saveVariant({ owner: o.owner, id, agentName: o.name, base: data.base, name, change, createdAt: Date.now() });
    return { ok: true as const, id, name };
  });

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
      /** Saved variants, runnable as `~id`. */
      variants: (await evals.listVariants(o.owner, o.name)).map((v) => ({
        id: v.id,
        name: v.name,
        base: v.base,
        note: v.change.model ? `model ${v.change.model}` : v.change.effort ? `${v.change.effort} reasoning effort` : `adds: ${v.change.addInstructions}`,
      })),
      /** What a variant may switch to. */
      // Models an agent can run on: the catalog also lists image, speech,
      // embedding and video models, which have no place in a chat turn.
      models: (await getLatch()).models
        .map((m) => m.id)
        .filter((id) => !/image|embedding|tts|veo|lyria|realtime|-live|computer-use|deep-research|translate|audio|-codex/.test(id)),
      model: rec.modelId,
      effort: rec.exec?.effort ?? null,
    };
  });

export const estimateRunFn = createServerFn({ method: "POST" })
  .validator((d: RunRequest) => d)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "Sign in again." };
    const p = await planRun(principal, data);
    if (!p.ok) return p;
    return { ok: true as const, estimate: p.estimate, same: p.same, reusable: p.reusable, confirmTwiceAbove: CONFIRM_TWICE_ABOVE };
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
/** What answering again would cost: one more try per answer, into the runs they came from. */
export const estimateAgainFn = createServerFn({ method: "POST" })
  .validator((d: AgainRequest) => d)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "Sign in again." };
    const p = await planAgain(principal, data);
    if (!p.ok) return p;
    return {
      ok: true as const,
      estimate: p.estimate,
      skipped: p.targets.filter((t) => !t.ok).map((t) => ({ version: t.version, error: t.error })),
      confirmTwiceAbove: CONFIRM_TWICE_ABOVE,
    };
  });

export const startAgainFn = createServerFn({ method: "POST" })
  .validator((d: AgainRequest & { confirmedCost: number | null }) => d)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "Sign in again." };
    return startAgain(principal, data, data.confirmedCost);
  });

export const startJudgeFn = createServerFn({ method: "POST" })
  .validator((d: { agent: string; datasetId: string; rubricId: string; runId: string; threadIds?: string[] }) => d)
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
      inputIds: j.inputIds,
      repeats: j.repeats,
      cost: j.estimate.cost,
      compareWith: j.compareWith ?? null,
      /** Answering again into an existing run, rather than a run of its own. */
      again: !!j.tryOf,
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
