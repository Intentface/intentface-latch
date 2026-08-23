import { createHmac, timingSafeEqual } from "node:crypto";
import { secretEnv } from "./env";

/**
 * Signed OAuth `state` for the Slack install/reinstall flow. The v1 state was
 * the bare app id — anything that could get a browser onto the callback with
 * a chosen code+state could complete a token exchange for a flow Latch never
 * started. v2 states are HMAC-signed and carry:
 *
 *  - the app id (which binding this install belongs to),
 *  - an expiry,
 *  - a manifest-version flag (`mv=2` marks a migrate-to-agent_view reinstall,
 *    recorded only after the exchange succeeds),
 *  - the INITIATING USER — the callback requires the completing browser
 *    session to be that same user, so a leaked install URL can't be finished
 *    by anyone else (and the creator-only gate that minted the URL still
 *    holds at completion time).
 *
 * States are also SINGLE-USE: the callback consumes them via the store's
 * claimOnce, so a completed state can't be replayed within its window.
 *
 * Format: `<appId>.<exp>.<mv>.<b64url(userId)>.<hex hmac>` — domain-separated
 * from the link tokens sharing the signing key.
 */

function secret(): string {
  return secretEnv("BETTER_AUTH_SECRET", "dev-only-secret-change-me");
}

function sign(appId: string, exp: number, mv: number, userId: string): string {
  return createHmac("sha256", secret())
    .update(`slack-oauth:${appId}:${exp}:${mv}:${userId}`)
    .digest("hex");
}

export function buildOauthState(
  appId: string,
  opts: { userId: string; manifestVersion?: number },
): string {
  const exp = Date.now() + 30 * 60_000;
  const mv = opts.manifestVersion ?? 0; // 0 = no version flip on callback
  const uid = Buffer.from(opts.userId, "utf8").toString("base64url");
  return `${appId}.${exp}.${mv}.${uid}.${sign(appId, exp, mv, opts.userId)}`;
}

export interface OauthState {
  appId: string;
  /** The user who started the install — the only one who may complete it. */
  userId: string;
  manifestVersion?: number;
  /** Single-use handle: claim `oauthstate:<sig>` before honoring the state. */
  sig: string;
}

export function verifyOauthState(state: string): OauthState | null {
  const parts = state.split(".");
  if (parts.length !== 5) return null;
  const [appId, expStr, mvStr, uidB64, sig] = parts as [string, string, string, string, string];
  const exp = Number(expStr);
  const mv = Number(mvStr);
  if (!appId || !Number.isFinite(exp) || !Number.isFinite(mv) || Date.now() > exp) return null;
  let userId: string;
  try {
    userId = Buffer.from(uidB64, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!userId) return null;
  let expected: string;
  try {
    expected = sign(appId, exp, mv, userId);
  } catch (e) {
    // No signing secret (misconfigured production): no inbound state can be
    // valid — refuse instead of 500ing. BUILDING states still throws loudly.
    console.error("[slack] oauth state verification unavailable:", e);
    return null;
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { appId, userId, sig, ...(mv > 0 ? { manifestVersion: mv } : {}) };
}
