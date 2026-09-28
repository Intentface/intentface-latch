/**
 * The comparison grid: any results — one version's answers in one run —
 * compared question by question against the first, the baseline. Shared by
 * the Results page and the Evals agent's compare_results, so both see the
 * same numbers. Server-only: evals-server.ts imports it inside a handler.
 */
import type { Principal } from "./session";
import { getLatch } from "./latch";
import { agentOwnerKey, normalizeAgentName } from "./agent-store";
import type { Rubric, ThreadRef, Verdict } from "./evals/v2/model";
import { compareVersions, summarize } from "./evals/v2/runner";
import { thresholdFor, trustOf } from "./evals/v2/alignment";
import { describeCounted } from "./evals/v2/counted";

export type ResultRef = { runId: string; version: string };

async function ownerFor(principal: Principal, agent: string) {
  const { agentStore } = await getLatch();
  const rec = await agentStore.getRecord(principal, normalizeAgentName(agent));
  return rec ? { owner: agentOwnerKey(principal, rec.scope), name: rec.name } : null;
}

/** A check as a sentence; a per-question value reads as what it is, not as template syntax. */
const sentence = (c: Rubric["checks"][number]) =>
  c.kind === "asked"
    ? c.ask
    : describeCounted(c).replace(/"?\{\{facts\.(\w+)\}\}"?/g, (_, k: string) => (k === "docs" ? "the document the question names" : `the question's ${k}`));

/** A check that reads what each input says for itself — its good answer, its document, its lists. */
function readsOf(c: Rubric["checks"][number]): "answer" | "calls" | "says" | null {
  if (c.kind === "counted") return c.spec.op === "expected_calls" ? "calls" : null;
  if (c.fromInput === "says") return "says";
  return /REFERENCE_ANSWER/.test(c.ask) ? "answer" : null;
}

