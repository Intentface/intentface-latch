import type { AppMessage } from "@intentface/latch-core";
import type { ChannelRunOps } from "../types.js";
import { consumeRun, pendingApprovals } from "../render.js";
import {
  whatsappApi,
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
  claimTurn?: (chatId: string) => Promise<boolean>;
  releaseTurn?: (chatId: string) => Promise<void>;
  /** Stash the message that triggered a link prompt, to replay after linking. */
  stashPending?: (input: {
    waId: string;
    profileName?: string;
    text: string;
  }) => Promise<void>;
  /** Build the platform authorize URL for a `connect_<name>` OAuth approval. */
  authorizeUrl?: (
    connectionName: string,
    ctx: { chatId: string; waId: string; approvalId: string },
  ) => string;
  waitUntil?: (p: Promise<unknown>) => void;
  /** Test seam: base URL / fetch for the Graph API client. */
  apiOptions?: WhatsappApiOptions;
}

// ── Webhook payload shapes (the slice we read) ──────────────────────────────

interface WaMediaRef {
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
  interactive?: { type?: string; button_reply?: { id: string; title?: string } };
}

interface WaChangeValue {
  messaging_product?: string;
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
    if (errorMessage) return; // don't look for approvals on a failed turn

    const history = await config.runtime.loadHistory({
      chatId: ctx.chatId,
      principal: ctx.principal,
    });
    for (const pa of pendingApprovals(history)) {
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
    }
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
    const decision = decodeWhatsappApprovalId(msg.interactive?.button_reply?.id);
    if (decision) {
      await runDecision(waId, profileName, decision);
      return;
    }

    const text = (msg.text?.body ?? msg.image?.caption ?? msg.document?.caption ?? "").trim();
    const media = mediaRefs(msg);
    if (!text && media.length === 0) return;

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
        .stashPending?.({ waId, ...(profileName ? { profileName } : {}), text })
        .catch((e) => console.error("[whatsapp] stashPending failed:", e));
      const base = auth.message ?? "You need a Latch account to use this agent.";
      const body = auth.linkUrl ? `${base}\n\nLink your Latch account: ${auth.linkUrl}` : base;
      await api.sendText(waId, body).catch((e) => console.error("[whatsapp] link notice failed:", e));
      return;
    }

    const chatId = chatIdFor(waId);
    if (config.claimTurn && !(await config.claimTurn(chatId))) {
      await api.sendText(waId, STILL_WORKING_MESSAGE).catch(() => {});
      return;
    }
    try {
      await runMessage({ waId, text, media, principal: auth.principal });
    } finally {
      await config.releaseTurn?.(chatId).catch(() => {});
    }
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
    try {
      const res = await config.runtime.applyApproval({
        chatId,
        principal: auth.principal,
        decisions: [{ approvalId: decision.approvalId, approved: decision.approved }],
      });
      await renderRun(res, { waId, chatId, principal: auth.principal });
    } catch (e) {
      console.error("[whatsapp] applyApproval failed:", e);
      const m = e instanceof Error ? e.message : String(e);
      await api.sendText(waId, `⚠️ ${m.slice(0, 3000)}`).catch(() => {});
    }
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

    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== "messages" || !change.value) continue;
        for (const msg of change.value.messages ?? []) {
          defer(runTurn(msg, change.value));
        }
        // statuses[] (delivery receipts) are intentionally ignored.
      }
    }
    return ok();
  }

  // `runMessage` is exposed so the host's post-link resume can replay a stashed
  // message (the gate already passed by linking).
  return { handleRequest, runMessage, api };
}
