import type { AppMessage } from "@intentface/latch-core";
import type { ChannelRunOps } from "../types.js";
import { consumeRun, pendingApprovals } from "../render.js";
import { telegramApi, type TelegramApiOptions, type TelegramToken } from "./api.js";
import { verifyTelegramSecretToken } from "./verify.js";
import { approvalPromptHtml, renderTelegramStream } from "./stream.js";
import { escapeHtml } from "./html.js";

/**
 * One agent's Telegram bot. The host wires `handleRequest` to the bot's
 * per-bot webhook route; we verify the secret token, ACK fast, and run the
 * turn in the background, streaming the answer as progressive message edits.
 *
 * v1 scope: private chats (DMs) only — group messages are ignored by design.
 *
 * Contract note vs the Slack channel: Slack runs every turn as one configured
 * owner principal and `authorizeUser` is a yes/no gate. Here `authorizeUser`
 * is a RESOLVER — it returns the linked platform user's principal, so each
 * turn runs as the human driving it (identity linking is per Telegram user).
 */

/** ~10 MB — files above this are skipped with a note (Telegram's own bot download cap is 20 MB). */
const MAX_INLINE_FILE_BYTES = 10 * 1024 * 1024;
const STILL_WORKING_MESSAGE = "I am still working on the previous message in this chat.";

