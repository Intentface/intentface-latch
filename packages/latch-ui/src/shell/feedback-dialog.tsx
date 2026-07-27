import { useState } from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { cn } from "../lib/utils.js";
import { Dialog } from "./dialog.js";
import Button from "./button.js";

export interface FeedbackDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Preselected verdict (the thumb the user clicked to open the dialog). */
  initialValue?: 0 | 1;
  /**
   * Submission is injected — the dialog is router/fetch-agnostic. Reject or
   * throw to keep it open; resolve to close it.
   */
  onSubmit: (feedback: { value: 0 | 1; comment?: string }) => void | Promise<void>;
  title?: string;
}

/**
 * A reusable response-feedback dialog: thumbs up/down plus an optional
 * free-text comment. Hosts wire `onSubmit` to their feedback endpoint (in
 * latch-platform it becomes a Langfuse `user-feedback` score on the run's
 * trace).
 */
export function FeedbackDialog({
  open,
  onOpenChange,
  initialValue,
  onSubmit,
  title = "How was this response?",
}: FeedbackDialogProps) {
  const [value, setValue] = useState<0 | 1 | undefined>(initialValue);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setValue(initialValue);
      setComment("");
      setBusy(false);
      setError(null);
    }
  };

  const submit = async () => {
    if (value === undefined || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ value, comment: comment.trim() || undefined });
      reset(false);
    } catch (e) {
      // Show why the dialog stayed open instead of silently re-enabling.
      setError(e instanceof Error ? e.message : "Couldn't submit feedback.");
      setBusy(false);
    }
  };

  const thumb = (v: 0 | 1, Icon: typeof ThumbsUp, label: string) => (
    <button
      type="button"
      aria-pressed={value === v}
      aria-label={label}
      onClick={() => setValue(v)}
      className={cn(
        "border-secondary-border text-ink-secondary hover:bg-secondary-hover flex h-10 w-12 cursor-pointer items-center justify-center rounded-lg border transition-colors",
        value === v && "bg-accent hover:bg-accent-hover border-transparent text-white",
      )}
    >
      <Icon className="size-4" />
    </button>
  );

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
          onChange={(e) => setComment(e.target.value)}
          placeholder="What worked or didn't? (optional)"
          rows={3}
          className="border-secondary-border text-ink-primary placeholder:text-ink-tertiary bg-secondary w-full resize-none rounded-lg border p-2.5 text-sm outline-none focus-visible:ring-2"
        />
        {error && <p className="text-sm text-red-500">{error}</p>}
        <div className="flex justify-end gap-2">
          <Dialog.Close
            className="text-ink-secondary hover:text-ink-primary cursor-pointer rounded-lg px-3 text-sm"
            disabled={busy}
          >
            Cancel
          </Dialog.Close>
          <Button size="md" onClick={submit} disabled={value === undefined || busy}>
            {busy ? "Sending…" : "Send feedback"}
          </Button>
        </div>
      </Dialog.Content>
    </Dialog>
  );
}