export async function computeGrid(
  principal: Principal,
  data: { agent: string; datasetId: string; rubricId: string; runId?: string; columns?: ResultRef[] },
) {    const o = await ownerFor(principal, data.agent);
    if (!o) return null;
    const { evals } = await getLatch();
    const latest = await evals.getRubric(o.owner, data.rubricId);
    if (!latest) return null;
    const runs = await evals.listRuns(o.owner, data.datasetId);

    // Columns: as asked, or every version of one run (the latest by default).
    let columns: ResultRef[] = (data.columns ?? []).filter((c) => runs.some((r) => r.runId === c.runId && r.versions.includes(c.version)));
    if (!columns.length) {
      // By default the newest COMPLETE run: one that was stopped, or answered
      // only a few inputs, is a poor thing to land on.
      const size = (await evals.listInputs(data.datasetId)).length;
      // A set grows after a run, so "complete" is nearly every input it has now.
      const complete = runs.find((r) => r.questions >= Math.floor(size * 0.9) && r.threads >= r.versions.length * r.questions);
      const run = runs.find((r) => r.runId === data.runId) ?? complete ?? runs.at(0);
      if (!run) return null;
      const order = (v: string) => (v === "live" ? "" : v);
      columns = [...run.versions].sort((a, b) => order(a).localeCompare(order(b))).map((version) => ({ runId: run.runId, version }));
    }
    // The same result twice is one column.
    const asked = columns;
    columns = asked.filter((c, i) => asked.findIndex((x) => x.runId === c.runId && x.version === c.version) === i);
    const shown = columns;
    const crossRun = new Set(columns.map((c) => c.runId)).size > 1;
    const runOf = new Map(runs.map((r) => [r.runId, r]));
    const when = (at: number) => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const time = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    // Across runs a column needs its run in its name; within one, the version
    // is enough. Everything is keyed by the label, so two runs of one version
    // on one day get their time too — or their answers merge into one column.
    const short = (c: ResultRef) => {
      if (!crossRun) return c.version;
      const r = runOf.get(c.runId)!;
      return `${c.version} · ${r.name ?? when(r.createdAt)}`;
    };
    const clash = (c: ResultRef) => shown.filter((x) => short(x) === short(c)).length > 1;
    const labelOf = (c: ResultRef) => (clash(c) ? `${short(c)}, ${time(runOf.get(c.runId)!.createdAt)}` : short(c));

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
    // What each column cost to answer — from the runs its threads made.
    const costs = await evals.threadCosts(threads.map((t) => t.threadId));
    // Which configuration answered — two columns with the same one differ only by chance.
    const setupOf = (label: string) => {
      const fp = threads.find((t) => t.version === label)?.configFingerprint;
      if (!fp) return null;
      let h = 5381;
      for (let i = 0; i < fp.length; i++) h = ((h << 5) + h + fp.charCodeAt(i)) | 0;
      return (h >>> 0).toString(36);
    };
    const spentOf = (label: string) => threads.filter((t) => t.version === label).reduce((a, t) => a + (costs.get(t.threadId) ?? 0), 0);

    return {
      runId: columns[0].runId,
      crossRun,
      columns: columns.map((c, i) => {
        const r = runOf.get(c.runId)!;
        return { ...c, label: labels[i], runName: r.name, at: r.createdAt, judgedWith: judgedWith[i], spent: spentOf(labels[i]), setup: setupOf(labels[i]), config: threads.find((t) => t.version === labels[i])?.configFingerprint ?? null };
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
          /** Which of an input's own expectations this check reads, if any. */
          reads: readsOf(c),
          judge: c.kind === "counted" ? "counted" : (c.judge ?? rubric.defaultJudge),
          cells: summaries.map((s) => s.checks.find((k) => k.checkId === c.id)!),
          /** Baseline vs the second column — what the summary sentence reads. */
          compare: labels[1] ? (changes.get(labels[1])?.find((x) => x.checkId === c.id) ?? null) : null,
          /** Baseline vs each other column, by column label. */
          changes: Object.fromEntries(labels.slice(1).map((l) => [l, changes.get(l)?.find((x) => x.checkId === c.id) ?? null])),
          trust: trust.find((t) => t.checkId === c.id) ?? null,
          accept: th.accept,
          /** What the judge returns: yes/no, one of a set, or a score — JEV's output types. */
          type: c.kind === "counted" ? ("rule" as const) : c.shape.type === "boolean" ? ("yes/no" as const) : c.shape.type,
          /** A scale check's rungs, lowest first, and how many from the bottom fail. */
          scale: c.kind === "asked" && c.shape.type === "score" ? { levels: c.shape.levels.map((l) => l.name), bad: c.shape.bad ?? 0 } : null,
          /** Every label the judge can give, what each means, and whether it fails — for choice and score checks. */
          labels:
            c.kind !== "asked"
              ? null
              : c.shape.type === "choice"
                ? Object.entries(c.shape.options).map(([id, means]) => ({ id, means, fails: (c.shape as { bad: string[] }).bad.includes(id) }))
                : c.shape.type === "score"
                  ? c.shape.levels.map((l, n) => ({ id: l.name, means: l.means, fails: n <= ((c.shape as { bad?: number }).bad ?? 0) }))
                  : null,
        };
      }),
      /** The questions, in the set's order, with what each says a good answer holds. */
      inputs: [...inputs.values()].map((i) => ({
        id: i.id,
        prompt: i.prompt,
        followUps: i.followUps ?? [],
        answer: typeof i.facts?.answer === "string" ? i.facts.answer : null,
        mustNot: Array.isArray(i.facts?.mustNot) ? i.facts.mustNot.map(String) : [],
        mustSay: Array.isArray(i.facts?.mustSay) ? i.facts.mustSay.map(String) : [],
        asks: Array.isArray(i.facts?.asks) ? i.facts.asks.map(String) : [],
        decline: i.facts?.decline === true,
        calls: Array.isArray(i.facts?.calls) ? i.facts.calls : [],
        judged: Array.isArray(i.facts?.judged) ? i.facts.judged : [],
        /** What's attached — never the contents, which can be megabytes. */
        files: (i.files ?? []).map((f) => ({ filename: f.filename, mediaType: f.mediaType, size: f.size })),
      })),
      /** Every answer shown, so a cell knows its tries and whether one broke. */
      threads: threads.map((t) => ({ threadId: t.threadId, column: t.version, inputId: t.inputId ?? "", attempt: t.attempt ?? 0, error: t.error ?? null })),
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
          score: v.score ?? null,
          escalatedTo: v.escalatedTo ?? null,
          probabilities: v.probabilities ?? null,
          ruling: rulingOf.get(`${v.threadId}|${v.checkId}`) ?? null,
        };
      }),
    };
}
