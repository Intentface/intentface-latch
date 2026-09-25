import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { createFileRoute, redirect } from "@tanstack/react-router"
import { ChevronDown, Loader2, RotateCw } from "lucide-react"
import { currentPrincipalFn } from "@/lib/server"
import {
  getEvalGridFn,
  getEvalsIndexFn,
  getQuestionsFn,
  saveEvalRulingFn,
  startJudgeFn,
} from "@/lib/evals-server"
import type { EvalGrid, JobRow } from "@/lib/evals-server"
import { AddColumn, AgainPanel } from "@/components/evals/run-menus"
import { ChecksDrawer, Composer, InputDrawer, SetDetails } from "@/components/evals/inputs"
import { GROUND, passColor } from "@/components/evals/ui"
import { RunDrawer } from "@/components/evals/run-drawer"
import { decodeResults, encodeResults } from "@/components/evals/compare-picker"
import type { Result } from "@/components/evals/compare-picker"
import { useEvalsChanged } from "@/components/evals/events"
import { ThreadView } from "@/components/evals/thread-view"
import { JobBanner, useJobs } from "@/components/evals/jobs"
import Drawer from "@/components/ui/drawer"
import { Popover } from "@/components/ui/popover"
import {
  EDITOR_DRAWER,
  EvalsEmpty,
  EvalsShell,
  NoEvalsYet,
  Picker,
  useOverview,
  useSetSearch,
  validateEvalsSearch,
} from "@/components/evals/shell"
import { Select } from "@/components/ui/select"
import { cn } from "@/lib/utils"

/**
 * Evals: the agent's inputs down the side, configurations across the top,
 * each cell one configuration's answer to one input, graded. Running a
 * configuration adds a column; comparing is choosing which columns are open,
 * the first being the baseline. Nothing here is organised around "runs" or
 * "experiments" — those are just where a column's answers came from.
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

type Column = EvalGrid["columns"][number]
type Verdict = EvalGrid["verdicts"][number]
type Filter = "all" | "changed" | "failing"

/** One configuration's answer to one input: every try, graded or not. */
type Cell = {
  tries: { threadId: string; attempt: number; pass: number; of: number; error: string | null }[]
  /** Mean share of checks passed over the graded tries, or null when none are. */
  rate: number | null
}

function EvalsPage() {
  const index = Route.useLoaderData()
  const search = Route.useSearch()
  const set = useSetSearch()

  const agent = search.agent ?? index[0]?.agent
  const [overview, reloadOverview] = useOverview(agent)
  const [grid, setGrid] = useState<EvalGrid | null>(null)
  const [loading, setLoading] = useState(false)
  const [runOpen, setRunOpen] = useState(false)
  const [filter, setFilter] = useState<Filter>("all")
  const [byCheck, setByCheck] = useState(false)
  const [openCell, setOpenCell] = useState<{ inputId: string; column: string } | null>(null)
  const [openInput, setOpenInput] = useState<string | null>(null)
  const [checksOpen, setChecksOpen] = useState(false)

  const dataset =
    overview?.datasets.find((d) => d.id === search.dataset) ??
    overview?.datasets.find((d) => d.runs.length) ??
    overview?.datasets[0]
  const rubricId = search.rubric ?? overview?.rubrics[0]?.id
  const columnsAsked = useMemo(() => decodeResults(search.cols), [search.cols])

  const reload = useCallback(() => {
    if (!agent || !dataset || !rubricId || !dataset.runs.length) return setGrid(null)
    setLoading(true)
    void getEvalGridFn({
      data: { agent, datasetId: dataset.id, rubricId, ...(columnsAsked.length ? { columns: columnsAsked } : {}) },
    })
      .then(setGrid)
      .finally(() => setLoading(false))
  }, [agent, dataset, rubricId, columnsAsked])
  useEffect(reload, [reload])
  useEvalsChanged(reload)

  const jobs = useJobs(agent, dataset?.id, (finished) => {
    reloadOverview()
    // A finished run opens beside what it was compared with, or on its own.
    if (finished.kind === "run")
      set({
        cols: encodeResults([
          ...(finished.compareWith ?? []),
          ...finished.versions.map((version) => ({ runId: finished.runId, version })),
        ]),
        focus: undefined,
      })
    else reload()
  })

  // While something runs, answers land every few seconds: show them as they do.
  const progress = jobs.rows.filter(isActive).map((j) => `${j.id}:${j.done}:${j.status}`).join(",")
  const seenProgress = useRef("")
  useEffect(() => {
    if (progress === seenProgress.current) return
    seenProgress.current = progress
    if (progress) reload()
  }, [progress, reload])

  if (!index.length) return <EvalsEmpty />

  const columns = grid?.columns ?? []
  const setColumns = (next: Result[], focus?: string) =>
    set({ cols: encodeResults(next), focus })
  const refs = columns.map((c) => ({ runId: c.runId, version: c.version }))

  return (
    <div className={GROUND}>
      <div className="evals-page mx-auto max-w-[1280px] space-y-5 p-6 transition-[margin]">
        <EvalsShell page="results" index={index} search={search}>
          {overview && overview.datasets.length > 1 && (
            <Picker label="Inputs">
              <Select
                id="evals-dataset"
                value={dataset?.id}
                onChange={(e) => set({ dataset: e.target.value, cols: undefined, focus: undefined })}
              >
                {overview.datasets.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({d.inputs})
                  </option>
                ))}
              </Select>
            </Picker>
          )}
          {overview && overview.rubrics.length > 1 && (
            <Picker label="Checks">
              <Select id="evals-rubric" value={rubricId} onChange={(e) => set({ rubric: e.target.value })}>
                {overview.rubrics.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.id}
                  </option>
                ))}
              </Select>
            </Picker>
          )}
        </EvalsShell>

        {agent && <JobBanner agent={agent} jobs={jobs.rows} onChanged={jobs.refresh} />}

        {overview && !overview.datasets.length && agent && (
          <NoEvalsYet agent={agent} onCreated={(id) => (set({ dataset: id }), reloadOverview())} />
        )}

        {overview && dataset && !dataset.runs.length && (
          <NothingRun agent={agent} datasetId={dataset.id} onRun={() => setRunOpen(true)} onChanged={reloadOverview} />
        )}

        {grid ? (
          <Results
            agent={agent}
            grid={grid}
            focusAsked={search.focus}
            filter={filter}
            setFilter={setFilter}
            byCheck={byCheck}
            setByCheck={setByCheck}
            runs={dataset?.runs ?? []}
            onOpen={setOpenCell}
            onBaseline={(label) => {
              const i = columns.findIndex((c) => c.label === label)
              setColumns([refs[i], ...refs.filter((_, n) => n !== i)])
            }}
            onFocus={(label) => set({ focus: label })}
            onHide={(label) => setColumns(refs.filter((_, n) => columns[n].label !== label))}
            onShow={(r) => setColumns([...refs, r], undefined)}
            onStarted={(added) => (setColumns([...refs, ...added], added[0]?.version), jobs.refresh())}
            onAgain={jobs.refresh}
            datasetId={dataset?.id ?? ""}
            rubricId={rubricId ?? ""}
            jobs={jobs.rows}
            onOpenInput={setOpenInput}
            onOpenChecks={() => setChecksOpen(true)}
            onAdded={(id) => (reload(), reloadOverview(), setOpenInput(id))}
          />
        ) : (
          loading && <Loader2 className="text-ink-tertiary size-4 animate-spin" />
        )}

        {agent && dataset && rubricId && runOpen && (
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

        {agent && grid && dataset && (
          <InputDrawer
            agent={agent}
            datasetId={dataset.id}
            input={grid.inputs.find((i) => i.id === openInput) ?? null}
            checks={grid.checks}
            results={<InputResults grid={grid} inputId={openInput} onOpen={(column) => (setOpenInput(null), setOpenCell({ inputId: openInput!, column }))} />}
            onClose={() => setOpenInput(null)}
            onSaved={reload}
            onOpenChecks={() => (setOpenInput(null), setChecksOpen(true))}
          />
        )}
        {agent && rubricId && (
          <ChecksDrawer agent={agent} rubricId={rubricId} open={checksOpen} onClose={() => setChecksOpen(false)} onSaved={reload} />
        )}

        {agent && grid && (
          <AnswerDrawer
            agent={agent}
            grid={grid}
            at={openCell}
            onClose={() => setOpenCell(null)}
            onRuled={reload}
            datasetId={dataset?.id ?? ""}
            rubricId={rubricId ?? ""}
            onAgain={() => (setOpenCell(null), jobs.refresh())}
          />
        )}
      </div>
    </div>
  )
}

