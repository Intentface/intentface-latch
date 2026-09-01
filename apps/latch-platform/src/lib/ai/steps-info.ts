// Tool-part → timeline-step derivation. This is the app's contract with its own
// backend tools (the askUser output shape, the webSearch findings shape, the
// approval gate), so it lives in the app, not the generic Steps primitive.

import type { UnknownPart } from "@intentface/chat/types"
import { splitReasoningByHeaders } from "@/lib/ai/message-info"
import { getToolParts } from "@/lib/ai/segments"
import type { MessageSegment } from "@/lib/ai/segments"
import type { ToolLabels } from "@/lib/ai/tool-labels"
import {
  approvalOf,
  isAnyToolPart,
  isAwaitingApproval,
  toolNameOf,
} from "@/lib/ai/types"
import type {
  AskUserInput,
  AskUserQuestion,
  StepStatus,
  ToolPart,
} from "@/lib/ai/types"

/**
 * A tool result arrives either as an object (the optimistic `addToolResult`
 * path) or as a JSON string (the persisted/streamed path). Read both.
 */
const readJsonOutput = <T>(output: unknown, context: string): T | undefined => {
  if (output && typeof output === "object") return output as T
  if (typeof output === "string") {
    try {
      return JSON.parse(output) as T
    } catch (error) {
      console.error(`Failed to parse ${context} output`, { output, error })
    }
  }
  return undefined
}

/**
 * Same read, but SILENT: label generators only glance at the output for a
 * detail (a search query), and most tools return plain text that isn't JSON —
 * logging that raw (bash output, fetched pages) would spill user data and
 * secrets into the browser console on every step.
 */
