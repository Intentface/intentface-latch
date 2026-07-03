"use client"

import * as React from "react"
import { Select as SelectPrimitive } from "@base-ui/react/select"
import { CheckIcon, ChevronsUpDownIcon } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * A popover (non-native) select built on `@base-ui/react/select`, so each option
 * can carry a `description` line — which a native `<select>`/`<option>` can't.
 * Options-driven; the trigger shows the selected option's label. Use the plain
 * `Select` (native) for simple, label-only lists.
 *
 * The highlighted row fills with the accent; `text-accent-foreground` (kept
 * contrast-correct by <ThemeContrast/>) keeps its text readable.
 */
export interface RichSelectOption {
  value: string
  label: string
  description?: string
}

export function RichSelect({
  value,
  onValueChange,
  options,
  placeholder = "Select…",
  className,
  disabled,
  id,
}: {
  value: string
  onValueChange: (value: string) => void
  options: RichSelectOption[]
  placeholder?: string
  className?: string
  disabled?: boolean
  /** Put on the trigger so a `<label htmlFor>` can focus it. */
  id?: string
}) {
  const items = React.useMemo(
    () => Object.fromEntries(options.map((o) => [o.value, o.label])),
    [options],
  )

  return (
    <SelectPrimitive.Root
      items={items}
      value={value}
      onValueChange={(v) => onValueChange(String(v))}
      disabled={disabled}
    >
      <SelectPrimitive.Trigger
        id={id}
        data-slot="rich-select-trigger"
        className={cn(
          "border-input bg-transparent text-foreground flex h-8 items-center justify-between gap-2 rounded-lg border px-2.5 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30",
          className,
        )}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon className="shrink-0 opacity-60">
          <ChevronsUpDownIcon className="size-3.5" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner className="isolate z-50 outline-none" sideOffset={4}>
          <SelectPrimitive.Popup
            data-slot="rich-select-content"
            className="bg-popover text-popover-foreground z-50 max-h-(--available-height) min-w-(--anchor-width) origin-(--transform-origin) overflow-y-auto rounded-lg p-1 shadow-md ring-1 ring-foreground/10 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
          >
            {options.map((o) => (
              <SelectPrimitive.Item
                key={o.value}
                value={o.value}
                className="group data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground flex cursor-default items-start gap-2 rounded-md px-2 py-1.5 outline-none select-none"
              >
                <span className="min-w-0 flex-1">
                  <SelectPrimitive.ItemText className="block text-sm">
                    {o.label}
                  </SelectPrimitive.ItemText>
                  {o.description && (
                    <span className="text-ink-tertiary group-data-[highlighted]:text-accent-foreground mt-0.5 block text-xs opacity-90">
                      {o.description}
                    </span>
                  )}
                </span>
                <SelectPrimitive.ItemIndicator className="mt-0.5 shrink-0">
                  <CheckIcon className="size-4" />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  )
}
