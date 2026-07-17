import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed account-link tokens for Telegram, mirroring `slack-link.ts`. The bot
 * DMs an unlinked user a `/telegram/link` URL carrying (bot id, Telegram user
 * id) + an expiry, HMAC-signed so the identity can't be forged. TTL is 10
 * minutes (shorter than Slack's 30 — the link lands in a private DM the user
 * is actively looking at).
 */
const TTL_MS = 10 * 60 * 1000;

function secret(): string {
  return process.env.BETTER_AUTH_SECRET ?? "dev-only-secret-change-me";
}

function sign(botId: string, telegramUserId: string, exp: number): string {
  return createHmac("sha256", secret())
    .update(`telegram:${botId}:${telegramUserId}:${exp}`)
    .digest("hex");
}

/** Build the signed `/telegram/link` URL (valid ~10 min). */
export function buildTelegramLinkUrl(
  baseUrl: string,
  botId: string,
  telegramUserId: string,
): string {
  const exp = Date.now() + TTL_MS;
  const q = new URLSearchParams({
    bot: botId,
    user: telegramUserId,
    exp: String(exp),
    sig: sign(botId, telegramUserId, exp),
  });
  return `${baseUrl}/telegram/link?${q}`;
}

/** Verify a link token (signature + expiry). */
export function verifyTelegramLink(
  botId: string,
  telegramUserId: string,
  exp: number,
  sig: string,
): boolean {
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  const expected = sign(botId, telegramUserId, exp);
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}
