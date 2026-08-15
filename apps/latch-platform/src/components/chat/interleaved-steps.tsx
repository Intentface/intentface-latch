/**
 * The turn timeline: reasoning and tool calls as one collapsible, chronological
 * disclosure, composed over the `Steps` primitive.
 *
 * The header narrates what's happening now while the turn runs, then settles
 * into a "Thought for Xs, used N tools" summary. Rows that carry detail (a
 * tool's arguments, a delegated subagent conversation, an eval run) expand in
 * place; an active row opens itself, so live detail is visible without a click.
 */

import { CircleIcon } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import {
  Children,
  
  
  useEffect,
  useRef,
  useState
} from "react"
import type {ComponentType, ReactNode} from "react";
import { Steps } from "@/components/ai/steps"
import { BrainIcon } from "@/components/icons/brain"
import { CheckMarkMediumIcon } from "@/components/icons/check-mark-medium"
import { ChevronDownIcon } from "@/components/icons/chevron-down"
import { CircleQuestionmarkIcon } from "@/components/icons/circle-questionmark"
import { ExclamationTriangleIcon } from "@/components/icons/exclamation-triangle"
import { Markdown } from "@/components/ui/markdown"
import { TextShimmer } from "@/components/ui/text-shimmer"
import { useThrottledText } from "@/hooks/use-throttled-text"
import { splitReasoningByHeaders } from "@/lib/ai/message-info"
import type { MessageSegment } from "@/lib/ai/segments"
import { getAskUserStepInfo, getToolCallInfo } from "@/lib/ai/steps-info"
import { DEFAULT_TOOL_LABELS } from "@/lib/ai/tool-labels"
import {
  isAwaitingApproval,
  
  
  toolNameOf
} from "@/lib/ai/types"
import type {StepStatus, ToolPart} from "@/lib/ai/types";
import { cn } from "@/lib/utils"

type IconComponent = ComponentType<{ className?: string }>

const statusIcons: Record<StepStatus, IconComponent> = {
  complete: CheckMarkMediumIcon,
  active: CircleIcon,
  pending: CircleIcon,
  error: ExclamationTriangleIcon,
}

/**
 * A timeline row: static when it has no detail, collapsible (the status icon
 * morphs into a chevron) when it does.
 */
const TimelineStep = ({
  label,
  status = "complete",
  icon,
  defaultOpen,
  children,
}: {
  label: string
  status?: StepStatus
  icon?: IconComponent
  defaultOpen?: boolean
  children?: ReactNode
}) => {
  const Icon = icon ?? statusIcons[status]
  const hasDetail = Children.toArray(children).length > 0

  const iconClasses = cn(
    status === "complete" && "text-ink-secondary",
    status === "active" && "text-ink-primary",
    status === "pending" && "text-ink-tertiary",
    status === "error" && "text-destructive"
  )
  const labelClasses = cn(
    "text-left text-sm",
    status === "active" && "font-medium text-ink-primary",
    status === "complete" && "text-ink-secondary",
    status === "pending" && "text-ink-tertiary",
    status === "error" && "text-destructive"
  )

  if (!hasDetail) {
    return (
      <Steps.Item status={status}>
        <div className="flex items-center gap-2 py-0.5">
          <span
            className={cn(
              "flex size-4 shrink-0 items-center justify-center",
              iconClasses
            )}
          >
            <Icon
              className={cn("size-3.5", status === "active" && "animate-pulse")}
            />
          </span>
          <span className={labelClasses}>{label}</span>
        </div>
      </Steps.Item>
    )
  }

  return (
    <Steps.Item status={status} defaultOpen={defaultOpen}>
      <Steps.Trigger>
        <span
          className={cn(
            "relative flex size-4 shrink-0 items-center justify-center",
            iconClasses
          )}
        >
          <span className="transition-opacity group-hover/steps-trigger:opacity-0 group-data-open/steps-trigger:opacity-0">
            <Icon
              className={cn("size-3.5", status === "active" && "animate-pulse")}
            />
          </span>
          <ChevronDownIcon className="absolute size-4 opacity-0 transition-all group-hover/steps-trigger:opacity-100 group-data-open/steps-trigger:rotate-180 group-data-open/steps-trigger:opacity-100" />
        </span>
        <span className={labelClasses}>{label}</span>
      </Steps.Trigger>
      <Steps.Panel>{children}</Steps.Panel>
    </Steps.Item>
  )
}

