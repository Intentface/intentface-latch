import type { AppMessage } from "@intentface/latch-core";
import type {
  AskSession,
  AskStateStore,
  ChannelRunOps,
  ChannelThreadStore,
  Question,
  TranscribeAudio,
} from "../types.js";
import { consumeRun, isPendingApprovalError, pendingApprovals, pendingQuestion } from "../render.js";
import { nextAskStep, type AskEvent } from "../ask.js";
import {
  CHANNEL_COMMANDS,
  helpText,
  parseCommand,
  THREAD_CHANGING_COMMANDS,
  type ParsedCommand,
} from "../commands.js";
import {
  assertCallbackData,
  telegramApi,
  type InlineKeyboardButton,
  type TelegramApiOptions,
  type TelegramToken,
} from "./api.js";
import { verifyTelegramSecretToken } from "./verify.js";
import {
  answeredQuestionHtml,
  approvalPromptHtml,
  optionButtonText,
  questionPromptHtml,
  renderTelegramStream,
} from "./stream.js";
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
const TRANSCRIBE_FAILED_MESSAGE =
  "⚠️ Couldn't transcribe your voice message — please try again or type it instead.";
const THREAD_UNAVAILABLE_MESSAGE =
  "⚠️ Couldn't work out which conversation this belongs to — please send that again.";
/** How much of a compaction summary `/compact` echoes back (Telegram caps at 4096). */
const MAX_SUMMARY_CHARS = 2000;

const truncate = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

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
   * Host-backed one-turn-per-chat guard. Return a claimant token when the
   * lease was acquired, or null if a turn is already running for this chatId
   * → the user gets a "still working" reply. The token fences the release: a
   * turn that outlives its lease must not delete a NEWER claimant's lease.
   */
  claimTurn?: (chatId: string) => Promise<string | null>;
  releaseTurn?: (chatId: string, token: string) => Promise<void>;
  /** Stash the message that triggered a link prompt, to replay after linking. */
  stashPending?: (input: {
    telegramUserId: string;
    username?: string;
    telegramChatId: string;
    text: string;
    media?: { ref: TgFileRef; mediaType: string; name: string }[];
  }) => Promise<void>;
  /** Build the platform authorize URL for a `connect_<name>` OAuth approval. */
  authorizeUrl?: (
    connectionName: string,
    ctx: { chatId: string; telegramUserId: string; approvalId: string },
  ) => string;
  /**
   * Host-provided speech-to-text. When set, inbound voice/audio messages are
   * transcribed and reach the agent as `[Voice message]: <transcript>` text —
   * the audio itself never becomes a file part (chat models generally reject
   * audio input). Without it, voice-only messages get a friendly refusal.
   */
  transcribe?: TranscribeAudio;
  /**
   * Host storage for in-flight `askUser` questionnaires. Without it a
   * questionnaire is posted as plain text and the turn stays paused (the user
   * can still answer in the web app) — buttons need somewhere to keep the
   * answers collected so far between webhook deliveries.
   */
  askState?: AskStateStore;
  /**
   * Host storage for the current thread epoch, which is what makes `/new`
   * possible: a Telegram DM is otherwise one conversation forever. Without it
   * `/new` reports that it isn't available and everything else works unchanged.
   */
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

// ── Questionnaire callback encoding ─────────────────────────────────────────
// Ordinals only: `ltq:<verb>|<nonce>|<questionIndex>[|<optionIndex>]`. The
// `toolCallId` is deliberately absent — it's provider-generated and 30-40 chars,
// which would crowd the 64-byte cap; it's read from the session instead. The
// nonce pins the payload to the questionnaire that was posted, so a button from
// a superseded one is rejected rather than answering the wrong question.
// Worst case: 4 + 2 + 7 + 3 + 3 = 19 bytes.

const QUESTION_PREFIX = "ltq";
/** Length of the session nonce carried in button payloads. */
export const ASK_NONCE_LENGTH = 6;

export type QuestionCallback =
  | { verb: "pick"; nonce: string; questionIndex: number; optionIndex: number }
  | { verb: "done"; nonce: string; questionIndex: number };

export function encodeQuestionCallback(cb: QuestionCallback): string {
  const tail = cb.verb === "pick" ? `|${cb.optionIndex}` : "";
  return assertCallbackData(
    `${QUESTION_PREFIX}:${cb.verb === "pick" ? "s" : "d"}|${cb.nonce}|${cb.questionIndex}${tail}`,
  );
}

export function decodeQuestionCallback(data: string | undefined): QuestionCallback | null {
  if (!data) return null;
  const m = /^ltq:([sd])\|([^|]+)\|(\d+)(?:\|(\d+))?$/.exec(data);
  if (!m) return null;
  const nonce = m[2]!;
  const questionIndex = Number(m[3]);
  if (m[1] === "d") return { verb: "done", nonce, questionIndex };
  if (m[4] === undefined) return null;
  return { verb: "pick", nonce, questionIndex, optionIndex: Number(m[4]) };
}

