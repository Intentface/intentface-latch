import { timingSafeEqual } from "node:crypto";

/**
 * Verify Telegram's webhook secret: the `x-telegram-bot-api-secret-token`
 * header must equal the `secret_token` we registered with `setWebhook`.
 * Constant-time compare (length check first — `timingSafeEqual` requires it).
 */
export function verifyTelegramSecretToken(
  header: string | null,
  expected: string,
): boolean {
  if (!header || !expected) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
