/**
 * The turn timeline: reasoning and tool calls as one collapsible, chronological
 * disclosure, composed over the `Steps` primitive.
 *
 * The timeline stays collapsed unless the user opens it: the header alone
 * narrates what's happening now while the turn runs, then settles into a
 * "Thought for Xs, used N tools" summary. Rows that carry detail (a tool's
 * arguments, a delegated subagent conversation, an eval run) start closed too
 * and expand in place — nothing opens itself at either level.
 *
 * Rows render straight onto the primitive: `useSteps` derives them, this file
 * draws them. There is no row component in between.
 */

import { CircleIcon, Loader } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import { useState } from "react"
import type { ComponentType, ReactNode } from "react"
import { Steps } from "@/components/ai/steps"
import { BrainIcon } from "@/components/icons/brain"
import { CheckMarkMediumIcon } from "@/components/icons/check-mark-medium"
import { ChevronDownIcon } from "@/components/icons/chevron-down"
import { CircleQuestionmarkIcon } from "@/components/icons/circle-questionmark"
import { ExclamationTriangleIcon } from "@/components/icons/exclamation-triangle"
import { Markdown } from "@/components/ui/markdown"
import { TextShimmer } from "@/components/ui/text-shimmer"
import { useSteps } from "@/hooks/use-steps"
import type { MessageSegment } from "@/lib/ai/segments"
import type { Step } from "@/lib/ai/steps-info"
import type { StepStatus, ToolPart } from "@/lib/ai/types"
import { cn } from "@/lib/utils"

type IconComponent = ComponentType<{ className?: string }>

const statusIcons: Record<StepStatus, IconComponent> = {
  complete: CheckMarkMediumIcon,
  active: CircleIcon,
  pending: Loader,
  error: ExclamationTriangleIcon,
}

/** Reasoning and questions carry their own glyph; tools go by status. */
const iconFor = (step: Step): IconComponent => {
  if (step.detail.kind === "reasoning") return BrainIcon
  if (step.detail.kind === "ask-user") return CircleQuestionmarkIcon
  return statusIcons[step.status]
}

/**
 * A row's expandable body, or null when it has none — which is what decides
 * whether the row is a static line or a disclosure.
 */
const detailFor = (
  step: Step,
  renderDetail?: (part: ToolPart) => ReactNode | undefined
): ReactNode => {
  const { detail } = step

  if (detail.kind === "reasoning") {
    if (!detail.body) return null
    return (
      <Markdown className="text-sm leading-tight text-ink-secondary [&_p]:mb-0">
        {detail.body}
      </Markdown>
    )
  }

  if (detail.kind === "ask-user") {
    const { questions, answers, isComplete } = detail.info
    return (
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
    )
  }

  const { summary, errorText, sources, input } = detail.info
  const custom = renderDetail?.(detail.part)
  const hasArgs = Object.keys(input).length > 0

  return (
    <>
      {errorText && (
        <span className="text-xs text-destructive">{errorText}</span>
      )}
      {summary && <span className="text-xs text-ink-secondary">{summary}</span>}
      {custom}
      {!custom && hasArgs && (
        <pre className="overflow-x-auto rounded-md border border-primary-border bg-primary-bg p-2.5 text-xs text-ink-tertiary">
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
    </>
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
  const { steps, label, isActive } = useSteps(segments, {
    isStreaming,
    awaitingInput,
  })

  // Collapsed by default. The rolling header is the narration, so the timeline
  // stays quiet until the user asks for it — and stays wherever they left it.
  const [open, setOpen] = useState(false)

  // One rolling label for both states — the box never changes when the stream
  // ends, so there's no layout shift: the last active label rolls out and the
  // summary rolls in (shimmer only while active).
  const header = (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span
        key={label}
        initial={{ opacity: 0, y: "100%", filter: "blur(4px)" }}
        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
        exit={{ opacity: 0, y: "-100%", filter: "blur(4px)" }}
        transition={{ duration: 0.3, ease: "easeOut" }}
        className="block"
      >
        {isActive ? <TextShimmer>{label}</TextShimmer> : label}
      </motion.span>
    </AnimatePresence>
  )

  // The tree keeps its shape across the no-steps boundary: a text-only turn is
  // the same trigger with nothing to expand, disabled. Swapping element types
  // here would remount the header and swallow the label's roll on the frame the
  // first step lands — exactly the frame it has to play.
  const hasSteps = steps.length > 0

  return (
    <Steps>
      <Steps.Item open={open} onOpenChange={setOpen}>
        <Steps.Trigger
          disabled={!hasSteps}
          className={cn(!hasSteps && "cursor-default hover:text-ink-secondary")}
        >
          <span className="overflow-hidden text-left">{header}</span>
          {hasSteps && (
            <ChevronDownIcon className="size-4 shrink-0 transition-transform group-data-open/steps-trigger:rotate-180" />
          )}
        </Steps.Trigger>
        <Steps.Panel>
          {steps.map((step) => {
            const Icon = iconFor(step)
            const glyph = (
              <Icon
                className={cn(
                  "size-3.5",
                  step.status === "active" && "animate-pulse",
                  step.status === "pending" && "animate-spin"
                )}
              />
            )
            const detail = detailFor(step, renderDetail)

            if (!detail) {
              return (
                <Steps.Item key={step.key} status={step.status}>
                  <div className="flex items-center gap-2 py-0.5">
                    <Steps.Icon
                      className={"data-[status=error]:text-destructive"}
                    >
                      {glyph}
                    </Steps.Icon>
                    <Steps.Label
                      className={"data-[status=error]:text-destructive"}
                    >
                      {step.label}
                    </Steps.Label>
                  </div>
                </Steps.Item>
              )
            }

            // `defaultOpen` is explicit because the primitive would otherwise
            // open an active row for us — rows start closed at every level.
            return (
              <Steps.Item
                key={step.key}
                status={step.status}
                defaultOpen={false}
              >
                <Steps.Trigger>
                  <Steps.Icon
                    className={cn(
                      "relative",
                      "data-[status=error]:text-destructive"
                    )}
                  >
                    <span className="transition-opacity group-hover/steps-trigger:opacity-0 group-data-open/steps-trigger:opacity-0">
                      {glyph}
                    </span>
                    <ChevronDownIcon className="absolute size-4 opacity-0 transition-all group-hover/steps-trigger:opacity-100 group-data-open/steps-trigger:rotate-180 group-data-open/steps-trigger:opacity-100" />
                  </Steps.Icon>
                  <Steps.Label
                    className={"data-[status=error]:text-destructive"}
                  >
                    {step.label}
                  </Steps.Label>
                </Steps.Trigger>
                <Steps.Panel>{detail}</Steps.Panel>
              </Steps.Item>
            )
          })}
        </Steps.Panel>
      </Steps.Item>
    </Steps>
  )
}
