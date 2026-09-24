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
            <Steps
              read={read}
              failures={failures.length}
              fine={fine.length}
              toReview={data.suggested.length}
              target={data.readTarget}
              available={data.threadsAvailable}
              minToCluster={data.minToCluster}
              modes={data.modes.length}
              decided={data.modes.filter((m) => m.decision).length}
              ungrouped={ungrouped.length}
              grouping={grouping}
              onRead={() => void startReading()}
              onGroup={() => void group()}
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
              <section id="failure-modes" className="scroll-mt-4 space-y-3">
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

/**
 * The page is a sequence, so it says so: read threads and say what went
 * wrong, group what was said into patterns, then decide what each pattern
 * deserves. Each step shows where it stands and holds its own button; the
 * next one to do is marked.
 */
function Steps({
  read,
  failures,
  fine,
  toReview,
  target,
  available,
  minToCluster,
  modes,
  decided,
  ungrouped,
  grouping,
  onRead,
  onGroup,
}: {
  read: number
  failures: number
  fine: number
  toReview: number
  target: number
  available: number
  minToCluster: number
  modes: number
  decided: number
  ungrouped: number
  grouping: boolean
  onRead: () => void
  onGroup: () => void
}) {
  const canGroup = failures >= minToCluster
  const next =
    toReview > 0 || !canGroup ? 1 : !modes || ungrouped > 0 ? 2 : decided < modes ? 3 : 1
  const unread = Math.max(0, available - read)
  const steps = [
    {
      title: "Read threads",
      status: (
        <>
          <b className="font-semibold text-ink-primary tabular-nums">{read}</b>{" "}
          read · {failures} went wrong · {fine} fine
        </>
      ),
      detail:
        toReview > 0
          ? `${toReview} read by the evals agent, waiting for you below.`
          : read < target
            ? `New kinds of failure keep turning up until about ${target} threads. ${unread} unread.`
            : `Past the point where new kinds of failure usually stop appearing. ${unread} unread.`,
      action: (
        <div className="flex flex-wrap gap-2">
          {toReview > 0 && (
            <StepButton
              primary={next === 1}
              onClick={() => document.getElementById("to-review")?.scrollIntoView({ behavior: "smooth", block: "start" })}
            >
              Review {toReview}
            </StepButton>
          )}
          <StepButton primary={next === 1 && !toReview} onClick={onRead}>
            <BookOpen className="size-4" /> Read threads
          </StepButton>
        </div>
      ),
    },
    {
      title: "Find patterns",
      status: modes ? (
        <>
          <b className="font-semibold text-ink-primary tabular-nums">{modes}</b>{" "}
          failure mode{modes === 1 ? "" : "s"}
        </>
      ) : (
        "None yet"
      ),
      detail: !canGroup
        ? `Needs ${minToCluster} notes on what went wrong; you have ${failures}.`
        : ungrouped
          ? `${ungrouped} note${ungrouped === 1 ? " is" : "s are"} not in a pattern yet.`
          : "Every note is in a pattern.",
      action: (
        <StepButton primary={next === 2} onClick={onGroup} disabled={grouping || !canGroup}>
          {grouping ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}{" "}
          {modes ? "Group again" : "Find patterns"}
        </StepButton>
      ),
    },
    {
      title: "Decide what to do",
      status: modes ? (
        <>
          <b className="font-semibold text-ink-primary tabular-nums">{decided}</b> of{" "}
          {modes} decided
        </>
      ) : (
        "After patterns"
      ),
      detail: "Fix the agent, measure it with a check, or leave it.",
      action: modes ? (
        <StepButton
          primary={next === 3}
          onClick={() =>
            document.getElementById("failure-modes")?.scrollIntoView({ behavior: "smooth", block: "start" })
          }
        >
          Go to patterns
        </StepButton>
      ) : null,
    },
  ]
  return (
    <ol className="grid gap-px overflow-hidden rounded-lg border border-primary-border bg-primary-border md:grid-cols-3">
      {steps.map((st, i) => (
        <li
          key={st.title}
          aria-current={next === i + 1 ? "step" : undefined}
          className="flex flex-col gap-2 bg-primary-bg px-4 py-3"
        >
          <div className="flex items-baseline gap-2">
            <span
              className={cn(
                "grid size-5 shrink-0 place-items-center rounded-full text-xs font-medium tabular-nums",
                next === i + 1 ? "bg-ink-primary text-primary-bg" : "bg-primary-bg-hover text-ink-secondary"
              )}
            >
              {i + 1}
            </span>
            <span className="text-sm font-medium text-ink-primary">{st.title}</span>
            {next === i + 1 && <span className="text-xs text-ink-tertiary">Next</span>}
          </div>
          <div className="text-sm text-ink-secondary">{st.status}</div>
          <p className="flex-1 text-xs text-ink-tertiary">{st.detail}</p>
          {st.action && <div>{st.action}</div>}
        </li>
      ))}
    </ol>
  )
}

