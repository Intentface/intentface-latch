import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "../lib/utils.js";
import type { AskUserQuestion } from "./ask-user.js";

/**
 * Imperative handle so an external driver (the composer) can navigate the
 * questionnaire from the keyboard while focus stays in the input.
 */
export type AskUserHandle = {
  /** Move the highlight within the current question's options. */
  navigate: (dir: number) => void;
  /** Act on the highlighted option: single-select picks + advances; multi toggles. */
  enter: () => void;
  /** Go to the previous question. */
  prev: () => void;
  /** Advance (or submit on the last question) when the current one is answered. */
  next: () => void;
  /** Pick the option at a 0-based index (number keys). */
  pickIndex: (i: number) => void;
};

/**
 * Interactive clarification questionnaire — one question at a time with
 * Prev/Next + a step indicator, numbered single-select radios or multi-select
 * checkboxes, keyboard hints, and an imperative handle for composer-driven
 * keyboard navigation. On completion it reports a map of question → comma-joined
 * picked labels, which the host returns as the tool result to resume the run.
 * Ported from intentface-chat.
 */
export const AskUser = forwardRef<
  AskUserHandle,
  {
    questions: AskUserQuestion[];
    onSubmit: (answers: Record<string, string>) => void;
    disabled?: boolean;
    className?: string;
  }
>(function AskUser({ questions, onSubmit, disabled, className }, ref) {
  const [step, setStep] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const rootRef = useRef<HTMLDivElement>(null);

  // Take focus when mounted / when the question changes so the keyboard drives
  // the questionnaire immediately (no click needed).
  useEffect(() => {
    rootRef.current?.focus();
  }, [step]);

  const total = questions.length;
  const q = questions[step];
  const multi = !!q?.multiSelect;
  const chosen = (q && answers[q.question]) || [];

  const completeOf = (a: Record<string, string[]>) =>
    questions.every((qq) => (a[qq.question]?.length ?? 0) > 0);
  const compile = (a: Record<string, string[]>): Record<string, string> =>
    Object.fromEntries(questions.map((qq) => [qq.question, (a[qq.question] ?? []).join(", ")]));

  const answeredAll = useMemo(() => completeOf(answers), [answers]); // eslint-disable-line react-hooks/exhaustive-deps
  const currentAnswered = (chosen?.length ?? 0) > 0;

  const goto = (s: number) => {
    setStep(Math.max(0, Math.min(total - 1, s)));
    setHighlight(0);
  };

  const submit = (a: Record<string, string[]> = answers) => {
    if (disabled || !completeOf(a)) return;
    onSubmit(compile(a));
  };

  const pick = (i: number) => {
    if (!q || disabled) return;
    const label = q.options[i]?.label;
    if (label == null) return;
    setHighlight(i);
    if (multi) {
      const cur = answers[q.question] ?? [];
      const nextLabels = cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label];
      setAnswers((p) => ({ ...p, [q.question]: nextLabels }));
      return;
    }
    const next = { ...answers, [q.question]: [label] };
    setAnswers(next);
    if (step < total - 1) goto(step + 1);
    else submit(next);
  };

  const next = () => {
    if (!currentAnswered) return;
    if (step < total - 1) goto(step + 1);
    else submit();
  };

  useImperativeHandle(
    ref,
    () => ({
      navigate: (dir) => setHighlight((h) => Math.max(0, Math.min((q?.options.length ?? 1) - 1, h + dir))),
      enter: () => pick(highlight),
      prev: () => goto(step - 1),
      next,
      pickIndex: (i) => pick(i),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [q, multi, highlight, step, answers],
  );

  const onKey = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowUp":
        setHighlight((h) => Math.max(0, h - 1));
        break;
      case "ArrowDown":
        setHighlight((h) => Math.min((q?.options.length ?? 1) - 1, h + 1));
        break;
      case "ArrowLeft":
        goto(step - 1);
        break;
      case "ArrowRight":
        next();
        break;
      case "Enter":
        pick(highlight);
        break;
      default:
        if (/^[1-9]$/.test(e.key)) pick(Number(e.key) - 1);
        else return; // let other keys pass through
    }
    e.preventDefault();
  };

  if (!q) return null;

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      onKeyDown={onKey}
      className={cn("flex flex-col gap-3 p-3 outline-none", className)}
    >
      <div className="flex items-center gap-2">
        {q.header && (
          <span className="text-ink-tertiary text-[10px] font-medium tracking-wide uppercase">
            {q.header}
          </span>
        )}
        <p className="text-ink-primary min-w-0 flex-1 text-sm font-medium">{q.question}</p>
        {total > 1 && (
          <div className="flex shrink-0 items-center gap-1">
            <NavBtn onClick={() => goto(step - 1)} disabled={step === 0} aria-label="Previous">
              <ChevronLeft className="size-3.5" />
            </NavBtn>
            <span className="text-ink-tertiary text-[10px] tabular-nums">
              {step + 1} of {total}
            </span>
            <NavBtn onClick={next} disabled={!currentAnswered} aria-label="Next">
              <ChevronRight className="size-3.5" />
            </NavBtn>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1">
        {q.options.map((opt, i) => {
          const active = chosen.includes(opt.label);
          const hl = i === highlight;
          return (
            <button
              key={opt.label}
              type="button"
              tabIndex={-1}
              disabled={disabled}
              onMouseMove={() => setHighlight(i)}
              onClick={() => pick(i)}
              className={cn(
                "flex items-start gap-2.5 rounded-lg p-2 text-left transition-colors",
                hl ? "bg-primary-hover" : "bg-transparent",
              )}
            >
              <span
                className={cn(
                  "mt-px grid size-4 shrink-0 place-items-center border text-[10px] font-medium tabular-nums transition-colors",
                  multi ? "rounded" : "rounded-[4px]",
                  active
                    ? "border-accent bg-accent text-white"
                    : "border-primary-border text-ink-secondary",
                )}
              >
                {multi ? active && <Check className="size-3" /> : i + 1}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="text-ink-primary text-sm leading-normal">{opt.label}</span>
                {opt.description && (
                  <span className="text-ink-tertiary text-xs leading-tight">{opt.description}</span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-3 px-1">
        <span className="text-ink-tertiary text-[10px]">
          ↑↓ move · ↵ select{total > 1 ? " · ←→ steps" : ""}
        </span>
        {(step === total - 1 || multi) && (
          <button
            type="button"
            onClick={() => submit()}
            disabled={!answeredAll || disabled}
            className="bg-accent rounded-full px-3 py-1 text-xs font-medium text-white transition-opacity disabled:opacity-40"
          >
            Submit
          </button>
        )}
      </div>
    </div>
  );
});

function NavBtn({ className, ...props }: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "text-ink-secondary hover:bg-tertiary-hover hover:text-ink-primary grid size-6 place-items-center rounded-md transition-colors disabled:pointer-events-none disabled:opacity-30",
        className,
      )}
      {...props}
    />
  );
}
