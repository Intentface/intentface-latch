import type { RecordDiff } from "@/lib/record-diff";
import { fieldLabel } from "@/lib/record-diff";
import { cn } from "@/lib/utils";

/**
 * What changed between two agent records.
 *
 * Non-prompt fields read as "before → after" one-liners; the system prompt gets
 * a real line diff, because it is prose someone re-reads rather than a value
 * they look up. Shared by the version history and the stale-publish warning —
 * both answer the same question, so both should look the same.
 */
export function DiffView({ diff }: { diff: RecordDiff }) {
  if (diff.identical) {
    return <p className="text-ink-secondary text-xs">No changes recorded for this version.</p>;
  }
  return (
    <div className="space-y-3">
      {diff.fields.length > 0 && (
        <dl className="space-y-1 text-xs">
          {diff.fields.map((f) => (
            <div key={f.field} className="flex gap-2">
              <dt className="text-ink-secondary w-24 shrink-0">{fieldLabel(f.field)}</dt>
              <dd className="text-ink-primary min-w-0 flex-1 break-words">
                <span className="text-ink-secondary line-through">{f.before ?? "—"}</span>
                {" → "}
                <span className="font-medium">{f.after ?? "—"}</span>
              </dd>
            </div>
          ))}
        </dl>
      )}
      {diff.instructions.length > 0 && (
        <div>
          <p className="text-ink-secondary mb-1 text-xs">System prompt</p>
          <pre className="border-primary-border max-h-72 overflow-auto rounded-lg border font-mono text-[11px] leading-relaxed">
            {diff.instructions.map((line, i) => (
              <div
                key={i}
                className={cn(
                  "px-2 whitespace-pre-wrap",
                  line.kind === "added" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
                  line.kind === "removed" && "bg-destructive/10 text-destructive",
                  line.kind === "same" && "text-ink-secondary",
                )}
              >
                <span className="select-none opacity-50">
                  {line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "}{" "}
                </span>
                {line.text || " "}
              </div>
            ))}
          </pre>
        </div>
      )}
    </div>
  );
}
