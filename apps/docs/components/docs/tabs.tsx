"use client";

import { Children, isValidElement, type ReactNode, useId, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Tabbed content, picked with the same pill switch as the site header. Each
 * `<Tab value>` is one panel; `items` sets the order and the labels.
 */
export const Tabs = ({ items, children }: { items: string[]; children: ReactNode }) => {
  const [active, setActive] = useState(items[0]);
  const id = useId();
  const panels = Children.toArray(children).filter(isValidElement<{ value?: string }>);

  return (
    <div className="my-6">
      <div role="tablist" className="flex w-fit max-w-full gap-0.5 overflow-x-auto rounded-full bg-ink-primary/5 p-0.5">
        {items.map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            id={`${id}-${item}`}
            aria-selected={item === active}
            onClick={() => setActive(item)}
            className={cn(
              "h-7 shrink-0 cursor-pointer rounded-full px-3 font-medium text-sm transition-[color,background-color,box-shadow]",
              "focus-visible:outline-2 focus-visible:outline-accent-bg/60 focus-visible:outline-offset-1",
              item === active
                ? "bg-raised text-ink-primary shadow-raised"
                : "text-ink-secondary hover:text-ink-primary",
            )}
          >
            {item}
          </button>
        ))}
      </div>
      {panels.map((panel) => (
        <div
          key={panel.props.value}
          role="tabpanel"
          aria-labelledby={`${id}-${panel.props.value}`}
          hidden={panel.props.value !== active}
          className="mt-3 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
        >
          {panel}
        </div>
      ))}
    </div>
  );
};

/** One panel of {@link Tabs}. */
export const Tab = ({ children }: { value: string; children: ReactNode }) => <>{children}</>;
