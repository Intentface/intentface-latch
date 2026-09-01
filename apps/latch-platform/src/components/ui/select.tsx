import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Native `<select>` styled to match {@link Input} (same surface, border,
 * height, radius) so form controls stay visually consistent. Content-width by
 * default — add `w-full` when it should fill its row.
 */
function Select({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="select"
      className={cn(
        "smooth-shadow-ring-xs smooth-ring-primary-border focus-visible:smooth-ring-primary-border-hover h-8 rounded-lg bg-primary-bg px-2.5 text-sm text-ink-primary transition-colors outline-none disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { Select }
