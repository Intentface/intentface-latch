import { useState } from "react";
import { Check, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EvalCase, EvalCaseResult, EvalRun, CheckVerdict } from "@/lib/evals/store";
import { effectiveFailed } from "@/lib/evals/reliability";
import { Chip, ConfigBadge, KindTag, ScopeTag, present, pctOf } from "./eval-primitives";
import type { Question } from "@/lib/evals/ask";

/**
 * Results, split by where the check lives.
 *
 * The old grid put every (case, check) pair on its own row. That is correct at
 * three cases and unreadable at a hundred: seven shared checks over a hundred
 * inputs is seven hundred rows of mostly identical ticks, and the handful of
 * per-case rows carrying the actual ground truth are buried in them.
 *
 * The two kinds want different treatments because they are different
 * measurements. A shared check's value over a hundred inputs is a RATE — one
 * row, one number per configuration, and a click to see which ones failed. A
 * per-case check's value is a TICK, because there is exactly one of it. Forcing
 * both into one table is what broke.
 */

type Shared = Record<string, Question>;

/** A run in progress, as the page streams it in. */
export interface LiveColumn {
  label: string;
  done: EvalCaseResult[];
  /** Cases the run will attempt, known before any of them has finished. */
  total: number;
}

/**
 * A column is a configuration measured once — finished, or still measuring.
 *
 * Giving the in-flight run a column rather than a panel of its own is the
 * point: results mean something next to the runs before them, and a regression
 * is worth seeing the moment the case lands, not after the other four have
 * also finished and the table redraws.
 */
type Column =
  | { kind: "run"; id: string; run: EvalRun }
  | { kind: "live"; id: "__live__"; live: LiveColumn };

const LIVE_ID = "__live__";

interface Props {
  runs: EvalRun[];
  cases: EvalCase[];
  shared: Shared;
  /** When set, everything this ONE input was judged on. */
  focusCase?: string | null;
  /** A run streaming in right now, shown as the rightmost column. */
  live?: LiveColumn | null;
  onOpenEvidence: (caseId: string, checkId: string, runId: string) => void;
}

