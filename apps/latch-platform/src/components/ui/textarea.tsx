import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "smooth-shadow-ring-xs smooth-ring-primary-border focus-visible:smooth-ring-primary-border-hover flex field-sizing-content min-h-16 w-full rounded-lg bg-primary-bg px-2.5 py-2 text-[1rem] text-ink-primary transition-colors outline-none placeholder:text-ink-tertiary disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:smooth-ring-destructive md:text-sm",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
