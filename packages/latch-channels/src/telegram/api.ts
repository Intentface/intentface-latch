/**
 * Minimal Telegram Bot API client — just the methods a channel (and its host's
 * admin surface) needs. JSON POSTs to `api.telegram.org/bot<token>/<method>`,
 * `{ok, result, description}` unwrap, 10s timeout per call. No SDK.
 */

export type TelegramToken = string | (() => string | Promise<string>);

const DEFAULT_BASE_URL = "https://api.telegram.org";
const DEFAULT_TIMEOUT_MS = 10_000;

/** A failed Bot API call. `retryAfter` (seconds) is set on 429s. */
export class TelegramApiError extends Error {
  readonly status: number;
  readonly retryAfter?: number;

  constructor(method: string, status: number, description?: string, retryAfter?: number) {
    super(`telegram:${method} failed: ${description ?? `HTTP ${status}`}`);
    this.name = "TelegramApiError";
    this.status = status;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

export interface TelegramApiOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface TelegramBotInfo {
  id: number;
  username: string;
  firstName: string;
}

export interface TelegramWebhookInfo {
  url: string;
  pendingUpdateCount: number;
  lastErrorMessage?: string;
  lastErrorDate?: number;
}

/** An inline-keyboard button: either a callback button or a URL link button. */
export type InlineKeyboardButton =
  | { text: string; callback_data: string }
  | { text: string; url: string };

export interface SendMessageInput {
  chat_id: number | string;
  text: string;
  parse_mode?: "HTML";
  reply_markup?: { inline_keyboard: InlineKeyboardButton[][] };
  link_preview_options?: { is_disabled: boolean };
}

/** Telegram's hard cap on `callback_data`. Over it, sendMessage 400s. */
export const MAX_CALLBACK_DATA_BYTES = 64;

/**
 * Guard a `callback_data` payload against Telegram's 64-byte cap. Encoders call
 * this so an over-long payload fails loudly at the call site instead of as an
 * opaque 400 from an unrelated `sendMessage`.
 */
export function assertCallbackData(data: string): string {
  const bytes = new TextEncoder().encode(data).length;
  if (bytes > MAX_CALLBACK_DATA_BYTES) {
    throw new Error(`callback_data too long (${bytes} > ${MAX_CALLBACK_DATA_BYTES}): ${data}`);
  }
  return data;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A bot-scoped client bound to one (possibly lazily resolved) token. */
export function telegramApi(token: TelegramToken, opts: TelegramApiOptions = {}) {
  const base = opts.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = opts.fetchImpl ?? fetch;

  async function resolveToken(): Promise<string> {
    return typeof token === "function" ? token() : token;
  }

  async function call(method: string, body: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetchImpl(`${base}/bot${await resolveToken()}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const payload = (await res.json().catch(() => null)) as {
        ok?: boolean;
        result?: unknown;
        description?: string;
        parameters?: { retry_after?: number };
      } | null;
      if (!payload?.ok) {
        throw new TelegramApiError(
          method,
          res.status,
          payload?.description,
          payload?.parameters?.retry_after,
        );
      }
      return payload.result;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    /** Validate the token and return the bot's identity. */
    async getMe(): Promise<TelegramBotInfo> {
      const r = asObject(await call("getMe", {}));
      if (typeof r.id !== "number" || typeof r.username !== "string") {
        throw new Error("Telegram getMe returned an unexpected result.");
      }
      return {
        id: r.id,
        username: r.username,
        firstName: typeof r.first_name === "string" ? r.first_name : "",
      };
    },

    /** Point Telegram's webhook at `url`, guarded by `secretToken`. */
    async setWebhook(input: {
      url: string;
      secretToken: string;
      dropPendingUpdates?: boolean;
    }): Promise<void> {
      const r = await call("setWebhook", {
        url: input.url,
        secret_token: input.secretToken,
        allowed_updates: ["message", "callback_query"],
        ...(input.dropPendingUpdates ? { drop_pending_updates: true } : {}),
      });
      if (r !== true) throw new Error("Telegram setWebhook returned an unexpected result.");
    },

    async deleteWebhook(): Promise<void> {
      await call("deleteWebhook", {});
    },

    /**
     * Publish the bot's command list — what Telegram shows in the "/" menu and
     * autocompletes. Cosmetic: the commands work either way, but nothing else
     * makes them discoverable. Call it whenever the webhook is (re-)registered.
     */
    async setMyCommands(
      commands: { command: string; description: string }[],
    ): Promise<void> {
      await call("setMyCommands", { commands });
    },

    async getWebhookInfo(): Promise<TelegramWebhookInfo> {
      const r = asObject(await call("getWebhookInfo", {}));
      return {
        url: typeof r.url === "string" ? r.url : "",
        pendingUpdateCount:
          typeof r.pending_update_count === "number" ? r.pending_update_count : 0,
        ...(typeof r.last_error_message === "string"
          ? { lastErrorMessage: r.last_error_message }
          : {}),
        ...(typeof r.last_error_date === "number" ? { lastErrorDate: r.last_error_date } : {}),
      };
    },

    /** Send a message; returns the new message id (cards are edited later by it). */
    async sendMessage(input: SendMessageInput): Promise<{ messageId: number }> {
      const r = asObject(await call("sendMessage", { ...input }));
      return { messageId: typeof r.message_id === "number" ? r.message_id : 0 };
    },

    /** Edit a previously sent message in place (the streaming primitive). */
    async editMessageText(input: SendMessageInput & { message_id: number }): Promise<void> {
      await call("editMessageText", { ...input });
    },

    /**
     * Swap (or remove) just a message's inline keyboard. Used to re-tick
     * multi-select options and to retire stale buttons — cheaper than
     * `editMessageText` and it can't trip the "message is not modified" 400.
     */
    async editMessageReplyMarkup(input: {
      chat_id: number | string;
      message_id: number;
      reply_markup?: { inline_keyboard: InlineKeyboardButton[][] };
    }): Promise<void> {
      await call("editMessageReplyMarkup", { ...input });
    },

    /** Show "typing…" in the chat (auto-expires after ~5s or the next message). */
    async sendChatAction(chatId: number | string, action = "typing"): Promise<void> {
      await call("sendChatAction", { chat_id: chatId, action }).catch(() => {
        /* cosmetic — never fail a turn over it */
      });
    },

    /** Ack a callback query (stops the client-side spinner on the button). */
    async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
      await call("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        ...(text ? { text } : {}),
      }).catch(() => {
        /* best-effort — the approval still resolves */
      });
    },

    /** Resolve a file_id to its download path + size. */
    async getFile(fileId: string): Promise<{ filePath?: string; fileSize?: number }> {
      const r = asObject(await call("getFile", { file_id: fileId }));
      return {
        ...(typeof r.file_path === "string" ? { filePath: r.file_path } : {}),
        ...(typeof r.file_size === "number" ? { fileSize: r.file_size } : {}),
      };
    },

    /** Download a file previously resolved via `getFile`. */
    async downloadFile(filePath: string): Promise<Uint8Array> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      try {
        const res = await fetchImpl(`${base}/file/bot${await resolveToken()}/${filePath}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`telegram file download failed: HTTP ${res.status}`);
        return new Uint8Array(await res.arrayBuffer());
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export type TelegramClient = ReturnType<typeof telegramApi>;