/** A tool call's row: label + status, with its arguments/result as the detail. */
const TimelineToolCall = ({
  part,
  detail,
}: {
  part: ToolPart
  detail?: ReactNode
}) => {
  const { label, status, summary, errorText, sources, input } = getToolCallInfo(
    part,
    DEFAULT_TOOL_LABELS
  )
  const hasArgs = Object.keys(input).length > 0

  return (
    <TimelineStep
      label={label}
      status={status}
      defaultOpen={status === "active" && !!detail}
    >
      {errorText && (
        <span className="text-xs text-destructive">{errorText}</span>
      )}
      {summary && <span className="text-xs text-ink-secondary">{summary}</span>}
      {detail}
      {!detail && hasArgs && (
        <pre className="overflow-x-auto text-xs text-ink-tertiary">
          {JSON.stringify(input, null, 2)}
        </pre>
      )}
      {sources.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {sources.map((source, index) => (
            <span
              key={index}
              className="inline-flex items-center rounded-md border border-primary-border bg-primary-bg px-2 py-0.5 text-xs text-ink-secondary"
            >
              {source.domain}
            </span>
          ))}
        </div>
      )}
    </TimelineStep>
  )
}

/** An ask-user exchange's row: the questions, plus the answers once they land. */
const TimelineAskUser = ({ part }: { part: ToolPart }) => {
  const { label, status, questions, answers, isComplete } =
    getAskUserStepInfo(part)

  return (
    <TimelineStep label={label} status={status} icon={CircleQuestionmarkIcon}>
      <div className="flex flex-col gap-1.5">
        {questions.map((q) => (
          <div key={q.question} className="flex flex-col gap-0.5">
            <span className="text-xs leading-tight font-medium text-ink-primary">
              {q.question}
            </span>
            {isComplete && (
              <span className="text-xs leading-tight text-ink-secondary">
                {answers[q.question] ?? "—"}
              </span>
            )}
          </div>
        ))}
      </div>
    </TimelineStep>
  )
}

export type InterleavedStepsProps = {
  segments: MessageSegment[]
  isStreaming: boolean
  /**
   * The turn is paused on the user (an open ask-user prompt, an undecided
   * approval), not finished — keep the block active rather than showing the
   * "done" summary.
   */
  awaitingInput?: boolean
  /**
   * Detail for a specific tool row — a delegated subagent conversation, a live
   * eval run. Return undefined to keep the default (the call's arguments).
   */
  renderDetail?: (part: ToolPart) => ReactNode | undefined
}

