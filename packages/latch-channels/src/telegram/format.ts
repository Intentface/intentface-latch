import { escapeHtml } from "./html.js";

/**
 * Telegram HTML for the cards the kernel asks the surface to post — approval
 * prompts, questionnaire questions and their answered receipts.
 */

/** Compose the approval-prompt text (HTML) for a tool awaiting approval. */
export function approvalPromptHtml(toolName: string, input: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(input, null, 2) ?? String(input);
  } catch {
    json = String(input);
  }
  if (json.length > 2500) json = `${json.slice(0, 2500)}\n… (truncated)`;
  return `🔒 Approve <b>${escapeHtml(toolName)}</b>?\n\n<pre>${escapeHtml(json)}</pre>`;
}

/** Longest option label Telegram renders comfortably on a button. */
const MAX_BUTTON_LABEL = 40;

/** Button caption for an option — ticked marker for multi-select, length-capped. */
export function optionButtonText(label: string, ticked?: boolean): string {
  const short =
    label.length > MAX_BUTTON_LABEL ? `${label.slice(0, MAX_BUTTON_LABEL - 1)}…` : label;
  return ticked === undefined ? short : `${ticked ? "✓ " : "　"}${short}`;
}

/**
 * Compose one question of a questionnaire (HTML). Option *labels* go on the
 * buttons; the descriptions only fit in the body, numbered so a typed "2" is an
 * unambiguous answer.
 */
export function questionPromptHtml(
  question: { question: string; header?: string; options: { label: string; description: string }[] },
  index: number,
  total: number,
): string {
  const head = total > 1 ? `<b>Question ${index + 1} of ${total}</b>\n` : "";
  const title = question.header
    ? `<i>${escapeHtml(question.header)}</i>\n${escapeHtml(question.question)}`
    : escapeHtml(question.question);
  const opts = question.options
    .map((o, i) => {
      const desc = o.description ? ` — ${escapeHtml(o.description)}` : "";
      return `${i + 1}. <b>${escapeHtml(o.label)}</b>${desc}`;
    })
    .join("\n");
  return `${head}${title}\n\n${opts}`;
}

/** Collapse an answered question card to a one-line receipt. */
export function answeredQuestionHtml(question: string, answer: string): string {
  return `✓ ${escapeHtml(question)}\n<b>${escapeHtml(answer)}</b>`;
}

/** Plain-text twin of a Telegram HTML card, for the entity-parse fallback. */
export function htmlToPlain(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
