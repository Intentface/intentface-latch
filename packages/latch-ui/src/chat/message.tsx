import type { ReactNode } from "react";
import { motion } from "motion/react";
import { cn } from "../lib/utils.js";
import { Markdown } from "./markdown.js";
import { Reasoning } from "./reasoning.js";
import { Steps } from "./steps.js";
import { getSegmentedParts, type ToolLabels, type ToolPart } from "./message-utils.js";
import type { AppUIMessage } from "./types.js";

const stateOf = (p: ToolPart) => (p as { state?: string }).state;

/**
 * Renders one message: user text in a bubble; assistant content segmented into
 * markdown text, a collapsible reasoning block, and a tool-call timeline.
 * Tool parts awaiting a decision (`approval-requested`) are handed to
 * `renderApproval` so the host can wire its own approve/deny / connect UI.
 */
export function Message({
  message,
  isStreaming,
  toolLabels,
  renderApproval,
  className,
}: {
  message: AppUIMessage;
  isStreaming?: boolean;
  toolLabels?: ToolLabels;
  renderApproval?: (part: ToolPart) => ReactNode;
  className?: string;
}) {
  const isUser = message.role === "user";
  const segments = getSegmentedParts(message.parts);

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className={cn("flex", isUser ? "justify-end" : "justify-start", className)}
    >
      <div
        className={cn(
          "min-w-0 space-y-2 text-sm",
          isUser
            ? "bg-primary text-ink-primary max-w-[80%] rounded-2xl px-3.5 py-2"
            : "text-ink-primary w-full",
        )}
      >
        {segments.map((seg, i) => {
          if (seg.type === "text") {
            const text = seg.parts.map((p) => p.text).join("");
            if (!text) return null;
            return isUser ? (
              <span key={i} className="whitespace-pre-wrap">
                {text}
              </span>
            ) : (
              <Markdown key={i}>{text}</Markdown>
            );
          }
          if (seg.type === "reasoning") {
            const text = seg.parts.map((p) => p.text).join("\n\n");
            return (
              <Reasoning key={i} text={text} isStreaming={isStreaming && segments.at(-1) === seg} />
            );
          }
          if (seg.type === "tool") {
            const approvals = renderApproval
              ? seg.parts.filter((p) => stateOf(p) === "approval-requested")
              : [];
            const rest = seg.parts.filter((p) => stateOf(p) !== "approval-requested");
            return (
              <div key={i} className="space-y-2">
                <Steps tools={rest} labels={toolLabels} />
                {approvals.map((p) => (
                  <div key={p.toolCallId}>{renderApproval?.(p)}</div>
                ))}
              </div>
            );
          }
          if (seg.type === "file") {
            return (
              <div key={i} className="text-ink-tertiary text-xs">
                {seg.parts.length} attachment{seg.parts.length === 1 ? "" : "s"}
              </div>
            );
          }
          return null;
        })}
      </div>
    </motion.div>
  );
}
