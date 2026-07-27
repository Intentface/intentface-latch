import { createHmac, timingSafeEqual } from "node:crypto";
import { secretEnv } from "./env";

/**
 * Signed account-link tokens. The bot DMs a Slack user a `/slack/link` URL
 * carrying their (team, slack user) + an expiry, HMAC-signed so the identity
 * can't be forged — only the person who received the ephemeral link can claim
 * it, and only by logging into a real platform account.
 */
function secret(): string {
  return secretEnv("BETTER_AUTH_SECRET", "dev-only-secret-change-me");
}

function sign(teamId: string, slackUserId: string, exp: number): string {
  // `slack:` domain-separates this from the Telegram/WhatsApp link tokens, which
  // share the same signing key — without it an id that collides across channels
  // could yield a token valid on the wrong channel.
  return createHmac("sha256", secret())
    .update(`slack:${teamId}:${slackUserId}:${exp}`)
    .digest("hex");
}

/** Build the signed `/slack/link` URL (valid ~30 min). */
export function buildLinkUrl(baseUrl: string, teamId: string, slackUserId: string): string {
  const exp = Date.now() + 30 * 60 * 1000;
  const q = new URLSearchParams({
    team: teamId,
    user: slackUserId,
    exp: String(exp),
    sig: sign(teamId, slackUserId, exp),
  });
  return `${baseUrl}/slack/link?${q}`;
}

/** Verify a link token (signature + expiry). */
export function verifyLink(
  teamId: string,
  slackUserId: string,
  exp: number,
  sig: string,
): boolean {
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  let expected: string;
  try {
    expected = sign(teamId, slackUserId, exp);
  } catch (e) {
    // No signing secret (misconfigured production): no inbound link can be
    // valid — refuse instead of 500ing. BUILDING links still throws loudly.
    console.error("[slack] link verification unavailable:", e);
    return false;
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}
