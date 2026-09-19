import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { FlaskConical, Play, Plus, Sparkles, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  currentPrincipalFn,
  deleteEvalSetFn,
  getEvalSetFn,
  listAgentRecordsFn,
  listAgentVersionsFn,
  listEvalRunsFn,
  listEvalSetsFn,
  runEvalSetFn,
  saveEvalSetFn,
  connectionToolsFn,
  draftEvalCasesFn,
  correctEvalCheckFn,
  auditAgentFn,
} from "@/lib/server";
import { effectiveFailed, reliabilityOf } from "@/lib/evals/reliability";
import type { EvalCase, EvalRun, JsonValue } from "@/lib/evals/store";
import type { Question } from "@/lib/evals/ask";
import { compare, type Observation } from "@/lib/evals/stats";
import { Button } from "@/components/ui/button";

/**
 * EXPERIMENTAL. The per-input tier of evals, which has had no page until now.
 *
 * A RUBRIC (the agent page's drawer) is one question asked of every input:
 * "is every claim supported by a document it opened?". A CASE is one input
 * with expectations for THAT input: "asked about VPC limits → must open
 * docs/networking/vpc-limits.md". Only the case tier can say that different
 * questions should read different documents, because only it knows what was
 * asked — which is the whole reason this page exists separately.
 *
 * Runs are pinned to a configuration (`live`, a version, or your draft) and
 * never activate it, so measuring a version cannot move production traffic.
 */
export const Route = createFileRoute("/evals")({
  head: () => ({ meta: [{ title: "Evals · Latch" }] }),
  beforeLoad: async () => {
    if (!(await currentPrincipalFn())) throw redirect({ to: "/login" });
  },
  loader: async () => {
    // Records rather than the agent list: only editable (DB-stored) agents can
    // have an eval set, and a record carries the scope `listVersions` needs.
    const [sets, agents] = await Promise.all([listEvalSetsFn(), listAgentRecordsFn()]);
    return { sets, agents };
  },
  component: EvalsPage,
});

const newCase = (n: number): EvalCase => ({
  id: `case-${n}`,
  name: "",
  input: "",
  expected: {},
});

/** "read_file, search" → the tool names, trimmed and de-duplicated. */
const parseList = (text: string): string[] =>
  [...new Set(text.split(",").map((s) => s.trim()).filter(Boolean))];

/**
 * One expected call per line: `tool` or `tool key=value, key=value`.
 *
 * Deliberately not tied to any particular argument name. An earlier version of
 * this form assumed `path`, which quietly encoded one example agent's document
 * tool into the UI — every other agent's tools (`fetch_top_hn_posts({limit:5})`)
 * could not be expressed at all. Args are matched as a SUBSET of the real call,
 * so naming one key is enough.
 */
function parseExpectedTools(text: string): EvalCase["expected"]["toolCalls"] {
  const rows = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [tool, ...rest] = line.split(/\s+/);
      const args: Record<string, JsonValue> = {};
      for (const pair of rest.join(" ").split(",")) {
        const [k, ...v] = pair.split("=");
        const key = k?.trim();
        const raw = v.join("=").trim();
        if (!key || !raw) continue;
        // Numbers and booleans compare as themselves; everything else is text.
        args[key] = raw === "true" ? true : raw === "false" ? false : Number.isFinite(Number(raw)) ? Number(raw) : raw;
      }
      return Object.keys(args).length ? { tool: tool!, args } : { tool: tool! };
    });
  return rows.length ? rows : undefined;
}

const renderExpectedTools = (calls: EvalCase["expected"]["toolCalls"]): string =>
  (calls ?? [])
    .map((c) => {
      const args = Object.entries(c.args ?? {})
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(", ");
      return args ? `${c.tool} ${args}` : c.tool;
    })
    .join("\n");

