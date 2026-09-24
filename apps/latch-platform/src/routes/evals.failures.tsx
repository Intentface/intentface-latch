import { GROUND } from "@/components/evals/ui"
import { useCallback, useEffect, useRef, useState } from "react"
import { createFileRoute, Link, redirect } from "@tanstack/react-router"
import {
  BookOpen,
  ChevronDown,
  ChevronUp,
  Loader2,
  Sparkles,
} from "lucide-react"
import { currentPrincipalFn } from "@/lib/server"
import { getEvalsIndexFn } from "@/lib/evals-server"
import {
  createCheckFromModeFn,
  decideModeFn,
  findPatternsFn,
  getFailuresFn,
  getReadingQueueFn,
  proposeCheckFn,
  resolveSuggestionFn,
} from "@/lib/failures-server"
import type { Failures } from "@/lib/failures-server"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import Drawer from "@/components/ui/drawer"
import {
  EDITOR_DRAWER,
  EvalsEmpty,
  EvalsShell,
  Field,
  validateEvalsSearch,
} from "@/components/evals/shell"
import { useEvalsChanged } from "@/components/evals/events"
import { Key, NoteBox, ThreadView } from "@/components/evals/thread-view"

/**
 * Error discovery, before measurement: read threads, write down the first
 * thing that went wrong, group the notes into failure modes, and turn the
 * ones that matter into checks. The checks a person imagines up front miss
 * the failures that need product judgment — a leasing assistant that never
 * offers the cheaper flat looks like a success to anyone who does not know
 * the budget mattered.
 */
export const Route = createFileRoute("/evals/failures")({
  head: () => ({ meta: [{ title: "Failures · Evals · Latch" }] }),
  validateSearch: validateEvalsSearch,
  beforeLoad: async () => {
    const principal = await currentPrincipalFn()
    if (!principal) throw redirect({ to: "/login" })
  },
  loader: () => getEvalsIndexFn(),
  component: FailuresPage,
})

type Reading = {
  threadId: string
  version: string
  inputId: string
  attempt: number
}[]
type Note = Failures["notes"][number]

