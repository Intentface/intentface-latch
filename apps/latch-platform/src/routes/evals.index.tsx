import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { ChevronDown, ChevronUp, Loader2, X } from "lucide-react";
import { currentPrincipalFn } from "@/lib/server";
import { getEvalGridFn, getEvalThreadFn, getEvalsIndexFn, saveEvalRulingFn } from "@/lib/evals-server";
import type { EvalGrid } from "@/lib/evals-server";
import { EvalsEmpty, EvalsShell, Picker, useOverview, useSetSearch, validateEvalsSearch } from "@/components/evals/shell";
import { cn } from "@/lib/utils";
import { Select } from "@/components/ui/select";

/**
 * Evals: how each version of an agent does on a fixed set of questions, and
 * whether the judge that says so can be believed.
 *
 * One grid — checks down, versions across — because that is how a
 * spreadsheet person already reads a comparison. A cell opens a review panel
 * beside it: one thread at a time, P/F to make the call, J/K to move. Those
 * calls are what the Trust column is made of.
 *
 * Nothing here runs or judges. Both cost money and stay on the command line
 * (`pnpm evals`) until there is a cost guard in front of them.
 */

export const Route = createFileRoute("/evals/")({
  head: () => ({ meta: [{ title: "Evals · Latch" }] }),
  validateSearch: validateEvalsSearch,
  beforeLoad: async () => {
    const principal = await currentPrincipalFn();
    if (!principal) throw redirect({ to: "/login" });
  },
  loader: () => getEvalsIndexFn(),
  component: EvalsPage,
});

type Row = EvalGrid["verdicts"][number];
type Cell = { checkId: string; version: string };

function EvalsPage() {
  const index = Route.useLoaderData();
  const search = Route.useSearch();
  const set = useSetSearch();

  const agent = search.agent ?? index[0]?.agent;
  const [overview] = useOverview(agent);
  const [grid, setGrid] = useState<EvalGrid | null>(null);
  const [loading, setLoading] = useState(false);

  const dataset =
    overview?.datasets.find((d) => d.id === search.dataset) ??
    overview?.datasets.find((d) => d.runs.length) ??
    overview?.datasets[0];
  const rubricId = search.rubric ?? overview?.rubrics[0]?.id;
  const runId = search.run ?? dataset?.runs[0]?.runId;
  const run = dataset?.runs.find((r) => r.runId === runId);

  const reload = useCallback(() => {
    if (!agent || !dataset || !rubricId || !runId) return setGrid(null);
    setLoading(true);
    void getEvalGridFn({ data: { agent, datasetId: dataset.id, rubricId, runId } })
      .then(setGrid)
      .finally(() => setLoading(false));
  }, [agent, dataset, rubricId, runId]);
  useEffect(reload, [reload]);

  const open: Cell | null = search.check && search.version ? { checkId: search.check, version: search.version } : null;
  const toggle = (c: Cell) =>
    set(open?.checkId === c.checkId && open.version === c.version ? { check: undefined, version: undefined } : { check: c.checkId, version: c.version });

  if (!index.length) return <EvalsEmpty />;

  return (
    <div className="mx-auto max-w-[1400px] space-y-5 p-6">
      <EvalsShell page="results" index={index} search={search}>
        <Picker label="Questions">
          <Select
            id="evals-dataset"
            value={dataset?.id ?? ""}
            onChange={(e) => set({ dataset: e.target.value, run: undefined, check: undefined, version: undefined })}
          >
            {overview?.datasets.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.inputs})
              </option>
            ))}
          </Select>
        </Picker>
        <Picker label="Checks">
          <Select id="evals-rubric" value={rubricId ?? ""} onChange={(e) => set({ rubric: e.target.value })}>
            {overview?.rubrics.map((r) => (
              <option key={r.id} value={r.id}>
                {r.id}
              </option>
            ))}
          </Select>
        </Picker>
        <Picker label="Run">
          <Select id="evals-run" value={runId ?? ""} onChange={(e) => set({ run: e.target.value, check: undefined, version: undefined })}>
            {dataset?.runs.map((r) => (
              <option key={r.runId} value={r.runId}>
                {new Date(r.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} · {r.versions.join(" vs ")}
              </option>
            ))}
          </Select>
        </Picker>
        {loading && <Loader2 className="text-ink-tertiary mb-2 size-4 animate-spin" />}
      </EvalsShell>

      {overview && dataset && !dataset.runs.length && (
        <p className="text-ink-secondary text-sm">
          {dataset.name} has {dataset.inputs} questions but no runs yet. Start one with <code>pnpm evals run</code>.
        </p>
      )}
      {grid && grid.rubricVersion < grid.latestVersion && (
        <p className="text-ink-secondary text-sm">
          Showing checks v{grid.rubricVersion}. Version {grid.latestVersion} has not been judged on this run yet; run{" "}
          <code>pnpm evals judge</code> to score it.
        </p>
      )}

      {grid && run && (
        <div className={cn("grid items-start gap-5", open && "xl:grid-cols-[minmax(0,1fr)_420px]")}>
          <div className="min-w-0 space-y-4">
            <Verdict grid={grid} questions={dataset?.inputs ?? 0} />
            <Grid grid={grid} open={open} onOpen={toggle} />
          </div>
          {open && agent && (
            <Review
              key={`${open.checkId}|${open.version}|${grid.runId}`}
              agent={agent}
              grid={grid}
              cell={open}
              onClose={() => set({ check: undefined, version: undefined })}
              onRuled={reload}
            />
          )}
        </div>
      )}
    </div>
  );
}

