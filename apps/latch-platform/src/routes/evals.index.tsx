import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  createFileRoute,
  Link,
  redirect,
  useNavigate,
} from "@tanstack/react-router"
import { ChevronDown, ChevronUp, Loader2, Play, X } from "lucide-react"
import { currentPrincipalFn } from "@/lib/server"
import {
  getEvalGridFn,
  getEvalsIndexFn,
  getRunHistoryFn,
  listJobsFn,
  cancelJobFn,
  startJudgeFn,
  saveEvalRulingFn,
} from "@/lib/evals-server"
import type { EvalGrid, JobRow, RunPoint } from "@/lib/evals-server"
import {
  CARD,
  ChartCard,
  GROUND,
  Pill,
  SectionNav,
  SectionTitle,
} from "@/components/evals/ui"
import { CostChart, QuestionHeatmap } from "@/components/evals/charts"
import { RunDrawer } from "@/components/evals/run-drawer"
import { useEvalsChanged } from "@/components/evals/events"
import { Key, NoteBox, ThreadView } from "@/components/evals/thread-view"
import Drawer from "@/components/ui/drawer"
import {
  EDITOR_DRAWER,
  EvalsEmpty,
  NoEvalsYet,
  EvalsShell,
  Picker,
  useOverview,
  useSetSearch,
  validateEvalsSearch,
} from "@/components/evals/shell"
import { cn } from "@/lib/utils"
import { Select } from "@/components/ui/select"

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
    const principal = await currentPrincipalFn()
    if (!principal) throw redirect({ to: "/login" })
  },
  loader: () => getEvalsIndexFn(),
  component: EvalsPage,
})

type Row = EvalGrid["verdicts"][number]
type Cell = { checkId: string; version: string }

