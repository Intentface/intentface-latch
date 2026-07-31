import type { AppMessage } from "@intentface/latch-core";
import type { AskSession, AskStateStore, ChannelRunOps, Question } from "../types.js";
import { consumeRun, isPendingApprovalError, pendingApprovals, pendingQuestion } from "../render.js";
import { nextAskStep, type AskEvent } from "../ask.js";
import {
  whatsappApi,
  MAX_LIST_ROWS,
  MAX_REPLY_BUTTONS,
  type LazyString,
  type WhatsappApiOptions,
} from "./api.js";
import { verifyWhatsappSignature, whatsappVerifyChallenge } from "./verify.js";

/**
 * One agent's WhatsApp business number (Meta Cloud API). The host wires
 * `handleRequest` to the bot's per-bot webhook route; we handle Meta's GET
 * verify handshake, check the POST signature, ACK fast, and run the turn in
 * the background. WhatsApp messages cannot be edited, so the answer posts
 * once at the end (split across messages past the 4096-char cap) — unlike
 * Telegram's streaming edits.
 *
 * Same contract extension as the Telegram channel: `authorizeUser` RESOLVES
 * the linked platform user's principal (Slack's is a yes/no gate).
 */

const MAX_INLINE_FILE_BYTES = 10 * 1024 * 1024;
const MAX_WHATSAPP_TEXT_CHARS = 4096;
const STILL_WORKING_MESSAGE = "I am still working on the previous message in this chat.";

export interface WhatsappAuthResult<P> {
  allowed: boolean;
  principal?: P;
  linkUrl?: string;
  message?: string;
}

export interface WhatsappChannelConfig<P> {
  /** The agent this number serves. */
  agent: string;
  /** Stable host-side bot id — used in chat ids (`whatsapp_<botRef>_<waId>`) and delivery keys. */
  botRef: string;
  /** Meta credentials, all lazily resolvable from the host's vault. */
  accessToken: LazyString;
  phoneNumberId: LazyString;
  appSecret: LazyString;
  verifyToken: LazyString;
  runtime: ChannelRunOps<P>;
  /** Resolve the inbound WhatsApp user (`wa_id`) to a platform principal. */
  authorizeUser: (user: {
    waId: string;
    profileName?: string;
  }) => Promise<WhatsappAuthResult<P>>;
  /** Persistent dedupe on `<botRef>:<waId>:<wamid>` (Meta re-delivers webhooks). */
  seen?: (deliveryKey: string) => Promise<boolean>;
  /**
   * Host-backed one-turn-per-chat guard: a claimant token when the lease was
   * acquired, null when a turn is already running. The token fences the
   * release against a newer claimant (see the Telegram channel).
   */
  claimTurn?: (chatId: string) => Promise<string | null>;
  releaseTurn?: (chatId: string, token: string) => Promise<void>;
  /** Stash the message that triggered a link prompt, to replay after linking. */
  stashPending?: (input: {
    waId: string;
    profileName?: string;
    text: string;
    media?: { ref: WaMediaRef; mediaType: string; name: string }[];
  }) => Promise<void>;
  /** Build the platform authorize URL for a `connect_<name>` OAuth approval. */
  authorizeUrl?: (
    connectionName: string,
    ctx: { chatId: string; waId: string; approvalId: string },
  ) => string;
  /**
   * Host storage for in-flight `askUser` questionnaires (see the Telegram
   * channel). Without it questions are posted as plain text and the turn stays
   * paused, answerable in the web app.
   */
  askState?: AskStateStore;
  waitUntil?: (p: Promise<unknown>) => void;
  /** Test seam: base URL / fetch for the Graph API client. */
  apiOptions?: WhatsappApiOptions;
}

// ── Webhook payload shapes (the slice we read) ──────────────────────────────

export interface WaMediaRef {
  id: string;
  mime_type?: string;
  filename?: string;
  caption?: string;
}

