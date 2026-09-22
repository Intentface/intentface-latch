import { useEffect, useMemo, useState } from "react";
import { FlaskConical, Loader2 } from "lucide-react";
import {
  getEvalGridFn,
  getEvalThreadFn,
  getEvalsOverviewFn,
  saveEvalRulingFn,
  type EvalGrid,
  type EvalsOverview,
} from "@/lib/evals-server";
import { cn } from "@/lib/utils";
import { Select } from "@/components/ui/select";

/**
 * Evals on the agent page: one grid, checks down the side, versions across
 * the top — the way a spreadsheet person already reads a comparison. A cell
 * opens the threads behind it, and each one can be ruled pass/fail; those
 * rulings are what the Trust column is made of.
 *
 * Read-only apart from rulings. Running and judging cost money and stay on
 * the command line until there is a cost guard in front of them.
 */
export function EvalsSection({ agent }: { agent: string }) {
  const [overview, setOverview] = useState<EvalsOverview | null | undefined>(undefined);
  const [datasetId, setDatasetId] = useState("");
  const [rubricId, setRubricId] = useState("");
  const [runId, setRunId] = useState("");
  const [grid, setGrid] = useState<EvalGrid | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<{ checkId: string; version: string } | null>(null);

  useEffect(() => {
    void getEvalsOverviewFn({ data: agent }).then((o) => {
      setOverview(o);
      const d = o?.datasets.find((x) => x.runs.length) ?? o?.datasets[0];
      if (d) (setDatasetId(d.id), setRunId(d.runs[0]?.runId ?? ""));
      if (o?.rubrics[0]) setRubricId(o.rubrics[0].id);
    });
  }, [agent]);

  const dataset = overview?.datasets.find((d) => d.id === datasetId);

  const load = () => {
    if (!datasetId || !rubricId || !runId) return setGrid(null);
    setLoading(true);
    void getEvalGridFn({ data: { agent, datasetId, rubricId, runId } })
      .then(setGrid)
      .finally(() => setLoading(false));
  };
  useEffect(load, [agent, datasetId, rubricId, runId]);

  if (overview === undefined) return null;

  return (
    <section className="smooth-shadow-ring-xs smooth-ring-primary-border bg-primary-bg space-y-3 rounded-lg p-4">
      <div className="flex items-center gap-2">
        <FlaskConical className="text-ink-secondary size-4" />
        <h2 className="text-ink-primary text-sm font-semibold">Evals</h2>
      </div>
      <p className="text-ink-tertiary text-xs">
        How each version does on a fixed set of questions. Open a cell to read the threads behind it and
        mark whether the judge got them right — those calls decide which checks can be trusted.
      </p>

      {!overview?.datasets.length ? (
        <p className="text-ink-secondary text-xs">
          No datasets for this agent yet. Import one with <code>pnpm evals import</code>, then{" "}
          <code>pnpm evals run</code> and <code>pnpm evals judge</code>.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-2">
            <Picker label="Questions">
              <Select
                id="evals-dataset"
                value={datasetId}
                onChange={(e) => {
                  const d = overview.datasets.find((x) => x.id === e.target.value);
                  setDatasetId(e.target.value);
                  setRunId(d?.runs[0]?.runId ?? "");
                  setOpen(null);
                }}
              >
                {overview.datasets.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({d.inputs})
                  </option>
                ))}
              </Select>
            </Picker>
            <Picker label="Checks">
              <Select id="evals-rubric" value={rubricId} onChange={(e) => (setRubricId(e.target.value), setOpen(null))}>
                {overview.rubrics.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.id} v{r.version} ({r.checks})
                  </option>
                ))}
              </Select>
            </Picker>
            <Picker label="Run">
              <Select id="evals-run" value={runId} onChange={(e) => (setRunId(e.target.value), setOpen(null))}>
                {(dataset?.runs ?? []).map((r) => (
                  <option key={r.runId} value={r.runId}>
                    {new Date(r.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} ·{" "}
                    {r.versions.join(" vs ")} · {r.threads} threads
                  </option>
                ))}
              </Select>
            </Picker>
            {loading && <Loader2 className="text-ink-tertiary mb-2 size-4 animate-spin" />}
          </div>

          {!dataset?.runs.length && <p className="text-ink-secondary text-xs">This dataset has not been run yet.</p>}
          {grid && (
            <Grid
              grid={grid}
              open={open}
              onOpen={(c) => setOpen(open && open.checkId === c.checkId && open.version === c.version ? null : c)}
            />
          )}
          {grid && open && (
            <CellThreads agent={agent} grid={grid} cell={open} onRuled={load} />
          )}
        </>
      )}
    </section>
  );
}

