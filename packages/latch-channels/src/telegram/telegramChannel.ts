import type {
  AskSession,
  AskStateStore,
  AuthResult,
  ChannelRunOps,
  ChannelThreadStore,
  PendingApproval,
  TranscribeAudio,
} from "../types.js";
import {
  createTurnKernel,
  decodeApprovalData,
  decodeQuestionData,
  encodeApprovalData,
  type Inbound,
  type InboundMedia,
  type QuestionData,
  type Surface,
} from "../kernel.js";
import {
  assertCallbackData,
  telegramApi,
  TelegramApiError,
  type InlineKeyboardButton,
  type SendMessageInput,
  type TelegramApiOptions,
  type TelegramClient,
  type TelegramToken,
} from "./api.js";
import { verifyTelegramSecretToken } from "./verify.js";
import {
  answeredQuestionHtml,
  approvalPromptHtml,
  htmlToPlain,
  optionButtonText,
  questionPromptHtml,
} from "./format.js";
import { escapeHtml, gfmToTelegramHtml } from "./html.js";

/**
 * One agent's Telegram bot. The host wires `handleRequest` to the bot's per-bot
 * webhook route; we verify the secret token, ACK fast, and hand the parsed
 * update to the turn kernel in the background. The answer posts once at
 * finish (as HTML, plain on an entity-parse failure); "typing…" is the only
 * progress signal.
 *
 * v1 scope: private chats (DMs) only — group messages are ignored by design.
 *
 * Everything below the parser is a {@link Surface}: how to send text, cards
 * and links, how to edit or retire a card, how to download a file. The
 * admission, questionnaire and command semantics live in the kernel.
 */

/** Telegram caps messages at 4096 chars; leave room for the split's trimming. */
const MAX_TEXT_CHARS = 4000;

export interface TelegramUser {
  telegramUserId: string;
  username?: string;
  /** In a private chat Telegram's chat_id IS the user id, but carry it as delivered. */
  telegramChatId: string;
}

export interface TelegramChannelConfig<P> {
  /** The agent this bot serves. */
  agent: string;
  /**
   * Stable host-side bot id (the bot row's id). Used in chat ids
   * (`telegram_<botRef>_<userId>`) and delivery keys — NOT the Telegram bot id,
   * so rotating the actual bot token/account keeps conversations intact.
   */
  botRef: string;
  /** Vault-backed in practice: `() => vault.get(principal, "telegram_bot_token:<id>")`. */
  botToken: TelegramToken;
  /** The `secret_token` registered with setWebhook (lazy-resolvable like the token). */
  webhookSecret: string | (() => string | Promise<string>);
  runtime: ChannelRunOps<P>;
  /**
   * Resolve the inbound Telegram user to a platform principal. Return
   * `{ allowed: false, linkUrl }` to refuse and DM a signed setup link; the
   * kernel stashes the message (see `stashPending`) to replay after linking.
   */
  authorizeUser: (user: TelegramUser) => Promise<AuthResult<P>>;
  /** Persistent dedupe on `<botRef>:<chatId>:<userId>:<messageId>` (and `<botRef>:cb:<id>` for taps). */
  seen?: (deliveryKey: string) => Promise<boolean>;
  /** Host-backed one-turn-per-chat lease (see the kernel). */
  claimTurn?: (chatId: string) => Promise<string | null>;
  releaseTurn?: (chatId: string, token: string) => Promise<void>;
  /** Stash the message that triggered a link prompt, to replay after linking. */
  stashPending?: (
    input: TelegramUser & { text: string; media?: InboundMedia<TgFileRef>[] },
  ) => Promise<void>;
  /** Build the platform authorize URL for a `connect_<name>` OAuth approval. */
  authorizeUrl?: (
    connectionName: string,
    ctx: { chatId: string; telegramUserId: string; approvalId: string },
  ) => string;
  /** Host speech-to-text for voice notes (see the kernel). */
  transcribe?: TranscribeAudio;
  /** Host storage for in-flight `askUser` questionnaires (see the kernel). */
  askState?: AskStateStore;
  /** Host storage for the thread epoch — what makes `/new` possible. */
  thread?: ChannelThreadStore;
  /** Keep a serverless function alive after the fast ACK (Vercel: `waitUntil`). */
  waitUntil?: (p: Promise<unknown>) => void;
  /** Test seam: base URL / fetch for the Bot API client. */
  apiOptions?: TelegramApiOptions;
}

