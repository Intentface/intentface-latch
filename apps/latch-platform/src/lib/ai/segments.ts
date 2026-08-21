/**
 * Chronological segmentation — which parts render in the turn timeline, and in
 * what runs.
 *
 * `@intentface/chat/message-utils` ships this for the parts it models, but two
 * of the platform's rules live outside that contract: `dynamic-tool` parts are
 * tool calls too (MCP / connection tools), and `request_secret` is rendered as
 * its own credential form rather than a timeline row. What belongs in the
 * timeline is app policy, so the walk lives here.
 */

import type {
  FilePart,
  ReasoningPart,
  TextPart,
  UnknownPart,
} from "@intentface/chat/types"
import { isFilePart, isReasoningPart, isTextPart } from "@intentface/chat/types"
import { isAnyToolPart  } from "@/lib/ai/types"
import type {ToolPart} from "@/lib/ai/types";

/** Parts rendered outside the timeline, by their own dedicated surface. */
const SEPARATELY_RENDERED = new Set(["tool-request_secret"])

/** Classifies message parts into coarse groups for chronological rendering. */
export type SegmentType = "reasoning" | "tool" | "text" | "file"

/** A contiguous run of same-typed message parts. */
export type MessageSegment =
  | { type: "reasoning"; parts: ReasoningPart[] }
  | { type: "tool"; parts: ToolPart[] }
  | { type: "text"; parts: TextPart[] }
  | { type: "file"; parts: FilePart[] }

/** Maps one part to its segment type; `null` for parts rendered elsewhere. */
export const partSegmentType = (part: UnknownPart): SegmentType | null => {
  if (SEPARATELY_RENDERED.has(part.type)) return null
  if (isReasoningPart(part)) return "reasoning"
  if (isTextPart(part)) return "text"
  if (isFilePart(part)) return "file"
  if (isAnyToolPart(part)) return "tool"
  return null
}

/**
 * Groups parts into contiguous same-type segments, preserving chronological
 * order so reasoning interleaved with tool calls renders in the order it
 * happened.
 */
export const getSegmentedParts = (
  parts: readonly UnknownPart[]
): MessageSegment[] => {
  const segments: MessageSegment[] = []
  for (const part of parts) {
    const segType = partSegmentType(part)
    if (!segType) continue

    const last = segments.at(-1)
    if (last && last.type === segType) {
      ;(last.parts as UnknownPart[]).push(part)
    } else {
      segments.push({ type: segType, parts: [part] } as MessageSegment)
    }
  }
  return segments
}

/** Aggregated text content from all text segments — the copy-action payload. */
export const getTextInfo = (segments: readonly MessageSegment[]) => {
  const parts = segments
    .filter((s): s is MessageSegment & { type: "text" } => s.type === "text")
    .flatMap((s) => s.parts)
  return { parts, text: parts.map((p) => p.text).join("") }
}

/** Extracts all file attachment parts from segments. */
export const getFileParts = (segments: readonly MessageSegment[]): FilePart[] =>
  segments
    .filter((s): s is MessageSegment & { type: "file" } => s.type === "file")
    .flatMap((s) => s.parts)

/** Every tool part in the message, in order. */
export const getToolParts = (segments: readonly MessageSegment[]): ToolPart[] =>
  segments
    .filter((s): s is MessageSegment & { type: "tool" } => s.type === "tool")
    .flatMap((s) => s.parts)
