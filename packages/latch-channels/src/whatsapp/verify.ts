import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Meta webhook verification, both halves:
 *  - GET handshake: Meta calls with `hub.mode=subscribe&hub.verify_token=…&
 *    hub.challenge=…` when the callback URL is saved; echo the challenge iff
 *    the verify token matches.
 *  - POST signature: `X-Hub-Signature-256: sha256=<hex HMAC of the raw body
 *    keyed on the app secret>`, constant-time compared.
 */

/** Returns the challenge to echo (HTTP 200 text/plain), or null → 403. */
export function whatsappVerifyChallenge(url: URL, verifyToken: string): string | null {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode !== "subscribe" || !token || !challenge || !verifyToken) return null;
  const a = Buffer.from(token);
  const b = Buffer.from(verifyToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return challenge;
}

/** Verify a webhook POST's `X-Hub-Signature-256` header over the raw body. */
export function verifyWhatsappSignature(opts: {
  appSecret: string;
  rawBody: string;
  signature: string | null;
}): boolean {
  if (!opts.signature || !opts.appSecret) return false;
  const expected = `sha256=${createHmac("sha256", opts.appSecret).update(opts.rawBody).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(opts.signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
