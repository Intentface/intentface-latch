"use client";

import { ChevronDown } from "@keyline-icons/react";
import { motion } from "motion/react";
import { type ReactNode, useState } from "react";
import { cn } from "@/lib/utils";
import { ReferenceTable } from "./reference-table";

/** One entry as `remarkAutoTypeTable` emits it (see source.config.ts). */
type TypeEntry = {
  type: ReactNode;
  typeDescription?: ReactNode;
  description?: ReactNode;
  default?: ReactNode;
  required?: boolean;
  deprecated?: boolean;
};

type PropRow = TypeEntry & { name: string };

// Generated option reference (`<auto-type-table>`), in the props-table frame.
// Rows are collapsible: collapsed shows the option, its type (truncated) and
// default; expanding reveals the description and the full type.
export const TypeTable = ({ type }: { type: Record<string, TypeEntry> }) => (
  <ReferenceTable
    columns={[
      { label: "Option", width: "w-[30%]" },
      { label: "Type" },
      { label: "Default", width: "w-[22%]" },
      { label: "Details", width: "w-10", srOnly: true },
    ]}
  >
    {Object.entries(type).map(([name, entry]) => (
      <PropsRow key={name} row={{ name, ...entry }} />
    ))}
  </ReferenceTable>
);

const PropsRow = ({ row }: { row: PropRow }) => {
  const [open, setOpen] = useState(false);

  return (
    <>
      <tr
        className={cn(
          "cursor-pointer transition-colors",
          open ? "bg-table-tray" : "hover:bg-ink-primary/[0.02]",
        )}
        onClick={() => setOpen((current) => !current)}
      >
        <td className="truncate px-4 py-3.5 align-middle">
          <code className="font-medium font-mono text-ink-primary text-sm">
            {row.name}
            {row.required ? null : <span className="text-ink-tertiary">?</span>}
          </code>
        </td>
        <td className="truncate px-4 py-3.5 align-middle">
          <TypeChip>{row.type}</TypeChip>
        </td>
        <td className="truncate px-4 py-3.5 align-middle">
          {row.default ? (
            <code className="font-mono text-ink-secondary text-xs">{row.default}</code>
          ) : (
            <span className="text-ink-tertiary text-xs">—</span>
          )}
        </td>
        <td className="py-3.5 pr-3 align-middle">
          <button
            type="button"
            aria-label={open ? "Collapse" : "Expand"}
            aria-expanded={open}
            className="grid size-6 cursor-pointer place-items-center rounded-full focus-visible:outline-2 focus-visible:outline-accent-bg/60"
            onClick={(event) => {
              event.stopPropagation();
              setOpen((current) => !current);
            }}
          >
            <ChevronDown
              className={cn(
                "size-3.5 transition-transform",
                open ? "rotate-180 text-ink-primary" : "text-ink-tertiary",
              )}
            />
          </button>
        </td>
      </tr>
      <tr
        aria-hidden={!open}
        // The rule between rows sits on this row, so the last one can drop it.
        className={cn("border-ink-primary/6 border-b last:border-0", open && "bg-table-tray")}
      >
        <td colSpan={4} className="p-0">
          <motion.div
            initial={false}
            animate={{ height: open ? "auto" : 0 }}
            transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
            className="overflow-hidden"
          >
            <div className="flex max-w-[560px] flex-col gap-2.5 px-4 pb-4">
              {row.description && (
                <div className="text-ink-body text-sm leading-5 [&_p]:my-0 [&_p]:text-sm [&_p]:leading-5 [&_li]:text-sm [&_li]:leading-5 [&_a]:text-accent-bg [&_a]:underline [&_a]:decoration-accent-bg/30 [&_a]:underline-offset-4 [&_code]:rounded-[4px] [&_code]:bg-ink-primary/6 [&_code]:px-1 [&_code]:py-px [&_code]:font-mono [&_code]:text-[0.9em] [&_code]:text-ink-primary [&_p+p]:mt-2 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:whitespace-pre [&_ul]:my-1.5 [&_ul]:ml-4 [&_ul]:list-disc">
                  {row.description}
                </div>
              )}
              <TypeChip className="w-fit max-w-full overflow-x-auto whitespace-pre-wrap">
                {row.typeDescription ?? row.type}
              </TypeChip>
            </div>
          </motion.div>
        </td>
      </tr>
    </>
  );
};

const TypeChip = ({ className, children }: { className?: string; children: ReactNode }) => (
  <code
    className={cn(
      "rounded-[4px] bg-ink-primary/6 px-1.5 py-0.5 font-mono text-ink-body text-xs",
      className,
    )}
  >
    {children}
  </code>
);
