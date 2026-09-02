import { createHmac, timingSafeEqual } from "node:crypto";
import { secretEnv } from "./env";

/**
 * CSRF token for the channel-link confirmation form (`/link/<kind>`).
 *
 * Why this exists even though the confirmation page already fixed the bug:
 * moving the write from GET to POST stops a link being *followed* into a
 * silent link, but the POST is still authenticated by the session cookie
 * alone. Its only remaining protection is that better-auth issues that cookie
 * as `SameSite=Lax`, which withholds it on cross-site form POSTs. That is a
 * genuine defence, and it is why the GET→POST change works — but it is an
 * implicit dependency on a third-party default. Setting `sameSite: "none"`
 * (the usual move when adding cross-subdomain auth) would silently reopen the
 * confused-deputy hole, and in its deliberate form: an attacker who has their
 * OWN valid signed link can host a page that auto-submits it, and any
 * logged-in victim who visits binds the ATTACKER's channel account to the
 * VICTIM's Latch account — every later message from the attacker then runs
 * with the victim's connections and data.
 *
 * The token is an HMAC over both identities at once: the channel side (from
 * the signed link) and the Latch side (from the session). It can therefore
 * only be minted by a GET that already carried the victim's own cookie, which
 * is exactly what a cross-site attacker cannot arrange. Stateless — no
 * storage, no extra round-trip — and it inherits the link's lifetime because
 * the link's `exp` is part of the signed payload.
 */

export interface ChannelLinkCsrfInput {
  /** Channel family, e.g. `"telegram"` — keeps tokens from crossing channels. */
  channel: string;
  /** Bot/app/workspace the link belongs to (bot id, Slack team id, …). */
  scopeId: string;
  /** The channel-side user id carried by the signed link. */
  externalId: string;
  /** The Latch user the browser is signed in as. */
  sessionUserId: string;
  /** The signed link's expiry, so the token cannot outlive the link. */
  exp: number;
}

function secret(): string {
  return secretEnv("BETTER_AUTH_SECRET", "dev-only-secret-change-me");
}

/**
 * Mint the token rendered into the confirmation form.
 *
 * Field lengths are prefixed rather than relying on the `:` separator alone:
 * a channel-supplied id containing a colon must not be able to shift the
 * boundaries and forge a payload for a different pair.
 */
export function channelLinkCsrfToken(input: ChannelLinkCsrfInput): string {
  const parts = [
    input.channel,
    input.scopeId,
    input.externalId,
    input.sessionUserId,
    String(input.exp),
  ];
  const payload = parts.map((p) => `${p.length}:${p}`).join("|");
  return createHmac("sha256", secret()).update(`link-csrf|${payload}`).digest("hex");
}

/** Verify a submitted token against the request's own identities. */
export function verifyChannelLinkCsrf(
  token: string | undefined | null,
  input: ChannelLinkCsrfInput,
): boolean {
  if (!token) return false;
  let expected: string;
  try {
    expected = channelLinkCsrfToken(input);
  } catch (e) {
    // No signing secret (misconfigured production): refuse rather than 500,
    // matching how the link signatures themselves fail closed.
    console.error("[channel-link] CSRF verification unavailable:", e);
    return false;
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The form field name carrying the token. */
export const CSRF_FIELD = "csrf";

/**
 * Read the token out of a POSTed form body, tolerating a malformed body
 * (returns undefined, which `verifyChannelLinkCsrf` rejects).
 */
export async function readCsrfField(request: Request): Promise<string | undefined> {
  try {
    const form = await request.formData();
    const value = form.get(CSRF_FIELD);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}