function Picker({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-ink-secondary text-xs font-medium">{label}</span>
      {children}
    </label>
  );
}

const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0);

const TRUST_COPY: Record<string, { label: string; tone: string; means: string }> = {
  unknown: { label: "Not yet known", tone: "text-ink-tertiary", means: "Fewer than 20 of your calls — the number is the judge's word only." },
  trusted: { label: "Trusted", tone: "text-emerald-700 dark:text-emerald-400", means: "Agrees with your calls at least 90% of the time." },
  gating: { label: "Can gate", tone: "text-emerald-700 dark:text-emerald-400", means: "50+ calls, 90%+ agreement — safe to block a publish on." },
  disputed: { label: "Disputed", tone: "text-amber-700 dark:text-amber-400", means: "You overrule this judge more than 1 time in 10 — reword the check." },
};

function Grid({
  grid,
  open,
  onOpen,
}: {
  grid: EvalGrid;
  open: { checkId: string; version: string } | null;
  onOpen: (c: { checkId: string; version: string }) => void;
}) {
  const [a, b] = grid.versions;
  const repeated = grid.attempts > 1;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[600px] border-separate border-spacing-0 text-xs tabular-nums">
        <thead>
          <tr className="text-ink-secondary text-left">
            <th className="py-1.5 pr-3 font-medium">Check</th>
            {grid.versions.map((v) => (
              <th key={v} className="px-2 py-1.5 font-medium">
                {v}
              </th>
            ))}
            {b && (
              <th className="px-2 py-1.5 font-medium" title="Question by question: how many got better (+) or worse (−)">
                {a} → {b}
              </th>
            )}
            <th className="px-2 py-1.5 font-medium">Trust</th>
          </tr>
        </thead>
        <tbody>
          {grid.checks.map((c) => {
            const trust = TRUST_COPY[c.trust?.level ?? "unknown"]!;
            return (
              <tr key={c.id} className="align-top">
                <td className="border-primary-border border-t py-2 pr-3">
                  <div className="text-ink-primary font-medium">{c.label}</div>
                  <div className="text-ink-tertiary mt-0.5 line-clamp-2 max-w-[30ch]" title={c.sentence}>
                    {c.sentence}
                  </div>
                  <div className="text-ink-tertiary mt-0.5">{c.kind === "counted" ? "read from the tool log" : `asked of ${c.judge}`}</div>
                </td>
                {c.cells.map((cell, i) => {
                  const version = grid.versions[i]!;
                  const active = open?.checkId === c.id && open.version === version;
                  const rate = pct(cell.passed, cell.total);
                  return (
                    <td key={version} className="border-primary-border border-t px-1 py-1">
                      <button
                        type="button"
                        onClick={() => onOpen({ checkId: c.id, version })}
                        className={cn(
                          "hover:bg-primary-bg-hover focus-visible:ring-ring w-full rounded-md px-1.5 py-1 text-left outline-none focus-visible:ring-2",
                          active && "bg-primary-bg-active",
                        )}
                      >
                        <div className="flex items-baseline gap-1.5">
                          <span className="text-ink-primary text-sm font-semibold">{cell.total ? `${rate}%` : "—"}</span>
                          <span className="text-ink-tertiary">
                            {cell.passed}/{cell.total}
                          </span>
                        </div>
                        <div className="bg-primary-border mt-1 h-1 overflow-hidden rounded-full">
                          <div className="bg-ink-secondary h-full rounded-full" style={{ width: `${rate}%` }} />
                        </div>
                        {repeated && (
                          <div className="text-ink-tertiary mt-1 whitespace-nowrap" title="Questions that passed on every attempt">
                            every time {cell.allPassed}/{cell.inputs}
                          </div>
                        )}
                      </button>
                    </td>
                  );
                })}
                {b && (
                  <td className="border-primary-border border-t px-2 py-2">
                    {c.compare && c.compare.pairs ? (
                      <>
                        <div className="whitespace-nowrap">
                          <span className={c.compare.improved ? "text-emerald-700 dark:text-emerald-400" : "text-ink-tertiary"}>
                            +{c.compare.improved}
                          </span>{" "}
                          <span className={c.compare.regressed ? "text-red-600 dark:text-red-400" : "text-ink-tertiary"}>
                            −{c.compare.regressed}
                          </span>
                          <span className="text-ink-tertiary"> of {c.compare.pairs}</span>
                        </div>
                        <div className="text-ink-tertiary mt-0.5" title={`p = ${c.compare.p.toFixed(3)}`}>
                          {c.compare.p < 0.05 ? "a real difference" : c.compare.improved + c.compare.regressed ? "could be chance" : "no change"}
                        </div>
                      </>
                    ) : (
                      <span className="text-ink-tertiary">—</span>
                    )}
                  </td>
                )}
                <td className="border-primary-border border-t px-2 py-2" title={trust.means}>
                  <div className={cn("font-medium whitespace-nowrap", trust.tone)}>{trust.label}</div>
                  <div className="text-ink-tertiary mt-0.5 whitespace-nowrap">
                    {c.trust?.ruled ?? 0} call{c.trust?.ruled === 1 ? "" : "s"}
                    {c.trust?.ruled ? ` · ${pct(c.trust.agreed, c.trust.ruled)}% agree` : ""}
                  </div>
                  {!!c.trust?.falsePasses && (
                    <div className="mt-0.5 text-amber-700 dark:text-amber-400">passed {c.trust.falsePasses} you failed</div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {grid.errors.some((e) => e.errors) && (
        <p className="text-ink-tertiary mt-2 text-xs">
          {grid.errors
            .filter((e) => e.errors)
            .map((e) => `${e.version}: ${e.errors} thread${e.errors === 1 ? "" : "s"} failed to run and are left out`)
            .join(" · ")}
        </p>
      )}
    </div>
  );
}

type Row = EvalGrid["verdicts"][number];

/** The threads behind one cell — least certain first, since that is where a call teaches the most. */
function CellThreads({
  agent,
  grid,
  cell,
  onRuled,
}: {
  agent: string;
  grid: EvalGrid;
  cell: { checkId: string; version: string };
  onRuled: () => void;
}) {
  const check = grid.checks.find((c) => c.id === cell.checkId)!;
  const rows = useMemo(
    () =>
      grid.verdicts
        .filter((v) => v.checkId === cell.checkId && v.version === cell.version)
        .sort(
          (x, y) =>
            Number(x.ruling !== null) - Number(y.ruling !== null) ||
            (x.confidence ?? 1) - (y.confidence ?? 1) ||
            x.inputId.localeCompare(y.inputId, undefined, { numeric: true }) ||
            x.attempt - y.attempt,
        ),
    [grid, cell],
  );
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="border-primary-border space-y-2 border-t pt-3">
      <div>
        <div className="text-ink-primary text-sm font-medium">
          {check.label} · {cell.version}
        </div>
        <div className="text-ink-secondary mt-0.5 text-xs">{check.sentence}</div>
      </div>
      <ul className="space-y-1">
        {rows.map((r) => (
          <ThreadRow
            key={r.threadId}
            agent={agent}
            row={r}
            repeated={grid.attempts > 1}
            expanded={expanded === r.threadId}
            onToggle={() => setExpanded(expanded === r.threadId ? null : r.threadId)}
            onRuled={onRuled}
          />
        ))}
      </ul>
    </div>
  );
}

function ThreadRow({
  agent,
  row,
  repeated,
  expanded,
  onToggle,
  onRuled,
}: {
  agent: string;
  row: Row;
  repeated: boolean;
  expanded: boolean;
  onToggle: () => void;
  onRuled: () => void;
}) {
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof getEvalThreadFn>> | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (expanded && detail === undefined) void getEvalThreadFn({ data: { agent, threadId: row.threadId } }).then(setDetail);
  }, [expanded, detail, agent, row.threadId]);

  const rule = async (failed: boolean) => {
    setSaving(true);
    setError(null);
    // Clicking the call you already made takes it back.
    const res = await saveEvalRulingFn({ data: { agent, threadId: row.threadId, checkId: row.checkId, failed: row.ruling === failed ? null : failed } });
    setSaving(false);
    if (!res.ok) return setError(`Your call was not saved: ${res.error}.`);
    onRuled();
  };

  const agrees = row.ruling === null ? null : row.ruling === row.failed;

  return (
    <li className="smooth-shadow-ring-xs smooth-ring-primary-border rounded-md">
      <div className="flex flex-wrap items-center gap-2 px-2.5 py-1.5 text-xs">
        <button type="button" onClick={onToggle} className="text-ink-primary min-w-0 flex-1 truncate text-left hover:underline">
          <span className="text-ink-tertiary">
            #{row.inputId}
            {repeated ? ` try ${row.attempt + 1}` : ""}
          </span>{" "}
          {row.prompt || "(no question recorded)"}
        </button>
        <span className={cn("font-medium", row.failed ? "text-red-600 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400")}>
          Judge: {row.failed ? "fail" : "pass"}
        </span>
        <span className="text-ink-tertiary w-28" title="The judge's answer and how sure it was">
          {row.answer.replace(/_/g, " ")}
          {row.confidence !== null ? ` · ${Math.round(row.confidence * 100)}%` : ""}
        </span>
        <div className="flex items-center gap-1" role="group" aria-label="Your call">
          <RuleButton on={row.ruling === false} disabled={saving} onClick={() => void rule(false)}>
            Pass
          </RuleButton>
          <RuleButton on={row.ruling === true} disabled={saving} onClick={() => void rule(true)}>
            Fail
          </RuleButton>
        </div>
        {agrees === false && <span className="text-amber-700 dark:text-amber-400">you disagree</span>}
      </div>
      {error && <p className="px-2.5 pb-1.5 text-xs text-red-600 dark:text-red-400">{error}</p>}
      {expanded && (
        <div className="border-primary-border space-y-2 border-t px-2.5 py-2 text-xs">
          {detail === undefined ? (
            <Loader2 className="text-ink-tertiary size-4 animate-spin" />
          ) : detail === null ? (
            <p className="text-ink-tertiary">This thread is no longer available.</p>
          ) : (
            <>
              <Block label="Asked">{[detail.prompt, ...detail.followUps].join("\n\n")}</Block>
              {detail.tools.length > 0 && (
                <Block label="Tools">
                  {detail.tools.map((t) => `${t.tool}${t.stubbed ? " (simulated)" : ""}`).join(", ")}
                </Block>
              )}
              <Block label="Answer">{detail.answer || "(no answer)"}</Block>
              {detail.reference && <Block label="A good answer conveys">{detail.reference}</Block>}
            </>
          )}
        </div>
      )}
    </li>
  );
}

function RuleButton({ on, disabled, onClick, children }: { on: boolean; disabled: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "smooth-shadow-ring-xs smooth-ring-primary-border focus-visible:ring-ring rounded px-2 py-0.5 outline-none focus-visible:ring-2 disabled:opacity-50",
        on ? "bg-ink-primary text-primary-bg" : "text-ink-secondary hover:bg-primary-bg-hover",
      )}
    >
      {children}
    </button>
  );
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-ink-secondary font-medium">{label}</div>
      <div className="text-ink-primary mt-0.5 max-h-64 overflow-y-auto whitespace-pre-wrap">{children}</div>
    </div>
  );
}
