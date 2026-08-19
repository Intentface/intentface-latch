import { useElapsedSeconds } from "@/hooks/use-elapsed-seconds"
import { useThrottledText } from "@/hooks/use-throttled-text"
import type { MessageSegment } from "@/lib/ai/segments"
import { getActiveLabel, getSteps, getStepsSummary } from "@/lib/ai/steps-info"
import type { Step } from "@/lib/ai/steps-info"
import { DEFAULT_TOOL_LABELS } from "@/lib/ai/tool-labels"

const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`

/** ", used 3 tools, asked 1 question" — empty when the turn did neither. */
const summarySuffix = (toolCount: number, questionCount: number) => {
  const clauses: string[] = []
  if (toolCount > 0) clauses.push(`used ${plural(toolCount, "tool")}`)
  if (questionCount > 0)
    clauses.push(`asked ${plural(questionCount, "question")}`)
  return clauses.length > 0 ? `, ${clauses.join(", ")}` : ""
}

export type StepsView = {
  /** The rows, flattened from segments. */
  steps: Step[]
  /** What the header reads right now — live narration, or the done summary. */
  label: string
  /** Still running, or paused on the user. Drives the header's shimmer. */
  isActive: boolean
}

/**
 * Everything the timeline needs that isn't markup: the rows, and the one line
 * of narration above them. Pure derivation lives in `steps-info`; this hook is
 * the composition layer plus the two things that need to persist across renders
 * — how long the turn ran, and a throttle so fast tools don't flicker past.
 */
export const useSteps = (
  segments: readonly MessageSegment[],
  {
    isStreaming,
    awaitingInput,
  }: { isStreaming: boolean; awaitingInput: boolean }
): StepsView => {
  const isActive = isStreaming || awaitingInput
  const duration = useElapsedSeconds(isStreaming)

  // Hold each label past the roll animation so a fast tool sequence reads as a
  // calm loop instead of overlapping mid-roll swaps.
  const liveLabel = useThrottledText(
    getActiveLabel(segments, DEFAULT_TOOL_LABELS),
    200
  )

  const { toolCount, questionCount } = getStepsSummary(segments)
  const elapsed =
    duration === undefined ? "a few seconds" : plural(duration, "second")
  const doneLabel = `Thought for ${elapsed}${summarySuffix(toolCount, questionCount)}`

  return {
    steps: getSteps(segments, { isActive, labels: DEFAULT_TOOL_LABELS }),
    label: isActive ? liveLabel : doneLabel,
    isActive,
  }
}
