/**
 * Human-in-the-loop approvals: reading the gate off a message, and mirroring a
 * decision locally.
 *
 * The server pauses a turn on an `approval-requested` tool part and resumes it
 * once a decision lands. The client mirrors each decision onto its own copy
 * *before* streaming the continuation — the stream only re-emits the tool part
 * once it has output, so without the mirror the approval card would sit on
 * screen for the whole execution.
 */

import {
  approvalOf,
  isAwaitingApproval
  
  
} from "@/lib/ai/types"
import type {AppUIMessage, ToolPart} from "@/lib/ai/types";

/** A tool part's loose view — the SDK keeps the approval fields opaque. */
type GatedPart = {
  type: string
  toolName?: string
  state?: string
  input?: unknown
  approval?: { id: string; approved?: boolean }
}

/**
 * The connection a gated tool part is about — either a per-connection
 * `connect_<name>` contributed by a tool source, or the Agent Builder's generic
 * `connect_connection({ name })`. Both render the same Connect card and resume
 * the same way.
 */
export const connectTargetOf = (part: ToolPart): string | undefined => {
  const p = part as GatedPart
  const name =
    p.type === "dynamic-tool" ? p.toolName : p.type.replace(/^tool-/, "")
  if (name === "connect_connection") {
    const target = (p.input as { name?: string } | undefined)?.name
    return typeof target === "string" && target ? target : undefined
  }
  return name?.startsWith("connect_")
    ? name.replace(/^connect_/, "")
    : undefined
}

/**
 * The undecided approvals on the LAST assistant message — the live pause point,
 * matching the server's `hasPendingApproval`. Sending a message supersedes them
 * server-side; mirroring that locally stops the card rendering as live instead
 * of lingering until the next history load.
 */
export const pendingApprovalIdsOnTail = (
  messages: readonly AppUIMessage[]
): string[] => {
  const last = messages.at(-1)
  if (last?.role !== "assistant") return []
  const ids: string[] = []
  for (const part of last.parts ?? []) {
    if (!isAwaitingApproval(part as GatedPart)) continue
    const id = approvalOf(part as GatedPart)?.id
    if (id) ids.push(id)
  }
  return ids
}

/** The approval id of a pending connect gate for `name`, if one awaits a decision. */
export const pendingConnectApprovalId = (
  messages: readonly AppUIMessage[] | undefined,
  name: string
): string | undefined => {
  for (const message of messages ?? []) {
    for (const part of message.parts ?? []) {
      const p = part as GatedPart
      if (connectTargetOf(part as ToolPart) !== name) continue
      if (!isAwaitingApproval(p)) continue
      const id = approvalOf(p)?.id
      if (id) return id
    }
  }
  return undefined
}

/**
 * Mirrors the server's `applyDecisions` onto a local message list: flips the
 * gated part to `approval-responded` so the card gives way to the tool's live
 * view the moment the user decides.
 */
export const applyDecisionToMessages = (
  messages: readonly AppUIMessage[],
  approvalId: string,
  approved: boolean
): AppUIMessage[] =>
  messages.map((message) => {
    const parts = message.parts
    if (!Array.isArray(parts)) return message
    let touched = false
    const nextParts = parts.map((part) => {
      const p = part as GatedPart
      if (p.state !== "approval-requested" || p.approval?.id !== approvalId)
        return part
      touched = true
      return {
        ...p,
        state: "approval-responded",
        approval: { ...p.approval, approved },
      }
    })
    return touched
      ? ({ ...message, parts: nextParts } as AppUIMessage)
      : message
  })
