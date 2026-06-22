import type { ReactNode } from "react";
import { StickToBottom } from "use-stick-to-bottom";
import { cn } from "../lib/utils.js";

/**
 * Scrollable message viewport that sticks to the bottom while new content
 * streams in (and lets the user scroll up freely). Render messages as children
 * and dock the composer beneath it.
 */
export function Thread({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <StickToBottom
      className={cn("relative min-h-0 flex-1 overflow-hidden", className)}
      resize="smooth"
      initial="smooth"
    >
      <StickToBottom.Content className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
        {children}
      </StickToBottom.Content>
    </StickToBottom>
  );
}
