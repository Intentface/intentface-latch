/**
 * The card a paused turn shows: approve/deny for a gated tool call, or a
 * Connect prompt when the gate is an OAuth connection.
 *
 * Denying is a real exit, not a cancel — it resumes the turn, so the agent can
 * say what it will do instead. Typing a new message does the same thing
 * server-side, which is why the card also stops rendering as live the moment the
 * user sends something.
 */

import { Loader2 } from "lucide-react"
import Button from "@/components/ui/button"
import { useChatSession } from "@/components/chat/context"
import { connectTargetOf } from "@/lib/ai/approvals"
import { approvalOf,  toolNameOf } from "@/lib/ai/types"
import type {ToolPart} from "@/lib/ai/types";

export const ApprovalCard = ({ part }: { part: ToolPart }) => {
  const { deciding, decide, connect } = useChatSession()
  const approvalId = approvalOf(part)?.id
  if (!approvalId) return null

  const connection = connectTargetOf(part)

  if (connection) {
    return (
      <div className="rounded-2xl border border-primary-border bg-primary-bg p-3 [corner-shape:squircle]">
        {deciding ? (
          <div className="flex items-center gap-2 text-sm text-ink-secondary">
            <Loader2 className="size-4 animate-spin" />
            Connecting <span className="font-medium">{connection}</span> and
            resuming…
          </div>
        ) : (
          <>
            <div className="text-sm text-ink-primary">
              Connect <span className="font-medium">{connection}</span> to
              continue.
            </div>
            <p className="my-1.5 text-xs text-ink-tertiary">
              You'll authorize access, then this conversation resumes
              automatically. Or dismiss this and tell the agent what to do
              instead.
            </p>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => connect(connection, approvalId)}>
                Connect {connection}
              </Button>
              {/* The way out when the connection can't be completed at all (bad
                  credentials, a provider that never redirects back). Denying
                  resumes the turn, so the agent can offer another route. */}
              <Button
                size="sm"
                variant="outline"
                onClick={() => decide(approvalId, false)}
              >
                Dismiss
              </Button>
            </div>
          </>
        )}
      </div>
    )
  }

  return (
    <div className="rounded-2xl border border-primary-border bg-primary-bg p-3 [corner-shape:squircle]">
      <div className="text-sm text-ink-primary">
        Approve <span className="font-medium">{toolNameOf(part)}</span>?
      </div>
      <pre className="my-1.5 overflow-x-auto text-xs text-ink-secondary">
        {JSON.stringify(part.input, null, 2)}
      </pre>
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={deciding}
          onClick={() => decide(approvalId, true)}
        >
          Approve
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={deciding}
          onClick={() => decide(approvalId, false)}
        >
          Deny
        </Button>
      </div>
    </div>
  )
}