export function EvalResults({ runs, cases, shared, focusCase, live, onOpenEvidence }: Props) {
  // Oldest → newest, so a regression reads as a change moving rightwards, and
  // the run in progress is rightmost of all.
  const columns: Column[] = [
    ...[...runs]
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(live ? -5 : -6)
      .map((run): Column => ({ kind: "run", id: run.id, run })),
    ...(live ? [{ kind: "live", id: LIVE_ID, live } as Column] : []),
  ];
  const sharedIds = Object.keys(shared);

  /** The results a column has so far — all of them, for a finished run. */
  const resultsOf = (col: Column): EvalCaseResult[] =>
    col.kind === "run" ? col.run.results : col.live.done;

  const verdictOf = (col: Column, caseId: string, checkId: string): CheckVerdict | undefined =>
    resultsOf(col)
      .find((r) => r.caseId === caseId)
      ?.checks?.find((c) => c.id === checkId);

  /** True when this column will have a verdict here but does not yet. */
  const pending = (col: Column, caseId: string) =>
    col.kind === "live" && !col.live.done.some((r) => r.caseId === caseId);

  /** Per-case rows: every (case, check) pair that is not a shared id. */
  const perCase: { caseId: string; caseName: string; checkId: string; q?: Question }[] = [];
  for (const c of cases) {
    for (const [id, q] of Object.entries(c.checks ?? {})) {
      perCase.push({ caseId: c.id, caseName: c.name || c.id, checkId: id, q });
    }
  }
  // Checks that ran but are no longer authored anywhere still have to appear,
  // or a history view silently drops the rows it cannot explain.
  for (const col of columns) {
    for (const res of resultsOf(col)) {
      for (const chk of res.checks ?? []) {
        if (sharedIds.includes(chk.id)) continue;
        if (perCase.some((p) => p.caseId === res.caseId && p.checkId === chk.id)) continue;
        perCase.push({ caseId: res.caseId, caseName: res.caseName, checkId: chk.id });
      }
    }
  }

  const cols = `minmax(240px, 1.6fr) repeat(${columns.length}, minmax(92px, 1fr))`;

  const focused = focusCase ? cases.find((c) => c.id === focusCase) : undefined;
  if (focusCase) {
    return (
      <OneCase
        caseId={focusCase}
        name={focused?.name || focusCase}
        shared={shared}
        own={focused?.checks ?? {}}
        columns={columns}
        cols={cols}
        verdictOf={verdictOf}
        pending={pending}
        onOpenEvidence={onOpenEvidence}
      />
    );
  }

  return (
    <div className="border-secondary-border overflow-hidden rounded-lg border">
      <div
        className="border-secondary-border bg-secondary-bg/40 grid items-end border-b"
        style={{ gridTemplateColumns: cols }}
      >
        <div className="text-ink-tertiary px-3 py-2.5 text-[11px] font-medium uppercase tracking-wide">
          Check
        </div>
        {columns.map((c) => (
          <ColumnHead key={c.id} col={c} />
        ))}
      </div>

      {sharedIds.length > 0 && (
        <>
          <SectionLabel
            title="Shared"
            sub={`asked of every case — one rate over ${cases.length} input${cases.length === 1 ? "" : "s"}, which is the only shape a comparison can resolve`}
          />
          <div className="divide-secondary-border divide-y">
            {sharedIds.map((id) => (
              <SharedRow
                key={id}
                checkId={id}
                q={shared[id]!}
                cases={cases}
                cols={cols}
                columns={columns}
                verdictOf={verdictOf}
                onOpenEvidence={onOpenEvidence}
              />
            ))}
          </div>
        </>
      )}

      {perCase.length > 0 && (
        <>
          <SectionLabel
            title="Per-case"
            sub="ground truth for one input — a tick, not a rate, because n=1 can never separate a real change from noise"
          />
          <div className="divide-secondary-border divide-y">
            {perCase.map((row) => {
              const overrides = sharedIds.includes(row.checkId);
              const labels = new Set(
                columns
                  .map((c) => verdictOf(c, row.caseId, row.checkId))
                  .filter(Boolean)
                  .map((v) => `${v!.answer}:${effectiveFailed(v!)}`),
              );
              return (
                <div
                  key={`${row.caseId}/${row.checkId}`}
                  className="grid items-stretch"
                  style={{ gridTemplateColumns: cols }}
                >
                  <div className="flex flex-col justify-center gap-1.5 px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-ink-tertiary font-mono text-[10px]">{row.caseName}</span>
                      <span className="text-ink-tertiary/50" aria-hidden>
                        ›
                      </span>
                      <span className="text-ink-primary text-[13px] font-medium leading-snug">
                        {row.checkId}
                      </span>
                      {labels.size > 1 && (
                        <Chip className="border-accent-border bg-accent-bg/15 text-ink-primary">
                          changed
                        </Chip>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <ScopeTag scope={overrides ? "override" : "case"} />
                      {row.q && <KindTag q={row.q} />}
                    </div>
                  </div>
                  {columns.map((c) => {
                    if (pending(c, row.caseId)) return <PendingCell key={c.id} />;
                    const v = verdictOf(c, row.caseId, row.checkId);
                    if (!v) return <NotApplicable key={c.id} />;
                    return (
                      <TickCell
                        key={c.id}
                        v={v}
                        {...(c.kind === "run"
                          ? { onClick: () => onOpenEvidence(row.caseId, row.checkId, c.id) }
                          : {})}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
        </>
      )}

      <Legend />
    </div>
  );
}

/**
 * One input, everything it is judged on.
 *
 * Here every check is a TICK, shared ones included — inside a single case a
 * shared check has exactly one observation, same as a per-case one. What has to
 * survive is which is which, because editing the shared one changes every other
 * case in the set and editing the case's own changes nothing else. So the scope
 * tag stays on every row even though the cells look alike.
 */
function OneCase({
  caseId,
  name,
  shared,
  own,
  columns,
  cols,
  verdictOf,
  pending,
  onOpenEvidence,
}: {
  caseId: string;
  name: string;
  shared: Shared;
  own: Record<string, Question>;
  columns: Column[];
  cols: string;
  verdictOf: (col: Column, caseId: string, checkId: string) => CheckVerdict | undefined;
  pending: (col: Column, caseId: string) => boolean;
  onOpenEvidence: (caseId: string, checkId: string, runId: string) => void;
}) {
  // Case-last, exactly as the runner merges them.
  const merged = { ...shared, ...own };
  const rows = Object.entries(merged).map(([id, q]) => ({
    id,
    q,
    scope: (id in own ? (id in shared ? "override" : "case") : "shared") as
      | "shared"
      | "case"
      | "override",
  }));

  return (
    <div>
      <div className="border-secondary-border grid items-end border-b" style={{ gridTemplateColumns: cols }}>
        <div className="text-ink-tertiary px-3 py-2.5 text-[11px] font-medium uppercase tracking-wide">
          {name}
        </div>
        {columns.map((c) => (
          <ColumnHead key={c.id} col={c} />
        ))}
      </div>

      <div className="divide-secondary-border divide-y">
        {rows.map((row) => (
          <div key={row.id} className="grid items-stretch" style={{ gridTemplateColumns: cols }}>
            <div className="flex flex-col justify-center gap-1.5 px-3 py-2.5">
              <span className="text-ink-primary text-[13px] font-medium leading-snug">
                {row.q.ask}
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <ScopeTag scope={row.scope} />
                <KindTag q={row.q} />
                <span className="text-ink-tertiary font-mono text-[10px]">{row.id}</span>
              </div>
            </div>
            {columns.map((c) => {
              if (pending(c, caseId)) return <PendingCell key={c.id} />;
              const v = verdictOf(c, caseId, row.id);
              if (!v) return <NotApplicable key={c.id} />;
              return (
                <TickCell
                  key={c.id}
                  v={v}
                  {...(c.kind === "run"
                    ? { onClick: () => onOpenEvidence(caseId, row.id, c.id) }
                    : {})}
                />
              );
            })}
          </div>
        ))}
        {rows.length === 0 && (
          <p className="text-ink-tertiary px-3 py-4 text-xs">
            This case has no checks of its own and the set has no shared ones, so nothing was
            judged.
          </p>
        )}
      </div>

      <Legend />
    </div>
  );
}

function SectionLabel({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="border-secondary-border bg-secondary-bg/30 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b px-3 py-1.5">
      <span className="text-ink-secondary text-[11px] font-semibold uppercase tracking-wider">
        {title}
      </span>
      <span className="text-ink-tertiary text-[11px]">{sub}</span>
    </div>
  );
}

/**
 * A shared check over every case: a rate per configuration, and a click to see
 * which cases made it up.
 *
 * "91/100" is the number worth reading; "show me the nine" is the reason anyone
 * reads it. Both belong in one row, the second folded away until asked for.
 */
function SharedRow({
  checkId,
  q,
  cases,
  cols,
  columns,
  verdictOf,
  onOpenEvidence,
}: {
  checkId: string;
  q: Question;
  cases: EvalCase[];
  cols: string;
  columns: Column[];
  verdictOf: (col: Column, caseId: string, checkId: string) => CheckVerdict | undefined;
  onOpenEvidence: (caseId: string, checkId: string, runId: string) => void;
}) {
  const [drill, setDrill] = useState<string | null>(null);
  // A case may redefine a shared id to sharpen it for its own input. That is a
  // good feature and an excellent way to confuse someone, so the shared row
  // says who is not actually asking this question as written.
  const sharpened = cases.filter((c) => c.checks && checkId in c.checks);

  return (
    <div>
      <div className="grid items-stretch" style={{ gridTemplateColumns: cols }}>
        <div className="flex flex-col justify-center gap-1.5 px-3 py-2.5">
          <span className="text-ink-primary text-[13px] font-medium leading-snug">{q.ask}</span>
          <div className="flex flex-wrap items-center gap-2">
            <ScopeTag scope="shared" count={cases.length} />
            <KindTag q={q} />
            <span className="text-ink-tertiary font-mono text-[10px]">{checkId}</span>
          </div>
          {sharpened.length > 0 && (
            <p className="text-ink-secondary text-[11px] leading-snug">
              {sharpened.length} case{sharpened.length > 1 ? "s" : ""} override
              {sharpened.length > 1 ? "" : "s"} this: {sharpened.map((c) => c.name || c.id).join(", ")}
            </p>
          )}
        </div>

        {columns.map((col) => {
          const vs = cases
            .map((c) => verdictOf(col, c.id, checkId))
            .filter((v): v is CheckVerdict => v !== undefined);
          // A live column with nothing in yet is not "not applicable" — it is
          // about to have an answer, and saying n/a would be a lie that clears
          // itself a few seconds later.
          if (vs.length === 0) return col.kind === "live" ? <PendingCell key={col.id} /> : <NotApplicable key={col.id} />;
          const pass = vs.filter((v) => !effectiveFailed(v)).length;
          return (
            <RateCell
              key={col.id}
              pass={pass}
              judged={vs.length}
              // While a run is in flight the denominator is the cases it WILL
              // judge, so the bar fills rather than rescaling under the reader.
              total={col.kind === "live" ? Math.max(col.live.total, vs.length) : vs.length}
              active={drill === col.id}
              onClick={() => setDrill((d) => (d === col.id ? null : col.id))}
            />
          );
        })}
      </div>

      {drill && (
        <Drill
          checkId={checkId}
          col={columns.find((c) => c.id === drill)!}
          cases={cases}
          verdictOf={verdictOf}
          onOpenEvidence={onOpenEvidence}
        />
      )}
    </div>
  );
}

function RateCell({
  pass,
  judged,
  total,
  active,
  onClick,
}: {
  pass: number;
  /** Cases answered so far. */
  judged: number;
  /** Cases this column will answer — larger than `judged` mid-run. */
  total: number;
  active: boolean;
  onClick: () => void;
}) {
  const all = pass === judged && judged === total;
  const partial = judged < total;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={active}
      className={cn(
        "flex flex-col justify-center gap-1.5 border px-2.5 py-2 text-left transition-colors",
        all
          ? "border-pass/30 bg-pass-muted hover:border-pass/60"
          : "border-fail/30 bg-fail-muted hover:border-fail/60",
        active && "ring-accent ring-2",
      )}
      title={
        partial
          ? `${pass} of ${judged} judged so far, ${total - judged} still running`
          : `${pass} of ${total} cases passed — click to see them`
      }
    >
      <span
        className={cn(
          "text-sm font-semibold leading-none tabular-nums",
          all ? "text-pass-ink" : "text-fail-ink",
        )}
      >
        {pass}
        <span className="text-ink-tertiary">/{judged}</span>
      </span>
      {/* A proportion bar rather than a row of ticks: it reads the same at
          n=3 and n=100, which is the whole point of a shared check. Mid-run it
          has three parts — passed, failed, and not yet judged — so the number
          can rise without the bar rescaling under the reader. */}
      <span className="bg-secondary-bg flex h-1 overflow-hidden rounded-full" aria-hidden>
        <span className="bg-pass h-full" style={{ width: `${(pass / total) * 100}%` }} />
        <span className="bg-fail h-full" style={{ width: `${((judged - pass) / total) * 100}%` }} />
      </span>
    </button>
  );
}

function Drill({
  checkId,
  col,
  cases,
  verdictOf,
  onOpenEvidence,
}: {
  checkId: string;
  col: Column;
  cases: EvalCase[];
  verdictOf: (col: Column, caseId: string, checkId: string) => CheckVerdict | undefined;
  onOpenEvidence: (caseId: string, checkId: string, runId: string) => void;
}) {
  const rows = cases
    .map((c) => ({ c, v: verdictOf(col, c.id, checkId) }))
    .filter((r): r is { c: EvalCase; v: CheckVerdict } => r.v !== undefined)
    // Failures first — the only reason to open this is "show me the nine".
    .sort((a, b) => Number(effectiveFailed(b.v)) - Number(effectiveFailed(a.v)));

  return (
    <div className="border-secondary-border bg-secondary-bg/30 border-t border-dashed px-3 py-2">
      <div className="text-ink-tertiary mb-1.5 text-[10px] font-semibold uppercase tracking-wider">
        per-case · {col.kind === "run" ? (col.run.configRef ?? "live") : col.live.label} · click
        to read the conversation
      </div>
      <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map(({ c, v }) => {
          const p = present(v, v.human?.failed);
          const fail = p.base === "fail";
          return (
            <button
              key={c.id}
              type="button"
              disabled={col.kind !== "run"}
              onClick={() => col.kind === "run" && onOpenEvidence(c.id, checkId, col.id)}
              className={cn(
                "flex items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-colors",
                fail
                  ? "border-fail/30 bg-fail-muted hover:border-fail/60"
                  : "border-secondary-border hover:border-ink-tertiary/50",
              )}
            >
              <span className={cn("shrink-0", fail ? "text-fail-ink" : "text-pass-ink")} aria-hidden>
                {fail ? <X className="size-3.5" strokeWidth={2.5} /> : <Check className="size-3.5" strokeWidth={2.5} />}
              </span>
              <span className="text-ink-primary min-w-0 flex-1 truncate text-xs">
                {c.name || c.id}
              </span>
              <span className="text-ink-tertiary text-[10px] tabular-nums">
                {p.uncertain ? "low " : ""}
                {pctOf(p.confidence)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * One verdict, at n=1.
 *
 * Three states, three forms. Pass and fail carry a glyph and a fill. Uncertain
 * is HATCHED, because a judge at 0.51 and one at 0.99 were drawn identically
 * before and a reader had no way to tell which marks deserved a second look —
 * which is exactly where a human ruling is worth the most.
 */
function TickCell({ v, onClick }: { v: CheckVerdict; onClick?: () => void }) {
  const p = present(v, v.human?.failed);
  const overruled = v.human !== undefined && v.human.failed !== v.failed;
  return (
    <button
      type="button"
      onClick={onClick}
      // A verdict from the run still in flight has no saved conversation behind
      // it yet. A click that silently does nothing is worse than a cell that
      // does not offer one; it becomes clickable a second later, when the run
      // is written.
      disabled={!onClick}
      className={cn(
        "flex flex-col items-center justify-center gap-1 border px-2 py-2.5 text-center transition-colors",
        p.tone === "pass" && "border-pass/30 bg-pass-muted text-pass-ink hover:border-pass/60",
        p.tone === "fail" && "border-fail/40 bg-fail-muted text-fail-ink hover:border-fail/70",
        p.tone === "uncertain" && "border-uncertain hatch-uncertain text-uncertain-ink",
      )}
      title={
        v.human
          ? `human says ${v.human.failed ? "fail" : "pass"} · judge said ${v.failed ? "fail" : "pass"} at ${pctOf(v.confidence)}`
          : `${p.label} · ${pctOf(v.confidence)} confident — click to read the conversation`
      }
    >
      <span className="inline-flex size-4 items-center justify-center" aria-hidden>
        {p.base === "pass" ? (
          <Check className="size-3.5" strokeWidth={2.5} />
        ) : (
          <X className="size-3.5" strokeWidth={2.5} />
        )}
      </span>
      {/* The option a CHOICE selected is the diagnosis, never a tick:
          said_none_match and invented_posts are both "fail" and completely
          different bugs. */}
      {p.label !== "true" && p.label !== "false" && (
        <span className="max-w-full break-words font-mono text-[10px] leading-tight">{p.label}</span>
      )}
      <span
        className={cn(
          "text-ink-tertiary text-[10px] tabular-nums",
          p.uncertain && "text-uncertain-ink font-medium",
        )}
      >
        {overruled ? "ruled" : `${p.uncertain ? "low " : ""}${pctOf(p.confidence)}`}
      </span>
    </button>
  );
}

/**
 * A column's identity: which configuration, and whether it is still measuring.
 *
 * A run in progress is labelled by the configuration it is measuring, same as
 * a finished one, because that is what a reader needs in order to know what
 * the arriving numbers will mean. What replaces the timestamp is the count,
 * since "when" is not yet a fact about it.
 */
function ColumnHead({ col }: { col: Column }) {
  if (col.kind === "live")
    return (
      <div className="border-accent-border/60 space-y-1 border-l px-2.5 py-2">
        <ConfigBadge label={col.live.label} />
        <div className="text-ink-tertiary flex items-center gap-1 text-[10px] tabular-nums">
          <Loader2 className="size-2.5 animate-spin" aria-hidden />
          {col.live.done.length}/{col.live.total || "…"} running
        </div>
      </div>
    );
  return (
    <div className="space-y-1 px-2.5 py-2">
      <ConfigBadge label={col.run.configRef ?? "live"} />
      <div className="text-ink-tertiary text-[10px] tabular-nums">
        {new Date(col.run.createdAt).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })}
      </div>
    </div>
  );
}

/**
 * This case has not finished yet.
 *
 * Deliberately NOT the n/a hatch: "did not exist in that run" and "is being
 * judged right now" are opposite facts, and drawing them alike would show
 * every pending cell as an absence that fills itself in a few seconds.
 */
function PendingCell() {
  return (
    <div
      className="border-secondary-border flex items-center justify-center border px-2 py-3"
      title="Still running"
    >
      <span className="bg-ink-tertiary/40 size-1.5 animate-pulse rounded-full" aria-hidden />
    </div>
  );
}

/** Absent is not failed: the check did not exist when this run happened. */
function NotApplicable() {
  return (
    <div
      className="hatch-neutral text-ink-tertiary flex flex-col items-center justify-center gap-0.5 px-2 py-3"
      title="Not applicable — this check did not exist when this run happened."
    >
      <span aria-hidden className="text-base leading-none">
        ·
      </span>
      <span className="text-[10px] uppercase tracking-wide">n/a</span>
    </div>
  );
}

function Legend() {
  return (
    <div className="border-secondary-border text-ink-tertiary flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-3 py-2 text-[10px]">
      <span className="inline-flex items-center gap-1.5">
        <span className="border-pass/30 bg-pass-muted text-pass-ink inline-flex size-4 items-center justify-center rounded border">
          <Check className="size-2.5" strokeWidth={3} />
        </span>
        passed
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="border-fail/40 bg-fail-muted text-fail-ink inline-flex size-4 items-center justify-center rounded border">
          <X className="size-2.5" strokeWidth={3} />
        </span>
        failed
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="border-uncertain hatch-uncertain inline-block size-4 rounded border" />
        judge was not sure — worth a ruling
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="hatch-neutral border-secondary-border inline-block size-4 rounded border" />
        did not exist in that run
      </span>
      <span className="ml-auto">click any verdict to read the conversation behind it</span>
    </div>
  );
}