// ── Telegram update shapes (the slice we read) ──────────────────────────────

interface TgUser {
  id: number;
  is_bot?: boolean;
  username?: string;
}

export interface TgFileRef {
  file_id: string;
  file_size?: number;
  mime_type?: string;
  file_name?: string;
}

interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number; type: string };
  text?: string;
  caption?: string;
  photo?: TgFileRef[];
  document?: TgFileRef;
  voice?: TgFileRef;
  audio?: TgFileRef;
  video?: TgFileRef;
  video_note?: TgFileRef;
}

interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: { message_id: number; chat: { id: number; type: string } };
  data?: string;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

/** Button payloads are the kernel's shared `lta:` / `ltq:` formats. */
export const encodeApprovalCallback = encodeApprovalData;
export const decodeApprovalCallback = decodeApprovalData;
export const decodeQuestionCallback = decodeQuestionData;

const ok = () => new Response(null, { status: 200 });

/** The typed media attachments present on a message, largest photo size only. */
function mediaRefs(msg: TgMessage): InboundMedia<TgFileRef>[] {
  const out: InboundMedia<TgFileRef>[] = [];
  const photo = msg.photo?.[msg.photo.length - 1];
  if (photo) out.push({ ref: photo, mediaType: "image/jpeg", name: "photo.jpg" });
  if (msg.document)
    out.push({
      ref: msg.document,
      mediaType: msg.document.mime_type ?? "application/octet-stream",
      name: msg.document.file_name ?? "document",
    });
  if (msg.voice) out.push({ ref: msg.voice, mediaType: "audio/ogg", name: "voice.ogg" });
  if (msg.audio)
    out.push({ ref: msg.audio, mediaType: msg.audio.mime_type ?? "audio/mpeg", name: "audio" });
  if (msg.video)
    out.push({ ref: msg.video, mediaType: msg.video.mime_type ?? "video/mp4", name: "video.mp4" });
  if (msg.video_note)
    out.push({ ref: msg.video_note, mediaType: "video/mp4", name: "video-note.mp4" });
  return out;
}

const userOf = (from: TgUser, chatId: number | string): TelegramUser => ({
  telegramUserId: String(from.id),
  ...(from.username ? { username: from.username } : {}),
  telegramChatId: String(chatId),
});

// ── The Telegram chat-id format ─────────────────────────────────────────────
// `telegram_<botRef>_<telegramUserId>` for the original thread, `…_t<epoch>`
// after `/new` bumps the epoch. Defined ONCE here and read back by
// `parseTelegramChatId`, so nothing outside this file has to know the shape —
// including the hosts that need to go the other way (a scheduled run resolving
// which DM it belongs to). `_t<n>` can't collide with a numeric Telegram user
// id and stays URL-safe: chat ids show up in `/chat/<chatId>` links.

/** Build the chat id for a (bot, Telegram user) at a thread epoch. */
export function telegramChatId(botRef: string, telegramUserId: string, epoch = 0): string {
  const base = `telegram_${botRef}_${telegramUserId}`;
  return epoch > 0 ? `${base}_t${epoch}` : base;
}

/**
 * The inverse of `telegramChatId`, or null when `id` isn't one of ours. Parsed
 * right-to-left because only the trailing parts have a fixed shape (numeric
 * user id, optional `_t<digits>`) — a botRef is host-chosen and may contain
 * anything but a newline.
 */
export function parseTelegramChatId(
  id: string,
): { botRef: string; telegramUserId: string; epoch: number } | null {
  const m = /^telegram_(.+)_(\d+)(?:_t(\d+))?$/.exec(id);
  if (!m) return null;
  return { botRef: m[1]!, telegramUserId: m[2]!, epoch: m[3] ? Number(m[3]) : 0 };
}

// ── The surface ─────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The inline keyboard for one question: one row per option, Done for multi. */
function questionKeyboard(session: AskSession, data: QuestionData): InlineKeyboardButton[][] {
  const q = session.questions[session.cursor]!;
  const rows: InlineKeyboardButton[][] = q.options.map((o, i) => [
    {
      text: optionButtonText(o.label, q.multiSelect ? session.selected.includes(i) : undefined),
      callback_data: assertCallbackData(data.pick(i)),
    },
  ]);
  if (q.multiSelect) rows.push([{ text: "✅ Done", callback_data: assertCallbackData(data.done) }]);
  return rows;
}