function EvalsPage() {
  const { sets, agents } = Route.useLoaderData();
  const editable = agents;
  const scopeOf = useMemo(
    () => new Map(agents.map((a) => [a.name, a.scope])),
    [agents],
  );

  const [agent, setAgent] = useState(sets[0]?.agentName ?? editable[0]?.name ?? "");
  const [setName, setSetName] = useState(sets[0]?.name ?? "default");
  const [cases, setCases] = useState<EvalCase[]>([]);
  const [versions, setVersions] = useState<{ version: number; createdAt: number }[]>([]);
  const [pin, setPin] = useState<string>("live");
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [tools, setTools] = useState<string[]>([]);
  const [brief, setBrief] = useState("");
  const [audit, setAudit] = useState<
    { judged: number; promises: { id: string; ask: string; type: string; broken: number; rate: number; examples: string[] }[] } | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!agent) return;
    setLoaded(false);
    const [set, vs, rs, ts] = await Promise.all([
      getEvalSetFn({ data: { agent, name: setName } }),
      listAgentVersionsFn({ data: { name: agent, scope: scopeOf.get(agent) ?? "user" } }).catch(
        () => [],
      ),
      listEvalRunsFn({ data: { agent, name: setName, limit: 10 } }),
      // The agent's REAL tools, so the editor's hints describe this agent
      // rather than whichever one the form was first written against.
      connectionToolsFn({ data: agents.find((a) => a.name === agent)?.connections ?? [] }).catch(
        () => [],
      ),
    ]);
    setCases(set?.cases ?? []);
    setVersions(vs as { version: number; createdAt: number }[]);
    setRuns(rs as EvalRun[]);
    setTools((ts as { name: string }[]).map((t) => t.name));
    setLoaded(true);
  }, [agent, setName, scopeOf, agents]);

  useEffect(() => {
    void load();
  }, [load]);

  // Hints come from the agent in front of you, never from an example.
  const toolHint = tools.length ? `${tools[0]} key=value` : "tool_name key=value";
  const forbidHint = tools.length > 1 ? tools[1]! : "tool_name";

  const runAudit = async () => {
    setBusy(true);
    const res = await auditAgentFn({ data: { agent } });
    setBusy(false);
    if (!res.ok) return toast.error(res.error);
    setAudit({ judged: res.judged, promises: res.promises });
  };

  const generate = async () => {
    setBusy(true);
    const res = await draftEvalCasesFn({ data: { agent, brief } });
    setBusy(false);
    if (!res.ok) return toast.error(res.error);
    // Drafts land UNSAVED, appended: reviewing and cutting is the job.
    setCases((cs) => [...cs, ...res.cases]);
    toast.success(`Drafted ${res.cases.length} case${res.cases.length === 1 ? "" : "s"} — review and save`);
  };

  const update = (i: number, patch: Partial<EvalCase>) =>
    setCases((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const updateExpected = (i: number, patch: Partial<EvalCase["expected"]>) =>
    setCases((cs) => cs.map((c, j) => (j === i ? { ...c, expected: { ...c.expected, ...patch } } : c)));

  const save = async () => {
    setBusy(true);
    const res = await saveEvalSetFn({ data: { agent, name: setName, cases } });
    setBusy(false);
    if (!res.ok) return toast.error(res.error);
    toast.success(`Saved ${cases.length} case${cases.length === 1 ? "" : "s"}`);
  };

  const run = async () => {
    setBusy(true);
    const version = pin === "live" ? undefined : pin === "draft" ? ("draft" as const) : Number(pin);
    const res = await runEvalSetFn({ data: { agent, name: setName, version } });
    setBusy(false);
    if (!res.ok) return toast.error(res.error);
    toast.success(`${res.ref}: ${res.run.passCount} passed, ${res.run.failCount} failed`);
    setRuns((r) => [res.run as EvalRun, ...r]);
  };

  const remove = async () => {
    if (!confirm(`Delete eval set "${setName}"?`)) return;
    const res = await deleteEvalSetFn({ data: { agent, name: setName } });
    if (!res.ok) return toast.error(res.error);
    setCases([]);
    toast.success("Deleted");
  };

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <div className="flex items-center gap-2">
        <FlaskConical className="size-5" />
        <h1 className="text-lg font-semibold">Evals</h1>
        <span className="text-ink-tertiary text-xs">experimental</span>
      </div>

      <p className="text-ink-tertiary max-w-2xl text-sm">
        A case is one input plus what should happen for <em>that</em> input — which documents it
        should open, which tools it must not call. Runs are pinned to a configuration and never
        make it live.
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <label className="text-ink-tertiary text-xs">
          Agent
          <select
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
            className="border-secondary-border text-ink-primary ml-2 rounded border bg-transparent px-2 py-1 text-xs"
          >
            {editable.map((a) => (
              <option key={a.name} value={a.name}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-ink-tertiary text-xs">
          Set
          <input
            value={setName}
            onChange={(e) => setSetName(e.target.value)}
            className="border-secondary-border text-ink-primary ml-2 rounded border bg-transparent px-2 py-1 text-xs"
          />
        </label>
        <label className="text-ink-tertiary text-xs">
          Run against
          <select
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            className="border-secondary-border text-ink-primary ml-2 rounded border bg-transparent px-2 py-1 text-xs"
          >
            <option value="live">live</option>
            <option value="draft">draft</option>
            {versions.map((v) => (
              <option key={v.version} value={String(v.version)}>
                v{v.version}
              </option>
            ))}
          </select>
        </label>
        <Button onClick={run} disabled={busy || !cases.length} className="gap-1">
          <Play className="size-3.5" />
          Run
        </Button>
        <Button variant="secondary" onClick={save} disabled={busy}>
          Save
        </Button>
        <Button variant="ghost" onClick={remove} disabled={busy || !cases.length}>
          <Trash2 className="size-3.5" />
        </Button>
      </div>

      {/* FIRST, and before anything is authored: the agent's instructions already
          list what it promises, and its conversations are already stored. So
          the first number costs a few cents and no decision to start. Asking
          someone to write a suite before they have seen one is how eval tooling
          goes unused. */}
      <div className="border-secondary-border space-y-2 rounded border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={runAudit} disabled={busy || !agent} className="gap-1">
            <Sparkles className="size-3.5" />
            What does this agent promise?
          </Button>
          <span className="text-ink-tertiary text-xs">
            Reads its instructions, asks those questions of conversations it already had. No setup,
            nothing re-run.
          </span>
        </div>

        {audit && (
          <div className="space-y-1 pt-1">
            <div className="text-ink-tertiary text-xs">
              {audit.promises.length} promises, checked against {audit.judged} stored conversation
              {audit.judged === 1 ? "" : "s"}
              {audit.judged < 10 && " — too few to conclude anything; treat these as a first look"}
            </div>
            {audit.promises.map((p) => (
              <div key={p.id} className="flex items-start gap-2 text-xs">
                <span className={p.broken ? "text-red-500" : "text-emerald-600"}>
                  {p.broken ? "✗" : "✓"}
                </span>
                <span className="text-ink-primary w-56 shrink-0 truncate" title={p.ask}>
                  {p.id}
                </span>
                <span className="text-ink-tertiary w-24 shrink-0">
                  {p.broken}/{audit.judged} broken
                </span>
                <span className="text-ink-tertiary min-w-0 flex-1 truncate" title={p.ask}>
                  {p.ask}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border-secondary-border space-y-2 rounded border border-dashed p-3">
        <label className="text-ink-tertiary block text-xs">
          Describe what to test — the agent writes the cases, grounded in its real tools
          <textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            placeholder="It should always fetch before summarising, ask which region when the question is ambiguous, and never act on a destructive request without confirming."
            rows={2}
            className="border-secondary-border text-ink-primary mt-1 w-full resize-none rounded border bg-transparent p-2"
          />
        </label>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={generate} disabled={busy || !agent} className="gap-1">
            <Sparkles className="size-3.5" />
            Generate cases
          </Button>
          <span className="text-ink-tertiary text-xs">
            {tools.length ? `${tools.length} tools available to this agent` : "no connection tools"}
          </span>
        </div>
      </div>

      {!loaded && <p className="text-ink-tertiary text-sm">Loading…</p>}

      {loaded && (
        <div className="space-y-3">
          {cases.map((c, i) => (
            <div key={i} className="border-secondary-border space-y-2 rounded border p-3">
              <div className="flex items-center gap-2">
                <input
                  value={c.id}
                  onChange={(e) => update(i, { id: e.target.value })}
                  placeholder="stable-case-id"
                  className="border-secondary-border text-ink-primary w-48 rounded border bg-transparent px-2 py-1 text-xs"
                />
                <input
                  value={c.name}
                  onChange={(e) => update(i, { name: e.target.value })}
                  placeholder="what this checks"
                  className="border-secondary-border text-ink-primary min-w-0 flex-1 rounded border bg-transparent px-2 py-1 text-xs"
                />
                <button
                  type="button"
                  aria-label="Remove case"
                  onClick={() => setCases((cs) => cs.filter((_, j) => j !== i))}
                  className="text-ink-tertiary hover:text-ink-primary"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
              <Turns
                input={c.input}
                followUps={c.followUps ?? []}
                onChange={(input, followUps) =>
                  update(i, { input, followUps: followUps.length ? followUps : undefined })
                }
              />
              <div className="grid gap-2 md:grid-cols-2">
                <label className="text-ink-tertiary text-xs">
                  Exact — must call, <code>tool key=value</code> per line (free, no judge)
                  <textarea
                    value={renderExpectedTools(c.expected.toolCalls)}
                    onChange={(e) => updateExpected(i, { toolCalls: parseExpectedTools(e.target.value) })}
                    placeholder={toolHint}
                    rows={2}
                    className="border-secondary-border text-ink-primary mt-1 w-full resize-none rounded border bg-transparent p-2"
                  />
                </label>
                <label className="text-ink-tertiary text-xs">
                  Exact — must NOT call, comma separated
                  <input
                    value={(c.expected.forbiddenTools ?? []).join(", ")}
                    onChange={(e) =>
                      updateExpected(i, {
                        forbiddenTools: parseList(e.target.value).length
                          ? parseList(e.target.value)
                          : undefined,
                      })
                    }
                    placeholder={forbidHint}
                    className="border-secondary-border text-ink-primary mt-1 w-full rounded border bg-transparent p-2"
                  />
                </label>
              </div>
              {(c.expected.rubric?.length ?? 0) > 0 && (
                <p className="text-ink-tertiary text-xs">
                  Also carries {c.expected.rubric!.length} legacy plain-text criteri
                  {c.expected.rubric!.length === 1 ? "on" : "a"}, still judged on every run. Rewrite
                  them as checks below when convenient — they are boolean questions either way, and
                  as checks they can be a choice or a score instead.
                </p>
              )}
              <CheckBuilder
                checks={c.checks ?? {}}
                onChange={(checks) => update(i, { checks: Object.keys(checks).length ? checks : undefined })}
              />
            </div>
          ))}

          <Button
            variant="secondary"
            onClick={() => setCases((cs) => [...cs, newCase(cs.length + 1)])}
            className="gap-1"
          >
            <Plus className="size-3.5" />
            Add case
          </Button>
        </div>
      )}

      {runs.length > 0 && <ResultsGrid runs={runs} agent={agent} onCorrected={(r) => setRuns((rs) => rs.map((x) => (x.id === r.id ? r : x)))} />}
      {runs.length > 1 && (
        <CompareStrip
          base={[...runs].sort((a, b) => a.createdAt - b.createdAt)[0]!}
          head={[...runs].sort((a, b) => a.createdAt - b.createdAt).slice(-1)[0]!}
        />
      )}
    </div>
  );
}

/**
 * CHECKS down, runs across.
 *
 * The first version put cases on the rows, which quietly asserted that a case
 * is one test. It is not: a case is one input with as many checks as the
 * behaviour needs, and collapsing them to a single tick threw away the only
 * thing worth reading. "grounded-in-fetch regressed between v6 and v7" is
 * actionable; "case 2 failed" sends you clicking.
 *
 * A check is also the right unit for a COMPARISON, because it is the thing
 * with a stable identity across versions. The input can be rewritten and the
 * question still means what it meant.
 *
 * One table serves three jobs: one column is a result view, two are a
 * comparison, six are drift over time.
 */
function ResultsGrid({
  runs,
  agent,
  onCorrected,
}: {
  runs: EvalRun[];
  agent: string;
  onCorrected: (run: EvalRun) => void;
}) {
  // Oldest → newest, so a regression reads as a change moving rightwards.
  const columns = [...runs].sort((a, b) => a.createdAt - b.createdAt).slice(-6);
  const [open, setOpen] = useState<{ run: string; caseId: string } | null>(null);

  const resultFor = (run: EvalRun, caseId: string) => run.results.find((r) => r.caseId === caseId);

  /** Every (case, check) pair seen in any column, plus the case-level verdict. */
  type Row = { caseId: string; caseName?: string; checkId?: string };
  const rows: Row[] = [];
  for (const caseId of [...new Set(columns.flatMap((r) => r.results.map((x) => x.caseId)))]) {
    const any = columns.map((r) => resultFor(r, caseId)).find(Boolean);
    rows.push({ caseId, caseName: any?.caseName });
    for (const checkId of [
      ...new Set(
        columns.flatMap((r) => (resultFor(r, caseId)?.checks ?? []).map((c) => c.id)),
      ),
    ]) {
      rows.push({ caseId, checkId });
    }
  }

  /** The verdict in one column: the check's, or the whole case's. */
  const cell = (run: EvalRun, row: Row) => {
    const res = resultFor(run, row.caseId);
    if (!res) return undefined;
    if (!row.checkId)
      return { failed: !res.pass, label: res.pass ? "✓" : "✗", overruled: false, title: res.reasons.join("\n") };
    const chk = res.checks?.find((c) => c.id === row.checkId);
    if (!chk) return undefined;
    // The ANSWER, not a tick: on a choice question which option was selected
    // IS the diagnosis, and it is the same width as a tick anyway. Where a
    // human has ruled, THAT is the verdict — otherwise a correction would be
    // cosmetic and the grid would keep showing an answer already overruled.
    return {
      failed: effectiveFailed(chk),
      label: chk.answer,
      overruled: chk.human !== undefined && chk.human.failed !== chk.failed,
      title: chk.human
        ? `human says ${chk.human.failed ? "fail" : "pass"} · judge said ${chk.failed ? "fail" : "pass"} (${(chk.confidence * 100).toFixed(0)}%)`
        : `${(chk.confidence * 100).toFixed(0)}% confident`,
    };
  };

  const changed = (row: Row) => {
    const seen = columns.map((r) => cell(r, row)).filter(Boolean).map((c) => c!.label);
    return seen.length > 1 && new Set(seen).size > 1;
  };

  const detail = open ? resultFor(columns.find((c) => c.id === open.run)!, open.caseId) : undefined;

  return (
    <div className="space-y-2">
      <h2 className="text-sm font-medium">Results</h2>
      <div className="border-secondary-border overflow-x-auto rounded border">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-secondary-border border-b">
              <th className="text-ink-tertiary p-2 text-left font-normal">case / check</th>
              {columns.map((r) => (
                <th key={r.id} className="p-2 text-left font-normal">
                  <div className="text-ink-primary">{r.configRef ?? "live"}</div>
                  <div className="text-ink-tertiary">
                    {r.passCount}/{r.passCount + r.failCount} ·{" "}
                    {new Date(r.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={`${row.caseId}/${row.checkId ?? ""}`}
                className="border-secondary-border border-b last:border-0"
              >
                <td className={row.checkId ? "text-ink-tertiary py-1 pl-6 pr-2" : "text-ink-primary p-2"}>
                  {row.checkId ?? row.caseName ?? row.caseId}
                  {changed(row) && (
                    <span className="ml-1 rounded bg-amber-500/15 px-1 text-[10px] text-amber-600">
                      changed
                    </span>
                  )}
                </td>
                {columns.map((r) => {
                  const c = cell(r, row);
                  return (
                    <td key={r.id} className={row.checkId ? "py-1 px-2" : "p-2"}>
                      {!c ? (
                        // Absent is not failed: the case or check did not exist
                        // when this run happened, and must not look like a loss.
                        <span className="text-ink-tertiary">·</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setOpen({ run: r.id, caseId: row.caseId })}
                          className={`${c.failed ? "text-red-500" : "text-emerald-600"} ${c.overruled ? "underline decoration-dotted" : ""}`}
                          title={c.title || "passed"}
                        >
                          {c.label}
                        </button>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Reliability runs={runs} />

      {detail && (
        <div className="border-secondary-border space-y-2 rounded border p-3 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-ink-primary font-medium">{detail.caseName || detail.caseId}</span>
            <button type="button" onClick={() => setOpen(null)} className="text-ink-tertiary">
              close
            </button>
          </div>
          {detail.reasons.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-4 text-red-500">
              {detail.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
          {/* Ruling on a verdict is the only way to learn whether this question
              is one you may ever gate a release on, so it is one click from
              the failure itself rather than a separate review screen. */}
          {detail.checks?.length ? (
            <div className="space-y-1">
              {detail.checks.map((c) => (
                <div key={c.id} className="flex items-center gap-2">
                  <span className={effectiveFailed(c) ? "text-red-500" : "text-emerald-600"}>
                    {effectiveFailed(c) ? "✗" : "✓"}
                  </span>
                  <span className="text-ink-primary">{c.id}</span>
                  <span className="text-ink-tertiary">
                    {c.answer} ({(c.confidence * 100).toFixed(0)}%)
                  </span>
                  {c.human && (
                    <span className="text-amber-600">
                      {c.human.failed === c.failed ? "confirmed" : "corrected"}
                    </span>
                  )}
                  <span className="flex-1" />
                  <span className="text-ink-tertiary">judge right?</span>
                  {([false, true] as const).map((failed) => (
                    <button
                      key={String(failed)}
                      type="button"
                      onClick={async () => {
                        const res = await correctEvalCheckFn({
                          data: { agent, runId: open!.run, caseId: detail.caseId, checkId: c.id, failed },
                        });
                        if (!res.ok) return toast.error(res.error);
                        onCorrected(res.run as EvalRun);
                      }}
                      className={`rounded border px-1 ${
                        c.human?.failed === failed
                          ? "border-amber-500 text-amber-600"
                          : "border-secondary-border text-ink-tertiary hover:text-ink-primary"
                      }`}
                    >
                      {failed ? "should fail" : "should pass"}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          ) : null}

          {detail.toolCalls.length > 0 && (
            <div className="text-ink-tertiary">
              tools: {detail.toolCalls.map((t) => t.tool).join(", ")}
            </div>
          )}
          {detail.answerPreview && (
            <p className="text-ink-tertiary whitespace-pre-wrap">{detail.answerPreview}</p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Two columns, per check: the difference, and how sure we are of it.
 *
 * This is the one thing the table above communicates badly. A reader sees
 * "0.14 better" and acts on it; the same reader shown an interval that plainly
 * straddles zero does not. So the interval is the drawing and the number is
 * the caption, rather than the other way round.
 *
 * It will usually say UNDERPOWERED, and that is the feature. A handful of
 * cases cannot separate a real change from a coin flip, and a view that
 * rendered a confident bar over six observations would be a more convincing
 * way to be wrong than the table it replaced.
 */
function CompareStrip({ base, head }: { base: EvalRun; head: EvalRun }) {
  const observations: Observation[] = [];
  for (const run of [base, head]) {
    for (const res of run.results) {
      for (const chk of res.checks ?? []) {
        observations.push({
          // A check within a case is the pairing key: it keeps its meaning
          // across versions even when the input is reworded.
          task: `${res.caseId}/${chk.id}`,
          agent: run.id,
          value: chk.failed ? 1 : 0,
        });
      }
      // The case-level verdict too, so a case with no typed checks still
      // contributes something to the comparison.
      observations.push({ task: res.caseId, agent: run.id, value: res.pass ? 0 : 1 });
    }
  }
  const overall = compare(observations, base.id, head.id);

  const checks = [...new Set(observations.map((o) => o.task))].filter((t) => t.includes("/"));
  const rows = checks
    .map((task) => ({ task, r: compare(observations.filter((o) => o.task === task), base.id, head.id) }))
    // A per-check comparison over one task is never conclusive; sort the ones
    // that at least moved to the top rather than pretending otherwise.
    .sort((a, b) => Math.abs(b.r.delta) - Math.abs(a.r.delta));

  const tone: Record<string, string> = {
    regressed: "text-red-500",
    improved: "text-emerald-600",
    flat: "text-ink-tertiary",
    underpowered: "text-amber-600",
  };

  /** The interval, drawn across a track centred on zero. */
  const Interval = ({ lo, hi, delta }: { lo: number; hi: number; delta: number }) => {
    const pos = (v: number) => `${((Math.max(-1, Math.min(1, v)) + 1) / 2) * 100}%`;
    const crossesZero = lo <= 0 && hi >= 0;
    return (
      <div className="bg-secondary-border/40 relative h-2 w-36 rounded">
        <div className="bg-ink-tertiary/40 absolute inset-y-0 w-px" style={{ left: "50%" }} />
        <div
          className={`absolute inset-y-0 rounded ${crossesZero ? "bg-amber-500/40" : delta > 0 ? "bg-red-500/50" : "bg-emerald-500/50"}`}
          style={{ left: pos(lo), right: `calc(100% - ${pos(hi)})` }}
        />
        <div className="bg-ink-primary absolute inset-y-0 w-0.5" style={{ left: pos(delta) }} />
      </div>
    );
  };

  const pp = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(0)}pp`;

  return (
    <div className="space-y-2">
      <h2 className="text-sm font-medium">
        {base.configRef ?? "live"} → {head.configRef ?? "live"}
      </h2>
      <div className="border-secondary-border space-y-1 rounded border p-3 text-xs">
        <div className="flex items-center gap-3">
          <span className="w-44 font-medium">overall failure rate</span>
          <Interval lo={overall.ci[0]} hi={overall.ci[1]} delta={overall.delta} />
          <span className="w-16 text-right">{pp(overall.delta)}</span>
          <span className={tone[overall.verdict]}>{overall.verdict}</span>
          <span className="text-ink-tertiary">n={overall.n}</span>
        </div>
        {rows.map(({ task, r }) => (
          <div key={task} className="text-ink-tertiary flex items-center gap-3">
            <span className="w-44 truncate" title={task}>
              {task.split("/")[1]}
            </span>
            <Interval lo={r.ci[0]} hi={r.ci[1]} delta={r.delta} />
            <span className="w-16 text-right">{pp(r.delta)}</span>
            <span className={tone[r.verdict]}>{r.verdict}</span>
          </div>
        ))}
        {overall.verdict === "underpowered" && (
          <p className="text-ink-tertiary pt-1">
            Too few observations to separate a real change from noise. At this spread you would
            need a difference of about {pp(overall.mde)} to see it — add cases, or accept that
            this comparison cannot answer the question.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * A builder for the three evaluation primitives, rather than a box of prose.
 *
 * The previous editor offered "criteria in plain English, one per line", which
 * is a boolean question wearing a disguise: every line became a yes/no
 * judgment, and neither of the other two shapes could be expressed at all. A
 * failure with several distinct forms had to be flattened into one, which is
 * the exact loss the choice primitive exists to prevent.
 *
 * So the editor now mirrors the contract: pick the shape of the judgment, then
 * fill in what that shape needs. What you build here is the same object the
 * judge receives — no translation layer to get wrong, and the same questions
 * work unchanged on live traffic.
 */
function CheckBuilder({
  checks,
  onChange,
}: {
  checks: Record<string, Question>;
  onChange: (checks: Record<string, Question>) => void;
}) {
  const entries = Object.entries(checks);

  const setKey = (oldId: string, newId: string) => {
    if (!newId.trim() || (newId !== oldId && checks[newId])) return;
    // Rebuild in order so renaming an id does not reorder the list under the
    // cursor — ids are the pairing key for a comparison, so they get edited.
    onChange(Object.fromEntries(entries.map(([k, v]) => [k === oldId ? newId : k, v])));
  };
  const setQuestion = (id: string, q: Question) => onChange({ ...checks, [id]: q });
  const remove = (id: string) =>
    onChange(Object.fromEntries(entries.filter(([k]) => k !== id)));

  const add = (type: "boolean" | "choice" | "score") => {
    let n = entries.length + 1;
    while (checks[`check-${n}`]) n++;
    const id = `check-${n}`;
    const q: Question =
      type === "choice"
        ? { type: "choice", ask: "", options: { ok: "", not_ok: "" }, bad: ["not_ok"] }
        : type === "score"
          ? { type: "score", ask: "", levels: ["Clearly fails", "Partly", "Fully"], bad: 0 }
          : { ask: "" };
    onChange({ ...checks, [id]: q });
  };

  const field =
    "border-secondary-border text-ink-primary rounded border bg-transparent px-2 py-1 text-xs";

  return (
    <div className="space-y-2">
      <div className="text-ink-tertiary flex items-center gap-2 text-xs">
        <span>Checks — judged questions, one per behaviour</span>
        <span className="flex-1" />
        {(["boolean", "choice", "score"] as const).map((t) => (
          <button key={t} type="button" onClick={() => add(t)} className="hover:text-ink-primary underline">
            + {t}
          </button>
        ))}
      </div>

      {entries.map(([id, q]) => {
        const type = q.type ?? "boolean";
        return (
          <div key={id} className="border-secondary-border space-y-1 rounded border border-dashed p-2">
            <div className="flex items-center gap-2">
              <input
                value={id}
                onChange={(e) => setKey(id, e.target.value)}
                className={`${field} w-44`}
                placeholder="stable-check-id"
              />
              <span className="text-ink-tertiary text-xs">{type}</span>
              {type === "boolean" && (
                <label className="text-ink-tertiary flex items-center gap-1 text-xs">
                  fails when
                  <select
                    value={(q as { bad?: string }).bad ?? "false"}
                    onChange={(e) => setQuestion(id, { ...(q as object), ask: q.ask, bad: e.target.value as "true" | "false" } as Question)}
                    className={field}
                  >
                    <option value="false">no</option>
                    <option value="true">yes</option>
                  </select>
                </label>
              )}
              <span className="flex-1" />
              <button type="button" aria-label="Remove check" onClick={() => remove(id)} className="text-ink-tertiary hover:text-ink-primary">
                <Trash2 className="size-3.5" />
              </button>
            </div>

            <textarea
              value={q.ask}
              onChange={(e) => setQuestion(id, { ...(q as object), ask: e.target.value } as Question)}
              rows={2}
              placeholder={
                type === "choice"
                  ? "Describe the situation and ask what the agent did — do not restate the options."
                  : type === "score"
                    ? "Ask how well it did the thing; the rungs below say what each level looks like."
                    : "Ask so that YES is the good answer."
              }
              className="border-secondary-border text-ink-primary w-full resize-none rounded border bg-transparent p-2 text-xs"
            />

            {type === "choice" && (
              <ChoiceFields
                q={q as Extract<Question, { type: "choice" }>}
                onChange={(next) => setQuestion(id, next)}
              />
            )}
            {type === "score" && (
              <ScoreFields
                q={q as Extract<Question, { type: "score" }>}
                onChange={(next) => setQuestion(id, next)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** `name: meaning` per line; lines without a colon are dropped, not guessed. */
function parseOptionLines(text: string): Record<string, string> {
  const rows = text
    .split("\n")
    .map((l) => l.split(/:(.*)/s))
    .filter((parts) => parts.length > 1 && parts[0]!.trim())
    .map(([k, v]) => [k!.trim(), (v ?? "").trim()] as const);
  return Object.fromEntries(rows);
}

function ChoiceFields({
  q,
  onChange,
}: {
  q: Extract<Question, { type: "choice" }>;
  onChange: (q: Question) => void;
}) {
  const names = Object.keys(q.options);
  return (
    <div className="space-y-1">
      <textarea
        value={Object.entries(q.options).map(([k, v]) => `${k}: ${v}`).join("\n")}
        onChange={(e) => {
          const options = parseOptionLines(e.target.value);
          // Drop any "bad" naming an option that no longer exists, or the save
          // fails on a rule the editor could simply have kept true.
          onChange({ ...q, options, bad: q.bad.filter((b) => options[b] !== undefined) });
        }}
        rows={3}
        placeholder={"asked: Asked which region first\nguessed: Answered without saying which"}
        className="border-secondary-border text-ink-primary w-full resize-none rounded border bg-transparent p-2 text-xs"
      />
      <div className="text-ink-tertiary flex flex-wrap items-center gap-2 text-xs">
        <span>fails on</span>
        {names.length === 0 && <span>— add at least two options</span>}
        {names.map((name) => (
          <label key={name} className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={q.bad.includes(name)}
              onChange={(e) =>
                onChange({
                  ...q,
                  bad: e.target.checked ? [...q.bad, name] : q.bad.filter((b) => b !== name),
                })
              }
            />
            <code>{name}</code>
          </label>
        ))}
      </div>
      {names.length > 1 && (q.bad.length === 0 || q.bad.length === names.length) && (
        // All-bad can never pass and none-bad can never fail; either way the
        // check measures nothing, and it is cheaper to say so here.
        <p className="text-amber-600">Mark some — but not all — options as failures.</p>
      )}
    </div>
  );
}

function ScoreFields({
  q,
  onChange,
}: {
  q: Extract<Question, { type: "score" }>;
  onChange: (q: Question) => void;
}) {
  return (
    <div className="space-y-1">
      <textarea
        value={q.levels.join("\n")}
        onChange={(e) => {
          const levels = e.target.value.split("\n").map((l) => l.trim()).filter(Boolean);
          onChange({ ...q, levels, bad: Math.min(q.bad ?? 0, Math.max(0, levels.length - 2)) });
        }}
        rows={3}
        placeholder={"Clearly fails\nPartly satisfies\nFully satisfies"}
        className="border-secondary-border text-ink-primary w-full resize-none rounded border bg-transparent p-2 text-xs"
      />
      <label className="text-ink-tertiary flex items-center gap-1 text-xs">
        rungs worst → best; fails at or below
        <select
          value={String(q.bad ?? 0)}
          onChange={(e) => onChange({ ...q, bad: Number(e.target.value) })}
          className="border-secondary-border text-ink-primary rounded border bg-transparent px-2 py-1 text-xs"
        >
          {q.levels.slice(0, -1).map((l, i) => (
            <option key={i} value={String(i)}>
              {l || `level ${i}`}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

/**
 * The conversation a case sends, one message per turn.
 *
 * A single box said a case is one question, and the author duly worked around
 * it by packing two requests into one message — which tests whether the agent
 * can juggle a compound instruction, not whether it keeps its footing across a
 * conversation. Those are different behaviours and the second is where the
 * interesting failures are.
 */
function Turns({
  input,
  followUps,
  onChange,
}: {
  input: string;
  followUps: string[];
  onChange: (input: string, followUps: string[]) => void;
}) {
  const all = [input, ...followUps];
  const set = (i: number, text: string) => {
    const next = all.map((t, j) => (j === i ? text : t));
    onChange(next[0] ?? "", next.slice(1));
  };
  const remove = (i: number) => {
    const next = all.filter((_, j) => j !== i);
    onChange(next[0] ?? "", next.slice(1));
  };
  return (
    <div className="space-y-1">
      {all.map((text, i) => (
        <div key={i} className="flex items-start gap-2">
          <span className="text-ink-tertiary w-10 shrink-0 pt-2 text-xs">
            {i === 0 ? "user" : "then"}
          </span>
          <textarea
            value={text}
            onChange={(e) => set(i, e.target.value)}
            placeholder={i === 0 ? "The user message to send" : "…and then they say"}
            rows={2}
            className="border-secondary-border text-ink-primary min-w-0 flex-1 resize-none rounded border bg-transparent p-2 text-xs"
          />
          {i > 0 && (
            <button
              type="button"
              aria-label="Remove turn"
              onClick={() => remove(i)}
              className="text-ink-tertiary hover:text-ink-primary pt-2"
            >
              <Trash2 className="size-3.5" />
            </button>
          )}
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange(input, [...followUps, ""])}
        className="text-ink-tertiary hover:text-ink-primary ml-12 text-xs underline"
      >
        + follow-up turn
      </button>
    </div>
  );
}

/**
 * What the corrections have bought so far.
 *
 * Worst agreement first, because those are the questions to rewrite. A check
 * that nobody has ruled on does not appear at all: silence is not evidence in
 * either direction, and listing it at 100% would invent confidence.
 */
function Reliability({ runs }: { runs: EvalRun[] }) {
  const rows = reliabilityOf(runs);
  if (rows.length === 0) return null;
  return (
    <div className="space-y-1">
      <h3 className="text-ink-tertiary text-xs">
        Judge agreement — a check may only gate a release once it has earned it
      </h3>
      <div className="border-secondary-border divide-secondary-border divide-y rounded border text-xs">
        {rows.map((r) => (
          <div key={`${r.caseId}/${r.checkId}`} className="flex items-center gap-2 px-2 py-1">
            <span className="text-ink-primary w-56 truncate">{r.checkId}</span>
            <span className="text-ink-tertiary w-40 truncate">{r.caseId}</span>
            <span className={r.gating ? "text-emerald-600" : "text-ink-tertiary"}>
              {((r.agreement ?? 0) * 100).toFixed(0)}% over {r.labelled}
            </span>
            <span className="flex-1" />
            <span className={r.gating ? "text-emerald-600" : "text-amber-600"}>
              {r.gating ? "can gate" : "reports only"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
