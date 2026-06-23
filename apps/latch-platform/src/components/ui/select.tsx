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
        "border-input bg-transparent text-foreground h-8 rounded-lg border px-2.5 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30",
        className
      )}
      {...props}
    />
  )
}

export { Select }
