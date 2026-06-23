import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/utils.js";

const iconButtonVariants = cva(
  "rounded-lg border border-transparent bg-clip-padding font-medium focus-visible:border-accent-border focus-visible:ring-accent/50 focus-visible:ring-3 [&_svg:not([class*='size-'])]:size-4 inline-flex items-center justify-center transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none shrink-0 [&_svg]:shrink-0 outline-none select-none active:scale-x-[0.99] cursor-pointer",
  {
    variants: {
      variant: {
        primary: "bg-primary border-primary-border text-ink-primary hover:bg-primary-hover",
        secondary: "bg-secondary text-ink-primary hover:bg-secondary-hover border-secondary-border",
        tertiary: "bg-tertiary text-ink-primary hover:bg-tertiary-hover border-tertiary-border",
        accent: "bg-accent text-white hover:bg-accent-hover",
        ghost: "hover:bg-primary-hover hover:text-ink-primary",
        link: "text-ink-primary underline-offset-4 hover:underline",
      },
      size: {
        "2xs": "size-4 [&_svg:not([class*='size-'])]:size-2.5",
        xs: "size-6 [&_svg:not([class*='size-'])]:size-3",
        sm: "size-7 [&_svg:not([class*='size-'])]:size-3.5",
        md: "size-8 [&_svg:not([class*='size-'])]:size-4",
        lg: "size-9 [&_svg:not([class*='size-'])]:size-4.5",
        xl: "size-10 [&_svg:not([class*='size-'])]:size-5",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export function IconButton({
  className,
  variant = "primary",
  size = "md",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof iconButtonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="icon-button"
      className={cn(iconButtonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { iconButtonVariants };
