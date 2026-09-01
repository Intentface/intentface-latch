import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "smooth-shadow-ring-xs smooth-ring-primary-border focus-visible:smooth-ring-primary-border-hover h-8 w-full min-w-0 rounded-lg bg-primary-bg px-2.5 py-1 text-[1rem] text-ink-primary transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-ink-tertiary disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:smooth-ring-destructive md:text-sm",
        className
      )}
      {...props}
    />
  )
}

export { Input }

export default Input
