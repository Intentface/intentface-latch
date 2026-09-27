import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { createFileRoute, redirect } from "@tanstack/react-router"
import { ChevronDown, Loader2, RotateCw } from "lucide-react"
import { currentPrincipalFn } from "@/lib/server"
import {
  getEvalGridFn,
  getEvalsIndexFn,
  getQuestionsFn,
  renameVariantFn,
  saveEvalRulingFn,
  startJudgeFn,
} from "@/lib/evals-server"
import type { EvalGrid, JobRow } from "@/lib/evals-server"
import { AddColumn, AgainPanel, EarlierAnswers } from "@/components/evals/run-menus"
import { ChecksDrawer, Composer, InputDrawer, SetDetails } from "@/components/evals/inputs"
import { askEvalsAgent } from "@/components/evals/agent-panel"
import { eachOf, labelsOf, saysItems } from "@/lib/evals/v2/expect"
import { cellsOf, columnRate, verdictFor, versus } from "@/lib/evals/v2/score"
import type { Cell } from "@/lib/evals/v2/score"
import { GROUND, passColor } from "@/components/evals/ui"
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
type Filter = "all" | "changed" | "failing" | "better" | "worse" | "same"

/** One configuration's answer to one input: every try, graded or not. */

function EvalsPage() {
  const index = Route.useLoaderData()
  const search = Route.useSearch()
  const set = useSetSearch()

  const agent = search.agent ?? index[0]?.agent
  const [overview, reloadOverview] = useOverview(agent)
  const [grid, setGrid] = useState<EvalGrid | null>(null)
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState<Filter>("all")
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
    // Answering again added tries to columns already open: just show them.
    if (finished.kind === "run" && !finished.again)
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
          <NothingRun
            agent={agent}
            datasetId={dataset.id}
            rubricId={rubricId ?? ""}
            onStarted={(added) => (setColumns(added, added[0]?.version), jobs.refresh(), reloadOverview())}
            onChanged={reloadOverview}
          />
        )}

        {grid ? (
          <Results
            agent={agent}
            grid={grid}
            focusAsked={search.focus}
            filter={filter}
            setFilter={setFilter}
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
            onRenamed={(c, name) => {
              setColumns(refs.map((r) => (r.runId === c.runId && r.version === c.version ? { ...r, version: name } : r)))
              reloadOverview()
            }}
          />
        ) : (
          loading && <Loader2 className="text-ink-tertiary size-4 animate-spin" />
        )}


        {agent && grid && dataset && (
          <InputDrawer
            agent={agent}
            datasetId={dataset.id}
            rubricId={rubricId}
            input={grid.inputs.find((i) => i.id === openInput) ?? null}
            checks={grid.checks.filter((c) => !expectationChecks(grid).some((e) => e.checkId === c.id))}
            results={<InputResults grid={grid} inputId={openInput} onOpen={(column) => (setOpenInput(null), setOpenCell({ inputId: openInput!, column }))} />}
            onClose={() => setOpenInput(null)}
            onSaved={reload}
            onOpenChecks={() => (setOpenInput(null), setChecksOpen(true))}
          />
        )}
        {agent && rubricId && (
          <ChecksDrawer agent={agent} rubricId={rubricId} datasetId={dataset?.id} open={checksOpen} onClose={() => setChecksOpen(false)} onSaved={reload} />
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

/**
 * The brief for "Why do these still fail?": which columns, which inputs, and
 * what to come back with — causes grouped, one fix proposed as a new
 * configuration, priced, not run.
 */
function whyPrompt(agent: string, datasetId: string, rubricId: string, base: Column, focus: Column, failing: string[]) {
  return [
    `For ${agent}, question set ${datasetId}, checks ${rubricId}: the column ${focus.label} (run ${focus.runId}, version ${focus.version}) still fails a check on ${failing.length} input${failing.length === 1 ? "" : "s"}: ${failing.join(", ")}. The baseline is ${base.label} (run ${base.runId}).`,
    "Read those threads and find the first thing that went wrong in each. Group them by cause and list each group with the inputs it covers, biggest first.",
    "Then propose ONE fix for the biggest group, as a new configuration: an edit to @draft (propose_fix) when the instructions or a tool are at fault, or a variant (create_variant) when it's a question of model or reasoning effort. If the failure is specific to some inputs, say which per-input expectation would catch it.",
    "Don't run anything yet: price re-running only the failing inputs with estimate_run and tell me the cost.",
  ].join("\n\n")
}

/**
 * The checks that read an input's own expectations: the one comparing with
 * its good answer, the one looking for the document it names. The rest apply
 * to every input the same way.
 */
function expectationChecks(grid: EvalGrid) {
  return grid.checks.filter((c) => c.reads).map((c) => ({ checkId: c.id, reads: c.reads! }))
}
/** An input's lists, as the grader numbers them. */
const listsOf = (i: EvalGrid["inputs"][number]) => ({ mustSay: i.mustSay, mustNot: i.mustNot, decline: i.decline, asks: i.asks, judged: i.judged })
/** How many tests an input brings itself — each item of its lists counts. */
const expectationCount = (i: EvalGrid["inputs"][number]) =>
  (i.answer ? 1 : 0) + i.calls.length + saysItems(listsOf(i)).length

// ─── Numbers ──────────────────────────────────────────────────────────────

const day = (at: number) => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" })
const time = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
const pct = (r: number | null) => (r === null ? "—" : `${Math.round(r * 100)}%`)
const money = (x: number) => (x < 1 ? `${Math.max(1, Math.round(x * 100))}¢` : `$${x.toFixed(2)}`)



// ─── Results ─────────────────────────────────────────────────────────────

function Results({
  agent,
  grid,
  focusAsked,
  filter,
  setFilter,
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
  onRenamed,
}: {
  agent: string
  grid: EvalGrid
  focusAsked: string | undefined
  filter: Filter
  setFilter: (f: Filter) => void
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
  /** A variant got a new name: its column follows it. */
  onRenamed: (c: Column, name: string) => void
}) {
  const cells = useMemo(() => cellsOf(grid), [grid])
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const expectations = expectationChecks(grid)
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
  // Compared by default: the first column that changed something — a re-run of the baseline's own setup only shows noise.
  const focus = rest.find((c) => c.label === focusAsked) ?? rest.find((c) => !c.setup || c.setup !== base.setup) ?? rest.at(0)
  const cell = (inputId: string, label: string) => cells.get(`${inputId}|${label}`)
  // A column is called by its version; the day is added only where two share one.
  // When a column was answered: the day, and the time where another column shares it.
  const whenOf = (c: Column) => (grid.columns.some((x) => x !== c && x.version === c.version && day(x.at) === day(c.at)) ? `${day(c.at)}, ${time(c.at)}` : day(c.at))
  // A column is called by its version; the day, then the time, only where two would share a name.
  const nameOf = (c: Column) => {
    const same = grid.columns.filter((x) => x.version === c.version)
    if (same.length < 2) return c.version
    return same.filter((x) => day(x.at) === day(c.at)).length < 2 ? `${c.version} · ${day(c.at)}` : `${c.version} · ${day(c.at)}, ${time(c.at)}`
  }

  // The baseline against the column in the headline, on the inputs both answered.
  const rows = grid.inputs.map((i) => {
    const a = cell(i.id, base.label)?.rate ?? null
    const b = focus ? (cell(i.id, focus.label)?.rate ?? null) : null
    return { input: i, d: a !== null && b !== null ? Math.sign(b - a) : null }
  })
  // Tries per input in a column: a range, since answering one input again gives only it a second.
  const triesOf = (c: Column) => {
    const per = grid.inputs.map((i) => cell(i.id, c.label)?.tries.length ?? 0).filter((n) => n > 0)
    const lo = per.length ? Math.min(...per) : 1, hi = per.length ? Math.max(...per) : 1
    return lo === hi ? (hi > 1 ? `${hi} tries each` : "1 try") : `${lo}–${hi} tries`
  }
  const broken = focus ? grid.inputs.filter((i) => cell(i.id, focus.label)?.tries.some((t) => t.error)).length : 0

  const shown = rows.filter((r) =>
    filter === "all" || !focus
      ? true
      : filter === "changed"
        ? r.d !== null && r.d !== 0
        : filter === "better"
          ? r.d !== null && r.d > 0
          : filter === "worse"
            ? r.d !== null && r.d < 0
            : filter === "same"
              ? r.d === 0
              : (cell(r.input.id, focus.label)?.rate ?? 1) < 1,
  )
  const hidden = runs.flatMap((r) =>
    r.versions
      .filter((v) => !grid.columns.some((c) => c.runId === r.runId && c.version === v))
      .map((v) => ({ runId: r.runId, version: v, run: r })),
  )

  return (
    <section className="border-primary-border bg-primary-bg rounded-xl border" aria-label="Results">
      <div className="border-primary-border space-y-3 border-b px-5 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-ink-tertiary text-xs tabular-nums">{grid.inputs.length} inputs</span>
          <button
            type="button"
            className="text-ink-secondary hover:text-ink-primary mr-2 text-xs underline underline-offset-2"
            onClick={() => askEvalsAgent(`For ${agent}: write 10 more inputs like the ones in this set — everyday ones, tricky ones, and a few it should decline — each with what a good answer says, and add them with edit_questions.`)}
          >
            Generate more
          </button>
          <Segmented
            value={filter}
            onChange={setFilter}
            options={[
              ["all", "All"],
              ["changed", "Changed"],
              ["failing", "Still failing"],
            ]}
          />
          {focus && (filter === "better" || filter === "worse" || filter === "same") && (
            <button type="button" onClick={() => setFilter("all")} className="bg-primary-bg-active text-ink-primary flex h-7 items-center gap-1 rounded-md px-2.5 text-xs">
              {shown.length} scored {filter === "better" ? "higher" : filter === "worse" ? "lower" : "the same"} on {nameOf(focus)} <span aria-hidden className="text-ink-tertiary">✕</span>
            </button>
          )}
          {focus && filter !== "all" && !(filter === "better" || filter === "worse" || filter === "same") && <span className="text-ink-tertiary text-xs">on {nameOf(focus)}</span>}
          {broken > 0 && (
            <span className="text-ink-tertiary text-xs tabular-nums">
              · {broken} answer{broken === 1 ? "" : "s"} on {nameOf(focus!)} broke — left out of the score
            </span>
          )}
          <span className="flex-1" />
          {focus && (
            <button
              type="button"
              onClick={() => askEvalsAgent(whyPrompt(agent, datasetId, rubricId, base, focus, grid.inputs.filter((i) => (cell(i.id, focus.label)?.rate ?? 1) < 1).map((i) => i.id)))}
              className="border-primary-border hover:bg-primary-bg-hover h-7 shrink-0 rounded-lg border px-3 text-xs"
            >
              Why do these still fail?
            </button>
          )}
          <EarlierAnswers hidden={hidden} onShow={onShow} />
          <AddColumn
            agent={agent}
            datasetId={datasetId}
            rubricId={rubricId}
            shown={grid.columns.map((c) => ({ runId: c.runId, version: c.version }))}
            onShow={onShow}
            onStarted={onStarted}
          />
        </div>
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
                <th key={c.label} className="w-[176px] min-w-[176px] px-2 py-2 text-center align-bottom">
                  <ColumnMenu
                    column={c}
                    isBase={n === 0}
                    when={whenOf(c)}
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
                    {...(c.version !== "live" && !c.version.startsWith("@")
                      ? {
                          onRename: async (name: string) => {
                            const r = await renameVariantFn({ data: { agent, from: c.version, name } })
                            if (!r.ok) return r.error
                            onRenamed(c, r.name)
                            return null
                          },
                        }
                      : {})}
                    canHide={grid.columns.length > 1}
                    onBaseline={() => onBaseline(c.label)}
                    onHide={() => onHide(c.label)}
                    {...(n > 0
                      ? (() => {
                          const v = versus(grid, cells, base.label, c.label)
                          return {
                            moved: { up: v.up, down: v.down, p: v.p, verdict: verdictFor(v), sameSetup: !!c.setup && c.setup === base.setup },
                            onShowMoved: (f: "better" | "worse") => (onFocus(c.label), setFilter(f)),
                          }
                        })()
                      : {})}
                  />
                </th>
              ))}
              <th className="w-full" />
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
                  <InputText
                    input={input}
                    onOpen={() => onOpenInput(input.id)}
                    count={expectationCount(input)}
                    shared={grid.checks.filter((c) => !c.reads).length}
                  />
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
        <span className="flex flex-wrap items-center gap-1.5">
          Every input also:
          {grid.checks
            .filter((c) => !expectations.some((e) => e.checkId === c.id))
            .map((c) => (
              <span key={c.id} title={c.sentence} className="border-primary-border text-ink-secondary rounded-full border px-2 py-0.5">
                {c.label}
              </span>
            ))}
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
 * The judge's confidence, in JEV's terms: q, the probability of the label it
 * gave. At or above the check's accept threshold τ the verdict is accepted;
 * below it, escalated — to a stronger judge, or to you. τ comes from your
 * rulings; until a check has enough, 80% stands in. For a scale check, where
 * on the scale it landed.
 */
function Sureness({ verdict, scale, accept }: { verdict: Verdict; scale: { levels: string[]; bad: number } | null; accept: number | null }) {
  const name = (l: string) => l.replace(/_/g, " ")
  if (scale && verdict.score !== null) {
    const top = scale.levels.length - 1
    const at = Math.max(0, Math.min(top, verdict.score))
    const lo = Math.floor(at), hi = Math.ceil(at)
    const between = hi !== lo && Math.abs(at - Math.round(at)) > 0.2
    const onLine = between && (lo <= scale.bad) !== (hi <= scale.bad)
    return (
      <span className="mt-1 flex items-center gap-2 text-[11px]" title={`Score ${at.toFixed(1)} on ${scale.levels.map(name).join(" · ")}. The lowest ${scale.bad + 1} fail.`}>
        <span className="relative flex h-1.5 w-28 gap-0.5" aria-hidden>
          {scale.levels.map((l, n) => (
            <i key={l} className={cn("flex-1 rounded-[2px] opacity-50", n <= scale.bad ? "bg-[color:var(--eval-bad)]" : "bg-[color:var(--eval-good)]")} />
          ))}
          <i className="bg-ink-primary absolute -top-[3px] h-3 w-0.5 rounded" style={{ left: `calc(${((at + 0.5) / scale.levels.length) * 100}% - 1px)` }} />
        </span>
        <span className="text-ink-secondary">Label: {between ? `between ${name(scale.levels[lo])} and ${name(scale.levels[hi])}` : name(scale.levels[Math.round(at)])}</span>
        {onLine && <span className="text-ink-primary">· on the pass line, escalate</span>}
        {verdict.escalatedTo && <span className="text-ink-tertiary">· escalated to {verdict.escalatedTo}</span>}
      </span>
    )
  }
  if (verdict.confidence === null) return null
  const q = verdict.confidence
  const tau = accept ?? 0.8
  const escalate = q < tau
  return (
    <span
      className="mt-1 flex items-center gap-2 text-[11px] tabular-nums"
      title={`Confidence: the judge's probability for the label it gave. Accept threshold τ ${Math.round(tau * 100)}%${accept === null ? " — a default until this check has 20 of your rulings" : ", from your rulings"}. Below it, a verdict is escalated: to a stronger judge, or to you.`}
    >
      <span className="bg-primary-bg-active relative h-1.5 w-28 overflow-hidden rounded-full" aria-hidden>
        <i className={cn("absolute inset-y-0 left-0 rounded-full", escalate ? "bg-ink-tertiary" : "bg-ink-secondary")} style={{ width: `${q * 100}%` }} />
        <i className="bg-ink-primary/60 absolute inset-y-0 w-px" style={{ left: `${tau * 100}%` }} />
      </span>
      <span className={escalate ? "text-ink-primary" : "text-ink-tertiary"}>
        {verdict.answer !== "true" && verdict.answer !== "false" && <>Label: <span className="font-mono">{verdict.answer}</span> · </>}
        Confidence {Math.round(q * 100)}% · {escalate ? "escalate" : "accept"}
      </span>
      {verdict.escalatedTo && <span className="text-ink-tertiary">· escalated to {verdict.escalatedTo}</span>}
    </span>
  )
}

function ColumnMenu({
  column,
  isBase,
  when,
  isFocus,
  rate,
  tries,
  state,
  failed,
  againPanel,
  onGrade,
  stale,
  onRename,
  canHide,
  onBaseline,
  onHide,
  moved,
  onShowMoved,
}: {
  column: Column
  isBase: boolean
  /** The day it was answered, with the time when another column shares the day. */
  when: string
  isFocus: boolean
  rate: number | null
  tries: string
  /** What is happening to it right now — answering, grading. */
  state: string | null
  failed: string[]
  againPanel: (inputIds: string[], done: () => void) => React.ReactNode
  onGrade: () => void
  /** Graded under an older version of the checks. */
  stale: boolean
  /** A variant's column can be renamed; versions keep their names. */
  onRename?: (name: string) => Promise<string | null>
  canHide: boolean
  onBaseline: () => void
  onHide: () => void
  /** Against the baseline: inputs that scored higher and lower, and what that adds up to. Absent on the baseline. */
  moved?: { up: number; down: number; p: number; verdict: string; sameSetup: boolean }
  onShowMoved?: (f: "better" | "worse") => void
}) {
  const item = "hover:bg-primary-bg-hover flex w-full flex-col items-start rounded-md px-2.5 py-1.5 text-left text-sm"
  const [open, setOpen] = useState(false)
  const [again, setAgain] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameError, setRenameError] = useState<string | null>(null)
  const pick = (f: () => void) => () => (setOpen(false), f())
  return (
    <Popover open={open} onOpenChange={(o) => (setOpen(o), o || setAgain(false))}>
      <span className="flex flex-col items-center leading-tight">
        {/* 1 · the name, which opens the column's menu */}
        <Popover.Trigger render={<button type="button" className="group flex items-center gap-0.5 rounded px-1 text-[13px] font-semibold tracking-tight whitespace-nowrap" />}>
          <span className={isFocus || isBase ? "text-ink-primary" : "text-ink-secondary group-hover:text-ink-primary"}>{column.version}</span>
          <ChevronDown className="text-ink-tertiary group-hover:text-ink-primary size-3" />
        </Popover.Trigger>
        {/* 2 · when, how often */}
        <span className={cn("mt-0.5 text-[11px] whitespace-nowrap tabular-nums", state ? "text-ink-secondary" : "text-ink-tertiary")}>
          {state ? <><Loader2 className="mr-1 inline size-3 animate-spin" />{state}</> : when}
          {!state && tries !== "1 try" && ` · ${tries.replace(" each", "")}`}
        </span>
        {/* 3 · the number */}
        <span className="mt-1.5 flex items-baseline gap-1">
          <span className={cn("font-mono text-[22px] leading-none font-medium tracking-[0.04em] tabular-nums", stale ? "text-ink-secondary" : "text-ink-primary")} title="Share of checks passed">
            {pct(rate)}
          </span>
          {stale && (
            <button type="button" onClick={onGrade} title="Graded with older checks — grade these answers with the current ones" className="text-ink-tertiary hover:text-ink-primary">
              <RotateCw className="size-3" />
            </button>
          )}
        </span>
        {/* 4 · what it adds up to */}
        <span className="mt-1 flex h-4 items-center gap-1.5 text-[11px] whitespace-nowrap tabular-nums">
          {moved ? (
            <>
              <button type="button" disabled={!moved.up} onClick={() => onShowMoved?.("better")} title={`${moved.up} scored higher than the baseline — show them`} className="font-medium text-[color:var(--eval-good-ink)] enabled:hover:underline disabled:opacity-40">
                ▲{moved.up}
              </button>
              <button type="button" disabled={!moved.down} onClick={() => onShowMoved?.("worse")} title={`${moved.down} scored lower than the baseline — show them`} className="font-medium text-[color:var(--eval-bad-ink)] enabled:hover:underline disabled:opacity-40">
                ▼{moved.down}
              </button>
              <span
                title={
                  moved.sameSetup
                    ? "The baseline's own configuration, answered again: every ▲ and ▼ is the agent answering differently on its own — the noise a real change has to beat."
                    : moved.verdict.startsWith("Maybe")
                      ? `${moved.up} scored higher, ${moved.down} lower. If nothing had changed, chance would split them this unevenly about 1 time in ${Math.max(2, Math.round(1 / moved.p))} — so it leans ${moved.up > moved.down ? "better" : "worse"}, but isn't sure. Answer again with 3 tries to settle it.`
                      : moved.verdict === "No real difference"
                        ? `${moved.up} scored higher, ${moved.down} lower — about what answering again alone does. More tries per input would tell.`
                        : moved.verdict === "No change"
                        ? "Every input scored the same as the baseline."
                        : `${moved.up + moved.down} inputs moved, ${Math.max(moved.up, moved.down)} of them the same way — more than chance would.`
                }
                className={cn(
                  moved.sameSetup || moved.verdict === "No real difference" || moved.verdict === "No change"
                    ? "text-ink-tertiary"
                    : moved.verdict === "Clearly better"
                      ? "font-medium text-[color:var(--eval-good-ink)]"
                      : moved.verdict === "Clearly worse"
                        ? "font-medium text-[color:var(--eval-bad-ink)]"
                        : moved.verdict === "Maybe better"
                          ? "text-[color:var(--eval-good-ink)] opacity-80"
                          : "text-[color:var(--eval-bad-ink)] opacity-80",
                )}
              >
                {moved.sameSetup ? "same setup" : moved.verdict.toLowerCase()}
              </span>
            </>
          ) : (
            <span className="text-ink-tertiary">{isBase ? "baseline" : ""}</span>
          )}
        </span>
      </span>
      <Popover.Content align="start" className="w-80 p-1.5">
        {again ? againPanel(failed, () => setOpen(false)) : <>
        <div className="text-ink-tertiary px-2.5 pt-1 pb-1.5 text-xs">
          {column.runName ?? "Unnamed run"} · {when} · {pct(rate)} of checks passed
          {column.spent > 0 && ` · spent ${money(column.spent)}`}
        </div>
        {!isBase && (
          <button type="button" className={item} onClick={pick(onBaseline)}>
            Use as baseline <span className="text-ink-tertiary text-xs">The others are compared with it</span>
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
        {onRename &&
          (renaming === null ? (
            <button type="button" className={item} onClick={() => (setRenaming(column.version), setRenameError(null))}>
              Rename <span className="text-ink-tertiary text-xs">A variant's name, as its column shows it</span>
            </button>
          ) : (
            <form
              className="space-y-1.5 px-2.5 py-1.5"
              onSubmit={(e) => {
                e.preventDefault()
                void onRename(renaming).then((err) => (err ? setRenameError(err) : (setRenaming(null), setOpen(false))))
              }}
            >
              <input autoFocus value={renaming} maxLength={48} onChange={(e) => setRenaming(e.target.value)} aria-label="New name" className="border-primary-border bg-primary-bg w-full rounded-md border px-2 py-1 text-sm outline-none" />
              {renameError && <p className="text-xs text-red-600 dark:text-red-400">{renameError}</p>}
              <button type="submit" className="bg-ink-primary text-primary-bg h-7 rounded-md px-3 text-xs font-medium">
                Save name
              </button>
            </form>
          ))}
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
function InputText({ input, onOpen, count, shared }: { input: EvalGrid["inputs"][number]; onOpen: () => void; count: number; shared: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [grown, setGrown] = useState<DOMRect | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const show = () => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      const el = ref.current
      if (!el) return
      if (el.scrollWidth <= el.clientWidth && !input.followUps.length && !input.files.length) return
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
      <button type="button" onClick={onOpen} className="flex w-full items-center gap-3 text-left">
        <span ref={ref} className="text-ink-primary block min-w-0 flex-1 truncate leading-7 hover:underline hover:decoration-[color:var(--color-ink-tertiary)] hover:underline-offset-2">
          {input.prompt}
        </span>
        {input.files.length > 0 && <span className="text-ink-tertiary shrink-0 text-[11.5px] tabular-nums" title={input.files.map((f) => f.filename).join(", ")}>📎 {input.files.length}</span>}
        <span className="text-ink-tertiary shrink-0 text-[11.5px] tabular-nums" title={`${count || "None"} of its own, ${shared} every input gets`}>
          {count + shared} test{count + shared === 1 ? "" : "s"}
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
          {input.files.length > 0 && <div className="text-ink-secondary text-xs">📎 {input.files.map((f) => f.filename).join(", ")}</div>}
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
function NothingRun({
  agent,
  datasetId,
  rubricId,
  onStarted,
  onChanged,
}: {
  agent: string
  datasetId: string
  rubricId: string
  onStarted: (added: Result[]) => void
  onChanged: () => void
}) {
  const [inputs, setInputs] = useState<EvalGrid["inputs"] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const load = useCallback(() => {
    void getQuestionsFn({ data: { agent, datasetId } }).then((r) =>
      setInputs(
        r?.questions.map((q) => ({ id: q.id, prompt: q.prompt, followUps: q.followUps, answer: q.answer || null, mustNot: q.mustNot, mustSay: q.mustSay, asks: q.asks, decline: q.decline, calls: q.calls, judged: q.judged, files: q.files })) ?? [],
      ),
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
        {inputs && inputs.length > 0 && rubricId && (
          <AddColumn agent={agent} datasetId={datasetId} rubricId={rubricId} shown={[]} onShow={() => {}} onStarted={onStarted} first />
        )}
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
        rubricId={rubricId}
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

/** An expected call in words: "calls read_file · file contains a.md", "never calls send_email". */
const callText = (c: EvalGrid["inputs"][number]["calls"][number]) => {
  const cut = c.tool.indexOf("_")
  const tool = cut > 0 && c.tool.slice(0, cut).includes("-") ? c.tool.slice(cut + 1) : c.tool
  if (c.never) return `never calls ${tool}`
  const m = (c.match ?? []).map((x) => (x.op === "any" ? `${x.path} set` : `${x.path === "result" ? "the result" : x.path} ${x.op.replace("_", " ")} ${x.value ?? ""}`)).join(", ")
  return `calls ${tool}${m ? ` · ${m}` : ""}`
}
const sayText = (x: ReturnType<typeof saysItems>[number]) =>
  x.kind === "mustSay" ? `says: ${x.text}` : x.kind === "mustNot" ? `doesn't say: ${x.text}` : x.kind === "decline" ? "declines" : x.text

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
  const [labelsOpen, setLabelsOpen] = useState<Set<string>>(new Set())
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
                        const each = eachOf(v.answer)
                        const itemLabels = labelsOf(v.answer)
                        const items = c?.reads === "calls" ? input.calls.map(callText) : c?.reads === "says" ? saysItems(listsOf(input)).map((x) => sayText(x)) : []
                        const overruled = v.ruling !== null && v.ruling !== v.failed
                        const shownFailed = v.ruling ?? v.failed
                        return (
                          <li key={v.checkId} className="grid grid-cols-[18px_minmax(0,1fr)_auto] items-baseline gap-2.5 px-3 py-2 text-[13px]">
                            <span className={cn("font-bold", shownFailed ? "text-[color:var(--eval-bad-ink)]" : "text-[color:var(--eval-good-ink)]")}>{shownFailed ? "✕" : "✓"}</span>
                            <span>
                              <span className="text-ink-primary">{c?.label ?? v.checkId}</span>
                              {c &&
                                (c.labels ? (
                                  <button
                                    type="button"
                                    aria-expanded={labelsOpen.has(v.checkId)}
                                    onClick={() => setLabelsOpen((o) => (o.has(v.checkId) ? new Set([...o].filter((x) => x !== v.checkId)) : new Set([...o, v.checkId])))}
                                    title={c.type === "choice" ? "The judge picks one of these labels — show them" : "The judge places it on this scale — show it"}
                                    className="border-primary-border text-ink-tertiary hover:text-ink-primary ml-1.5 rounded border px-1 py-px align-[1px] font-mono text-[10px]"
                                  >
                                    {c.type} · {c.labels.length} {labelsOpen.has(v.checkId) ? "▴" : "▾"}
                                  </button>
                                ) : (
                                  <span
                                    title={c.type === "rule" ? "A rule on the tool log — exact, no judge" : "The judge answers yes or no"}
                                    className="border-primary-border text-ink-tertiary ml-1.5 rounded border px-1 py-px align-[1px] font-mono text-[10px]"
                                  >
                                    {c.type}
                                  </span>
                                ))}
                              {c?.labels && labelsOpen.has(v.checkId) && (
                                <span className="border-primary-border mt-1.5 block space-y-0.5 border-l-2 pl-2">
                                  {c.labels.map((l) => {
                                    const given = l.id === v.answer
                                    return (
                                      <span key={l.id} className={cn("grid grid-cols-[12px_minmax(0,1fr)] gap-1.5 text-xs", given ? "text-ink-primary" : "text-ink-tertiary")}>
                                        <span className={l.fails ? "text-[color:var(--eval-bad-ink)]" : "text-[color:var(--eval-good-ink)]"}>{l.fails ? "✕" : "✓"}</span>
                                        <span>
                                          <span className={cn("font-mono", given && "font-semibold")}>{l.id}</span>
                                          {given && <span className="text-ink-secondary"> ← the judge's label</span>}
                                          <span className="block">{l.means}</span>
                                        </span>
                                      </span>
                                    )
                                  })}
                                </span>
                              )}
                              {why && <span className="text-ink-tertiary block text-xs">{why}</span>}
                              {each && (
                                <span className="mt-1 block space-y-0.5">
                                  {each.map((ok, n) => (
                                    <span key={n} className="flex gap-1.5 text-xs">
                                      <span className={ok ? "text-[color:var(--eval-good-ink)]" : "text-[color:var(--eval-bad-ink)]"}>{ok ? "✓" : "✕"}</span>
                                      <span className="text-ink-secondary">
                                        {items[n] ?? `Item ${n + 1}`}
                                        {itemLabels?.[n] && <span className="text-ink-tertiary font-mono"> → {itemLabels[n]}</span>}
                                      </span>
                                    </span>
                                  ))}
                                </span>
                              )}
                              {c && c.kind !== "counted" && <Sureness verdict={v} scale={c.scale} accept={c.accept} />}
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