function EvalsPage() {
  const index = Route.useLoaderData()
  const search = Route.useSearch()
  const set = useSetSearch()
  const navigate = useNavigate()

  const agent = search.agent ?? index[0]?.agent
  const [overview, reloadOverview] = useOverview(agent)
  const [grid, setGrid] = useState<EvalGrid | null>(null)
  const [loading, setLoading] = useState(false)
  const [runOpen, setRunOpen] = useState(false)

  const dataset =
    overview?.datasets.find((d) => d.id === search.dataset) ??
    overview?.datasets.find((d) => d.runs.length) ??
    overview?.datasets[0]
  const rubricId = search.rubric ?? overview?.rubrics[0]?.id
  const runId = search.run ?? dataset?.runs[0]?.runId
  const run = dataset?.runs.find((r) => r.runId === runId)

  const reload = useCallback(() => {
    if (!agent || !dataset || !rubricId || !runId) return setGrid(null)
    setLoading(true)
    void getEvalGridFn({
      data: { agent, datasetId: dataset.id, rubricId, runId },
    })
      .then(setGrid)
      .finally(() => setLoading(false))
  }, [agent, dataset, rubricId, runId])
  useEffect(reload, [reload])

  const [history, setHistory] = useState<RunPoint[] | null>(null)
  const [historyTick, setHistoryTick] = useState(0)
  useEffect(() => {
    setHistory(null)
    if (!agent || !dataset || !rubricId) return
    void getRunHistoryFn({
      data: { agent, datasetId: dataset.id, rubricId },
    }).then(setHistory)
  }, [agent, dataset, rubricId, historyTick])

  const jobs = useJobs(agent, dataset?.id, (finished) => {
    // A run that just finished is the one worth looking at.
    reloadOverview()
    setHistoryTick((t) => t + 1)
    if (finished.kind === "run")
      set({ run: finished.runId, check: undefined, version: undefined })
    else reload()
  })
  // The Evals agent may have started a run, judged one, or edited checks.
  useEvalsChanged(() => {
    reload()
    setHistoryTick((t) => t + 1)
    jobs.refresh()
  })
  const judgeAgain = async () => {
    if (!agent || !dataset || !rubricId || !runId) return
    const r = await startJudgeFn({
      data: { agent, datasetId: dataset.id, rubricId, runId },
    })
    if (r.ok) jobs.refresh()
  }

  const open: Cell | null =
    search.check && search.version
      ? { checkId: search.check, version: search.version }
      : null
  // Keep the last cell's threads on screen while the drawer animates shut.
  const lastOpen = useRef(open)
  if (open) lastOpen.current = open
  const reviewing = open ?? lastOpen.current
  const toggle = (c: Cell) =>
    set(
      open?.checkId === c.checkId && open.version === c.version
        ? { check: undefined, version: undefined }
        : { check: c.checkId, version: c.version }
    )

  if (!index.length) return <EvalsEmpty />

  return (
    <div className={GROUND}>
      <div className="evals-page mx-auto max-w-[1400px] space-y-6 p-6 transition-[margin]">
        <EvalsShell
          page="results"
          index={index}
          search={search}
          actions={
            dataset &&
            rubricId && (
              <button
                type="button"
                onClick={() => setRunOpen(true)}
                className="flex h-8 items-center gap-1.5 rounded-lg bg-ink-primary px-3 text-sm font-medium text-primary-bg"
              >
                <Play className="size-3.5" /> New run
              </button>
            )
          }
        >
          {overview && overview.datasets.length > 0 && (
            <>
              <Picker label="Questions">
                <Select
                  id="evals-dataset"
                  value={dataset?.id ?? ""}
                  onChange={(e) =>
                    set({
                      dataset: e.target.value,
                      run: undefined,
                      check: undefined,
                      version: undefined,
                    })
                  }
                >
                  {overview.datasets.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name} ({d.inputs})
                    </option>
                  ))}
                </Select>
              </Picker>
              <Picker label="Checks">
                <Select
                  id="evals-rubric"
                  value={rubricId ?? ""}
                  onChange={(e) => set({ rubric: e.target.value })}
                >
                  {overview.rubrics.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.id}
                    </option>
                  ))}
                </Select>
              </Picker>
              <Picker label="Run">
                <Select
                  id="evals-run"
                  value={runId ?? ""}
                  onChange={(e) =>
                    set({
                      run: e.target.value,
                      check: undefined,
                      version: undefined,
                    })
                  }
                >
                  {dataset?.runs.map((r) => (
                    <option key={r.runId} value={r.runId}>
                      {runLabel(r)}
                    </option>
                  ))}
                </Select>
              </Picker>
            </>
          )}
          {loading && (
            <Loader2 className="mb-2 size-4 animate-spin text-ink-tertiary" />
          )}
        </EvalsShell>

        {agent && (
          <JobBanner agent={agent} jobs={jobs.rows} onChanged={jobs.refresh} />
        )}

        {agent && overview && !overview.datasets.length && (
          <NoEvalsYet
            agent={agent}
            onCreated={(id) =>
              void navigate({
                to: "/evals/questions",
                search: { agent, dataset: id },
              })
            }
          />
        )}

        {overview &&
          dataset &&
          !dataset.runs.length &&
          !jobs.rows.some(isActive) && (
            <p className="text-sm text-ink-secondary">
              {dataset.name} has {dataset.inputs} questions but no runs yet.{" "}
              <button
                type="button"
                onClick={() => setRunOpen(true)}
                className="text-ink-primary underline"
              >
                Start the first one
              </button>
              .
            </p>
          )}
        {grid && grid.rubricVersion < grid.latestVersion && (
          <p className="flex flex-wrap items-center gap-x-2 text-sm text-ink-secondary">
            Showing checks v{grid.rubricVersion}. Version {grid.latestVersion}{" "}
            has not been judged on this run yet.
            {!jobs.rows.some(
              (j) => isActive(j) && j.kind === "judge" && j.runId === runId
            ) && (
              <button
                type="button"
                onClick={() => void judgeAgain()}
                className="font-medium text-ink-primary underline"
              >
                Judge it with v{grid.latestVersion}
              </button>
            )}
            <span className="text-ink-tertiary">
              Only the judge runs; the agent does not.
            </span>
          </p>
        )}

        {grid && run && (
          <div className="evals-sections gap-10 xl:grid xl:grid-cols-[168px_minmax(0,1fr)]">
            <SectionNav sections={SECTIONS} />
            <div className="min-w-0 space-y-10">
              <section id="summary" className="scroll-mt-6 space-y-4">
                <SectionTitle id="summary">Summary</SectionTitle>
                <Verdict grid={grid} questions={dataset?.inputs ?? 0} />
              </section>

              <section id="checks" className="scroll-mt-6 space-y-4">
                <SectionTitle
                  id="checks"
                  aside={`${grid.checks.length} checks · version ${grid.rubricVersion}`}
                >
                  Checks
                </SectionTitle>
                <ChartCard
                  id="checks"
                  title="Pass rate by check"
                  subtitle={`Share of verdicts that passed, per version${grid.attempts > 1 ? `; dots are the ${grid.attempts} tries of each question` : ""}. Change compares question by question. Click a cell to read its threads.`}
                  flush
                >
                  <Grid
                    grid={grid}
                    open={open}
                    onOpen={toggle}
                    checkLink={
                      agent && rubricId
                        ? {
                            agent,
                            rubric: rubricId,
                            ...(dataset ? { dataset: dataset.id } : {}),
                          }
                        : undefined
                    }
                  />
                </ChartCard>
              </section>

              <section id="questions" className="scroll-mt-6 space-y-4">
                <SectionTitle
                  id="questions"
                  aside={`${new Set(grid.verdicts.map((v) => v.inputId)).size} questions`}
                >
                  Questions
                </SectionTitle>
                <ChartCard
                  id="questions"
                  title="Where each question fails"
                  subtitle="Each question's pass rate on each check, per version. A red row is a question the agent cannot answer; a red column is a check nothing passes."
                >
                  <QuestionHeatmap
                    grid={grid}
                    onOpen={toggle}
                    checkLink={
                      agent && rubricId
                        ? {
                            agent,
                            rubric: rubricId,
                            ...(dataset ? { dataset: dataset.id } : {}),
                          }
                        : undefined
                    }
                  />
                </ChartCard>
              </section>

              <section id="cost" className="scroll-mt-6 space-y-4">
                <SectionTitle
                  id="cost"
                  aside={
                    history
                      ? `${history.length} version${history.length === 1 ? "" : "s"} across runs`
                      : undefined
                  }
                >
                  Cost
                </SectionTitle>
                <ChartCard
                  id="cost"
                  title="Pass rate vs cost per thread"
                  subtitle="Every version in every run of this question set. Up and to the left is better; the dotted line joins the runs nothing beat on both. Hover a point for its run."
                >
                  {history ? (
                    <CostChart points={history} current={runId} />
                  ) : (
                    <Loader2 className="size-4 animate-spin text-ink-tertiary" />
                  )}
                </ChartCard>
              </section>
            </div>
          </div>
        )}

        {agent && dataset && rubricId && (
          <RunDrawer
            open={runOpen}
            agent={agent}
            datasetId={dataset.id}
            rubricId={rubricId}
            onClose={() => setRunOpen(false)}
            onStarted={() => {
              setRunOpen(false)
              jobs.refresh()
            }}
          />
        )}

        <Drawer
          open={!!(open && grid)}
          onOpenChange={(o) =>
            !o && set({ check: undefined, version: undefined })
          }
        >
          <Drawer.Content className={EDITOR_DRAWER}>
            {reviewing && grid && agent && (
              <Review
                key={`${reviewing.checkId}|${reviewing.version}|${grid.runId}`}
                agent={agent}
                grid={grid}
                cell={reviewing}
                onClose={() => set({ check: undefined, version: undefined })}
                onRuled={reload}
              />
            )}
          </Drawer.Content>
        </Drawer>
      </div>
    </div>
  )
}

