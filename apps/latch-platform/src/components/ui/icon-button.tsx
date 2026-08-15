import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const iconButtonVariants = cva(
  "group/button inline-flex shrink-0 cursor-pointer items-center justify-center rounded-lg border border-transparent bg-clip-padding font-medium transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-x-[0.99] disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        primary:
          "border-primary-border bg-primary-bg text-ink-secondary hover:border-primary-border-hover hover:bg-primary-bg-hover hover:text-ink-primary",
        secondary:
          "border-secondary-border bg-secondary-bg text-ink-secondary hover:border-secondary-border-hover hover:bg-secondary-bg-hover hover:text-ink-primary",
        tertiary:
          "border-tertiary-border bg-tertiary-bg text-ink-secondary hover:border-tertiary-border-hover hover:bg-tertiary-bg-hover hover:text-ink-primary",
        accent: "bg-accent-bg text-white hover:bg-accent-bg-hover",
        ghost:
          "text-ink-secondary hover:bg-primary-bg-hover hover:text-ink-primary aria-expanded:bg-muted aria-expanded:text-foreground",
        link: "text-primary-bg underline-offset-4 hover:underline",
      },
      size: {
        "2xs":
          "size-4 rounded-[min(var(--radius-md),8px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-2.5",
        xs: "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        sm: "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3.5",
        md: "size-8 [&_svg:not([class*='size-'])]:size-4",
        lg: "size-9 [&_svg:not([class*='size-'])]:size-4.5",
        xl: "size-10 [&_svg:not([class*='size-'])]:size-5",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  }
)

function IconButton({
  className,
  variant = "primary",
  size = "md",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof iconButtonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(iconButtonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { IconButton, iconButtonVariants }