const isActive = (j: JobRow) => j.status === "running" || j.status === "judging"

// ─── Numbers ──────────────────────────────────────────────────────────────

/** Every cell of the grid, keyed "input|column". */
function cellsOf(grid: EvalGrid): Map<string, Cell> {
  const verdictsOf = new Map<string, Verdict[]>()
  for (const v of grid.verdicts) verdictsOf.set(v.threadId, [...(verdictsOf.get(v.threadId) ?? []), v])
  const out = new Map<string, Cell>()
  for (const t of grid.threads) {
    const key = `${t.inputId}|${t.column}`
    const vs = verdictsOf.get(t.threadId) ?? []
    const cell = out.get(key) ?? { tries: [], rate: null }
    cell.tries.push({ threadId: t.threadId, attempt: t.attempt, pass: vs.filter((v) => !v.failed).length, of: vs.length, error: t.error })
    out.set(key, cell)
  }
  for (const cell of out.values()) {
    cell.tries.sort((a, b) => a.attempt - b.attempt)
    const graded = cell.tries.filter((x) => !x.error && x.of)
    cell.rate = graded.length ? graded.reduce((a, x) => a + x.pass / x.of, 0) / graded.length : null
  }
  return out
}

/** Share of all checks passed in a column, over its graded answers. */
function columnRate(grid: EvalGrid, cells: Map<string, Cell>, label: string) {
  let pass = 0, of = 0
  for (const i of grid.inputs)
    for (const t of cells.get(`${i.id}|${label}`)?.tries ?? []) if (!t.error) (pass += t.pass, of += t.of)
  return of ? pass / of : null
}

/**
 * How likely a split this lopsided is by chance, if the change did nothing:
 * a two-sided sign test on the inputs that moved.
 */
function signTest(up: number, down: number) {
  const n = up + down, k = Math.min(up, down)
  if (!n) return 1
  let c = 1, sum = 0
  for (let i = 0; i <= k; i++) {
    if (i) c = (c * (n - i + 1)) / i
    sum += c
  }
  return Math.min(1, (2 * sum) / 2 ** n)
}

const day = (at: number) => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" })
const pct = (r: number | null) => (r === null ? "—" : `${Math.round(r * 100)}%`)
const money = (x: number) => (x < 1 ? `${Math.max(1, Math.round(x * 100))}¢` : `$${x.toFixed(2)}`)

// ─── Results ─────────────────────────────────────────────────────────────

