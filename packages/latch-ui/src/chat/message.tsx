import { type ReactNode, useState } from "react";
import { Collapsible } from "@base-ui/react/collapsible";
import { motion } from "motion/react";
import { Check, ChevronDown, CircleHelp, Copy, FileText, RotateCcw } from "lucide-react";
import { cn } from "../lib/utils.js";
import { Markdown } from "./markdown.js";
import { Reasoning } from "./reasoning.js";
import { Steps } from "./steps.js";
import {
  getAskUserInfo,
  getSegmentedParts,
  getSourcesInfo,
  getTextInfo,
  type ToolLabels,
  type ToolPart,
} from "./message-utils.js";
import type { AppUIMessage } from "./types.js";

const stateOf = (p: ToolPart) => (p as { state?: string }).state;
const isSpawnAgent = (p: ToolPart) => p.type === "tool-spawn_agent";

/**
 * Renders one message, styled after intentface-chat: user text in a bordered
 * bubble; assistant content segmented into markdown text, a collapsible
 * reasoning block, and a tool-call timeline, followed by source pills and a
 * hover copy action. Tool parts awaiting a decision (`approval-requested`) are
 * handed to `renderApproval` so the host can wire approve/deny / connect UI.
 */
export function Message({
  message,
  isStreaming,
  toolLabels,
  renderApproval,
  renderSubagent,
  onRegenerate,
  className,
}: {
  message: AppUIMessage;
  isStreaming?: boolean;
  toolLabels?: ToolLabels;
  renderApproval?: (part: ToolPart) => ReactNode;
  /** Render a `spawn_agent` tool call (e.g. an expandable subagent thread). */
  renderSubagent?: (part: ToolPart) => ReactNode;
  /** Called when the user clicks the regenerate action (assistant messages). */
  onRegenerate?: () => void;
  className?: string;
}) {
  const isUser = message.role === "user";
  const segments = getSegmentedParts(message.parts);
  const { sources, hasSources } = getSourcesInfo(message.parts);
  const { text: copyText } = getTextInfo(segments);
  const { answered } = getAskUserInfo(message.parts);

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className={cn("group flex w-full flex-col gap-1.5", isUser ? "items-end" : "items-start", className)}
    >
      <div
        className={cn(
          "text-md min-w-0",
          isUser
            ? "border-primary-border bg-primary text-ink-primary flex max-w-[80%] flex-col gap-2 rounded-[20px] border px-3 py-1.5 shadow-xs"
            : "text-ink-primary flex w-full flex-col gap-4",
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
            const spawns = renderSubagent ? seg.parts.filter(isSpawnAgent) : [];
            const rest = seg.parts.filter(
              (p) => stateOf(p) !== "approval-requested" && !(renderSubagent && isSpawnAgent(p)),
            );
            return (
              <div key={i} className="space-y-2">
                <Steps tools={rest} labels={toolLabels} />
                {spawns.map((p) => (
                  <div key={p.toolCallId}>{renderSubagent?.(p)}</div>
                ))}
                {approvals.map((p) => (
                  <div key={p.toolCallId}>{renderApproval?.(p)}</div>
                ))}
              </div>
            );
          }
          if (seg.type === "file") {
            return (
              <div key={i} className="flex flex-wrap gap-2">
                {seg.parts.map((p, j) =>
                  p.mediaType?.startsWith("image/") ? (
                    <a
                      key={j}
                      href={p.url}
                      target="_blank"
                      rel="noreferrer"
                      className="border-primary-border block overflow-hidden rounded-lg border"
                    >
                      <img
                        src={p.url}
                        alt={p.filename ?? "attachment"}
                        className="max-h-48 max-w-full object-cover"
                      />
                    </a>
                  ) : (
                    <a
                      key={j}
                      href={p.url}
                      target="_blank"
                      rel="noreferrer"
                      className="border-primary-border bg-base text-ink-secondary hover:text-ink-primary flex items-center gap-2 rounded-lg border px-2.5 py-2 text-xs transition-colors"
                    >
                      <FileText className="size-4 shrink-0" />
                      <span className="max-w-40 truncate">{p.filename ?? "file"}</span>
                    </a>
                  ),
                )}
              </div>
            );
          }
          return null;
        })}
      </div>

      {!isUser &&
        answered.map((a) => (
          <Collapsible.Root key={a.toolCallId} className="group/ask w-full">
            <Collapsible.Trigger className="text-ink-secondary hover:text-ink-primary flex items-center gap-1.5 text-xs transition-colors">
              <CircleHelp className="size-3.5 shrink-0" />
              <span>
                Answered {a.questions.length} {a.questions.length === 1 ? "question" : "questions"}
              </span>
              <ChevronDown className="size-3.5 shrink-0 transition-transform group-data-[panel-open]/ask:rotate-180" />
            </Collapsible.Trigger>
            <Collapsible.Panel className="border-primary-border mt-2 flex flex-col gap-2 border-l-2 pl-3">
              {a.questions.map((q) => (
                <div key={q.question} className="flex flex-col gap-0.5">
                  <span className="text-ink-primary text-xs font-medium">{q.question}</span>
                  <span className="text-ink-secondary text-xs">{a.answers[q.question] ?? "—"}</span>
                </div>
              ))}
            </Collapsible.Panel>
          </Collapsible.Root>
        ))}

      {!isUser && hasSources && (
        <div className="flex flex-wrap gap-1.5">
          {sources.map((s) => (
            <a
              key={s.domain}
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              className="border-primary-border bg-primary text-ink-secondary hover:bg-primary-hover inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors"
            >
              <img
                src={`https://www.google.com/s2/favicons?domain=${s.domain}&sz=16`}
                alt=""
                width={14}
                height={14}
                className="shrink-0"
              />
              {s.domain}
            </a>
          ))}
        </div>
      )}

      {!isUser && !isStreaming && (copyText || onRegenerate) && (
        <div className="pointer-events-none flex items-center gap-1 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
          {copyText && <CopyButton text={copyText} />}
          {onRegenerate && (
            <button
              type="button"
              aria-label="Regenerate"
              onClick={onRegenerate}
              className="text-ink-tertiary hover:text-ink-primary hover:bg-primary-hover grid size-7 place-items-center rounded-md transition-colors"
            >
              <RotateCcw className="size-3.5" />
            </button>
          )}
        </div>
      )}
    </motion.div>
  );
}

/** Ghost icon button that copies `text` and briefly shows a check. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : "Copy"}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="text-ink-tertiary hover:text-ink-primary hover:bg-primary-hover grid size-7 place-items-center rounded-md transition-colors"
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
}