export function telegramSurface(api: TelegramClient, botRef: string): Surface<TelegramUser, TgFileRef> {
  const chat = (u: TelegramUser) => u.telegramChatId;
  const ref = (r: { messageId: number }) => (r.messageId ? String(r.messageId) : undefined);

  /**
   * Send HTML; on 429 honour `retry_after` once; on 400 (almost always an
   * entity-parse failure on model markdown) resend the plain twin.
   */
  async function sendHtml(
    u: TelegramUser,
    html: string,
    plain: string,
    reply_markup?: SendMessageInput["reply_markup"],
  ): Promise<string | undefined> {
    const base = {
      chat_id: chat(u),
      link_preview_options: { is_disabled: true },
      ...(reply_markup ? { reply_markup } : {}),
    };
    const rich = { ...base, text: html, parse_mode: "HTML" as const };
    try {
      return ref(await api.sendMessage(rich));
    } catch (e) {
      if (e instanceof TelegramApiError && e.status === 429) {
        await sleep((e.retryAfter ?? 3) * 1000);
        return ref(await api.sendMessage(rich));
      }
      if (e instanceof TelegramApiError && e.status === 400) {
        return ref(await api.sendMessage({ ...base, text: plain }));
      }
      throw e;
    }
  }

  return {
    kind: "telegram",
    maxTextChars: MAX_TEXT_CHARS,
    chatId: (u, epoch) => telegramChatId(botRef, u.telegramUserId, epoch),

    sendText: async (u, text, opts) =>
      opts?.rich
        ? sendHtml(u, gfmToTelegramHtml(text), text)
        : ref(await api.sendMessage({ chat_id: chat(u), text })),

    sendLink: async (u, body, label, url) => {
      await sendHtml(u, escapeHtml(body), body, { inline_keyboard: [[{ text: label, url }]] });
    },

    sendApproval: (u, pa: PendingApproval, data) => {
      const html = approvalPromptHtml(pa.toolName, pa.input);
      return sendHtml(u, html, htmlToPlain(html), {
        inline_keyboard: [
          [
            { text: "✅ Approve", callback_data: assertCallbackData(data.approve) },
            { text: "🚫 Deny", callback_data: assertCallbackData(data.deny) },
          ],
        ],
      });
    },

    sendQuestion: (u, session, data) => {
      const q = session.questions[session.cursor];
      if (!q) return Promise.resolve(undefined);
      const html = questionPromptHtml(q, session.cursor, session.questions.length);
      return sendHtml(
        u,
        html,
        htmlToPlain(html),
        data ? { inline_keyboard: questionKeyboard(session, data) } : undefined,
      );
    },

    updateQuestion: (u, card, session, data) =>
      api.editMessageReplyMarkup({
        chat_id: chat(u),
        message_id: Number(card),
        reply_markup: { inline_keyboard: questionKeyboard(session, data) },
      }),

    answered: async (u, card, a) => {
      if (card === undefined) return;
      await api.editMessageText({
        chat_id: chat(u),
        message_id: Number(card),
        text: answeredQuestionHtml(a.question, a.answer),
        parse_mode: "HTML",
      });
    },

    settleCard: (u, card, text, opts) =>
      api.editMessageText({
        chat_id: chat(u),
        message_id: Number(card),
        text: opts?.rich ? gfmToTelegramHtml(text) : text,
        ...(opts?.rich ? { parse_mode: "HTML" as const } : {}),
      }),

    retireCard: (u, card) =>
      api.editMessageReplyMarkup({ chat_id: chat(u), message_id: Number(card) }),

    typing: (u) => api.sendChatAction(chat(u)),

    ack: (id, text) => api.answerCallbackQuery(id, text),

    fetchMedia: async (m, maxBytes) => {
      if ((m.ref.file_size ?? 0) > maxBytes) return null;
      const { filePath, fileSize } = await api.getFile(m.ref.file_id);
      if (!filePath || (fileSize ?? 0) > maxBytes) return null;
      return { bytes: await api.downloadFile(filePath), mediaType: m.mediaType };
    },
  };
}

// ── The channel ─────────────────────────────────────────────────────────────