function StepButton({
  primary,
  disabled,
  onClick,
  children,
}: {
  primary: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm disabled:opacity-50",
        primary
          ? "bg-ink-primary font-medium text-primary-bg"
          : "text-ink-primary smooth-shadow-ring-xs smooth-ring-primary-border hover:bg-primary-bg-hover"
      )}
    >
      {children}
    </button>
  )
}

type Suggested = Failures["suggested"][number]
type Filter = "wrong" | "fine" | "all"

/** "Went wrong" or "Looks fine" — a chip, so the verdict reads before the words. */
function Verdict({ ok }: { ok: boolean }) {
  return (
    <span className="inline-flex w-[6.25rem] shrink-0 items-center gap-1.5 rounded-full bg-primary-bg-hover px-2 py-0.5 text-xs font-medium text-ink-secondary">
      <span
        aria-hidden
        className="size-2 rounded-full"
        style={{ background: ok ? "var(--eval-good)" : "var(--eval-bad)" }}
      />
      {ok ? "Looks fine" : "Went wrong"}
    </span>
  )
}

const day = (at: number | null) =>
  at ? new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : null

/**
 * What the evals agent read and would note, waiting for a person. One line
 * each — the verdict, the question, the gist — and the rest on click. Accepting
 * makes it your note on that thread (the only thing it changes); rejecting
 * drops it, and the agent will not suggest it again. Several at once by
 * ticking them, since the agent often says "accept these five".
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
  const [filter, setFilter] = useState<Filter>("all")
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const wrong = items.filter((s) => !s.ok)
  const fine = items.filter((s) => s.ok)
  const shown = (filter === "wrong" ? wrong : filter === "fine" ? fine : items)
    .slice()
    // In question order, as the question set lists them.
    .sort((a, b) => Number(a.inputId) - Number(b.inputId) || a.inputId.localeCompare(b.inputId))
  const byQuestion = new Map<string, Suggested[]>()
  for (const s of shown) {
    const key = `${s.inputId}|${s.prompt}`
    byQuestion.set(key, [...(byQuestion.get(key) ?? []), s])
  }
  const groups = [...byQuestion].map(([key, answers]) => ({
    key,
    inputId: answers[0].inputId,
    prompt: answers[0].prompt,
    items: answers.sort((a, b) => Number(a.ok) - Number(b.ok) || (b.ranAt ?? 0) - (a.ranAt ?? 0)),
  }))
  const chosen = shown.filter((s) => picked.has(s.threadId))
  const allOn = shown.length > 0 && chosen.length === shown.length

  const resolve = async (threadIds: string[], accept: boolean) => {
    setBusy(true)
    // One at a time: each is its own note, and a failure should not take the rest with it.
    for (const threadId of threadIds) await resolveSuggestionFn({ data: { agent, threadId, accept } })
    setBusy(false)
    setPicked(new Set())
    onResolved()
  }
  const toggle = (id: string) => {
    const next = new Set(picked)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setPicked(next)
  }

  return (
    <section id="to-review" className="scroll-mt-4 space-y-3">
      <div className="space-y-1">
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="text-sm font-semibold text-ink-primary">Is the evals agent right?</h2>
          <span className="text-xs text-ink-tertiary tabular-nums">{items.length} to check</span>
          <button
            type="button"
            onClick={onReviewAll}
            className="ml-auto text-sm text-ink-secondary underline-offset-2 hover:text-ink-primary hover:underline"
          >
            Review one by one
          </button>
        </div>
        <p className="max-w-3xl text-sm text-ink-secondary">
          {agent} answered these test questions in your eval runs. The evals agent read the
          conversations and wrote down what it thinks went wrong in each. Check that it read them
          right. <b className="font-medium text-ink-primary">Agree</b> saves its sentence as your note
          on that conversation; <b className="font-medium text-ink-primary">Disagree</b> throws it
          away. Only notes are used to find patterns, so a misreading never decides what gets fixed.
          Nothing else changes — not the agent, its checks or its scores.
        </p>
      </div>

      <div className="rounded-lg border border-primary-border bg-primary-bg">
        <div className="flex flex-wrap items-center gap-3 border-b border-primary-border px-3 py-2">
          <input
            type="checkbox"
            aria-label="Select all shown"
            checked={allOn}
            onChange={() => setPicked(allOn ? new Set() : new Set(shown.map((s) => s.threadId)))}
          />
          <div role="radiogroup" aria-label="Show" className="inline-flex rounded-lg p-0.5 text-xs smooth-shadow-ring-xs smooth-ring-primary-border">
            {(
              [
                ["all", `All ${items.length}`],
                ["wrong", `Went wrong ${wrong.length}`],
                ["fine", `Looks fine ${fine.length}`],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={filter === value}
                onClick={() => (setFilter(value), setPicked(new Set()))}
                className={cn(
                  "rounded-md px-2.5 py-1 tabular-nums",
                  filter === value ? "bg-primary-bg-active font-medium text-ink-primary" : "text-ink-secondary hover:text-ink-primary"
                )}
              >
                {label}
              </button>
            ))}
          </div>
          {chosen.length > 0 && (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-ink-secondary tabular-nums">{chosen.length} selected</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void resolve(chosen.map((s) => s.threadId), true)}
                className="rounded-md bg-ink-primary px-2.5 py-1 font-medium text-primary-bg disabled:opacity-50"
              >
                {busy ? "Saving…" : "Agree"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void resolve(chosen.map((s) => s.threadId), false)}
                className="rounded-md px-2.5 py-1 text-ink-secondary smooth-shadow-ring-xs smooth-ring-primary-border hover:text-ink-primary disabled:opacity-50"
              >
                Disagree
              </button>
            </div>
          )}
        </div>

        {/* Grouped by question: a row is one answer to it — by one version, in one run. */}
        <ul>
          {groups.map((g) => {
            const ids = g.items.map((s) => s.threadId)
            const groupOn = ids.every((id) => picked.has(id))
            const wrongHere = g.items.filter((s) => !s.ok).length
            return (
              <li key={g.key} className="border-b border-primary-border last:border-b-0">
                <div className="flex items-start gap-3 bg-primary-bg-hover/40 px-3 py-2.5">
                  <input
                    type="checkbox"
                    className="mt-1"
                    aria-label={`Select every answer to question ${g.inputId}`}
                    checked={groupOn}
                    onChange={() => {
                      const next = new Set(picked)
                      for (const id of ids) {
                        if (groupOn) next.delete(id)
                        else next.add(id)
                      }
                      setPicked(next)
                    }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-ink-tertiary">Question {g.inputId}</div>
                    <div className="text-sm font-medium text-ink-primary">{g.prompt || "—"}</div>
                  </div>
                  <span className="shrink-0 pt-0.5 text-xs text-ink-tertiary tabular-nums">
                    {g.items.length} answer{g.items.length === 1 ? "" : "s"} read
                    {wrongHere > 0 && wrongHere < g.items.length && ` · ${wrongHere} went wrong`}
                  </span>
                </div>
                <ul className="divide-y divide-primary-border">
                  {g.items.map((s) => {
                    const isOpen = expanded === s.threadId
                    return (
                      <li key={s.threadId}>
                        <div className="flex items-center gap-3 px-3 py-2 text-sm">
                          <input
                            type="checkbox"
                            aria-label={`Select the ${s.version} answer to question ${s.inputId}`}
                            checked={picked.has(s.threadId)}
                            onChange={() => toggle(s.threadId)}
                          />
                          <button
                            type="button"
                            aria-expanded={isOpen}
                            onClick={() => setExpanded(isOpen ? null : s.threadId)}
                            className="flex min-w-0 flex-1 items-center gap-3 text-left"
                          >
                            <span className="w-28 shrink-0 text-xs text-ink-secondary" title="Which version answered, and when it ran">
                              <span className="font-medium text-ink-primary">{s.version}</span>
                              {day(s.ranAt) && <span className="text-ink-tertiary"> · {day(s.ranAt)}</span>}
                            </span>
                            <Verdict ok={s.ok} />
                            <span className={cn("min-w-0 flex-1 text-ink-primary", !isOpen && "truncate")}>
                              {s.ok ? s.text || "Nothing went wrong." : s.text}
                            </span>
                            {isOpen ? (
                              <ChevronUp className="size-4 shrink-0 text-ink-tertiary" />
                            ) : (
                              <ChevronDown className="size-4 shrink-0 text-ink-tertiary" />
                            )}
                          </button>
                        </div>
                        {isOpen && (
                          <div className="space-y-3 pr-4 pb-3 pl-[10.5rem] text-sm">
                            {s.why && (
                              <p className="text-ink-secondary">
                                <span className="text-xs text-ink-tertiary">Why: </span>
                                {s.why}
                              </p>
                            )}
                            <div className="flex flex-wrap items-center gap-2 text-xs">
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void resolve([s.threadId], true)}
                                className="rounded-md bg-ink-primary px-2.5 py-1 font-medium text-primary-bg disabled:opacity-50"
                              >
                                Agree
                              </button>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void resolve([s.threadId], false)}
                                className="rounded-md px-2.5 py-1 text-ink-secondary smooth-shadow-ring-xs smooth-ring-primary-border hover:text-ink-primary disabled:opacity-50"
                              >
                                Disagree
                              </button>
                              <button
                                type="button"
                                onClick={() => onOpen(s.threadId)}
                                className="px-1.5 py-1 text-ink-secondary underline-offset-2 hover:text-ink-primary hover:underline"
                              >
                                Read the conversation
                              </button>
                            </div>
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </li>
            )
          })}
        </ul>
      </div>
    </section>
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
