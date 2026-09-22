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
import type { Rubric, ThreadRef } from "./evals/v2/model";
import { compareVersions, summarize } from "./evals/v2/runner";
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
    const rubric = await evals.getRubric(o.owner, data.rubricId);
    if (!rubric) return null;
    const threads = await evals.listThreads(o.owner, { datasetId: data.datasetId, runId: data.runId });
    const ids = threads.map((t) => t.threadId);
    const verdicts = await evals.listVerdicts({ threadIds: ids, rubricVersion: rubric.version });
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