const peekJsonOutput = (output: unknown): unknown => {
  if (output && typeof output === "object") return output
  if (typeof output === "string") {
    try {
      return JSON.parse(output) as unknown
    } catch {
      return undefined
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Ask-user
// ---------------------------------------------------------------------------

/** A single answered ask-user exchange with parsed questions and answers. */
export type AskUserAnswered = {
  toolCallId: string
  questions: AskUserQuestion[]
  answers: Record<string, string>
}

/** Ask-user tool call info for a message. */
export type AskUserInfo = {
  /** True when at least one ask-user tool is waiting for user input. */
  isAwaitingInput: boolean
  /** Answered ask-user exchanges with parsed Q&A pairs. */
  answered: AskUserAnswered[]
}

const isAskUserPart = (part: UnknownPart): part is ToolPart =>
  isAnyToolPart(part) && part.type === "tool-askUser"

/**
 * Extracts askUser tool parts and returns structured info: whether any are
 * awaiting input, and parsed Q&A pairs for answered ones.
 */
export const getAskUserInfo = (
  allParts: readonly UnknownPart[]
): AskUserInfo => {
  const parts = allParts.filter(
    (p): p is ToolPart =>
      isAskUserPart(p) &&
      (p.state === "input-available" || p.state === "output-available")
  )

  const answered: AskUserAnswered[] = parts
    .filter((p) => p.state === "output-available")
    .map((p) => ({
      toolCallId: p.toolCallId,
      questions: (p.input as AskUserInput | undefined)?.questions ?? [],
      answers:
        readJsonOutput<Record<string, string>>(p.output, "askUser") ?? {},
    }))

  return {
    isAwaitingInput: parts.some((p) => p.state === "input-available"),
    answered,
  }
}

export type AskUserStepInfo = {
  label: string
  status: StepStatus
  questions: AskUserQuestion[]
  answers: Record<string, string>
  isComplete: boolean
}

export const getAskUserStepInfo = (part: ToolPart): AskUserStepInfo => {
  const isComplete = part.state === "output-available"
  const questions = (part.input as AskUserInput | undefined)?.questions ?? []
  const answers = isComplete
    ? (readJsonOutput<Record<string, string>>(part.output, "askUser") ?? {})
    : {}

  const count = questions.length
  const noun = count === 1 ? "question" : "questions"
  // Awaiting the user's answer vs already answered — don't claim "Answered"
  // while the prompt is still open.
  const label = isComplete
    ? `Answered ${count} ${noun}`
    : `Asked ${count} ${noun}`

  return {
    label,
    status: isComplete ? "complete" : "active",
    questions,
    answers,
    isComplete,
  }
}

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

type WebSearchFinding = {
  claim: string
  sources: { url: string; title: string }[]
}

export type ToolCallInfo = {
  name: string
  label: string
  status: StepStatus
  summary: string | null
  /** Present only when the tool failed (state "output-error"). */
  errorText: string | null
  sources: { url: string; title: string; domain: string }[]
  /** The tool's input, for the arguments detail row. */
  input: Record<string, unknown>
  /** Set while the call is paused on an undecided approval. */
  awaitingApproval: boolean
  /** The approval this call is (or was) gated on, if any. */
  approvalId: string | undefined
}

export const getToolCallInfo = (
  part: ToolPart,
  labels: ToolLabels = {}
): ToolCallInfo => {
  const input = (part.input as Record<string, unknown>) ?? {}
  const awaitingApproval = isAwaitingApproval(part)
  const isActive =
    part.state === "input-streaming" || part.state === "input-available"
  const isComplete = part.state === "output-available"
  const isError = part.state === "output-error"
  const name = toolNameOf(part)

  const labelConfig = labels[name]
  // A gate waiting on the user reads as pending, not running: the tool hasn't
  // started, and its label should say so.
  const label = awaitingApproval
    ? `Waiting for approval: ${name}`
    : labelConfig
      ? isActive
        ? labelConfig.active(input)
        : labelConfig.complete(
            input,
            isComplete ? peekJsonOutput(part.output) : undefined
          )
      : isActive
        ? `Running ${name}`
        : `Ran ${name}`

  const status: StepStatus = isError
    ? "error"
    : awaitingApproval
      ? "pending"
      : isActive
        ? "active"
        : isComplete
          ? "complete"
          : "pending"

  const errorText = isError ? (part.errorText ?? "Tool call failed") : null

  // A summary line, when the tool's output offers one.
  const output = isComplete
    ? (part.output as Record<string, unknown> | undefined)
    : null
  const summary = typeof output?.summary === "string" ? output.summary : null

  // Flatten sources from web-search findings.
  const rawOutput = isComplete && name === "webSearch" ? part.output : null
  const findings = Array.isArray(rawOutput)
    ? (rawOutput as WebSearchFinding[])
    : []
  const sources = findings
    .flatMap((f) => f.sources)
    .map((s) => {
      try {
        return { ...s, domain: new URL(s.url).hostname.replace(/^www\./, "") }
      } catch {
        return { ...s, domain: s.title }
      }
    })

  return {
    name,
    label,
    status,
    summary,
    errorText,
    sources,
    input,
    awaitingApproval,
    approvalId: approvalOf(part)?.id,
  }
}

// ---------------------------------------------------------------------------
// Steps-level derivation — the rows, and what the header says about them all.
// ---------------------------------------------------------------------------

export type StepsSummary = {
  toolCount: number
  questionCount: number
}

/** Counts a turn's work. Wording belongs to the caller, not here. */
export const getStepsSummary = (
  segments: readonly MessageSegment[]
): StepsSummary => {
  let toolCount = 0
  let questionCount = 0

  for (const part of getToolParts(segments)) {
    if (part.type !== "tool-askUser") {
      toolCount++
      continue
    }
    const input = part.input as AskUserInput | undefined
    questionCount += input?.questions?.length ?? 0
  }

  return { toolCount, questionCount }
}

/**
 * A row's kind-specific payload. Everything a row needs to render *except* its
 * markup — icons and JSX stay in the component, so this whole module stays
 * testable without React.
 */
export type StepDetail =
  | { kind: "reasoning"; body: string | null }
  | { kind: "tool"; part: ToolPart; info: ToolCallInfo }
  | { kind: "ask-user"; info: AskUserStepInfo }

export type Step = {
  /** Stable across renders: segment index, then position within it. */
  key: string
  label: string
  status: StepStatus
  detail: StepDetail
}

/**
 * Flattens segments into the timeline's rows. Reasoning splits into one row per
 * markdown header, so a long think reads as a list of moves rather than a wall.
 *
 * `isActive` marks the turn as still running: only then can the last reasoning
 * section be the one being written.
 */
export const getSteps = (
  segments: readonly MessageSegment[],
  { isActive, labels }: { isActive: boolean; labels: ToolLabels }
): Step[] => {
  const steps: Step[] = []

  segments.forEach((segment, i) => {
    if (segment.type === "reasoning") {
      const text = segment.parts.map((p) => p.text).join("")
      const streaming = isActive && segment === segments.at(-1)
      const sections = splitReasoningByHeaders([text])

      sections.forEach((section, j) => {
        steps.push({
          key: `r-${i}-${j}`,
          label: section.header ?? "Thinking",
          status:
            streaming && j === sections.length - 1 ? "active" : "complete",
          detail: { kind: "reasoning", body: section.body || null },
        })
      })
      return
    }

    if (segment.type !== "tool") return

    segment.parts.forEach((part, j) => {
      if (part.type === "tool-askUser") {
        const info = getAskUserStepInfo(part)
        steps.push({
          key: `a-${i}-${j}`,
          label: info.label,
          status: info.status,
          detail: { kind: "ask-user", info },
        })
        return
      }
      const info = getToolCallInfo(part, labels)
      steps.push({
        key: `t-${i}-${j}`,
        label: info.label,
        status: info.status,
        detail: { kind: "tool", part, info },
      })
    })
  })

  return steps
}

// ---------------------------------------------------------------------------
/**
 * The header's label while a turn runs: what's happening *now*, in the present
 * tense — never a row's past-tense label.
 *
 * Priority is deliberate. An approval gate outranks a running call because the
 * turn is really waiting on the user; between tool rounds nothing is running,
 * so the most recent tool holds rather than dropping back to "Thinking" once
 * tools have started.
 */
export const getActiveLabel = (
  segments: readonly MessageSegment[],
  labels: ToolLabels
): string => {
  const toolParts = getToolParts(segments)
  const gated = toolParts.find((p) => isAwaitingApproval(p))
  const running = toolParts.find(
    (p) => p.state === "input-streaming" || p.state === "input-available"
  )
  const active = gated ?? running ?? toolParts.at(-1)

  if (!active) return "Thinking..."
  if (gated) return "Waiting for your approval"

  if (active.type === "tool-askUser") {
    const input = active.input as AskUserInput | undefined
    const count = input?.questions?.length ?? 0
    return `Asking ${count === 1 ? "question" : "questions"}`
  }

  const name = toolNameOf(active)
  const input = (active.input as Record<string, unknown>) ?? {}
  return labels[name]?.active(input) ?? `Running ${name}`
}