const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0);

/** The one sentence a person wants before the grid: did the candidate win, and can we tell yet? */
function Verdict({ grid, questions }: { grid: EvalGrid; questions: number }) {
  const [a, b] = grid.versions;
  const paired = grid.checks[0]?.compare?.pairs ?? 0;
  const tries = `${paired || questions} question${paired === 1 ? "" : "s"}${grid.attempts > 1 ? ` × ${grid.attempts} tries` : ""}`;
  if (!b)
    return (
      <p className="text-ink-secondary text-sm">
        One version, <span className="text-ink-primary font-medium">{a}</span>, on {tries}.
      </p>
    );
  const moved = grid.checks.filter((c) => c.compare && c.compare.improved + c.compare.regressed > 0);
  const better = moved.filter((c) => c.compare!.improved > c.compare!.regressed);
  const worse = moved.filter((c) => c.compare!.regressed > c.compare!.improved);
  const real = moved.filter((c) => c.compare!.p < 0.05);
  const names = (cs: typeof moved) => cs.map((c) => c.label.toLowerCase()).join(", ");
  return (
    <div className="smooth-shadow-ring-xs smooth-ring-primary-border bg-primary-bg rounded-lg px-4 py-3 text-sm">
      <p className="text-ink-primary">
        <span className="font-medium">{b}</span> against <span className="font-medium">{a}</span>:{" "}
        {better.length ? <>better on {names(better)}</> : "better on nothing"}
        {worse.length ? <>; worse on {names(worse)}</> : "; worse on nothing"}.
      </p>
      <p className="text-ink-tertiary mt-0.5">
        {real.length
          ? `The change in ${names(real)} is larger than chance explains. `
          : "None of it is larger than chance explains yet — "}
        {tries}.{!real.length && paired < 15 && " Run more questions before deciding."}
      </p>
    </div>
  );
}

const TRUST: Record<string, { label: string; tone: string; means: string }> = {
  unknown: { label: "Not yet known", tone: "text-ink-tertiary", means: "Fewer than 20 of your calls: the number is the judge's word only." },
  trusted: { label: "Trusted", tone: "text-emerald-700 dark:text-emerald-400", means: "Agrees with your calls at least 9 times in 10." },
  gating: { label: "Can gate", tone: "text-emerald-700 dark:text-emerald-400", means: "50+ calls at 90%+ agreement: safe to block a publish on." },
  disputed: { label: "Disputed", tone: "text-amber-700 dark:text-amber-400", means: "You overrule this judge more than 1 time in 10. Reword the check." },
};

