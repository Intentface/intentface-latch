import { createHmac, timingSafeEqual } from "node:crypto";
import { secretEnv } from "./env";

/**
 * Signed account-link tokens for WhatsApp, mirroring `telegram-link.ts`:
 * (bot id, wa_id) + expiry, HMAC-signed, 10-min TTL.
 */
const TTL_MS = 10 * 60 * 1000;

function secret(): string {
  return secretEnv("BETTER_AUTH_SECRET", "dev-only-secret-change-me");
}

function sign(botId: string, waId: string, exp: number): string {
  return createHmac("sha256", secret()).update(`whatsapp:${botId}:${waId}:${exp}`).digest("hex");
}

/** Build the signed `/whatsapp/link` URL (valid ~10 min). */
export function buildWhatsappLinkUrl(baseUrl: string, botId: string, waId: string): string {
  const exp = Date.now() + TTL_MS;
  const q = new URLSearchParams({
    bot: botId,
    user: waId,
    exp: String(exp),
    sig: sign(botId, waId, exp),
  });
  return `${baseUrl}/whatsapp/link?${q}`;
}

/** Verify a link token (signature + expiry). */
export function verifyWhatsappLink(
  botId: string,
  waId: string,
  exp: number,
  sig: string,
): boolean {
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  let expected: string;
  try {
    expected = sign(botId, waId, exp);
  } catch (e) {
    // No signing secret (misconfigured production): no inbound link can be
    // valid — refuse instead of 500ing. BUILDING links still throws loudly.
    console.error("[whatsapp] link verification unavailable:", e);
    return false;
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}