function Results({
  agent,
  grid,
  focusAsked,
  filter,
  setFilter,
  byCheck,
  setByCheck,
  runs,
  onOpen,
  onBaseline,
  onFocus,
  onHide,
  onShow,
  onStarted,
  onAgain,
  datasetId,
  rubricId,
  jobs,
  onOpenInput,
  onOpenChecks,
  onAdded,
}: {
  agent: string
  grid: EvalGrid
  focusAsked: string | undefined
  filter: Filter
  setFilter: (f: Filter) => void
  byCheck: boolean
  setByCheck: (b: boolean) => void
  runs: { runId: string; versions: string[]; name: string | null; createdAt: number; questions: number; tries: number }[]
  onOpen: (at: { inputId: string; column: string }) => void
  onBaseline: (label: string) => void
  onFocus: (label: string) => void
  onHide: (label: string) => void
  onShow: (r: Result) => void
  onStarted: (added: Result[]) => void
  onAgain: () => void
  datasetId: string
  rubricId: string
  jobs: JobRow[]
  onOpenInput: (id: string) => void
  onOpenChecks: () => void
  onAdded: (id: string) => void
}) {
  const cells = useMemo(() => cellsOf(grid), [grid])
  const [picked, setPicked] = useState<Set<string>>(new Set())
  // What is running against which column, so cells can say so instead of "—".
  const active = jobs.filter(isActive)
  const running = (c: Column) => active.find((j) => j.kind === "run" && !j.again && j.runId === c.runId && j.versions.includes(c.version))
  const grading = (c: Column) => active.some((j) => j.runId === c.runId && (j.kind === "judge" || j.status === "judging"))
  const againFor = (c: Column, inputId: string) =>
    active.some((j) => j.again && j.runId === c.runId && j.versions.includes(c.version) && j.inputIds.includes(inputId))
  const columnRefs = grid.columns.map((c) => ({ runId: c.runId, version: c.version, label: c.label }))
  const gradeUngraded = async (inputIds: string[] | null) => {
    const verdictOf = new Set(grid.verdicts.map((v) => v.threadId))
    for (const c of grid.columns) {
      // Graded under older checks: every answer needs grading under the new ones.
      const stale = c.judgedWith < grid.latestVersion
      const threadIds = grid.threads
        .filter((t) => t.column === c.label && !t.error && (stale || !verdictOf.has(t.threadId)) && (!inputIds || inputIds.includes(t.inputId)))
        .map((t) => t.threadId)
      if (threadIds.length) await startJudgeFn({ data: { agent, datasetId, rubricId, runId: c.runId, threadIds } })
    }
    onAgain()
  }
  const [base, ...rest] = grid.columns
  const focus = rest.find((c) => c.label === focusAsked) ?? rest.at(0)
  const cell = (inputId: string, label: string) => cells.get(`${inputId}|${label}`)
  // A column is called by its version; the day is added only where two share one.
  const nameOf = (c: Column) => (grid.columns.filter((x) => x.version === c.version).length > 1 ? `${c.version} · ${day(c.at)}` : c.version)

  // The baseline against the column in the headline, on the inputs both answered.
  const rows = grid.inputs.map((i) => {
    const a = cell(i.id, base.label)?.rate ?? null
    const b = focus ? (cell(i.id, focus.label)?.rate ?? null) : null
    return { input: i, d: a !== null && b !== null ? Math.sign(b - a) : null }
  })
  const shared = rows.filter((r) => r.d !== null)
  const up = shared.filter((r) => r.d! > 0).length
  const down = shared.filter((r) => r.d! < 0).length
  const p = signTest(up, down)
  const triesOf = (c: Column) => Math.max(1, ...grid.threads.filter((t) => t.column === c.label).map((t) => t.attempt + 1))
  const broken = focus ? grid.inputs.filter((i) => cell(i.id, focus.label)?.tries.some((t) => t.error)).length : 0

  const shown = rows.filter((r) =>
    filter === "all" || !focus
      ? true
      : filter === "changed"
        ? r.d !== null && r.d !== 0
        : (cell(r.input.id, focus.label)?.rate ?? 1) < 1,
  )
  const hidden = runs.flatMap((r) =>
    r.versions
      .filter((v) => !grid.columns.some((c) => c.runId === r.runId && c.version === v))
      .map((v) => ({ runId: r.runId, version: v, run: r })),
  )

  return (
    <section className="border-primary-border bg-primary-bg rounded-xl border" aria-label="Results">
      <div className="border-primary-border space-y-3 border-b px-5 py-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            {focus ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 tabular-nums">
                <span className="flex items-baseline gap-2.5 text-[22px] tracking-tight">
                  <span className="text-ink-tertiary">{nameOf(base)} {pct(columnRate(grid, cells, base.label))}</span>
                  <span className="text-ink-tertiary text-base" aria-hidden>→</span>
                  <b className="text-ink-primary font-semibold">{nameOf(focus)} {pct(columnRate(grid, cells, focus.label))}</b>
                </span>
                <span className="text-ink-secondary text-[13px]">
                  <b className="font-semibold text-[color:var(--eval-good-ink)]">{up} better</b> ·{" "}
                  <b className="font-semibold text-[color:var(--eval-bad-ink)]">{down} worse</b> · {shared.length - up - down} same
                </span>
                <span
                  title={p < 0.05 ? `${up + down} inputs changed, ${Math.max(up, down)} the same way — very unlikely to be chance.` : "Too few inputs changed to tell. Run it with more tries per input."}
                  className={cn(
                    "rounded-full px-2.5 py-0.5 text-xs font-medium",
                    p < 0.05 ? "bg-[color:var(--eval-good)] text-ink-primary" : "border-primary-border text-ink-secondary border",
                  )}
                >
                  {p < 0.05 ? `Clear ${up >= down ? "improvement" : "regression"}` : "Could be chance"}
                </span>
              </div>
            ) : (
              <div className="text-ink-primary text-[22px] font-semibold tabular-nums">
                {nameOf(base)} {pct(columnRate(grid, cells, base.label))}
              </div>
            )}
            <p className="text-ink-tertiary mt-1 text-xs tabular-nums">
              {focus
                ? `${focus.runName ?? nameOf(focus)} · compared with ${nameOf(base)} on ${shared.length} input${shared.length === 1 ? "" : "s"} · ${triesOf(focus) > 1 ? `${triesOf(focus)} tries each` : "1 try"}${focus.runId !== base.runId ? " · answered on different days" : ""}`
                : "Add a column to compare with it."}
              {broken > 0 && ` · ${broken} answer${broken === 1 ? "" : "s"} broke — left out of the score`}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            value={filter}
            onChange={setFilter}
            options={[
              ["all", "All"],
              ["changed", "Changed"],
              ["failing", "Still failing"],
            ]}
          />
          <span className="flex-1" />
          {focus && (
            <button
              type="button"
              aria-expanded={byCheck}
              onClick={() => setByCheck(!byCheck)}
              className="text-ink-secondary hover:text-ink-primary flex items-center gap-1 text-[13px]"
            >
              By check <ChevronDown className={cn("size-3.5 transition-transform", byCheck && "rotate-180")} />
            </button>
          )}
        </div>
        {byCheck && focus && <ByCheck grid={grid} base={base} focus={focus} />}
      </div>

      {picked.size > 0 && (
        <div className="border-primary-border bg-primary-bg-hover flex flex-wrap items-center gap-3 border-b px-5 py-2 text-[13px]">
          <b className="text-ink-primary tabular-nums">{picked.size} selected</b>
          <Popover>
            <Popover.Trigger render={<button type="button" className="border-primary-border bg-primary-bg hover:bg-primary-bg-hover flex h-7 items-center gap-1.5 rounded-md border px-2.5" />}>
              <RotateCw className="size-3.5" /> Answer again
            </Popover.Trigger>
            <Popover.Content align="start" className="w-80 p-1">
              <AgainPanel agent={agent} datasetId={datasetId} rubricId={rubricId} inputIds={[...picked]} columns={columnRefs} onStarted={() => (setPicked(new Set()), onAgain())} />
            </Popover.Content>
          </Popover>
          <button type="button" className="text-ink-secondary hover:text-ink-primary underline underline-offset-2" onClick={() => void gradeUngraded([...picked]).then(() => setPicked(new Set()))}>
            Grade what isn't graded
          </button>
          <button type="button" className="text-ink-tertiary hover:text-ink-primary ml-auto" onClick={() => setPicked(new Set())}>
            Clear
          </button>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-primary-border border-b">
              <th className="bg-primary-bg sticky left-0 z-10 w-9 py-2 pl-3">
                <input
                  type="checkbox"
                  aria-label="Select every input"
                  checked={picked.size === grid.inputs.length}
                  onChange={() => setPicked(picked.size === grid.inputs.length ? new Set() : new Set(grid.inputs.map((i) => i.id)))}
                />
              </th>
              <th className="bg-primary-bg text-ink-tertiary sticky left-9 z-10 w-10 px-3 py-2 text-left text-xs font-medium">#</th>
              <th className="bg-primary-bg text-ink-tertiary sticky left-[76px] z-10 w-[480px] max-w-[480px] px-3 py-2 text-left text-xs font-medium">Input</th>
              {grid.columns.map((c, n) => (
                <th key={c.label} className="min-w-[132px] px-2 py-2 text-center align-bottom">
                  <ColumnMenu
                    column={c}
                    isBase={n === 0}
                    isFocus={c.label === focus?.label}
                    rate={columnRate(grid, cells, c.label)}
                    tries={triesOf(c)}
                    state={running(c) ? `answering · ${running(c)!.done}/${running(c)!.total}` : grading(c) ? "grading…" : null}
                    failed={grid.inputs.filter((i) => (cell(i.id, c.label)?.rate ?? 1) < 1).map((i) => i.id)}
                    againPanel={(ids, done) => (
                      <AgainPanel agent={agent} datasetId={datasetId} rubricId={rubricId} inputIds={ids} columns={columnRefs} preset={[c.label]} onStarted={() => (done(), onAgain())} />
                    )}
                    onGrade={() => void gradeUngraded(null)}
                    stale={c.judgedWith < grid.latestVersion && !grading(c)}
                    canHide={grid.columns.length > 1}
                    onBaseline={() => onBaseline(c.label)}
                    onFocus={() => onFocus(c.label)}
                    onHide={() => onHide(c.label)}
                  />
                </th>
              ))}
              <th className="w-full px-2 py-2 text-left align-bottom">
                <AddColumn
                  agent={agent}
                  datasetId={datasetId}
                  rubricId={rubricId}
                  shown={grid.columns.map((c) => ({ runId: c.runId, version: c.version }))}
                  hidden={hidden}
                  onShow={onShow}
                  onStarted={onStarted}
                />
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map(({ input }) => (
              <tr key={input.id} className="group/row border-primary-border border-b last:border-b-0">
                <td className="bg-primary-bg sticky left-0 z-10 py-1.5 pl-3">
                  <input
                    type="checkbox"
                    aria-label={`Select input ${input.id}`}
                    checked={picked.has(input.id)}
                    onChange={() => {
                      const next = new Set(picked)
                      if (next.has(input.id)) next.delete(input.id)
                      else next.add(input.id)
                      setPicked(next)
                    }}
                  />
                </td>
                <td className="bg-primary-bg text-ink-tertiary sticky left-9 z-10 px-3 py-1.5 tabular-nums">{input.id}</td>
                <td className="bg-primary-bg sticky left-[76px] z-10 w-[480px] max-w-[480px] px-3 py-1.5">
                  <InputText input={input} onOpen={() => onOpenInput(input.id)} />
                </td>
                {grid.columns.map((c) => (
                  <td key={c.label} className="px-2 py-1.5 text-center whitespace-nowrap">
                    <CellButton
                      pending={againFor(c, input.id) ? "answering…" : !cell(input.id, c.label) && running(c) ? "···" : null}
                      cell={cell(input.id, c.label)}
                      baseRate={c.label === base.label ? null : (cell(input.id, base.label)?.rate ?? null)}
                      label={`Input ${input.id} on ${c.label}`}
                      onOpen={() => onOpen({ inputId: input.id, column: c.label })}
                    />
                  </td>
                ))}
                <td className="px-1 py-1.5">
                  <Popover>
                    <Popover.Trigger
                      render={
                        <button
                          type="button"
                          aria-label={`Answer input ${input.id} again`}
                          title="Answer again"
                          className="text-ink-tertiary hover:text-ink-primary hover:bg-primary-bg-hover grid size-7 place-items-center rounded-md opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
                        />
                      }
                    >
                      <RotateCw className="size-3.5" />
                    </Popover.Trigger>
                    <Popover.Content align="end" className="w-80 p-1">
                      <AgainPanel agent={agent} datasetId={datasetId} rubricId={rubricId} inputIds={[input.id]} columns={columnRefs} onStarted={onAgain} />
                    </Popover.Content>
                  </Popover>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-primary-border border-t px-4 py-3">
        <Composer agent={agent} datasetId={datasetId} onAdded={onAdded} />
      </div>
      <div className="text-ink-tertiary border-primary-border flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-5 py-2.5 text-xs">
        <span className="tabular-nums">{grid.inputs.length} inputs</span>
        <span>
          Every input also: {grid.checks.map((c) => c.label).join(" · ")}{" "}
          <button type="button" onClick={onOpenChecks} className="text-ink-secondary hover:text-ink-primary underline underline-offset-2">
            Edit
          </button>
        </span>
        <span className="flex-1" />
        <Popover>
          <Popover.Trigger render={<button type="button" className="text-ink-secondary hover:text-ink-primary underline underline-offset-2" />}>About these inputs</Popover.Trigger>
          <Popover.Content align="end" className="w-80 p-1">
            <SetDetails agent={agent} datasetId={datasetId} />
          </Popover.Content>
        </Popover>
      </div>
    </section>
  )
}

function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: [T, string][] }) {
  return (
    <div role="radiogroup" className="smooth-shadow-ring-xs smooth-ring-primary-border inline-flex rounded-lg p-0.5 text-xs">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={cn("rounded-md px-2.5 py-1", value === v ? "bg-primary-bg-active text-ink-primary font-medium" : "text-ink-secondary hover:text-ink-primary")}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

/**
 * Per check, on the inputs both columns answered: the share that passed, the
 * baseline's mark on the same bar. Counts alone would mislead when one
 * column answered fewer inputs, or tried each more than once.
 */
function ByCheck({ grid, base, focus }: { grid: EvalGrid; base: Column; focus: Column }) {
  const inputsOf = (checkId: string, label: string) => new Set(grid.verdicts.filter((v) => v.checkId === checkId && v.version === label).map((v) => v.inputId))
  const rateOf = (checkId: string, label: string, only: Set<string>) => {
    const vs = grid.verdicts.filter((v) => v.checkId === checkId && v.version === label && only.has(v.inputId))
    return { pass: vs.filter((v) => !v.failed).length, of: vs.length }
  }
  const share = (x: { pass: number; of: number }) => (x.of ? x.pass / x.of : 0)
  return (
    <table className="w-full text-[13px] tabular-nums" aria-label="By check">
      <tbody>
        {grid.checks.map((c) => {
          const theirs = inputsOf(c.id, focus.label)
          const both = new Set([...inputsOf(c.id, base.label)].filter((id) => theirs.has(id)))
          const a = rateOf(c.id, base.label, both), b = rateOf(c.id, focus.label, both)
          const d = Math.round((share(b) - share(a)) * 100)
          return (
            <tr key={c.id}>
              <td className="text-ink-secondary py-1 pr-4" title={c.sentence}>{c.label}</td>
              <td className="w-[34%] py-1">
                <span className="bg-primary-bg-hover relative block h-1.5 rounded-full">
                  <i className="absolute inset-y-0 left-0 rounded-full bg-[color:var(--eval-good)]" style={{ width: `${share(b) * 100}%` }} />
                  <u className="bg-ink-tertiary absolute -top-[3px] h-3 w-0.5 rounded" style={{ left: `calc(${share(a) * 100}% - 1px)` }} />
                </span>
              </td>
              <td className="w-28 py-1 text-right">
                {b.pass}/{b.of} <span className="text-ink-tertiary">was {a.pass}/{a.of}</span>
              </td>
              <td className={cn("w-14 py-1 text-right text-xs font-semibold", d > 0 ? "text-[color:var(--eval-good-ink)]" : d < 0 ? "text-[color:var(--eval-bad-ink)]" : "text-ink-tertiary")}>
                {!both.size ? "—" : d > 0 ? `+${d} pts` : d < 0 ? `${d} pts` : "same"}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function ColumnMenu({
  column,
  isBase,
  isFocus,
  rate,
  tries,
  state,
  failed,
  againPanel,
  onGrade,
  stale,
  canHide,
  onBaseline,
  onFocus,
  onHide,
}: {
  column: Column
  isBase: boolean
  isFocus: boolean
  rate: number | null
  tries: number
  /** What is happening to it right now — answering, grading. */
  state: string | null
  failed: string[]
  againPanel: (inputIds: string[], done: () => void) => React.ReactNode
  onGrade: () => void
  /** Graded under an older version of the checks. */
  stale: boolean
  canHide: boolean
  onBaseline: () => void
  onFocus: () => void
  onHide: () => void
}) {
  const item = "hover:bg-primary-bg-hover flex w-full flex-col items-start rounded-md px-2.5 py-1.5 text-left text-sm"
  const [open, setOpen] = useState(false)
  const [again, setAgain] = useState(false)
  const pick = (f: () => void) => () => (setOpen(false), f())
  return (
    <Popover open={open} onOpenChange={(o) => (setOpen(o), o || setAgain(false))}>
      <Popover.Trigger render={<button type="button" className="group inline-flex flex-col items-center" />}>
        <span className={cn("flex items-center gap-1 text-xs font-semibold whitespace-nowrap", isFocus || isBase ? "text-ink-primary" : "text-ink-secondary group-hover:text-ink-primary")}>
          {column.version}
          {isBase && <span className="border-primary-border text-ink-tertiary rounded-full border px-1.5 text-[10px] font-medium">baseline</span>}
          <ChevronDown className="size-3" />
        </span>
        <span className={cn("text-[11px] whitespace-nowrap tabular-nums", state ? "text-ink-secondary" : "text-ink-tertiary")}>
          {state ? <><Loader2 className="mr-1 inline size-3 animate-spin" />{state}</> : <>{day(column.at)} · {pct(rate)}</>}
          {column.spent > 0 && ` · ${money(column.spent)}`}
          {tries > 1 && ` · ${tries} tries`}
        </span>
      </Popover.Trigger>
      {stale && (
        <button type="button" onClick={onGrade} className="border-primary-border text-ink-secondary hover:text-ink-primary mx-auto mt-1 block rounded-full border border-dashed px-2 text-[10.5px] whitespace-nowrap">
          New checks · grade them
        </button>
      )}
      <Popover.Content align="start" className="w-80 p-1.5">
        {again ? againPanel(failed, () => setOpen(false)) : <>
        <div className="text-ink-tertiary px-2.5 pt-1 pb-1.5 text-xs">
          {column.runName ?? "Unnamed run"} · {day(column.at)}
          {column.spent > 0 && ` · spent ${money(column.spent)}`}
        </div>
        {!isBase && (
          <button type="button" className={item} onClick={pick(onBaseline)}>
            Use as baseline <span className="text-ink-tertiary text-xs">The others are compared with it</span>
          </button>
        )}
        {!isBase && !isFocus && (
          <button type="button" className={item} onClick={pick(onFocus)}>
            Compare in the headline <span className="text-ink-tertiary text-xs">Against the baseline</span>
          </button>
        )}
        {failed.length > 0 && (
          <button type="button" className={item} onClick={() => setAgain(true)}>
            Answer again where it failed <span className="text-ink-tertiary text-xs tabular-nums">{failed.length} input{failed.length === 1 ? "" : "s"} · another try each</span>
          </button>
        )}
        <button type="button" className={item} onClick={pick(onGrade)}>
          Grade what isn't graded <span className="text-ink-tertiary text-xs">Answers without a grade under the current checks · cents</span>
        </button>
        {canHide && (
          <button type="button" className={item} onClick={pick(onHide)}>
            Hide column <span className="text-ink-tertiary text-xs">Its answers are kept</span>
          </button>
        )}
        </>}
      </Popover.Content>
    </Popover>
  )
}

function CellButton({
  cell,
  baseRate,
  label,
  pending,
  onOpen,
}: {
  cell: Cell | undefined
  baseRate: number | null
  label: string
  /** Being answered right now — shown instead of the result, or of "—". */
  pending: string | null
  onOpen: () => void
}) {
  if (pending) return <span className="text-ink-tertiary inline-flex h-7 min-w-[76px] items-center justify-center text-xs">{pending}</span>
  if (!cell) return <span className="text-ink-tertiary text-xs">—</span>
  const broke = cell.tries.every((t) => t.error)
  if (broke)
    return (
      <button type="button" onClick={onOpen} title={cell.tries[0].error ?? undefined} className="border-ink-tertiary text-ink-secondary inline-flex h-7 min-w-[76px] items-center justify-center rounded-full border border-dashed px-2.5 text-xs">
        Broke
      </button>
    )
  if (cell.rate === null)
    return (
      <button type="button" onClick={onOpen} className="border-ink-tertiary text-ink-secondary inline-flex h-7 min-w-[76px] items-center justify-center rounded-full border border-dashed px-2.5 text-xs">
        Not graded
      </button>
    )
  const graded = cell.tries.filter((t) => !t.error && t.of)
  const of = Math.max(...graded.map((t) => t.of))
  const differ = new Set(graded.map((t) => t.pass)).size > 1
  const d = baseRate === null ? 0 : Math.sign(cell.rate - baseRate)
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${label}: ${graded.map((t) => t.pass).join(" and ")} of ${of}`}
        style={{ background: passColor(cell.rate) }}
        className="text-ink-primary inline-flex min-w-[76px] flex-col items-center justify-center rounded-full px-2.5 py-1 text-xs leading-tight font-semibold tabular-nums hover:ring-2 hover:ring-[color:var(--color-ink-tertiary)]"
      >
        {graded.map((t) => t.pass).join(" · ")}/{of}
        {graded.length > 1 && <small className={cn("text-[9.5px] font-medium", differ ? "text-[color:var(--eval-bad-ink)]" : "text-ink-secondary")}>{graded.length} tries{differ ? " · differ" : ""}</small>}
      </button>
      <span aria-hidden className={cn("w-2 text-[11px]", d > 0 ? "text-[color:var(--eval-good-ink)]" : "text-[color:var(--eval-bad-ink)]", !d && "invisible")}>
        {d > 0 ? "▲" : "▼"}
      </span>
    </span>
  )
}

/**
 * An input, one line. Resting on it grows its own block in place — the whole
 * text, any follow-ups — over the rows below, so nothing is shown twice and
 * the table doesn't jump. The block is drawn at the page's top level: inside
 * the sticky cell it would sit under the next row's sticky cell.
 */
function InputText({ input, onOpen }: { input: EvalGrid["inputs"][number]; onOpen: () => void }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [grown, setGrown] = useState<DOMRect | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const show = () => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      const el = ref.current
      if (!el) return
      if (el.scrollWidth <= el.clientWidth && !input.followUps.length) return
      setGrown(el.getBoundingClientRect())
    }, 220)
  }
  const hide = () => {
    clearTimeout(timer.current)
    setGrown(null)
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  // Fixed to where the row was; once anything scrolls, it no longer is.
  useEffect(() => {
    if (!grown) return
    const off = () => setGrown(null)
    window.addEventListener("scroll", off, true)
    return () => window.removeEventListener("scroll", off, true)
  }, [grown])
  return (
    <div onMouseEnter={show} onMouseLeave={(e) => { if (!(e.relatedTarget instanceof Element && e.relatedTarget.closest("[data-grown]"))) hide() }} className="relative">
      <button type="button" onClick={onOpen} className="block w-full text-left">
        <span ref={ref} className="text-ink-primary block truncate leading-7 hover:underline hover:decoration-[color:var(--color-ink-tertiary)] hover:underline-offset-2">
          {input.prompt}
        </span>
      </button>
      {grown && createPortal(
        <div
          data-grown
          onMouseLeave={hide}
          onClick={() => (hide(), onOpen())}
          className="border-primary-border bg-primary-bg text-ink-primary fixed z-40 cursor-pointer space-y-1.5 rounded-lg border px-2.5 pt-2 pb-2 text-[13px] leading-[1.4] shadow-lg"
          style={{ left: grown.left - 11, top: grown.top - 4, width: grown.width + 22 }}
        >
          <div>{input.prompt}</div>
          {input.followUps.map((f, n) => (
            <div key={n} className="text-ink-secondary text-xs">
              <span className="text-ink-tertiary mr-2">Then asks</span>
              {f}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}

/**
 * Before anything has run: the inputs are still the rows, editable, with the
 * composer under them — and one button to get the first answers.
 */
function NothingRun({ agent, datasetId, onRun, onChanged }: { agent: string; datasetId: string; onRun: () => void; onChanged: () => void }) {
  const [inputs, setInputs] = useState<EvalGrid["inputs"] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const load = useCallback(() => {
    void getQuestionsFn({ data: { agent, datasetId } }).then((r) =>
      setInputs(r?.questions.map((q) => ({ id: q.id, prompt: q.prompt, followUps: q.followUps, answer: q.answer || null, docs: q.docs, mustNot: q.mustNot })) ?? []),
    )
  }, [agent, datasetId])
  useEffect(load, [load])
  return (
    <section className="border-primary-border bg-primary-bg rounded-xl border">
      <div className="space-y-3 px-5 py-5">
        <h2 className="text-ink-primary text-[22px] font-semibold">Nothing has run yet</h2>
        <p className="text-ink-secondary max-w-[62ch] text-sm">
          {inputs?.length ?? 0} input{inputs?.length === 1 ? " is" : "s are"} ready. Run a configuration to get its answers, graded against what each input expects.
        </p>
        <button type="button" onClick={onRun} disabled={!inputs?.length} className="bg-ink-primary text-primary-bg h-9 rounded-lg px-4 text-sm font-medium disabled:opacity-40">
          Run a configuration
        </button>
      </div>
      {inputs && inputs.length > 0 && (
        <ul className="divide-primary-border border-primary-border divide-y border-t">
          {inputs.map((i) => (
            <li key={i.id}>
              <button type="button" onClick={() => setOpen(i.id)} className="hover:bg-primary-bg-hover flex w-full gap-3 px-5 py-2 text-left text-[13px]">
                <span className="text-ink-tertiary w-6 shrink-0 tabular-nums">{i.id}</span>
                <span className="text-ink-primary truncate">{i.prompt}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="border-primary-border border-t px-4 py-3">
        <Composer agent={agent} datasetId={datasetId} onAdded={(id) => (load(), onChanged(), setOpen(id))} />
      </div>
      <InputDrawer
        agent={agent}
        datasetId={datasetId}
        input={inputs?.find((i) => i.id === open) ?? null}
        checks={[]}
        results={<p className="text-ink-tertiary text-xs">Not run yet.</p>}
        onClose={() => setOpen(null)}
        onSaved={load}
        onOpenChecks={() => setOpen(null)}
      />
    </section>
  )
}

/** In an input's drawer: each open column's result on it, to open. */
function InputResults({ grid, inputId, onOpen }: { grid: EvalGrid; inputId: string | null; onOpen: (column: string) => void }) {
  const cells = useMemo(() => cellsOf(grid), [grid])
  if (!inputId) return null
  const shown = grid.columns.map((c) => ({ c, cell: cells.get(`${inputId}|${c.label}`) }))
  if (!shown.some((x) => x.cell)) return <p className="text-ink-tertiary text-xs">Not run yet — use ↻ on its row to answer it.</p>
  return (
    <div className="flex flex-wrap gap-2">
      {shown.map(({ c, cell }) =>
        cell ? (
          <button
            key={c.label}
            type="button"
            onClick={() => onOpen(c.label)}
            style={{ background: cell.rate === null ? undefined : passColor(cell.rate) }}
            className="text-ink-primary rounded-full px-3 py-1 text-xs font-semibold tabular-nums"
          >
            {c.version} · {cell.rate === null ? "not graded" : `${Math.round(cell.rate * 100)}%`}
          </button>
        ) : null,
      )}
    </div>
  )
}

// ─── One answer ──────────────────────────────────────────────────────────

/** A verdict's answer, in words; the raw value when there is no better one. */
const WHY: Record<string, string> = {
  partly_grounded: "Only partly from what it read",
  unsupported: "Not from anything it read",
  nothing_read: "It read nothing",
  asked_to_clarify: "Asked a question instead of answering",
  misses_the_point: "Misses the point of the good answer",
  partial: "Partly matches the good answer",
}

/**
 * One configuration's answer to one input: which try, each check with why,
 * the whole conversation as its user saw it — tool calls and what came back
 * — and a way to say the grader got a check wrong.
 */
function AnswerDrawer({
  agent,
  grid,
  at,
  onClose,
  onRuled,
  datasetId,
  rubricId,
  onAgain,
}: {
  agent: string
  grid: EvalGrid
  at: { inputId: string; column: string } | null
  onClose: () => void
  onRuled: () => void
  datasetId: string
  rubricId: string
  onAgain: () => void
}) {
  const [againOpen, setAgainOpen] = useState(false)
  useEffect(() => setAgainOpen(false), [at?.inputId, at?.column])
  const cells = useMemo(() => cellsOf(grid), [grid])
  const [tryN, setTryN] = useState(0)
  useEffect(() => setTryN(0), [at?.inputId, at?.column])
  const cell = at ? cells.get(`${at.inputId}|${at.column}`) : undefined
  const input = at ? grid.inputs.find((i) => i.id === at.inputId) : undefined
  const allTries = cell?.tries ?? []
  const pick = allTries.at(Math.min(tryN, allTries.length - 1))
  const verdicts = pick ? grid.verdicts.filter((v) => v.threadId === pick.threadId) : []
  const checkOf = (id: string) => grid.checks.find((c) => c.id === id)

  const rule = async (v: Verdict, failed: boolean | null) => {
    await saveEvalRulingFn({ data: { agent, threadId: v.threadId, checkId: v.checkId, failed } })
    onRuled()
  }

  return (
    <Drawer open={!!at} onOpenChange={(o) => !o && onClose()}>
      <Drawer.Content className={EDITOR_DRAWER}>
        {at && input && pick && (
          <div className="flex h-full flex-col">
            <Drawer.Header className="border-primary-border space-y-1 border-b px-5">
              <Drawer.Description className="text-ink-tertiary text-xs tabular-nums">
                Input {input.id} · {at.column}
              </Drawer.Description>
              <Drawer.Title className="text-ink-primary text-base leading-snug">{input.prompt}</Drawer.Title>
              {allTries.length > 1 && (
                <div className="pt-1">
                  <Segmented
                    value={String(tryN)}
                    onChange={(v) => setTryN(Number(v))}
                    options={allTries.map((t, n) => [String(n), `Try ${n + 1}${t.error ? " · broke" : ` · ${t.pass}/${t.of}`}`])}
                  />
                </div>
              )}
            </Drawer.Header>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="flex flex-wrap items-center gap-2 px-5 pt-4">
                <button type="button" onClick={() => setAgainOpen(!againOpen)} className="border-primary-border hover:bg-primary-bg-hover flex h-8 items-center gap-1.5 rounded-md border px-3 text-[13px]">
                  <RotateCw className="size-3.5" /> Answer again
                </button>
                {!pick.error && !verdicts.length && (
                  <button
                    type="button"
                    className="border-primary-border hover:bg-primary-bg-hover h-8 rounded-md border px-3 text-[13px]"
                    onClick={() => {
                      const col = grid.columns.find((c) => c.label === at.column)
                      if (col) void startJudgeFn({ data: { agent, datasetId, rubricId, runId: col.runId, threadIds: [pick.threadId] } }).then(onAgain)
                    }}
                  >
                    Grade it
                  </button>
                )}
              </div>
              {againOpen && (() => {
                const col = grid.columns.find((c) => c.label === at.column)
                return col ? (
                  <div className="border-primary-border mx-5 mt-3 rounded-lg border">
                    <AgainPanel agent={agent} datasetId={datasetId} rubricId={rubricId} inputIds={[input.id]} columns={[{ runId: col.runId, version: col.version, label: col.label }]} onStarted={onAgain} />
                  </div>
                ) : null
              })()}
              <div className="space-y-2 px-5 pt-4">
                {pick.error ? (
                  <div className="border-primary-border bg-primary-bg-hover rounded-lg border px-3 py-2.5 text-sm">
                    <b className="text-ink-primary">This answer broke.</b>{" "}
                    <span className="text-ink-secondary">{pick.error}</span>
                    <p className="text-ink-tertiary mt-1 text-xs">It's left out of the score rather than counted as a fail.</p>
                  </div>
                ) : (
                  <>
                    <div className="text-ink-tertiary text-xs">Checks</div>
                    <ul className="divide-primary-border border-primary-border divide-y rounded-lg border">
                      {verdicts.map((v) => {
                        const c = checkOf(v.checkId)
                        const why = WHY[v.answer] ?? ""
                        const overruled = v.ruling !== null && v.ruling !== v.failed
                        const shownFailed = v.ruling ?? v.failed
                        return (
                          <li key={v.checkId} className="grid grid-cols-[18px_minmax(0,1fr)_auto] items-baseline gap-2.5 px-3 py-2 text-[13px]">
                            <span className={cn("font-bold", shownFailed ? "text-[color:var(--eval-bad-ink)]" : "text-[color:var(--eval-good-ink)]")}>{shownFailed ? "✕" : "✓"}</span>
                            <span>
                              <span className="text-ink-primary">{c?.label ?? v.checkId}</span>
                              {why && <span className="text-ink-tertiary block text-xs">{why}</span>}
                              {overruled && <span className="text-ink-tertiary block text-xs">You said the grader got this wrong</span>}
                            </span>
                            {c?.kind === "counted" ? (
                              <span className="text-ink-tertiary text-[11px]">exact · tool log</span>
                            ) : overruled ? (
                              <button type="button" className="text-ink-secondary text-xs underline underline-offset-2" onClick={() => void rule(v, null)}>
                                Undo
                              </button>
                            ) : (
                              <button type="button" className="text-ink-secondary hover:text-ink-primary text-xs underline underline-offset-2" onClick={() => void rule(v, !v.failed)}>
                                Wrong?
                              </button>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  </>
                )}
              </div>
              <ThreadView key={pick.threadId} agent={agent} threadId={pick.threadId} caption="The conversation" />
            </div>
          </div>
        )}
      </Drawer.Content>
    </Drawer>
  )
}
