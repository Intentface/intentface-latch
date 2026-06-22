import { Check, CircleDashed, Loader2, Wrench } from "lucide-react";
import { cn } from "../lib/utils.js";
import { type ToolLabels, type ToolPart, toolLabels as defaultLabels } from "./message-utils.js";

/** The tool's name: `dynamic-tool` carries `toolName`; static parts encode it in `type`. */
const toolName = (part: ToolPart) =>
  part.type === "dynamic-tool"
    ? ((part as { toolName?: string }).toolName ?? "tool")
    : part.type.replace(/^tool-/, "");

function labelFor(part: ToolPart, labels: ToolLabels): string {
  const name = toolName(part);
  const input = (part.input ?? {}) as Record<string, unknown>;
  const entry = labels[name];
  const done = part.state === "output-available";
  if (entry) return done ? entry.complete(input) : entry.active(input);
  return name.replace(/_/g, " ");
}

function summaryOf(part: ToolPart): string | undefined {
  if (part.state !== "output-available") return undefined;
  const out = part.output as unknown;
  if (out && typeof out === "object" && "summary" in out) return String((out as { summary: unknown }).summary);
  return undefined;
}

/**
 * A compact tool-call timeline: one row per tool part with a status icon, a
 * human label (from `toolLabels`), and an optional result summary.
 */
export function Steps({
  tools,
  labels = defaultLabels,
  className,
}: {
  tools: ToolPart[];
  labels?: ToolLabels;
  className?: string;
}) {
  if (tools.length === 0) return null;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {tools.map((part) => {
        const done = part.state === "output-available";
        const errored = part.state === "output-error";
        const active = part.state === "input-streaming" || part.state === "input-available";
        const summary = summaryOf(part);
        return (
          <div key={part.toolCallId} className="text-ink-secondary flex items-start gap-2 text-xs">
            <span className="mt-0.5 shrink-0">
              {errored ? (
                <Wrench className="text-destructive size-3.5" />
              ) : done ? (
                <Check className="size-3.5 text-(--accent)" />
              ) : active ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <CircleDashed className="size-3.5" />
              )}
            </span>
            <span className="min-w-0">
              <span className="text-ink-primary">{labelFor(part, labels)}</span>
              {summary && <span className="text-ink-tertiary"> · {summary}</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}
