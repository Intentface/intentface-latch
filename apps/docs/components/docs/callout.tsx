import { Info, TriangleAlert } from "@keyline-icons/react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A note set apart from the text: the tray-and-panel frame the reference
 * tables use, with a title in the tray. `warn` marks a limit or a trap.
 */
export const Callout = ({
  title,
  type = "info",
  children,
}: {
  title?: ReactNode;
  type?: "info" | "warn";
  children: ReactNode;
}) => {
  const Icon = type === "warn" ? TriangleAlert : Info;
  return (
    <aside className="not-prose my-6 rounded-xl bg-table-tray p-[5px] shadow-card">
      <div className="flex h-[31px] items-center gap-2 px-3 pb-[5px]">
        <Icon
          aria-hidden
          className={cn("size-3.5 shrink-0", type === "warn" ? "text-amber-600 dark:text-amber-400" : "text-accent-bg")}
        />
        <span className="font-medium text-ink-primary text-xs">{title ?? (type === "warn" ? "Note" : "Good to know")}</span>
      </div>
      <div
        className={cn(
          "rounded-md bg-table-panel px-4 py-3 text-ink-body text-md leading-[22px]",
          "shadow-[0_0_0_1px_rgb(0_0_0/0.06),0_1px_2px_rgb(0_0_0/0.04)] dark:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.07)]",
          "[&>p]:my-0 [&>p+p]:mt-2 [&_p]:text-md [&_p]:leading-[22px] [&_ul]:my-2 [&_li]:text-md",
        )}
      >
        {children}
      </div>
    </aside>
  );
};
