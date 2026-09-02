import type { AppMessage } from "@intentface/latch-core";
import type {
  AskSession,
  AskStateStore,
  AuthResult,
  ChannelRunOps,
  ChannelThreadStore,
  PendingApproval,
  Question,
  TranscribeAudio,
} from "./types.js";
import { consumeRun, isChatBusyError, isPendingApprovalError, pendingApprovals, pendingQuestion } from "./render.js";
import { nextAskStep, type AskEvent } from "./ask.js";
import {
  CHANNEL_COMMANDS,
  helpText,
  parseCommand,
  THREAD_CHANGING_COMMANDS,
  type ParsedCommand,
} from "./commands.js";

/**
 * The turn kernel — everything a direct-message surface (Telegram, WhatsApp,
 * the next one) does between "a webhook arrived" and "the platform API was
 * called", written once:
 *
 *   dedupe → identity gate (+ stash & link notice) → thread epoch → commands
 *   → questionnaire answers → one-turn-per-chat lease → media fold → run
 *   → post the answer at finish → render what the turn parked on
 *   (approvals, then questions) → button taps back into the run.
 *
 * A {@link Surface} is pure protocol: how to send text, buttons and links, how
 * to edit or retire a card, how to download an attachment. It never sees the
 * runtime, the stores or the state machine, so a new platform is a Surface plus
 * a webhook parser that produces {@link Inbound} events — never a re-derivation
 * of the admission and questionnaire semantics.
 *
 * Answers post ONCE at finish (split past the platform's length cap). No
 * progressive edits: the only progress signal is the surface's typing hint.
 */

// ── Inbound events (what a webhook parser produces) ─────────────────────────

/** An attachment reference as the platform delivered it, plus what we know about it. */
export interface InboundMedia<Ref> {
  ref: Ref;
  mediaType: string;
  name: string;
}

export type Inbound<User, Ref> =
  | {
      kind: "message";
      user: User;
      text: string;
      media: InboundMedia<Ref>[];
      /** Persistent-dedupe key; platforms redeliver until they see a 2xx. */
      deliveryKey: string;
    }
  | {
      kind: "action";
      user: User;
      /** The button payload — one of the strings the kernel handed the surface. */
      data: string;
      deliveryKey: string;
      /** The tapped card's platform ref, when the platform reports it. */
      card?: string;
      /** Platform ack handle (Telegram callback_query id) — acked via `Surface.ack`. */
      ackId?: string;
    };

// ── The surface contract ────────────────────────────────────────────────────

/** Button payloads the surface attaches to a question card. */
export interface QuestionData {
  pick(optionIndex: number): string;
  done: string;
}

export interface Surface<User, Ref> {
  /** Platform name — the log prefix; also conventionally the chat-id prefix. */
  kind: string;
  /** Longest message the platform accepts; longer answers are split at paragraph breaks. */
  maxTextChars: number;
  /** The Latch chat id for this person at a thread epoch (0 = the original, un-suffixed id). */
  chatId(user: User, epoch: number): string;
  /**
   * Send a message. `rich` marks agent output (GitHub-flavoured markdown) the
   * surface may format natively. Returns the card ref when the platform has one.
   */
  sendText(user: User, text: string, opts?: { rich?: boolean }): Promise<string | undefined>;
  /** A message whose point is a URL to open (identity link, OAuth connect). */
  sendLink(user: User, body: string, label: string, url: string): Promise<void>;
  /** Approve/Deny prompt. A tap comes back as an `action` carrying `data.approve` / `data.deny`. */
  sendApproval(
    user: User,
    approval: PendingApproval,
    data: { approve: string; deny: string },
  ): Promise<string | undefined>;
  /**
   * Post the question at `session.cursor`. Without `data` (no host ask-state)
   * post the numbered text form — there is nothing to tap.
   */
  sendQuestion(user: User, session: AskSession, data?: QuestionData): Promise<string | undefined>;
  /** Re-tick a multi-select card in place. Surfaces that cannot edit omit it. */
  updateQuestion?(user: User, card: string, session: AskSession, data: QuestionData): Promise<void>;
  /** Show that a question was answered — collapse the card, or post a receipt. */
  answered(
    user: User,
    card: string | undefined,
    answered: { question: string; answer: string },
  ): Promise<void>;
  /** Replace a card's content (approval settled / no longer active). Omit where messages can't be edited. */
  settleCard?(user: User, card: string, text: string, opts?: { rich?: boolean }): Promise<void>;
  /** Remove a card's buttons without changing its text. */
  retireCard?(user: User, card: string): Promise<void>;
  /** Progress hint ("typing…"), refreshed every few seconds while a turn runs. */
  typing?(user: User): Promise<void>;
  /** Acknowledge a button tap, optionally with a toast. */
  ack?(ackId: string, text?: string): Promise<void>;
  /** Download an attachment, or null when it's unavailable or larger than `maxBytes`. */
  fetchMedia(
    media: InboundMedia<Ref>,
    maxBytes: number,
  ): Promise<{ bytes: Uint8Array; mediaType: string } | null>;
}

// ── Host contract ───────────────────────────────────────────────────────────