function FailuresPage() {
  const index = Route.useLoaderData()
  const search = Route.useSearch()
  const agent = search.agent ?? index[0]?.agent
  const [data, setData] = useState<Failures | null>(null)
  const [reading, setReading] = useState<Reading | null>(null)
  const [grouping, setGrouping] = useState(false)
  const [message, setMessage] = useState<{
    text: string
    bad?: boolean
  } | null>(null)
  const [toCheck, setToCheck] = useState<Failures["modes"][number] | null>(null)

  const load = useCallback(() => {
    if (agent) void getFailuresFn({ data: agent }).then(setData)
  }, [agent])
  useEffect(() => {
    setData(null)
    load()
  }, [load])
  // The Evals agent may have suggested notes, grouped them or triaged a mode.
  useEvalsChanged(load)

  const startReading = async () => {
    if (!agent) return
    const q = await getReadingQueueFn({ data: agent })
    if (!q.length)
      return setMessage({
        text: "Every eval thread of this agent has been read. Run more questions to read more.",
      })
    setReading(q)
  }
  const reread = (n: Note) =>
    setReading([
      {
        threadId: n.threadId,
        version: n.version,
        inputId: n.inputId,
        attempt: 0,
      },
    ])

  const group = async () => {
    if (!agent) return
    setGrouping(true)
    setMessage(null)
    const r = await findPatternsFn({ data: agent }).catch((e: unknown) => ({
      ok: false as const,
      error: e instanceof Error ? e.message : String(e),
    }))
    setGrouping(false)
    if (!r.ok) return setMessage({ text: r.error, bad: true })
    setMessage({
      text: `Found ${r.modes} failure mode${r.modes === 1 ? "" : "s"} in ${r.grouped} of ${r.of} notes.`,
    })
    load()
  }

  if (!index.length) return <EvalsEmpty />

  const failures = data?.notes.filter((n) => !n.ok) ?? []
  const fine = data?.notes.filter((n) => n.ok) ?? []
  const read = data?.notes.length ?? 0
  const ungrouped = failures.filter(
    (n) => !n.modeId || !data?.modes.some((m) => m.id === n.modeId)
  )

  return (
    <div className={GROUND}>
      <div className="evals-page mx-auto max-w-[1100px] space-y-6 p-6 transition-[margin]">
        <EvalsShell
          page="failures"
          index={index}
          search={search}
          actions={
            data && (
              <>
                <button
                  type="button"
                  onClick={() => void group()}
                  disabled={grouping || failures.length < data.minToCluster}
                  title={
                    failures.length < data.minToCluster
                      ? `Write at least ${data.minToCluster} notes first`
                      : undefined
                  }
                  className="flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm text-ink-primary smooth-shadow-ring-xs smooth-ring-primary-border hover:bg-primary-bg-hover disabled:opacity-50"
                >
                  {grouping ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Sparkles className="size-4" />
                  )}{" "}
                  Find patterns
                </button>
                <button
                  type="button"
                  onClick={() => void startReading()}
                  className="flex h-8 items-center gap-1.5 rounded-lg bg-ink-primary px-3 text-sm font-medium text-primary-bg"
                >
                  <BookOpen className="size-4" /> Read threads
                </button>
              </>
            )
          }
        />

        {message && (
          <p
            className={cn(
              "text-sm",
              message.bad
                ? "text-red-600 dark:text-red-400"
                : "text-ink-secondary"
            )}
          >
            {message.text}
          </p>
        )}

        {data && (
          <>
            <Progress
              read={read}
              failures={failures.length}
              fine={fine.length}
              target={data.readTarget}
              available={data.threadsAvailable}
            />

            {data.suggested.length > 0 && (
              <SuggestionList
                agent={agent}
                items={data.suggested}
                onOpen={(threadId) => {
                  const s = data.suggested.find((x) => x.threadId === threadId)
                  if (s)
                    setReading([
                      s,
                      ...data.suggested.filter((x) => x.threadId !== threadId),
                    ])
                }}
                onReviewAll={() => setReading(data.suggested)}
                onResolved={load}
              />
            )}

            {data.modes.length > 0 && (
              <section className="space-y-3">
                <h2 className="text-sm font-semibold text-ink-primary">
                  Failure modes
                </h2>
                <ul className="space-y-2">
                  {data.modes
                    .map((m) => ({
                      m,
                      notes: failures.filter((n) => n.modeId === m.id),
                    }))
                    .sort((a, b) => b.notes.length - a.notes.length)
                    .map(({ m, notes }) => (
                      <ModeCard
                        key={m.id}
                        mode={m}
                        notes={notes}
                        of={failures.length}
                        onOpen={reread}
                        onCheck={() => setToCheck(m)}
                        onDecide={(decision) =>
                          agent &&
                          void decideModeFn({
                            data: { agent, id: m.id, decision },
                          }).then(load)
                        }
                      />
                    ))}
                </ul>
              </section>
            )}

            {ungrouped.length > 0 && (
              <section className="space-y-3">
                <div className="flex items-baseline gap-3">
                  <h2 className="text-sm font-semibold text-ink-primary">
                    {data.modes.length ? "Not in a pattern yet" : "Notes"}
                  </h2>
                  <span className="text-xs text-ink-tertiary">
                    {data.modes.length
                      ? "Find patterns again after more reading."
                      : `Find patterns once there are ${data.minToCluster} or more.`}
                  </span>
                </div>
                <NoteList notes={ungrouped} onOpen={reread} />
              </section>
            )}

            {!read && (
              <div className="max-w-2xl space-y-2 rounded-lg border border-primary-border bg-primary-bg p-5 text-sm">
                <p className="font-medium text-ink-primary">
                  Start by reading.
                </p>
                <p className="text-ink-secondary">
                  Open threads one at a time and write down the first thing that
                  went wrong, as the user would see it. Skip the cause; say what
                  happened. Mark the ones that look fine. After a few dozen,
                  patterns show — and those are the checks worth having.
                </p>
              </div>
            )}
          </>
        )}

        {agent && (
          <ReadDrawer
            agent={agent}
            queue={reading}
            onClose={() => {
              setReading(null)
              load()
            }}
          />
        )}
        {agent && (
          <CheckFromMode
            agent={agent}
            mode={toCheck}
            onClose={() => (setToCheck(null), load())}
          />
        )}
      </div>
    </div>
  )
}