const ok = () => new Response(null, { status: 200 });

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `m_${Date.now()}_${Math.round(Math.random() * 1e9)}`;
}

/** Short random token pinning button payloads to one posted questionnaire. */
function newNonce(): string {
  const uuid = globalThis.crypto?.randomUUID?.() ?? String(Math.random());
  return uuid.replace(/[^a-z0-9]/gi, "").slice(0, ASK_NONCE_LENGTH);
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

  /**
   * The permanent key for a Telegram DM — continuity is per (bot, Telegram user).
   * Also the `ChannelThreadStore` key, so the epoch survives token rotation.
   */
  const baseChatIdFor = (telegramUserId: string) => `telegram_${config.botRef}_${telegramUserId}`;

  /**
   * The chat this DM is currently writing to. `/new` bumps the epoch; epoch 0
   * keeps the original, un-suffixed id so no existing conversation moves. `_t<n>`
   * can't collide with a (numeric) Telegram user id and stays URL-safe — chat ids
   * show up in `/chat/<chatId>` links.
   *
   * The epoch comes back with it so nothing has to parse the suffix again: the
   * format lives here only. A store failure THROWS rather than falling back to
   * epoch 0 — that would silently write the message into the conversation the
   * user just left behind, mixing two threads with no way to tell.
   */
  async function currentThread(telegramUserId: string): Promise<{ chatId: string; epoch: number }> {
    const base = baseChatIdFor(telegramUserId);
    if (!config.thread) return { chatId: base, epoch: 0 };
    const epoch = await config.thread.current(base);
    return { chatId: epoch > 0 ? `${base}_t${epoch}` : base, epoch };
  }

  /** `currentThread`'s chat id alone, for the paths that don't need the epoch. */
  const currentChatId = async (telegramUserId: string) =>
    (await currentThread(telegramUserId)).chatId;

  /**
   * The current chat id, or null after telling the user we couldn't work it out.
   * Used by the entry points a host calls directly (`runMessage`,
   * `replayMessage`): they run detached under `waitUntil`, so a rejected promise
   * would only reach a log and the person would be left with silence.
   */
  async function resolveThreadOrNotify(ctx: {
    telegramUserId: string;
    telegramChatId: string;
  }): Promise<string | null> {
    try {
      return await currentChatId(ctx.telegramUserId);
    } catch (e) {
      console.error("[telegram] thread lookup failed:", e);
      await api
        .sendMessage({ chat_id: ctx.telegramChatId, text: THREAD_UNAVAILABLE_MESSAGE })
        .catch(() => {});
      return null;
    }
  }

  /**
   * Run `fn` under the one-turn-per-chat lease. Every path that mutates a
   * chat's run state — fresh turns, post-link replays AND approval resumes —
   * goes through here, so two of them can never interleave on one chat. When
   * the lease is taken the user gets the "still working" notice instead.
   */
  async function withTurnLease(
    chatId: string,
    telegramChatId: string | number,
    fn: () => Promise<void>,
  ): Promise<void> {
    let lease: string | undefined;
    if (config.claimTurn) {
      const token = await config.claimTurn(chatId);
      if (!token) {
        await api
          .sendMessage({ chat_id: telegramChatId, text: STILL_WORKING_MESSAGE })
          .catch(() => {});
        return;
      }
      lease = token;
    }
    try {
      await fn();
    } finally {
      if (lease) await config.releaseTurn?.(chatId, lease).catch(() => {});
    }
  }

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

    // A command changes what the message MEANS everywhere below: it isn't an
    // answer to a question, isn't worth stashing for replay, and never reaches
    // the agent. Media rules it out — a captioned photo is a real message, and
    // running a command would silently drop the file.
    const command = media.length === 0 ? parseCommand(text) : null;

    if (!auth.allowed || auth.principal === undefined) {
      // Don't stash a command: the post-link replay would send the agent the
      // literal "/new" as a message.
      if (!command) {
        await config
          .stashPending?.({
            telegramUserId,
            ...(from.username ? { username: from.username } : {}),
            telegramChatId,
            text,
            ...(media.length ? { media } : {}),
          })
          .catch((e) => console.error("[telegram] stashPending failed:", e));
      }
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

    const principal = auth.principal;
    // Which conversation this belongs to. If that can't be established, say so
    // and drop the message: guessing would write it into the wrong thread.
    let thread: { chatId: string; epoch: number };
    try {
      thread = await currentThread(telegramUserId);
    } catch (e) {
      console.error("[telegram] thread lookup failed:", e);
      await api
        .sendMessage({ chat_id: msg.chat.id, text: THREAD_UNAVAILABLE_MESSAGE })
        .catch(() => {});
      return;
    }
    const chatId = thread.chatId;

    // A questionnaire on screen changes what a plain message MEANS: it answers
    // the current question rather than starting a turn. Deliberately downstream
    // of `seen()` — a redelivered update would otherwise be applied as a second
    // answer and skip a question — and downstream of the auth gate, so an
    // unlinked user still gets the link prompt and can't mutate ask state.
    let droppedQuestions = false;
    if (config.askState) {
      const session = await config.askState.get(chatId).catch(() => null);
      if (session) {
        // Media is never an answer: treating a captioned photo as one would
        // silently drop the file, since answers are plain text. Let it fall
        // through to a normal turn so the attachment actually reaches the agent.
        if (!command && text && media.length === 0) {
          const { rejected } = await answerQuestion({
            chatId,
            telegramChatId,
            telegramUserId,
            principal,
            session,
            event: { kind: "typed", text },
          });
          if (rejected) {
            await api.sendMessage({ chat_id: msg.chat.id, text: rejected }).catch(() => {});
          }
          return;
        }
        // Not an answer. Retire the questionnaire when whatever comes next
        // abandons the parked call anyway — a fresh turn (media, or unknown `/`
        // text) or a command that ends/replaces the thread. Read-only commands
        // (`/status`, `/help`) leave it live: asking about a conversation
        // shouldn't destroy the questions in it.
        if (!command || THREAD_CHANGING_COMMANDS.has(command.name)) {
          await config.askState.clear(chatId).catch(() => {});
          if (session.promptRef) await stripKeyboard(telegramChatId, session.promptRef);
          droppedQuestions = true;
        }
      }
    }

    if (command) {
      await runCommand({
        command,
        chatId,
        epoch: thread.epoch,
        telegramChatId,
        telegramUserId,
        principal,
        droppedQuestions,
      });
      return;
    }

    await withTurnLease(chatId, msg.chat.id, () =>
      runMessage({ telegramUserId, telegramChatId, text, media, principal, chatId }),
    );
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
    /** The resolved thread, when the caller already looked it up. */
    chatId?: string;
  }): Promise<void> {
    const chatId = ctx.chatId ?? (await resolveThreadOrNotify(ctx));
    if (chatId === null) return;

    // Media → inline data-URL file parts (≤10 MB each); oversized listed in a
    // note. Audio is the exception: it's transcribed to text (never a file
    // part) because the agent's chat model can't be assumed to accept audio.
    const fileParts: { type: "file"; mediaType: string; filename: string; url: string }[] = [];
    const transcripts: string[] = [];
    const skipped: string[] = [];
    const failedAudio: string[] = [];
    for (const m of ctx.media ?? []) {
      const isAudio = m.mediaType.startsWith("audio/");
      const markFailed = () => (isAudio ? failedAudio : skipped).push(m.name);
      if (isAudio && !config.transcribe) {
        markFailed();
        continue;
      }
      if ((m.ref.file_size ?? 0) > MAX_INLINE_FILE_BYTES) {
        markFailed();
        continue;
      }
      try {
        const { filePath, fileSize } = await api.getFile(m.ref.file_id);
        if (!filePath || (fileSize ?? 0) > MAX_INLINE_FILE_BYTES) {
          markFailed();
          continue;
        }
        const bytes = await api.downloadFile(filePath);
        if (isAudio) {
          const transcript = (
            await config.transcribe!({ bytes, mediaType: m.mediaType, filename: m.name })
          ).trim();
          if (!transcript) {
            failedAudio.push(m.name);
            continue;
          }
          transcripts.push(`[Voice message]: ${transcript}`);
        } else {
          fileParts.push({
            type: "file",
            mediaType: m.mediaType,
            filename: m.name,
            url: `data:${m.mediaType};base64,${Buffer.from(bytes).toString("base64")}`,
          });
        }
      } catch (e) {
        console.error(`[telegram] media processing failed (${m.name}):`, e);
        markFailed();
      }
    }

    let text = [ctx.text, ...transcripts].filter(Boolean).join("\n\n");
    // A voice message that produced nothing usable: tell the sender instead of
    // running a turn the agent would have no content to answer.
    if (failedAudio.length && !text && fileParts.length === 0) {
      await api
        .sendMessage({ chat_id: ctx.telegramChatId, text: TRANSCRIBE_FAILED_MESSAGE })
        .catch(() => {});
      return;
    }
    if (failedAudio.length) {
      const note = `[A voice/audio message could not be transcribed: ${failedAudio.join(", ")}]`;
      text = text ? `${text}\n\n${note}` : note;
    }
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
      await renderPending(chatId, ctx.telegramChatId, ctx.telegramUserId, ctx.principal);
    } catch (e) {
      console.error("[telegram] runMessage failed:", e);
      const m = e instanceof Error ? e.message : String(e);
      await api
        .sendMessage({ chat_id: ctx.telegramChatId, text: `⚠️ ${m.slice(0, 3000)}` })
        .catch(() => {});
      // The turn was refused because a decision is still outstanding — re-post
      // the card so it can be resolved from here. Without this the chat is a
      // dead end: the same refusal every turn and no buttons to clear it.
      if (isPendingApprovalError(e)) {
        await renderPending(
          chatId,
          ctx.telegramChatId,
          ctx.telegramUserId,
          ctx.principal,
        ).catch((err) => console.error("[telegram] re-render pending failed:", err));
      }
    }
  }

  /**
   * Replay one message under the turn lease — the post-link resume path. The
   * auth gate already passed (the user just linked), but the lease must still
   * be honored: without it a fresh webhook message racing the replay would
   * start a second concurrent run against the same history.
   */
  async function replayMessage(ctx: {
    telegramUserId: string;
    telegramChatId: string;
    text: string;
    media?: { ref: TgFileRef; mediaType: string; name: string }[];
    principal: P;
  }): Promise<void> {
    const chatId = await resolveThreadOrNotify(ctx);
    if (chatId === null) return;
    await withTurnLease(chatId, ctx.telegramChatId, () => runMessage({ ...ctx, chatId }));
  }

  /**
   * Everything a paused turn is waiting on — approvals and questionnaires are
   * message state, not stream chunks, so scan fresh history once and render
   * whatever it's parked on. Approvals win when both are present: a gated tool
   * blocks the run outright, so answering questions first would go nowhere.
   */
  async function renderPending(
    chatId: string,
    telegramChatId: string,
    telegramUserId: string,
    principal: P,
  ): Promise<void> {
    const history = await config.runtime.loadHistory({ chatId, principal });
    const approvals = pendingApprovals(history);
    await renderApprovals(approvals, chatId, telegramChatId, telegramUserId);
    if (approvals.length) return;
    await renderQuestions(pendingQuestion(history), chatId, telegramChatId);
  }

  async function renderApprovals(
    approvals: ReturnType<typeof pendingApprovals>,
    chatId: string,
    telegramChatId: string,
    telegramUserId: string,
  ): Promise<void> {
    for (const pa of approvals) {
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

  // ── Questionnaires (askUser) ───────────────────────────────────────────────

  /** The inline keyboard for one question: one row per option, Done for multi. */
  function questionKeyboard(
    q: Question,
    nonce: string,
    questionIndex: number,
    selected: number[],
  ): InlineKeyboardButton[][] {
    const rows: InlineKeyboardButton[][] = q.options.map((o, i) => [
      {
        text: optionButtonText(o.label, q.multiSelect ? selected.includes(i) : undefined),
        callback_data: encodeQuestionCallback({
          verb: "pick",
          nonce,
          questionIndex,
          optionIndex: i,
        }),
      },
    ]);
    if (q.multiSelect) {
      rows.push([
        {
          text: "✅ Done",
          callback_data: encodeQuestionCallback({ verb: "done", nonce, questionIndex }),
        },
      ]);
    }
    return rows;
  }

  /** Post the question at `cursor`; returns the new message id for `promptRef`. */
  async function sendQuestion(session: AskSession): Promise<number | undefined> {
    const q = session.questions[session.cursor];
    if (!q) return undefined;
    const { messageId } = await api.sendMessage({
      chat_id: session.promptChatId,
      text: questionPromptHtml(q, session.cursor, session.questions.length),
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: questionKeyboard(q, session.nonce, session.cursor, session.selected),
      },
    });
    return messageId;
  }

  /**
   * Prompt the questionnaire the turn is parked on (if any), and retire a stale
   * session when it's gone — e.g. the user answered the same questionnaire in
   * the web app, so the Telegram buttons must stop looking live.
   */
  async function renderQuestions(
    pending: { toolCallId: string; questions: Question[] } | null,
    chatId: string,
    telegramChatId: string,
  ): Promise<void> {
    const store = config.askState;
    if (!pending) {
      const stale = await store?.clear(chatId).catch(() => null);
      if (stale?.promptRef) await stripKeyboard(telegramChatId, stale.promptRef);
      return;
    }
    if (!store) {
      // No host storage: post the questions as text so the user at least sees
      // them, and leave the turn paused (answerable in the web app). Fabricating
      // an answer would put words in their mouth.
      console.warn("[telegram] askUser pending but no askState configured — posting as text");
      for (const [i, q] of pending.questions.entries()) {
        await api
          .sendMessage({
            chat_id: telegramChatId,
            text: questionPromptHtml(q, i, pending.questions.length),
            parse_mode: "HTML",
          })
          .catch(() => {});
      }
      return;
    }

    const session: Omit<AskSession, "rev"> = {
      toolCallId: pending.toolCallId,
      nonce: newNonce(),
      questions: pending.questions,
      cursor: 0,
      answers: {},
      selected: [],
      promptChatId: telegramChatId,
    };
    // `already` ⇒ this questionnaire is on screen from an earlier render (a
    // redelivered webhook, or a resume that produced no new askUser). Prompting
    // again would post a duplicate card whose buttons both mutate one session.
    if ((await store.begin(chatId, session)) === "already") return;
    let messageId: number | undefined;
    try {
      messageId = await sendQuestion({ ...session, rev: 0 });
    } catch (e) {
      // No prompt reached the user, so nothing is on screen to answer. Retire
      // the session or their next message gets eaten as an answer to a question
      // they never saw, with `/cancel` the only way out.
      await store.clear(chatId).catch(() => null);
      throw e;
    }
    if (messageId !== undefined) {
      await store
        .update(chatId, pending.toolCallId, 0, { promptRef: String(messageId) })
        .catch(() => null);
    }
  }

  /** Best-effort removal of a message's buttons (it may be gone or too old). */
  async function stripKeyboard(telegramChatId: string, messageRef: string): Promise<void> {
    const messageId = Number(messageRef);
    if (!Number.isFinite(messageId)) return;
    await api
      .editMessageReplyMarkup({ chat_id: telegramChatId, message_id: messageId })
      .catch(() => {});
  }

  /**
   * Apply one questionnaire interaction. Only the final answer runs the agent,
   * so only that path takes the turn lease — leasing intermediate taps would
   * serialize a 5-question flow behind the lease TTL and reply "still working"
   * to taps that touch no run state.
   */
  async function answerQuestion(ctx: {
    chatId: string;
    telegramChatId: string;
    telegramUserId: string;
    principal: P;
    session: AskSession;
    event: AskEvent;
    /** The tapped card, when the interaction came from a button. */
    cardMessageId?: number;
    /** Ack this callback query before a resume that would outlive its window. */
    ackCallbackId?: string;
  }): Promise<{ rejected?: string; acked?: boolean }> {
    const store = config.askState;
    if (!store) return {};
    const { session } = ctx;
    const step = nextAskStep(session, ctx.event);

    if (step.kind === "rejected") return { rejected: step.reason };

    if (step.kind === "toggled") {
      const rev = await store.update(ctx.chatId, session.toolCallId, session.rev, {
        selected: step.selected,
      });
      if (rev === null) return { rejected: "Already answered." };
      const q = session.questions[session.cursor]!;
      const messageId = ctx.cardMessageId ?? Number(session.promptRef);
      if (Number.isFinite(messageId)) {
        await api
          .editMessageReplyMarkup({
            chat_id: ctx.telegramChatId,
            message_id: messageId,
            reply_markup: {
              inline_keyboard: questionKeyboard(q, session.nonce, session.cursor, step.selected),
            },
          })
          .catch(() => {});
      }
      return {};
    }

    const answeredCard = ctx.cardMessageId ?? Number(session.promptRef);
    const collapseCard = async () => {
      if (!Number.isFinite(answeredCard)) return;
      await api
        .editMessageText({
          chat_id: ctx.telegramChatId,
          message_id: answeredCard,
          text: answeredQuestionHtml(step.answered.question, step.answered.answer),
          parse_mode: "HTML",
        })
        .catch(() => {});
    };

    if (step.kind === "advanced") {
      const rev = await store.update(ctx.chatId, session.toolCallId, session.rev, {
        cursor: step.cursor,
        answers: step.answers,
        selected: [],
      });
      if (rev === null) return { rejected: "Already answered." };
      await collapseCard();
      const messageId = await sendQuestion({
        ...session,
        cursor: step.cursor,
        answers: step.answers,
        selected: [],
        rev,
      });
      if (messageId !== undefined) {
        await store
          .update(ctx.chatId, session.toolCallId, rev, { promptRef: String(messageId) })
          .catch(() => null);
      }
      return {};
    }

    // Last question answered — this resumes the agent. Ack the button first: the
    // resume runs the whole turn (tens of seconds), which outlives Telegram's
    // callback-query window, so acking afterwards fails and leaves the user
    // staring at a spinner. The approval path acks up front for the same reason.
    const acked = ctx.ackCallbackId !== undefined;
    if (ctx.ackCallbackId) await api.answerCallbackQuery(ctx.ackCallbackId);

    // Nothing to submit through — bail BEFORE consuming the session, so the
    // collected answers survive a misconfigured host.
    const submit = config.runtime.applyToolResult;
    if (!submit) {
      console.error("[telegram] runtime.applyToolResult not wired — cannot resume askUser");
      return { acked };
    }

    // Take the lease BEFORE consuming the session: releasing the session first
    // would destroy every collected answer with no way left to submit them.
    await withTurnLease(ctx.chatId, ctx.telegramChatId, async () => {
      if (!(await store.finish(ctx.chatId, session.toolCallId, session.rev))) return;
      await collapseCard();
      try {
        const res = await submit({
          chatId: ctx.chatId,
          principal: ctx.principal,
          toolCallId: session.toolCallId,
          output: step.output,
        });
        await renderTelegramStream(consumeRun(res), { api, chatId: ctx.telegramChatId });
        await renderPending(ctx.chatId, ctx.telegramChatId, ctx.telegramUserId, ctx.principal);
      } catch (e) {
        console.error("[telegram] applyToolResult failed:", e);
        const m = e instanceof Error ? e.message : String(e);
        await api
          .sendMessage({ chat_id: ctx.telegramChatId, text: `⚠️ ${m.slice(0, 3000)}` })
          .catch(() => {});
      }
    });
    return { acked };
  }

  // ── Commands ───────────────────────────────────────────────────────────────

  interface CommandCtx {
    command: ParsedCommand;
    /** The thread the command was issued in (before `/new` rotates it). */
    chatId: string;
    /** That thread's epoch — 0 for the first conversation. */
    epoch: number;
    telegramChatId: string;
    telegramUserId: string;
    principal: P;
    /** True when a live questionnaire was retired to make room for this command. */
    droppedQuestions: boolean;
  }

  /** Plain-text reply; commands answer conversationally, never as a turn. */
  const say = (telegramChatId: string, text: string) =>
    api.sendMessage({ chat_id: telegramChatId, text }).catch((e) => {
      console.error("[telegram] command reply failed:", e);
      return undefined;
    });

  const COMMAND_HELP = `Commands\n\n${helpText(CHANNEL_COMMANDS)}`;

  async function runCommand(ctx: CommandCtx): Promise<void> {
    switch (ctx.command.name) {
      case "help":
        await say(ctx.telegramChatId, COMMAND_HELP);
        return;
      case "start":
        await say(
          ctx.telegramChatId,
          `You're talking to ${config.agent}. Send a message — text, a photo, a file, or a voice note — and it will answer here.\n\n${COMMAND_HELP}`,
        );
        return;
      case "new":
        await runNewCommand(ctx);
        return;
      case "compact":
        await runCompactCommand(ctx);
        return;
      case "cancel":
        await runCancelCommand(ctx);
        return;
      case "status":
        await runStatusCommand(ctx);
        return;
      default:
        // Unreachable: `parseCommand` only resolves names in the registry.
        await say(ctx.telegramChatId, COMMAND_HELP);
    }
  }

  /** `/new` — rotate to a fresh thread. Cheap: no lease, no agent turn. */
  async function runNewCommand(ctx: CommandCtx): Promise<void> {
    if (!config.thread) {
      console.warn("[telegram] /new used but no thread store configured");
      await say(ctx.telegramChatId, "Starting a new conversation isn't available on this bot.");
      return;
    }
    try {
      await config.thread.rotate(baseChatIdFor(ctx.telegramUserId));
    } catch (e) {
      console.error("[telegram] /new failed:", e);
      await say(ctx.telegramChatId, "⚠️ Couldn't start a new conversation — please try again.");
      return;
    }
    await say(
      ctx.telegramChatId,
      "Started a new conversation. The previous one is still in the web app.",
    );
  }

  /**
   * `/compact` — summarize the thread and keep going in the same one. Takes the
   * turn lease: it costs a model call and rewrites what the next turn sends.
   */
  async function runCompactCommand(ctx: CommandCtx): Promise<void> {
    const compact = config.runtime.compactChat;
    if (!compact) {
      console.warn("[telegram] /compact used but runtime.compactChat not wired");
      await say(ctx.telegramChatId, "Compacting isn't available on this bot.");
      return;
    }
    await withTurnLease(ctx.chatId, ctx.telegramChatId, async () => {
      await api.sendChatAction(ctx.telegramChatId);
      try {
        const res = await compact({
          chatId: ctx.chatId,
          principal: ctx.principal,
          ...(ctx.command.args ? { focus: ctx.command.args } : {}),
        });
        if (!res) {
          await say(ctx.telegramChatId, "This conversation is short enough already.");
          return;
        }
        // Plain text on purpose: the summary is model output, so with parse_mode
        // set it would have to be escaped, and escaping AFTER truncating can push
        // the message back over Telegram's 4096-char limit (or split an entity)
        // — which would drop the reply entirely.
        await say(
          ctx.telegramChatId,
          `♻️ Compacted ${res.compacted} messages. Carrying forward:\n\n${truncate(
            res.summary,
            MAX_SUMMARY_CHARS,
          )}`,
        );
      } catch (e) {
        console.error("[telegram] /compact failed:", e);
        const m = e instanceof Error ? e.message : String(e);
        await say(ctx.telegramChatId, `⚠️ ${m.slice(0, 3000)}`);
        // Paused turn: show what it's waiting on, so the refusal is actionable.
        if (isPendingApprovalError(e)) {
          await renderPending(
            ctx.chatId,
            ctx.telegramChatId,
            ctx.telegramUserId,
            ctx.principal,
          ).catch((err) => console.error("[telegram] re-render pending failed:", err));
        }
      }
    });
  }

  /**
   * `/cancel` — get out of whatever the agent is waiting on. A questionnaire is
   * already dropped by the time we get here; approvals are denied, which lets the
   * agent wrap up instead of leaving the chat gated forever.
   */
  async function runCancelCommand(ctx: CommandCtx): Promise<void> {
    // The questionnaire is already gone (runTurn dropped it), so report that
    // BEFORE the lease: a busy chat would otherwise answer only "still working"
    // and the user would never learn their questions had been retired.
    if (ctx.droppedQuestions) {
      await say(ctx.telegramChatId, "Dropped those questions. What would you like to do instead?");
    }

    // Approvals, in contrast, are read and denied INSIDE the lease: a decision
    // built from a pre-lease read could name approvals a concurrent turn has
    // already moved past. If a turn is running the user gets "still working",
    // which is the honest answer — there'd be nothing to cancel yet anyway.
    await withTurnLease(ctx.chatId, ctx.telegramChatId, async () => {
      let approvals: ReturnType<typeof pendingApprovals> = [];
      try {
        approvals = pendingApprovals(
          await config.runtime.loadHistory({ chatId: ctx.chatId, principal: ctx.principal }),
        );
      } catch (e) {
        console.error("[telegram] /cancel history read failed:", e);
        await say(ctx.telegramChatId, "⚠️ Couldn't read this conversation — try again.");
        return;
      }
      // Nothing left to say when the questions were the thing being cancelled —
      // "Nothing to cancel." right after "Dropped those questions." contradicts it.
      if (!approvals.length) {
        if (!ctx.droppedQuestions) await say(ctx.telegramChatId, "Nothing to cancel.");
        return;
      }

      try {
        const res = await config.runtime.applyApproval({
          chatId: ctx.chatId,
          principal: ctx.principal,
          decisions: approvals.map((a) => ({ approvalId: a.approvalId, approved: false })),
        });
        await say(ctx.telegramChatId, `🚫 Denied ${approvals.map((a) => a.toolName).join(", ")}.`);
        await renderTelegramStream(consumeRun(res), { api, chatId: ctx.telegramChatId });
        await renderPending(ctx.chatId, ctx.telegramChatId, ctx.telegramUserId, ctx.principal);
      } catch (e) {
        console.error("[telegram] /cancel failed:", e);
        const m = e instanceof Error ? e.message : String(e);
        await say(ctx.telegramChatId, `⚠️ ${m.slice(0, 3000)}`);
      }
    });
  }

  /** `/status` — what this thread is and what it's waiting on. Read-only. */
  async function runStatusCommand(ctx: CommandCtx): Promise<void> {
    let history: AppMessage[] = [];
    try {
      history = await config.runtime.loadHistory({
        chatId: ctx.chatId,
        principal: ctx.principal,
      });
    } catch (e) {
      console.error("[telegram] /status history read failed:", e);
      await say(ctx.telegramChatId, "⚠️ Couldn't read this conversation.");
      return;
    }
    const approvals = pendingApprovals(history);
    const question = pendingQuestion(history);
    const waiting = approvals.length
      ? `approval for ${approvals.map((a) => a.toolName).join(", ")}`
      : question
        ? `${question.questions.length} question(s)`
        : "nothing";
    await say(
      ctx.telegramChatId,
      [
        `Agent: ${config.agent}`,
        // The epoch comes from `currentThread`, so the `_t<n>` id format stays
        // known in exactly one place.
        `Conversation: ${ctx.epoch > 0 ? `#${ctx.epoch + 1}` : "the first one"}`,
        `Messages: ${history.length}`,
        `Waiting on: ${waiting}`,
      ].join("\n"),
    );
  }

  /**
   * Every inline button lands here. Approvals and questionnaires use distinct
   * prefixes, so try both decoders — an undecodable payload is ignored, which is
   * why a new button type MUST be registered here or it silently does nothing.
   */
  async function runCallback(cb: TgCallbackQuery): Promise<void> {
    const approval = decodeApprovalCallback(cb.data);
    if (approval) return runApprovalCallback(cb, approval);
    const question = decodeQuestionCallback(cb.data);
    if (question) return runQuestionCallback(cb, question);
  }

  /** Resolve the identity behind a button press (it's authorized on its own). */
  async function callbackPrincipal(
    cb: TgCallbackQuery,
    telegramChatId: string,
  ): Promise<P | undefined> {
    try {
      const auth = await config.authorizeUser({
        telegramUserId: String(cb.from.id),
        ...(cb.from.username ? { username: cb.from.username } : {}),
        telegramChatId,
      });
      if (auth.allowed && auth.principal !== undefined) return auth.principal;
    } catch (e) {
      console.error("[telegram] callback auth failed:", e);
      return undefined;
    }
    await api
      .sendMessage({ chat_id: telegramChatId, text: "Link your Latch account first." })
      .catch(() => {});
    return undefined;
  }

  /** An option / Done tap on a questionnaire card. */
  async function runQuestionCallback(
    cb: TgCallbackQuery,
    decoded: QuestionCallback,
  ): Promise<void> {
    const telegramUserId = String(cb.from.id);
    const telegramChatId = String(cb.message?.chat.id ?? cb.from.id);
    // Unknown thread ⇒ we can't tell which session this tap belongs to. Ack with
    // the reason and leave the card alone so a retry still works.
    let chatId: string;
    try {
      chatId = await currentChatId(telegramUserId);
    } catch (e) {
      console.error("[telegram] thread lookup failed:", e);
      await api.answerCallbackQuery(cb.id, "Something went wrong — try again.");
      return;
    }

    const session = await config.askState?.get(chatId).catch(() => null);
    // Stale button: the session is gone (answered elsewhere, cancelled, expired)
    // or belongs to a newer questionnaire, or this card isn't the current
    // question. Retire the card instead of answering the wrong thing.
    const stale =
      !session ||
      session.nonce !== decoded.nonce ||
      session.cursor !== decoded.questionIndex;
    if (stale) {
      await api.answerCallbackQuery(
        cb.id,
        session ? "Already answered." : "This questionnaire is no longer active.",
      );
      if (cb.message) await stripKeyboard(telegramChatId, String(cb.message.message_id));
      return;
    }

    const principal = await callbackPrincipal(cb, telegramChatId);
    if (principal === undefined) {
      await api.answerCallbackQuery(cb.id);
      return;
    }

    const event: AskEvent =
      decoded.verb === "pick" ? { kind: "pick", option: decoded.optionIndex } : { kind: "done" };
    const { rejected, acked } = await answerQuestion({
      chatId,
      telegramChatId,
      telegramUserId,
      principal,
      session,
      event,
      ackCallbackId: cb.id,
      ...(cb.message ? { cardMessageId: cb.message.message_id } : {}),
    });
    // The resume path already acked (it outlives the query window); everything
    // else settles synchronously and gets its ack — with the reason, if rejected.
    if (!acked) await api.answerCallbackQuery(cb.id, rejected);
  }

  // ── Approve/Deny button → resume the run ────────────────────────────────────
  async function runApprovalCallback(
    cb: TgCallbackQuery,
    decoded: { approved: boolean; approvalId: string },
  ): Promise<void> {
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

    const principal = auth.principal;
    let chatId: string;
    try {
      chatId = await currentChatId(telegramUserId);
    } catch (e) {
      console.error("[telegram] thread lookup failed:", e);
      await api
        .sendMessage({ chat_id: telegramChatId, text: THREAD_UNAVAILABLE_MESSAGE })
        .catch(() => {});
      return;
    }

    // Resolve the tapped approval against fresh history BEFORE acting on it. Not
    // just for naming the card: a card left behind by a previous thread (`/new`)
    // or already decided in the web app points at an approval this chat no longer
    // has, and pushing it through would surface a raw "Unknown chat" error.
    let history: AppMessage[];
    try {
      history = await config.runtime.loadHistory({ chatId, principal });
    } catch (e) {
      // Couldn't tell live from stale. Say so and leave the card as it is —
      // retiring it on a transient read failure would strand a real approval
      // with no buttons left to resolve it.
      console.error("[telegram] approval history read failed:", e);
      await api
        .sendMessage({ chat_id: telegramChatId, text: "⚠️ Couldn't check that request — try again." })
        .catch(() => {});
      return;
    }
    const live = pendingApprovals(history).find((p) => p.approvalId === decoded.approvalId);
    if (!live) {
      if (cb.message) {
        await api
          .editMessageText({
            chat_id: cb.message.chat.id,
            message_id: cb.message.message_id,
            text: "This request is no longer active.",
          })
          .catch(() => {});
      }
      return;
    }
    const toolName = live.toolName;

    // The resume mutates the same run state as a fresh turn — take the lease
    // too, or an approval press racing a new message runs two turns at once.
    // If the chat is busy the buttons stay in place; the user presses again.
    await withTurnLease(chatId, telegramChatId, async () => {
      try {
        const res = await config.runtime.applyApproval({
          chatId,
          principal,
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
        // Continue rendering whatever the resume produced (chained approvals, or
        // a questionnaire the resumed turn went on to ask).
        await renderTelegramStream(consumeRun(res), { api, chatId: telegramChatId });
        await renderPending(chatId, telegramChatId, telegramUserId, principal);
      } catch (e) {
        console.error("[telegram] applyApproval failed:", e);
        const m = e instanceof Error ? e.message : String(e);
        await api
          .sendMessage({ chat_id: telegramChatId, text: `⚠️ ${m.slice(0, 3000)}` })
          .catch(() => {});
      }
    });
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

  // `replayMessage` is exposed so the host's post-link resume can replay a
  // stashed message (the gate already passed by linking; the lease is claimed).
  return { handleRequest, runMessage, replayMessage, api };
}
