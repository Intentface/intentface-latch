import { Collapsible } from "@base-ui/react/collapsible";
import { Check, ChevronDown, CircleDashed, Loader2, Wrench } from "lucide-react";
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
  if (out && typeof out === "object" && "summary" in out) {
    return String((out as { summary: unknown }).summary);
  }
  return undefined;
}

/** Pretty-print a tool input/output value for the expanded detail panel. */
function format(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * A tool-call timeline: one row per tool with a status icon and a human label
 * (from `toolLabels`). Rows with arguments/results are collapsible — expand to
 * see the tool's input and output; the status icon swaps to a chevron on
 * hover/open. Styled after intentface-chat's Steps.
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
    <div className={cn("flex flex-col gap-1", className)}>
      {tools.map((part) => (
        <StepRow key={part.toolCallId} part={part} labels={labels} />
      ))}
    </div>
  );
}

function StepRow({ part, labels }: { part: ToolPart; labels: ToolLabels }) {
  const done = part.state === "output-available";
  const errored = part.state === "output-error";
  const active = part.state === "input-streaming" || part.state === "input-available";
  const label = labelFor(part, labels);
  const summary = summaryOf(part);

  const input = part.input as unknown;
  const hasInput = !!input && typeof input === "object" && Object.keys(input).length > 0;
  const errorText = errored ? ((part as { errorText?: string }).errorText ?? "Tool error") : undefined;
  const output = done ? (part.output as unknown) : undefined;
  const hasDetail = hasInput || output !== undefined || !!errorText;

  const Icon = (
    <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
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
  );

  const labelEl = (
    <span className="min-w-0 text-xs">
      <span className="text-ink-primary">{label}</span>
      {summary && <span className="text-ink-tertiary"> · {summary}</span>}
    </span>
  );

  // No args/results to show → a static, non-collapsible row.
  if (!hasDetail) {
    return (
      <div className="text-ink-secondary flex items-start gap-2">
        {Icon}
        {labelEl}
      </div>
    );
  }

  return (
    <Collapsible.Root defaultOpen={false} className="group/step">
      <Collapsible.Trigger className="hover:text-ink-primary flex w-full cursor-pointer items-start gap-2 text-left">
        <span className="relative mt-0.5 flex size-4 shrink-0 items-center justify-center">
          {/* Status icon — hidden on hover/open, replaced by the chevron. */}
          <span className="transition-opacity group-hover/step:opacity-0 group-data-[panel-open]/step:opacity-0">
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
          <ChevronDown className="text-ink-secondary absolute size-4 opacity-0 transition-all group-hover/step:opacity-100 group-data-[panel-open]/step:rotate-180 group-data-[panel-open]/step:opacity-100" />
        </span>
        {labelEl}
      </Collapsible.Trigger>
      <Collapsible.Panel className="border-primary-border mt-1 ml-2 space-y-2 border-l pl-3">
        {hasInput && <Detail label="Input" value={format(input)} />}
        {errorText && <Detail label="Error" value={errorText} tone="error" />}
        {output !== undefined && !errorText && <Detail label="Output" value={format(output)} />}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function Detail({ label, value, tone }: { label: string; value: string; tone?: "error" }) {
  return (
    <div className="space-y-0.5">
      <p className="text-ink-tertiary text-[10px] font-medium tracking-wide uppercase">{label}</p>
      <pre
        className={cn(
          "bg-base text-ink-secondary max-h-48 overflow-auto rounded-md px-2 py-1.5 text-[11px] whitespace-pre-wrap",
          tone === "error" && "text-destructive",
        )}
      >
        {value}
      </pre>
    </div>
  );
}
