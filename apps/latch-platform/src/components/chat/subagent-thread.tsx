/**
 * A `spawn_agent` call's delegated conversation, rendered inside its timeline
 * row.
 *
 * While the subagent runs, the streamed `data-subagent-progress` part carries
 * the exchange live. Once the tool result lands that part is gone, so the thread
 * is fetched on demand from the subagent's own persisted history.
 */

import { Loader2 } from "lucide-react"
import { useEffect, useState } from "react"
import { useChatSession } from "@/components/chat/context"
import { ChatMessageItem } from "@/components/chat/message-item"
import type { SubagentProgressData } from "@intentface/latch-core"
import type { AppUIMessage, ToolPart } from "@/lib/ai/types"

export const SubagentThread = ({
  part,
  progress,
}: {
  part: ToolPart
  progress?: SubagentProgressData
}) => {
  const { loadThread } = useChatSession()
  const p = part as {
    state?: string
    input?: { agent?: string; threadId?: string }
    output?: { threadId?: string; answer?: string }
  }
  const threadId = p.output?.threadId ?? p.input?.threadId ?? progress?.threadId
  const running = p.state === "input-streaming" || p.state === "input-available"
  const live = running && progress ? progress : undefined

  const [messages, setMessages] = useState<AppUIMessage[] | null>(null)
  const [loading, setLoading] = useState(false)

  // Settled call: fetch the delegated transcript once this row is expanded (the
  // row only mounts its panel when open, so this is the lazy load).
  useEffect(() => {
    if (live || !threadId || messages !== null) return
    let cancelled = false
    setLoading(true)
    loadThread(threadId)
      .then((loaded) => {
        if (!cancelled) setMessages(loaded)
      })
      .catch(() => {
        if (!cancelled) setMessages([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [live, threadId, messages, loadThread])

  const shown = live?.messages ?? messages

  return (
    <div className="flex flex-col gap-3">
      {live && (
        <span className="flex items-center gap-1.5 text-xs text-ink-tertiary">
          <Loader2 className="size-3 shrink-0 animate-spin" />
          Running…
        </span>
      )}
      {loading && <p className="text-xs text-ink-tertiary">Loading…</p>}
      {shown && shown.length > 0
        ? shown.map((message) => (
            <ChatMessageItem
              key={message.id}
              message={message}
              isLast={false}
              isStreaming={false}
              readOnly
            />
          ))
        : !loading && (
            <p className="text-xs text-ink-tertiary">No messages yet.</p>
          )}
    </div>
  )
}
