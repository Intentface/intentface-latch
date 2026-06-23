import { type ReactNode, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";
import { cn } from "../lib/utils.js";

/**
 * Chat composer: a rounded input with an auto-growing textarea (Enter sends,
 * Shift+Enter newlines) and an accent send button. `leading` is a slot for
 * controls like a model selector or attach button. Kept lean and reusable; the
 * tiptap commands/mentions can layer in later.
 */
export function Composer({
  onSubmit,
  disabled,
  placeholder = "Message the agent…",
  leading,
  className,
}: {
  onSubmit: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
  leading?: ReactNode;
  className?: string;
}) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  const resize = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };
  const send = () => {
    const text = value.trim();
    if (!text || disabled) return;
    onSubmit(text);
    setValue("");
    if (ref.current) ref.current.style.height = "auto";
  };

  return (
    <div
      className={cn(
        "border-primary-border bg-secondary focus-within:border-accent-border flex flex-col gap-2 rounded-2xl border p-2.5 shadow-sm transition-colors",
        className,
      )}
    >
      <textarea
        ref={ref}
        rows={1}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => {
          setValue(e.target.value);
          resize(e.target);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        className="text-ink-primary placeholder:text-ink-tertiary max-h-48 w-full resize-none bg-transparent px-1.5 text-sm outline-none"
      />
      <div className="flex items-center gap-2">
        {leading}
        <button
          type="button"
          onClick={send}
          disabled={disabled || !value.trim()}
          aria-label="Send"
          className="bg-accent ml-auto grid size-7 shrink-0 place-items-center rounded-full text-white transition-opacity disabled:opacity-40"
        >
          <ArrowUp className="size-4" />
        </button>
      </div>
    </div>
  );
}
