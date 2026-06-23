import type { ElementType, HTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/utils.js";

export type TextShimmerProps = {
  as?: string;
  duration?: number;
  spread?: number;
  children: ReactNode;
} & HTMLAttributes<HTMLElement>;

/**
 * Animated gradient sweep over text — used for "active" labels (a step the
 * agent is currently working on). The `shimmer` keyframe lives in theme.css.
 */
export function TextShimmer({
  as = "span",
  className,
  duration = 4,
  spread = 20,
  children,
  ...props
}: TextShimmerProps) {
  const dynamicSpread = Math.min(Math.max(spread, 5), 45);
  const Component = as as ElementType;

  return (
    <Component
      className={cn("bg-size-[200%_auto] bg-clip-text font-medium text-transparent", className)}
      style={{
        backgroundImage: `linear-gradient(to right, var(--color-ink-secondary) ${50 - dynamicSpread}%, var(--color-ink-primary) 50%, var(--color-ink-secondary) ${50 + dynamicSpread}%)`,
        animation: `shimmer ${duration}s infinite linear`,
      }}
      {...props}
    >
      {children}
    </Component>
  );
}
