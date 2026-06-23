import { useState } from "react";
import { Check } from "lucide-react";
import { cn } from "../lib/utils.js";
import type { AskUserQuestion } from "./ask-user.js";

/**
 * Interactive clarification questionnaire — rendered when an `askUser` tool
 * call is awaiting input. Single-select questions use radio behavior,
 * `multiSelect` ones use checkboxes. On submit it reports a map of
 * question → comma-joined picked labels, which the host sends back as the
 * tool result to resume the run.
 */
export function AskUser({
  questions,
  onSubmit,
  disabled,
  className,
}: {
  questions: AskUserQuestion[];
  onSubmit: (answers: Record<string, string>) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [sel, setSel] = useState<Record<string, string[]>>({});

  const toggle = (q: string, label: string, multi: boolean) =>
    setSel((prev) => {
      const cur = prev[q] ?? [];
      if (multi) {
        return { ...prev, [q]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] };
      }
      return { ...prev, [q]: [label] };
    });

  const complete = questions.every((q) => (sel[q.question]?.length ?? 0) > 0);

  const submit = () => {
    if (!complete || disabled) return;
    const answers: Record<string, string> = {};
    for (const q of questions) answers[q.question] = (sel[q.question] ?? []).join(", ");
    onSubmit(answers);
  };

  return (
    <div className={cn("flex flex-col gap-4 p-3", className)}>
      {questions.map((q) => {
        const multi = !!q.multiSelect;
        const chosen = sel[q.question] ?? [];
        return (
          <div key={q.question} className="flex flex-col gap-2">
            {q.header && (
              <span className="text-ink-tertiary text-[10px] font-medium tracking-wide uppercase">
                {q.header}
              </span>
            )}
            <p className="text-ink-primary text-sm font-medium">{q.question}</p>
            <div className="flex flex-col gap-1.5">
              {q.options.map((opt) => {
                const active = chosen.includes(opt.label);
                return (
                  <button
                    key={opt.label}
                    type="button"
                    disabled={disabled}
                    onClick={() => toggle(q.question, opt.label, multi)}
                    className={cn(
                      "group/opt flex items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors",
                      active
                        ? "border-accent-border bg-accent/5"
                        : "border-primary-border bg-primary hover:border-accent-border/60",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-0.5 grid size-4 shrink-0 place-items-center border transition-colors",
                        multi ? "rounded" : "rounded-full",
                        active ? "border-accent bg-accent text-white" : "border-primary-border",
                      )}
                    >
                      {active && <Check className="size-3" />}
                    </span>
                    <span className="min-w-0">
                      <span className="text-ink-primary block text-sm">{opt.label}</span>
                      {opt.description && (
                        <span className="text-ink-tertiary block text-xs">{opt.description}</span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      <button
        type="button"
        onClick={submit}
        disabled={!complete || disabled}
        className="bg-accent ml-auto rounded-full px-4 py-1.5 text-sm font-medium text-white transition-opacity disabled:opacity-40"
      >
        Submit
      </button>
    </div>
  );
}