interface WaMessage {
  from: string; // wa_id
  id: string; // wamid
  type: string;
  text?: { body: string };
  image?: WaMediaRef;
  document?: WaMediaRef;
  audio?: WaMediaRef;
  video?: WaMediaRef;
  interactive?: {
    type?: string;
    button_reply?: { id: string; title?: string };
    list_reply?: { id: string; title?: string };
  };
}

interface WaChangeValue {
  messaging_product?: string;
  metadata?: { phone_number_id?: string; display_phone_number?: string };
  contacts?: { wa_id: string; profile?: { name?: string } }[];
  messages?: WaMessage[];
}

interface WaWebhookBody {
  object?: string;
  entry?: { changes?: { field?: string; value?: WaChangeValue }[] }[];
}

// Approval button ids reuse the Telegram encoding (interactive reply ids allow 256 chars).
const CALLBACK_RE = /^lta:([01])\|(.+)$/;

export function encodeWhatsappApprovalId(approved: boolean, approvalId: string): string {
  return `lta:${approved ? 1 : 0}|${approvalId}`;
}

export function decodeWhatsappApprovalId(
  id: string | undefined,
): { approved: boolean; approvalId: string } | null {
  if (!id) return null;
  const m = CALLBACK_RE.exec(id);
  if (!m) return null;
  return { approved: m[1] === "1", approvalId: m[2]! };
}

// Questionnaire ids use the same `ltq:` wire format as Telegram (reply ids allow
// 256 chars, so there's no budget pressure here — sharing the format keeps the
// two channels' encoders from drifting).
const QUESTION_RE = /^ltq:([sd])\|([^|]+)\|(\d+)(?:\|(\d+))?$/;

export type WhatsappQuestionReply =
  | { verb: "pick"; nonce: string; questionIndex: number; optionIndex: number }
  | { verb: "done"; nonce: string; questionIndex: number };

export function encodeWhatsappQuestionId(cb: WhatsappQuestionReply): string {
  const tail = cb.verb === "pick" ? `|${cb.optionIndex}` : "";
  return `ltq:${cb.verb === "pick" ? "s" : "d"}|${cb.nonce}|${cb.questionIndex}${tail}`;
}

export function decodeWhatsappQuestionId(id: string | undefined): WhatsappQuestionReply | null {
  if (!id) return null;
  const m = QUESTION_RE.exec(id);
  if (!m) return null;
  const nonce = m[2]!;
  const questionIndex = Number(m[3]);
  if (m[1] === "d") return { verb: "done", nonce, questionIndex };
  if (m[4] === undefined) return null;
  return { verb: "pick", nonce, questionIndex, optionIndex: Number(m[4]) };
}

function newNonce(): string {
  const uuid = globalThis.crypto?.randomUUID?.() ?? String(Math.random());
  return uuid.replace(/[^a-z0-9]/gi, "").slice(0, 6);
}

/** Question body text: the question plus numbered options (typed "2" answers it). */
function questionBody(q: Question, index: number, total: number, numbered: boolean): string {
  const head = total > 1 ? `*Question ${index + 1} of ${total}*\n` : "";
  const title = q.header ? `_${q.header}_\n${q.question}` : q.question;
  if (!numbered) return `${head}${title}`;
  const opts = q.options.map((o, i) => `${i + 1}. ${o.label}`).join("\n");
  const how = q.multiSelect
    ? "\n\nReply with the numbers you want, e.g. 1,3"
    : "\n\nReply with a number, or just tell me in your own words.";
  return `${head}${title}\n\n${opts}${how}`;
}

/** Split text into ≤`max`-char messages, preferring paragraph/line breaks. */
export function splitWhatsappText(text: string, max = MAX_WHATSAPP_TEXT_CHARS): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"));
    const at = cut > max * 0.5 ? cut : max;
    out.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest.trim()) out.push(rest);
  return out;
}