export interface TelegramAuthResult<P> {
  allowed: boolean;
  /** The principal the turn runs as (required when `allowed`). */
  principal?: P;
  /** Signed setup link to send when not allowed. */
  linkUrl?: string;
  /** Override the refusal message. */
  message?: string;
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
   * host should stash the message (see `stashPending`) to replay after linking.
   */
  authorizeUser: (user: {
    telegramUserId: string;
    username?: string;
    telegramChatId: string;
  }) => Promise<TelegramAuthResult<P>>;
  /**
   * Persistent dedupe: return true if this delivery key was already handled.
   * Telegram re-delivers updates until a 2xx; an in-process Set is not enough
   * on serverless. Keys look like `<botRef>:<chatId>:<userId>:<messageId>`.
   */
  seen?: (deliveryKey: string) => Promise<boolean>;
  /**
   * Host-backed one-turn-per-chat guard. Return false if a turn is already
   * running for this chatId → the user gets a "still working" reply.
   */
  claimTurn?: (chatId: string) => Promise<boolean>;
  releaseTurn?: (chatId: string) => Promise<void>;
  /** Stash the message that triggered a link prompt, to replay after linking. */
  stashPending?: (input: {
    telegramUserId: string;
    username?: string;
    telegramChatId: string;
    text: string;
  }) => Promise<void>;
  /** Build the platform authorize URL for a `connect_<name>` OAuth approval. */
  authorizeUrl?: (
    connectionName: string,
    ctx: { chatId: string; telegramUserId: string; approvalId: string },
  ) => string;
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

interface TgFileRef {
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

// ── Approval callback encoding (Telegram caps callback_data at 64 bytes) ────
// Carry only the decision + approval id; the chat id is recomputed from the
// callback's sender (per-bot channel + private chats ⇒ user id pins the chat).

const CALLBACK_PREFIX = "lta";

export function encodeApprovalCallback(approved: boolean, approvalId: string): string {
  return `${CALLBACK_PREFIX}:${approved ? 1 : 0}|${approvalId}`;
}

export function decodeApprovalCallback(
  data: string | undefined,
): { approved: boolean; approvalId: string } | null {
  if (!data) return null;
  const m = /^lta:([01])\|(.+)$/.exec(data);
  if (!m) return null;
  return { approved: m[1] === "1", approvalId: m[2]! };
}

const ok = () => new Response(null, { status: 200 });

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `m_${Date.now()}_${Math.round(Math.random() * 1e9)}`;
}

/** The typed media attachments present on a message, largest photo size only. */
function mediaRefs(msg: TgMessage): { ref: TgFileRef; mediaType: string; name: string }[] {
  const out: { ref: TgFileRef; mediaType: string; name: string }[] = [];
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

export function telegramChannel<P>(config: TelegramChannelConfig<P>) {
  const api = telegramApi(config.botToken, config.apiOptions);

  const defer = (p: Promise<unknown>) => (config.waitUntil ? config.waitUntil(p) : p);

  async function resolveWebhookSecret(): Promise<string> {
    return typeof config.webhookSecret === "function"
      ? config.webhookSecret()
      : config.webhookSecret;
  }

  /** chatId for a Telegram DM — continuity is per (bot, Telegram user). */
  const chatIdFor = (telegramUserId: string) => `telegram_${config.botRef}_${telegramUserId}`;

  // ── Inbound message → one agent turn ───────────────────────────────────────
  async function runTurn(msg: TgMessage): Promise<void> {
    const from = msg.from;
    if (!from || from.is_bot) return;
    if (msg.chat.type !== "private") return; // v1: DMs only, by design
    const telegramUserId = String(from.id);
    const telegramChatId = String(msg.chat.id);
    const text = (msg.text ?? msg.caption ?? "").trim();
    const media = mediaRefs(msg);
    if (!text && media.length === 0) return;

    if (config.seen) {
      const key = `${config.botRef}:${telegramChatId}:${telegramUserId}:${msg.message_id}`;
      if (await config.seen(key)) {
        console.log(`[telegram] duplicate delivery ${key} — dropped`);
        return;
      }
    }

    let auth: TelegramAuthResult<P>;
    try {
      auth = await config.authorizeUser({
        telegramUserId,
        ...(from.username ? { username: from.username } : {}),
        telegramChatId,
      });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      await api
        .sendMessage({ chat_id: msg.chat.id, text: `⚠️ auth check failed: ${m.slice(0, 500)}` })
        .catch(() => {});
      return;
    }

    if (!auth.allowed || auth.principal === undefined) {
      await config
        .stashPending?.({
          telegramUserId,
          ...(from.username ? { username: from.username } : {}),
          telegramChatId,
          text,
        })
        .catch((e) => console.error("[telegram] stashPending failed:", e));
      const base = auth.message ?? "You need a Latch account to use this agent.";
      const body = auth.linkUrl
        ? `${escapeHtml(base)}\n\n<a href="${auth.linkUrl}">Link your Latch account</a>`
        : escapeHtml(base);
      await api
        .sendMessage({
          chat_id: msg.chat.id,
          text: body,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        })
        .catch((e) => console.error("[telegram] link notice failed:", e));
      return;
    }

    const chatId = chatIdFor(telegramUserId);
    if (config.claimTurn && !(await config.claimTurn(chatId))) {
      await api
        .sendMessage({ chat_id: msg.chat.id, text: STILL_WORKING_MESSAGE })
        .catch(() => {});
      return;
    }
    try {
      await runMessage({
        telegramUserId,
        telegramChatId,
        text,
        media,
        principal: auth.principal,
      });
    } finally {
      await config.releaseTurn?.(chatId).catch(() => {});
    }
  }

  /**
   * Run one user message against the agent and render it — WITHOUT the auth
   * gate or turn claim (callers handle those). Also used by the host's
   * post-link resume to replay a stashed message.
   */
  async function runMessage(ctx: {
    telegramUserId: string;
    telegramChatId: string;
    text: string;
    media?: { ref: TgFileRef; mediaType: string; name: string }[];
    principal: P;
  }): Promise<void> {
    const chatId = chatIdFor(ctx.telegramUserId);

    // Media → inline data-URL file parts (≤10 MB each); oversized listed in a note.
    const fileParts: { type: "file"; mediaType: string; filename: string; url: string }[] = [];
    const skipped: string[] = [];
    for (const m of ctx.media ?? []) {
      if ((m.ref.file_size ?? 0) > MAX_INLINE_FILE_BYTES) {
        skipped.push(m.name);
        continue;
      }
      try {
        const { filePath, fileSize } = await api.getFile(m.ref.file_id);
        if (!filePath || (fileSize ?? 0) > MAX_INLINE_FILE_BYTES) {
          skipped.push(m.name);
          continue;
        }
        const bytes = await api.downloadFile(filePath);
        fileParts.push({
          type: "file",
          mediaType: m.mediaType,
          filename: m.name,
          url: `data:${m.mediaType};base64,${Buffer.from(bytes).toString("base64")}`,
        });
      } catch (e) {
        console.error(`[telegram] file download failed (${m.name}):`, e);
        skipped.push(m.name);
      }
    }

    let text = ctx.text;
    if (skipped.length) {
      const note = `[Some attached files could not be included (too large or unavailable): ${skipped.join(", ")}]`;
      text = text ? `${text}\n\n${note}` : note;
    }
    if (!text && fileParts.length === 0) return;

    const message: AppMessage = {
      id: newId(),
      role: "user",
      parts: [...(text ? [{ type: "text" as const, text }] : []), ...fileParts],
      metadata: { visibility: "user", createdAt: Date.now() },
    };

    try {
      const res = await config.runtime.handleChat({
        agent: config.agent,
        chatId,
        principal: ctx.principal,
        message,
      });
      await renderTelegramStream(consumeRun(res), {
        api,
        chatId: ctx.telegramChatId,
      });
      await renderApprovals(chatId, ctx.telegramChatId, ctx.telegramUserId, ctx.principal);
    } catch (e) {
      console.error("[telegram] runMessage failed:", e);
      const m = e instanceof Error ? e.message : String(e);
      await api
        .sendMessage({ chat_id: ctx.telegramChatId, text: `⚠️ ${m.slice(0, 3000)}` })
        .catch(() => {});
    }
  }

  /** Approvals are message state, not stream chunks — scan fresh history. */
  async function renderApprovals(
    chatId: string,
    telegramChatId: string,
    telegramUserId: string,
    principal: P,
  ): Promise<void> {
    const history = await config.runtime.loadHistory({ chatId, principal });
    for (const pa of pendingApprovals(history)) {
      if (pa.isConnect && pa.connectionName && config.authorizeUrl) {
        const url = config.authorizeUrl(pa.connectionName, {
          chatId,
          telegramUserId,
          approvalId: pa.approvalId,
        });
        await api.sendMessage({
          chat_id: telegramChatId,
          text: `Connect <b>${escapeHtml(pa.connectionName)}</b> to continue.`,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[{ text: `Sign in to ${pa.connectionName}`, url }]],
          },
        });
      } else {
        await api.sendMessage({
          chat_id: telegramChatId,
          text: approvalPromptHtml(pa.toolName, pa.input),
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ Approve", callback_data: encodeApprovalCallback(true, pa.approvalId) },
                { text: "🚫 Deny", callback_data: encodeApprovalCallback(false, pa.approvalId) },
              ],
            ],
          },
        });
      }
    }
  }

  // ── Approve/Deny button → resume the run ────────────────────────────────────
  async function runCallback(cb: TgCallbackQuery): Promise<void> {
    const decoded = decodeApprovalCallback(cb.data);
    if (!decoded) return;
    await api.answerCallbackQuery(cb.id);

    const telegramUserId = String(cb.from.id);
    const telegramChatId = String(cb.message?.chat.id ?? cb.from.id);

    let auth: TelegramAuthResult<P>;
    try {
      auth = await config.authorizeUser({
        telegramUserId,
        ...(cb.from.username ? { username: cb.from.username } : {}),
        telegramChatId,
      });
    } catch (e) {
      console.error("[telegram] callback auth failed:", e);
      return;
    }
    if (!auth.allowed || auth.principal === undefined) {
      await api
        .sendMessage({ chat_id: telegramChatId, text: "Link your Latch account first." })
        .catch(() => {});
      return;
    }

    const chatId = chatIdFor(telegramUserId);

    // Name the tool on the settled card (history still holds the pending part).
    let toolName = "tool";
    try {
      const history = await config.runtime.loadHistory({ chatId, principal: auth.principal });
      toolName =
        pendingApprovals(history).find((p) => p.approvalId === decoded.approvalId)?.toolName ??
        toolName;
    } catch {
      /* cosmetic only */
    }

    try {
      const res = await config.runtime.applyApproval({
        chatId,
        principal: auth.principal,
        decisions: [{ approvalId: decoded.approvalId, approved: decoded.approved }],
      });
      if (cb.message) {
        await api
          .editMessageText({
            chat_id: cb.message.chat.id,
            message_id: cb.message.message_id,
            text: decoded.approved
              ? `✅ Approved <b>${escapeHtml(toolName)}</b>`
              : `🚫 Denied <b>${escapeHtml(toolName)}</b>`,
            parse_mode: "HTML",
          })
          .catch(() => {});
      }
      // Continue rendering whatever the resume produced (incl. chained approvals).
      await renderTelegramStream(consumeRun(res), { api, chatId: telegramChatId });
      await renderApprovals(chatId, telegramChatId, telegramUserId, auth.principal);
    } catch (e) {
      console.error("[telegram] applyApproval failed:", e);
      const m = e instanceof Error ? e.message : String(e);
      await api
        .sendMessage({ chat_id: telegramChatId, text: `⚠️ ${m.slice(0, 3000)}` })
        .catch(() => {});
    }
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

    if (update.callback_query) {
      if (config.seen && (await config.seen(`${config.botRef}:cb:${update.callback_query.id}`))) {
        return ok();
      }
      defer(runCallback(update.callback_query));
      return ok();
    }
    if (update.message) {
      defer(runTurn(update.message));
      return ok();
    }
    return ok();
  }

  // `runMessage` is exposed so the host's post-link resume can replay a stashed
  // message (the gate already passed by linking).
  return { handleRequest, runMessage, api };
}