export function telegramChannel<P>(config: TelegramChannelConfig<P>) {
  const api = telegramApi(config.botToken, config.apiOptions);
  const defer = (p: Promise<unknown>) => (config.waitUntil ? config.waitUntil(p) : p);

  const kernel = createTurnKernel<P, TelegramUser, TgFileRef>(
    {
      agent: config.agent,
      botRef: config.botRef,
      runtime: config.runtime,
      authorizeUser: config.authorizeUser,
      ...(config.seen ? { seen: config.seen } : {}),
      ...(config.claimTurn ? { claimTurn: config.claimTurn } : {}),
      ...(config.releaseTurn ? { releaseTurn: config.releaseTurn } : {}),
      ...(config.transcribe ? { transcribe: config.transcribe } : {}),
      ...(config.askState ? { askState: config.askState } : {}),
      ...(config.thread ? { thread: config.thread } : {}),
      ...(config.stashPending
        ? {
            stashPending: (i: { user: TelegramUser; text: string; media?: InboundMedia<TgFileRef>[] }) =>
              config.stashPending!({ ...i.user, text: i.text, ...(i.media ? { media: i.media } : {}) }),
          }
        : {}),
      ...(config.authorizeUrl
        ? {
            authorizeUrl: (name: string, ctx: { chatId: string; user: TelegramUser; approvalId: string }) =>
              config.authorizeUrl!(name, {
                chatId: ctx.chatId,
                telegramUserId: ctx.user.telegramUserId,
                approvalId: ctx.approvalId,
              }),
          }
        : {}),
    },
    telegramSurface(api, config.botRef),
  );

  async function resolveWebhookSecret(): Promise<string> {
    return typeof config.webhookSecret === "function" ? config.webhookSecret() : config.webhookSecret;
  }

  /** A Telegram update → the kernel's inbound event, or null for updates we ignore. */
  function parse(update: TgUpdate): Inbound<TelegramUser, TgFileRef> | null {
    const cb = update.callback_query;
    if (cb) {
      // Same DM-only rule as messages: a tap on a card that somehow lives in a
      // group would otherwise route every reply to that group's chat id.
      if (cb.message && cb.message.chat.type !== "private") return null;
      return {
        kind: "action",
        user: userOf(cb.from, cb.message?.chat.id ?? cb.from.id),
        data: cb.data ?? "",
        deliveryKey: `${config.botRef}:cb:${cb.id}`,
        ...(cb.message ? { card: String(cb.message.message_id) } : {}),
        ackId: cb.id,
      };
    }
    const msg = update.message;
    if (!msg?.from || msg.from.is_bot) return null;
    if (msg.chat.type !== "private") return null; // v1: DMs only, by design
    const user = userOf(msg.from, msg.chat.id);
    return {
      kind: "message",
      user,
      text: (msg.text ?? msg.caption ?? "").trim(),
      media: mediaRefs(msg),
      deliveryKey: `${config.botRef}:${user.telegramChatId}:${user.telegramUserId}:${msg.message_id}`,
    };
  }

  // ── The per-bot webhook entrypoint ──────────────────────────────────────────
  async function handleRequest(request: Request): Promise<Response> {
    const header = request.headers.get("x-telegram-bot-api-secret-token");
    if (!verifyTelegramSecretToken(header, await resolveWebhookSecret())) {
      return new Response("invalid secret token", { status: 401 });
    }
    let update: TgUpdate;
    try {
      update = (await request.json()) as TgUpdate;
    } catch {
      return ok(); // malformed body — nothing to retry
    }
    const ev = parse(update);
    if (ev) defer(kernel.handleInbound(ev));
    return ok();
  }

  type HostCtx = {
    telegramUserId: string;
    telegramChatId: string;
    text: string;
    media?: InboundMedia<TgFileRef>[];
    principal: P;
  };
  const kernelCtx = ({ telegramUserId, telegramChatId, ...rest }: HostCtx) => ({
    user: { telegramUserId, telegramChatId },
    ...rest,
  });

  return {
    handleRequest,
    /** Run one already-gated, already-leased message (scheduled delivery). */
    runMessage: (ctx: HostCtx & { chatId?: string }) => kernel.runMessage(kernelCtx(ctx)),
    /** Replay a stashed message under the turn lease (the post-link resume). */
    replayMessage: (ctx: HostCtx) => kernel.replayMessage(kernelCtx(ctx)),
    api,
  };
}