const ok = () => new Response(null, { status: 200 });

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `m_${Date.now()}_${Math.round(Math.random() * 1e9)}`;
}

function mediaRefs(msg: WaMessage): { ref: WaMediaRef; mediaType: string; name: string }[] {
  const out: { ref: WaMediaRef; mediaType: string; name: string }[] = [];
  if (msg.image) out.push({ ref: msg.image, mediaType: msg.image.mime_type ?? "image/jpeg", name: "photo.jpg" });
  if (msg.document)
    out.push({
      ref: msg.document,
      mediaType: msg.document.mime_type ?? "application/octet-stream",
      name: msg.document.filename ?? "document",
    });
  if (msg.audio) out.push({ ref: msg.audio, mediaType: msg.audio.mime_type ?? "audio/ogg", name: "audio.ogg" });
  if (msg.video) out.push({ ref: msg.video, mediaType: msg.video.mime_type ?? "video/mp4", name: "video.mp4" });
  return out;
}

export function whatsappChannel<P>(config: WhatsappChannelConfig<P>) {
  const api = whatsappApi(
    { accessToken: config.accessToken, phoneNumberId: config.phoneNumberId },
    config.apiOptions,
  );

  const defer = (p: Promise<unknown>) => (config.waitUntil ? config.waitUntil(p) : p);

  async function resolveLazy(v: LazyString): Promise<string> {
    return typeof v === "function" ? v() : v;
  }

  /** chatId for a WhatsApp conversation — continuity is per (bot, wa_id). */
  const chatIdFor = (waId: string) => `whatsapp_${config.botRef}_${waId}`;

  /**
   * Run `fn` under the one-turn-per-chat lease. Every path that mutates a
   * chat's run state — fresh turns, post-link replays AND approval resumes —
   * goes through here, so two of them can never interleave on one chat. When
   * the lease is taken the user gets the "still working" notice instead.
   */
  async function withTurnLease(chatId: string, waId: string, fn: () => Promise<void>): Promise<void> {
    let lease: string | undefined;
    if (config.claimTurn) {
      const token = await config.claimTurn(chatId);
      if (!token) {
        await api.sendText(waId, STILL_WORKING_MESSAGE).catch(() => {});
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

  /** Fold a run into ONE reply (or several, past the length cap) + approvals. */
  async function renderRun(res: Response, ctx: { waId: string; chatId: string; principal: P }) {
    let text = "";
    let errorMessage: string | undefined;
    try {
      for await (const ev of consumeRun(res)) {
        if (ev.type === "text-delta") text += ev.text;
        else if (ev.type === "error") errorMessage = ev.message;
      }
    } catch (e) {
      console.error("[whatsapp] render stream failed:", e);
      errorMessage = e instanceof Error ? e.message : String(e);
    }

    let body = text.trim();
    if (errorMessage) body += `${body ? "\n\n" : ""}⚠️ ${errorMessage.slice(0, 500)}`;
    for (const chunk of splitWhatsappText(body)) {
      await api.sendText(ctx.waId, chunk);
    }
    if (errorMessage) return; // a failed turn has nothing new to decide
    await renderPending(ctx);
  }

  /**
   * Post whatever the turn is parked on. Approvals win over questionnaires: a
   * gated tool blocks the run, so answering questions first would go nowhere.
   */
  async function renderPending(ctx: {
    waId: string;
    chatId: string;
    principal: P;
  }): Promise<void> {
    const history = await config.runtime.loadHistory({
      chatId: ctx.chatId,
      principal: ctx.principal,
    });
    const approvals = pendingApprovals(history);
    await renderApprovals(approvals, ctx);
    if (approvals.length) return;
    await renderQuestions(pendingQuestion(history), ctx);
  }

  async function renderApprovals(
    approvals: ReturnType<typeof pendingApprovals>,
    ctx: { waId: string; chatId: string; principal: P },
  ): Promise<void> {
    for (const pa of approvals) {
      if (pa.isConnect && pa.connectionName && config.authorizeUrl) {
        const url = config.authorizeUrl(pa.connectionName, {
          chatId: ctx.chatId,
          waId: ctx.waId,
          approvalId: pa.approvalId,
        });
        await api.sendText(ctx.waId, `Connect ${pa.connectionName} to continue:\n${url}`);
      } else {
        let json: string;
        try {
          json = JSON.stringify(pa.input, null, 2) ?? String(pa.input);
        } catch {
          json = String(pa.input);
        }
        if (json.length > 800) json = `${json.slice(0, 800)}\n… (truncated)`;
        await api.sendReplyButtons(ctx.waId, `🔒 Approve ${pa.toolName}?\n\n${json}`, [
          { id: encodeWhatsappApprovalId(true, pa.approvalId), title: "✅ Approve" },
          { id: encodeWhatsappApprovalId(false, pa.approvalId), title: "🚫 Deny" },
        ]);
      }
    }
  }

  // ── Questionnaires (askUser) ───────────────────────────────────────────────

  /**
   * Post one question with the best affordance Meta allows: reply buttons up to
   * 3 options, a tappable list up to 10, otherwise a numbered text prompt.
   *
   * Multi-select always falls back to numbers: WhatsApp cannot edit a sent
   * message, so there's no way to tick options in place the way Telegram does.
   */
  async function sendQuestion(session: AskSession): Promise<void> {
    const q = session.questions[session.cursor];
    if (!q) return;
    const total = session.questions.length;
    const id = (optionIndex: number) =>
      encodeWhatsappQuestionId({
        verb: "pick",
        nonce: session.nonce,
        questionIndex: session.cursor,
        optionIndex,
      });

    if (!q.multiSelect && q.options.length <= MAX_REPLY_BUTTONS) {
      await api.sendReplyButtons(
        session.promptChatId,
        questionBody(q, session.cursor, total, false),
        q.options.map((o, i) => ({ id: id(i), title: o.label })),
      );
      return;
    }
    if (!q.multiSelect && q.options.length <= MAX_LIST_ROWS) {
      await api.sendList(
        session.promptChatId,
        questionBody(q, session.cursor, total, false),
        "Choose",
        q.options.map((o, i) => ({ id: id(i), title: o.label, description: o.description })),
      );
      return;
    }
    await api.sendText(session.promptChatId, questionBody(q, session.cursor, total, true));
  }

  /** Prompt the parked questionnaire, or retire a session that's no longer live. */
  async function renderQuestions(
    pending: { toolCallId: string; questions: Question[] } | null,
    ctx: { waId: string; chatId: string; principal: P },
  ): Promise<void> {
    const store = config.askState;
    if (!pending) {
      await store?.clear(ctx.chatId).catch(() => null);
      return;
    }
    if (!store) {
      console.warn("[whatsapp] askUser pending but no askState configured — posting as text");
      for (const [i, q] of pending.questions.entries()) {
        await api
          .sendText(ctx.waId, questionBody(q, i, pending.questions.length, true))
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
      promptChatId: ctx.waId,
    };
    if ((await store.begin(ctx.chatId, session)) === "already") return;
    try {
      await sendQuestion({ ...session, rev: 0 });
    } catch (e) {
      // No prompt reached the user, so nothing is on screen to answer. Retire
      // the session or their next message gets eaten as an answer to a question
      // they never saw, with `/cancel` the only way out.
      await store.clear(ctx.chatId).catch(() => null);
      throw e;
    }
  }

  /**
   * Apply one questionnaire interaction. Only the final answer runs the agent,
   * so only that path takes the turn lease.
   */
  async function answerQuestion(ctx: {
    waId: string;
    chatId: string;
    principal: P;
    session: AskSession;
    event: AskEvent;
  }): Promise<void> {
    const store = config.askState;
    if (!store) return;
    const { session } = ctx;
    const step = nextAskStep(session, ctx.event);

    if (step.kind === "rejected") {
      await api.sendText(ctx.waId, step.reason).catch(() => {});
      return;
    }
    if (step.kind === "toggled") {
      // Unreachable in practice: multi-select is answered by a numbered reply
      // here, never by per-option taps, since messages can't be edited.
      await store
        .update(ctx.chatId, session.toolCallId, session.rev, { selected: step.selected })
        .catch(() => null);
      return;
    }

    if (step.kind === "advanced") {
      const rev = await store.update(ctx.chatId, session.toolCallId, session.rev, {
        cursor: step.cursor,
        answers: step.answers,
        selected: [],
      });
      if (rev === null) return; // a racing delivery already advanced this
      await api.sendText(ctx.waId, `✓ ${step.answered.answer}`).catch(() => {});
      await sendQuestion({
        ...session,
        cursor: step.cursor,
        answers: step.answers,
        selected: [],
        rev,
      });
      return;
    }

    // Nothing to submit through — bail BEFORE consuming the session, so the
    // collected answers survive a misconfigured host.
    const submit = config.runtime.applyToolResult;
    if (!submit) {
      console.error("[whatsapp] runtime.applyToolResult not wired — cannot resume askUser");
      return;
    }

    // Final answer: claim the lease BEFORE consuming the session, so a busy chat
    // leaves the answers recoverable instead of destroying them.
    await withTurnLease(ctx.chatId, ctx.waId, async () => {
      if (!(await store.finish(ctx.chatId, session.toolCallId, session.rev))) return;
      await api.sendText(ctx.waId, `✓ ${step.answered.answer}`).catch(() => {});
      try {
        const res = await submit({
          chatId: ctx.chatId,
          principal: ctx.principal,
          toolCallId: session.toolCallId,
          output: step.output,
        });
        await renderRun(res, ctx);
      } catch (e) {
        console.error("[whatsapp] applyToolResult failed:", e);
        const m = e instanceof Error ? e.message : String(e);
        await api.sendText(ctx.waId, `⚠️ ${m.slice(0, 3000)}`).catch(() => {});
      }
    });
  }

  /**
   * Run one user message against the agent — WITHOUT the auth gate or turn
   * claim (callers handle those). Also used by the host's post-link resume.
   */
  async function runMessage(ctx: {
    waId: string;
    text: string;
    media?: { ref: WaMediaRef; mediaType: string; name: string }[];
    principal: P;
  }): Promise<void> {
    const chatId = chatIdFor(ctx.waId);

    const fileParts: { type: "file"; mediaType: string; filename: string; url: string }[] = [];
    const skipped: string[] = [];
    for (const m of ctx.media ?? []) {
      try {
        const info = await api.getMediaInfo(m.ref.id);
        if (!info.url || (info.fileSize ?? 0) > MAX_INLINE_FILE_BYTES) {
          skipped.push(m.name);
          continue;
        }
        const bytes = await api.downloadMedia(info.url);
        const mediaType = info.mimeType ?? m.mediaType;
        fileParts.push({
          type: "file",
          mediaType,
          filename: m.name,
          url: `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`,
        });
      } catch (e) {
        console.error(`[whatsapp] media download failed (${m.name}):`, e);
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
      await renderRun(res, { waId: ctx.waId, chatId, principal: ctx.principal });
    } catch (e) {
      console.error("[whatsapp] runMessage failed:", e);
      const m = e instanceof Error ? e.message : String(e);
      await api.sendText(ctx.waId, `⚠️ ${m.slice(0, 3000)}`).catch(() => {});
      // Refused because a decision is still outstanding — re-post the card, or
      // the chat is a dead end: the same refusal every turn, no way to clear it.
      if (isPendingApprovalError(e)) {
        await renderPending({ waId: ctx.waId, chatId, principal: ctx.principal }).catch((err) =>
          console.error("[whatsapp] re-render pending failed:", err),
        );
      }
    }
  }

  /**
   * Replay one message under the turn lease — the post-link resume path. The
   * auth gate already passed (the user just linked), but the lease must still
   * be honored so a racing webhook message can't start a concurrent run.
   */
  async function replayMessage(ctx: {
    waId: string;
    text: string;
    media?: { ref: WaMediaRef; mediaType: string; name: string }[];
    principal: P;
  }): Promise<void> {
    await withTurnLease(chatIdFor(ctx.waId), ctx.waId, () => runMessage(ctx));
  }

  // ── Inbound message → one agent turn ───────────────────────────────────────
  async function runTurn(msg: WaMessage, value: WaChangeValue): Promise<void> {
    const waId = msg.from;
    const profileName = value.contacts?.find((c) => c.wa_id === waId)?.profile?.name;

    if (config.seen) {
      const key = `${config.botRef}:${waId}:${msg.id}`;
      if (await config.seen(key)) {
        console.log(`[whatsapp] duplicate delivery ${key} — dropped`);
        return;
      }
    }

    // Approval button replies resume a paused run instead of starting a turn.
    const replyId = msg.interactive?.button_reply?.id ?? msg.interactive?.list_reply?.id;
    const decision = decodeWhatsappApprovalId(replyId);
    if (decision) {
      await runDecision(waId, profileName, decision);
      return;
    }
    // A questionnaire option tap (reply button or list row).
    const questionReply = decodeWhatsappQuestionId(replyId);

    const text = (msg.text?.body ?? msg.image?.caption ?? msg.document?.caption ?? "").trim();
    const media = mediaRefs(msg);
    if (!questionReply && !text && media.length === 0) return;

    let auth: WhatsappAuthResult<P>;
    try {
      auth = await config.authorizeUser({
        waId,
        ...(profileName ? { profileName } : {}),
      });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      await api.sendText(waId, `⚠️ auth check failed: ${m.slice(0, 500)}`).catch(() => {});
      return;
    }

    if (!auth.allowed || auth.principal === undefined) {
      await config
        .stashPending?.({
          waId,
          ...(profileName ? { profileName } : {}),
          text,
          ...(media.length ? { media } : {}),
        })
        .catch((e) => console.error("[whatsapp] stashPending failed:", e));
      const base = auth.message ?? "You need a Latch account to use this agent.";
      const body = auth.linkUrl ? `${base}\n\nLink your Latch account: ${auth.linkUrl}` : base;
      await api.sendText(waId, body).catch((e) => console.error("[whatsapp] link notice failed:", e));
      return;
    }

    const principal = auth.principal;
    const chatId = chatIdFor(waId);

    // With a questionnaire on screen, an option tap or a plain reply answers the
    // current question rather than starting a turn. Downstream of `seen()` so a
    // redelivered update can't be applied as a second answer.
    if (config.askState) {
      const session = await config.askState.get(chatId).catch(() => null);
      if (session) {
        const stale =
          questionReply &&
          (session.nonce !== questionReply.nonce ||
            session.cursor !== questionReply.questionIndex);
        if (stale) {
          await api.sendText(waId, "That question was already answered.").catch(() => {});
          return;
        }
        if (questionReply) {
          await answerQuestion({
            waId,
            chatId,
            principal,
            session,
            event:
              questionReply.verb === "pick"
                ? { kind: "pick", option: questionReply.optionIndex }
                : { kind: "done" },
          });
          return;
        }
        const command = text.startsWith("/");
        // Media is never an answer: treating a captioned image as one would
        // silently drop the file, since answers are plain text. Let it fall
        // through to a normal turn so the attachment actually reaches the agent.
        if (!command && text && media.length === 0) {
          await answerQuestion({ waId, chatId, principal, session, event: { kind: "typed", text } });
          return;
        }
        // A command, or a message carrying media — not an answer. Drop the questionnaire.
        await config.askState.clear(chatId).catch(() => {});
        if (command && /^\/(cancel|skip)\b/.test(text)) {
          await api
            .sendText(waId, "Dropped those questions. What would you like to do instead?")
            .catch(() => {});
          return;
        }
      } else if (questionReply) {
        // Tapped a button whose questionnaire is gone (answered elsewhere, expired).
        await api.sendText(waId, "That questionnaire is no longer active.").catch(() => {});
        return;
      }
    }

    await withTurnLease(chatId, waId, () => runMessage({ waId, text, media, principal }));
  }

  // ── Approve/Deny button reply → resume the run ──────────────────────────────
  async function runDecision(
    waId: string,
    profileName: string | undefined,
    decision: { approved: boolean; approvalId: string },
  ): Promise<void> {
    let auth: WhatsappAuthResult<P>;
    try {
      auth = await config.authorizeUser({ waId, ...(profileName ? { profileName } : {}) });
    } catch (e) {
      console.error("[whatsapp] decision auth failed:", e);
      return;
    }
    if (!auth.allowed || auth.principal === undefined) {
      await api.sendText(waId, "Link your Latch account first.").catch(() => {});
      return;
    }
    const chatId = chatIdFor(waId);
    const principal = auth.principal;
    // The resume mutates the same run state as a fresh turn — take the lease
    // too, or an approval reply racing a new message runs two turns at once.
    // If the chat is busy the buttons stay in place; the user replies again.
    await withTurnLease(chatId, waId, async () => {
      try {
        const res = await config.runtime.applyApproval({
          chatId,
          principal,
          decisions: [{ approvalId: decision.approvalId, approved: decision.approved }],
        });
        await renderRun(res, { waId, chatId, principal });
      } catch (e) {
        console.error("[whatsapp] applyApproval failed:", e);
        const m = e instanceof Error ? e.message : String(e);
        await api.sendText(waId, `⚠️ ${m.slice(0, 3000)}`).catch(() => {});
      }
    });
  }

  // ── The per-bot webhook entrypoint (GET verify + POST events) ──────────────
  async function handleRequest(request: Request): Promise<Response> {
    if (request.method === "GET") {
      const challenge = whatsappVerifyChallenge(
        new URL(request.url),
        await resolveLazy(config.verifyToken),
      );
      return challenge !== null
        ? new Response(challenge, { status: 200, headers: { "content-type": "text/plain" } })
        : new Response("verification failed", { status: 403 });
    }

    const raw = await request.text();
    const valid = verifyWhatsappSignature({
      appSecret: await resolveLazy(config.appSecret),
      rawBody: raw,
      signature: request.headers.get("x-hub-signature-256"),
    });
    if (!valid) return new Response("invalid signature", { status: 401 });

    let body: WaWebhookBody;
    try {
      body = JSON.parse(raw || "{}") as WaWebhookBody;
    } catch {
      return ok();
    }
    if (body.object !== "whatsapp_business_account") return ok();

    // One Meta app/WABA can deliver events for MULTIPLE registered numbers to
    // the same endpoint — only dispatch changes addressed to OUR number, or a
    // message for a sibling number would run this bot's agent and reply
    // through this binding.
    const ourPhoneNumberId = await resolveLazy(config.phoneNumberId);
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== "messages" || !change.value) continue;
        const recipient = change.value.metadata?.phone_number_id;
        if (recipient && recipient !== ourPhoneNumberId) {
          console.log(
            `[whatsapp] change for phone_number_id ${recipient} ignored (bot ${config.botRef} serves ${ourPhoneNumberId})`,
          );
          continue;
        }
        for (const msg of change.value.messages ?? []) {
          defer(runTurn(msg, change.value));
        }
        // statuses[] (delivery receipts) are intentionally ignored.
      }
    }
    return ok();
  }

  // `replayMessage` is exposed so the host's post-link resume can replay a
  // stashed message (the gate already passed by linking; the lease is claimed).
  return { handleRequest, runMessage, replayMessage, api };
}