/** Per question, its attempts in order: the dot strip a cell draws. */
function strips(grid: EvalGrid): Map<string, { inputId: string; tries: boolean[] }[]> {
  const out = new Map<string, Map<string, boolean[]>>();
  for (const v of grid.verdicts) {
    const k = `${v.checkId}|${v.version}`;
    const byInput = out.get(k) ?? out.set(k, new Map()).get(k)!;
    const tries = byInput.get(v.inputId) ?? byInput.set(v.inputId, []).get(v.inputId)!;
    tries[v.attempt] = !v.failed;
  }
  return new Map(
    [...out].map(([k, m]) => [
      k,
      [...m]
        .sort(([x], [y]) => x.localeCompare(y, undefined, { numeric: true }))
        // Object.values skips the holes a missing attempt leaves.
        .map(([inputId, tries]) => ({ inputId, tries: Object.values(tries) })),
    ]),
  );
}

function Grid({ grid, open, onOpen }: { grid: EvalGrid; open: Cell | null; onOpen: (c: Cell) => void }) {
  const b = grid.versions[1];
  const dots = useMemo(() => strips(grid), [grid]);
  return (
    <div className="smooth-shadow-ring-xs smooth-ring-primary-border bg-primary-bg overflow-x-auto rounded-lg">
      <table className="w-full min-w-[620px] border-separate border-spacing-0 text-xs tabular-nums">
        <thead>
          <tr className="text-ink-secondary text-left">
            <th className="px-4 py-2.5 font-medium">Check</th>
            {grid.versions.map((v) => (
              <th key={v} className="px-3 py-2.5 font-medium">
                {v}
              </th>
            ))}
            {b && (
              <th className="px-3 py-2.5 font-medium" title="Question by question: how many passed more often (+) or less often (−)">
                Change
              </th>
            )}
            <th className="px-3 py-2.5 font-medium">Trust</th>
          </tr>
        </thead>
        <tbody>
          {grid.checks.map((c) => {
            const trust = TRUST[c.trust?.level ?? "unknown"];
            const ruled = c.trust?.ruled ?? 0;
            return (
              <tr key={c.id} className="align-top">
                <td className="border-primary-border w-[30%] border-t px-4 py-3">
                  <div className="text-ink-primary text-[13px] font-medium">{c.label}</div>
                  <div className="text-ink-tertiary mt-1 line-clamp-2" title={c.sentence}>
                    {c.sentence}
                  </div>
                  <div className="text-ink-tertiary mt-1">{c.kind === "counted" ? "Read from the tool log" : `Asked of ${c.judge}`}</div>
                </td>
                {c.cells.map((cell, i) => {
                  const version = grid.versions[i];
                  const active = open?.checkId === c.id && open.version === version;
                  return (
                    <td key={version} className="border-primary-border border-t p-1.5">
                      <button
                        type="button"
                        onClick={() => onOpen({ checkId: c.id, version })}
                        aria-pressed={active}
                        className={cn(
                          "hover:bg-primary-bg-hover focus-visible:ring-ring w-full rounded-md px-2.5 py-2 text-left outline-none focus-visible:ring-2",
                          active && "bg-primary-bg-active smooth-shadow-ring-xs smooth-ring-primary-border-active",
                        )}
                      >
                        <div className="flex items-baseline gap-1.5">
                          <span className="text-ink-primary text-base font-semibold">{cell.total ? `${pct(cell.passed, cell.total)}%` : "—"}</span>
                          <span className="text-ink-tertiary">
                            {cell.passed}/{cell.total}
                          </span>
                        </div>
                        <DotStrip questions={dots.get(`${c.id}|${version}`) ?? []} />
                        {grid.attempts > 1 && (
                          <div className="text-ink-tertiary mt-1.5 whitespace-nowrap">
                            {cell.allPassed} of {cell.inputs} every time
                          </div>
                        )}
                      </button>
                    </td>
                  );
                })}
                {b && (
                  <td className="border-primary-border border-t px-3 py-3.5">
                    {c.compare && c.compare.pairs ? (
                      <>
                        <div className="text-[13px] whitespace-nowrap">
                          <span className={c.compare.improved ? "text-emerald-700 dark:text-emerald-400" : "text-ink-tertiary"}>+{c.compare.improved}</span>{" "}
                          <span className={c.compare.regressed ? "text-red-600 dark:text-red-400" : "text-ink-tertiary"}>−{c.compare.regressed}</span>
                        </div>
                        <div className="text-ink-tertiary mt-1" title={`p = ${c.compare.p.toFixed(3)}`}>
                          {c.compare.p < 0.05 ? "real difference" : c.compare.improved + c.compare.regressed ? "could be chance" : "no change"}
                        </div>
                        <div className="text-ink-tertiary mt-0.5 whitespace-nowrap">
                          {Math.round(c.compare.rateA * 100)}% → {Math.round(c.compare.rateB * 100)}%
                        </div>
                      </>
                    ) : (
                      <span className="text-ink-tertiary">—</span>
                    )}
                  </td>
                )}
                <td className="border-primary-border border-t px-3 py-3.5" title={trust.means}>
                  <div className={cn("text-[13px] font-medium whitespace-nowrap", trust.tone)}>{trust.label}</div>
                  <div className="text-ink-tertiary mt-1 whitespace-nowrap">
                    {ruled < 20 ? `${ruled} of 20 calls` : `${pct(c.trust!.agreed, ruled)}% of ${ruled} agree`}
                  </div>
                  {ruled < 20 && (
                    <div className="bg-primary-border mt-1.5 h-1 w-20 overflow-hidden rounded-full">
                      <div className="bg-ink-tertiary h-full" style={{ width: `${(ruled / 20) * 100}%` }} />
                    </div>
                  )}
                  {!!c.trust?.falsePasses && (
                    <div className="mt-1 text-amber-700 dark:text-amber-400">passed {c.trust.falsePasses} you failed</div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {grid.errors.some((e) => e.errors) && (
        <p className="text-ink-tertiary border-primary-border border-t px-4 py-2 text-xs">
          {grid.errors
            .filter((e) => e.errors)
            .map((e) => `${e.version}: ${e.errors} thread${e.errors === 1 ? "" : "s"} failed to run and are left out`)
            .join(" · ")}
        </p>
      )}
    </div>
  );
}

/**
 * One cluster per question, one dot per try: filled passed, hollow failed.
 * A rate says how often; the strip says whether it is the same questions
 * failing every time or a coin toss everywhere, which a rate cannot.
 */
function DotStrip({ questions }: { questions: { inputId: string; tries: boolean[] }[] }) {
  return (
    <div className="mt-2 flex flex-wrap gap-x-1.5 gap-y-1" aria-hidden>
      {questions.map((q) => (
        <span key={q.inputId} className="flex gap-[2px]" title={`#${q.inputId}: ${q.tries.filter(Boolean).length} of ${q.tries.length}`}>
          {q.tries.map((ok, i) => (
            <span
              key={i}
              className={cn("size-[7px] rounded-full", ok ? "bg-ink-secondary" : "ring-ink-tertiary ring-1 ring-inset")}
            />
          ))}
        </span>
      ))}
    </div>
  );
}

// ─── Review ────────────────────────────────────────────────────────────────

/**
 * The threads behind one cell, one at a time. Unruled and least certain come
 * first: a call where the judge was unsure teaches the most about the judge.
 */
function Review({
  agent,
  grid,
  cell,
  onClose,
  onRuled,
}: {
  agent: string;
  grid: EvalGrid;
  cell: Cell;
  onClose: () => void;
  onRuled: () => void;
}) {
  const check = grid.checks.find((c) => c.id === cell.checkId);
  // Order is fixed when the panel opens, so a call does not reshuffle the list under the cursor.
  const [order] = useState(() =>
    grid.verdicts
      .filter((v) => v.checkId === cell.checkId && v.version === cell.version)
      .sort(
        (x, y) =>
          Number(x.ruling !== null) - Number(y.ruling !== null) ||
          (x.confidence ?? 1) - (y.confidence ?? 1) ||
          x.inputId.localeCompare(y.inputId, undefined, { numeric: true }) ||
          x.attempt - y.attempt,
      )
      .map((v) => v.threadId),
  );
  const rows = useMemo(() => {
    const by = new Map(grid.verdicts.filter((v) => v.checkId === cell.checkId && v.version === cell.version).map((v) => [v.threadId, v]));
    return order.map((id) => by.get(id)).filter((r): r is Row => !!r);
  }, [grid, cell, order]);
  const [at, setAt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const row = rows[Math.min(at, rows.length - 1)] as Row | undefined;
  const ruledCount = rows.filter((r) => r.ruling !== null).length;

  const rule = useCallback(
    async (failed: boolean) => {
      if (!row || saving) return;
      setSaving(true);
      setError(null);
      // Making the call you already made takes it back.
      const res = await saveEvalRulingFn({
        data: { agent, threadId: row.threadId, checkId: row.checkId, failed: row.ruling === failed ? null : failed },
      });
      setSaving(false);
      if (!res.ok) return setError(`Your call was not saved: ${res.error}.`);
      onRuled();
      if (row.ruling !== failed) setAt((i) => Math.min(i + 1, rows.length - 1));
    },
    [agent, row, rows.length, saving, onRuled],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) return;
      const k = e.key.toLowerCase();
      if (k === "p") void rule(false);
      else if (k === "f") void rule(true);
      else if (k === "j" || e.key === "ArrowDown") setAt((i) => Math.min(i + 1, rows.length - 1));
      else if (k === "k" || e.key === "ArrowUp") setAt((i) => Math.max(i - 1, 0));
      else if (e.key === "Escape") onClose();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rule, rows.length, onClose]);

  if (!check) return null;

  return (
    <aside className="smooth-shadow-ring-xs smooth-ring-primary-border bg-primary-bg flex max-h-[calc(100vh-11rem)] flex-col overflow-hidden rounded-lg xl:sticky xl:top-6">
      <div className="border-primary-border flex items-start gap-3 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-ink-primary text-sm font-medium">
            {check.label} <span className="text-ink-tertiary font-normal">on {cell.version}</span>
          </div>
          <div className="text-ink-tertiary mt-0.5 line-clamp-2 text-xs" title={check.sentence}>
            {check.sentence}
          </div>
        </div>
        <button type="button" onClick={onClose} aria-label="Close review" className="text-ink-tertiary hover:text-ink-primary rounded p-0.5">
          <X className="size-4" />
        </button>
      </div>

      <div className="border-primary-border flex items-center gap-2 border-b px-4 py-2 text-xs">
        <button
          type="button"
          aria-label="Previous thread"
          onClick={() => setAt((i) => Math.max(i - 1, 0))}
          className="text-ink-secondary hover:text-ink-primary rounded p-0.5 disabled:opacity-40"
          disabled={at === 0}
        >
          <ChevronUp className="size-4" />
        </button>
        <button
          type="button"
          aria-label="Next thread"
          onClick={() => setAt((i) => Math.min(i + 1, rows.length - 1))}
          className="text-ink-secondary hover:text-ink-primary rounded p-0.5 disabled:opacity-40"
          disabled={at >= rows.length - 1}
        >
          <ChevronDown className="size-4" />
        </button>
        <span className="text-ink-secondary tabular-nums">
          {rows.length ? at + 1 : 0} of {rows.length}
        </span>
        <span className="text-ink-tertiary">· {ruledCount} called</span>
        <div className="ml-auto flex gap-[3px]" aria-hidden>
          {rows.map((r, i) => (
            <button
              key={r.threadId}
              type="button"
              tabIndex={-1}
              onClick={() => setAt(i)}
              title={`#${r.inputId}${grid.attempts > 1 ? ` try ${r.attempt + 1}` : ""}`}
              className={cn(
                "h-3 w-1.5 rounded-[2px]",
                r.ruling === null ? "bg-primary-border" : r.ruling === r.failed ? "bg-ink-secondary" : "bg-amber-500",
                i === at && "bg-ink-primary h-4",
              )}
            />
          ))}
        </div>
      </div>

      {row ? <Thread key={row.threadId} agent={agent} row={row} repeated={grid.attempts > 1} /> : <p className="text-ink-tertiary p-4 text-sm">Nothing to review.</p>}

      {row && (
        <div className="border-primary-border space-y-2 border-t px-4 py-3">
          <div className="flex items-center gap-2 text-xs">
            <span className="text-ink-secondary">The judge said</span>
            <span className={cn("font-medium", row.failed ? "text-red-600 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400")}>
              {row.failed ? "fail" : "pass"}
            </span>
            <span className="text-ink-tertiary">
              ({row.answer.replace(/_/g, " ")}
              {row.confidence !== null ? `, ${Math.round(row.confidence * 100)}% sure` : ""})
            </span>
            {row.ruling !== null && row.ruling !== row.failed && <span className="ml-auto text-amber-700 dark:text-amber-400">you disagree</span>}
          </div>
          <div className="grid grid-cols-2 gap-2" role="group" aria-label="Your call">
            <CallButton on={row.ruling === false} disabled={saving} onClick={() => void rule(false)} hint="P">
              Pass
            </CallButton>
            <CallButton on={row.ruling === true} disabled={saving} onClick={() => void rule(true)} hint="F">
              Fail
            </CallButton>
          </div>
          {error ? (
            <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
          ) : (
            <p className="text-ink-tertiary text-xs">
              <Key>J</Key> <Key>K</Key> to move · <Key>Esc</Key> to close · make the same call again to take it back
            </p>
          )}
        </div>
      )}
    </aside>
  );
}

function CallButton({ on, disabled, onClick, hint, children }: { on: boolean; disabled: boolean; onClick: () => void; hint: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "smooth-shadow-ring-xs smooth-ring-primary-border focus-visible:ring-ring flex h-9 items-center justify-center gap-2 rounded-md text-sm font-medium outline-none focus-visible:ring-2 disabled:opacity-60",
        on ? "bg-ink-primary text-primary-bg" : "text-ink-primary hover:bg-primary-bg-hover",
      )}
    >
      {children}
      <span className={cn("text-xs font-normal", on ? "opacity-70" : "text-ink-tertiary")}>{hint}</span>
    </button>
  );
}

function Thread({ agent, row, repeated }: { agent: string; row: Row; repeated: boolean }) {
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof getEvalThreadFn>> | undefined>(undefined);
  useEffect(() => {
    void getEvalThreadFn({ data: { agent, threadId: row.threadId } }).then(setDetail);
  }, [agent, row.threadId]);

  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3 text-sm">
      <div className="text-ink-tertiary text-xs">
        Question #{row.inputId}
        {repeated ? `, try ${row.attempt + 1}` : ""}
      </div>
      {detail === undefined ? (
        <Loader2 className="text-ink-tertiary size-4 animate-spin" />
      ) : detail === null ? (
        <p className="text-ink-tertiary">This thread is no longer available.</p>
      ) : (
        <>
          <Part label="Asked">{[detail.prompt, ...detail.followUps].join("\n\n")}</Part>
          {detail.tools.length > 0 && (
            <Part label={`Tools (${detail.tools.length} calls)`}>
              <span className="flex flex-wrap gap-1">
                {grouped(detail.tools).map((t) => (
                  <span key={t.tool} className="bg-primary-bg-hover text-ink-secondary rounded px-1.5 py-0.5 font-mono text-[11px]">
                    {t.tool}
                    {t.n > 1 ? ` ×${t.n}` : ""}
                    {t.stubbed ? " · simulated" : ""}
                  </span>
                ))}
              </span>
            </Part>
          )}
          <Part label="Answer">{detail.answer || "(no answer)"}</Part>
          {detail.reference && (
            <Part label="A good answer conveys" quiet>
              {detail.reference}
            </Part>
          )}
        </>
      )}
    </div>
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="smooth-shadow-ring-xs smooth-ring-primary-border text-ink-secondary inline-block rounded px-1 font-sans text-[11px] leading-4">
      {children}
    </kbd>
  );
}

/** Calls to the same tool, counted, in first-call order. */
function grouped(tools: { tool: string; stubbed: boolean }[]) {
  const out = new Map<string, { tool: string; n: number; stubbed: boolean }>();
  for (const t of tools) {
    const g = out.get(t.tool) ?? out.set(t.tool, { tool: t.tool, n: 0, stubbed: false }).get(t.tool)!;
    g.n += 1;
    g.stubbed ||= t.stubbed;
  }
  return [...out.values()];
}

function Part({ label, quiet, children }: { label: string; quiet?: boolean; children: React.ReactNode }) {
  return (
    <section>
      <div className="text-ink-secondary mb-1 text-xs font-medium">{label}</div>
      <div
        className={cn(
          "leading-relaxed whitespace-pre-wrap",
          quiet ? "border-primary-border text-ink-secondary border-l-2 pl-3" : "text-ink-primary",
        )}
      >
        {children}
      </div>
    </section>
  );
}
