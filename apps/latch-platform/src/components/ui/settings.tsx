import type { ComponentProps } from "react"
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"

import { ChevronRightMediumIcon } from "@/components/icons/chevron-right-medium"
import { cn } from "@/lib/utils"

const SettingsRoot = ({
  className,
  children,
  ...props
}: ComponentProps<"section">) => (
  <section
    data-slot="settings"
    className={cn("flex flex-col gap-2", className)}
    {...props}
  >
    {children}
  </section>
)

const SettingsHeader = ({
  className,
  children,
  ...props
}: ComponentProps<"div">) => (
  <div
    data-slot="settings-header"
    className={cn("flex items-center justify-between gap-4 pl-2.5", className)}
    {...props}
  >
    {children}
  </div>
)

const SettingsHeading = ({
  className,
  children,
  ...props
}: ComponentProps<"div">) => (
  <div
    data-slot="settings-heading"
    className={cn("flex min-w-0 flex-col gap-0.5", className)}
    {...props}
  >
    {children}
  </div>
)

const SettingsTitle = ({
  className,
  children,
  ...props
}: ComponentProps<"h2">) => (
  <h2
    data-slot="settings-title"
    className={cn("text-md font-medium text-ink-primary", className)}
    {...props}
  >
    {children}
  </h2>
)

const SettingsSubtitle = ({
  className,
  children,
  ...props
}: ComponentProps<"p">) => (
  <p
    data-slot="settings-subtitle"
    className={cn("text-sm text-ink-secondary", className)}
    {...props}
  >
    {children}
  </p>
)

const SettingsCard = ({
  className,
  children,
  ...props
}: ComponentProps<"div">) => (
  <div
    data-slot="settings-card"
    className={cn(
      "smooth-shadow-ring-xs smooth-ring-primary-border flex flex-col overflow-hidden rounded-lg bg-primary-bg",
      className
    )}
    {...props}
  >
    {children}
  </div>
)

const SettingsRow = ({
  className,
  render,
  ...props
}: useRender.ComponentProps<"div">) =>
  useRender({
    defaultTagName: "div",
    render,
    props: mergeProps<"div">(
      {
        className: cn(
          "flex min-h-14 items-center gap-3 border-b border-primary-border p-3 text-left outline-none last-of-type:border-0",
          "[&:is(a,button)]:w-full [&:is(a,button)]:cursor-pointer [&:is(a,button)]:transition-colors",
          "hover:[&:is(a,button)]:bg-primary-bg-hover",
          "focus-visible:ring-1 focus-visible:ring-inset",
          className
        ),
      },
      props
    ),
  })

/** Leading icon tile — 32px, so tile + row padding = the row's min height. */
const SettingsIcon = ({
  className,
  children,
  ...props
}: ComponentProps<"div">) => (
  <div
    data-slot="settings-icon"
    className={cn(
      "flex size-8 shrink-0 items-center justify-center rounded-md bg-tertiary-bg text-ink-secondary [&>img]:size-4 [&>svg]:size-4",
      className
    )}
    {...props}
  >
    {children}
  </div>
)

const SettingsLabel = ({
  className,
  children,
  ...props
}: ComponentProps<"span">) => (
  <span
    data-slot="settings-label"
    className={cn("text-sm text-ink-primary", className)}
    {...props}
  >
    {children}
  </span>
)

const SettingsDescription = ({
  className,
  children,
  ...props
}: ComponentProps<"span">) => (
  <span
    data-slot="settings-description"
    className={cn("text-xs text-ink-secondary", className)}
    {...props}
  >
    {children}
  </span>
)

const SettingsLabelGroup = ({
  className,
  children,
  ...props
}: ComponentProps<"div">) => (
  <div
    data-slot="settings-label-group"
    className={cn("flex min-w-0 flex-1 flex-col gap-0.5", className)}
    {...props}
  >
    {children}
  </div>
)

const SettingsControl = ({
  className,
  children,
  ...props
}: ComponentProps<"div">) => (
  <div
    data-slot="settings-control"
    className={cn("flex w-60 justify-end", className)}
    {...props}
  >
    {children}
  </div>
)

/** Lightweight inline summary (row counts, "Nothing scheduled"). */
const SettingsSummary = ({
  className,
  children,
  ...props
}: ComponentProps<"span">) => (
  <span
    data-slot="settings-summary"
    className={cn("text-sm text-ink-secondary", className)}
    {...props}
  >
    {children}
  </span>
)

/** Trailing status text (next-run countdown, scope, counts). */
const SettingsValue = ({
  className,
  children,
  ...props
}: ComponentProps<"span">) => (
  <span
    data-slot="settings-value"
    className={cn("shrink-0 text-sm text-ink-secondary", className)}
    {...props}
  >
    {children}
  </span>
)

const SettingsChevron = ({ className, ...props }: ComponentProps<"svg">) => (
  <ChevronRightMediumIcon
    data-slot="settings-chevron"
    className={cn(
      "size-4 shrink-0 text-ink-tertiary transition-transform",
      className
    )}
    {...props}
  />
)

export const Settings = Object.assign(SettingsRoot, {
  Header: SettingsHeader,
  Heading: SettingsHeading,
  Title: SettingsTitle,
  Subtitle: SettingsSubtitle,
  Card: SettingsCard,
  Row: SettingsRow,
  Icon: SettingsIcon,
  LabelGroup: SettingsLabelGroup,
  Label: SettingsLabel,
  Summary: SettingsSummary,
  Value: SettingsValue,
  Description: SettingsDescription,
  Control: SettingsControl,
  Chevron: SettingsChevron,
})