export interface KernelConfig<P, User, Ref> {
  /** The agent this bot serves. */
  agent: string;
  /** Stable host-side bot id — the chat-id namespace and the dedupe-key prefix. */
  botRef: string;
  runtime: ChannelRunOps<P>;
  /**
   * Resolve the inbound platform user to a principal. `{ allowed: false, linkUrl }`
   * refuses and sends a link; the triggering message is stashed for replay.
   */
  authorizeUser: (user: User) => Promise<AuthResult<P>>;
  /** Persistent dedupe: true if this delivery key was already handled. */
  seen?: (deliveryKey: string) => Promise<boolean>;
  /**
   * Host-backed one-turn-per-chat lease: a claimant token, or null when a turn
   * is already running (→ "still working"). The token fences the release.
   */
  claimTurn?: (chatId: string) => Promise<string | null>;
  releaseTurn?: (chatId: string, token: string) => Promise<void>;
  /** Stash the message that triggered a link prompt, to replay after linking. */
  stashPending?: (input: { user: User; text: string; media?: InboundMedia<Ref>[] }) => Promise<void>;
  /** Build the platform authorize URL for a `connect_<name>` OAuth approval. */
  authorizeUrl?: (
    connectionName: string,
    ctx: { chatId: string; user: User; approvalId: string },
  ) => string;
  /**
   * Host speech-to-text. Voice/audio reaches the agent as `[Voice message]: …`
   * text — never a file part (chat models generally reject audio). Without it,
   * voice-only messages get a friendly refusal.
   */
  transcribe?: TranscribeAudio;
  /** Storage for in-flight questionnaires; without it questions post as text and stay answerable in the web app. */
  askState?: AskStateStore;
  /** Storage for the thread epoch — what makes `/new` possible on a one-conversation surface. */
  thread?: ChannelThreadStore;
  /** Attachments above this are skipped with a note (default 10 MB). */
  maxInlineFileBytes?: number;
}

// ── Button payload codecs (shared wire format across surfaces) ──────────────
// Approvals: `lta:<0|1>|<approvalId>`. Questionnaires carry ordinals only —
// `ltq:<s|d>|<nonce>|<questionIndex>[|<optionIndex>]` — because Telegram caps
// callback_data at 64 bytes and a provider toolCallId alone would crowd it; the
// nonce pins a tap to the questionnaire that was posted.

export function encodeApprovalData(approved: boolean, approvalId: string): string {
  return `lta:${approved ? 1 : 0}|${approvalId}`;
}

export function decodeApprovalData(
  data: string | undefined,
): { approved: boolean; approvalId: string } | null {
  if (!data) return null;
  const m = /^lta:([01])\|(.+)$/.exec(data);
  if (!m) return null;
  return { approved: m[1] === "1", approvalId: m[2]! };
}

/** Length of the session nonce carried in button payloads. */
export const ASK_NONCE_LENGTH = 6;

export type QuestionPayload =
  | { verb: "pick"; nonce: string; questionIndex: number; optionIndex: number }
  | { verb: "done"; nonce: string; questionIndex: number };

export function encodeQuestionData(cb: QuestionPayload): string {
  const tail = cb.verb === "pick" ? `|${cb.optionIndex}` : "";
  return `ltq:${cb.verb === "pick" ? "s" : "d"}|${cb.nonce}|${cb.questionIndex}${tail}`;
}

export function decodeQuestionData(data: string | undefined): QuestionPayload | null {
  if (!data) return null;
  const m = /^ltq:([sd])\|([^|]+)\|(\d+)(?:\|(\d+))?$/.exec(data);
  if (!m) return null;
  const nonce = m[2]!;
  const questionIndex = Number(m[3]);
  if (m[1] === "d") return { verb: "done", nonce, questionIndex };
  if (m[4] === undefined) return null;
  return { verb: "pick", nonce, questionIndex, optionIndex: Number(m[4]) };
}

// ── Small shared helpers ────────────────────────────────────────────────────

export function newMessageId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `m_${Date.now()}_${Math.round(Math.random() * 1e9)}`;
}

/** Short random token pinning button payloads to one posted questionnaire. */
export function newNonce(): string {
  const uuid = globalThis.crypto?.randomUUID?.() ?? String(Math.random());
  return uuid.replace(/[^a-z0-9]/gi, "").slice(0, ASK_NONCE_LENGTH);
}

