/**
 * @intentface/latch-channels/telegram
 *
 * Bring a Latch agent to Telegram DMs: per-bot webhook handling (secret-token
 * verified), streaming answers via progressive message edits, inline-keyboard
 * approvals, and media → multimodal file parts. Pure protocol translation —
 * identity, credentials and dedupe are injected by the host.
 */
export {
  telegramApi,
  TelegramApiError,
  type TelegramApiOptions,
  type TelegramBotInfo,
  type TelegramClient,
  type TelegramToken,
  type TelegramWebhookInfo,
  type InlineKeyboardButton,
} from "./api.js";
export { verifyTelegramSecretToken } from "./verify.js";
export { escapeHtml, gfmToTelegramHtml } from "./html.js";
export {
  MAX_TELEGRAM_TEXT_CHARS,
  TELEGRAM_TEXT_TRUNCATION_NOTICE,
  approvalPromptHtml,
  renderTelegramStream,
  type TelegramStreamOptions,
  type TelegramStreamResult,
} from "./stream.js";
export {
  telegramChannel,
  encodeApprovalCallback,
  decodeApprovalCallback,
  type TelegramAuthResult,
  type TelegramChannelConfig,
  type TgFileRef,
} from "./telegramChannel.js";
