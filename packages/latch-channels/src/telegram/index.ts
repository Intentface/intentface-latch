/**
 * @intentface/latch-channels/telegram
 *
 * Bring a Latch agent to Telegram DMs: per-bot webhook handling (secret-token
 * verified), the answer posted once at finish as HTML, inline-keyboard
 * approvals and questionnaires, and media → multimodal file parts. A Surface
 * over the turn kernel — identity, credentials and dedupe are injected by the
 * host.
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
export { approvalPromptHtml, questionPromptHtml, answeredQuestionHtml } from "./format.js";
export {
  telegramChannel,
  telegramSurface,
  telegramChatId,
  parseTelegramChatId,
  encodeApprovalCallback,
  decodeApprovalCallback,
  type TelegramChannelConfig,
  type TelegramUser,
  type TgFileRef,
} from "./telegramChannel.js";
