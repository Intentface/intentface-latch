import { createHmac, timingSafeEqual } from "node:crypto";
import { secretEnv } from "./env";
import type { ChannelKind } from "./channel-store";

/**
 * Signed account-link tokens for every chat channel. A bot sends an unlinked
 * user a `/link/<kind>` URL naming the PLATFORM side of the link — which bot or
 * workspace (`botRef`), which platform user (`externalId`), plus channel data the
 * confirmation page shows (`meta`: a Telegram @username, a Slack team id) — and
 * an expiry, HMAC-signed so none of it can be forged: only the person who
 * received the link can claim it, and only into a real Latch account.
 *
 * One signer for all kinds. The kind is inside the HMAC and every field is
 * length-prefixed, so a token can neither be replayed on another channel nor
 * have its field boundaries shifted by an id that contains the separator.
 */

export interface ChannelLinkRef {
  kind: ChannelKind;
  /** The bot id (Telegram/WhatsApp) or the Slack app id — what the link route resolves the binding by. */
  botRef: string;
  /** The platform-side user id. */
  externalId: string;
  /** Extra channel data, HMAC-covered: Telegram @username (display), Slack team id (identity key). */
  meta?: string;
}

/** How long a link stays claimable. DM links land in a chat the user is looking at; Slack's may sit in a thread. */
const LINK_TTL_MS: Record<ChannelKind, number> = {
  telegram: 10 * 60_000,
  whatsapp: 10 * 60_000,
  slack: 30 * 60_000,
};

function secret(): string {
  return secretEnv("BETTER_AUTH_SECRET", "dev-only-secret-change-me");
}

function sign(ref: ChannelLinkRef, exp: number): string {
  const parts = [ref.kind, ref.botRef, ref.externalId, String(exp), ref.meta ?? ""];
  const payload = parts.map((p) => `${p.length}:${p}`).join("|");
  return createHmac("sha256", secret()).update(`link|${payload}`).digest("hex");
}

/** Build the signed `/link/<kind>` URL. */
export function buildChannelLinkUrl(baseUrl: string, ref: ChannelLinkRef): string {
  const exp = Date.now() + LINK_TTL_MS[ref.kind];
  const q = new URLSearchParams({
    ref: ref.botRef,
    user: ref.externalId,
    ...(ref.meta ? { meta: ref.meta } : {}),
    exp: String(exp),
    sig: sign(ref, exp),
  });
  return `${baseUrl}/link/${ref.kind}?${q}`;
}

/** Verify a link token (signature + expiry). */
export function verifyChannelLink(ref: ChannelLinkRef, exp: number, sig: string): boolean {
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  let expected: string;
  try {
    expected = sign(ref, exp);
  } catch (e) {
    // No signing secret (misconfigured production): no inbound link can be
    // valid — refuse instead of 500ing. BUILDING links still throws loudly.
    console.error("[channel-link] verification unavailable:", e);
    return false;
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}
