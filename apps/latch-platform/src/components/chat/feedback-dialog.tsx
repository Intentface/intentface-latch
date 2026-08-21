/**
 * Response feedback — thumbs up/down plus an optional comment.
 *
 * Submission is injected, so the dialog stays transport-agnostic: in this app it
 * becomes a Langfuse `user-feedback` score on the run's trace. Rejecting keeps
 * the dialog open with the reason rather than silently swallowing the failure.
 */

import { ThumbsDown, ThumbsUp } from "lucide-react"
import { useState } from "react"
import Button from "@/components/ui/button"
import { Dialog } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

export type FeedbackDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Preselected verdict (the thumb the user clicked to open the dialog). */
  initialValue?: 0 | 1
  onSubmit: (feedback: {
    value: 0 | 1
    comment?: string
  }) => void | Promise<void>
  title?: string
}

export function FeedbackDialog({
  open,
  onOpenChange,
  initialValue,
  onSubmit,
  title = "How was this response?",
}: FeedbackDialogProps) {
  const [value, setValue] = useState<0 | 1 | undefined>(initialValue)
  const [comment, setComment] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reset = (next: boolean) => {
    onOpenChange(next)
    if (!next) {
      setValue(initialValue)
      setComment("")
      setBusy(false)
      setError(null)
    }
  }

  const submit = async () => {
    if (value === undefined || busy) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit({ value, comment: comment.trim() || undefined })
      reset(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't submit feedback.")
      setBusy(false)
    }
  }

  const thumb = (verdict: 0 | 1, Icon: typeof ThumbsUp, label: string) => (
    <button
      type="button"
      aria-pressed={value === verdict}
      aria-label={label}
      onClick={() => setValue(verdict)}
      className={cn(
        "flex h-10 w-12 cursor-pointer items-center justify-center rounded-lg border border-secondary-border text-ink-secondary transition-colors hover:bg-secondary-bg-hover",
        value === verdict &&
          "border-transparent bg-accent-bg text-accent-foreground hover:bg-accent-bg-hover"
      )}
    >
      <Icon className="size-4" />
    </button>
  )

  return (
    <Dialog open={open} onOpenChange={reset}>
      <Dialog.Content className="flex flex-col gap-4">
        <Dialog.Title>{title}</Dialog.Title>
        <div className="flex gap-2">
          {thumb(1, ThumbsUp, "Good response")}
          {thumb(0, ThumbsDown, "Bad response")}
        </div>
        <textarea
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          placeholder="What worked or didn't? (optional)"
          rows={3}
          className="w-full resize-none rounded-lg border border-secondary-border bg-secondary-bg p-2.5 text-sm text-ink-primary outline-none placeholder:text-ink-tertiary focus-visible:ring-2"
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Dialog.Close
            className="cursor-pointer rounded-lg px-3 text-sm text-ink-secondary hover:text-ink-primary"
            disabled={busy}
          >
            Cancel
          </Dialog.Close>
          <Button onClick={submit} disabled={value === undefined || busy}>
            {busy ? "Sending…" : "Send feedback"}
          </Button>
        </div>
      </Dialog.Content>
    </Dialog>
  )
}
