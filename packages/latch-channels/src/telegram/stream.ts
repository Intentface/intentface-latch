import type { RenderEvent } from "../types.js";
import { TelegramApiError, type TelegramClient } from "./api.js";
import { escapeHtml, gfmToTelegramHtml } from "./html.js";

/**
 * The streaming-edit engine: Telegram (unlike Slack) can edit a sent message,
 * so the answer streams as progressive `editMessageText` calls on one message.
 *
 *   sendChatAction("typing") on start.
 *   First text-delta → sendMessage; keep the message_id.
 *   Buffer deltas; flush when ≥`minEditIntervalMs` since the last edit OR
 *   ≥`minEditChars` new chars. On 429, honor `retry_after` and resume.
 *   tool-start folds a status line into the draft; tool-end clears it.
 *   At `maxChars` stop growing, append the truncation notice (one message,
 *   never a spill-over second one), and keep draining events without editing.
 *   finish/error → final flush (status line removed, error appended).
 *
 * Renders HTML (`parse_mode: "HTML"`); if Telegram rejects the entity parse
 * (400), the same content is retried as plain text and the message stays
 * plain for the rest of the turn.
 */

export const MAX_TELEGRAM_TEXT_CHARS = 4000;
export const TELEGRAM_TEXT_TRUNCATION_NOTICE =
  "\n\n_Response truncated for Telegram. The full turn is available in Latch._";

export interface TelegramStreamOptions {
  api: Pick<TelegramClient, "sendMessage" | "editMessageText" | "sendChatAction">;
  chatId: number | string;
  maxChars?: number;
  truncationNotice?: string;
  minEditIntervalMs?: number;
  minEditChars?: number;
  /** Injectable clock/sleep for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface TelegramStreamResult {
  /** The full accumulated answer text (pre-truncation). */
  text: string;
  errorMessage?: string;
  messageId?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function renderTelegramStream(
  events: AsyncIterable<RenderEvent>,
  opts: TelegramStreamOptions,
): Promise<TelegramStreamResult> {
  const maxChars = opts.maxChars ?? MAX_TELEGRAM_TEXT_CHARS;
  const notice = opts.truncationNotice ?? TELEGRAM_TEXT_TRUNCATION_NOTICE;
  const minInterval = opts.minEditIntervalMs ?? 1500;
  const minChars = opts.minEditChars ?? 500;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;

  let text = "";
  let truncated = false;
  let statusLine = "";
  let errorMessage: string | undefined;
  let messageId: number | undefined;
  let lastSent = "";
  let lastFlushAt = 0;
  let charsSinceFlush = 0;
  let plainFallback = false;

  function compose(final: boolean): { html: string; plain: string } {
    let body = truncated ? text.slice(0, maxChars) + notice : text;
    if (!final && statusLine) body += `\n\n⏳ ${statusLine}`;
    if (final && errorMessage) body += `${body ? "\n\n" : ""}⚠️ ${errorMessage.slice(0, 500)}`;
    return { html: gfmToTelegramHtml(body), plain: body };
  }

  async function send(content: { html: string; plain: string }): Promise<void> {
    const attempt = async () => {
      const input = plainFallback
        ? { chat_id: opts.chatId, text: content.plain }
        : {
            chat_id: opts.chatId,
            text: content.html,
            parse_mode: "HTML" as const,
            link_preview_options: { is_disabled: true },
          };
      if (messageId === undefined) {
        messageId = (await opts.api.sendMessage(input)).messageId;
      } else {
        await opts.api.editMessageText({ ...input, message_id: messageId });
      }
    };
    try {
      await attempt();
    } catch (e) {
      if (e instanceof TelegramApiError && e.status === 429) {
        await sleep((e.retryAfter ?? 3) * 1000);
        await attempt();
      } else if (e instanceof TelegramApiError && e.status === 400 && !plainFallback) {
        // Almost always an entity-parse failure on partial markdown → go plain.
        plainFallback = true;
        await attempt();
      } else {
        throw e;
      }
    }
  }

  async function flush(final: boolean): Promise<void> {
    const content = compose(final);
    const key = plainFallback ? content.plain : content.html;
    if (!key.trim() || key === lastSent) return;
    try {
      await send(content);
      lastSent = plainFallback ? content.plain : content.html;
      lastFlushAt = now();
      charsSinceFlush = 0;
    } catch (e) {
      if (final) throw e;
      console.error("[telegram] stream flush failed (will retry on next flush):", e);
    }
  }

  await opts.api.sendChatAction(opts.chatId, "typing");

  for await (const ev of events) {
    switch (ev.type) {
      case "text-delta":
        if (!truncated) {
          text += ev.text;
          charsSinceFlush += ev.text.length;
          if (text.length > maxChars) truncated = true;
        } else {
          text += ev.text; // keep accumulating for the caller; stop editing
          continue;
        }
        break;
      case "tool-start":
        statusLine = `Running ${ev.toolName}…`;
        charsSinceFlush += minChars; // status changes flush on the next check
        break;
      case "tool-end":
        statusLine = "";
        charsSinceFlush += minChars;
        break;
      case "error":
        errorMessage = ev.message;
        continue;
      default:
        continue;
    }
    const due = now() - lastFlushAt >= minInterval || charsSinceFlush >= minChars;
    // Create the message promptly on first content; then throttle edits.
    if ((messageId === undefined && text.trim()) || (messageId !== undefined && due)) {
      await flush(false);
    }
  }

  statusLine = "";
  await flush(true);
  const result: TelegramStreamResult = { text };
  if (errorMessage !== undefined) result.errorMessage = errorMessage;
  if (messageId !== undefined) result.messageId = messageId;
  return result;
}

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
