import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type Kind = "passed" | "restored" | "built";

const KIND: Record<Kind, { label: string; className: string }> = {
  // Something your code sends.
  passed: { label: "You pass it", className: "bg-accent-bg/10 text-accent-bg dark:bg-accent-bg/15" },
  // Saved earlier, read back by Latch.
  restored: { label: "Latch restores it", className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
  // Made again by your function.
  built: { label: "Rebuilt", className: "bg-ink-primary/6 text-ink-secondary" },
};

type Cell = { kind: Kind; note: ReactNode };

const MOMENTS = [
  { title: "First message", when: "10:00, in the browser" },
  { title: "Approved in Slack", when: "the next day" },
  { title: "Server crashed", when: "another server finishes" },
  { title: "Next message", when: "in the same chat" },
];

const ROWS: { input: ReactNode; question: string; cells: Cell[] }[] = [
  {
    input: <code>principal</code>,
    question: "Who is asking",
    cells: [
      { kind: "passed", note: "from your login" },
      { kind: "restored", note: "re-checked first" },
      { kind: "restored", note: "re-checked first" },
      { kind: "passed", note: "from your login" },
    ],
  },
  {
    input: <code>context</code>,
    question: "What they can work with",
    cells: [
      { kind: "built", note: "from the principal" },
      { kind: "built", note: "current plan, roles" },
      { kind: "built", note: "current plan, roles" },
      { kind: "built", note: "from the principal" },
    ],
  },
  {
    input: <code>params</code>,
    question: "What the chat is about",
    cells: [
      { kind: "passed", note: "saved on the chat" },
      { kind: "restored", note: "from the chat" },
      { kind: "restored", note: "from the chat" },
      { kind: "restored", note: "not sent again" },
    ],
  },
  {
    input: <code>data-context</code>,
    question: "What they're looking at",
    cells: [
      { kind: "passed", note: "on the message" },
      { kind: "restored", note: "same message, same values" },
      { kind: "restored", note: "same message, same values" },
      { kind: "passed", note: "the new message's own" },
    ],
  },
];

/**
 * One answer's life, and what each input does at every point: who supplies it
 * on the first message, and how Latch gets it back when the answer continues
 * without your code (an approval from Slack, crash recovery).
 */
export const InputsTimeline = () => (
  <figure className="not-prose my-6">
    <div className="overflow-x-auto rounded-xl bg-table-tray p-[5px] shadow-card">
      <table className="w-full min-w-[640px] border-separate border-spacing-0 text-sm">
        <thead>
          <tr>
            <th className="w-[22%] px-3 pb-[5px] text-left align-bottom font-medium text-ink-secondary text-xs">Input</th>
            {MOMENTS.map((m, i) => (
              <th key={m.title} className="px-3 pb-[5px] text-left align-bottom font-medium text-xs">
                <span className="flex items-center gap-1.5 text-ink-primary">
                  <span className="grid size-4 shrink-0 place-items-center rounded-full bg-ink-primary/8 font-mono text-[10px] text-ink-secondary">
                    {i + 1}
                  </span>
                  {m.title}
                </span>
                <span className="mt-0.5 block font-normal text-ink-tertiary">{m.when}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row, r) => (
            <tr key={r}>
              <td
                className={cn(
                  "bg-table-panel px-3 py-3 align-top",
                  "border-black/6 border-l dark:border-white/7",
                  r === 0 ? "rounded-tl-md border-t" : "border-t border-t-ink-primary/6",
                  r === ROWS.length - 1 && "rounded-bl-md border-b",
                )}
              >
                <span className="block font-medium text-ink-primary [&_code]:font-mono [&_code]:text-[13px]">{row.input}</span>
                <span className="mt-0.5 block text-ink-secondary text-xs">{row.question}</span>
              </td>
              {row.cells.map((cell, c) => (
                <td
                  key={c}
                  className={cn(
                    "bg-table-panel px-3 py-3 align-top",
                    "border-black/6 dark:border-white/7",
                    c === row.cells.length - 1 && "border-r",
                    r === 0 ? "border-t" : "border-t border-t-ink-primary/6",
                    r === ROWS.length - 1 && "border-b",
                    r === 0 && c === row.cells.length - 1 && "rounded-tr-md",
                    r === ROWS.length - 1 && c === row.cells.length - 1 && "rounded-br-md",
                  )}
                >
                  <span className={cn("inline-flex h-5 items-center rounded-[5px] px-1.5 font-medium text-2xs", KIND[cell.kind].className)}>
                    {KIND[cell.kind].label}
                  </span>
                  <span className="mt-1 block text-ink-body text-xs leading-4">{cell.note}</span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    <figcaption className="mt-2.5 text-ink-secondary text-sm">
      Your code supplies inputs only on new messages. In moments 2 and 3 nothing of yours runs except your{" "}
      <code className="rounded-[4px] bg-ink-primary/6 px-1 font-mono text-[0.85em]">context</code> function, so
      everything else has to come from what Latch saved.
    </figcaption>
  </figure>
);
