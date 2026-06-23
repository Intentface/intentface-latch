import { Collapsible } from "@base-ui/react/collapsible";
import { Brain, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils.js";
import { Markdown } from "./markdown.js";
import { TextShimmer } from "./text-shimmer.js";

/** Last bold header in the reasoning text (e.g. **Analyzing the data**). */
const lastHeader = (text: string): string | undefined =>
  text
    .match(/\*\*(.+?)\*\*/g)
    ?.map((h) => h.replace(/\*\*/g, ""))
    .at(-1);

/**
 * Collapsible "reasoning" block, styled after intentface-chat. While streaming
 * it shimmers the current section header (or "Thinking…") and tracks elapsed
 * time; once done it shows "Thought for Ns". The panel renders the reasoning
 * text as markdown.
 */
export function Reasoning({
  text,
  isStreaming,
  defaultOpen,
  className,
}: {
  text: string;
  isStreaming?: boolean;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [duration, setDuration] = useState<number>();
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    if (isStreaming) {
      if (startRef.current === null) startRef.current = Date.now();
    } else if (startRef.current !== null) {
      setDuration(Math.max(1, Math.ceil((Date.now() - startRef.current) / 1000)));
      startRef.current = null;
    }
  }, [isStreaming]);

  if (!text.trim()) return null;

  const label = isStreaming ? (
    <TextShimmer>{lastHeader(text) ?? "Thinking…"}</TextShimmer>
  ) : (
    <span>{duration ? `Thought for ${duration}s` : "Reasoning"}</span>
  );

  return (
    <Collapsible.Root defaultOpen={defaultOpen} className={cn("group/reasoning", className)}>
      <Collapsible.Trigger className="text-ink-secondary hover:text-ink-primary flex items-center gap-1.5 text-xs transition-colors">
        <Brain className="size-3.5 shrink-0" />
        {label}
        <ChevronDown className="size-3.5 shrink-0 transition-transform group-data-[panel-open]/reasoning:rotate-180" />
      </Collapsible.Trigger>
      <Collapsible.Panel className="text-ink-secondary border-primary-border mt-2 border-l-2 pl-3 text-sm">
        <Markdown>{text}</Markdown>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
