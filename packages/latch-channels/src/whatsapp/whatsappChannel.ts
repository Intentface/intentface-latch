import type {
  AskStateStore,
  AuthResult,
  ChannelRunOps,
  ChannelThreadStore,
  PendingApproval,
  Question,
} from "../types.js";
import {
  createTurnKernel,
  decodeApprovalData,
  decodeQuestionData,
  encodeApprovalData,
  splitText,
  type Inbound,
  type InboundMedia,
  type Surface,
} from "../kernel.js";
import {
  whatsappApi,
  MAX_LIST_ROWS,
  MAX_REPLY_BUTTONS,
  type LazyString,
  type WhatsappApiOptions,
  type WhatsappClient,
} from "./api.js";
import { verifyWhatsappSignature, whatsappVerifyChallenge } from "./verify.js";

/**
 * One agent's WhatsApp business number (Meta Cloud API). The host wires
 * `handleRequest` to the bot's per-bot webhook route; we handle Meta's GET
 * verify handshake, check the POST signature, ACK fast, and hand the parsed
 * message to the turn kernel in the background. WhatsApp messages cannot be
 * edited, so the surface never edits: answers post once (split past the
 * 4096-char cap), receipts are separate messages.
 */

const MAX_TEXT_CHARS = 4096;

export interface WhatsappUser {
  waId: string;
  profileName?: string;
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
  authorizeUser: (user: WhatsappUser) => Promise<AuthResult<P>>;
  /** Persistent dedupe on `<botRef>:<waId>:<wamid>` (Meta re-delivers webhooks). */
  seen?: (deliveryKey: string) => Promise<boolean>;
  /** Host-backed one-turn-per-chat lease (see the kernel). */
  claimTurn?: (chatId: string) => Promise<string | null>;
  releaseTurn?: (chatId: string, token: string) => Promise<void>;
  /** Stash the message that triggered a link prompt, to replay after linking. */
  stashPending?: (
    input: WhatsappUser & { text: string; media?: InboundMedia<WaMediaRef>[] },
  ) => Promise<void>;
  /** Build the platform authorize URL for a `connect_<name>` OAuth approval. */
  authorizeUrl?: (
    connectionName: string,
    ctx: { chatId: string; waId: string; approvalId: string },
  ) => string;
  /** Host storage for in-flight `askUser` questionnaires (see the kernel). */
  askState?: AskStateStore;
  /** Host storage for the thread epoch — what makes `/new` possible. */
  thread?: ChannelThreadStore;
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

/** Interactive reply ids use the kernel's shared `lta:` / `ltq:` formats (256-char budget here). */
export const encodeWhatsappApprovalId = encodeApprovalData;
export const decodeWhatsappApprovalId = decodeApprovalData;
export const decodeWhatsappQuestionId = decodeQuestionData;

/** Build the chat id for a (bot, WhatsApp user) at a thread epoch — same shape as Telegram's. */
export function whatsappChatId(botRef: string, waId: string, epoch = 0): string {
  const base = `whatsapp_${botRef}_${waId}`;
  return epoch > 0 ? `${base}_t${epoch}` : base;
}

/** The inverse of `whatsappChatId`, or null when `id` isn't one of ours. */
export function parseWhatsappChatId(
  id: string,
): { botRef: string; waId: string; epoch: number } | null {
  const m = /^whatsapp_(.+)_(\d+)(?:_t(\d+))?$/.exec(id);
  if (!m) return null;
  return { botRef: m[1]!, waId: m[2]!, epoch: m[3] ? Number(m[3]) : 0 };
}

/** Kept for hosts that split their own text; the kernel splits answers itself. */
export const splitWhatsappText = (text: string, max = MAX_TEXT_CHARS) => splitText(text, max);

const ok = () => new Response(null, { status: 200 });

function mediaRefs(msg: WaMessage): InboundMedia<WaMediaRef>[] {
  const out: InboundMedia<WaMediaRef>[] = [];
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

/** Question body text: the question plus, when `numbered`, its options (typed "2" answers it). */
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

// ── The surface ─────────────────────────────────────────────────────────────

export function whatsappSurface(api: WhatsappClient, botRef: string): Surface<WhatsappUser, WaMediaRef> {
  return {
    kind: "whatsapp",
    maxTextChars: MAX_TEXT_CHARS,
    chatId: (u, epoch) => whatsappChatId(botRef, u.waId, epoch),

    sendText: async (u, text) => {
      await api.sendText(u.waId, text);
      return undefined;
    },

    sendLink: (u, body, label, url) => api.sendText(u.waId, `${body}\n\n${label}: ${url}`),

    sendApproval: async (u, pa: PendingApproval, data) => {
      let json: string;
      try {
        json = JSON.stringify(pa.input, null, 2) ?? String(pa.input);
      } catch {
        json = String(pa.input);
      }
      if (json.length > 800) json = `${json.slice(0, 800)}\n… (truncated)`;
      await api.sendReplyButtons(u.waId, `🔒 Approve ${pa.toolName}?\n\n${json}`, [
        { id: data.approve, title: "✅ Approve" },
        { id: data.deny, title: "🚫 Deny" },
      ]);
      return undefined;
    },

    /**
     * Post one question with the best affordance Meta allows: reply buttons up
     * to 3 options, a tappable list up to 10, otherwise a numbered text prompt.
     * Multi-select always falls back to numbers: messages can't be edited, so
     * there is no way to tick options in place.
     */
    sendQuestion: async (u, session, data) => {
      const q = session.questions[session.cursor];
      if (!q) return undefined;
      const total = session.questions.length;
      if (data && !q.multiSelect && q.options.length <= MAX_REPLY_BUTTONS) {
        await api.sendReplyButtons(
          u.waId,
          questionBody(q, session.cursor, total, false),
          q.options.map((o, i) => ({ id: data.pick(i), title: o.label })),
        );
      } else if (data && !q.multiSelect && q.options.length <= MAX_LIST_ROWS) {
        await api.sendList(
          u.waId,
          questionBody(q, session.cursor, total, false),
          "Choose",
          q.options.map((o, i) => ({ id: data.pick(i), title: o.label, description: o.description })),
        );
      } else {
        await api.sendText(u.waId, questionBody(q, session.cursor, total, true));
      }
      return undefined;
    },

    answered: (u, _card, a) => api.sendText(u.waId, `✓ ${a.answer}`),

    fetchMedia: async (m, maxBytes) => {
      const info = await api.getMediaInfo(m.ref.id);
      if (!info.url || (info.fileSize ?? 0) > maxBytes) return null;
      return { bytes: await api.downloadMedia(info.url), mediaType: info.mimeType ?? m.mediaType };
    },
  };
}

// ── The channel ─────────────────────────────────────────────────────────────

export function whatsappChannel<P>(config: WhatsappChannelConfig<P>) {
  const api = whatsappApi(
    { accessToken: config.accessToken, phoneNumberId: config.phoneNumberId },
    config.apiOptions,
  );
  const defer = (p: Promise<unknown>) => (config.waitUntil ? config.waitUntil(p) : p);
  const resolveLazy = async (v: LazyString): Promise<string> => (typeof v === "function" ? v() : v);

  const kernel = createTurnKernel<P, WhatsappUser, WaMediaRef>(
    {
      agent: config.agent,
      botRef: config.botRef,
      runtime: config.runtime,
      authorizeUser: config.authorizeUser,
      ...(config.seen ? { seen: config.seen } : {}),
      ...(config.claimTurn ? { claimTurn: config.claimTurn } : {}),
      ...(config.releaseTurn ? { releaseTurn: config.releaseTurn } : {}),
      ...(config.askState ? { askState: config.askState } : {}),
      ...(config.thread ? { thread: config.thread } : {}),
      ...(config.stashPending
        ? {
            stashPending: (i: { user: WhatsappUser; text: string; media?: InboundMedia<WaMediaRef>[] }) =>
              config.stashPending!({ ...i.user, text: i.text, ...(i.media ? { media: i.media } : {}) }),
          }
        : {}),
      ...(config.authorizeUrl
        ? {
            authorizeUrl: (name: string, ctx: { chatId: string; user: WhatsappUser; approvalId: string }) =>
              config.authorizeUrl!(name, { chatId: ctx.chatId, waId: ctx.user.waId, approvalId: ctx.approvalId }),
          }
        : {}),
    },
    whatsappSurface(api, config.botRef),
  );

  /** One Meta message → the kernel's inbound event. Button/list replies are actions. */
  function parse(msg: WaMessage, value: WaChangeValue): Inbound<WhatsappUser, WaMediaRef> {
    const profileName = value.contacts?.find((c) => c.wa_id === msg.from)?.profile?.name;
    const user: WhatsappUser = { waId: msg.from, ...(profileName ? { profileName } : {}) };
    const deliveryKey = `${config.botRef}:${msg.from}:${msg.id}`;
    const replyId = msg.interactive?.button_reply?.id ?? msg.interactive?.list_reply?.id;
    if (replyId) return { kind: "action", user, data: replyId, deliveryKey };
    return {
      kind: "message",
      user,
      text: (msg.text?.body ?? msg.image?.caption ?? msg.document?.caption ?? "").trim(),
      media: mediaRefs(msg),
      deliveryKey,
    };
  }

  // ── The per-bot webhook entrypoint (GET verify + POST events) ──────────────
  async function handleRequest(request: Request): Promise<Response> {
    if (request.method === "GET") {
      const challenge = whatsappVerifyChallenge(new URL(request.url), await resolveLazy(config.verifyToken));
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
          defer(kernel.handleInbound(parse(msg, change.value)));
        }
        // statuses[] (delivery receipts) are intentionally ignored.
      }
    }
    return ok();
  }

  type HostCtx = { waId: string; text: string; media?: InboundMedia<WaMediaRef>[]; principal: P };
  const kernelCtx = ({ waId, ...rest }: HostCtx) => ({ user: { waId }, ...rest });

  return {
    handleRequest,
    /** Run one already-gated, already-leased message (scheduled delivery). */
    runMessage: (ctx: HostCtx & { chatId?: string }) => kernel.runMessage(kernelCtx(ctx)),
    /** Replay a stashed message under the turn lease (the post-link resume). */
    replayMessage: (ctx: HostCtx) => kernel.replayMessage(kernelCtx(ctx)),
    api,
  };
}