type Suggested = Failures["suggested"][number]

/**
 * What the evals agent proposes, all in one place. Each counts for nothing
 * until accepted: "Use it" makes it your note, "Dismiss" rejects it (the agent
 * will not propose it again). Opening the thread is the way to check it — the
 * agent misses failures that take product judgment.
 */
function SuggestionList({
  agent,
  items,
  onOpen,
  onReviewAll,
  onResolved,
}: {
  agent: string
  items: Suggested[]
  onOpen: (threadId: string) => void
  onReviewAll: () => void
  onResolved: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const resolve = async (threadId: string, accept: boolean) => {
    setBusy(threadId)
    await resolveSuggestionFn({ data: { agent, threadId, accept } })
    setBusy(null)
    onResolved()
  }
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="text-sm font-semibold text-ink-primary">
          Suggested by the evals agent
        </h2>
        <span className="text-xs text-ink-tertiary">
          {items.length} waiting · they count once you accept them
        </span>
        <button
          type="button"
          onClick={onReviewAll}
          className="ml-auto text-sm font-medium text-ink-primary underline"
        >
          Review one by one
        </button>
      </div>
      <ul className="divide-y divide-primary-border rounded-lg border border-primary-border bg-primary-bg">
        {items.map((s) => (
          <li
            key={s.threadId}
            className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3 text-sm"
          >
            <div className="min-w-0 flex-1 space-y-1">
              <div className="text-xs text-ink-tertiary">
                #{s.inputId} on {s.version}
                {s.prompt && <span> · {s.prompt}</span>}
              </div>
              <div className="text-ink-primary">
                {s.ok ? "Looks fine." : s.text}
              </div>
              {s.why && (
                <div
                  className="line-clamp-2 text-xs text-ink-tertiary"
                  title={s.why}
                >
                  {s.why}
                </div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-3 pt-0.5 text-xs">
              <button
                type="button"
                onClick={() => onOpen(s.threadId)}
                className="text-ink-secondary hover:text-ink-primary"
              >
                Open thread
              </button>
              <button
                type="button"
                disabled={busy === s.threadId}
                onClick={() => void resolve(s.threadId, false)}
                className="text-ink-secondary hover:text-ink-primary disabled:opacity-50"
              >
                Dismiss
              </button>
              <button
                type="button"
                disabled={busy === s.threadId}
                onClick={() => void resolve(s.threadId, true)}
                className="rounded-md bg-ink-primary px-2.5 py-1 font-medium text-primary-bg disabled:opacity-50"
              >
                Use it
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Progress({
  read,
  failures,
  fine,
  target,
  available,
}: {
  read: number
  failures: number
  fine: number
  target: number
  available: number
}) {
  const pct = Math.min(100, Math.round((100 * read) / target))
  return (
    <div className="space-y-2 rounded-lg border border-primary-border bg-primary-bg px-4 py-3 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-ink-primary">
          <span className="text-[15px] font-semibold tabular-nums">{read}</span>{" "}
          of about {target} threads read
        </span>
        <span className="text-ink-tertiary tabular-nums">
          {failures} went wrong · {fine} looked fine ·{" "}
          {Math.max(0, available - read)} unread
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-primary-border">
        <div
          className="h-full rounded-full bg-ink-secondary"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-xs text-ink-tertiary">
        {read < target
          ? "New kinds of failure keep turning up until about a hundred threads. Before that, a pattern you have not seen yet is likely."
          : "Past the point where new kinds of failure usually stop appearing."}
      </p>
    </div>
  )
}

function ModeCard({
  mode,
  notes,
  of,
  onOpen,
  onCheck,
  onDecide,
}: {
  mode: Failures["modes"][number]
  notes: Note[]
  of: number
  onOpen: (n: Note) => void
  onCheck: () => void
  onDecide: (d: "fix" | "measure" | "leave") => void
}) {
  const [open, setOpen] = useState(false)
  const share = of ? Math.round((100 * notes.length) / of) : 0
  return (
    <li className="rounded-lg border border-primary-border bg-primary-bg">
      <div className="flex flex-wrap items-start gap-4 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-ink-primary">{mode.name}</div>
          <p className="mt-0.5 text-sm text-ink-secondary">
            {mode.description}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <div className="h-1 w-32 overflow-hidden rounded-full bg-primary-border">
              <div
                className="h-full bg-ink-secondary"
                style={{ width: `${share}%` }}
              />
            </div>
            <span className="text-xs text-ink-tertiary tabular-nums">
              {notes.length} thread{notes.length === 1 ? "" : "s"} · {share}% of
              failures
            </span>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <div
              role="radiogroup"
              aria-label="What to do about it"
              className="inline-flex rounded-lg p-0.5 smooth-shadow-ring-xs smooth-ring-primary-border"
            >
              {(
                [
                  [
                    "fix",
                    "Fix now",
                    "The cause is plain: change the agent and re-run the threads that failed.",
                  ],
                  [
                    "measure",
                    "Measure",
                    "Subjective, recurring or risky: make it a check.",
                  ],
                  [
                    "leave",
                    "Leave",
                    "Rare or harmless: not worth the effort now.",
                  ],
                ] as const
              ).map(([value, label, hint]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={mode.decision === value}
                  title={hint}
                  onClick={() => onDecide(value)}
                  className={cn(
                    "rounded-md px-2.5 py-1",
                    mode.decision === value
                      ? "bg-primary-bg-active font-medium text-ink-primary"
                      : "text-ink-secondary hover:text-ink-primary"
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            {mode.decision && mode.decidedBy === "agent" && (
              <span className="text-ink-tertiary">
                Suggested by the evals agent
                {mode.decisionWhy ? `: ${mode.decisionWhy}` : "."}
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="flex items-center gap-1 text-sm text-ink-secondary hover:text-ink-primary"
          >
            {open ? (
              <ChevronUp className="size-4" />
            ) : (
              <ChevronDown className="size-4" />
            )}{" "}
            Notes
          </button>
          {mode.decision !== "fix" && mode.decision !== "leave" && (
            <button
              type="button"
              onClick={onCheck}
              className="h-8 rounded-lg px-3 text-sm text-ink-primary smooth-shadow-ring-xs smooth-ring-primary-border hover:bg-primary-bg-hover"
            >
              Turn into a check
            </button>
          )}
        </div>
      </div>
      {open && (
        <div className="border-t border-primary-border px-2 py-2">
          <NoteList notes={notes} onOpen={onOpen} flat />
        </div>
      )}
    </li>
  )
}

function NoteList({
  notes,
  onOpen,
  flat,
}: {
  notes: Note[]
  onOpen: (n: Note) => void
  flat?: boolean
}) {
  return (
    <ul
      className={cn(
        !flat &&
          "divide-y divide-primary-border rounded-lg border border-primary-border bg-primary-bg"
      )}
    >
      {notes.map((n) => (
        <li key={n.threadId}>
          <button
            type="button"
            onClick={() => onOpen(n)}
            className="flex w-full items-baseline gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-primary-bg-hover"
          >
            <span className="w-24 shrink-0 text-xs text-ink-tertiary tabular-nums">
              #{n.inputId} · {n.version}
            </span>
            <span className="min-w-0 flex-1 text-ink-primary">{n.text}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

// ─── Reading ───────────────────────────────────────────────────────────────

function ReadDrawer({
  agent,
  queue,
  onClose,
}: {
  agent: string
  queue: Reading | null
  onClose: () => void
}) {
  const [at, setAt] = useState(0)
  const [noted, setNoted] = useState(0)
  const note = useRef<HTMLTextAreaElement>(null)
  const last = useRef(queue)
  if (queue) last.current = queue
  const shown = queue ?? last.current
  useEffect(() => {
    if (queue) (setAt(0), setNoted(0))
  }, [queue])
  const row = shown?.[Math.min(at, (shown.length || 1) - 1)]
  const next = () => setAt((i) => Math.min(i + 1, (shown?.length ?? 1) - 1))

  useEffect(() => {
    if (!queue) return
    const onKey = (e: KeyboardEvent) => {
      const inText = (e.target as HTMLElement).tagName === "TEXTAREA"
      // ⌘↵ in the note moves on; blur saves it on the way.
      if (inText && e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        note.current?.blur()
        next()
        return
      }
      if (inText || e.metaKey || e.ctrlKey || e.altKey) return
      const k = e.key.toLowerCase()
      if (k === "j" || e.key === "ArrowDown")
        setAt((i) => Math.min(i + 1, queue.length - 1))
      else if (k === "k" || e.key === "ArrowUp")
        setAt((i) => Math.max(i - 1, 0))
      else if (k === "n") note.current?.focus()
      else return
      e.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  return (
    <Drawer open={!!queue} onOpenChange={(o) => !o && onClose()}>
      <Drawer.Content className={EDITOR_DRAWER}>
        {shown && row && (
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex items-center gap-2 border-b border-primary-border px-4 py-3 text-sm">
              <Drawer.Title className="text-sm font-medium text-ink-primary">
                Reading threads
              </Drawer.Title>
              <span className="text-ink-tertiary tabular-nums">
                {at + 1} of {shown.length} · {noted} noted
              </span>
              <div className="ml-auto flex items-center gap-1">
                <button
                  type="button"
                  aria-label="Previous thread"
                  disabled={at === 0}
                  onClick={() => setAt(at - 1)}
                  className="rounded p-1 text-ink-secondary hover:text-ink-primary disabled:opacity-40"
                >
                  <ChevronUp className="size-4" />
                </button>
                <button
                  type="button"
                  aria-label="Next thread"
                  disabled={at >= shown.length - 1}
                  onClick={next}
                  className="rounded p-1 text-ink-secondary hover:text-ink-primary disabled:opacity-40"
                >
                  <ChevronDown className="size-4" />
                </button>
              </div>
            </div>
            <ThreadView
              key={row.threadId}
              agent={agent}
              threadId={row.threadId}
              caption={`Question #${row.inputId} on ${row.version}`}
            >
              <NoteBox
                agent={agent}
                threadId={row.threadId}
                textareaRef={note}
                onSaved={() => setNoted((n) => n + 1)}
              />
            </ThreadView>
            <div className="flex items-center gap-2 border-t border-primary-border px-4 py-3">
              <p className="text-xs text-ink-tertiary">
                <Key>N</Key> to write · <Key>⌘</Key>
                <Key>↵</Key> save and next · <Key>J</Key> <Key>K</Key> to move
              </p>
              <button
                type="button"
                onClick={next}
                disabled={at >= shown.length - 1}
                className="ml-auto rounded-md bg-ink-primary px-3 py-1.5 text-sm font-medium text-primary-bg disabled:opacity-50"
              >
                Next thread
              </button>
            </div>
          </div>
        )}
      </Drawer.Content>
    </Drawer>
  )
}

// ─── From failure mode to check ────────────────────────────────────────────

function CheckFromMode({
  agent,
  mode,
  onClose,
}: {
  agent: string
  mode: Failures["modes"][number] | null
  onClose: () => void
}) {
  const [draft, setDraft] = useState<{ label: string; ask: string } | null>(
    null
  )
  const [rubrics, setRubrics] = useState<{ id: string; version: number }[]>([])
  const [rubricId, setRubricId] = useState("")
  const [examples, setExamples] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState<{
    version: number
    failed: number
    passed: number
  } | null>(null)
  const last = useRef(mode)
  if (mode) last.current = mode
  const shown = mode ?? last.current

  useEffect(() => {
    if (!mode) return
    setDraft(null)
    setError(null)
    setDone(null)
    void proposeCheckFn({ data: { agent, modeId: mode.id } })
      .then((r) => {
        if (!r.ok) return setError(r.error)
        setDraft(r.draft)
        setRubrics(r.rubrics)
        setRubricId(r.rubrics[0]?.id ?? "")
        setExamples(r.examples)
      })
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : String(e))
      )
  }, [agent, mode])

  const save = async () => {
    if (!mode || !draft || !rubricId) return
    setSaving(true)
    setError(null)
    const r = await createCheckFromModeFn({
      data: { agent, modeId: mode.id, rubricId, ...draft },
    })
    setSaving(false)
    if (!r.ok) return setError(r.error)
    setDone(r)
  }

  const target = rubrics.find((r) => r.id === rubricId)

  return (
    <Drawer open={!!mode} onOpenChange={(o) => !o && onClose()}>
      <Drawer.Content className={EDITOR_DRAWER}>
        {shown && (
          <div className="flex h-full flex-col">
            <Drawer.Header className="border-b border-primary-border px-5">
              <Drawer.Title className="text-ink-primary">
                Turn into a check
              </Drawer.Title>
              <Drawer.Description className="text-xs text-ink-tertiary">
                {shown.name}. The threads you noted with this failure become the
                check's first fails, and threads you marked fine its first
                passes — so it starts with evidence about its judge.
              </Drawer.Description>
            </Drawer.Header>
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
              {done ? (
                <div className="space-y-2 text-sm">
                  <p className="font-medium text-ink-primary">
                    Added to {rubricId} as version {done.version}.
                  </p>
                  <p className="text-ink-secondary">
                    It starts with {done.failed} fail
                    {done.failed === 1 ? "" : "s"} and {done.passed} pass
                    {done.passed === 1 ? "" : "es"} from your notes. Nothing has
                    judged it yet: open a run on Results and judge it with v
                    {done.version} to see whether the judge agrees with you.
                  </p>
                  <Link
                    to="/evals"
                    search={{ agent }}
                    className="inline-block font-medium text-ink-primary underline"
                  >
                    Go to Results
                  </Link>
                </div>
              ) : !draft ? (
                error ? (
                  <p className="text-sm text-red-600 dark:text-red-400">
                    {error}
                  </p>
                ) : (
                  <p className="flex items-center gap-2 text-sm text-ink-tertiary">
                    <Loader2 className="size-4 animate-spin" /> Drafting a check
                    from {shown.name.toLowerCase()}…
                  </p>
                )
              ) : (
                <>
                  <Field
                    id="fm-label"
                    label="Name"
                    hint="What passing means, as the results grid will show it."
                  >
                    <Input
                      id="fm-label"
                      value={draft.label}
                      onChange={(e) =>
                        setDraft({ ...draft, label: e.target.value })
                      }
                    />
                  </Field>
                  <Field
                    id="fm-ask"
                    label="Question for the judge"
                    hint={`Drafted from ${examples} note${examples === 1 ? "" : "s"}. Yes means the agent did well.`}
                  >
                    <Textarea
                      id="fm-ask"
                      value={draft.ask}
                      onChange={(e) =>
                        setDraft({ ...draft, ask: e.target.value })
                      }
                      rows={4}
                    />
                  </Field>
                  <Field id="fm-rubric" label="Add to">
                    <Select
                      id="fm-rubric"
                      value={rubricId}
                      onChange={(e) => setRubricId(e.target.value)}
                    >
                      {rubrics.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.id} (now v{r.version})
                        </option>
                      ))}
                    </Select>
                  </Field>
                </>
              )}
            </div>
            <div className="flex items-center gap-2 border-t border-primary-border px-5 py-3">
              {error && draft && (
                <span className="min-w-0 flex-1 text-sm text-red-600 dark:text-red-400">
                  {error}
                </span>
              )}
              <div className="ml-auto flex gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-3 py-1.5 text-sm text-ink-secondary hover:text-ink-primary"
                >
                  {done ? "Close" : "Cancel"}
                </button>
                {!done && (
                  <button
                    type="button"
                    disabled={!draft || !rubricId || saving}
                    onClick={() => void save()}
                    className="rounded-md bg-ink-primary px-3 py-1.5 text-sm font-medium text-primary-bg disabled:opacity-50"
                  >
                    {saving
                      ? "Adding…"
                      : target
                        ? `Add as v${target.version + 1}`
                        : "Add"}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </Drawer.Content>
    </Drawer>
  )
}
