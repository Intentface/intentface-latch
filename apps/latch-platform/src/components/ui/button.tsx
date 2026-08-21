import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * Button — intentface-chat's button, extended with the variants this app was
 * authored against.
 *
 * `primary` / `secondary` / `tertiary` / `ghost` / `link` and the `xs…xl` sizes
 * are upstream's, so the ported chat components render exactly as they do there.
 * `default` (accent fill), `outline`, `destructive` and the `icon*` sizes are the
 * platform's own, kept so its pages need no per-call-site edits — `default`
 * stays the accent-filled primary action.
 *
 * Exported both ways: default (upstream's import style, used by
 * `components/ai/*`) and named (this app's pages).
 */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 cursor-pointer items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        primary:
          "border-primary-border bg-primary-bg text-ink-primary hover:border-primary-border-hover hover:bg-primary-bg-hover",
        secondary:
          "border-secondary-border bg-secondary-bg text-ink-primary hover:bg-secondary-bg-hover",
        tertiary:
          "border-tertiary-border bg-tertiary-bg text-ink-primary hover:bg-tertiary-bg-hover",
        ghost: "hover:bg-primary-bg-hover",
        link: "text-ink-primary underline-offset-4 hover:underline",
        // Platform variants.
        default: "bg-accent-bg text-accent-foreground hover:bg-accent-bg-hover",
        accent: "bg-accent-bg text-accent-foreground hover:bg-accent-bg-hover",
        outline:
          "border-primary-border bg-transparent text-ink-primary hover:bg-primary-bg-hover aria-expanded:bg-primary-bg-hover",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
      },
      size: {
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        md: "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        xl: "h-10 gap-2 px-3 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        // Platform sizes.
        default:
          "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-8",
        "icon-xs":
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  render,
  nativeButton,
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      render={render}
      // When rendered as a custom element (e.g. `render={<Link/>}` → an <a>) it
      // isn't a native <button>; tell Base UI so it doesn't warn or apply native
      // button semantics. Plain buttons (no render) stay native.
      nativeButton={nativeButton ?? render === undefined}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export default Button
export { Button, buttonVariants }
