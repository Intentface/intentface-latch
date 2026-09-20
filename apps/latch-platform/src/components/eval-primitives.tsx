import type { ReactNode } from "react";
import { Crosshair, Replace, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Question } from "@/lib/evals/ask";
import type { CheckVerdict } from "@/lib/evals/store";

/**
 * The small vocabulary the evals page is written in.
 *
 * Three distinctions carry most of the meaning on this page, and all three are
 * invisible if they are only text: where a check LIVES (editing a shared one
 * changes every case), what KIND of judgment it is (a choice is not a styled
 * boolean), and which CONFIGURATION a run measured. Each gets a mark with its
 * own shape and icon, so none of them is colour alone and all of them survive a
 * screenshot pasted into a ticket.
 */

/** Below this, the judge was not sure, and a human ruling is worth the most. */
export const UNCERTAIN = 0.7;

export type CheckScope = "shared" | "case" | "override";

export function Chip({
  children,
  className,
  mono,
}: {
  children: ReactNode;
  className?: string;
  mono?: boolean;
}) {
  return (
    <span
      className={cn(
        "border-secondary-border text-ink-secondary inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] leading-none",
        mono && "font-mono",
        className,
      )}
    >
      {children}
    </span>
  );
}

const KIND_MEANS: Record<string, string> = {
  boolean: "line",
  choice: "diagnosis",
  score: "degree",
};

/**
 * What kind of judgment this is, and what that kind is FOR — because the three
 * are not interchangeable and the choice between them is the whole skill. A
 * boolean draws a line; a choice names which of several failures happened; a
 * score places the answer on a ladder.
 */
export function KindTag({ q }: { q: Question }) {
  const kind = q.type ?? "boolean";
  return (
    <span className="text-ink-tertiary inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider">
      <span className="text-ink-secondary">{kind}</span>
      <span aria-hidden className="opacity-60">
        ·
      </span>
      <span>{KIND_MEANS[kind]}</span>
    </span>
  );
}

/**
 * Where a check lives — the most load-bearing distinction on the page, and the
 * one the UI previously did not draw at all. A reader inside a case saw six
 * identical widgets, two of which would rewrite every other case if edited.
 *
 * It also decides what the numbers can say. Shared over 100 inputs is n=100 and
 * a comparison can resolve it; per-case is n=1 and never can.
 */
export function ScopeTag({
  scope,
  count,
  className,
}: {
  scope: CheckScope;
  /** For shared: how many cases it is asked of. */
  count?: number;
  className?: string;
}) {
  const base =
    "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide leading-none";
  if (scope === "shared")
    return (
      <span
        className={cn(base, "border-secondary-border bg-secondary-bg text-ink-secondary border", className)}
        title={
          count
            ? `Shared — asked of all ${count} cases. Editing it changes every one of them.`
            : "Shared — asked of every case."
        }
      >
        <Users className="size-3" aria-hidden />
        shared{count ? ` · ${count}` : ""}
      </span>
    );
  if (scope === "override")
    return (
      <span
        className={cn(base, "border-accent-border bg-accent-bg/15 text-ink-primary border", className)}
        title="Override — the shared question, sharpened for this one input."
      >
        <Replace className="size-3" aria-hidden />
        override
      </span>
    );
  return (
    <span
      className={cn(base, "border-ink-tertiary/60 text-ink-tertiary border border-dashed", className)}
      title="This case only — carries ground truth no other input has. n=1, so it can never resolve a comparison on its own."
    >
      <Crosshair className="size-3" aria-hidden />
      this case
    </span>
  );
}

/**
 * A run's identity is its CONFIGURATION, not its time.
 *
 * Two runs of the same version are a flakiness signal; two runs of different
 * versions are a comparison. A timestamp cannot tell you which you are reading,
 * so the label leads and each kind takes its own shape: live is a filled pill
 * with a dot, a published version is a solid rectangle, a draft is dashed.
 */
export function ConfigBadge({ label, className }: { label: string; className?: string }) {
  const shared =
    "inline-flex items-center gap-1.5 px-1.5 py-0.5 text-[11px] font-medium font-mono leading-none";
  if (label === "draft")
    return (
      <span
        className={cn(shared, "border-ink-tertiary text-ink-secondary rounded-md border border-dashed", className)}
        title="The author's unpublished draft"
      >
        {label}
      </span>
    );
  if (label === "live" || label === "")
    return (
      <span
        className={cn(shared, "border-accent-border bg-accent-bg/15 text-ink-primary rounded-full border", className)}
        title="Whatever is serving traffic right now"
      >
        <span aria-hidden className="bg-accent size-1.5 rounded-full" />
        live
      </span>
    );
  return (
    <span
      className={cn(shared, "border-secondary-border bg-secondary-bg text-ink-primary rounded-md border", className)}
      title="A published version, pinned"
    >
      {label}
    </span>
  );
}

export function PanelHeader({
  title,
  hint,
  right,
}: {
  title: string;
  hint?: string;
  right?: ReactNode;
}) {
  return (
    <div className="border-secondary-border flex items-start justify-between gap-4 border-b px-4 py-3">
      <div className="space-y-0.5">
        <h2 className="text-ink-primary text-sm font-semibold">{title}</h2>
        {hint ? <p className="text-ink-tertiary max-w-prose text-xs leading-relaxed">{hint}</p> : null}
      </div>
      {right ? <div className="shrink-0">{right}</div> : null}
    </div>
  );
}

export type Tone = "pass" | "fail" | "uncertain" | "neutral";

export interface Presented {
  tone: Tone;
  /** The thing to read in the cell. For a choice this is the diagnosis. */
  label: string;
  /** The pass/fail underneath an uncertain flag. */
  base: "pass" | "fail";
  uncertain: boolean;
  confidence: number;
}

/**
 * How a verdict should read.
 *
 * Two things this fixes. A choice verdict is never reduced to a tick — the
 * option it picked IS the diagnosis, and `said_none_match` and `invented_posts`
 * are different bugs that a boolean records identically. And a judge at 0.51 is
 * separated from one at 0.99: the uncertain ones are where a human ruling
 * carries the most information, so they have to be findable.
 */
export function present(v: CheckVerdict, human?: boolean): Presented {
  const failed = human ?? v.failed;
  const base: "pass" | "fail" = failed ? "fail" : "pass";
  // A human ruling is certain by construction — a person looked.
  const uncertain = human === undefined && v.confidence > 0 && v.confidence < UNCERTAIN;
  return {
    tone: uncertain ? "uncertain" : base,
    label: v.answer,
    base,
    uncertain,
    confidence: v.confidence,
  };
}

export const pctOf = (n: number) => `${Math.round(n * 100)}%`;
