import { createHmac, timingSafeEqual } from "node:crypto";
import { secretEnv } from "./env";

/**
 * Signed OAuth `state` for the Slack install/reinstall flow. The v1 state was
 * the bare app id — anything that could get a victim's browser onto the
 * callback with a chosen code+state could complete a token exchange with no
 * proof the install was started from Latch. v2 states are HMAC-signed, carry
 * an expiry, and a manifest-version flag (`mv=2` marks a migrate-to-agent_view
 * reinstall, flipped only after the exchange succeeds).
 *
 * Format: `<appId>.<exp>.<mv>.<hex hmac>` — domain-separated from the link
 * tokens sharing the signing key.
 */

function secret(): string {
  return secretEnv("BETTER_AUTH_SECRET", "dev-only-secret-change-me");
}

function sign(appId: string, exp: number, mv: number): string {
  return createHmac("sha256", secret())
    .update(`slack-oauth:${appId}:${exp}:${mv}`)
    .digest("hex");
}

export function buildOauthState(appId: string, opts: { manifestVersion?: number } = {}): string {
  const exp = Date.now() + 30 * 60_000;
  const mv = opts.manifestVersion ?? 0; // 0 = no version flip on callback
  return `${appId}.${exp}.${mv}.${sign(appId, exp, mv)}`;
}

export function verifyOauthState(
  state: string,
): { appId: string; manifestVersion?: number } | null {
  const parts = state.split(".");
  if (parts.length !== 4) return null;
  const [appId, expStr, mvStr, sig] = parts as [string, string, string, string];
  const exp = Number(expStr);
  const mv = Number(mvStr);
  if (!appId || !Number.isFinite(exp) || !Number.isFinite(mv) || Date.now() > exp) return null;
  let expected: string;
  try {
    expected = sign(appId, exp, mv);
  } catch (e) {
    // No signing secret (misconfigured production): no inbound state can be
    // valid — refuse instead of 500ing. BUILDING states still throws loudly.
    console.error("[slack] oauth state verification unavailable:", e);
    return null;
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { appId, ...(mv > 0 ? { manifestVersion: mv } : {}) };
}