export const InterleavedSteps = ({
  segments,
  isStreaming,
  awaitingInput = false,
  renderDetail,
}: InterleavedStepsProps) => {
  const isActive = isStreaming || awaitingInput
  const { toolCount, questionCount } = segments.reduce(
    (acc, s) => {
      if (s.type !== "tool") return acc
      for (const p of s.parts) {
        if (p.type === "tool-askUser") {
          const input = p.input as { questions?: unknown[] } | undefined
          acc.questionCount += input?.questions?.length ?? 0
        } else {
          acc.toolCount++
        }
      }
      return acc
    },
    { toolCount: 0, questionCount: 0 }
  )

  // Track how long the turn ran, the way Reasoning does.
  const [duration, setDuration] = useState<number | undefined>(undefined)
  const startTimeRef = useRef<number | null>(null)

  useEffect(() => {
    if (isStreaming) {
      if (startTimeRef.current === null) {
        startTimeRef.current = Date.now()
      }
    } else if (startTimeRef.current !== null) {
      setDuration(Math.ceil((Date.now() - startTimeRef.current) / 1000))
      startTimeRef.current = null
    }
  }, [isStreaming])

  const suffixes: string[] = []
  if (toolCount > 0)
    suffixes.push(`used ${toolCount} tool${toolCount !== 1 ? "s" : ""}`)
  if (questionCount > 0)
    suffixes.push(
      `asked ${questionCount} question${questionCount !== 1 ? "s" : ""}`
    )
  const suffix = suffixes.length > 0 ? `, ${suffixes.join(", ")}` : ""

  // While the turn runs the header cycles to the running tool's label — falling
  // back to the last tool between rounds so it never drops to "Thinking" once
  // tools start — throttled so fast tools don't flicker. It narrates what's
  // happening *now*, so even the between-rounds fallback keeps the present
  // tense ("Searching the web"), never the row's past-tense label.
  const toolParts = segments.flatMap((s) => (s.type === "tool" ? s.parts : []))
  const runningTool = toolParts.find(
    (p) => p.state === "input-streaming" || p.state === "input-available"
  )
  const gatedTool = toolParts.find((p) => isAwaitingApproval(p))
  const activeTool = gatedTool ?? runningTool ?? toolParts.at(-1)
  const askingCount =
    activeTool?.type === "tool-askUser"
      ? (
          (activeTool.input as { questions?: unknown[] } | undefined)
            ?.questions ?? []
        ).length
      : 0
  const activeToolName = activeTool ? toolNameOf(activeTool) : ""
  const activeToolConfig = DEFAULT_TOOL_LABELS[activeToolName]
  const streamingLabel = !activeTool
    ? "Thinking..."
    : gatedTool
      ? `Waiting for your approval`
      : activeTool.type === "tool-askUser"
        ? `Asking ${askingCount === 1 ? "question" : "questions"}`
        : (activeToolConfig?.active(
            (activeTool.input as Record<string, unknown>) ?? {}
          ) ?? `Running ${activeToolName}`)
  // Hold each label past the roll animation (300ms) so a fast tool sequence
  // reads as a calm loop instead of overlapping mid-roll swaps.
  const shownLabel = useThrottledText(streamingLabel, 800)

  // Open while active, auto-collapse when done — but a user toggle wins from then on.
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const open = userOpen ?? isActive

  const doneLabel = `Thought for ${
    duration === undefined
      ? "a few seconds"
      : `${duration} ${duration === 1 ? "second" : "seconds"}`
  }${suffix}`
  const displayLabel = isActive ? shownLabel : doneLabel

  // One rolling label for both states — the box never changes when the stream
  // ends, so there's no layout shift: the last active label rolls out and the
  // summary rolls in (shimmer only while active).
  const header = (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span
        key={displayLabel}
        initial={{ opacity: 0, y: "100%", filter: "blur(4px)" }}
        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
        exit={{ opacity: 0, y: "-100%", filter: "blur(4px)" }}
        transition={{ duration: 0.3, ease: "easeOut" }}
        className="block"
      >
        {isActive ? <TextShimmer>{displayLabel}</TextShimmer> : displayLabel}
      </motion.span>
    </AnimatePresence>
  )

  // Text-only turn (no reasoning, no tools) — keep the status header, but there
  // is nothing to expand, so render it as a static line.
  if (segments.length === 0) {
    return (
      <div className="flex w-full items-center py-1 text-sm text-ink-secondary">
        <span className="overflow-hidden text-left">{header}</span>
      </div>
    )
  }

  return (
    <Steps>
      <Steps.Item open={open} onOpenChange={setUserOpen}>
        <Steps.Trigger>
          <span className="overflow-hidden text-left">{header}</span>
          <ChevronDownIcon className="size-4 shrink-0 transition-transform group-data-open/steps-trigger:rotate-180" />
        </Steps.Trigger>
        <Steps.Panel>
          {segments.map((seg, i) => {
            if (seg.type === "reasoning") {
              const text = seg.parts.map((p) => p.text).join("")
              const streaming = isActive && seg === segments.at(-1)
              const sections = splitReasoningByHeaders([text])

              return sections.map((section, j) => (
                <TimelineStep
                  key={`r-${i}-${j}`}
                  label={section.header ?? "Thinking"}
                  status={
                    streaming && j === sections.length - 1
                      ? "active"
                      : "complete"
                  }
                  icon={BrainIcon}
                >
                  {section.body && (
                    <Markdown className="text-sm leading-tight text-ink-secondary [&_p]:mb-0">
                      {section.body}
                    </Markdown>
                  )}
                </TimelineStep>
              ))
            }
            if (seg.type === "tool") {
              return seg.parts.map((part, j) =>
                part.type === "tool-askUser" ? (
                  <TimelineAskUser key={`a-${i}-${j}`} part={part} />
                ) : (
                  <TimelineToolCall
                    key={`t-${i}-${j}`}
                    part={part}
                    detail={renderDetail?.(part)}
                  />
                )
              )
            }
            return null
          })}
        </Steps.Panel>
      </Steps.Item>
    </Steps>
  )
}
