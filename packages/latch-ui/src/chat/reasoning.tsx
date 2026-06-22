import { Collapsible } from "@base-ui/react/collapsible";
import { Brain, ChevronDown } from "lucide-react";
import { cn } from "../lib/utils.js";
import { Markdown } from "./markdown.js";

/**
 * Collapsible "reasoning" block. Shows a shimmering "Thinking…" while streaming,
 * else a quiet summary; the panel renders the reasoning text as markdown.
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
  if (!text.trim()) return null;
  return (
    <Collapsible.Root defaultOpen={defaultOpen} className={cn("group/reasoning", className)}>
      <Collapsible.Trigger className="text-ink-secondary hover:text-ink-primary flex items-center gap-1.5 text-xs transition-colors">
        <Brain className="size-3.5" />
        <span className={cn(isStreaming && "animate-pulse")}>
          {isStreaming ? "Thinking…" : "Reasoning"}
        </span>
        <ChevronDown className="size-3.5 transition-transform group-data-[panel-open]/reasoning:rotate-180" />
      </Collapsible.Trigger>
      <Collapsible.Panel className="text-ink-secondary border-primary-border mt-2 border-l-2 pl-3 text-sm">
        <Markdown>{text}</Markdown>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