const isActive = (j: JobRow) => j.status === "running" || j.status === "judging"

/** Recent jobs for this set, polled while any is running; `onFinished` fires once per job that completes. */
function useJobs(
  agent: string | undefined,
  datasetId: string | undefined,
  onFinished: (j: JobRow) => void
) {
  const [rows, setRows] = useState<JobRow[]>([])
  const seen = useRef(new Map<string, JobRow["status"]>())
  const finished = useRef(onFinished)
  finished.current = onFinished
  const [tick, setTick] = useState(0)
  const refresh = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    if (!agent || !datasetId) return setRows([])
    let stop = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      const next = await listJobsFn({ data: { agent, datasetId } })
      if (stop) return
      for (const j of next) {
        const was = seen.current.get(j.id)
        if (was && was !== "done" && j.status === "done") finished.current(j)
        seen.current.set(j.id, j.status)
      }
      setRows(next)
      if (next.some(isActive)) timer = setTimeout(() => void load(), 2500)
    }
    void load()
    return () => {
      stop = true
      clearTimeout(timer)
    }
  }, [agent, datasetId, tick])

  return { rows, refresh }
}

/** What is running now, and what went wrong recently. Finished runs speak through the Run picker. */
function JobBanner({
  agent,
  jobs,
  onChanged,
}: {
  agent: string
  jobs: JobRow[]
  onChanged: () => void
}) {
  const recent = Date.now() - 30 * 60_000
  const shown = jobs.filter(
    (j) => isActive(j) || (j.status === "failed" && j.updatedAt > recent)
  )
  if (!shown.length) return null
  return (
    <div className="space-y-2">
      {shown.map((j) => {
        const pctDone = j.total ? Math.round((100 * j.done) / j.total) : 0
        const what =
          j.kind === "judge"
            ? `Judging ${j.total} threads`
            : `${j.versions.join(" vs ")} · ${j.questions} question${j.questions === 1 ? "" : "s"}${j.repeats > 1 ? ` × ${j.repeats} tries` : ""}`
        return (
          <div
            key={j.id}
            className="rounded-lg bg-primary-bg px-4 py-3 text-sm smooth-shadow-ring-xs smooth-ring-primary-border"
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {isActive(j) && (
                <Loader2 className="size-4 animate-spin text-ink-secondary" />
              )}
              <span className="font-medium text-ink-primary">
                {j.status === "failed"
                  ? "Run failed"
                  : j.status === "judging"
                    ? "Judging"
                    : j.kind === "judge"
                      ? "Judging"
                      : "Running"}
              </span>
              <span className="text-ink-secondary">{what}</span>
              <span className="text-ink-tertiary tabular-nums">
                {j.status === "judging"
                  ? `${j.total} threads run`
                  : `${j.done} of ${j.total}`}
                {j.failed > 0 && ` · ${j.failed} failed to run`}
                {j.cost !== null && ` · about $${j.cost.toFixed(2)}`}
              </span>
              {isActive(j) && (
                <button
                  type="button"
                  onClick={() =>
                    void cancelJobFn({ data: { agent, id: j.id } }).then(
                      onChanged
                    )
                  }
                  className="ml-auto text-ink-secondary hover:text-ink-primary"
                >
                  Stop
                </button>
              )}
            </div>
            {isActive(j) && (
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-primary-border">
                <div
                  className={cn(
                    "h-full rounded-full bg-ink-secondary transition-[width] duration-500",
                    j.status === "judging" && "animate-pulse"
                  )}
                  style={{
                    width: `${j.status === "judging" ? 100 : pctDone}%`,
                  }}
                />
              </div>
            )}
            {j.error && (
              <p className="mt-1 text-red-600 dark:text-red-400">{j.error}</p>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * A run as the picker names it — an experiment: what it tested (when named),
 * which versions, on how many questions and tries, and when.
 */
function runLabel(r: {
  name: string | null
  versions: string[]
  questions: number
  tries: number
  createdAt: number
}) {
  const when = new Date(r.createdAt).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  })
  const scope = `${r.questions} question${r.questions === 1 ? "" : "s"}${r.tries > 1 ? ` × ${r.tries} tries` : ""}`
  return [r.name, r.versions.join(" vs "), scope, when]
    .filter(Boolean)
    .join(" · ")
}

const SECTIONS = [
  { id: "summary", label: "Summary" },
  { id: "checks", label: "Checks" },
  { id: "questions", label: "Questions" },
  { id: "cost", label: "Cost" },
]

const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0)

/** The one sentence a person wants before the grid: did the candidate win, and can we tell yet? */
function Verdict({ grid, questions }: { grid: EvalGrid; questions: number }) {
  const [a, b] = grid.versions
  const paired = grid.checks[0]?.compare?.pairs ?? 0
  const tries = `${paired || questions} question${paired === 1 ? "" : "s"}${grid.attempts > 1 ? ` × ${grid.attempts} tries` : ""}`
  const overall = grid.versions.map((v, i) => {
    let passed = 0
    let total = 0
    for (const c of grid.checks)
      ((passed += c.cells[i].passed), (total += c.cells[i].total))
    return { v, rate: total ? passed / total : 0, total }
  })
  if (!b)
    return (
      <div className={cn(CARD, "space-y-2 px-5 py-4")}>
        <Pill>{a}</Pill>
        <p className="text-[15px] text-ink-primary">
          <span className="font-semibold">{a}</span> passed{" "}
          <span className="font-semibold">
            {Math.round((overall[0]?.rate ?? 0) * 100)}%
          </span>{" "}
          of {overall[0]?.total ?? 0} verdicts on {tries}.
        </p>
      </div>
    )
  const moved = grid.checks.filter(
    (c) => c.compare && c.compare.improved + c.compare.regressed > 0
  )
  const better = moved.filter((c) => c.compare!.improved > c.compare!.regressed)
  const worse = moved.filter((c) => c.compare!.regressed > c.compare!.improved)
  const real = moved.filter((c) => c.compare!.p < 0.05)
  const names = (cs: typeof moved) =>
    cs.map((c) => c.label.toLowerCase()).join(", ")
  return (
    <div className={cn(CARD, "space-y-3 px-5 py-4")}>
      <Pill>
        {a} vs {b}
      </Pill>
      <p className="max-w-[80ch] text-[15px] leading-relaxed text-ink-primary">
        <span className="font-semibold">{b}</span> passed{" "}
        <span className="font-semibold">
          {Math.round(overall[1].rate * 100)}%
        </span>{" "}
        of its verdicts, <span className="font-semibold">{a}</span>{" "}
        <span className="font-semibold">
          {Math.round(overall[0].rate * 100)}%
        </span>
        . {b} is{" "}
        {better.length ? <>better on {names(better)}</> : "better on nothing"}
        {worse.length ? (
          <> and worse on {names(worse)}</>
        ) : (
          " and worse on nothing"
        )}
        .
      </p>
      <p className="text-sm text-ink-tertiary">
        {real.length
          ? `The change in ${names(real)} is larger than chance explains. `
          : "None of it is larger than chance explains yet — "}
        {tries}.
        {!real.length && paired < 15 && " Run more questions before deciding."}
      </p>
    </div>
  )
}

const TRUST: Record<string, { label: string; tone: string; means: string }> = {
  unknown: {
    label: "Not yet known",
    tone: "text-ink-tertiary",
    means: "Fewer than 20 of your calls: the number is the judge's word only.",
  },
  trusted: {
    label: "Trusted",
    tone: "text-emerald-700 dark:text-emerald-400",
    means: "Agrees with your calls at least 9 times in 10.",
  },
  gating: {
    label: "Can gate",
    tone: "text-emerald-700 dark:text-emerald-400",
    means: "50+ calls at 90%+ agreement: safe to block a publish on.",
  },
  disputed: {
    label: "Disputed",
    tone: "text-amber-700 dark:text-amber-400",
    means: "You overrule this judge more than 1 time in 10. Reword the check.",
  },
}

/** Per question, its attempts in order: the dot strip a cell draws. */
function strips(
  grid: EvalGrid
): Map<string, { inputId: string; tries: boolean[] }[]> {
  const out = new Map<string, Map<string, boolean[]>>()
  for (const v of grid.verdicts) {
    const k = `${v.checkId}|${v.version}`
    const byInput = out.get(k) ?? out.set(k, new Map()).get(k)!
    const tries =
      byInput.get(v.inputId) ?? byInput.set(v.inputId, []).get(v.inputId)!
    tries[v.attempt] = !v.failed
  }
  return new Map(
    [...out].map(([k, m]) => [
      k,
      [...m]
        .sort(([x], [y]) => x.localeCompare(y, undefined, { numeric: true }))
        // Object.values skips the holes a missing attempt leaves.
        .map(([inputId, tries]) => ({ inputId, tries: Object.values(tries) })),
    ])
  )
}

/** Where a check's name leads: its editor on the Checks page, with the same agent and set of checks. */
type CheckLink = { agent: string; dataset?: string; rubric: string }

function Grid({
  grid,
  open,
  onOpen,
  checkLink,
}: {
  grid: EvalGrid
  open: Cell | null
  onOpen: (c: Cell) => void
  checkLink?: CheckLink
}) {
  const b = grid.versions[1]
  const dots = useMemo(() => strips(grid), [grid])
  return (
    <div className="overflow-x-auto border-t border-primary-border">
      <table className="w-full min-w-[620px] border-separate border-spacing-0 text-xs tabular-nums">
        <thead>
          <tr className="text-left text-ink-secondary">
            <th className="px-4 py-2.5 font-medium">Check</th>
            {grid.versions.map((v) => (
              <th key={v} className="px-3 py-2.5 font-medium">
                {v}
              </th>
            ))}
            {b && (
              <th
                className="px-3 py-2.5 font-medium"
                title="Question by question: how many passed more often (+) or less often (−)"
              >
                Change
              </th>
            )}
            <th className="px-3 py-2.5 font-medium">Trust</th>
          </tr>
        </thead>
        <tbody>
          {grid.checks.map((c) => {
            const trust = TRUST[c.trust?.level ?? "unknown"]
            const ruled = c.trust?.ruled ?? 0
            return (
              <tr key={c.id} className="align-top">
                <td className="w-[30%] border-t border-primary-border px-4 py-3">
                  {checkLink ? (
                    <Link
                      to="/evals/checks"
                      search={{ ...checkLink, check: c.id }}
                      title="Open this check"
                      className="text-[13px] font-medium text-ink-primary underline-offset-2 hover:underline"
                    >
                      {c.label}
                    </Link>
                  ) : (
                    <div className="text-[13px] font-medium text-ink-primary">
                      {c.label}
                    </div>
                  )}
                  <div
                    className="mt-1 line-clamp-2 text-ink-tertiary"
                    title={c.sentence}
                  >
                    {c.sentence}
                  </div>
                  <div className="mt-1 text-ink-tertiary">
                    {c.kind === "counted"
                      ? "Read from the tool log"
                      : `Asked of ${c.judge}`}
                  </div>
                </td>
                {c.cells.map((cell, i) => {
                  const version = grid.versions[i]
                  const active =
                    open?.checkId === c.id && open.version === version
                  return (
                    <td
                      key={version}
                      className="border-t border-primary-border p-1.5"
                    >
                      <button
                        type="button"
                        onClick={() => onOpen({ checkId: c.id, version })}
                        aria-pressed={active}
                        className={cn(
                          "w-full rounded-md px-2.5 py-2 text-left outline-none hover:bg-primary-bg-hover focus-visible:ring-2 focus-visible:ring-ring",
                          active &&
                            "bg-primary-bg-active smooth-shadow-ring-xs smooth-ring-primary-border-active"
                        )}
                      >
                        <div className="flex items-baseline gap-1.5">
                          <span className="text-[15px] font-semibold text-ink-primary">
                            {cell.total
                              ? `${pct(cell.passed, cell.total)}%`
                              : "—"}
                          </span>
                          <span className="text-ink-tertiary">
                            {cell.passed}/{cell.total}
                          </span>
                        </div>
                        <DotStrip
                          questions={dots.get(`${c.id}|${version}`) ?? []}
                        />
                        {grid.attempts > 1 && (
                          <div className="mt-1.5 whitespace-nowrap text-ink-tertiary">
                            {cell.allPassed} of {cell.inputs} every time
                          </div>
                        )}
                      </button>
                    </td>
                  )
                })}
                {b && (
                  <td className="border-t border-primary-border px-3 py-3.5">
                    {c.compare && c.compare.pairs ? (
                      <>
                        <div className="text-[13px] whitespace-nowrap">
                          <span
                            className={
                              c.compare.improved
                                ? "text-emerald-700 dark:text-emerald-400"
                                : "text-ink-tertiary"
                            }
                          >
                            +{c.compare.improved}
                          </span>{" "}
                          <span
                            className={
                              c.compare.regressed
                                ? "text-red-600 dark:text-red-400"
                                : "text-ink-tertiary"
                            }
                          >
                            −{c.compare.regressed}
                          </span>
                        </div>
                        <div
                          className="mt-1 text-ink-tertiary"
                          title={`p = ${c.compare.p.toFixed(3)}`}
                        >
                          {c.compare.p < 0.05
                            ? "real difference"
                            : c.compare.improved + c.compare.regressed
                              ? "could be chance"
                              : "no change"}
                        </div>
                        <div className="mt-0.5 whitespace-nowrap text-ink-tertiary">
                          {Math.round(c.compare.rateA * 100)}% →{" "}
                          {Math.round(c.compare.rateB * 100)}%
                        </div>
                      </>
                    ) : (
                      <span className="text-ink-tertiary">—</span>
                    )}
                  </td>
                )}
                <td
                  className="border-t border-primary-border px-3 py-3.5"
                  title={trust.means}
                >
                  <div
                    className={cn(
                      "text-[13px] font-medium whitespace-nowrap",
                      trust.tone
                    )}
                  >
                    {trust.label}
                  </div>
                  <div className="mt-1 whitespace-nowrap text-ink-tertiary">
                    {ruled < 20
                      ? `${ruled} of 20 calls`
                      : `${pct(c.trust!.agreed, ruled)}% of ${ruled} agree`}
                  </div>
                  {ruled < 20 && (
                    <div className="mt-1.5 h-1 w-20 overflow-hidden rounded-full bg-primary-border">
                      <div
                        className="h-full bg-ink-tertiary"
                        style={{ width: `${(ruled / 20) * 100}%` }}
                      />
                    </div>
                  )}
                  {!!c.trust?.falsePasses && (
                    <div className="mt-1 text-amber-700 dark:text-amber-400">
                      passed {c.trust.falsePasses} you failed
                    </div>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {grid.errors.some((e) => e.errors) && (
        <p className="border-t border-primary-border px-4 py-2 text-xs text-ink-tertiary">
          {grid.errors
            .filter((e) => e.errors)
            .map(
              (e) =>
                `${e.version}: ${e.errors} thread${e.errors === 1 ? "" : "s"} failed to run and are left out`
            )
            .join(" · ")}
        </p>
      )}
    </div>
  )
}

/**
 * One cluster per question, one dot per try: filled passed, hollow failed.
 * A rate says how often; the strip says whether it is the same questions
 * failing every time or a coin toss everywhere, which a rate cannot.
 */
function DotStrip({
  questions,
}: {
  questions: { inputId: string; tries: boolean[] }[]
}) {
  return (
    <div className="mt-2 flex flex-wrap gap-x-1.5 gap-y-1" aria-hidden>
      {questions.map((q) => (
        <span
          key={q.inputId}
          className="flex gap-[2px]"
          title={`#${q.inputId}: ${q.tries.filter(Boolean).length} of ${q.tries.length}`}
        >
          {q.tries.map((ok, i) => (
            <span
              key={i}
              className={cn(
                "size-[7px] rounded-full",
                ok ? "bg-ink-secondary" : "ring-1 ring-ink-tertiary ring-inset"
              )}
            />
          ))}
        </span>
      ))}
    </div>
  )
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
  agent: string
  grid: EvalGrid
  cell: Cell
  onClose: () => void
  onRuled: () => void
}) {
  const check = grid.checks.find((c) => c.id === cell.checkId)
  // Order is fixed when the panel opens, so a call does not reshuffle the list under the cursor.
  const [order] = useState(() =>
    grid.verdicts
      .filter((v) => v.checkId === cell.checkId && v.version === cell.version)
      .sort(
        (x, y) =>
          Number(x.ruling !== null) - Number(y.ruling !== null) ||
          (x.confidence ?? 1) - (y.confidence ?? 1) ||
          x.inputId.localeCompare(y.inputId, undefined, { numeric: true }) ||
          x.attempt - y.attempt
      )
      .map((v) => v.threadId)
  )
  const rows = useMemo(() => {
    const by = new Map(
      grid.verdicts
        .filter((v) => v.checkId === cell.checkId && v.version === cell.version)
        .map((v) => [v.threadId, v])
    )
    return order.map((id) => by.get(id)).filter((r): r is Row => !!r)
  }, [grid, cell, order])
  const [at, setAt] = useState(0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const row = rows[Math.min(at, rows.length - 1)] as Row | undefined
  const ruledCount = rows.filter((r) => r.ruling !== null).length

  const rule = useCallback(
    async (failed: boolean) => {
      if (!row || saving) return
      setSaving(true)
      setError(null)
      // Making the call you already made takes it back.
      const res = await saveEvalRulingFn({
        data: {
          agent,
          threadId: row.threadId,
          checkId: row.checkId,
          failed: row.ruling === failed ? null : failed,
        },
      })
      setSaving(false)
      if (!res.ok) return setError(`Your call was not saved: ${res.error}.`)
      onRuled()
      if (row.ruling !== failed) setAt((i) => Math.min(i + 1, rows.length - 1))
    },
    [agent, row, rows.length, saving, onRuled]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) ||
        t.isContentEditable
      )
        return
      const k = e.key.toLowerCase()
      if (k === "p") void rule(false)
      else if (k === "f") void rule(true)
      else if (k === "j" || e.key === "ArrowDown")
        setAt((i) => Math.min(i + 1, rows.length - 1))
      else if (k === "k" || e.key === "ArrowUp")
        setAt((i) => Math.max(i - 1, 0))
      else return
      e.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [rule, rows.length])

  if (!check) return null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-start gap-3 border-b border-primary-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-ink-primary">
            {check.label}{" "}
            <span className="font-normal text-ink-tertiary">
              on {cell.version}
            </span>
          </div>
          <div
            className="mt-0.5 line-clamp-2 text-xs text-ink-tertiary"
            title={check.sentence}
          >
            {check.sentence}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close review"
          className="rounded p-0.5 text-ink-tertiary hover:text-ink-primary"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="flex items-center gap-2 border-b border-primary-border px-4 py-2 text-xs">
        <button
          type="button"
          aria-label="Previous thread"
          onClick={() => setAt((i) => Math.max(i - 1, 0))}
          className="rounded p-0.5 text-ink-secondary hover:text-ink-primary disabled:opacity-40"
          disabled={at === 0}
        >
          <ChevronUp className="size-4" />
        </button>
        <button
          type="button"
          aria-label="Next thread"
          onClick={() => setAt((i) => Math.min(i + 1, rows.length - 1))}
          className="rounded p-0.5 text-ink-secondary hover:text-ink-primary disabled:opacity-40"
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
                r.ruling === null
                  ? "bg-primary-border"
                  : r.ruling === r.failed
                    ? "bg-ink-secondary"
                    : "bg-amber-500",
                i === at && "h-4 bg-ink-primary"
              )}
            />
          ))}
        </div>
      </div>

      {row ? (
        <Thread
          key={row.threadId}
          agent={agent}
          row={row}
          repeated={grid.attempts > 1}
        />
      ) : (
        <p className="p-4 text-sm text-ink-tertiary">Nothing to review.</p>
      )}

      {row && (
        <div className="space-y-2 border-t border-primary-border px-4 py-3">
          <div className="flex items-center gap-2 text-xs">
            <span className="text-ink-secondary">The judge said</span>
            <span
              className={cn(
                "font-medium",
                row.failed
                  ? "text-red-600 dark:text-red-400"
                  : "text-emerald-700 dark:text-emerald-400"
              )}
            >
              {row.failed ? "fail" : "pass"}
            </span>
            <span className="text-ink-tertiary">
              ({row.answer.replace(/_/g, " ")}
              {row.confidence !== null
                ? `, ${Math.round(row.confidence * 100)}% sure`
                : ""}
              )
            </span>
            {row.ruling !== null && row.ruling !== row.failed && (
              <span className="ml-auto text-amber-700 dark:text-amber-400">
                you disagree
              </span>
            )}
          </div>
          <div
            className="grid grid-cols-2 gap-2"
            role="group"
            aria-label="Your call"
          >
            <CallButton
              on={row.ruling === false}
              disabled={saving}
              onClick={() => void rule(false)}
              hint="P"
            >
              Pass
            </CallButton>
            <CallButton
              on={row.ruling === true}
              disabled={saving}
              onClick={() => void rule(true)}
              hint="F"
            >
              Fail
            </CallButton>
          </div>
          {error ? (
            <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
          ) : (
            <p className="text-xs text-ink-tertiary">
              <Key>J</Key> <Key>K</Key> to move · <Key>Esc</Key> to close · make
              the same call again to take it back
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function CallButton({
  on,
  disabled,
  onClick,
  hint,
  children,
}: {
  on: boolean
  disabled: boolean
  onClick: () => void
  hint: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-9 items-center justify-center gap-2 rounded-md text-sm font-medium smooth-shadow-ring-xs outline-none smooth-ring-primary-border focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
        on
          ? "bg-ink-primary text-primary-bg"
          : "text-ink-primary hover:bg-primary-bg-hover"
      )}
    >
      {children}
      <span
        className={cn(
          "text-xs font-normal",
          on ? "opacity-70" : "text-ink-tertiary"
        )}
      >
        {hint}
      </span>
    </button>
  )
}

function Thread({
  agent,
  row,
  repeated,
}: {
  agent: string
  row: Row
  repeated: boolean
}) {
  return (
    <ThreadView
      agent={agent}
      threadId={row.threadId}
      caption={`Question #${row.inputId}${repeated ? `, try ${row.attempt + 1}` : ""}`}
    >
      <NoteBox agent={agent} threadId={row.threadId} />
    </ThreadView>
  )
}
