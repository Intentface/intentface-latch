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
import type { Check } from "./evals/v2/model";
import type { Change } from "./candidates";
import { fromEditable, toEditable, validateChecks } from "./evals/v2/validate";
import { CONFIRM_TWICE_ABOVE } from "./evals/v2/jobs";
import { planAgain, planRun, startAgain, startJudgeJob, startPlannedRun, tryCheck } from "./evals-jobs";
import { computeGrid } from "./evals-grid";
import type { ResultRef } from "./evals-grid";
import { createCandidate, createChecks, createQuestionSet, editInputFiles, editQuestions } from "./evals-actions";
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
    // Runs file answers under ids (`@c_…`); what people call each is its title.
    const { candidatesOf, titleOf } = await import("./candidates");
    const candidates = (await candidatesOf(principal, o.name, { closed: true }))?.candidates ?? [];
    return {
      datasets: await Promise.all(
        datasets.map(async (d) => ({
          id: d.id,
          name: d.name,
          inputs: (await evals.listInputs(d.owner, d.id)).length,
          runs: (await evals.listRuns(o.owner, d.id)).map((r) => ({ ...r, names: Object.fromEntries(r.versions.map((v) => [v, titleOf(v, candidates)])) as Record<string, string> })),
          views: (await evals.listViews(d.owner, d.id)).map((v) => ({ id: v.id, name: v.name, tags: v.tags })),
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
    const input = t.datasetId && t.inputId ? (await evals.listInputs(t.owner, t.datasetId)).find((i) => i.id === t.inputId) : undefined;
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
      questions: (await evals.listInputs(d.owner, d.id)).map((i) => ({
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
    const filesOf = new Map((await evals.listInputs(d.owner, d.id)).map((i) => [i.id, i.files]));
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
    await evals.setInputs(d.owner, d.id, valid.value);
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
    // Built-in tools (sandbox, default tools, web, memory…) are callable too.
    const { builtInToolsOf } = await import("./agent-tools");
    const builtIn = rec ? builtInToolsOf(rec).map((b) => b.name) : [];
    const names = [...new Set([...seen.keys(), ...enabled, ...builtIn])].sort();
    return names.map((name) => ({
      name,
      called: seen.has(name),
      builtIn: builtIn.includes(name),
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

/**
 * A candidate with one thing changed from a base — the model, the reasoning
 * effort or a line of instructions — to run as its own column. The same
 * change on the same base is the same candidate, so running it again reuses
 * its answers. It opens in the agent editor like any other.
 */
export const createCandidateFn = createServerFn({ method: "POST" })
  .validator((d: { agent: string; base: string; change: Change; name?: string }) => d)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "Sign in again." };
    return createCandidate(principal, data);
  });

/** Rename a candidate from its column — the editor shows the new name too. */
export const renameCandidateFn = createServerFn({ method: "POST" })
  .validator((d: { agent: string; label: string; name: string }) => d)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "Sign in again." };
    const { agentStore } = await getLatch();
    const rec = await agentStore.getRecord(principal, normalizeAgentName(data.agent));
    if (!rec) return { ok: false as const, error: "Only agents you can edit." };
    const { renameCandidate } = await import("./candidates");
    return renameCandidate(principal, rec.name, rec.scope, data.label.replace(/^@/, ""), data.name);
  });

/**
 * Make a column's configuration what people get: a candidate is published as
 * the next version (refused once if someone published since it was started,
 * unless `force`); an older version is made live again, appending nothing.
 */
export const makeLiveFn = createServerFn({ method: "POST" })
  .validator((d: { agent: string; label: string; force?: boolean; message?: string }) => d)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "Sign in again." };
    const { agentStore } = await getLatch();
    const rec = await agentStore.getRecord(principal, normalizeAgentName(data.agent));
    if (!rec) return { ok: false as const, error: "Only agents you can edit." };
    const { publishRecord, liveVersionOf } = await import("./candidates");
    const pinned = /^@(\d+)$/.exec(data.label);
    if (pinned) {
      const n = Number(pinned[1]);
      if ((await liveVersionOf(principal, rec.name, rec.scope)) === n) return { ok: true as const, version: n };
      await agentStore.activateVersion(principal, rec.name, rec.scope, n, { actor: principal.userId });
      return { ok: true as const, version: n };
    }
    const c = await agentStore.getCandidate(principal, rec.name, rec.scope, data.label.replace(/^@/, ""));
    if (!c) return { ok: false as const, error: "Only a published version or a candidate can be made live." };
    if (c.closedAt) return { ok: false as const, error: c.publishedAs ? `Already published as v${c.publishedAs}.` : "This candidate was discarded." };
    return publishRecord(principal, {
      record: c.record,
      message: data.message ?? `Published “${c.title}” from Evals`,
      ...(c.baseVersion != null ? { baseVersion: c.baseVersion } : {}),
      force: data.force,
      candidateId: c.id,
    });
  });

/** What a new run can be made of: live, the candidates, past versions — and the questions. */
export const getRunOptionsFn = createServerFn({ method: "GET" })
  .validator((d: { agent: string; datasetId: string }) => d)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return null;
    const o = await ownerFor(principal, data.agent);
    if (!o) return null;
    const { evals, agentStore } = await getLatch();
    const { candidatesOf } = await import("./candidates");
    const found = await candidatesOf(principal, o.name);
    if (!found) return null;
    const { rec, candidates, liveVersion } = found;
    const [history, inputs] = await Promise.all([agentStore.listVersions(principal, o.name, rec.scope), evals.listInputs(o.owner, data.datasetId)]);
    // Say which listed configuration IS live: picking both compares it with itself.
    const livePrint = configFingerprint(rec);
    const recent = history.slice().sort((a, b) => b.version - a.version).filter((v) => v.version !== liveVersion).slice(0, 12);
    const prints = await Promise.all(
      recent.map(async (v) => {
        const r = await agentStore.getVersion(principal, o.name, rec.scope, v.version);
        return r ? configFingerprint(r) : null;
      }),
    );
    const me = agentOwnerKey(principal, "user");
    return {
      versions: [
        { label: "live", title: liveVersion == null ? "live" : `live · @${liveVersion}`, kind: "live" as const, note: "what users get now" },
        ...candidates.map((c) => ({
          label: `@${c.id}`,
          title: c.title,
          kind: "candidate" as const,
          note: configFingerprint(c.record) === livePrint ? "same as live — no changes yet" : c.author === me ? "your candidate" : "a teammate's candidate",
        })),
        ...recent.map((v, i) => ({
          label: `@${v.version}`,
          title: `@${v.version}`,
          kind: "version" as const,
          note: prints[i] === livePrint ? "same as live" : (v.message ?? (v.changedFields?.length ? `changed ${v.changedFields.join(", ")}` : "")),
        })),
      ],
      questions: inputs.map((i) => ({ id: i.id, prompt: i.prompt })),
      /** What a new candidate may switch to. */
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
 * Price every configuration at once, for the Run menu: what running it on
 * every input would cost, or — when that exact configuration already
 * answered them — that it's free to show those answers instead.
 */
export const priceRunsFn = createServerFn({ method: "POST" })
  .validator((d: { agent: string; datasetId: string; rubricId: string; labels: string[]; repeats: number; inputIds?: string[] }) => d)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return null;
    const o = await ownerFor(principal, data.agent);
    if (!o) return null;
    const { evals } = await getLatch();
    // A view runs its own inputs; otherwise every input.
    const all = (await evals.listInputs(o.owner, data.datasetId)).map((i) => i.id);
    const inputIds = data.inputIds?.length ? all.filter((id) => data.inputIds!.includes(id)) : all;
    const out = [];
    for (const label of data.labels) {
      const p = await planRun(principal, { agent: data.agent, datasetId: data.datasetId, rubricId: data.rubricId, versions: [label], inputIds, repeats: data.repeats });
      out.push(
        p.ok
          ? { label, ok: true as const, filedAs: p.versions[0].label, cost: p.estimate.cost, basis: p.estimate.basis, answers: p.estimate.agentRuns, reuse: p.reusable[0] ?? null }
          : { label, ok: false as const, error: p.error },
      );
    }
    return { inputIds, limit: CONFIRM_TWICE_ABOVE, prices: out };
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
  .validator((d: { agent: string; datasetId: string; rubricId: string; runId: string; threadIds?: string[]; regrade?: boolean }) => d)
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


/** Grade a few recent answers with an unsaved check — the judge only, cents. */
export const tryCheckFn = createServerFn({ method: "POST" })
  .validator((d: { agent: string; datasetId: string; rubricId: string; check: string; inputId?: string }) => d)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "Sign in again." };
    let check: Check;
    try {
      check = JSON.parse(data.check) as Check;
    } catch {
      return { ok: false as const, error: "That check could not be read." };
    }
    return tryCheck(principal, { agent: data.agent, datasetId: data.datasetId, rubricId: data.rubricId, check, ...(data.inputId ? { inputId: data.inputId, n: 10 } : {}) });
  });

/** Move one input's judge question to the checks every input gets. */
export const promoteJudgedFn = createServerFn({ method: "POST" })
  .validator((d: { agent: string; datasetId: string; rubricId: string; inputId: string; index: number }) => d)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "Sign in again." };
    const { promoteJudged } = await import("./evals-actions");
    return promoteJudged(principal, data);
  });

export const saveViewFn = createServerFn({ method: "POST" })
  .validator((d: { agent: string; datasetId: string; id?: string; name: string; tags: string[] }) => d)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "Sign in again." };
    const { saveView } = await import("./evals-actions");
    return saveView(principal, data);
  });

export const removeViewFn = createServerFn({ method: "POST" })
  .validator((d: { agent: string; datasetId: string; id: string }) => d)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "Sign in again." };
    const { removeView } = await import("./evals-actions");
    return removeView(principal, data);
  });