/** Split text into ≤`max`-char messages, preferring paragraph/line breaks. */
export function splitText(text: string, max: number): string[] {
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

/**
 * Run `fn` under the one-turn-per-chat lease. Every path that mutates a chat's
 * run state — fresh turns, replays, approval resumes, questionnaire submits —
 * goes through here, so two of them can never interleave on one chat. When the
 * lease is held, `onBusy` runs instead (the "still working" notice).
 */
export async function withTurnLease(
  lease: {
    claimTurn?: (chatId: string) => Promise<string | null>;
    releaseTurn?: (chatId: string, token: string) => Promise<void>;
  },
  chatId: string,
  onBusy: () => Promise<unknown>,
  fn: () => Promise<void>,
): Promise<void> {
  let token: string | undefined;
  if (lease.claimTurn) {
    const t = await lease.claimTurn(chatId);
    if (!t) {
      await onBusy().catch(() => {});
      return;
    }
    token = t;
  }
  try {
    await fn();
  } finally {
    if (token) await lease.releaseTurn?.(chatId, token).catch(() => {});
  }
}

const MAX_INLINE_FILE_BYTES = 10 * 1024 * 1024;
const STILL_WORKING_MESSAGE = "I am still working on the previous message in this chat.";
const TRANSCRIBE_FAILED_MESSAGE =
  "⚠️ Couldn't transcribe your voice message — please try again or type it instead.";
const THREAD_UNAVAILABLE_MESSAGE =
  "⚠️ Couldn't work out which conversation this belongs to — please send that again.";
const LINK_FIRST_MESSAGE = "Link your Latch account first.";
const NOT_ACTIVE_MESSAGE = "This request is no longer active.";
/** How much of a compaction summary `/compact` echoes back. */
const MAX_SUMMARY_CHARS = 2000;
/** Typing hints expire after ~5s on every platform that has them. */
const TYPING_REFRESH_MS = 4000;

const truncate = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ── The kernel ──────────────────────────────────────────────────────────────

export interface TurnKernel<P, User, Ref> {
  /** Route one parsed webhook event. Runs post-ACK (the caller defers it). */
  handleInbound(ev: Inbound<User, Ref>): Promise<void>;
  /**
   * Run one user message against the agent and render it — WITHOUT the auth
   * gate or turn lease (callers hold those). `chatId` skips the thread lookup
   * when the caller already resolved it.
   */
  runMessage(ctx: {
    user: User;
    text: string;
    media?: InboundMedia<Ref>[];
    principal: P;
    chatId?: string;
  }): Promise<void>;
  /**
   * Replay one already-gated message under the turn lease — the post-link
   * resume. The gate passed by linking; the lease still must be honoured or a
   * racing webhook message starts a second run on the same history.
   */
  replayMessage(ctx: {
    user: User;
    text: string;
    media?: InboundMedia<Ref>[];
    principal: P;
  }): Promise<void>;
}

export function createTurnKernel<P, User, Ref>(
  cfg: KernelConfig<P, User, Ref>,
  surface: Surface<User, Ref>,
): TurnKernel<P, User, Ref> {
  const tag = `[${surface.kind}]`;
  const maxBytes = cfg.maxInlineFileBytes ?? MAX_INLINE_FILE_BYTES;

  /** Plain-text reply that never throws — notices, command answers, error lines. */
  const say = (user: User, text: string) =>
    surface.sendText(user, text).catch((e) => {
      console.error(`${tag} reply failed:`, e);
      return undefined;
    });

  const lease = (chatId: string, user: User, fn: () => Promise<void>) =>
    withTurnLease(cfg, chatId, () => say(user, STILL_WORKING_MESSAGE), fn);

  // ── Threads ────────────────────────────────────────────────────────────────

  /**
   * The chat this person is currently writing to. `/new` bumps the epoch; epoch
   * 0 keeps the original id so no existing conversation moves. A store failure
   * THROWS rather than falling back to epoch 0 — that would write into the
   * conversation the user just left behind.
   */
  async function currentThread(user: User): Promise<{ chatId: string; epoch: number }> {
    if (!cfg.thread) return { chatId: surface.chatId(user, 0), epoch: 0 };
    const epoch = await cfg.thread.current(surface.chatId(user, 0));
    return { chatId: surface.chatId(user, epoch), epoch };
  }

  /** The current chat id, or null after telling the user we couldn't work it out. */
  async function threadOrNotify(user: User): Promise<string | null> {
    try {
      return (await currentThread(user)).chatId;
    } catch (e) {
      console.error(`${tag} thread lookup failed:`, e);
      await say(user, THREAD_UNAVAILABLE_MESSAGE);
      return null;
    }
  }

  // ── Identity ───────────────────────────────────────────────────────────────

  /** The principal behind a button press, or undefined after telling the user to link. */
  async function tapPrincipal(user: User): Promise<P | undefined> {
    let auth: AuthResult<P>;
    try {
      auth = await cfg.authorizeUser(user);
    } catch (e) {
      console.error(`${tag} tap auth failed:`, e);
      return undefined;
    }
    if (auth.allowed && auth.principal !== undefined) return auth.principal;
    if (!auth.silent) await say(user, auth.message ?? LINK_FIRST_MESSAGE);
    return undefined;
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  /** Keep the typing hint alive for as long as the returned stop() isn't called. */
  function startTyping(user: User): () => void {
    if (!surface.typing) return () => {};
    const ping = () => surface.typing!(user).catch(() => {});
    void ping();
    const timer = setInterval(ping, TYPING_REFRESH_MS);
    (timer as { unref?: () => void }).unref?.();
    return () => clearInterval(timer);
  }

  /**
   * Fold a run into its answer, post it once at finish (split past the cap),
   * then render whatever the turn parked on. A failed turn has nothing new to
   * decide, so its error line is the end of it.
   */
  async function renderRun(res: Response, ctx: { chatId: string; user: User; principal: P }) {
    let text = "";
    let errorMessage: string | undefined;
    const stopTyping = startTyping(ctx.user);
    try {
      for await (const ev of consumeRun(res)) {
        if (ev.type === "text-delta") text += ev.text;
        else if (ev.type === "error") errorMessage = ev.message;
      }
    } catch (e) {
      console.error(`${tag} render stream failed:`, e);
      errorMessage = errorText(e);
    } finally {
      stopTyping();
    }

    let body = text.trim();
    if (errorMessage) body += `${body ? "\n\n" : ""}⚠️ ${errorMessage.slice(0, 500)}`;
    for (const chunk of splitText(body, surface.maxTextChars)) {
      await surface.sendText(ctx.user, chunk, { rich: true });
    }
    if (errorMessage) return;
    await renderPending(ctx);
  }

  /**
   * Everything a paused turn is waiting on — message state, not stream chunks,
   * so scan fresh history once. Approvals win when both are present: a gated
   * tool blocks the run outright, so answering questions first would go nowhere.
   */
  async function renderPending(ctx: { chatId: string; user: User; principal: P }): Promise<void> {
    const history = await cfg.runtime.loadHistory({ chatId: ctx.chatId, principal: ctx.principal });
    const approvals = pendingApprovals(history);
    for (const pa of approvals) {
      if (pa.isConnect && pa.connectionName && cfg.authorizeUrl) {
        const url = cfg.authorizeUrl(pa.connectionName, {
          chatId: ctx.chatId,
          user: ctx.user,
          approvalId: pa.approvalId,
        });
        await surface.sendLink(
          ctx.user,
          `Connect ${pa.connectionName} to continue.`,
          `Sign in to ${pa.connectionName}`,
          url,
        );
      } else {
        await surface.sendApproval(ctx.user, pa, {
          approve: encodeApprovalData(true, pa.approvalId),
          deny: encodeApprovalData(false, pa.approvalId),
        });
      }
    }
    if (approvals.length) return;
    await renderQuestions(pendingQuestion(history), ctx);
  }

  /** Re-post the pending card after a turn was refused for an outstanding decision. */
  async function rerenderPending(ctx: { chatId: string; user: User; principal: P }) {
    await renderPending(ctx).catch((err) =>
      console.error(`${tag} re-render pending failed:`, err),
    );
  }

  // ── Questionnaires (askUser) ───────────────────────────────────────────────

  const questionData = (session: Pick<AskSession, "nonce" | "cursor">): QuestionData => ({
    pick: (optionIndex) =>
      encodeQuestionData({ verb: "pick", nonce: session.nonce, questionIndex: session.cursor, optionIndex }),
    done: encodeQuestionData({ verb: "done", nonce: session.nonce, questionIndex: session.cursor }),
  });

  /** Post the current question and remember its card as `promptRef`. */
  async function promptQuestion(chatId: string, user: User, session: AskSession): Promise<void> {
    const card = await surface.sendQuestion(user, session, questionData(session));
    if (card !== undefined) {
      await cfg.askState
        ?.update(chatId, session.toolCallId, session.rev, { promptRef: card })
        .catch(() => null);
    }
  }

  /**
   * Prompt the questionnaire the turn is parked on (if any), and retire a stale
   * session when it's gone — e.g. the user answered in the web app, so the
   * buttons here must stop looking live.
   */
  async function renderQuestions(
    pending: { toolCallId: string; questions: Question[] } | null,
    ctx: { chatId: string; user: User },
  ): Promise<void> {
    const store = cfg.askState;
    if (!pending) {
      const stale = await store?.clear(ctx.chatId).catch(() => null);
      if (stale?.promptRef) await surface.retireCard?.(ctx.user, stale.promptRef).catch(() => {});
      return;
    }
    const base = {
      toolCallId: pending.toolCallId,
      nonce: newNonce(),
      questions: pending.questions,
      cursor: 0,
      answers: {},
      selected: [],
      promptChatId: surface.chatId(ctx.user, 0),
    };
    if (!store) {
      // No host storage: post the questions as text so the user at least sees
      // them, and leave the turn paused (answerable in the web app). Fabricating
      // an answer would put words in their mouth.
      console.warn(`${tag} askUser pending but no askState configured — posting as text`);
      for (let i = 0; i < pending.questions.length; i++) {
        await surface
          .sendQuestion(ctx.user, { ...base, cursor: i, rev: 0 })
          .catch(() => undefined);
      }
      return;
    }
    // `already` ⇒ this questionnaire is on screen from an earlier render (a
    // redelivered webhook, or a resume that produced no new askUser). Prompting
    // again would post a duplicate card whose buttons both mutate one session.
    if ((await store.begin(ctx.chatId, base)) === "already") return;
    try {
      await promptQuestion(ctx.chatId, ctx.user, { ...base, rev: 0 });
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
   * so only that path takes the turn lease — leasing intermediate taps would
   * serialize a 5-question flow behind the lease TTL and reply "still working"
   * to taps that touch no run state.
   */
  async function answerQuestion(ctx: {
    chatId: string;
    user: User;
    principal: P;
    session: AskSession;
    event: AskEvent;
    /** The tapped card, when the interaction came from a button. */
    card?: string;
    /** Ack this tap before a resume that would outlive its window. */
    ackId?: string;
  }): Promise<{ rejected?: string; acked?: boolean }> {
    const store = cfg.askState;
    if (!store) return {};
    const { session, user } = ctx;
    const step = nextAskStep(session, ctx.event);
    if (step.kind === "rejected") return { rejected: step.reason };

    const card = ctx.card ?? session.promptRef;

    if (step.kind === "toggled") {
      const rev = await store.update(ctx.chatId, session.toolCallId, session.rev, {
        selected: step.selected,
      });
      if (rev === null) return { rejected: "Already answered." };
      const next: AskSession = { ...session, selected: step.selected, rev };
      if (card && surface.updateQuestion) {
        await surface.updateQuestion(user, card, next, questionData(next)).catch(() => {});
      }
      return {};
    }

    if (step.kind === "advanced") {
      const rev = await store.update(ctx.chatId, session.toolCallId, session.rev, {
        cursor: step.cursor,
        answers: step.answers,
        selected: [],
      });
      if (rev === null) return { rejected: "Already answered." };
      await surface.answered(user, card, step.answered).catch(() => {});
      await promptQuestion(ctx.chatId, user, {
        ...session,
        cursor: step.cursor,
        answers: step.answers,
        selected: [],
        rev,
      });
      return {};
    }

    // Last question answered — this resumes the agent. Ack the tap first: the
    // resume runs the whole turn (tens of seconds), which outlives the
    // platform's ack window, so acking afterwards fails and leaves a spinner.
    const acked = ctx.ackId !== undefined;
    if (ctx.ackId) await surface.ack?.(ctx.ackId).catch(() => {});

    // Nothing to submit through — bail BEFORE consuming the session, so the
    // collected answers survive a misconfigured host.
    const submit = cfg.runtime.applyToolResult;
    if (!submit) {
      console.error(`${tag} runtime.applyToolResult not wired — cannot resume askUser`);
      return { acked };
    }

    // Take the lease BEFORE consuming the session: releasing the session first
    // would destroy every collected answer with no way left to submit them.
    await lease(ctx.chatId, user, async () => {
      if (!(await store.finish(ctx.chatId, session.toolCallId, session.rev))) return;
      await surface.answered(user, card, step.answered).catch(() => {});
      try {
        const res = await submit({
          chatId: ctx.chatId,
          principal: ctx.principal,
          toolCallId: session.toolCallId,
          output: step.output,
        });
        await renderRun(res, ctx);
      } catch (e) {
        if (isChatBusyError(e)) {
          // Core refused the resume (a turn is live in the chat): the session
          // was already consumed to fence the submit — put it back, answers
          // included, so the same tap works once the chat is free.
          await restoreSession(ctx.chatId, session).catch((err) =>
            console.error(`${tag} could not restore questionnaire after busy refusal:`, err),
          );
          return void (await say(user, STILL_WORKING_MESSAGE));
        }
        console.error(`${tag} applyToolResult failed:`, e);
        await say(user, `⚠️ ${errorText(e).slice(0, 3000)}`);
      }
    });
    return { acked };
  }

  /** Re-create a finished session with its progress (`begin` starts at cursor 0; the fenced update fills it in). */
  async function restoreSession(chatId: string, session: AskSession): Promise<void> {
    const store = cfg.askState;
    if (!store) return;
    const { rev: _rev, promptRef, cursor, answers, selected, ...base } = session;
    await store.begin(chatId, { ...base, cursor: 0, answers: {}, selected: [], ...(promptRef ? { promptRef } : {}) });
    await store.update(chatId, session.toolCallId, 0, {
      cursor,
      answers,
      selected,
      ...(promptRef ? { promptRef } : {}),
    });
  }

  // ── Inbound message → one agent turn ───────────────────────────────────────

  async function handleMessage(ev: Extract<Inbound<User, Ref>, { kind: "message" }>): Promise<void> {
    const { user } = ev;
    const text = ev.text.trim();
    const media = ev.media;
    if (!text && media.length === 0) return;

    let auth: AuthResult<P>;
    try {
      auth = await cfg.authorizeUser(user);
    } catch (e) {
      await say(user, `⚠️ auth check failed: ${errorText(e).slice(0, 500)}`);
      return;
    }

    // A command changes what the message MEANS everywhere below: it isn't an
    // answer to a question, isn't worth stashing for replay, and never reaches
    // the agent. Media rules it out — a captioned photo is a real message, and
    // running a command would silently drop the file.
    const command = media.length === 0 ? parseCommand(text) : null;

    if (!auth.allowed || auth.principal === undefined) {
      if (auth.silent) return;
      // Don't stash a command: the post-link replay would send the agent the
      // literal "/new" as a message.
      if (!command) {
        await cfg
          .stashPending?.({ user, text, ...(media.length ? { media } : {}) })
          .catch((e) => console.error(`${tag} stashPending failed:`, e));
      }
      const body = auth.message ?? "You need a Latch account to use this agent.";
      const notice = auth.linkUrl
        ? surface.sendLink(user, body, "Link your Latch account", auth.linkUrl)
        : surface.sendText(user, body);
      await notice.catch((e) => console.error(`${tag} link notice failed:`, e));
      return;
    }
    const principal = auth.principal;

    // Which conversation this belongs to. If that can't be established, say so
    // and drop the message: guessing would write it into the wrong thread.
    let thread: { chatId: string; epoch: number };
    try {
      thread = await currentThread(user);
    } catch (e) {
      console.error(`${tag} thread lookup failed:`, e);
      await say(user, THREAD_UNAVAILABLE_MESSAGE);
      return;
    }
    const { chatId } = thread;
    const ctx = { chatId, user, principal };

    // A questionnaire on screen changes what a plain message MEANS: it answers
    // the current question rather than starting a turn. Deliberately downstream
    // of dedupe — a redelivered update would otherwise be applied as a second
    // answer and skip a question — and of the auth gate, so an unlinked user
    // still gets the link prompt and can't mutate ask state.
    let droppedQuestions = false;
    if (cfg.askState) {
      const session = await cfg.askState.get(chatId).catch(() => null);
      if (session) {
        // Media is never an answer: treating a captioned photo as one would
        // silently drop the file, since answers are plain text. Let it fall
        // through to a normal turn so the attachment actually reaches the agent.
        if (!command && text && media.length === 0) {
          const { rejected } = await answerQuestion({ ...ctx, session, event: { kind: "typed", text } });
          if (rejected) await say(user, rejected);
          return;
        }
        // Not an answer. Retire the questionnaire when whatever comes next
        // abandons the parked call anyway — a fresh turn (media, or unknown `/`
        // text) or a command that ends/replaces the thread. Read-only commands
        // (`/status`, `/help`) leave it live: asking about a conversation
        // shouldn't destroy the questions in it.
        if (!command || THREAD_CHANGING_COMMANDS.has(command.name)) {
          await cfg.askState.clear(chatId).catch(() => {});
          if (session.promptRef) await surface.retireCard?.(user, session.promptRef).catch(() => {});
          droppedQuestions = true;
        }
      }
    }

    if (command) {
      await runCommand({ command, ...ctx, epoch: thread.epoch, droppedQuestions });
      return;
    }

    await lease(chatId, user, () => runMessage({ user, text, media, principal, chatId }));
  }

  async function runMessage(ctx: {
    user: User;
    text: string;
    media?: InboundMedia<Ref>[];
    principal: P;
    chatId?: string;
  }): Promise<void> {
    const { user } = ctx;
    const chatId = ctx.chatId ?? (await threadOrNotify(user));
    if (chatId === null) return;

    // Media → inline data-URL file parts (≤ cap each); oversized listed in a
    // note. Audio is the exception: it's transcribed to text (never a file
    // part) because the agent's chat model can't be assumed to accept audio.
    const fileParts: { type: "file"; mediaType: string; filename: string; url: string }[] = [];
    const transcripts: string[] = [];
    const skipped: string[] = [];
    const failedAudio: string[] = [];
    for (const m of ctx.media ?? []) {
      const isAudio = m.mediaType.startsWith("audio/");
      const markFailed = () => (isAudio ? failedAudio : skipped).push(m.name);
      if (isAudio && !cfg.transcribe) {
        markFailed();
        continue;
      }
      try {
        const fetched = await surface.fetchMedia(m, maxBytes);
        if (!fetched) {
          markFailed();
          continue;
        }
        if (isAudio) {
          const transcript = (
            await cfg.transcribe!({ bytes: fetched.bytes, mediaType: m.mediaType, filename: m.name })
          ).trim();
          if (!transcript) {
            failedAudio.push(m.name);
            continue;
          }
          transcripts.push(`[Voice message]: ${transcript}`);
        } else {
          fileParts.push({
            type: "file",
            mediaType: fetched.mediaType,
            filename: m.name,
            url: `data:${fetched.mediaType};base64,${Buffer.from(fetched.bytes).toString("base64")}`,
          });
        }
      } catch (e) {
        console.error(`${tag} media processing failed (${m.name}):`, e);
        markFailed();
      }
    }

    let text = [ctx.text, ...transcripts].filter(Boolean).join("\n\n");
    // A voice message that produced nothing usable: tell the sender instead of
    // running a turn the agent would have no content to answer.
    if (failedAudio.length && !text && fileParts.length === 0) {
      await say(user, TRANSCRIBE_FAILED_MESSAGE);
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
      id: newMessageId(),
      role: "user",
      parts: [...(text ? [{ type: "text" as const, text }] : []), ...fileParts],
      metadata: { visibility: "user", createdAt: Date.now() },
    };

    const rctx = { chatId, user, principal: ctx.principal };
    try {
      const res = await cfg.runtime.handleChat({
        agent: cfg.agent,
        chatId,
        principal: ctx.principal,
        message,
      });
      await renderRun(res, rctx);
    } catch (e) {
      // Core's own one-turn-per-chat rule refused: same answer as our lease.
      if (isChatBusyError(e)) return void (await say(user, STILL_WORKING_MESSAGE));
      console.error(`${tag} runMessage failed:`, e);
      await say(user, `⚠️ ${errorText(e).slice(0, 3000)}`);
      // The turn was refused because a decision is still outstanding — re-post
      // the card so it can be resolved from here. Without this the chat is a
      // dead end: the same refusal every turn and no buttons to clear it.
      if (isPendingApprovalError(e)) await rerenderPending(rctx);
    }
  }

  async function replayMessage(ctx: {
    user: User;
    text: string;
    media?: InboundMedia<Ref>[];
    principal: P;
  }): Promise<void> {
    const chatId = await threadOrNotify(ctx.user);
    if (chatId === null) return;
    await lease(chatId, ctx.user, () => runMessage({ ...ctx, chatId }));
  }

  // ── Button taps ────────────────────────────────────────────────────────────

  async function handleAction(ev: Extract<Inbound<User, Ref>, { kind: "action" }>): Promise<void> {
    const approval = decodeApprovalData(ev.data);
    if (approval) return handleApprovalTap(ev, approval);
    const question = decodeQuestionData(ev.data);
    if (question) return handleQuestionTap(ev, question);
    // Unknown payload (a button type nobody registered here): nothing to do.
    if (ev.ackId) await surface.ack?.(ev.ackId).catch(() => {});
  }

  /** Approve/Deny → resume the run. */
  async function handleApprovalTap(
    ev: Extract<Inbound<User, Ref>, { kind: "action" }>,
    decoded: { approved: boolean; approvalId: string },
  ): Promise<void> {
    const { user } = ev;
    // Ack up front: the resume outlives the platform's ack window.
    if (ev.ackId) await surface.ack?.(ev.ackId).catch(() => {});

    const principal = await tapPrincipal(user);
    if (principal === undefined) return;
    const chatId = await threadOrNotify(user);
    if (chatId === null) return;
    const ctx = { chatId, user, principal };

    // Resolve the tapped approval against fresh history BEFORE acting on it. Not
    // just for naming the card: a card left behind by a previous thread (`/new`)
    // or already decided in the web app points at an approval this chat no longer
    // has, and pushing it through would surface a raw "Unknown chat" error.
    let history: AppMessage[];
    try {
      history = await cfg.runtime.loadHistory({ chatId, principal });
    } catch (e) {
      // Couldn't tell live from stale. Say so and leave the card as it is —
      // retiring it on a transient read failure would strand a real approval
      // with no buttons left to resolve it.
      console.error(`${tag} approval history read failed:`, e);
      await say(user, "⚠️ Couldn't check that request — try again.");
      return;
    }
    const live = pendingApprovals(history).find((p) => p.approvalId === decoded.approvalId);
    if (!live) {
      if (ev.card) await surface.settleCard?.(user, ev.card, NOT_ACTIVE_MESSAGE).catch(() => {});
      else await say(user, NOT_ACTIVE_MESSAGE);
      return;
    }

    // The resume mutates the same run state as a fresh turn — take the lease
    // too, or an approval press racing a new message runs two turns at once.
    // If the chat is busy the buttons stay in place; the user presses again.
    await lease(chatId, user, async () => {
      try {
        const res = await cfg.runtime.applyApproval({
          chatId,
          principal,
          decisions: [{ approvalId: decoded.approvalId, approved: decoded.approved }],
        });
        if (ev.card) {
          const verdict = decoded.approved ? "✅ Approved" : "🚫 Denied";
          await surface
            .settleCard?.(user, ev.card, `${verdict} **${live.toolName}**`, { rich: true })
            .catch(() => {});
        }
        // Continue rendering whatever the resume produced (chained approvals, or
        // a questionnaire the resumed turn went on to ask).
        await renderRun(res, ctx);
      } catch (e) {
        if (isChatBusyError(e)) return void (await say(user, STILL_WORKING_MESSAGE));
        console.error(`${tag} applyApproval failed:`, e);
        await say(user, `⚠️ ${errorText(e).slice(0, 3000)}`);
      }
    });
  }

  /** An option / Done tap on a questionnaire card. */
  async function handleQuestionTap(
    ev: Extract<Inbound<User, Ref>, { kind: "action" }>,
    decoded: QuestionPayload,
  ): Promise<void> {
    const { user } = ev;
    /** Answer the tap: a toast where the platform has one, a message otherwise. */
    const respond = (text: string) =>
      ev.ackId ? surface.ack?.(ev.ackId, text).catch(() => {}) : say(user, text);

    // Unknown thread ⇒ we can't tell which session this tap belongs to. Say
    // so and leave the card alone so a retry still works.
    let chatId: string;
    try {
      chatId = (await currentThread(user)).chatId;
    } catch (e) {
      console.error(`${tag} thread lookup failed:`, e);
      await respond("Something went wrong — try again.");
      return;
    }

    const session = await cfg.askState?.get(chatId).catch(() => null);
    // Stale button: the session is gone (answered elsewhere, cancelled, expired)
    // or belongs to a newer questionnaire, or this card isn't the current
    // question. Retire the card instead of answering the wrong thing.
    const stale =
      !session || session.nonce !== decoded.nonce || session.cursor !== decoded.questionIndex;
    if (stale) {
      await respond(session ? "Already answered." : "This questionnaire is no longer active.");
      if (ev.card) await surface.retireCard?.(user, ev.card).catch(() => {});
      return;
    }

    const principal = await tapPrincipal(user);
    if (principal === undefined) {
      if (ev.ackId) await surface.ack?.(ev.ackId).catch(() => {});
      return;
    }

    const event: AskEvent =
      decoded.verb === "pick" ? { kind: "pick", option: decoded.optionIndex } : { kind: "done" };
    const { rejected, acked } = await answerQuestion({
      chatId,
      user,
      principal,
      session,
      event,
      ...(ev.card !== undefined ? { card: ev.card } : {}),
      ...(ev.ackId !== undefined ? { ackId: ev.ackId } : {}),
    });
    // The resume path already acked (it outlives the ack window); everything
    // else settles synchronously and gets its ack — with the reason, if rejected.
    if (!acked) {
      if (ev.ackId) await surface.ack?.(ev.ackId, rejected).catch(() => {});
      else if (rejected) await say(user, rejected);
    }
  }

  // ── Commands ───────────────────────────────────────────────────────────────

  interface CommandCtx {
    command: ParsedCommand;
    /** The thread the command was issued in (before `/new` rotates it). */
    chatId: string;
    /** That thread's epoch — 0 for the first conversation. */
    epoch: number;
    user: User;
    principal: P;
    /** True when a live questionnaire was retired to make room for this command. */
    droppedQuestions: boolean;
  }

  const COMMAND_HELP = `Commands\n\n${helpText(CHANNEL_COMMANDS)}`;

  async function runCommand(ctx: CommandCtx): Promise<void> {
    switch (ctx.command.name) {
      case "help":
        await say(ctx.user, COMMAND_HELP);
        return;
      case "start":
        await say(
          ctx.user,
          `You're talking to ${cfg.agent}. Send a message — text, a photo, a file, or a voice note — and it will answer here.\n\n${COMMAND_HELP}`,
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
        await say(ctx.user, COMMAND_HELP);
    }
  }

  /** `/new` — rotate to a fresh thread. Cheap: no lease, no agent turn. */
  async function runNewCommand(ctx: CommandCtx): Promise<void> {
    if (!cfg.thread) {
      console.warn(`${tag} /new used but no thread store configured`);
      await say(ctx.user, "Starting a new conversation isn't available on this bot.");
      return;
    }
    try {
      await cfg.thread.rotate(surface.chatId(ctx.user, 0));
    } catch (e) {
      console.error(`${tag} /new failed:`, e);
      await say(ctx.user, "⚠️ Couldn't start a new conversation — please try again.");
      return;
    }
    await say(ctx.user, "Started a new conversation. The previous one is still in the web app.");
  }

  /**
   * `/compact` — summarize the thread and keep going in the same one. Takes the
   * turn lease: it costs a model call and rewrites what the next turn sends.
   */
  async function runCompactCommand(ctx: CommandCtx): Promise<void> {
    const compact = cfg.runtime.compactChat;
    if (!compact) {
      console.warn(`${tag} /compact used but runtime.compactChat not wired`);
      await say(ctx.user, "Compacting isn't available on this bot.");
      return;
    }
    await lease(ctx.chatId, ctx.user, async () => {
      await surface.typing?.(ctx.user).catch(() => {});
      try {
        const res = await compact({
          chatId: ctx.chatId,
          principal: ctx.principal,
          ...(ctx.command.args ? { focus: ctx.command.args } : {}),
        });
        if (!res) {
          await say(ctx.user, "This conversation is short enough already.");
          return;
        }
        // Plain text on purpose: the summary is model output, and formatting it
        // could push an escaped message past the platform cap or split an entity.
        await say(
          ctx.user,
          `♻️ Compacted ${res.compacted} messages. Carrying forward:\n\n${truncate(res.summary, MAX_SUMMARY_CHARS)}`,
        );
      } catch (e) {
        console.error(`${tag} /compact failed:`, e);
        await say(ctx.user, `⚠️ ${errorText(e).slice(0, 3000)}`);
        // Paused turn: show what it's waiting on, so the refusal is actionable.
        if (isPendingApprovalError(e)) await rerenderPending(ctx);
      }
    });
  }

  /**
   * `/cancel` — get out of whatever the agent is waiting on. A questionnaire is
   * already dropped by the time we get here; approvals are denied, which lets the
   * agent wrap up instead of leaving the chat gated forever.
   */
  async function runCancelCommand(ctx: CommandCtx): Promise<void> {
    // The questionnaire is already gone, so report that BEFORE the lease: a busy
    // chat would otherwise answer only "still working" and the user would never
    // learn their questions had been retired.
    if (ctx.droppedQuestions) {
      await say(ctx.user, "Dropped those questions. What would you like to do instead?");
    }
    // Approvals, in contrast, are read and denied INSIDE the lease: a decision
    // built from a pre-lease read could name approvals a concurrent turn has
    // already moved past. If a turn is running the user gets "still working",
    // which is the honest answer — there'd be nothing to cancel yet anyway.
    await lease(ctx.chatId, ctx.user, async () => {
      let approvals: PendingApproval[] = [];
      try {
        approvals = pendingApprovals(
          await cfg.runtime.loadHistory({ chatId: ctx.chatId, principal: ctx.principal }),
        );
      } catch (e) {
        console.error(`${tag} /cancel history read failed:`, e);
        await say(ctx.user, "⚠️ Couldn't read this conversation — try again.");
        return;
      }
      // Nothing left to say when the questions were the thing being cancelled —
      // "Nothing to cancel." right after "Dropped those questions." contradicts it.
      if (!approvals.length) {
        if (!ctx.droppedQuestions) await say(ctx.user, "Nothing to cancel.");
        return;
      }
      try {
        const res = await cfg.runtime.applyApproval({
          chatId: ctx.chatId,
          principal: ctx.principal,
          decisions: approvals.map((a) => ({ approvalId: a.approvalId, approved: false })),
        });
        await say(ctx.user, `🚫 Denied ${approvals.map((a) => a.toolName).join(", ")}.`);
        await renderRun(res, ctx);
      } catch (e) {
        console.error(`${tag} /cancel failed:`, e);
        await say(ctx.user, `⚠️ ${errorText(e).slice(0, 3000)}`);
      }
    });
  }

  /** `/status` — what this thread is and what it's waiting on. Read-only. */
  async function runStatusCommand(ctx: CommandCtx): Promise<void> {
    let history: AppMessage[] = [];
    try {
      history = await cfg.runtime.loadHistory({ chatId: ctx.chatId, principal: ctx.principal });
    } catch (e) {
      console.error(`${tag} /status history read failed:`, e);
      await say(ctx.user, "⚠️ Couldn't read this conversation.");
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
      ctx.user,
      [
        `Agent: ${cfg.agent}`,
        `Conversation: ${ctx.epoch > 0 ? `#${ctx.epoch + 1}` : "the first one"}`,
        `Messages: ${history.length}`,
        `Waiting on: ${waiting}`,
      ].join("\n"),
    );
  }

  // ── Entry ──────────────────────────────────────────────────────────────────

  /**
   * The error boundary: callers run this detached (under `waitUntil`, or as a
   * dropped promise), so a rejection here would be an unhandled one. Every
   * user-visible failure is already reported inside; whatever escapes is logged.
   */
  async function handleInbound(ev: Inbound<User, Ref>): Promise<void> {
    try {
      if (cfg.seen && (await cfg.seen(ev.deliveryKey))) {
        console.log(`${tag} duplicate delivery ${ev.deliveryKey} — dropped`);
        return;
      }
      if (ev.kind === "action") await handleAction(ev);
      else await handleMessage(ev);
    } catch (e) {
      console.error(`${tag} inbound handling failed:`, e);
    }
  }

  return { handleInbound, runMessage, replayMessage };
}
